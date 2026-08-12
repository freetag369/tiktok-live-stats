import type { AdapterStatus, Ms, QuotaInfo, UserId } from './events';
import type * as D from './dto';

// Channel names live in constants.ts but every consumer imports them from here,
// alongside the payload types they carry.
export { CH_FEED_PORT, CH_MONITOR_STATE, CH_RPC, CH_SETTINGS_PUSH, CH_TOAST, CH_VISIBILITY, CH_WORKER_STATE } from './constants';

/**
 * One RPC channel, one discriminated union. Keeps preload to ~60 lines and puts
 * the whole contract in a single file all three processes import.
 */
export type RpcMap = {
  // connection
  'conn.start': { p: { uniqueId: string; waitUntilLive: boolean }; r: { sessionId: number | null } };
  'conn.stop': { p: void; r: void };
  'conn.status': {
    p: void;
    r: { status: AdapterStatus; sessionId: number | null; quota: QuotaInfo | null };
  };
  'conn.refreshQuota': { p: void; r: QuotaInfo | null };
  /** NDJSON キャプチャを本物の接続として再生する(配信なしの動作確認用)。 */
  'conn.startReplay': { p: { file: string; speed: number }; r: { sessionId: number | null } };

  // countdown challenge — worker が処理
  'challenge.get': { p: void; r: D.ChallengeState };
  'challenge.start': { p: void; r: D.ChallengeState };
  'challenge.stop': { p: void; r: D.ChallengeState };
  'challenge.reset': { p: void; r: D.ChallengeState };
  'challenge.press': { p: void; r: D.ChallengeState };
  /** モニター演出のテスト再生(値・統計は変えない)。設定画面の「▶ モニター」用。 */
  'challenge.testEffect': { p: D.ChallengeTestEffectSpec; r: void };

  // queries
  'q.viewerTable': { p: { sessionId: number | null } & D.ViewerTableQuery; r: D.Page<D.ViewerTableRow> };
  'q.viewer': { p: { userId: UserId; sessionId: number | null }; r: D.ViewerDetail | null };
  'q.recallCard': { p: { userId: UserId; sessionId: number | null }; r: D.RecallCard | null };
  'q.comments': { p: D.CommentSearchQuery; r: D.Page<D.CommentHit> };
  'q.gifts': { p: { userId: UserId } & D.Paged; r: D.Page<D.GiftRow> };
  'q.likeSeries': { p: { userId: UserId; limitSessions: number }; r: D.LikeSeriesPoint[] };
  'q.sessions': { p: D.Paged; r: D.Page<D.SessionListRow> };
  'q.sessionDetail': { p: { sessionId: number }; r: D.SessionDetail | null };
  'q.sessionTotals': { p: { sessionId: number }; r: D.SessionTotals | null };
  'q.timeline': { p: { sessionId: number; bucketMs: number }; r: D.TimelinePoint[] };
  'q.leaderboard': { p: D.LeaderboardQuery; r: D.Page<D.LeaderboardRow> };
  'q.churn': { p: D.ChurnQuery; r: D.ChurnRow[] };
  'q.matrix': { p: D.MatrixQuery; r: D.MatrixCell[] };
  'q.missions': { p: { sessionId: number | null }; r: D.MissionProgress[] };
  'q.diagnostics': { p: void; r: D.DiagnosticsInfo };

  // mutations
  'm.viewerMeta': { p: { userId: UserId; patch: D.ViewerMetaPatch }; r: void };
  'm.forgetViewer': { p: { userId: UserId; mode: 'block' | 'purge' }; r: void };
  'm.unblockViewer': { p: { userId: UserId }; r: void };
  'm.recomputeScores': { p: { full: boolean }; r: { updated: number } };
  'm.purge': { p: D.PurgeSpec; r: D.PurgeResult };
  'm.reloadMissions': { p: void; r: { ok: boolean; error?: string } };

  // Worker-internal: main owns the save dialog, the worker owns the database.
  'w.exportCsv': { p: { spec: D.CsvExportSpec; path: string }; r: { rows: number } };
  'w.backup': { p: { path: string }; r: void };

  // settings & files — handled in MAIN, not forwarded to the worker
  'cfg.get': { p: void; r: D.AppSettings };
  'cfg.set': { p: Partial<D.AppSettings>; r: { workerRestarted: boolean } };
  'file.exportCsv': { p: D.CsvExportSpec; r: { path: string; rows: number } | null };
  'file.backup': { p: void; r: { path: string } | null };
  'file.openDataDir': { p: void; r: void };
  'file.pickDataDir': { p: void; r: { dbPath: string; viewers: number } | null };
  'file.openMissions': { p: void; r: void };
  'file.saveSource': { p: void; r: { path: string } | null };
  'app.licenses': { p: void; r: { license: string; sourceOffer: string; thirdParty: string } };

  // monitor window — handled in MAIN(第2ウィンドウの開閉)
  'monitor.open': { p: void; r: { open: boolean } };
  'monitor.close': { p: void; r: { open: boolean } };
  'monitor.status': { p: void; r: { open: boolean } };
  'monitor.displays': {
    p: void;
    r: Array<{ id: number; label: string; primary: boolean; width: number; height: number }>;
  };
};

export type RpcMethod = keyof RpcMap;
export type RpcParams<K extends RpcMethod> = RpcMap[K]['p'];
export type RpcResult<K extends RpcMethod> = RpcMap[K]['r'];

export interface RpcRequest<K extends RpcMethod = RpcMethod> {
  id: string;
  method: K;
  params: RpcParams<K>;
}

