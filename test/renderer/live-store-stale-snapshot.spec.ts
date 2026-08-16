import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChallengeEffect, ChallengeState } from '@shared/dto';
import type { LiveMessage, LiveTotals, WorkerState } from '@shared/ipc';
import { attachLive, setChallenge, useLive } from '../../src/renderer/state/liveStore';

/**
 * 「ルーレット/ギフトが贈られた個数を超えて再生される」の回帰テスト。
 *
 * delta は scheduleFlush の rAF(+250ms)コアレスで遅延反映されるが、RPC
 * (challenge.press / challenge.get)の返り値は setChallenge が即時反映する。press は
 * モニターの Space 押下と画面タップのたびに飛ぶので、**新しい delta を適用した後に
 * それより古い press の返り値が着弾する**逆転が起きる。
 *
 * 逆転で recentEffects が古い配列に差し替わると、watermark 方式の演出再生
 * (MonitorView / useChallengeSe)が「新しい effect が来た」と誤認して直近5秒ぶんを
 * 丸ごと再生し直す。ここでは**ストアが effect ストリームを後退させないこと**を固定する。
 *
 * renderer ソースを import するため test/renderer/ に置く(test/unit は
 * tsconfig.node.json 側で型検査され DOM lib が無い)。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

type LiveHandler = (m: LiveMessage) => void;
type StateHandler = (s: WorkerState) => void;

let onLiveHandler: LiveHandler = () => undefined;
let onStateHandler: StateHandler = () => undefined;
const rafCbs = new Map<number, FrameRequestCallback>();
let rafSeq = 0;

function fireRaf(): void {
  const cbs = [...rafCbs.values()];
  rafCbs.clear();
  for (const cb of cbs) cb(0);
}

beforeEach(() => {
  rafCbs.clear();
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
    rafSeq += 1;
    rafCbs.set(rafSeq, cb);
    return rafSeq;
  });
  vi.stubGlobal('cancelAnimationFrame', (id: number): void => {
    rafCbs.delete(id);
  });
  vi.stubGlobal('window', {
    api: {
      onLive: (h: LiveHandler) => {
        onLiveHandler = h;
        return () => undefined;
      },
      onWorkerState: (h: StateHandler) => {
        onStateHandler = h;
        return () => undefined;
      },
    },
    setTimeout: (): number => 9999,
    clearTimeout: (): void => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const EMPTY_TOTALS: LiveTotals = {
  viewers: null,
  peakViewers: 0,
  totalViewers: 0,
  roomTotalLikes: 0,
  observedLikes: 0,
  diamonds: 0,
  heartMe: 0,
  comments: 0,
  newFollowers: 0,
  shares: 0,
  uniqueViewers: 0,
  firstTimers: 0,
  elapsedMs: 0,
};

function fx(id: number): ChallengeEffect {
  return { id, kind: 'roulette', amount: 5, valueAfter: 100, atMs: NOW };
}

/** recentEffects は新しい順(worker の unshift と同じ)。 */
function challenge(
  effects: ChallengeEffect[],
  over: Partial<ChallengeState> = {}
): ChallengeState {
  return {
    status: 'running',
    value: 100,
    initialValue: 100,
    title: 'テスト企画',
    startedMs: NOW,
    achievedMs: null,
    stats: { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, joinDown: 0, joinUp: 0, rouletteSpins: 0 },
    recentEffects: effects,
    likeGauge: null,
    result: null,
    ...over,
  };
}

function pushDelta(state: ChallengeState): void {
  onLiveHandler({
    t: 'delta',
    tick: 1,
    atMs: NOW,
    sessionId: 1,
    totals: EMPTY_TOTALS,
    viewers: [],
    alerts: [],
    challenge: state,
    deferred: 0,
  });
  fireRaf();
}

describe('ingestChallenge — effect ストリームは後退させない', () => {
  it('古いスナップショットが後着しても recentEffects は据え置く(参照ごと同じ)', () => {
    const detach = attachLive();
    const fresh = [fx(105), fx(104)];
    pushDelta(challenge(fresh));
    expect(useLive.getState().challenge?.recentEffects).toBe(fresh);

    // 押下前に発行された press RPC の返り値が、delta より後に解決した形。
    setChallenge(challenge([fx(100), fx(99)], { value: 95 }));

    const s = useLive.getState().challenge!;
    // 演出の入力は据え置き(参照が変わらないので MonitorView の effect も再走しない)。
    expect(s.recentEffects).toBe(fresh);
    // press の即時フィードバック(値)は通す — 据え置くのは演出の入力だけ。
    expect(s.value).toBe(95);
    detach();
  });

  it('前進したスナップショットは普通に採用する', () => {
    const detach = attachLive();
    pushDelta(challenge([fx(205), fx(204)], { startedMs: NOW + 1 }));
    const next = [fx(207), fx(206)];
    setChallenge(challenge(next, { startedMs: NOW + 1 }));
    expect(useLive.getState().challenge?.recentEffects).toBe(next);
    detach();
  });

  it("worker 再起動('starting')で workerEpoch が進み、小さい id を受け入れ直す", () => {
    const detach = attachLive();
    pushDelta(challenge([fx(305), fx(304)], { startedMs: NOW + 2 }));
    const before = useLive.getState().workerEpoch;

    // main の WorkerHost: クラッシュ復帰は restarting → starting → ready。
    // **ready の直前は常に starting** なので、世代の合図は 'starting' で取る。
    onStateHandler('restarting');
    onStateHandler('starting');
    onStateHandler('ready');
    expect(useLive.getState().workerEpoch).toBe(before + 1);

    // 新しい worker は id 1 から振り直す。後退ガードは白紙に戻っているので通る。
    const reborn = [fx(2), fx(1)];
    setChallenge(challenge(reborn, { startedMs: NOW + 2 }));
    expect(useLive.getState().challenge?.recentEffects).toBe(reborn);
    detach();
  });

  it("'starting' の再通知では上げない(1 worker = 1 世代)", () => {
    const detach = attachLive();
    onStateHandler('ready');
    const before = useLive.getState().workerEpoch;
    onStateHandler('starting');
    onStateHandler('starting'); // 同じ世代の再通知では上げない
    onStateHandler('ready');
    expect(useLive.getState().workerEpoch).toBe(before + 1);
    detach();
  });
});
