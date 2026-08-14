import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ViewerFilter, ViewerSortKey } from '@shared/dto';
import type { NormalizedEvent } from '@shared/events';
import { getSessionViewerTable } from '../../src/worker/store/queries/viewers';
import { Store } from '../../src/worker/store/index';
import { normalize } from '../../src/worker/tiktok/normalize';

/**
 * 「今回」列(今回💗/今回💎/今回コメ)のソートだけは viewer_session_stat を駆動表に
 * した専用パスを通る — viewer 全件を実体化してソートする汎用パスが、DB が育つほど
 * 遅くなる唯一の残り箇所だったため(実測 42.3ms → 15.0ms、かつ O(取得件数) に変わる)。
 *
 * **速くなっても並びが1行でも変われば配信中の誤読につながる**ので、
 * 新パスと旧パス(forceLegacy)を全組み合わせで突き合わせる。
 */
const T0 = 1_700_000_000_000;
let dir: string;
let store: Store;
const nctx = { seq: 0, unstableKeys: 0 };

function u(id: string, nick: string) {
  return { id, idStr: id, displayId: `handle_${id}`, nickname: nick, secUid: `MS4wLjABAAAA${id}`, badgeList: [] };
}
function ev(kind: string, data: Record<string, unknown>, at = T0): NormalizedEvent {
  const e = normalize(nctx, kind, { common: { createTime: String(Math.floor(at / 1000)) }, ...data }, at);
  if (!e) throw new Error(`normalize returned null for ${kind}`);
  return e;
}
const like = (id: string, n: number, seq: number) =>
  ev('like', { common: { msgId: `l${seq}`, createTime: String(T0 / 1000) }, user: u(id, `nick${id}`), count: n });
const chat = (id: string, text: string, seq: number) =>
  ev('chat', { common: { msgId: `c${seq}`, createTime: String(T0 / 1000) }, user: u(id, `nick${id}`), content: text });
const gift = (id: string, diamonds: number, seq: number) =>
  ev('gift', {
    common: { msgId: `g${seq}`, createTime: String(T0 / 1000) },
    user: u(id, `nick${id}`),
    giftId: '5655',
    repeatCount: 1,
    repeatEnd: 1,
    groupId: `grp${seq}`,
    gift: { id: '5655', name: 'Rose', type: 1, diamondCount: diamonds },
  });
const joinOnly = (id: string, seq: number) =>
  ev('member', { common: { msgId: `m${seq}`, createTime: String(T0 / 1000) }, user: u(id, `nick${id}`), actionId: 1 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-sort-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, { idAliases: {}, nameRules: [] });
});
afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

/**
 * 意図的に境界を踏む形にする:
 *  - 前回のみ参加 = viewer 行はあるが今回の vss 行が無い
 *  - 入室だけ = vss 行はあるが全列 0(「行が無い」と混同すると消える)
 *  - 同値の並び(タイブレークが user_id 昇順であることの検査)
 *  - ブロック済み(どのパスでも出てはいけない)
 */
function seed(): number {
  const prev = store.openSession({ hostUserId: 'h', hostUniqueId: 'h', roomId: 'r', startedMs: T0 - 86_400_000 }).sessionId;
  store.applyBatch(prev, [gift('90', 5, 900), like('91', 7, 901), chat('92', 'old', 902)]);
  store.closeSession(prev, { endedMs: T0 - 80_000_000, reason: 'userStopped' });

  const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'h', roomId: 'r', startedMs: T0 }).sessionId;
  store.applyBatch(sid, [
    joinOnly('1', 1), // 全部 0
    joinOnly('2', 2), // 全部 0
    like('3', 5, 3),
    like('4', 5, 4), // 3 と同値 → タイブレーク検査
    like('5', 9, 5),
    chat('6', 'あ', 6),
    chat('7', 'い', 7),
    chat('7', 'う', 8), // コメント2件
    gift('8', 3, 9),
    gift('9', 3, 10), // 8 と同値
    gift('10', 11, 11),
    chat('10', 'え', 12),
    like('10', 2, 13),
    joinOnly('11', 14),
    gift('12', 1, 15),
  ]);
  store.forgetViewer('11', 'block');
  return sid;
}

