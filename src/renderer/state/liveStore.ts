import { create } from 'zustand';
import type { AdapterStatus, QuotaInfo, UserId } from '@shared/events';
import type { DeltaViewer, FeedItem, JoinAlertCard, LiveMessage, LiveTotals, WorkerState } from '@shared/ipc';
import type { ChallengeLogEntry, ChallengeState, MissionProgress } from '@shared/dto';
import {
  appendChallengeLog,
  challengeSnapshotMaxEffectId,
  isStaleChallengeSnapshot,
} from '@shared/challenge';
import { pruneLiveRows } from '@shared/live-rows';

/**
 * The live table can hold 5,000 rows updating twice a second. Putting that Map in
 * React state would re-render everything on every tick, so the Map lives outside
 * React and only a monotonic version counter is reactive; components do point
 * lookups via liveRow() when the version bumps.
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
  /**
   * worker の世代。`'starting'` への遷移(= WorkerHost.start() が新しい
   * utilityProcess を起こした)で +1 する。**演出 watermark の唯一のリセット信号** —
   * worker が再起動すると effect の id が 1 から振り直されるので、購読側は
   * これが変わったら watermark を null(= 全件再生済みに倒す)へ戻す。
   * かつては freshChallengeEffects が「id が watermark を下回ったら再起動」と
   * 推測していたが、古いスナップショットの後着でも成立して演出が重複再生された。
   */
  workerEpoch: number;
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
  workerEpoch: 0,
  droppedFeed: 0,
  deferred: 0,
}));

const FEED_CAP = 300;
const ALERT_CAP = 12;

/**
 * 剪定の間隔と保持期間。タイマーは持たず mergeViewer のついでに償却実行する
 * (タイマー自体がリークになるのを避ける)。
 */
const ROWS_PRUNE_EVERY_MS = 60_000;
const ROWS_TTL_MS = 30 * 60_000;
const ROWS_HARD_CAP = 20_000;
let lastRowsPruneMs = 0;

function mergeViewer(d: DeltaViewer): void {
  // 上限が無いと耐久配信でユニーク視聴者数ぶん単調増加する。詳細は prune.ts。
  const now = Date.now();
  if (now - lastRowsPruneMs > ROWS_PRUNE_EVERY_MS) {
    lastRowsPruneMs = now;
    pruneLiveRows(rows, now, ROWS_TTL_MS, ROWS_HARD_CAP);
  }
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
  lastRowsPruneMs = 0;
  // 保留中のフラッシュを捨てる: 直前 delta の totals/feed が rAF でクリア直後に
  // 復活する(配信開始 = status 'live' と delta が近接する瞬間に起きる)のを防ぐ。
  // ただし challenge はセッションから独立した寿命を持つ(上の setState でも消して
  // いない)ので温存する — 捨てると worker 側は dirty 消費済みで再送せず、
  // status のずれ(running/achieved)が固定化して PUSH が効かなくなる。
  for (const k of Object.keys(pendingPatch)) {
    if (k === 'challenge' || k === 'challengeLog') continue;
    delete (pendingPatch as Record<string, unknown>)[k];
  }
  useLive.setState({
    version: 0,
    totals: EMPTY_TOTALS,
    feed: [],
    alerts: [],
    droppedFeed: 0,
    deferred: 0,
  });
}

let flushRafId = 0;
let flushTimerId = 0;

/**
 * rAF が返ってこない環境(GPU プロセスのリセット、ディスプレイ構成変更、
 * 遮蔽と省電力の組合せ等)でも delta の反映が止まらないためのフォールバック尺。
 * 旧実装は rAF 単独依存で、コールバックが一度も呼ばれないと pendingFlush が
 * true に固着し、以後 7セグも演出も**完全に**止まった。
 */
const FLUSH_FALLBACK_MS = 250;

function flushPending(): void {
  // 先に発火した方が両方を回収する — 二重 flush は version の空回りになる。
  if (flushRafId) cancelAnimationFrame(flushRafId);
  if (flushTimerId) window.clearTimeout(flushTimerId);
  flushRafId = 0;
  flushTimerId = 0;
  const p = { ...pendingPatch, version: useLive.getState().version + 1 };
  for (const k of Object.keys(pendingPatch)) delete (pendingPatch as Record<string, unknown>)[k];
  useLive.setState(p);
}

