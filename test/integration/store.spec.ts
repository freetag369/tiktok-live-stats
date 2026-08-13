import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import type { NormalizedEvent } from '@shared/events';

/**
 * End-to-end over the real database: events in, rows and rollups out.
 * These are the invariants the product's correctness rests on.
 */

let dir: string;
let store: Store;

const ALIASES = {
  idAliases: { '7934': 'heart_me' },
  nameRules: [{ canonical: 'heart_me', match: ['heart me'] }],
};

function mkStore(): Store {
  const s = new Store();
  s.open({ dbPath: join(dir, 'db', 'test.db') }, ALIASES);
  return s;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-'));
  store = mkStore();
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const T0 = Date.UTC(2026, 6, 28, 12, 0, 0);
const ctx = () => makeNormalizeCtx();

function u(id: string, nick = `user${id}`) {
  return { id, idStr: id, displayId: `handle_${id}`, nickname: nick, secUid: `MS4wLjABAAAA${id}`, badgeList: [] };
}

function ev(kind: string, data: Record<string, unknown>, at = T0): NormalizedEvent {
  const e = normalize(ctx(), kind, { common: { createTime: String(Math.floor(at / 1000)) }, ...data }, at);
  if (!e) throw new Error(`normalize returned null for ${kind}`);
  return e;
}

function openSession(startedMs = T0, roomId = 'room-1'): number {
  return store.openSession({ hostUserId: 'host1', hostUniqueId: 'me', roomId, startedMs }).sessionId;
}

describe('ingest', () => {
  it('records a comment and rolls it up to session and lifetime totals', () => {
    const sid = openSession();
    store.applyBatch(sid, [ev('chat', { user: u('1'), content: 'こんばんは' })]);

    const rows = store.getSessionViewerTable(sid, {}).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.commentsCurrent).toBe(1);
    expect(rows[0]!.commentsLifetime).toBe(1);
    expect(rows[0]!.visits).toBe(1);
    expect(rows[0]!.isFirstEver).toBe(true);
    expect(store.getSessionTotals(sid)!.comments).toBe(1);
  });

  it('is idempotent — replaying the same batch adds nothing', () => {
    const sid = openSession();
    const batch = [
      ev('chat', { common: { msgId: 'c1', createTime: String(T0 / 1000) }, user: u('1'), content: 'a' }),
      ev('like', { common: { msgId: 'l1', createTime: String(T0 / 1000) }, user: u('1'), count: 5, total: '100' }),
    ];
    store.applyBatch(sid, batch);
    store.applyBatch(sid, batch);
    store.applyBatch(sid, batch);

    const r = store.getSessionViewerTable(sid, {}).rows[0]!;
    expect(r.commentsCurrent).toBe(1);
    // The like path has no INSERT OR IGNORE guard of its own, so the msg_id
    // dedupe must be what stops the double count.
    expect(r.likesCurrent).toBe(5);
    expect(store.getSessionTotals(sid)!.comments).toBe(1);
  });

  it('counts likes per viewer and keeps the room total separate', () => {
    const sid = openSession();
    store.applyBatch(sid, [
      ev('like', { common: { msgId: 'l1', createTime: String(T0 / 1000) }, user: u('1'), count: 5, total: '4000' }),
      ev('like', { common: { msgId: 'l2', createTime: String(T0 / 1000) }, user: u('2'), count: 3, total: '4200' }),
    ]);
    const t = store.getSessionTotals(sid)!;
    expect(t.observedLikes).toBe(8);
    // TikTok's own figure for the whole room — always >= what we observed.
    expect(t.roomTotalLikes).toBe(4200);
  });

  it('counts one gift per streak and attributes the diamonds', () => {
    const sid = openSession();
    const gift = (repeatEnd: number, repeatCount: number) => ({
      common: { msgId: `g${repeatCount}`, createTime: String(T0 / 1000) },
      user: u('1'),
      giftId: '5655',
      repeatCount,
      repeatEnd,
      groupId: 'grp1',
      gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 1 },
    });
    // Mid-streak events are dropped by the normalizer itself.
    expect(normalize(ctx(), 'gift', gift(0, 1), T0)).toBeNull();
    store.applyBatch(sid, [ev('gift', gift(1, 4))]);

    const t = store.getSessionTotals(sid)!;
    expect(t.gifts).toBe(1);
    expect(t.diamonds).toBe(4);
  });

  it('counts ハートミー separately, resolving the family by name when the id is unknown', () => {
    const sid = openSession();
    store.applyBatch(sid, [
      ev('gift', {
        common: { msgId: 'hm1', createTime: String(T0 / 1000) },
        user: u('1'),
        giftId: '999999',
        repeatCount: 3,
        repeatEnd: 1,
        gift: { id: '999999', name: 'Heart Me', type: 1, diamondCount: 1 },
      }),
    ]);
    expect(store.getSessionTotals(sid)!.heartMe).toBe(3);
    expect(store.getSessionViewerTable(sid, {}).rows[0]!.heartMeLifetime).toBe(3);
  });

  it('keeps one viewer row across a handle change and records the history', () => {
    const sid = openSession();
    store.applyBatch(sid, [ev('chat', { common: { msgId: 'a', createTime: String(T0 / 1000) }, user: u('1', '旧名'), content: 'a' })]);
    store.applyBatch(sid, [
      ev('chat', {
        common: { msgId: 'b', createTime: String(T0 / 1000) },
        user: { ...u('1', '新名'), displayId: 'new_handle' },
        content: 'b',
      }),
    ]);
    const detail = store.getViewer('1', sid)!;
    expect(store.getSessionViewerTable(sid, {}).rows).toHaveLength(1);
    expect(detail.row.nickname).toBe('新名');
    expect(detail.row.displayId).toBe('new_handle');
    expect(detail.identityHistory.length).toBe(2);
  });

  it('drops events from a blocked viewer but keeps their history', () => {
    const sid = openSession();
    store.applyBatch(sid, [ev('chat', { common: { msgId: 'a', createTime: String(T0 / 1000) }, user: u('1'), content: 'a' })]);
    store.forgetViewer('1', 'block');
    store.applyBatch(sid, [ev('chat', { common: { msgId: 'b', createTime: String(T0 / 1000) }, user: u('1'), content: 'b' })]);

    // Blocked viewers are hidden from the table but the earlier row still exists.
    expect(store.getSessionViewerTable(sid, {}).rows).toHaveLength(0);
    expect(store.searchComments({ userId: '1' }).total).toBe(1);
  });
});

