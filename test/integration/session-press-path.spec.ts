import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { DEFAULT_MISSIONS } from '@shared/missions';
import { ChallengeEngine } from '../../src/worker/challenge';
import { SessionManager } from '../../src/worker/session';
import { Store } from '../../src/worker/store/index';

/**
 * 押下(challenge.press)の応答経路に同期SQL を残さないための回帰テスト。
 *
 * worker は単一スレッドで node:sqlite も同期なので、pushDelta の中で SQL を
 * 走らせるとその時間ぶんだけ press の RPC が遅れる(クエリ実行中は後続の
 * メッセージが配送すらされない)。ミッション計算は専用タイマーへ追い出した。
 */
let dir: string;
let store: Store;
let sm: SessionManager | null = null;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-press-'));
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

function makeSession(): SessionManager {
  const challenge = new ChallengeEngine(() => DEFAULT_CHALLENGE, Date.now, Math.random, Math.random, () => undefined);
  return new SessionManager({
    store,
    post: () => undefined,
    userDataDir: dir,
    getSettings: () => ({ eulerApiKey: '', captureDebug: false, alertMinTier: 3, giftAlertDiamonds: 100 }),
    getMissionConfig: () => DEFAULT_MISSIONS,
    challenge,
  });
}

describe('押下経路に同期SQL を残さない', () => {
  it('セッション中に nudgeChallenge を100回叩いても getMissionInputs は呼ばれない', async () => {
    sm = makeSession();
    const started = await sm.startReplay(resolve('fixtures/synth-small-room.ndjson'), 1000);
    expect(started.sessionId).not.toBeNull();

    // スパイは「同期ブロックの直前」に張り、await を挟まずに数える。
    // 3秒間隔の missionTimer は同期コードの実行中には発火しないので、
    // ここで数えた値は純粋に nudgeChallenge 由来になる。
    let calls = 0;
    const orig = store.getMissionInputs.bind(store);
    store.getMissionInputs = ((...a: Parameters<Store['getMissionInputs']>) => {
      calls += 1;
      return orig(...a);
    }) as Store['getMissionInputs'];

    for (let i = 0; i < 100; i += 1) sm.nudgeChallenge();

    expect(calls).toBe(0);
  });

  it('pruneLikeSeen はトランザクションで括られ、古い行だけを消す', () => {
    const sid = store.openSession({ hostUserId: 'h1', hostUniqueId: 'h', roomId: 'r1', startedMs: 1_000_000 }).sessionId;
    store.applyBatch(sid, [
      { kind: 'like', tsMs: 1_000_000, msgId: 'old', viewer: { userId: 'u1' }, count: 1 },
      { kind: 'like', tsMs: 9_000_000, msgId: 'new', viewer: { userId: 'u1' }, count: 1 },
    ] as never);
    // 1回目で古い行だけが消え、2回目が 0 を返すことが COMMIT された証拠。
    // ROLLBACK していれば 2 回目も同じ行を消して 1 を返す。
    expect(store.pruneLikeSeen(5_000_000)).toBe(1);
    expect(store.pruneLikeSeen(5_000_000)).toBe(0);
    // 新しい行はまだ残っている。
    expect(store.pruneLikeSeen(10_000_000)).toBe(1);
  });
});