/** Coalesces bursts into a single rAF-gated state bump (with a timer fallback). */
function scheduleFlush(patch: Partial<LiveState>): void {
  Object.assign(pendingPatch, patch);
  if (flushRafId || flushTimerId) return;
  flushRafId = requestAnimationFrame(flushPending);
  flushTimerId = window.setTimeout(flushPending, FLUSH_FALLBACK_MS);
}
const pendingPatch: Partial<LiveState> = {};

/**
 * 「未フラッシュの値も含めた」現在値。ストアだけを読むと、同一フレーム内の
 * 2通目の feed/alerts が1通目を無かったことにする(rAF コアレスの取りこぼし)。
 */
function effective<K extends keyof LiveState>(k: K): LiveState[K] {
  return k in pendingPatch ? (pendingPatch as LiveState)[k] : useLive.getState()[k];
}

/**
 * `lite` はモニター窓用 — MonitorView が消費するのは challenge / totals /
 * sessionId だけなので、視聴者 Map のマージとフィード取り込みを丸ごと省く。
 * モニター窓は backgroundThrottling が無効で常時フル稼働のため、ここを削ると
 * 長時間配信での CPU / GC 負荷が視聴者数に比例して積み上がらなくなる。
 */
export function attachLive(opts?: { lite?: boolean }): () => void {
  const lite = opts?.lite ?? false;
  const offLive = window.api.onLive((m: LiveMessage) => {
    switch (m.t) {
      case 'delta': {
        if (lite) {
          scheduleFlush({
            totals: m.totals,
            sessionId: m.sessionId,
            ...(m.challenge ? ingestChallenge(m.challenge) : {}),
          });
          return;
        }
        for (const v of m.viewers) mergeViewer(v);
        scheduleFlush({
          totals: m.totals,
          sessionId: m.sessionId,
          deferred: m.deferred,
          ...(m.missions ? { missions: m.missions } : {}),
          ...(m.challenge ? ingestChallenge(m.challenge) : {}),
          ...(m.alerts.length ? { alerts: [...m.alerts, ...effective('alerts')].slice(0, ALERT_CAP) } : {}),
        });
        return;
      }
      case 'feed': {
        if (lite) return;
        // NEWEST FIRST. `m.items` arrives oldest-first within the tick, so it is
        // reversed before being placed ahead of everything already on screen —
        // index 0 is the most recent comment and renders at the top.
        const nextFeed = [...m.items].reverse().concat(effective('feed')).slice(0, FEED_CAP);
        scheduleFlush({ feed: nextFeed, droppedFeed: effective('droppedFeed') + m.dropped });
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

  const offState = window.api.onWorkerState((s) => {
    const prev = useLive.getState().workerState;
    // worker 世代の**唯一の合図は 'starting'** — main の WorkerHost.start() が
    // 冒頭で必ず1回だけ撃つので、utilityProcess 1本につきちょうど1回届く
    // (クラッシュ復帰は restarting → starting → ready、手動再起動は
    //  dead → starting → ready。**ready の直前は常に starting** なので
    //  「restarting|dead → ready」を見ると一度も発火しない)。
    // 新しい worker では effect の id が 1 から振り直されるため、ここで watermark
    // (演出再生 / 効果音 / 履歴ログ)を白紙へ戻す。初回起動でも走るが、そのときは
    // まだ何も取り込んでいないので実質 no-op。
    const restarted = s === 'starting' && prev !== 'starting';
    if (restarted) resetChallengeWatermarks();
    useLive.setState((st) => ({
      workerState: s,
      workerEpoch: restarted ? st.workerEpoch + 1 : st.workerEpoch,
    }));
  });
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
 * 取り込み済みの effect ストリームの世代印と、その中身。
 *
 * **なぜ要るか**: delta は scheduleFlush の rAF(+250ms)コアレスで遅延反映されるが、
 * RPC(challenge.press / challenge.get)の返り値は setChallenge が即時反映する。
 * press はモニターの Space 押下と画面タップのたびに飛ぶので、**あとから来た delta を
 * 適用したあとに、それより古い press の返り値が着弾する**逆転が普通に起きる
 * (worker のイベントループ停止・ultra 動画再生中の rAF 飢餓で顕著)。
 * 逆転で recentEffects が古い配列に差し替わると、watermark 方式の演出再生が
 * 「新しい effect が来た」と誤認して直近5秒ぶんを丸ごと再生し直し、ルーレットも
 * ギフトカットインも**贈られた個数を超えて**回る/流れる。
 *
 * 対策はこの1点だけ: **effect ストリームは後退させない。** 値・boost.tapCount など
 * press の即時フィードバックに要るフィールドはそのまま通し、recentEffects と
 * fxQueue(どちらも演出の入力)だけを直前の新しい方で据え置く。
 */
let seenMaxEffectId = 0;
let seenEffects: ChallengeState['recentEffects'] | null = null;
let seenFxQueue: ChallengeState['fxQueue'];
/** 後退スナップショットの観測数(診断ログの間引き用)。 */
let staleSnapshots = 0;
let staleLoggedAtMs = 0;
/** 診断ログの間引き窓(ms)。押下ストームで診断リングを溢れさせない。 */
const STALE_LOG_EVERY_MS = 5000;

/**
 * worker 再起動で watermark を白紙へ戻す(attachLive の onWorkerState から)。
 * 履歴ログも含めて捨てる — 新しい worker の id 1 番から取り込み直す。
 */
function resetChallengeWatermarks(): void {
  logEntries = [];
  lastLoggedId = null;
  lastStartedMs = undefined;
  seenMaxEffectId = 0;
  seenEffects = null;
  seenFxQueue = undefined;
}

/**
 * ChallengeState を取り込み、履歴ログを更新して差分パッチを返す。
 * delta 経路と RPC 経路の両方がここを通る(同じ状態を二度受けても冪等)。
 */
function ingestChallenge(incoming: ChallengeState): Partial<LiveState> {
  // start / reset の検知。worker 側は recentEffects を空にするだけで「消せ」とは
  // 言ってこないので、startedMs の変化(start=新しい時刻 / reset=null)で判断する。
  // status 遷移だけを見ると stop→start の往復を取りこぼす。
  let cleared = false;
  if (lastStartedMs !== undefined && lastStartedMs !== incoming.startedMs) {
    logEntries = [];
    lastLoggedId = null;
    cleared = true;
    // ラン境界ではリングが空になるので世代印も戻す(後退判定の材料が無くなる)。
    seenMaxEffectId = 0;
    seenEffects = null;
    seenFxQueue = undefined;
  }
  lastStartedMs = incoming.startedMs;

  // 後退スナップショットは演出の入力だけ据え置く(上の seenMaxEffectId の解説)。
  let state = incoming;
  if (seenEffects !== null && isStaleChallengeSnapshot(seenMaxEffectId, incoming)) {
    staleSnapshots++;
    const now = Date.now();
    if (now - staleLoggedAtMs >= STALE_LOG_EVERY_MS) {
      staleLoggedAtMs = now;
      console.warn(
        '[fx-skip] 古いチャレンジ状態が後着 — 演出の入力(recentEffects)は据え置き',
        { seenMaxEffectId, incomingMaxEffectId: challengeSnapshotMaxEffectId(incoming), total: staleSnapshots }
      );
    }
    state = { ...incoming, recentEffects: seenEffects };
    if (seenFxQueue !== undefined) state.fxQueue = seenFxQueue;
    else delete state.fxQueue;
  } else {
    seenMaxEffectId = challengeSnapshotMaxEffectId(incoming);
    seenEffects = incoming.recentEffects;
    seenFxQueue = incoming.fxQueue;
  }

  const next = appendChallengeLog(logEntries, state, lastLoggedId);
  lastLoggedId = next.lastId;
  if (next.log === logEntries) {
    // ラン境界で空にしたときは、積む effect がゼロでもストアへ届ける必要がある。
    // appendChallengeLog は「新着なし」で入力の配列をそのまま返す規約なので、
    // ここで返さないと zustand 側は前のランのログを持ったままになる —
    // リセットの確認ダイアログが「ログがすべて消えて」と約束しているのに、
    // 次の演出が来るまで前ランの履歴が画面に残っていた。
    return cleared ? { challenge: state, challengeLog: logEntries } : { challenge: state };
  }
  logEntries = next.log;
  return { challenge: state, challengeLog: next.log };
}

/** RPC(challenge.*)の戻り値で即時反映する。delta からの上書きと冪等。 */
export function setChallenge(state: ChallengeState): void {
  useLive.setState(ingestChallenge(state));
}