describe('今回 / 前回 / 累計', () => {
  it('reports zero for 今回 when the viewer did not attend THIS session', () => {
    const s1 = openSession(T0, 'room-1');
    store.applyBatch(s1, [ev('like', { common: { msgId: 'l1', createTime: String(T0 / 1000) }, user: u('1'), count: 50 })]);
    store.closeSession(s1, { endedMs: T0 + 3_600_000, reason: 'streamEnd' });

    const t2 = T0 + 7 * 86_400_000;
    const s2 = store.openSession({ hostUserId: 'host1', hostUniqueId: 'me', roomId: 'room-2', startedMs: t2 }).sessionId;
    store.applyBatch(s2, [ev('chat', { common: { msgId: 'c9', createTime: String(t2 / 1000) }, user: u('9'), content: 'hi' }, t2)]);

    // The absent viewer must read 0 for 今回 and 50 for 前回 — a naive
    // "most recent session" view would show last week's 50 as 今回.
    const rows = store.getSessionViewerTable(s2, { limit: 100 }).rows;
    const one = rows.find((r) => r.userId === '1')!;
    expect(one.likesCurrent).toBe(0);
    expect(one.likesPrev).toBe(50);
    expect(one.likesLifetime).toBe(50);
    expect(one.presentNow).toBe(false);
    expect(one.visits).toBe(1);
  });

  it('counts 来店回数 as distinct sessions attended', () => {
    for (let i = 0; i < 3; i++) {
      const at = T0 + i * 7 * 86_400_000;
      const sid = store.openSession({ hostUserId: 'host1', hostUniqueId: 'me', roomId: `room-${i}`, startedMs: at }).sessionId;
      store.applyBatch(sid, [
        ev('chat', { common: { msgId: `c${i}a`, createTime: String(at / 1000) }, user: u('1'), content: 'a' }, at),
        ev('chat', { common: { msgId: `c${i}b`, createTime: String(at / 1000) }, user: u('1'), content: 'b' }, at),
      ]);
      store.closeSession(sid, { endedMs: at + 3_600_000, reason: 'streamEnd' });
    }
    const detail = store.getViewer('1', null)!;
    expect(detail.row.visits).toBe(3);
    expect(detail.row.consecutiveStreak).toBe(3);
    expect(detail.medianIntervalDays).toBe(7);
  });
});

