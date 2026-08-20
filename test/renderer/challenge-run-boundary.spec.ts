import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChallengeEffect, ChallengeState } from '@shared/dto';
import type { LiveMessage, WorkerState } from '@shared/ipc';

/**
 * ラン境界(start / reset)での履歴ログのリセット。
 *
 * worker は新しいランで recentEffects を空にするだけで「消せ」とは言ってこない。
 * renderer 側はリングから拾った effect を**自前の配列に積み直して**いるので
 * (worker にも DB にも履歴は無い)、境界を検知して捨てないと前のランのログが
 * 残り、「なぜ数字が動いたか」の履歴が2ラン分混ざる。
 *
 * 検知は startedMs の変化で行う。status 遷移だけを見ると stop→start の往復を
 * 取りこぼす、というのが実装の主張。ここではその主張を固定する。
 *
 * ログの実体は liveStore のモジュールスコープ変数なので、テストごとに
 * vi.resetModules() で作り直す(loop-lag.spec.ts と同じ流儀)。
 *
 * renderer ソースを import するため test/renderer/ に置く(test/unit は
 * tsconfig.node.json 側で型検査され DOM lib が無い)。
 */
const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

type LiveHandler = (m: LiveMessage) => void;
type StateHandler = (s: WorkerState) => void;
type Store = typeof import('../../src/renderer/state/liveStore');

let store: Store;
let idSeq = 0;

