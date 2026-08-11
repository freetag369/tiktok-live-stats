import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Alerts } from '../../src/worker/alerts';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import type { NormalizedEvent } from '@shared/events';

/**
 * 入室アラート is the feature the right-hand panel exists for, and it was firing
 * for nobody: the recall card was looked up before the batcher had written the
 * viewer, and a brand-new viewer has no row at all — so 初見, the case that
 * matters most, always missed.
 */

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-alert-'));
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

const T0 = Date.UTC(2026, 6, 28, 12, 0, 0);

function joinEvent(id: string, nick: string, at = T0): NormalizedEvent {
  const e = normalize(
    makeNormalizeCtx(),
    'member',
    {
      common: { msgId: `j-${id}-${at}`, createTime: String(Math.floor(at / 1000)) },
      user: { id, idStr: id, displayId: `h_${id}`, nickname: nick, secUid: `MS4wLjABAAAA${id}`, badgeList: [] },
      action: 1,
    },
    at
  );
  if (!e) throw new Error('normalize failed');
  return e;
}

describe('入室アラート', () => {
  it('fires for a viewer who has never been recorded before', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    const alerts = new Alerts(store, 1);

    // Nothing has been written yet — exactly the state during a live join.
    alerts.consider(joinEvent('1', 'はじめてさん'), sid, 0, true);

    const out = alerts.drain();
    expect(out).toHaveLength(1);
    expect(out[0]!.nickname).toBe('はじめてさん');
    expect(out[0]!.isFirstEver).toBe(true);
    expect(out[0]!.visits).toBe(0);
  });

  it('fires once per viewer per session, not on every re-entry', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    const alerts = new Alerts(store, 1);
    alerts.consider(joinEvent('1', 'A'), sid, 0, true);
    alerts.consider(joinEvent('1', 'A', T0 + 60_000), sid, 0, true);
    expect(alerts.drain()).toHaveLength(1);
  });

  it('stays quiet for an ordinary returning viewer below the alert tier', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    const alerts = new Alerts(store, 1);
    // tier 0, not a first-timer -> not worth interrupting the streamer.
    alerts.consider(joinEvent('2', 'ふつうの人'), sid, 0, false);
    expect(alerts.drain()).toHaveLength(0);
  });

  it('carries the recall aid for a known regular', () => {
    // Session 1: the viewer comments, so they get a real row and history.
    const s1 = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r1', startedMs: T0 }).sessionId;
    const chat = normalize(
      makeNormalizeCtx(),
      'chat',
      {
        common: { msgId: 'c1', createTime: String(T0 / 1000) },
        user: { id: '9', idStr: '9', displayId: 'h_9', nickname: '常連さん', badgeList: [] },
        content: 'この前の話おもしろかった',
      },
      T0
    )!;
    store.applyBatch(s1, [chat]);
    store.updateViewerMeta('9', { readingKana: 'じょうれん', note: '誕生日 3/4' });
    store.closeSession(s1, { endedMs: T0 + 3_600_000, reason: 'streamEnd' });

    const t2 = T0 + 7 * 86_400_000;
    const s2 = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r2', startedMs: t2 }).sessionId;
    const alerts = new Alerts(store, 1);
    alerts.consider(joinEvent('9', '常連さん', t2), s2, 1, false);

    const card = alerts.drain()[0]!;
    expect(card.readingKana).toBe('じょうれん');
    expect(card.note).toBe('誕生日 3/4');
    expect(card.visits).toBe(1);
    expect(card.prevVisitMs).not.toBeNull();
    expect(card.lastComments[0]).toBe('この前の話おもしろかった');
  });
});

describe('メモ（今後の配信でも残ること）', () => {
  it('persists a memo across sessions and surfaces it on the next visit', () => {
    const s1 = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r1', startedMs: T0 }).sessionId;
    store.applyBatch(s1, [joinEvent('7', 'たろう')]);
    store.updateViewerMeta('7', { note: '誕生日 3/4 / ゲームの話が好き', readingKana: 'たろう' });
    store.closeSession(s1, { endedMs: T0 + 3_600_000, reason: 'streamEnd' });

    // A week later — a completely new broadcast, and the memo must still be there.
    const t2 = T0 + 7 * 86_400_000;
    const s2 = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r2', startedMs: t2 }).sessionId;
    const card = store.getRecallCard('7', s2)!;
    expect(card.note).toBe('誕生日 3/4 / ゲームの話が好き');
    expect(card.readingKana).toBe('たろう');

    // …and the join alert carries it, so it is visible without opening anything.
    const alerts = new Alerts(store, 1);
    alerts.consider(joinEvent('7', 'たろう', t2), s2, 1, false);
    expect(alerts.drain()[0]!.note).toBe('誕生日 3/4 / ゲームの話が好き');
  });

  it('keeps the memo when the nickname changes', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [joinEvent('8', '旧なまえ')]);
    store.updateViewerMeta('8', { note: '常連さん' });
    store.applyBatch(sid, [joinEvent('8', '新しいなまえ', T0 + 60_000)]);
    // The memo is keyed on the stable user id, not the display name.
    expect(store.getRecallCard('8', sid)!.note).toBe('常連さん');
  });

  it('clears a memo when emptied, without touching the reading', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [joinEvent('9', 'A')]);
    store.updateViewerMeta('9', { note: 'あとで消す', readingKana: 'えー' });
    store.updateViewerMeta('9', { note: null });
    const card = store.getRecallCard('9', sid)!;
    expect(card.note).toBeNull();
    expect(card.readingKana).toBe('えー');
  });

  it('reports lifetime likes so the feed can show 累計💗', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    const like = normalize(
      makeNormalizeCtx(),
      'like',
      {
        common: { msgId: 'lk1', createTime: String(T0 / 1000) },
        user: { id: '10', idStr: '10', displayId: 'h10', nickname: 'B', badgeList: [] },
        count: 42,
        total: '900',
      },
      T0
    )!;
    store.applyBatch(sid, [like]);
    expect(store.getRecallCard('10', sid)!.likesLifetime).toBe(42);
    expect(store.getSessionAttendees(sid).find((a) => a.userId === '10')!.likesLifetime).toBe(42);
  });
});