/** 「今回」列 = viewer_session_stat 駆動、「累計」列 = viewer_lifetime 駆動。 */
const SORTS: ViewerSortKey[] = [
  'likesCurrent',
  'diamondsCurrent',
  'commentsCurrent',
  'diamondsLifetime',
  'likesLifetime',
  'heartMeLifetime',
  'visits',
  'score',
];
const FILTERS: ViewerFilter[] = ['all', 'firstTime', 'vip', 'regular', 'gifter', 'commenter', 'present'];

describe('専用パスを通るソートでも並びが変わらない', () => {
  it('sort x desc x filter x 検索 x offset の全組み合わせで旧パスと一致する', () => {
    const sid = seed();
    let checked = 0;
    for (const sort of SORTS) {
      for (const desc of [true, false]) {
        for (const filter of FILTERS) {
          for (const search of ['', 'nick1']) {
            for (const offset of [0, 3]) {
              const q = { sort, desc, filter, search, limit: 50, offset };
              const fresh = getSessionViewerTable(store['db'], sid, q, 30, T0, undefined, false);
              const legacy = getSessionViewerTable(store['db'], sid, q, 30, T0, undefined, true);
              const label = `${sort}/${desc ? 'desc' : 'asc'}/${filter}/q="${search}"/off=${offset}`;
              expect(fresh.rows.map((r) => r.userId), label).toEqual(legacy.rows.map((r) => r.userId));
              // 行の中身も同じであること(列の取り違えを拾う)
              expect(fresh.rows.map((r) => r.likesCurrent), label).toEqual(legacy.rows.map((r) => r.likesCurrent));
              expect(fresh.rows.map((r) => r.diamondsCurrent), label).toEqual(legacy.rows.map((r) => r.diamondsCurrent));
              checked += 1;
            }
          }
        }
      }
    }
    expect(checked).toBe(SORTS.length * 2 * FILTERS.length * 2 * 2);
  });

  it('ブロック済みの視聴者はどちらのパスでも出ない', () => {
    const sid = seed();
    for (const forceLegacy of [false, true]) {
      const page = getSessionViewerTable(store['db'], sid, { sort: 'diamondsCurrent', limit: 50 }, 30, T0, undefined, forceLegacy);
      expect(page.rows.some((r) => r.userId === '11')).toBe(false);
    }
  });

  it('累計列ソートでも汎用パスと同じ件数・同じ先頭が返る', () => {
    const sid = seed();
    for (const sort of ['diamondsLifetime', 'visits', 'score'] as ViewerSortKey[]) {
      const a = getSessionViewerTable(store['db'], sid, { sort, desc: true, limit: 50 }, 30, T0, undefined, false);
      const b = getSessionViewerTable(store['db'], sid, { sort, desc: true, limit: 50 }, 30, T0, undefined, true);
      expect(a.rows.length, sort).toBe(b.rows.length);
      expect(a.rows.map((r) => r.userId), sort).toEqual(b.rows.map((r) => r.userId));
    }
  });

  it('今回0の人(入室のみ・前回のみ参加)も欠落せず、0 群として並ぶ', () => {
    const sid = seed();
    const page = getSessionViewerTable(store['db'], sid, { sort: 'diamondsCurrent', desc: true, limit: 50 }, 30, T0);
    const ids = page.rows.map((r) => r.userId);
    // vss 行はあるが 0 の人(入室のみ)
    expect(ids).toContain('1');
    // viewer 行はあるが今回の vss 行が無い人(前回のみ参加)
    expect(ids).toContain('90');
    // 正の群が先、0 の群が後ろ
    const firstZero = page.rows.findIndex((r) => r.diamondsCurrent === 0);
    expect(page.rows.slice(0, firstZero).every((r) => r.diamondsCurrent > 0)).toBe(true);
    expect(page.rows.slice(firstZero).every((r) => r.diamondsCurrent === 0)).toBe(true);
  });
});