beforeEach(async () => {
  vi.stubGlobal('requestAnimationFrame', (): number => 1);
  vi.stubGlobal('cancelAnimationFrame', (): void => undefined);
  vi.stubGlobal('window', {
    api: {
      onLive: (_h: LiveHandler) => () => undefined,
      onWorkerState: (_h: StateHandler) => () => undefined,
    },
    setTimeout: (): number => 9999,
    clearTimeout: (): void => undefined,
  });
  // 履歴ログ・watermark はモジュールスコープに載っているので毎回作り直す。
  vi.resetModules();
  store = await import('../../src/renderer/state/liveStore');
  idSeq = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** ログに残る種類の effect(press は描画時に除かれるので follow を使う)。 */
function fx(over: Partial<ChallengeEffect> = {}): ChallengeEffect {
  idSeq += 1;
  return { id: idSeq, kind: 'follow', amount: 10, valueAfter: 100, atMs: NOW, ...over };
}

function challenge(over: Partial<ChallengeState> = {}): ChallengeState {
  return {
    status: 'running',
    value: 100,
    initialValue: 100,
    title: 'テスト企画',
    startedMs: NOW,
    achievedMs: null,
    stats: {
      presses: 0,
      follows: 0,
      giftDown: 0,
      giftUp: 0,
      likeUp: 0,
      likeStockUp: 0,
      likeDown: 0,
      likeStockDown: 0,
      commentUp: 0,
      joinDown: 0,
      joinUp: 0,
      rouletteSpins: 0,
    },
    recentEffects: [],
    likeGauge: null,
    result: null,
    ...over,
  };
}

function logLen(): number {
  return store.useLive.getState().challengeLog.length;
}

describe('ingestChallenge — ラン境界で履歴ログを捨てる', () => {
  it('同じラン中はログが積み上がる', () => {
    const a = fx();
    store.setChallenge(challenge({ recentEffects: [a] }));
    expect(logLen()).toBe(1);

    const b = fx();
    store.setChallenge(challenge({ recentEffects: [b, a] }));
    expect(logLen()).toBe(2);
  });

  it('reset(startedMs が null になる)でログが消える', () => {
    store.setChallenge(challenge({ recentEffects: [fx()] }));
    expect(logLen()).toBe(1);

    store.setChallenge(challenge({ status: 'idle', startedMs: null, recentEffects: [] }));
    expect(logLen()).toBe(0);
  });

  it('新しい start(startedMs が別の時刻)でログが消える', () => {
    store.setChallenge(challenge({ recentEffects: [fx()] }));
    expect(logLen()).toBe(1);

    store.setChallenge(challenge({ startedMs: NOW + 60_000, recentEffects: [] }));
    expect(logLen()).toBe(0);
  });

  it('一時停止だけではログを消さない(値を残す規約と揃える)', () => {
    store.setChallenge(challenge({ recentEffects: [fx()] }));
    expect(logLen()).toBe(1);

    // stop は startedMs を残す。ここで消すと「さっき何が起きたか」が見られなくなる。
    store.setChallenge(challenge({ status: 'idle', startedMs: NOW, value: 40, recentEffects: [] }));
    expect(logLen()).toBe(1);
  });

  it('stop → start の往復で消える(status だけを見ると取りこぼす経路)', () => {
    store.setChallenge(challenge({ recentEffects: [fx()] }));
    store.setChallenge(challenge({ status: 'idle', startedMs: NOW, recentEffects: [] }));
    expect(logLen()).toBe(1);

    // 開始し直し = 別の startedMs。
    store.setChallenge(challenge({ status: 'running', startedMs: NOW + 1000, recentEffects: [] }));
    expect(logLen()).toBe(0);
  });

  it('ラン境界のあとは小さい effect id でも積み直せる(後退判定ごと捨てる)', () => {
    store.setChallenge(challenge({ recentEffects: [fx({ id: 900 })] }));
    expect(logLen()).toBe(1);

    store.setChallenge(challenge({ startedMs: NOW + 5000, recentEffects: [] }));
    expect(logLen()).toBe(0);

    // 新しいランの id は前より小さいが、境界で watermark を捨てているので通る。
    store.setChallenge(challenge({ startedMs: NOW + 5000, recentEffects: [fx({ id: 5 })] }));
    expect(logLen()).toBe(1);
  });
});

describe('ingestChallenge — 境界と認めるのは前進だけ(旧ランの後着は破棄)', () => {
  it('reset 直後に旧ランのスナップショットが後着してもログを復活させない', () => {
    store.setChallenge(challenge({ recentEffects: [fx(), fx()] }));
    expect(logLen()).toBe(2);

    // reset — ログが消え、確認ダイアログの「すべて消えます」が成立する。
    store.setChallenge(challenge({ status: 'idle', startedMs: null, value: 100, recentEffects: [] }));
    expect(logLen()).toBe(0);

    // reset 直前に投げた press RPC の返り値(旧ランの startedMs とリング)が後着。
    // 境界の再検出で watermark が白紙になり前ランのログが全件復活していた経路。
    store.setChallenge(
      challenge({ value: 55, recentEffects: [fx({ id: 2 }), fx({ id: 1 })] })
    );
    expect(logLen()).toBe(0);
    // スナップショットごと破棄されるので、7セグの値も reset 後のまま。
    expect(store.useLive.getState().challenge?.value).toBe(100);
    expect(store.useLive.getState().challenge?.startedMs).toBeNull();
  });

  it('走行中に旧ランのスナップショットが後着しても破棄する', () => {
    store.setChallenge(challenge({ recentEffects: [fx()] }));
    store.setChallenge(challenge({ startedMs: NOW + 60_000, recentEffects: [] }));
    expect(logLen()).toBe(0);

    store.setChallenge(challenge({ value: 1, recentEffects: [fx({ id: 50 })] }));
    expect(logLen()).toBe(0);
    expect(store.useLive.getState().challenge?.startedMs).toBe(NOW + 60_000);
  });

  it('reset 後の新しい start(前ランより新しい startedMs)は境界として受け入れる', () => {
    store.setChallenge(challenge({ recentEffects: [fx()] }));
    store.setChallenge(challenge({ status: 'idle', startedMs: null, recentEffects: [] }));

    store.setChallenge(challenge({ startedMs: NOW + 1000, recentEffects: [fx({ id: 1 })] }));
    expect(logLen()).toBe(1);
    expect(store.useLive.getState().challenge?.startedMs).toBe(NOW + 1000);
  });
});
