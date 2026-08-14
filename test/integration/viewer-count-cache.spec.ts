import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { normalize } from '../../src/worker/tiktok/normalize';
import type { NormalizedEvent } from '@shared/events';

/**
 * 視聴者テーブルの総件数キャッシュ。
 *
 * COUNT(*) は viewer 全件(全期間の累積)を走査するのでDBが育つほど重くなるが、
 * 用途は「記録 N人」の表示だけ。ダッシュボードは8秒ごとにこのクエリを叩くので、
 * 行の取得だけを毎回やって total は 60 秒使い回す。
 */
const T0 = 1_700_000_000_000;
let dir: string;
let store: Store;

const nctx = { seq: 0, unstableKeys: 0 };
function u(id: string) {
  return { id, idStr: id, displayId: `handle_${id}`, nickname: `user${id}`, secUid: `MS4wLjABAAAA${id}`, badgeList: [] };
}
function ev(kind: string, data: Record<string, unknown>, at = T0): NormalizedEvent {
  const e = normalize(nctx, kind, { common: { createTime: String(Math.floor(at / 1000)) }, ...data }, at);
  if (!e) throw new Error(`normalize returned null for ${kind}`);
  return e;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-count-'));
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

describe('視聴者テーブルの総件数キャッシュ', () => {
  it('行は毎回引き直すが total は TTL 内で使い回す', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'h', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [ev('chat', { user: u('1'), content: 'a' })]);
    expect(store.getSessionViewerTable(sid, {}).total).toBe(1);

    // 2人目を足す。行(rows)は即座に増えるが、total はキャッシュのまま。
    store.applyBatch(sid, [ev('chat', { user: u('2'), content: 'b' })]);
    const page = store.getSessionViewerTable(sid, {});
    expect(page.rows).toHaveLength(2);
    expect(page.total).toBe(1);
  });

  it('filter / 検索語ごとに別のキーで持つ', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'h', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [ev('chat', { user: u('1'), content: 'a' }), ev('chat', { user: u('2'), content: 'b' })]);
    expect(store.getSessionViewerTable(sid, {}).total).toBe(2);
    // 検索語が違えば別キー = キャッシュを共有しない(1件しか当たらない)。
    expect(store.getSessionViewerTable(sid, { search: 'user1' }).total).toBe(1);
    expect(store.getSessionViewerTable(sid, {}).total).toBe(2);
  });

  it('purge のあとは total を引き直す', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'h', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [ev('chat', { user: u('1'), content: 'a' }), ev('chat', { user: u('2'), content: 'b' })]);
    expect(store.getSessionViewerTable(sid, {}).total).toBe(2);

    store.purge({ scope: 'viewer', userId: '1' });
    expect(store.getSessionViewerTable(sid, {}).total).toBe(1);
  });
});