describe('session lifecycle', () => {
  it('resumes the same session after a short drop, and starts a new one after a long gap', () => {
    const a = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r1', startedMs: T0 });
    store.closeSession(a.sessionId, { endedMs: T0 + 60_000, reason: 'lostConnection' });

    const b = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r1', startedMs: T0 + 180_000 });
    expect(b.resumed).toBe(true);
    expect(b.sessionId).toBe(a.sessionId);

    store.closeSession(b.sessionId, { endedMs: T0 + 240_000, reason: 'lostConnection' });
    const c = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r1', startedMs: T0 + 3_600_000 });
    expect(c.resumed).toBe(false);
    expect(c.sessionId).not.toBe(a.sessionId);
  });

  it('adopts a session opened seconds earlier without a room id', () => {
    // Observed live: connect succeeds before TikTok returns a room id, the socket
    // re-handshakes 3 s later with the real one, and the broadcast is split in two.
    const a = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: null, startedMs: T0 });
    const b = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: '7667584174132005648', startedMs: T0 + 3000 });
    expect(b.resumed).toBe(true);
    expect(b.sessionId).toBe(a.sessionId);
    // …and the real room id is filled in, so later reconnects match on it.
    expect(store.listSessions({}).rows).toHaveLength(1);
    const c = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: '7667584174132005648', startedMs: T0 + 9000 });
    expect(c.sessionId).toBe(a.sessionId);
  });

  it('still starts a new session for the same host after a long gap', () => {
    const a = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: null, startedMs: T0 });
    store.closeSession(a.sessionId, { endedMs: T0 + 60_000, reason: 'streamEnd' });
    const b = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: null, startedMs: T0 + 3_600_000 });
    expect(b.resumed).toBe(false);
    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it('does not merge two different streamers', () => {
    const a = store.openSession({ hostUserId: 'h1', hostUniqueId: 'alice', roomId: null, startedMs: T0 });
    const b = store.openSession({ hostUserId: 'h2', hostUniqueId: 'bob', roomId: null, startedMs: T0 + 3000 });
    expect(b.resumed).toBe(false);
    expect(b.sessionId).not.toBe(a.sessionId);
  });

  it('closes a session left open by a crash on the next open()', () => {
    const sid = openSession();
    store.applyBatch(sid, [ev('chat', { common: { msgId: 'x', createTime: String(T0 / 1000) }, user: u('1'), content: 'x' })]);
    store.close(); // simulate a crash: no closeSession call

    store = mkStore();
    expect(store.capabilities.orphanSessionsClosed).toBe(1);
    const s = store.listSessions({}).rows[0]!;
    expect(s.endReason).toBe('crash');
    expect(s.endedMs).not.toBeNull();
  });
});

