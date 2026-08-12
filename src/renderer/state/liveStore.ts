import { create } from 'zustand';
import type { AdapterStatus, QuotaInfo, UserId } from '@shared/events';
import type { DeltaViewer, FeedItem, JoinAlertCard, LiveMessage, LiveTotals, WorkerState } from '@shared/ipc';
import type { ChallengeLogEntry, ChallengeState, MissionProgress } from '@shared/dto';
import { appendChallengeLog } from '@shared/challenge';

/**
 * The live table can hold 5,000 rows updating twice a second. Putting that Map in
 * React state would re-render everything on every tick, so the Map lives outside
 * React and only a monotonic version counter is reactive; components read the
 * snapshot array that is rebuilt at most twice a second.
 */
export interface LiveRow {
  userId: UserId;
  nickname: string;
  displayId: string;
  avatarUrl: string | null;
  diamonds: number;
  comments: number;
  likes: number;
  gifts: number;
  heartMe: number;
  lastSeenMs: number;
  flags: number;
}

const rows = new Map<UserId, LiveRow>();
let snapshot: LiveRow[] = [];

export function liveRows(): LiveRow[] {
  return snapshot;
}

export function liveRow(userId: UserId): LiveRow | undefined {
  return rows.get(userId);
}

interface LiveState {
  version: number;
  totals: LiveTotals;
  /** Newest first. 初見 / VIP / 質問 live in this one lane, distinguished by colour. */
  feed: FeedItem[];
  alerts: JoinAlertCard[];
  missions: MissionProgress[];
  /** カウントダウンチャレンジ。配信セッションとは独立の寿命(resetLive で消さない)。 */
  challenge: ChallengeState | null;
  /**
   * チャレンジの履歴ログ(新しい順)。worker の12件リングバッファから拾い直した
   * もので、**ここが唯一の履歴**(worker にも DB にも残らない)。
   * LiveDashboard は route 切替でアンマウントされるので、ログはストア側に置く。
   */
  challengeLog: ChallengeLogEntry[];
  status: AdapterStatus;
  quota: QuotaInfo | null;
  sessionId: number | null;
  workerState: WorkerState;
  droppedFeed: number;
  deferred: number;
}

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

export const useLive = create<LiveState>(() => ({
  version: 0,
  totals: EMPTY_TOTALS,
  feed: [],
  alerts: [],
  missions: [],
  challenge: null,
  challengeLog: [],
  status: { state: 'idle' },
  quota: null,
  sessionId: null,
  workerState: 'starting',
  droppedFeed: 0,
  deferred: 0,
}));

const FEED_CAP = 300;
const ALERT_CAP = 12;

function mergeViewer(d: DeltaViewer): void {
  let r = rows.get(d.u);
  if (!r) {
    r = {
      userId: d.u,
      nickname: d.n ?? '',
      displayId: d.di ?? '',
      avatarUrl: d.a ?? null,
      diamonds: 0,
      comments: 0,
      likes: 0,
      gifts: 0,
      heartMe: 0,
      lastSeenMs: 0,
      flags: 0,
    };
    rows.set(d.u, r);
  } else {
    // Replace the object so React.memo on the row actually sees a change.
    r = { ...r };
    rows.set(d.u, r);
  }
  if (d.n) r.nickname = d.n;
  if (d.di) r.displayId = d.di;
  if (d.a) r.avatarUrl = d.a;
  if (d.d) r.diamonds += d.d;
  if (d.c) r.comments += d.c;
  if (d.l) r.likes += d.l;
  if (d.g) r.gifts += d.g;
  if (d.h) r.heartMe += d.h;
  if (d.ls) r.lastSeenMs = Math.max(r.lastSeenMs, d.ls);
  if (d.flags) r.flags |= d.flags;
}

export function resetLive(): void {
  rows.clear();
  snapshot = [];
  useLive.setState({
    version: 0,
    totals: EMPTY_TOTALS,
    feed: [],
    alerts: [],
    droppedFeed: 0,
    deferred: 0,
  });
}

