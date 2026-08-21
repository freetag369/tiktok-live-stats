import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import type { NormalizedEvent } from '@shared/events';

/**
 * ギフトリスト(設定の最後尾タブ)が引く一覧。
 *
 * この表の値が狂うと、配信者は**存在しない giftId を設定に書く**ことになり、
 * 「登録したのに演出が出ない」に直結する。だから守るのは見た目ではなく
 * 「受信した実測がそのまま出るか」— 単価が総額に化けないこと、連打が
 * 受信回数に化けないこと、名前の前後スペースが落ちないこと。
 */

let dir: string;
let store: Store;

const ALIASES = {
  idAliases: { '7934': 'heart_me' },
  nameRules: [{ canonical: 'heart_me', match: ['heart me'] }],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-giftcat-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, ALIASES);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 7, 20, 12, 0, 0);

function u(id: string) {
  return { id, idStr: id, displayId: `handle_${id}`, nickname: `user${id}`, secUid: `MS4wLjABAAAA${id}`, badgeList: [] };
}

function giftEvent(
  msgId: string,
  giftId: string,
  name: string,
  diamondEach: number,
  repeat: number,
  type = 1,
  at = T0
): NormalizedEvent {
  const e = normalize(
    makeNormalizeCtx(),
    'gift',
    {
      common: { msgId, createTime: String(Math.floor(at / 1000)) },
      user: u('1'),
      giftId,
      repeatCount: repeat,
      repeatEnd: 1,
      gift: { id: giftId, name, type, diamondCount: diamondEach },
    },
    at
  );
  if (!e) throw new Error('normalize returned null');
  return e;
}

describe('listGiftCatalog — 受信済み全ギフトの一覧', () => {
  it('受信した実測がそのまま出る(単価・最大連打・受信回数・累計💎)', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [
      giftEvent('r1', '5655', 'Rose', 1, 4),
      giftEvent('r2', '5655', 'Rose', 1, 17, 1, T0 + 1000),
      giftEvent('h1', '5660', 'Hand Heart', 100, 1, 2, T0 + 2000),
    ]);

    const list = store.listGiftCatalog();
    const rose = list.find((r) => r.giftId === '5655')!;
    // 💎単価は diamondEach。総額(1×4 + 1×17 = 21)と取り違えないこと。
    expect(rose.diamonds).toBe(1);
    expect(rose.totalDiamonds).toBe(21);
    // 受信回数は gift_event の行数 = 2(連打は1行に畳まれる)。最大連打は実測の 17。
    expect(rose.count).toBe(2);
    expect(rose.maxRepeat).toBe(17);
    expect(rose.giftType).toBe(1);

    const hand = list.find((r) => r.giftId === '5660')!;
    expect(hand.diamonds).toBe(100);
    expect(hand.count).toBe(1);
    expect(hand.giftType).toBe(2);
  });

  it('giftId は数値順に並ぶ(文字列順だと 10715 が 5655 より前に来る)', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [
      giftEvent('a', '10715', 'Headphone', 199, 1),
      giftEvent('b', '5655', 'Rose', 1, 1),
      giftEvent('c', '626056', 'Kudos for My Star', 15, 1),
    ]);
    expect(store.listGiftCatalog().map((r) => r.giftId)).toEqual(['5655', '10715', '626056']);
  });

  it('ギフト名は受信原文ママ(前後スペースを落とさない)', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    // ' Ice Lolly'(6544)のように前後スペース入りで届くギフトが実在する。
    // trim すると exactName 一致の検証に使えなくなるので、表は原文で持つ。
    store.applyBatch(sid, [giftEvent('i1', '6544', ' Ice Lolly', 10, 1)]);
    expect(store.listGiftCatalog()[0]!.name).toBe(' Ice Lolly');
  });

  it('canonical(gift_alias)が乗る', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [giftEvent('hm', '7934', 'Heart Me', 1, 3)]);
    expect(store.listGiftCatalog().find((r) => r.giftId === '7934')!.canonical).toBe('heart_me');
  });

  it('1件も受け取っていなければ空(存在しない giftId を出さない)', () => {
    expect(store.listGiftCatalog()).toEqual([]);
  });
});