describe('高額ギフトアラート', () => {
  function giftEvent(id: string, nick: string, name: string, diamonds: number, count = 1): NormalizedEvent {
    const e = normalize(
      makeNormalizeCtx(),
      'gift',
      {
        common: { msgId: `g-${id}-${name}-${diamonds}`, createTime: String(T0 / 1000) },
        user: { id, idStr: id, displayId: `h_${id}`, nickname: nick, badgeList: [] },
        giftId: '9999',
        repeatCount: count,
        repeatEnd: 1,
        gift: { id: '9999', name, type: 2, diamondCount: diamonds / count },
      },
      T0
    );
    if (!e) throw new Error('normalize failed');
    return e;
  }

  it('raises a card for a gift at or above the threshold', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    const alerts = new Alerts(store, 1, 100);
    alerts.consider(giftEvent('5', 'ふとっぱらさん', 'Leon the Kitten', 4888), sid, 0, false);

    const card = alerts.drain()[0]!;
    expect(card.kind).toBe('gift');
    expect(card.gift?.name).toBe('Leon the Kitten');
    expect(card.gift?.diamonds).toBe(4888);
    expect(card.nickname).toBe('ふとっぱらさん');
  });

  it('stays silent for a small gift, which belongs in the feed', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    const alerts = new Alerts(store, 1, 100);
    alerts.consider(giftEvent('6', 'A', 'Rose', 1), sid, 0, false);
    expect(alerts.drain()).toHaveLength(0);
  });

  it('alerts on every qualifying gift, unlike joins which fire once per viewer', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    const alerts = new Alerts(store, 1, 100);
    alerts.consider(giftEvent('7', 'B', 'Perfume', 200), sid, 0, false);
    alerts.consider(giftEvent('7', 'B', 'Corgi', 299), sid, 0, false);
    // Two separate acts of generosity deserve two thank-yous.
    expect(alerts.drain()).toHaveLength(2);
  });
});

describe('セッション再開', () => {
  it('restores the roster so regulars are not re-announced after a reconnect', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    store.applyBatch(sid, [joinEvent('1', 'A'), joinEvent('2', 'B')]);

    const attendees = store.getSessionAttendees(sid);
    expect(attendees).toHaveLength(2);
    expect(attendees.every((a) => a.firstEver)).toBe(true);

    const alerts = new Alerts(store, 1);
    for (const a of attendees) alerts.markSeen(a.userId);
    // The reconnect replays the same joins; nobody should be announced twice.
    alerts.consider(joinEvent('1', 'A'), sid, 0, true);
    alerts.consider(joinEvent('2', 'B'), sid, 0, true);
    expect(alerts.drain()).toHaveLength(0);
  });
});

describe('session_metric', () => {
  it('records the room-wide like total, which only ever arrives on like events', () => {
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r', startedMs: T0 }).sessionId;
    const ctx = makeNormalizeCtx();
    const like = normalize(
      ctx,
      'like',
      {
        common: { msgId: 'l1', createTime: String(T0 / 1000) },
        user: { id: '1', idStr: '1', displayId: 'h1', nickname: 'A', badgeList: [] },
        count: 5,
        total: '123456',
      },
      T0
    )!;
    const room = normalize(
      ctx,
      'roomUser',
      { common: { msgId: 'r1', createTime: String((T0 + 6000) / 1000) }, total: '87', totalUser: '9000', ranks: [] },
      T0 + 6000
    )!;
    store.applyBatch(sid, [like, room]);

    const tl = store.getSessionTimeline(sid, 5000);
    const withLikes = tl.filter((p) => p.roomTotalLikes != null);
    expect(withLikes.length).toBeGreaterThan(0);
    expect(withLikes[0]!.roomTotalLikes).toBe(123456);
    // And 同接 comes from `total`, not the cumulative `totalUser`.
    expect(tl.some((p) => p.viewers === 87)).toBe(true);
  });
});
