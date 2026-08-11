import type { EndReason, Ms, QuotaInfo, UserId } from './events';

// ── Store lifecycle ──────────────────────────────────────────────────────────

export interface OpenOptions {
  dbPath: string;
  /** Set once at first run; used to label 「計測開始日」 in the UI. */
  createIfMissing?: boolean;
}

export interface StoreCapabilities {
  dbPath: string;
  sqliteVersion: string;
  journalMode: string;
  fts5: boolean;
  /** WAL is impossible on network/OneDrive paths; we fall back and say so. */
  networkPathFallback: boolean;
  measuringSinceMs: Ms | null;
  orphanSessionsClosed: number;
  schemaVersion: number;
}

export interface BatchResult {
  applied: number;
  ignoredDuplicates: number;
  droppedBlocked: number;
  unhandled: string[];
}

export type ConnectLogKind =
  | 'connected'
  | 'websocketConnected'
  | 'disconnected'
  | 'error'
  | 'rateLimited'
  | 'streamEnd'
  | 'sessionOpened'
  | 'sessionResumed'
  | 'sessionClosed'
  | 'quotaGuard';

// ── Sessions ─────────────────────────────────────────────────────────────────

export interface OpenSessionInput {
  hostUserId: string | null;
  hostUniqueId: string;
  hostNickname?: string;
  roomId: string | null;
  startedMs: Ms;
}

export interface CloseSessionInput {
  endedMs: Ms;
  reason: EndReason;
}

export interface SessionTotals {
  sessionId: number;
  startedMs: Ms;
  endedMs: Ms | null;
  durationMs: number;
  viewerCount: number | null;
  peakViewers: number;
  totalViewers: number;
  avgViewers: number | null;
  roomTotalLikes: number;
  uniqueViewers: number;
  comments: number;
  gifts: number;
  diamonds: number;
  heartMe: number;
  newFollowers: number;
  shares: number;
  observedLikes: number;
  firstTimers: number;
}

export interface SessionListRow {
  sessionId: number;
  startedMs: Ms;
  endedMs: Ms | null;
  durationMs: number;
  endReason: string | null;
  peakViewers: number;
  avgViewers: number | null;
  totalViewers: number;
  uniqueViewers: number;
  comments: number;
  diamonds: number;
  heartMe: number;
  newFollowers: number;
  roomTotalLikes: number;
}

export interface TopRow {
  userId: UserId;
  nickname: string;
  displayId: string;
  /** The metric the list is ranked by — diamonds, comments or likes. */
  value: number;
  gifts: number;
}

export interface SessionDetail extends SessionListRow {
  hostUniqueId: string;
  roomId: string | null;
  /** viewer → commenter → liker → gifter, with conversion rates. */
  funnel: { viewers: number; commenters: number; likers: number; gifters: number };
  newVsReturning: { first: number; returning: number };
  topGifters: TopRow[];
  topCommenters: TopRow[];
  topLikers: TopRow[];
  prev: SessionListRow | null;
  sameWeekdayAvg: { peakViewers: number; diamonds: number; comments: number; newFollowers: number } | null;
}

export interface TimelinePoint {
  tsMs: Ms;
  viewers: number | null;
  roomTotalLikes: number | null;
  comments: number;
  diamonds: number;
  joins: number;
  follows: number;
}

// ── Viewers ──────────────────────────────────────────────────────────────────

export interface ViewerTableQuery {
  sort?: ViewerSortKey;
  desc?: boolean;
  /** Substring over nickname / @handle / よみがな. */
  search?: string;
  filter?: ViewerFilter;
  limit?: number;
  offset?: number;
}

export type ViewerSortKey =
  | 'lastSeen'
  | 'visits'
  | 'likesCurrent'
  | 'likesLifetime'
  | 'diamondsCurrent'
  | 'diamondsLifetime'
  | 'heartMeLifetime'
  | 'commentsCurrent'
  | 'score'
  | 'nickname';

