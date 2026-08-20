import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChallengeState } from '@shared/dto';
import type { LiveMessage, LiveTotals } from '@shared/ipc';
import { attachLive, useLive } from '../../src/renderer/state/liveStore';

/**
 * resetLive(status 'live')が保留中の challenge パッチまで捨てない回帰テスト。
 *
 * delta は rAF+250ms で遅延反映されるが、status 'live' は同期で resetLive() を
 * 呼ぶ。ここで pendingPatch を全キー破棄すると、直前 delta に載っていた
 * challenge が消える — worker 側 drainIfChanged() は dirty を1回しか返さない
 * ので再送されず、running/achieved のずれが固定化して PUSH が効かなくなる。
 *
 * renderer ソースを import するため、この spec だけ tsconfig.web.json 側で
 * 型検査する(test/renderer/ は tsconfig.node.json から除外)。実行は他と同じ
 * vitest の node 環境 — window / rAF は下のスタブで駆動する。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

type LiveHandler = (m: LiveMessage) => void;

let onLiveHandler: LiveHandler = () => undefined;
const rafCbs = new Map<number, FrameRequestCallback>();
let rafSeq = 0;

/** 捕獲済みの rAF コールバックを発火する(ブラウザの次フレーム相当)。 */
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
      onWorkerState: () => () => undefined,
    },
    // フォールバックタイマーは発火させない — flush は fireRaf() で駆動する。
    setTimeout: (): number => 9999,
    clearTimeout: (): void => undefined,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function totals(over: Partial<LiveTotals> = {}): LiveTotals {
  return {
    viewers: 10,
    peakViewers: 10,
    totalViewers: 10,
    roomTotalLikes: 100,
    observedLikes: 50,
    diamonds: 30,
    heartMe: 0,
    comments: 7,
    newFollowers: 1,
    shares: 0,
    uniqueViewers: 10,
    firstTimers: 2,
    elapsedMs: 60_000,
    ...over,
  };
}

function runningChallenge(): ChallengeState {
  return {
    status: 'running',
    value: 100,
    initialValue: 100,
    title: 'テスト企画',
    startedMs: NOW,
    achievedMs: null,
    stats: {
      presses: 3,
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
  };
}

describe('resetLive と保留中 challenge パッチ', () => {
  it("status 'live' 直前の delta に載っていた challenge が flush 後も残る", () => {
    const detach = attachLive();

    // ① challenge 入り delta(rAF 待ちの pendingPatch に積まれる)
    onLiveHandler({
      t: 'delta',
      tick: 1,
      atMs: NOW,
      sessionId: 1,
      totals: totals(),
      viewers: [],
      alerts: [],
      challenge: runningChallenge(),
      deferred: 0,
    });

    // ② 接続確立(同期で resetLive が走る)— rAF はまだ発火していない
    onLiveHandler({
      t: 'status',
      status: { state: 'live', roomId: 'r1', hostDisplayId: 'host', startedMs: NOW },
      sessionId: 1,
    });

    // ③ 次フレームで flush
    fireRaf();

    const s = useLive.getState();
    // challenge はセッション独立の寿命 — resetLive で捨てられてはいけない。
    expect(s.challenge?.status).toBe('running');
    // resetLive 本来の意図(直前 delta の totals/feed の復活防止)は維持される。
    expect(s.totals.comments).toBe(0);
    expect(s.totals.diamonds).toBe(0);
    expect(s.feed).toEqual([]);
    expect(s.alerts).toEqual([]);

    detach();
  });
});