export type RpcErrorCode = 'DB' | 'ADAPTER' | 'VALIDATION' | 'TIMEOUT' | 'WORKER_DOWN' | 'INTERNAL';

export type RpcResponse<K extends RpcMethod = RpcMethod> =
  | { id: string; ok: true; result: RpcResult<K> }
  | { id: string; ok: false; error: { code: RpcErrorCode; message: string } };

/** Methods main answers itself instead of forwarding. */
export const MAIN_HANDLED: ReadonlySet<string> = new Set([
  'cfg.get',
  'cfg.set',
  'file.exportCsv',
  'file.backup',
  'file.openDataDir',
  'file.pickDataDir',
  'file.openMissions',
  'file.saveSource',
  'app.licenses',
  'monitor.open',
  'monitor.close',
  'monitor.status',
  'monitor.displays',
]);

// ── Firehose (direct worker → renderer MessagePort) ──────────────────────────

/** Bit flags on a delta viewer entry. */
export const VF_FIRST = 1;
export const VF_VIP = 2;
export const VF_REGULAR = 4;
export const VF_MOD = 8;
export const VF_SUB = 16;
export const VF_PRESENT = 32;

export interface LiveTotals {
  /** 同接 — concurrent right now. */
  viewers: number | null;
  peakViewers: number;
  /** 累計視聴者 — cumulative entries since the stream started. */
  totalViewers: number;
  roomTotalLikes: number;
  observedLikes: number;
  diamonds: number;
  heartMe: number;
  comments: number;
  newFollowers: number;
  shares: number;
  uniqueViewers: number;
  firstTimers: number;
  elapsedMs: number;
}

/** Short keys: this message is sent 2×/sec with up to 800 entries. */
export interface DeltaViewer {
  u: UserId;
  /** diamonds / comments / likes / gifts / heartMe deltas since the last tick */
  d?: number;
  c?: number;
  l?: number;
  g?: number;
  h?: number;
  n?: string;
  a?: string;
  di?: string;
  ls?: Ms;
  v?: number;
  flags?: number;
}

export interface JoinAlertCard {
  /** 'join' — someone worth greeting arrived. 'gift' — someone worth thanking gave. */
  kind: 'join' | 'gift';
  userId: UserId;
  nickname: string;
  displayId: string;
  avatarUrl: string | null;
  readingKana: string | null;
  note: string | null;
  vipTier: number;
  visits: number;
  prevVisitMs: Ms | null;
  diamondsLifetime: number;
  heartMeLifetime: number;
  lastComments: string[];
  isFirstEver: boolean;
  atMs: Ms;
  /** Present when kind === 'gift'. */
  gift?: { name: string; iconUrl?: string; count: number; diamonds: number; canonical?: string };
}

export interface LiveDelta {
  t: 'delta';
  tick: number;
  atMs: Ms;
  sessionId: number | null;
  totals: LiveTotals;
  viewers: DeltaViewer[];
  alerts: JoinAlertCard[];
  missions?: D.MissionProgress[];
  /** カウントダウンチャレンジ — 変化したtickだけ載る(missions と同じ相乗り方式)。 */
  challenge?: D.ChallengeState;
  /** Viewer entries deferred to the next tick because the cap was hit. */
  deferred: number;
}

/**
 * The viewer's record, carried on every feed row.
 *
 * Reading a comment without knowing whether it is someone's first visit or their
 * fortieth is the difference between a generic reply and calling them by name.
 * Lifetime figures only — the current stream's numbers are merged in by the
 * renderer from live deltas so they never go stale.
 */
export interface FeedViewerRecord {
  /** 来店回数 (observed). */
  vis: number;
  /** Previous visit, epoch ms. */
  pv?: Ms;
  /** Lifetime diamonds. */
  dl?: number;
  /** Lifetime likes (observed). */
  ll?: number;
  /** Lifetime Heart Me. */
  hl?: number;
  /** よみがな. */
  kana?: string;
  /** CRM memo. */
  note?: string;
}

export type FeedItem =
  | ({
      k: 'c';
      id: string;
      u: UserId;
      n: string;
      a?: string;
      txt: string;
      ts: Ms;
      tri?: 'first' | 'vip' | 'question';
      vt: number;
    } & FeedViewerRecord)
  | ({
      k: 'g';
      id: string;
      u: UserId;
      n: string;
      a?: string;
      gift: string;
      icon?: string;
      cnt: number;
      dia: number;
      ts: Ms;
      canon?: string;
      vt: number;
    } & FeedViewerRecord)
  | ({ k: 'j'; id: string; u: UserId; n: string; a?: string; ts: Ms; first: boolean; vt: number } & FeedViewerRecord)
  | ({ k: 'f'; id: string; u: UserId; n: string; a?: string; ts: Ms; sub: 'follow' | 'share' | 'sub'; vt: number } &
      FeedViewerRecord);

export interface LiveFeed {
  t: 'feed';
  tick: number;
  items: FeedItem[];
  /** Never silently lose the count — the UI shows 「表示省略 N件」. */
  dropped: number;
}

export interface LiveStatusMsg {
  t: 'status';
  status: AdapterStatus;
  sessionId: number | null;
  quota?: QuotaInfo | null;
}

export interface LiveJobMsg {
  t: 'job';
  jobId: string;
  phase: 'run' | 'done' | 'error';
  done: number;
  total: number;
  msg?: string;
}

export type LiveMessage = LiveDelta | LiveFeed | LiveStatusMsg | LiveJobMsg;

export type WorkerState = 'starting' | 'ready' | 'restarting' | 'dead';

export interface ToastMsg {
  level: 'info' | 'warn' | 'error';
  msgJa: string;
}