export type ViewerFilter = 'all' | 'firstTime' | 'vip' | 'regular' | 'gifter' | 'commenter' | 'present';

export interface ViewerTableRow {
  userId: UserId;
  displayId: string;
  nickname: string;
  avatarUrl: string | null;
  readingKana: string | null;
  note: string | null;
  vipTier: number;
  vipSource: string;
  isModerator: boolean;
  isSubscriber: boolean;
  /** 来店回数（観測ベース）— distinct sessions attended. */
  visits: number;
  firstSeenMs: Ms;
  lastSeenMs: Ms;
  /** null when the viewer has never attended a session before this one. */
  prevVisitMs: Ms | null;
  isFirstEver: boolean;
  /** Present in the session being viewed. */
  presentNow: boolean;
  likesCurrent: number;
  likesPrev: number;
  likesLifetime: number;
  commentsCurrent: number;
  commentsLifetime: number;
  diamondsCurrent: number;
  diamondsPrev: number;
  diamondsLifetime: number;
  giftsLifetime: number;
  heartMeCurrent: number;
  heartMePrev: number;
  heartMeLifetime: number;
  score: number;
  consecutiveStreak: number;
  lastComment: string | null;
}

export interface RecallCard {
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
  likesLifetime: number;
  lastComments: string[];
  isFirstEver: boolean;
}

export interface ViewerDetail {
  row: ViewerTableRow;
  identityHistory: Array<{ displayId: string; nickname: string; observedMs: Ms }>;
  secUid: string | null;
  sessionsAttended: number;
  medianIntervalDays: number | null;
  giftTotals: Array<{ canonical: string | null; giftName: string; count: number; diamonds: number; iconUrl: string | null }>;
}

export interface ViewerMetaPatch {
  readingKana?: string | null;
  note?: string | null;
  vipTierManual?: number | null;
}

// ── Comments / gifts ─────────────────────────────────────────────────────────

