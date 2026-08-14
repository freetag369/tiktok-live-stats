import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import type { LiveMessage } from '@shared/ipc';
import { DEFAULT_MISSIONS } from '@shared/missions';
import { ChallengeEngine } from '../../src/worker/challenge';
import { SessionManager } from '../../src/worker/session';
import { Store } from '../../src/worker/store/index';

/**
 * 'live' 遷移直後に challenge 入りの全量 delta が必ず配られる回帰テスト。
 *
 * renderer は status 'live' の受信で resetLive() し、その瞬間に保留中だった
 * challenge パッチを失いうる。worker の drainIfChanged() は dirty を1回しか
 * 返さない(捨てられたら再送なし)ので、onStatus は 'live' を配った直後に
 * pushDelta(true) で最新スナップショットを配り直す。postMessage の順序保証で
 * renderer では必ず「'live' → resetLive → 全量 delta」の順になる。
 */
let dir: string;
let store: Store;
let sm: SessionManager | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-live-resend-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, { idAliases: {}, nameRules: [] });
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

describe("'live' 遷移直後の challenge 再送", () => {
  it("status 'live' の後に challenge(running)入りの delta が配られる", async () => {
    const challenge = new ChallengeEngine(() => DEFAULT_CHALLENGE, Date.now, Math.random, Math.random, () => undefined);
    const posted: LiveMessage[] = [];
    sm = new SessionManager({
      store,
      post: (m: LiveMessage) => {
        posted.push(m);
      },
      userDataDir: dir,
      getSettings: () => ({ eulerApiKey: '', captureDebug: false, alertMinTier: 3, giftAlertDiamonds: 100 }),
      getMissionConfig: () => DEFAULT_MISSIONS,
      challenge,
    });

    challenge.start();
    // renderer 側で resetLive がパッチを捨てた状況を再現する:
    // dirty は消費済み = 以後 drainIfChanged() は null しか返さない。
    expect(challenge.drainIfChanged()).not.toBeNull();
    expect(challenge.drainIfChanged()).toBeNull();

    const started = await sm.startReplay(resolve('fixtures/synth-small-room.ndjson'), 1000);
    expect(started.sessionId).not.toBeNull();

    const liveIdx = posted.findIndex((m) => m.t === 'status' && m.status.state === 'live');
    expect(liveIdx).toBeGreaterThanOrEqual(0);

    // 'live' より後に、challenge を載せた delta が存在し、実状態(running)を運ぶ。
    const resent = posted
      .slice(liveIdx + 1)
      .find((m) => m.t === 'delta' && m.challenge != null);
    expect(resent).toBeDefined();
    expect(resent?.t === 'delta' && resent.challenge?.status).toBe('running');
  });
});
