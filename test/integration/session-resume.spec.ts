import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import type { NormalizedEvent } from '@shared/events';

/**
 * 回帰テスト: セッション分裂と二重採点。
 *
 * かつて resume 判定は「開いたままのセッション」の最終活動を started_ms とみなして
 * いたため、配信開始から10分を超えた時点の切断→再接続で必ずセッションが分裂した。
 * また closeSession の採点は累積型で、停止→再開→再停止すると同じセッションが
 * 二重採点されて score / streak が恒久的に膨らんだ。
 */

let dir: string;
let store: Store;

const ALIASES = { idAliases: {}, nameRules: [] };
const T0 = Date.UTC(2026, 6, 28, 12, 0, 0);
const MIN = 60_000;
const ctx = () => makeNormalizeCtx();

function u(id: string) {
  return { id, idStr: id, displayId: `handle_${id}`, nickname: `user${id}`, secUid: `MS4wLjABAAAA${id}`, badgeList: [] };
}

function ev(kind: string, data: Record<string, unknown>, at: number): NormalizedEvent {
  const e = normalize(ctx(), kind, { common: { createTime: String(Math.floor(at / 1000)) }, ...data }, at);
  if (!e) throw new Error(`normalize returned null for ${kind}`);
  return e;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-resume-'));
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

function open(startedMs: number, roomId = 'room-1') {
  return store.openSession({ hostUserId: 'host1', hostUniqueId: 'me', roomId, startedMs });
}

describe('resume — ライブ中の再接続', () => {
  it('配信開始から10分超でも、直近に活動があれば同一セッションへ resume する', () => {
    const s1 = open(T0);
    // 20分間イベントが続いた配信の途中で切断された想定。
    store.applyBatch(s1.sessionId, [
      ev('chat', { common: { msgId: 'c1', createTime: String((T0 + 20 * MIN) / 1000) }, user: u('1'), content: 'a' }, T0 + 20 * MIN),
    ]);
    // 2分後に再接続 — 最終活動(20分時点のコメント)からは gap 内。
    const s2 = open(T0 + 22 * MIN);
    expect(s2.resumed).toBe(true);
    expect(s2.sessionId).toBe(s1.sessionId);
  });

  it('開いたままでも最終活動が古すぎるゾンビセッションへは resume しない', () => {
    const s1 = open(T0);
    store.applyBatch(s1.sessionId, [
      ev('chat', { common: { msgId: 'c1', createTime: String(T0 / 1000) }, user: u('1'), content: 'a' }, T0),
    ]);
    // 最終活動(T0)から30分後 — 別配信として扱う。
    const s2 = open(T0 + 30 * MIN);
    expect(s2.resumed).toBe(false);
    expect(s2.sessionId).not.toBe(s1.sessionId);
  });
});

describe('採点の冪等性 — 停止→再開→再停止', () => {
  it('同じセッションを二度クローズしてもスコアとストリークが増えない', () => {
    const s1 = open(T0);
    store.applyBatch(s1.sessionId, [
      ev(
        'gift',
        {
          common: { msgId: 'g1', createTime: String(T0 / 1000) },
          user: u('1'),
          giftId: '5655',
          repeatCount: 1,
          repeatEnd: 1,
          gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 100 },
        },
        T0
      ),
    ]);
    store.closeSession(s1.sessionId, { endedMs: T0 + 5 * MIN, reason: 'streamEnd' });

    const before = store.getSessionViewerTable(s1.sessionId, {}).rows[0]!;
    expect(before.score).toBeGreaterThan(0);
    expect(before.consecutiveStreak).toBe(1);

    // 10分以内の再開 → 同一セッション → 再クローズ。
    const s2 = open(T0 + 8 * MIN);
    expect(s2.resumed).toBe(true);
    expect(s2.sessionId).toBe(s1.sessionId);
    store.closeSession(s1.sessionId, { endedMs: T0 + 10 * MIN, reason: 'streamEnd' });

    const after = store.getSessionViewerTable(s1.sessionId, {}).rows[0]!;
    expect(after.score).toBeCloseTo(before.score, 5);
    expect(after.consecutiveStreak).toBe(1);
  });

  it('再開後の増分だけが加点される', () => {
    const gift = (msgId: string, at: number, diamonds: number) =>
      ev(
        'gift',
        {
          common: { msgId, createTime: String(at / 1000) },
          user: u('1'),
          giftId: '5655',
          repeatCount: 1,
          repeatEnd: 1,
          gift: { id: '5655', name: 'Rose', type: 1, diamondCount: diamonds },
        },
        at
      );

    const s1 = open(T0);
    store.applyBatch(s1.sessionId, [gift('g1', T0, 100)]);
    store.closeSession(s1.sessionId, { endedMs: T0 + 5 * MIN, reason: 'streamEnd' });
    const s2 = open(T0 + 8 * MIN);
    store.applyBatch(s2.sessionId, [gift('g2', T0 + 9 * MIN, 100)]);
    store.closeSession(s2.sessionId, { endedMs: T0 + 10 * MIN, reason: 'streamEnd' });

    // 比較対象: 一度で 200 ダイヤを投げた別視聴者と同じスコアになるはず。
    const s3 = open(T0 + 60 * MIN, 'room-2');
    store.applyBatch(s3.sessionId, [
      ev(
        'gift',
        {
          common: { msgId: 'g3', createTime: String((T0 + 60 * MIN) / 1000) },
          user: u('2'),
          giftId: '5655',
          repeatCount: 2,
          repeatEnd: 1,
          gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 100 },
        },
        T0 + 60 * MIN
      ),
    ]);
    store.closeSession(s3.sessionId, { endedMs: T0 + 90 * MIN, reason: 'streamEnd' });

    const rows = store.getSessionViewerTable(null, { sort: 'lastSeen' }).rows;
    const v1 = rows.find((r) => r.userId === '1')!;
    const v2 = rows.find((r) => r.userId === '2')!;
    expect(v1.diamondsLifetime).toBe(200);
    expect(v2.diamondsLifetime).toBe(200);
    // epochFactor はセッション開始時刻依存なので完全一致にはならないが、
    // 二重加算(2倍)とは明確に区別できる誤差に収まる。
    expect(v1.score).toBeGreaterThan(v2.score * 0.9);
    expect(v1.score).toBeLessThan(v2.score * 1.1);
  });
});