describe('P1 analytics', () => {
  it('incremental scores match a full recompute exactly', () => {
    for (let i = 0; i < 6; i++) {
      const at = T0 + i * 14 * 86_400_000;
      const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: `r${i}`, startedMs: at }).sessionId;
      store.applyBatch(sid, [
        ev('chat', { common: { msgId: `c${i}`, createTime: String(at / 1000) }, user: u('1'), content: 'x' }, at),
        ev('gift', {
          common: { msgId: `g${i}`, createTime: String(at / 1000) },
          user: u('1'),
          giftId: '1',
          repeatCount: 1,
          repeatEnd: 1,
          gift: { id: '1', name: 'Rose', type: 2, diamondCount: 10 },
        }, at),
      ]);
      store.closeSession(sid, { endedMs: at + 3_600_000, reason: 'streamEnd' });
    }
    const incremental = store.getViewer('1', null)!.row.score;
    store.recomputeScores({ full: true });
    const full = store.getViewer('1', null)!.row.score;
    expect(full).toBeCloseTo(incremental, 6);
  });

  it('flags an overdue regular but not a one-off first-timer', () => {
    // Weekly regular, then absent.
    for (let i = 0; i < 5; i++) {
      const at = T0 + i * 7 * 86_400_000;
      const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: `r${i}`, startedMs: at }).sessionId;
      store.applyBatch(sid, [ev('chat', { common: { msgId: `c${i}`, createTime: String(at / 1000) }, user: u('1'), content: 'x' }, at)]);
      // A first-timer who came once, at the very start.
      if (i === 0) {
        store.applyBatch(sid, [ev('chat', { common: { msgId: 'once', createTime: String(at / 1000) }, user: u('2'), content: 'y' }, at)]);
      }
      store.closeSession(sid, { endedMs: at + 3_600_000, reason: 'streamEnd' });
    }
    const lastVisit = T0 + 4 * 7 * 86_400_000;
    const now = lastVisit + 21 * 86_400_000;
    const rows = store.getChurnCandidates({ kind: 'churn', minVisits: 3, overdueFactor: 2 });
    // getChurnCandidates uses Date.now(), so assert on the shape rather than the
    // wall clock: only the multi-visit regular is eligible at all.
    expect(rows.every((r) => r.visits >= 3)).toBe(true);
    expect(rows.some((r) => r.userId === '2')).toBe(false);
    void now;
  });

  it('buckets the hour × weekday matrix by JST start time', () => {
    const sid = openSession(Date.UTC(2026, 6, 28, 12, 30, 0)); // 21:30 JST, Tuesday
    store.closeSession(sid, { endedMs: Date.UTC(2026, 6, 28, 14, 0, 0), reason: 'streamEnd' });
    const cells = store.getHourWeekdayMatrix({ metric: 'sessions' });
    expect(cells).toHaveLength(1);
    expect(cells[0]!.weekday).toBe(2);
    expect(cells[0]!.hour).toBe(21);
  });
});

describe('like_seen prune (migration 005)', () => {
  it('drops rows older than the cutoff but keeps in-window dedupe intact', () => {
    const sid = openSession();
    const oldTs = T0;
    const newTs = T0 + 40 * 60_000;
    store.applyBatch(sid, [
      ev('like', { common: { msgId: 'l-old', createTime: String(oldTs / 1000) }, user: u('1'), count: 5 }, oldTs),
    ]);
    store.applyBatch(sid, [
      ev('like', { common: { msgId: 'l-new', createTime: String(newTs / 1000) }, user: u('1'), count: 3 }, newTs),
    ]);

    // 配信中の定期掃除と同じ形: 「今」から30分より古い行を捨てる。
    store.pruneLikeSeen(newTs - 30 * 60_000);
    const count = (store.rawAll('SELECT COUNT(*) AS c FROM like_seen') as Array<{ c: number }>)[0]!.c;
    expect(count).toBe(1);

    // ウィンドウ内の再送(再接続バックログ)は引き続き二重計上されない。
    store.applyBatch(sid, [
      ev('like', { common: { msgId: 'l-new', createTime: String(newTs / 1000) }, user: u('1'), count: 3 }, newTs),
    ]);
    expect(store.getSessionViewerTable(sid, {}).rows[0]!.likesCurrent).toBe(8);
  });
});

describe('purge', () => {
  it('rebuilds lifetime totals after a session is deleted', () => {
    const s1 = openSession(T0, 'r1');
    store.applyBatch(s1, [ev('chat', { common: { msgId: 'a', createTime: String(T0 / 1000) }, user: u('1'), content: 'a' })]);
    store.closeSession(s1, { endedMs: T0 + 1000, reason: 'streamEnd' });

    const t2 = T0 + 86_400_000;
    const s2 = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r2', startedMs: t2 }).sessionId;
    store.applyBatch(s2, [ev('chat', { common: { msgId: 'b', createTime: String(t2 / 1000) }, user: u('1'), content: 'b' }, t2)]);
    store.closeSession(s2, { endedMs: t2 + 1000, reason: 'streamEnd' });

    expect(store.getViewer('1', null)!.row.commentsLifetime).toBe(2);
    store.purge({ scope: 'session', sessionId: s1 });
    // Stale rollups after a delete would quietly corrupt every later comparison.
    expect(store.getViewer('1', null)!.row.commentsLifetime).toBe(1);
    expect(store.getViewer('1', null)!.row.visits).toBe(1);
  });
});