let pendingFlush = false;

/** Coalesces bursts into a single rAF-gated state bump. */
function scheduleFlush(patch: Partial<LiveState>): void {
  Object.assign(pendingPatch, patch);
  if (pendingFlush) return;
  pendingFlush = true;
  requestAnimationFrame(() => {
    pendingFlush = false;
    snapshot = Array.from(rows.values());
    const p = { ...pendingPatch, version: useLive.getState().version + 1 };
    for (const k of Object.keys(pendingPatch)) delete (pendingPatch as Record<string, unknown>)[k];
    useLive.setState(p);
  });
}
const pendingPatch: Partial<LiveState> = {};

export function attachLive(): () => void {
  const offLive = window.api.onLive((m: LiveMessage) => {
    switch (m.t) {
      case 'delta': {
        for (const v of m.viewers) mergeViewer(v);
        const s = useLive.getState();
        scheduleFlush({
          totals: m.totals,
          sessionId: m.sessionId,
          deferred: m.deferred,
          ...(m.missions ? { missions: m.missions } : {}),
          ...(m.challenge ? ingestChallenge(m.challenge) : {}),
          ...(m.alerts.length ? { alerts: [...m.alerts, ...s.alerts].slice(0, ALERT_CAP) } : {}),
        });
        return;
      }
      case 'feed': {
        const s = useLive.getState();
        // NEWEST FIRST. `m.items` arrives oldest-first within the tick, so it is
        // reversed before being placed ahead of everything already on screen —
        // index 0 is the most recent comment and renders at the top.
        const nextFeed = [...m.items].reverse().concat(s.feed).slice(0, FEED_CAP);
        scheduleFlush({ feed: nextFeed, droppedFeed: s.droppedFeed + m.dropped });
        return;
      }
      case 'status':
        useLive.setState({ status: m.status, sessionId: m.sessionId, quota: m.quota ?? useLive.getState().quota });
        if (m.status.state === 'live') resetLive();
        return;
      case 'job':
        return;
    }
  });

  const offState = window.api.onWorkerState((s) => useLive.setState({ workerState: s }));
  return () => {
    offLive();
    offState();
  };
}

export function dismissAlert(userId: UserId): void {
  useLive.setState((s) => ({ alerts: s.alerts.filter((a) => a.userId !== userId) }));
}

/**
 * 履歴ログの積み上げ状態。React の外に置く — delta は rAF でコアレスされるので、
 * ストアから読み戻すと同じ tick 内の2件目が1件目を無かったことにする。
 */
let logEntries: ChallengeLogEntry[] = [];
let lastLoggedId: number | null = null;
let lastStartedMs: number | null | undefined;

/**
 * ChallengeState を取り込み、履歴ログを更新して差分パッチを返す。
 * delta 経路と RPC 経路の両方がここを通る(同じ状態を二度受けても冪等)。
 */
function ingestChallenge(state: ChallengeState): Partial<LiveState> {
  // start / reset の検知。worker 側は recentEffects を空にするだけで「消せ」とは
  // 言ってこないので、startedMs の変化(start=新しい時刻 / reset=null)で判断する。
  // status 遷移だけを見ると stop→start の往復を取りこぼす。
  if (lastStartedMs !== undefined && lastStartedMs !== state.startedMs) {
    logEntries = [];
    lastLoggedId = null;
  }
  lastStartedMs = state.startedMs;

  const next = appendChallengeLog(logEntries, state, lastLoggedId);
  lastLoggedId = next.lastId;
  if (next.log === logEntries) return { challenge: state };
  logEntries = next.log;
  return { challenge: state, challengeLog: next.log };
}

/** RPC(challenge.*)の戻り値で即時反映する。delta からの上書きと冪等。 */
export function setChallenge(state: ChallengeState): void {
  useLive.setState(ingestChallenge(state));
}