describe('封筒(envelope) — セッション合計と視聴者別集計の整合', () => {
  it('過去配信で既知・今回未入室の視聴者の封筒でも vss 行が作られ乖離しない', () => {
    // セッション1で視聴者を既知にする。
    const s1 = open(T0);
    store.applyBatch(s1.sessionId, [
      ev('chat', { common: { msgId: 'c1', createTime: String(T0 / 1000) }, user: u('9'), content: 'a' }, T0),
    ]);
    store.closeSession(s1.sessionId, { endedMs: T0 + 5 * MIN, reason: 'streamEnd' });

    // 30分後の新セッションに、入室イベント無しで封筒だけが届く。
    const s2 = open(T0 + 35 * MIN);
    expect(s2.sessionId).not.toBe(s1.sessionId);
    const at = T0 + 36 * MIN;
    store.applyBatch(s2.sessionId, [
      ev('envelope', { envelopeInfo: { envelopeId: 'env1', sendUserId: '9', diamondCount: 500, peopleCount: 10 } }, at),
    ]);

    const totals = store.getSessionTotals(s2.sessionId)!;
    expect(totals.diamonds).toBe(500);
    const row = store.getSessionViewerTable(s2.sessionId, {}).rows.find((r) => r.userId === '9');
    expect(row).toBeDefined();
    expect(row!.diamondsCurrent).toBe(500);
  });
});
