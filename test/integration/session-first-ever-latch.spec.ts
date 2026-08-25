import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { DEFAULT_MISSIONS } from '@shared/missions';
import type { LiveMessage } from '@shared/ipc';
import type { NormalizedEvent } from '@shared/events';
import { ChallengeEngine } from '../../src/worker/challenge';
import { SessionManager } from '../../src/worker/session';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';

/**
 * 回帰テスト: ライブ経路の初見判定は DB のラッチ値(vss.is_first_ever)が正。
 *
 * ダイヤ貢献ランキング(roomUser.ranks → topContributors)は viewer を持つ
 * イベントではないため metaOf を通らず、DB の visits だけが本人の入室より先に
 * +1 される。metaOf が visits===0 で初見を再計算していた頃は、この先行書き込みで
 * 高ランク視聴者ほど初見扱いが消え、初見ルーレット(challenge の joinFirstEver
 * ガード)が無言で不発になった。メモ保存(invalidateMeta)や TTL 剪定による
 * キャッシュ再取得でも同じ再計算が走り、配信中に初見フラグが反転した。
 */

let dir: string;
let store: Store;
let sm: SessionManager | null = null;
let posts: LiveMessage[] = [];

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
  dir = mkdtempSync(join(tmpdir(), 'tls-first-ever-'));
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
  sessionId: number | null;
  metaOf(id: string): { firstEver: boolean };
}
const internals = (m: SessionManager) => m as unknown as SmInternals;

function open(startedMs: number, roomId = 'room-1') {
  return store.openSession({ hostUserId: 'host1', hostUniqueId: 'me', roomId, startedMs });
}

describe('初見ラッチ — metaOf は DB の is_first_ever を尊重する', () => {
  it('ダイヤランキング(ranks)が入室より先に届いても初見扱いは消えない', () => {
    sm = makeSession();
    const s = internals(sm);
    const sid = open(T0).sessionId;
    s.sessionId = sid;

    // 接続直後のバックログ相当: 本人の入室前にランキングだけが届く。
    store.applyBatch(sid, [ev('roomUser', { total: '10', ranks: [{ user: u('top1'), score: '9999', rank: 1 }] }, T0 + 50)]);

    // 前提の固定: ranks → touchViewer で DB には来店+1 が既に書かれている。
    const row = store.getSessionViewerTable(sid, {}).rows.find((r) => r.userId === 'top1')!;
    expect(row.visits).toBe(1);
    expect(row.isFirstEver).toBe(true);

    // 入室処理(metaOf キャッシュミス)— visits は 1 だがラッチ値で初見のまま。
    expect(s.metaOf('top1').firstEver).toBe(true);
  });

  it('入室が DB に書かれた後の再取得(メモ保存・剪定)でも初見フラグが反転しない', () => {
    sm = makeSession();
    const s = internals(sm);
    const sid = open(T0).sessionId;
    s.sessionId = sid;

    store.applyBatch(sid, [ev('member', { common: { msgId: 'j1', createTime: String(T0 / 1000) }, user: u('v1'), action: 1 }, T0 + 100)]);
    expect(s.metaOf('v1').firstEver).toBe(true);

    sm.invalidateMeta('v1');
    expect(s.metaOf('v1').firstEver).toBe(true);
  });

  it('過去セッションに来店済みの再訪者は初見にならない', () => {
    const s1 = open(T0).sessionId;
    store.applyBatch(s1, [ev('member', { common: { msgId: 'j9a', createTime: String(T0 / 1000) }, user: u('v9'), action: 1 }, T0 + 100)]);

    const s2 = open(T0 + 60 * MIN);
    expect(s2.sessionId).not.toBe(s1);
    sm = makeSession();
    const s = internals(sm);
    s.sessionId = s2.sessionId;

    // 今セッションの vss 行がまだ無い段階(COALESCE で 0)でも false。
    expect(s.metaOf('v9').firstEver).toBe(false);

    // 今セッションの入室がラッチ 0 で書かれた後、キャッシュ破棄しても false のまま。
    store.applyBatch(s2.sessionId, [
      ev('member', { common: { msgId: 'j9b', createTime: String((T0 + 61 * MIN) / 1000) }, user: u('v9'), action: 1 }, T0 + 61 * MIN),
    ]);
    sm.invalidateMeta('v9');
    expect(s.metaOf('v9').firstEver).toBe(false);
  });
});
