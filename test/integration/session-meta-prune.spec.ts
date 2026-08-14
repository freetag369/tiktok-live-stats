import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { DEFAULT_MISSIONS } from '@shared/missions';
import type { LiveMessage } from '@shared/ipc';
import { ChallengeEngine } from '../../src/worker/challenge';
import { SessionManager } from '../../src/worker/session';
import { Store } from '../../src/worker/store/index';

/**
 * meta キャッシュ剪定の回帰テスト。
 *
 * 耐久配信で meta(ViewerMeta の Map)がユニーク視聴者数に比例して育つと、
 * 単一スレッド worker の GC 停止が press RPC / 2Hz delta を塞ぐ — そのための
 * pruneMeta。ただし観測ユニーク / 初見の表示値は meta.size から分離した
 * カウンタが持つので、**剪定しても数字は減らない**ことをここで固定する。
 */
let dir: string;
let store: Store;
let sm: SessionManager | null = null;
let posts: LiveMessage[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-meta-prune-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, { idAliases: {}, nameRules: [] });
  posts = [];
});

afterEach(async () => {
  await sm?.stop('userStopped', false);
  sm = null;
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

function makeSession(): SessionManager {
  const challenge = new ChallengeEngine(() => DEFAULT_CHALLENGE, Date.now, Math.random, Math.random, () => undefined);
  return new SessionManager({
    store,
    post: (m) => posts.push(m),
    userDataDir: dir,
    getSettings: () => ({ eulerApiKey: '', captureDebug: false, alertMinTier: 3, giftAlertDiamonds: 100 }),
    getMissionConfig: () => DEFAULT_MISSIONS,
    challenge,
  });
}

/** private への到達。テスト専用 — 実行時の形はここで宣言したものに一致する。 */
interface SmInternals {
  meta: Map<string, { lastSeenMs: number; firstEver: boolean }>;
  seenIds: Set<string>;
  uniqueViewers: number;
  firstTimers: number;
  sessionId: number | null;
  metaOf(id: string): { firstEver: boolean };
  pruneMeta(): void;
  pushDelta(full: boolean): void;
  hydrateTotals(sessionId: number): void;
}
const internals = (m: SessionManager) => m as unknown as SmInternals;

function lastDeltaTotals(): { uniqueViewers: number; firstTimers: number } {
  const deltas = posts.filter((p): p is Extract<LiveMessage, { t: 'delta' }> => p.t === 'delta');
  const last = deltas[deltas.length - 1];
  expect(last).toBeDefined();
  return { uniqueViewers: last!.totals.uniqueViewers, firstTimers: last!.totals.firstTimers };
}

describe('meta 剪定と観測ユニークの分離', () => {
  it('TTL 超過の剪定後も 観測ユニーク / 初見 は減らず、再訪しても二重加算されない', () => {
    sm = makeSession();
    const s = internals(sm);
    const n = 1000;
    for (let i = 0; i < n; i += 1) s.metaOf(`u${i}`);
    expect(s.meta.size).toBe(n);
    expect(s.uniqueViewers).toBe(n);
    // 空 DB なので全員が初見。
    expect(s.firstTimers).toBe(n);

    // 前半を 31 分前に見たことにして TTL(30分)剪定を発火させる。
    const old = Date.now() - 31 * 60_000;
    for (let i = 0; i < n / 2; i += 1) s.meta.get(`u${i}`)!.lastSeenMs = old;
    s.pruneMeta();
    expect(s.meta.size).toBe(n / 2);

    // 表示値は据え置き。
    expect(s.uniqueViewers).toBe(n);
    expect(s.firstTimers).toBe(n);
    s.pushDelta(true);
    expect(lastDeltaTotals()).toEqual({ uniqueViewers: n, firstTimers: n });

    // 剪定済みの視聴者の再訪(= metaOf のキャッシュミス)で二重加算しない。
    s.metaOf('u0');
    expect(s.uniqueViewers).toBe(n);
    expect(s.firstTimers).toBe(n);
    expect(s.meta.size).toBe(n / 2 + 1);
  });

  it('invalidateMeta 後の再取得でも二重加算しない', () => {
    sm = makeSession();
    const s = internals(sm);
    s.metaOf('u1');
    expect(s.uniqueViewers).toBe(1);
    sm.invalidateMeta('u1');
    s.metaOf('u1');
    expect(s.uniqueViewers).toBe(1);
    expect(s.firstTimers).toBe(1);
  });

  it('ハードキャップ(20,000)超は古い順に間引かれるが表示値は全数を保つ', () => {
    sm = makeSession();
    const s = internals(sm);
    const n = 21_000;
    // metaOf を n 回呼ぶと getRecallCard の同期 SQL が n 回走って遅いので、
    // キャッシュ投入は直接行い、カウンタは本経路(metaOf)と同じ規約で足す。
    const now = Date.now();
    for (let i = 0; i < n; i += 1) {
      s.meta.set(`u${i}`, { lastSeenMs: now + i, firstEver: true });
      s.seenIds.add(`u${i}`);
    }
    s.uniqueViewers = n;
    s.firstTimers = n;

    s.pruneMeta();
    expect(s.meta.size).toBe(20_000);
    // 古い順に消える = 最新の 20,000 件が残る。
    expect(s.meta.has('u0')).toBe(false);
    expect(s.meta.has(`u${n - 1}`)).toBe(true);
    expect(s.uniqueViewers).toBe(n);
    expect(s.firstTimers).toBe(n);
  });

  it('hydrateTotals(再接続復元)は seenIds / uniqueViewers も再構築し、復元後の再訪で二重加算しない', () => {
    sm = makeSession();
    const s = internals(sm);
    const sid = store.openSession({ hostUserId: 'h1', hostUniqueId: 'h', roomId: 'r1', startedMs: 1_000_000 }).sessionId;
    store.applyBatch(sid, [
      { kind: 'join', action: 1, tsMs: 1_000_100, msgId: 'j1', viewer: { userId: 'v1', nickname: 'V1' } },
      { kind: 'join', action: 1, tsMs: 1_000_200, msgId: 'j2', viewer: { userId: 'v2', nickname: 'V2' } },
      { kind: 'like', tsMs: 1_000_300, msgId: 'l1', viewer: { userId: 'v3', nickname: 'V3' }, count: 5 },
    ] as never);

    s.sessionId = sid;
    s.hydrateTotals(sid);

    const attendees = store.getSessionAttendees(sid);
    expect(attendees.length).toBeGreaterThan(0);
    expect(s.uniqueViewers).toBe(attendees.length);
    expect(s.seenIds.size).toBe(attendees.length);
    expect(s.meta.size).toBe(attendees.length);

    // 復元済みの視聴者を metaOf しても増えない。
    const before = s.uniqueViewers;
    s.metaOf(attendees[0]!.userId);
    expect(s.uniqueViewers).toBe(before);

    // 新規は増える。
    s.metaOf('brand-new');
    expect(s.uniqueViewers).toBe(before + 1);
  });
});