export interface Paged {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface CommentSearchQuery extends Paged {
  userId?: UserId;
  sessionId?: number;
  text?: string;
  questionsOnly?: boolean;
}

export interface CommentHit {
  msgId: string;
  sessionId: number;
  userId: UserId;
  nickname: string;
  displayId: string;
  avatarUrl: string | null;
  tsMs: Ms;
  content: string;
  isQuestion: boolean;
}

export interface GiftRow {
  msgId: string;
  sessionId: number;
  tsMs: Ms;
  giftId: string;
  giftName: string | null;
  canonical: string | null;
  iconUrl: string | null;
  repeatCount: number;
  diamonds: number;
  isBoxGift: boolean;
}

export interface LikeSeriesPoint {
  sessionId: number;
  startedMs: Ms;
  likes: number;
  diamonds: number;
  comments: number;
}

// ── Analytics (P1) ───────────────────────────────────────────────────────────

export interface ScoringConfig {
  weights: {
    visit: number;
    diamond: number;
    comment: number;
    like: number;
    share: number;
    follow: number;
    subscribe: number;
    heartMe: number;
  };
  caps: { comment: number; like: number; share: number };
  halfLifeDays: number;
  tiers: { regular: number; vip: number; topVip: number };
  tierDiamonds: { vip: number; topVip: number };
  minVisitsForRegular: number;
  /** Demotion needs score < threshold * this AND >= 14 days since promotion. */
  demotionFactor: number;
}

export interface RecomputeOpts {
  full: boolean;
  sessionId?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface LeaderboardQuery extends Paged {
  scope: 'lifetime' | 'month' | 'week';
  metric: 'score' | 'diamonds' | 'visits' | 'comments' | 'likes' | 'heartMe';
}

export interface LeaderboardRow {
  rank: number;
  userId: UserId;
  nickname: string;
  displayId: string;
  avatarUrl: string | null;
  vipTier: number;
  value: number;
  visits: number;
  lastSeenMs: Ms;
}

export interface ChurnQuery {
  kind: 'churn' | 'dormant';
  minVisits?: number;
  overdueFactor?: number;
  dormantMinDiamonds?: number;
  dormantSilentDays?: number;
  limit?: number;
}

export interface ChurnRow {
  userId: UserId;
  nickname: string;
  displayId: string;
  avatarUrl: string | null;
  vipTier: number;
  visits: number;
  lastSeenMs: Ms;
  daysSince: number;
  expectedIntervalDays: number | null;
  overdueRatio: number | null;
  diamondsLifetime: number;
  note: string | null;
}

export type MatrixMetric =
  | 'avgViewers'
  | 'peakViewers'
  | 'newFollowers'
  | 'diamonds'
  | 'uniqueViewers'
  | 'sessions'
  | 'durationMin';

export interface MatrixQuery {
  metric: MatrixMetric;
  sinceMs?: Ms;
}

export interface MatrixCell {
  weekday: number;
  hour: number;
  value: number;
  sessions: number;
}

// ── Missions ─────────────────────────────────────────────────────────────────

export type MissionScope = 'session' | 'day' | 'week';
export type MissionMetric =
  | 'durationMin'
  | 'newFollowers'
  | 'validStreamDays'
  | 'activeFans'
  | 'diamonds'
  | 'uniqueViewers'
  | 'comments';

export interface MissionDef {
  id: string;
  labelJa: string;
  scope: MissionScope;
  metric: MissionMetric;
  target: number;
  pacer?: boolean;
  validDay?: { minDurationMin: number };
  activeFan?: { windowDays: number; minComments: number };
}

export interface MissionConfig {
  schemaVersion: number;
  sourceNote?: string;
  timezone?: string;
  dayResetHour?: number;
  weekStartsOn?: 'monday' | 'sunday';
  missions: MissionDef[];
}

export interface MissionInputs {
  nowMs: Ms;
  session: { durationMin: number; newFollowers: number; diamonds: number; uniqueViewers: number; comments: number } | null;
  day: { diamonds: number; durationMin: number; newFollowers: number };
  week: { validStreamDays: number; activeFans: number; diamonds: number; durationMin: number; newFollowers: number };
}

export interface MissionProgress {
  id: string;
  labelJa: string;
  scope: MissionScope;
  current: number;
  target: number;
  done: boolean;
  /** For pacer missions: projected end-of-window value at the current rate. */
  projected?: number;
  /** Fraction of the window elapsed, for the pace indicator. */
  windowElapsed?: number;
}

// ── カウントダウンチャレンジ ─────────────────────────────────────────────────

/**
 * ギフト1件をカウント増減へ写像する規則。上から順に評価し、最初に一致した
 * 1件だけを適用する。canonical / giftId があればその一致で判定し、どちらも
 * 無い規則は minDiamonds の閾値で判定する。
 */
export interface ChallengeGiftRule {
  id: string;
  /** normalize 済みの canonical('rose' 等、gift-aliases 由来)と一致で適用。 */
  canonical?: string;
  giftId?: string;
  /** canonical/giftId 無指定時: diamonds がこの値以上なら適用。 */
  minDiamonds?: number;
  /** 'fixed': amount をそのまま加算。'perDiamond': diamonds × amount を加算(四捨五入)。 */
  mode: 'fixed' | 'perDiamond';
  /** 正=カウントを増やす(妨害)、負=減らす(応援)。 */
  amount: number;
  /** true ならモニターに照明フラッシュ演出。 */
  flash?: boolean;
}

export interface ChallengeConfig {
  enabled: boolean;
  /** モニターの見出し。例「0まで寝ない」。 */
  title: string;
  /** カウント初期値。例 6218。 */
  initialValue: number;
  /** ボタン1回で減る量(正の数で保持し、適用時に減算する)。 */
  pressStep: number;
  /** フォロー1件で増える量(妨害)。 */
  followStep: number;
  giftRules: ChallengeGiftRule[];
  /** どの規則にも一致しないギフトの既定動作。null なら無視。 */
  giftDefault: { mode: 'fixed' | 'perDiamond'; amount: number } | null;
  /** diamonds がこの値以上のギフトは規則に関係なく照明フラッシュ。null で無効。 */
  flashMinDiamonds: number | null;
  /** グローバルホットキー(Electron accelerator)。'' で無効。 */
  hotkey: string;
  /** モニターを出すディスプレイ。null = 自動(最後の非プライマリ)。 */
  monitorDisplayId: number | null;
  /** 残数がこの値以下になるとモニターの数字が点滅する。 */
  lowThreshold: number;
}

export type ChallengeStatus = 'idle' | 'running' | 'achieved';

/**
 * モニターが再生する演出1件。id はエンジン生存期間を通して単調増加 —
 * 受信側は「最後に再生した id」だけ覚え、それより新しい項目を再生すれば
 * 冪等になる。reset で配列は消えるが id カウンタは巻き戻さない。
 */
export interface ChallengeEffect {
  id: number;
  kind: 'press' | 'follow' | 'gift' | 'achieved';
  /** カウント変化量(負=減、正=増)。achieved は 0。 */
  amount: number;
  /** kind='gift' で照明フラッシュ演出を伴うとき true。 */
  flash?: boolean;
  nickname?: string;
  giftName?: string;
  giftIconUrl?: string;
  diamonds?: number;
  atMs: Ms;
}

export interface ChallengeStats {
  presses: number;
  /** フォロー妨害の回数(同一ユーザーはチャレンジ1回につき1度だけ数える)。 */
  follows: number;
  /** ギフトによる減算量の合計(正の数で保持)。 */
  giftDown: number;
  /** ギフトによる加算量の合計。 */
  giftUp: number;
}

export interface ChallengeState {
  status: ChallengeStatus;
  /** 現在値。0 未満にはならない(クランプ)。上方向は無制限。 */
  value: number;
  /** 開始時点の初期値。プログレスバーの分母。 */
  initialValue: number;
  title: string;
  startedMs: Ms | null;
  achievedMs: Ms | null;
  stats: ChallengeStats;
  /** 新しい順・最大 CHALLENGE_EFFECTS_MAX 件のリングバッファ。 */
  recentEffects: ChallengeEffect[];
}

// ── Settings / export ────────────────────────────────────────────────────────

export interface AppSettings {
  eulerApiKey: string;
  hostUniqueId: string;
  waitUntilLive: boolean;
  diamondToJpy: number;
  loadAvatars: boolean;
  captureDebug: boolean;
  retentionDays: number | null;
  scoring: ScoringConfig;
  dbPath: string;
  minimizeToTray: boolean;
  alertMinTier: number;
  /** Diamonds at or above which a gift gets its own alert card. */
  giftAlertDiamonds: number;
  /** Display scale, 0.6–2.5. Persisted so it survives restarts. */
  zoomFactor: number;
  /** カウントダウンチャレンジ設定。ワーカー再起動不要 — settings メッセージで即時反映。 */
  challenge: ChallengeConfig;
}

export type CsvExportKind = 'viewers' | 'comments' | 'gifts' | 'sessions' | 'agencyMonthly';

export interface CsvExportSpec {
  kind: CsvExportKind;
  sessionId?: number;
  userId?: UserId;
  fromMs?: Ms;
  toMs?: Ms;
}

export interface BackupProgress {
  totalPages: number;
  remainingPages: number;
}

export type PurgeSpec =
  | { scope: 'all' }
  | { scope: 'session'; sessionId: number }
  | { scope: 'viewer'; userId: UserId }
  | { scope: 'olderThan'; days: number };

export interface PurgeResult {
  sessionsDeleted: number;
  viewersDeleted: number;
  rowsDeleted: number;
}

export interface DiagnosticsInfo {
  capabilities: StoreCapabilities;
  unknownEventCounts: Array<{ libType: string; count: number }>;
  dbSizeBytes: number;
  rowCounts: Record<string, number>;
  quota: QuotaInfo | null;
  gitSha: string;
  buildTime: string;
  appVersion: string;
}
