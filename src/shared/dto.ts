import type { EndReason, Ms, QuotaInfo, UserId } from './events';
import type { DashPaneKey } from './dash-layout';

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

/**
 * ギフトリスト(カウントダウンチャレンジ設定の「ギフトリスト」タブ)の1行。
 *
 * 出所は **gift_catalog(受信のたびに自動で育つ実測テーブル)** で、創作値は無い。
 * チャレンジの各機能(giftFullCut / roulettes / tapBoost / tapLock / fanStamp /
 * stampTriggers / revolution / giftRules)は giftId 完全一致が本線なので、
 * 「この配信に実際に届いた giftId はどれか」を一覧で引けることが設定作業の前提になる。
 * ギフト名は同名別ID・前後スペース・綴り揺れがあり、名前では特定できない。
 */
export interface GiftCatalogRow {
  giftId: string;
  /** 受信原文ママ(前後スペースを含むことがある — trim しないこと)。 */
  name: string;
  /** 単価💎(= diamond_count = イベントの diamondEach)。総額ではない。 */
  diamonds: number;
  /** 1 == 連打(コンボ)あり。2・4 は単発系。未受信で不明なら null。 */
  giftType: number | null;
  iconUrl: string | null;
  /** gift_alias の canonical('heart' など粒度が粗い。個別指定には使わない)。 */
  canonical: string | null;
  /** gift_event の行数(= 受信回数。連打は1行にまとまる)。 */
  count: number;
  /** 実測の最大連打(MAX(repeat_count))。type だけでは分からない実際の上限。 */
  maxRepeat: number;
  /** 累計💎(SUM(diamonds) = 単価×連打の総和)。 */
  totalDiamonds: number;
  firstSeenMs: Ms | null;
  lastSeenMs: Ms | null;
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

/**
 * ルーレット終盤の演出パターンの全種。抽選は**出目の珍しさで条件付ける**(パチンコの
 * 信頼度方式)— レアな出目ほど激アツ(heavy)パターンが出やすいが、どのパターンも
 * 全レア度帯で正の重みを持つ(ガセあり)。演出は「期待感」であって結果の確定予告には
 * ならない。条件付けの実体は roulette-fx.ts の drawRoulettePattern / ROULETTE_TIER_WEIGHTS。
 * 値は CSS のクラス名(rl-p-*)とキーフレーム名(rl-run-*)の接尾辞になる。
 * 各パターンの見せ方の設計は monitor.css のルーレット節の冒頭コメントに、
 * SE のタイミングは roulette-fx.ts の ROULETTE_PATTERN_TIMING にある。
 *
 * ここ(dto)に置く理由: challenge.ts(既定値・検証)と roulette-fx.ts(演出幾何)の
 * 両方が一覧を必要とするが、roulette-fx.ts は challenge.ts から import しているので
 * challenge.ts → roulette-fx.ts の import は循環になる。dto は依存の根なので安全。
 */
export const ROULETTE_PATTERNS = [
  'slow', //       じわじわ減速
  'pop', //        ポンポン飛び移り
  'kick', //       フェイク停止 → キックで1個ずれる
  'overrun', //    当選を通り過ぎて隣に着地 → 巻き戻し
  'crawl', //      超低速で這う(微停止つき)
  'doublefake', // フェイク停止2回 → キック2発
  'restart', //    途中失速 → 再加速
  'teeter', //     当選との境界でシーソー
  'stairs', //     5段の階段(保持が段々伸びる)
  'blackout', //   終盤に暗転 → 明けたら止まっている
  'jackstop', //   一番下の出目が完全に入って止まる → 蹴り出される
  'jackslip', //   一番下の出目が寸前で震えて中央をすり抜ける
  'jackback', //   一番下の出目が届かず後ろへ転がり戻る
  // ── 超激アツ(ultra)— 全画面動画とマス移動が交互に進む。動画の終端の一撃が
  //    リールを1マス押す(振り付けの規約は roulette-fx.ts の clips コメント)。
  'dragon', //     黄金龍 — 尾撃ち・火炎でマスを押す。二段キック終い
  'unicorn', //    ユニコーン — 角の一撃で2マス押し。シーソー終い
  'whale', //      クジラ — 尾撃ち×3 → ブリーチ(飛沫スラム)終い
  'phoenix', //    フェニックス — 羽ばたきの衝撃波×3 → 再生の爆発終い
  'lion', //       ライオン — 全ステップが飛び掛かり(キック)。最後の1つ前で止まらない
  'heartme', //     ハートミー — ハート型ロケットが開いて撃ち出す。振り付けは phoenix と同一値の流用
  'hearttouch', //  ハートタッチ — 2つのハートが触れ合って融合する。振り付けは unicorn と同一値の流用
  'heartbday', //   ハートの誕生日 — ハート型ケーキのロウソクが爆ぜる。振り付けは dragon と同一値の流用
  'heartbloom', //  花咲ハート — ハート型の花が満開に開く。振り付けは lion と同一値の流用
  // ── 激熱確定専用(ギフト連動)。設定画面のチェック一覧には出さず、通常の抽選にも乗らない。
  //    ROULETTE_HOT_ONLY_PATTERNS / ROULETTE_SELECTABLE_PATTERNS を参照。
  'djglasses', //   DJメガネ — ターンテーブル・ミラーボール・スピーカーの一撃。振り付けは ultra 共通
  // 'unicorn' は既に一角獣の通常パターンとして埋まっているので、ギフト連動側は別スラッグ。
  'unicorngift', // ユニコーン — 虹の角のチャージとプリズムの一撃。振り付けは ultra 共通
  'bunnydj', //     バニーDJ — ターンテーブル・ミラーボール・スピーカーの一撃。振り付けは ultra 共通
] as const;
export type RoulettePattern = (typeof ROULETTE_PATTERNS)[number];

/**
 * 激熱確定(hot)でだけ出る絵柄。**通常のルーレットでは絶対に出さない。**
 *
 * オプトイン(ROULETTE_OPT_IN_PATTERNS)とは別概念 — あちらは「ユーザーがチェックすれば
 * 出る」、こちらは「チェック自体を見せない」。ギフト連動で 100% その絵柄になるので、
 * 通常スピンに混ざると 43 秒級の演出が意図せず出てしまう。
 *
 * 締め出しは3点セット: ①この配列から ROULETTE_SELECTABLE_PATTERNS を作る
 * ②sanitizeRoulettePatterns が保存時に除去 ③設定画面の一覧が SELECTABLE を回す。
 */
export const ROULETTE_HOT_ONLY_PATTERNS: readonly RoulettePattern[] = [
  'djglasses',
  'unicorngift',
  'bunnydj',
];

/**
 * 設定画面で選べる = 通常抽選に乗りうるパターン。ROULETTE_PATTERNS から激熱専用を抜いたもの。
 * **並び順は ROULETTE_PATTERNS のまま**(正順への正規化がこの順に依存している)。
 */
export const ROULETTE_SELECTABLE_PATTERNS: readonly RoulettePattern[] = ROULETTE_PATTERNS.filter(
  (p) => !ROULETTE_HOT_ONLY_PATTERNS.includes(p)
);

/**
 * パターンの段位。スピン尺と走行距離は**段位のみの関数**(rouletteSpinMs /
 * roulette-fx.ts の RUN_BASE)— レア度から尺を直接決めると「長いのに軽い演出」が
 * 別のバレ経路になるため、レア度は抽選の重み付けにだけ効かせる。
 */
export type RouletteTier = 'light' | 'mid' | 'heavy' | 'ultra';
/**
 * パターン → 段位。light = 段・微停止だけの通常変動、mid = 強いフェイク/衝撃が
 * 1発の中リーチ、heavy = ダブルフェイクと大当たり寸止め系(設定UIで「大当たり〜」
 * と名の付く3種 + doublefake)の激アツ、ultra = 全画面動画×マス移動の超激アツ
 * (約24秒・ROULETTE_PATTERN_TIMING.clips が動画ウィンドウの権威)。
 */
export const ROULETTE_PATTERN_TIER: Record<RoulettePattern, RouletteTier> = {
  slow: 'light',
  pop: 'light',
  crawl: 'light',
  stairs: 'light',
  kick: 'mid',
  overrun: 'mid',
  restart: 'mid',
  teeter: 'mid',
  blackout: 'mid',
  doublefake: 'heavy',
  jackstop: 'heavy',
  jackslip: 'heavy',
  jackback: 'heavy',
  dragon: 'ultra',
  unicorn: 'ultra',
  whale: 'ultra',
  phoenix: 'ultra',
  lion: 'ultra',
  heartme: 'ultra',
  hearttouch: 'ultra',
  heartbday: 'ultra',
  heartbloom: 'ultra',
  djglasses: 'ultra',
  unicorngift: 'ultra',
  bunnydj: 'ultra',
};
/** スピン尺・走行距離の引数キー。'fast' は 16 本目以降(と合算 effect)の短縮スピン。 */
export type RouletteSpinKey = RoulettePattern | 'fast';

/** ルーレットの出目1件。amount は表示値(絶対値)、適用方向は direction が決める。 */
export interface ChallengeRouletteSegment {
  amount: number;
  /** 抽選の重み(相対値)。0 でこの出目は出ない。確率 = weight / Σweight。 */
  weight: number;
}

/**
 * ギフトルーレット。トリガーギフトを受けると重み付き抽選で出目を決め、
 * カウントへ即時適用する(モニターの回転演出は確定済みの出目の遅延再生)。
 * トリガーに一致したギフトは giftRules/giftDefault を評価しない — ルーレットが
 * 増減の写像を置き換える(二重適用防止)。
 */
export interface ChallengeRouletteConfig {
  /**
   * 行の識別子。設定UIの key と、行ごとのテスト再生(ChallengeTestEffectSpec の
   * rouletteId)の対象指定に使う — giftRules と同じ流儀。
   */
  id: string;
  /**
   * モニター表示名。「{label} ○○がルーレット」の {label}。'' なら effect.giftName
   * (TikTok から届く実名)へフォールバックする。実名は英語 'Heart Me' で届くことが
   * あるので、日本語表記(ハートミー)を出すにはここに持たせる必要がある。
   */
  label: string;
  enabled: boolean;
  /**
   * トリガーギフトの giftId 直接一致。ライブ経路では NormalizedEvent.canonical が
   * 未代入(normalize.ts は名寄せ結果をイベントに載せない)なので、これが本線。
   */
  giftId: string;
  /** 補助マッチ: giftName の小文字部分一致。'' で無効(ID 変更時の保険)。 */
  giftName: string;
  /** 補助マッチ: canonical 一致。リプレイ/テスト経路でだけ乗る。'' で無効。 */
  canonical: string;
  segments: ChallengeRouletteSegment[];
  /** 'add' = カウント増(妨害・既定) / 'sub' = カウント減(応援)。 */
  direction: 'add' | 'sub';
  /**
   * このルーレットで使う終盤の演出パターン(チェック済みの中から、出目の珍しさで
   * 段位を重み付けして抽選 — 信頼度方式)。検証(validateRoulette)が空を許さないので
   * 最低1件。許可リストは設定でしかなく、チェックの組合せがどうであれ全パターンが
   * 全レア度帯で正の重みを持つ(演出が結果を確定も除外もしない)。
   */
  patterns: RoulettePattern[];
  /**
   * この行だけの回転サウンド。**キー欠損 = 方向に対応する共通に従う**(既定) —
   * direction が 'add' なら cfg.rouletteSound、'sub' なら cfg.rouletteSoundSub。
   * 上書きするときだけ4項目まとめて1組で持つ(部分継承はしない)。旧 settings.json は
   * 全行がこのキーを持たないので、**欠損が共通へ倒れること自体が移行の代わり**になる
   * (SETTINGS_VERSION は上げない)。検証は validateRoulette、実効値の解決は
   * resolveRouletteSound が唯一の実装。
   */
  sound?: RouletteSoundConfig;
  /**
   * 激熱確定。**キー欠損 = 無効**(保存済み settings.json の全行がここへ倒れるので、
   * 欠損が移行の代わりになる — sound / rouletteTease と同じ手口で SETTINGS_VERSION は
   * 上げない)。有効な行は**100%** 激熱確定になり、出目に multiplier を掛けた値が
   * そのままカウントへ適用される(演出だけの見せかけ倍率とは別物 — RouletteFx.tsx の
   * mult の解説を参照)。multiplier は ROULETTE_HOT_MULT_MIN..MAX。
   * **direction:'sub' の行では検証(validateRoulette)がキーごと落とす** — 応援側で
   * 一気に 50 倍減らすのは別の企画なので、死んだ設定を構造的に作らない。
   */
  hot?: RouletteHotConfig;
}

/**
 * 激熱倍率の候補1件。盤面(ChallengeRouletteSegment)と同じ「候補+重み」形式 —
 * weight は相対値で、0 の候補は出ない(sanitizeRouletteSegments と同じ規約)。
 */
export interface RouletteHotMultCandidate {
  /** 出目に掛ける倍率の候補。ROULETTE_HOT_MULT_MIN..MAX へ clamp される。 */
  multiplier: number;
  /** 抽選の重み(相対値)。 */
  weight: number;
}

/**
 * 激熱確定の設定。ギフトルーレット行(ChallengeRouletteConfig.hot)専用で、入室
 * ルーレットには持たせない — 入室は単一設定・盤面も1つなので、100% 発動の 50 倍が
 * 入室のたびに走ると 43 秒の演出でモニターが埋まる。
 */
export interface RouletteHotConfig {
  enabled: boolean;
  /**
   * 出目に掛ける実倍率(従来形)。ROULETTE_HOT_MULT_MIN..MAX へ clamp される。
   * multipliers があるときは代表値(最大 weight・同率先勝ち)を validate が焼き直す —
   * 旧バージョンで読んだときの縮退先。
   */
  multiplier: number;
  /**
   * 候補倍率の分布(確率抽選)。**キー欠損 = 単一 multiplier 動作**(保存済み
   * settings.json の移行代わり — hot 自身・sound と同じ手口で SETTINGS_VERSION は
   * 上げない)。**正規形はキー存在 ⇔ 候補2件以上**: validateRouletteHot が候補1件を
   * 従来形へ畳むので、出荷既定(DJメガネ ×10)の形は変わらない。存在するときだけ
   * worker が出目側の rand をちょうど1回消費して重み抽選する(drawRouletteHotMult)。
   */
  multipliers?: RouletteHotMultCandidate[];
}

/**
 * 入室ルーレット。視聴者の入室(join, action=1)で自動的に1スピン回り、
 * 出目をカウントへ即時適用する(ギフトルーレット同様、モニターの回転演出は
 * 確定済みの出目の遅延再生)。トリガーギフトを持たない単一設定なので
 * ChallengeRouletteConfig とは別型 — giftId/giftName/canonical をダミーで
 * 持たせると matchRoulette の先勝ち評価や id 振り直しと混線する。
 * 盤面・方向・焦らしパターンの部品型はギフトルーレットと共有する。
 */
export interface JoinRouletteConfig {
  enabled: boolean;
  /** 発火対象。'first' = 初見さんのみ(viewer_lifetime 初記録)、'all' = すべての入室。 */
  target: 'first' | 'all';
  /**
   * モニター表示名。「{label} ○○がルーレット」の {label}。空にすると
   * rouletteBoardKey が同一盤面のギフトルーレットと衝突して畳み込まれうるため、
   * 検証(validateJoinRoulette)は空を既定 '初見さん' へ倒す。
   */
  label: string;
  segments: ChallengeRouletteSegment[];
  /** 'add' = カウント増(妨害・既定) / 'sub' = カウント減(応援)。 */
  direction: 'add' | 'sub';
  /** 終盤の演出パターン許可リスト。ChallengeRouletteConfig.patterns と同じ規約。 */
  patterns: RoulettePattern[];
  /**
   * この入室ルーレットだけの回転サウンド。ChallengeRouletteConfig.sound と同じ規約
   * (キー欠損は direction に対応する共通へ倒れる)。
   */
  sound?: RouletteSoundConfig;
}

/**
 * 超焦らし(大当たり寸止め系 jack 3種)のカウント方式。毎回の抽選任せにせず、
 * 「並びの最後のフル尺スピン」を数えて 5回 or 7回(ROULETTE_TEASE_COUNTS から
 * ランダム)に1回だけ必ず発動する。発動回以外で worker 抽選が jack を引いたら
 * doublefake(同じ heavy 段位)へ降格 — 超焦らしの出現をこのカウントに一本化する。
 * 判定はモニター側(キューの残りを知る唯一の層)、実装は shared/roulette-tease.ts。
 * 入室ルーレット(rouletteJoin)と試写(test)は対象外で素通し。
 */
export interface RouletteTeaseConfig {
  /** カウント方式の有効/無効。false で従来どおり抽選のまま(降格もしない)。 */
  enabled: boolean;
  /**
   * 発動時に使う jack 系パターン(等重み抽選)。jack 3種のサブセットで最低1件
   * (検証 validateRouletteTease が空を既定 = 3種全部へ倒す)。行ごとの patterns は
   * effect に載らずモニターから参照できないため、こちらが発動時の権威。
   */
  patterns: RoulettePattern[];
}

/**
 * ルーレット回転中のサウンド。**方向ごとの共通2組 + 行ごとの任意上書き**。
 * cfg.rouletteSound(増やす/妨害)と cfg.rouletteSoundSub(減らす/応援)が
 * それぞれの向きのルーレットの既定で、sound を持つ行
 * (ChallengeRouletteConfig / JoinRouletteConfig)だけがそれを**丸ごと**差し替える
 * — フィールド単位の継承はしない(設定UIを「共通に従う」チェック1個で
 * 説明しきれる粒度に保つため)。
 *
 * 盤面(segments)と違い音は正しさに関与しないので、**effect には音を載せない** —
 * 載せるのは行の同一性(rouletteId / rouletteJoin)だけで、モニターは
 * shared の resolveRouletteSound で cfg から引き直す(音量を cfg から読む
 * giftBandFx.bgmVolume と同じ扱い)。設定変更は onSettings の即時プッシュで届くので、
 * **キューに積まれたスピンにも新しい音が効く**。
 * enabled ブールは持たない — 各スロットの 'off' が完全にその役を果たし、
 * 「off なのに id が残る」状態を作らないため。
 */
export interface RouletteSoundConfig {
  /** 回転中BGMの id(CHALLENGE_ROULETTE_BGM_IDS)または 'off'(鳴らさない)。 */
  bgm: string;
  /** BGMの音量 0-100。seVolume・giftBandFx.bgmVolume とは独立。 */
  bgmVolume: number;
  /**
   * リール回転ループ音の id(CHALLENGE_ROULETTE_SPIN_SE_IDS)、'off'、または
   * `custom:<ファイル名>`(ユーザーが取り込んだ config/sounds/ 内のファイル —
   * 規約は shared/challenge.ts の CUSTOM_SOUND_PREFIX)。
   */
  spinSe: string;
  /** ループ音の音量 0-100。 */
  spinSeVolume: number;
  /**
   * 超激アツ(ultra)の全画面動画に焼き込まれた効果音の音量 0-100。
   * 素材(assets/fx/rl/*.mp4)の音声トラックをそのまま鳴らす — 全面カットの
   * giftFullCut.volume と同じ流儀で、challenge.seVolume は掛からない絶対値。
   * seEnabled が false なら動画ごと無音になる。
   */
  clipVolume: number;
}

/**
 * ダイヤ帯域カットイン(バンド演出)の1帯域。min〜max(両端含む)のダイヤ数の
 * ギフトで clip を全画面再生し、durationSec の間カウンタを凍結する。
 */
export interface GiftFxBand {
  id: string;
  /** ダイヤ下限(inclusive)。 */
  min: number;
  /** ダイヤ上限(inclusive)。 */
  max: number;
  /** クリップ id(CHALLENGE_FX_CLIP_IDS)または 'off'(この帯域では出さない)。 */
  clip: string;
  /** 演出とカウンタ凍結の秒数(1〜30)。動画が短ければループで持たせる。 */
  durationSec: number;
  enabled: boolean;
  /**
   * カットイン中に流すBGM id(CHALLENGE_BAND_BGM_IDS)または 'off'。
   * 効果音(seSounds)とは別カタログ — 長尺曲をジングルの選択肢に混ぜない。
   */
  bgm: string;
}

/**
 * ダイヤ帯域カットインの設定。バンド一致時は全画面カットインを再生し、
 * 再生中はカウンタを凍結する(worker の fxFreeze)。
 */
export interface GiftBandFxConfig {
  enabled: boolean;
  bands: GiftFxBand[];
  /**
   * 除外する giftId。既定はハートミー('7934')— 1ダイヤの高頻度ギフトで
   * カットインを出すと画面が埋まる。ライブ経路では canonical が乗らないため
   * giftId ベースが本線(canonical 'heart_me' は保険で常に除外)。
   */
  excludeGiftIds: string[];
  /** 最上位バンドの max を超えたギフト: 'top'=最上位バンドを適用 / 'off'=バンド演出なし。 */
  overflow: 'top' | 'off';
  /**
   * カットイン中のBGM。有効時はギフトジングル(gift-tN の効果音)の代わりに
   * バンドごとの bgm を再生する(useChallengeSe が fxBandClip 付き gift を黙る)。
   */
  bgmEnabled: boolean;
  /** BGMの音量 0-100。効果音の seVolume とは独立(モニターのカットイン専用)。 */
  bgmVolume: number;
}

/**
 * 全面カットの1行。**ダイヤ数ではなくギフトそのもの**(giftId / giftName / canonical)で
 * 一致させるのが帯域(GiftFxBand)との違い。一致したギフトは帯域カットインを再生しない。
 *
 * トリガー3つの意味は matchGiftTrigger の規約に従う(giftId は完全一致、giftName は
 * 部分一致、canonical は完全一致。3つとも '' の行はどのギフトにも一致しない)。
 */
export interface GiftFullCutRule {
  id: string;
  /** 設定画面の行見出し。表示専用でマッチには一切使わない。 */
  label: string;
  /** giftId 完全一致。'' で無視。ライブ経路で最も確実。 */
  giftId: string;
  /** ギフト名の部分一致(小文字で保存)。'' で無視。 */
  giftName: string;
  /** canonical 完全一致(小文字で保存)。'' で無視。 */
  canonical: string;
  /**
   * giftName の照合を**完全一致**にする。既定 false = 従来どおり部分一致(includes)。
   * giftId / canonical は元から完全一致なのでこのフラグの影響を受けない。
   *
   * 必要な理由: ギフト名は部分一致なので、短い名前の行が上位ギフトを巻き込む。
   * 例えば giftName 'tiktok' の行は「TikTok Universe」(44,999💎)にも一致してしまい、
   * 1ダイヤのロゴ演出が最高額ギフトの演出を奪う。そういう行だけ true にする。
   *
   * ⚠ この規約は giftFullCut 専用。matchGiftTrigger を共有するルーレット
   *   (ChallengeRouletteConfig)とファンスタンプ(FanStampConfig)はこのキーを
   *   持たないので、undefined = 従来の部分一致のまま変わらない。
   *
   * 省略可(?:)にしないのは、既定を toEqual で比較しているテストが
   * 「キー有り false」と「キー無し」を別物と判定するのと、UI の controlled
   * checkbox が undefined を嫌うため(FanStampConfig.suppressBandFx と同じ流儀)。
   */
  exactName: boolean;
  /** クリップ id(CHALLENGE_FX_CLIP_IDS)または 'off'(この行では出さない)。 */
  clip: string;
  /** 演出とカウンタ凍結の秒数(1〜30)。動画が短ければループで持たせる。 */
  durationSec: number;
  enabled: boolean;
}

/**
 * ダイヤの全面カット。**ダイヤ数帯(giftBandFx)より先に評価し、一致したら帯域は
 * 一切評価しない**(matchGiftFullCut)。
 *
 * 帯域と違い BGM 選択を持たない — 素材(assets/fx/cut/*.mp4)に音声が焼き込んで
 * あるため。音量だけをここで持ち、モニターは stock-cutin と同じ方式で
 * <video> の muted を外して鳴らす(あちらの音量は stockCutinVolume が持つ —
 * 焼き込み音声の音量は**その動画を出す機能が自分で持つ**のがこの2つの共通規約)。
 */
export interface GiftFullCutConfig {
  enabled: boolean;
  /** 焼き込み音声の音量 0-100。seEnabled=false のときは映像ごと無音になる。 */
  volume: number;
  /** 上から順に評価し、最初に一致した1行だけを使う(giftRules と同じ先勝ち)。 */
  rules: GiftFullCutRule[];
}

/**
 * 連打ギフト(コンボ)の演出反復。TikTok の streakable ギフト(gift.type === 1)は
 * 「連打中は repeatEnd=0、最後の1件だけ repeatEnd=1 + 合計 repeatCount」で届き、
 * normalize.ts がそれを1件の NormalizedEvent へ畳む(diamonds はそこで確定 —
 * 再計算禁止)。その1件の演出をモニター側で回数ぶん撃ち直すのがこの設定。
 *
 * **反復するのは見た目だけ** — 値・統計・ランキング・履歴ログは1件のまま。
 * 唯一の例外は rouletteEnabled(抽選を N 回引くので増減も N 回ぶんになる)。
 */
export interface GiftRepeatFxConfig {
  enabled: boolean;
  /** 1イベントあたりの最大再生回数(1 = 従来どおり1回)。 */
  max: number;
  /** 反復の間隔(ms)。クリップ/簡易演出/効果音/フラッシュに効く。 */
  intervalMs: number;
  /**
   * 帯域カットインも繰り返す。全画面動画なので間隔ではなく尺ぶんの直列再生になり、
   * その間ずっとカウンタが凍結する(6秒バンド×5 = 30秒)。
   */
  bandEnabled: boolean;
  /**
   * ギフトルーレットも回数ぶん回す。**これだけは値の増減も回数ぶんになる** —
   * ルーレットは抽選なので、反復するには出目を N 回引くしかないため。
   */
  rouletteEnabled: boolean;
}

/**
 * お助け機能(ファンスタンプ)の設定。クリエイター専用のカスタムギフトが届いたら
 * 「個数 × amountEach」だけカウントを動かす。単一設定だが、将来複数化したくなった
 * ときのために matchFanStamp は boolean ではなく行そのものを返す(matchRoulette と
 * 同じ形)— 呼び出し側のコードを変えずに配列化できる。
 *
 * トリガー3フィールド(giftId/giftName/canonical)は ChallengeRouletteConfig と
 * 意味も '' = 無効の規約も同一。判定は matchGiftTrigger で共有する。
 */
export interface FanStampConfig {
  enabled: boolean;
  /**
   * トリガーギフトの giftId 直接一致。ライブ経路では NormalizedEvent.canonical が
   * 未代入(normalize.ts は名寄せ結果をイベントに載せない)なので、これが本線。
   */
  giftId: string;
  /** 補助マッチ: giftName の小文字部分一致。'' で無効(ID 変更時の保険)。 */
  giftName: string;
  /** 補助マッチ: canonical 一致。リプレイ/テスト経路でだけ乗る。'' で無効。 */
  canonical: string;
  /**
   * ギフト1個(repeatCount 1)あたりの増減。負=減らす(お助け)、正=増える(妨害)。
   * ダイヤ数ではなく**個数**に比例させる — 2ダイヤ以上のカスタムギフトを作られても
   * 「1個につき -N」の意味が変わらないようにするため(perDiamond を流用しない理由)。
   */
  amountEach: number;
  /**
   * true: このギフトではダイヤ帯域カットイン(と 6 秒のカウンタ凍結)を出さない。
   * ファンスタンプは 1 ダイヤ・高頻度なので、既定バンド(1〜50💎)に素で当たると
   * 届くたびにカウントが止まる。既定 true。
   */
  suppressBandFx: boolean;
  /** true ならモニターに照明フラッシュ演出。 */
  flash: boolean;
}

/**
 * チャットスタンプ(サブスクエモート)トリガーの1行。ギフトではなく
 * WebcastChatMessage / WebcastEmoteChatMessage の emote として届くスタンプを
 * お助け(fanStamp)と同じ演出・同じ合算窓で増減に割り当てる。
 *
 * emoteId は**完全一致のみ**(giftName のような部分一致の保険が無いのは、
 * emote に名前がそもそも載って来ないため — 表示用の label はマッチに使わない)。
 */
export interface StampTriggerRule {
  /** 行の識別子。UI の key 用(GiftFullCutRule.id と同じ役割)。 */
  id: string;
  /** 設定画面の行見出し(例: ようこそ)。表示専用でマッチには一切使わない。 */
  label: string;
  /** エモートの emoteId 完全一致。'' はどのスタンプにも一致しない。 */
  emoteId: string;
  /**
   * スタンプ1個あたりの増減。負=減らす(お助け)、正=増える(妨害)。
   * 0 は「演出だけ出して値は動かさない」(FanStampConfig.amountEach と同じ clamp)。
   */
  amountEach: number;
  enabled: boolean;
}

/**
 * チャットスタンプ(サブスクエモート)トリガー。**1メッセージに複数スタンプ**が
 * 載って届くので、一致した全スタンプの合計を1回で適用し、演出はお助けの
 * 合算バナー(fanStamp effect)を流用する。値の増減はギフトの増減規則とは
 * 独立(スタンプはギフトではないので、そもそもあちらの規則を通らない)。
 */
export interface StampTriggerConfig {
  enabled: boolean;
  /** true ならモニターに照明フラッシュ演出(FanStampConfig.flash と同じ)。 */
  flash: boolean;
  rules: StampTriggerRule[];
}

/**
 * タップブースト(フィーバー)の設定。トリガーギフトが届くと
 * ①起動カットイン(introClip・固定 TAP_BOOST_INTRO_MS = 5秒)→
 * ②カウントダウン(countClip・固定 TAP_BOOST_COUNT_MS = 3秒。3・2・1 は映像
 * 焼き込み)→ ③タップウィンドウ durationSec 秒(loopClip のループ+BGM。
 * 減算タップは「数えるだけ」で溜める)→ ④結果カットシーン(resultClip・固定
 * TAP_BOOST_RESULT_MS = 4秒。'off' でスキップ)→ ⑤減算量「-N」のロールアップ
 * 発表(パチンコ風の桁回転→確定→溜め)→ ⑥7セグへ着弾 →
 * ⑦一括減算(タップ数 × pressStep × multiplier)、の順に進む。
 *
 * 各段の映像は同梱素材(assets/fx/boost/)から段ごとに選択できる。id の一覧は
 * shared/challenge.ts の TAP_BOOST_*_CLIPS(validate がそのリストで検証する)。
 *
 * お助け(fanStamp)とは別機能・別トリガー。トリガー3フィールド(giftId/giftName/
 * canonical)は FanStampConfig と意味も '' = 無効の規約も同一で、判定は
 * matchGiftTrigger を共有する。
 */
export interface TapBoostRule {
  /** 行の識別子。UI の key と行ごとの実演(ChallengeTestEffectSpec.boostId)の対象特定に使う。 */
  id: string;
  /** 設定画面の行見出し。表示専用でマッチには使わない(GiftFullCutRule.label と同じ)。 */
  label: string;
  enabled: boolean;
  /** トリガーギフトの giftId 直接一致。ライブ経路の本線(FanStampConfig と同じ理由)。 */
  giftId: string;
  /** 補助マッチ: giftName の小文字部分一致。'' で無効(ID 変更時の保険)。 */
  giftName: string;
  /** 補助マッチ: canonical 一致。リプレイ/テスト経路でだけ乗る。'' で無効。 */
  canonical: string;
  /**
   * giftName の照合を**完全一致**にする(既定 false = 従来どおり部分一致)。規約は
   * GiftFullCutRule.exactName と同じだが、**ブーストの方が誤爆の代償が大きい** —
   * 一致すると最長23秒カウンタが凍結し、そのギフトの全面カット・帯域・ルーレットは
   * 評価すらされない。短いギフト名を使うときは立てるか、giftId で当てること。
   */
  exactName: boolean;
  /** ブースト中のタップ倍率。既定 5(clamp 1〜100)。 */
  multiplier: number;
  /**
   * タップウィンドウの長さ(秒)。既定 5・clamp 5〜15(ユーザー要件)。前置き
   * (起動5秒+カウントダウン3秒)と合わせた総凍結は最長 23 秒 — 帯域カットインの
   * GIFT_FX_FREEZE_MAX_MS(15秒)を意図的に超える(理由は
   * TAP_BOOST_DURATION_MAX_SEC のコメント参照)。
   */
  durationSec: number;
  /** 起動カットインのクリップ id(TAP_BOOST_INTRO_CLIPS)または 'off'(この段をスキップ)。 */
  introClip: string;
  /** カウントダウンのクリップ id(TAP_BOOST_COUNT_CLIPS)または 'off'(この段をスキップ)。 */
  countClip: string;
  /** タップウィンドウのクリップ id(TAP_BOOST_LOOP_CLIPS)または 'off'(暗幕+カウンタのみ)。 */
  loopClip: string;
  /**
   * 結果カットシーンのクリップ id(TAP_BOOST_RESULT_CLIPS)または 'off'(この段を
   * スキップ)。ロールアップ発表('-N')は 'off' でも常に出る。
   */
  resultClip: string;
  /** true ならモニターに照明フラッシュ演出。 */
  flash: boolean;
}

/**
 * タップブースト(フィーバー)の設定。**上から順に評価し、最初に一致した1行だけ**を
 * 使う(giftFullCut / roulettes と同じ先勝ち)。ギフトごとに倍率・尺・映像を変えられる。
 *
 * 旧・単一設定(giftId/multiplier/クリップをこの階層に直接持つ形)は
 * validateTapBoost が rules[0] へ包み直す。**移行(migrate*)ではなく validate 側**に
 * あるのは、migrateChallengeConfig が validateChallengeConfig の**後**に走るため
 * (boot-settings.ts の loadSettings / loadChallengeDefault)— あちらは明示リテラル
 * return なので、migrate の時点では旧キーはもう消えている。validateRoulettes が
 * 旧単数キー roulette を roulettes[0] へ寄せるのと同じ手口。
 */
export interface TapBoostConfig {
  /** 機能全体のスイッチ。false で全行が止まる(行ごとの enabled とは別)。 */
  enabled: boolean;
  rules: TapBoostRule[];
}

/**
 * お邪魔(タップ封じ)の1行。tapBoost の**鏡像** — あちらが「押すほど効く」なら
 * こちらは「押させない」。トリガーの3フィールドと exactName の規約は TapBoostRule と
 * 同じなので、matchTapLock は matchTapBoost の複製でよい。
 */
export interface TapLockRule {
  /** 行の識別子。UI の key と行ごとの実演(ChallengeTestEffectSpec.lockId)の対象特定に使う。 */
  id: string;
  /** 設定画面の行見出し。表示専用でマッチには使わない。 */
  label: string;
  enabled: boolean;
  /** トリガーギフトの giftId 直接一致。ライブ経路の本線(TapBoostRule と同じ理由)。 */
  giftId: string;
  /** 補助マッチ: giftName の小文字部分一致。'' で無効(ID 変更時の保険)。 */
  giftName: string;
  /** 補助マッチ: canonical 一致。リプレイ/テスト経路でだけ乗る。'' で無効。 */
  canonical: string;
  /**
   * giftName の照合を**完全一致**にする(既定 false = 部分一致)。**誤爆の代償は
   * ブーストより更に大きい** — 一致すると配信者のタップそのものが止まる。短い
   * ギフト名を使うときは必ず立てるか、giftId で当てること。
   */
  exactName: boolean;
  /** 封印の長さ(秒)。既定 30・clamp は TAP_LOCK_DURATION_MIN_SEC〜MAX_SEC。 */
  durationSec: number;
  /**
   * トリガーギフト1個あたりのカウント増減量。既定 0 = **値は動かさない**
   * (tapBoost のトリガーギフト規約と同じ)。正 = 妨害(増える)。
   */
  amountEach: number;
  /** true ならモニターに照明フラッシュ演出。 */
  flash: boolean;
}

/**
 * お邪魔(タップ封じ)の設定。**上から順に評価し、最初に一致した1行だけ**を使う
 * (tapBoost / giftFullCut / roulettes と同じ先勝ち)。
 *
 * 機能 enabled の既定は **false**(周辺機能の「既定 true」とは逆)。アプリの主操作
 * そのものを殺す機能なので、キー欠損の既定フォールバックで勝手に有効化されては
 * ならない — validate 側も `=== true` で読む(challenge.ts の真偽値の向きの規約)。
 */
export interface TapLockConfig {
  /** 機能全体のスイッチ。false で全行が止まる(行ごとの enabled とは別)。 */
  enabled: boolean;
  rules: TapLockRule[];
}

/**
 * 革命の1行。tapBoost / tapLock と同じトリガー3フィールド+exactName の規約で、
 * 判定は matchGiftTrigger を共有する(matchRevolution)。
 *
 * 効果は「1分間の窓」を開くこと: ①タップが multiplier 倍で**即時**に効く
 * (フィーバーのプレーンモードと同じ — 凍結は張らない)、②いいね着弾・いいね
 * ストック着弾の増減が**反転**して減算になる(妨害がお助けになる)。
 */
export interface RevolutionRule {
  /** 行の識別子。UI の key と行ごとの実演(ChallengeTestEffectSpec.revolutionId)の対象特定に使う。 */
  id: string;
  /** 設定画面の行見出し。表示専用でマッチには使わない。 */
  label: string;
  enabled: boolean;
  /** トリガーギフトの giftId 直接一致。ライブ経路の本線(TapBoostRule と同じ理由)。 */
  giftId: string;
  /** 補助マッチ: giftName の小文字部分一致。'' で無効(ID 変更時の保険)。 */
  giftName: string;
  /** 補助マッチ: canonical 一致。リプレイ/テスト経路でだけ乗る。'' で無効。 */
  canonical: string;
  /**
   * giftName の照合を**完全一致**にする(既定 false = 部分一致)。既定行は
   * 'swan' という短い名前を使うので必ず立てる(TapBoostRule.exactName と同じ警告 —
   * 'black swan' 等への部分一致誤爆で1分間ゲーム経済が変わる)。
   */
  exactName: boolean;
  /** 窓中のタップ倍率。既定 3(clamp REVOLUTION_MULT_MIN〜MAX)。 */
  multiplier: number;
  /** 窓の長さ(秒)。既定 60・clamp REVOLUTION_DURATION_MIN_SEC〜MAX_SEC。 */
  durationSec: number;
  /** true ならモニターに照明フラッシュ演出。 */
  flash: boolean;
}

/**
 * 革命の設定。**上から順に評価し、最初に一致した1行だけ**を使う(tapBoost /
 * tapLock と同じ先勝ち)。
 *
 * 機能 enabled の既定は **false**(tapLock と同じ向き)。いいね妨害の反転は
 * ゲーム経済の意味を変えるので、キー欠損の既定フォールバックで勝手に有効化
 * されてはならない — validate 側も `=== true` で読む。旧 settings.json に
 * このキーは無いので、**欠損時のフォールバックが移行の代わり**になる
 * (SETTINGS_VERSION は上げない)。
 */
export interface RevolutionConfig {
  /** 機能全体のスイッチ。false で全行が止まる(行ごとの enabled とは別)。 */
  enabled: boolean;
  rules: RevolutionRule[];
}

/**
 * お題ルーレットのトリガー1行。マッチのフィールド構成は RevolutionRule と同一
 * (matchGiftTrigger 互換)で、倍率・秒数を持たない — 窓の尺や増減幅は行ごと
 * ではなく QuizConfig 側の1組(お題の企画はゲーム内で1種類、という整理)。
 */
export interface QuizRule {
  /** 行の識別子。UI の key と行ごとの実演(ChallengeTestEffectSpec.quizId)の対象特定に使う。 */
  id: string;
  /** 設定画面の行見出し。モニターの見出し表示にも使う(「{label} ○○がお題ルーレット!」)。 */
  label: string;
  enabled: boolean;
  /** トリガーギフトの giftId 直接一致。ライブ経路の本線(RevolutionRule と同じ理由)。 */
  giftId: string;
  /** 補助マッチ: giftName の小文字部分一致。'' で無効(ID 変更時の保険)。 */
  giftName: string;
  /** 補助マッチ: canonical 一致。リプレイ/テスト経路でだけ乗る。'' で無効。 */
  canonical: string;
  /** giftName の照合を**完全一致**にする(既定 false = 部分一致)。RevolutionRule と同じ警告。 */
  exactName: boolean;
  /** true ならモニターに照明フラッシュ演出。 */
  flash: boolean;
}

/**
 * お題ルーレットの**数値到達トリガー**1行(2026-08-22 ユーザー決定)。ギフトではなく
 * チャレンジのカウント値を監視し、`value` が `value` フィールドの数を**下から上へ
 * 跨いだ瞬間**に発動する(「○○を超えました!」)。
 *
 * **ヒステリシス**: 一度発動したら、カウントがしきい値を**下回るまで再発動しない**。
 * 判定の唯一の実装は shared/challenge.ts の stepQuizThresholds。
 */
export interface QuizThresholdRule {
  /** 行の識別子。UI の key と行ごとの実演(ChallengeTestEffectSpec.quizThresholdId)に使う。 */
  id: string;
  /** 設定画面の行見出し。表示専用でマッチには使わない(QuizRule.label と同じ)。 */
  label: string;
  enabled: boolean;
  /**
   * しきい値。カウント値がこの数**以上**へ跨いだ瞬間に発動する(「達した時」なので
   * 厳密には `>=`)。clamp は QUIZ_THRESHOLD_MIN〜MAX。
   */
  value: number;
  /** true ならモニターに照明フラッシュ演出。 */
  flash: boolean;
  /**
   * 告知(「○○を超えました!」)の瞬間に鳴らす効果音(2026-08-23 ユーザー決定
   * 「数値トリガーの行ごとに音を指定」)。
   *
   * - `QUIZ_THRESHOLD_SOUND_SLOT`(`'slot'`)= **既定**。「効果音」タブの
   *   『ルーレット確定』スロットに従う(2026-08-22 版とまったく同じ挙動)。
   *   既定がこの番兵なので、**キー欠損のフォールバックが移行の代わり**になり
   *   SETTINGS_VERSION は上げなくてよい。
   * - `'off'` = 無音。
   * - `CHALLENGE_SE_SOUND_IDS` のカタログ id、または取込み済みカスタム音
   *   (`custom:<ファイル名>` — RouletteSoundConfig.spinSe と同じ規約)。
   */
  sound: string;
  /**
   * 上の音の音量(0-100)。全体音量(seVolume)と掛け合わせる
   * (effectiveSeVolume 経由 — スロットごとの個別音量と同じ扱い)。
   * `sound === 'slot'` のときは**無視**され、スロット側の音量が効く。
   */
  soundVolume: number;
}

/**
 * お題ルーレットの設定。トリガー行は**上から順に評価し、最初に一致した1行だけ**
 * (revolution と同じ先勝ち)。
 *
 * 機能 enabled の既定は **false**(revolution と同じ向き)。全アクション停止+投票で
 * ±amount というゲーム経済の大技なので、キー欠損の既定フォールバックで勝手に
 * 有効化されてはならない — validate 側も `=== true` で読む。旧 settings.json に
 * このキーは無いので、**欠損時のフォールバックが移行の代わり**になる
 * (SETTINGS_VERSION は上げない)。
 */
export interface QuizConfig {
  /** 機能全体のスイッチ。false で全行が止まる(行ごとの enabled とは別)。 */
  enabled: boolean;
  rules: QuizRule[];
  /**
   * 数値到達トリガー(カウント値がしきい値を上へ跨いだら発動)。**既定は空配列**で、
   * 旧 settings.json にこのキーは無い — 欠損 → `[]` = 発動なし、が**そのまま移行の
   * 代わり**になる(SETTINGS_VERSION は上げない。revolution / tapLock と同じ前例)。
   * rules と同じく上から順に評価するが、同じ判定 tick で複数行が跨いだときは
   * **最初の1行だけ発動し、跨いだ他の行も再武装待ちへ落とす**(発動をスタックさせない)。
   */
  thresholds: QuizThresholdRule[];
  /**
   * お題の候補(表示順)。arm 時に worker が等確率で1件抽選する。
   * 空配列のままでは発動しない(トリガー一致しても不発 + giftDiag に記録)。
   */
  prompts: string[];
  /** 挑戦ウィンドウ(制限時間)の秒数。既定 60・clamp QUIZ_DURATION_MIN_SEC〜MAX_SEC。 */
  durationSec: number;
  /** 投票タイムの秒数。既定 30・clamp QUIZ_VOTE_MIN_SEC〜MAX_SEC。 */
  voteSec: number;
  /** 判定の増減幅(正の数で保持)。よかった多数で減算、だめ多数で加算。既定 5000。 */
  amount: number;
  /** 「よかった」判定ワード(部分一致・大文字小文字無視)。先頭が投票画面の表示語。 */
  goodWords: string[];
  /** 「だめ」判定ワード(規約は goodWords と同じ)。 */
  badWords: string[];
  /**
   * **区間①(発動〜導入カット〜回転)** の BGM の id
   * ('off' / 同梱カタログ id / custom:)。ギフト着弾の瞬間からモニターが
   * 切り替える — 「お題モードが来る」予告そのもの。
   *
   * 2026-08-22 に「発動中ずっと1曲」から**区間の先頭スロット**へ意味を変えた。
   * 後続の区間(revealBgm / prepBgm / thinkBgm / voteBgm)の既定が
   * QUIZ_BGM_KEEP なので、**何も設定していなければ従来どおり1曲が通しで鳴る**。
   * このスロットだけは 'keep' を受け付けない(継続元が無い)。
   */
  bgm: string;
  /** bgm の音量 0-100(絶対値・seVolume は掛からない — rouletteSound と同じ規約)。 */
  bgmVolume: number;
  /**
   * **区間②(お題発表 = 決定パンチ表示・QUIZ_REVEAL_MS)** の BGM。
   * QUIZ_BGM_KEEP で「前の区間の曲を続ける」(既定)。値域は bgm + 'keep'。
   */
  revealBgm: string;
  /** revealBgm の音量 0-100。'off'/'keep' のときは使わない。 */
  revealBgmVolume: number;
  /**
   * **区間★(お題発表準備)** の秒数。発表と制限時間の間に挟む仕度時間。
   * 既定 5・clamp QUIZ_PREP_MIN_SEC(0)〜QUIZ_PREP_MAX_SEC(60)。
   * **0 でこの区間ごとスキップ**(発表からそのまま制限時間へ)。
   *
   * 窓の原点は「モニターが前置きを再生し始めた時刻 + preMs」なので、この値は
   * arm 時に QuizArmSnapshot へ焼き込み、effect の quizPrepMs で配る
   * (窓中に設定を変えても進行中の1回はズレない)。
   */
  prepSec: number;
  /** **区間★(お題発表準備)** の BGM。既定 QUIZ_BGM_KEEP。 */
  prepBgm: string;
  /** prepBgm の音量 0-100。 */
  prepBgmVolume: number;
  /** **区間③(お題考え時 = 挑戦ウィンドウ・durationSec)** の BGM。既定 QUIZ_BGM_KEEP。 */
  thinkBgm: string;
  /** thinkBgm の音量 0-100。 */
  thinkBgmVolume: number;
  /** **区間④(コメント受付時 = 投票タイム・voteSec)** の BGM。既定 QUIZ_BGM_KEEP。 */
  voteBgm: string;
  /** voteBgm の音量 0-100。 */
  voteBgmVolume: number;
  /**
   * **区間⑤(終了後)** の秒数。**投票締切の瞬間**から数え、結果発表カットシーン
   * (QUIZ_RESULT_MS = 6秒)はこの中に含まれる。既定 20・clamp 0〜120。0 で無効。
   */
  outroSec: number;
  /**
   * **区間⑤** の BGM(**減算 = 「よかった」多数**)。既定 'off'。
   * 出荷 v0.13.0 は投票締切で無音になる仕様なので、既定を 'keep' にはしない
   * (勝手に鳴り続けるようになった、という驚きを配らない)。
   */
  outroDownBgm: string;
  /** outroDownBgm の音量 0-100。 */
  outroDownBgmVolume: number;
  /** **区間⑤** の BGM(**増加 = 「だめ」多数**)。既定 'off'。 */
  outroUpBgm: string;
  /** outroUpBgm の音量 0-100。 */
  outroUpBgmVolume: number;
  /**
   * 導入全面カットのクリップ id。既定 'off'(再生枠のみ = この段をスキップ)。
   * 全面カット素材(FX_CLIPS)から選ぶ。
   */
  introClip: string;
}

/**
 * ルーレット走行中の「残り」小窓の出し方。既定は 'small'。
 * 見え方の実装は monitor.css の .count-mirror 節を参照。
 */
export type RouletteCountView = 'off' | 'small' | 'large';

/** 設定 UI と欠損フォールバックが共有する候補一覧(順序はそのまま選択肢の並び)。 */
export const ROULETTE_COUNT_VIEWS: readonly RouletteCountView[] = ['off', 'small', 'large'];

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
  /** いいね◯件ごとに加算(妨害)。0 で無効。 */
  likeEvery: number;
  /** likeEvery 件ごとに増える量。 */
  likeStep: number;
  /** ゲージ満タン◯回でストック満杯 → likeStockStep を加算(妨害)。0 で無効。 */
  likeStockCount: number;
  /** ストック満杯1回あたりの加算量。 */
  likeStockStep: number;
  /**
   * ストック満杯カットイン(assets/fx/stock-cutin.mp4)の焼き込み音声の音量 0-100。
   *
   * giftFullCut.volume と同じ**絶対値**で、seVolume(全体音量)は掛からない。
   * v0.5.3 までは効果音スロット 'stock-full' の音量(= seVolume × seVolumes)を
   * 流用していたが、あのスロットは同じ瞬間に鳴る効果音 stock-burst と共用で、
   * 配布デフォが 16% に絞ってあるため動画の音が 70×16% ≒ 11% まで潰れていた。
   * 音を分けられるようにスロットから独立させたのがこのフィールド。
   *
   * seEnabled=false のときは映像ごと無音になる(muted 側の判定)。
   */
  stockCutinVolume: number;
  /**
   * 指定コメント(キーワード)の妨害規則。**上から順に評価し、最初に一致した
   * 1件だけ適用**(giftRules と同じ先勝ち)。空配列 = 機能オフ。
   */
  commentRules: ChallengeCommentRule[];
  giftRules: ChallengeGiftRule[];
  /** どの規則にも一致しないギフトの既定動作。null なら無視。 */
  giftDefault: { mode: 'fixed' | 'perDiamond'; amount: number } | null;
  /**
   * ギフトルーレット。**上から順に評価し、最初に一致した1件だけ適用**(giftRules と
   * 同じ規約)。トリガー一致時は giftRules/giftDefault より優先。
   * 旧 settings.json の単一 `roulette` キーは validateChallengeConfig が1件の配列へ移行する。
   */
  roulettes: ChallengeRouletteConfig[];
  /**
   * 入室ルーレット(初見さんのみ / すべての入室)。ギフトルーレットとは独立の
   * 単一設定。旧 settings.json にキーが無ければ validateJoinRoulette が既定値
   * (enabled:false)へ倒すので移行は不要。
   */
  joinRoulette: JoinRouletteConfig;
  /**
   * ルーレット回転中のBGM・ループ音。**出目の方向が 'add'(増やす/妨害)の
   * ルーレットの既定**(行ごとに sound で上書き可)。
   */
  rouletteSound: RouletteSoundConfig;
  /**
   * 出目の方向が 'sub'(減らす/応援)のルーレットの既定。rouletteSound と同じ
   * 立ち位置の**別の1組**で、項目単位の継承も相互追従もしない — 「応援のルーレットは
   * 音でも見分けが付く」ためのもの(見た目の緑テーマと対)。
   *
   * 旧 settings.json にこのキーは無いので、**欠損時のフォールバックが移行の代わり**
   * になる(SETTINGS_VERSION は上げない。rouletteTease / 行別 sound と同じ手口)。
   * 既定は共通からの派生で、回転ループ音だけを差し替える — defaultRouletteSoundSub。
   * 実効値の解決は resolveRouletteSound、共通の選択は rouletteCommonSound が唯一の実装。
   */
  rouletteSoundSub: RouletteSoundConfig;
  /**
   * 超焦らし(jack 3種)のカウント方式。全ルーレット共通で1組。旧 settings.json に
   * キーが無ければ validateRouletteTease が既定(enabled:true・3種全部)へ倒す。
   */
  rouletteTease: RouletteTeaseConfig;
  /**
   * ライブ画面の履歴ログでルーレット結果の数値を伏せる(既定 true)。
   *
   * 抽選も値の適用もギフト受信の瞬間に確定しており、モニターのリールは
   * **確定済みの出目を遅れて再生しているだけ**(worker/challenge.ts の
   * matchRoulette 参照)。伏せないとリールが止まる前にログで結果が読める。
   *
   * 完全な隠蔽ではない — 前後の行の残数の差分と、カード上部の大きな残数
   * (モニターと違い据え置きが無い)からは逆算できる。
   */
  hideRouletteResultInLog: boolean;
  /** diamonds がこの値以上のギフトは規則に関係なく照明フラッシュ。null で無効。 */
  flashMinDiamonds: number | null;
  /** グローバルホットキー(Electron accelerator)。'' で無効。 */
  hotkey: string;
  /** モニターを出すディスプレイ。null = 自動(最後の非プライマリ)。 */
  monitorDisplayId: number | null;
  /** true = 全画面にせず通常のウィンドウ(枠付き・移動/リサイズ可)で出す。 */
  monitorWindowed: boolean;
  /** 「何時起き」をモニター左下に出す。 */
  wakeEnabled: boolean;
  /** 起床時刻 'HH:mm'(24時間・ローカル時刻)。null = 未設定(何も出さない)。 */
  wakeTime: string | null;
  /** 残数がこの値以下になるとモニターの数字が点滅する。 */
  lowThreshold: number;
  /**
   * ルーレット走行中にモニターへ出す「残り」の小窓。ルーレットは全面の暗幕
   * (rgba(5,3,10,.8))と ultra の全画面動画で7セグを覆うので、暗幕の手前に
   * 数字のコピーを出さないと最長 31 秒ほど残数が読めなくなる。
   * 'off' = 出さない / 'small' = 隅に小さく(既定)/ 'large' = 大きく。
   */
  rouletteCountView: RouletteCountView;
  /** 演出(press/follow/like/gift/achieved)の効果音を鳴らす。 */
  seEnabled: boolean;
  /** 効果音の音量 0-100。 */
  seVolume: number;
  /**
   * 演出スロットごとの効果音の割り当て。値は同梱音の id
   * (shared/challenge.ts の CHALLENGE_SE_SOUND_IDS)または 'off'(鳴らさない)。
   */
  seSounds: Record<ChallengeSeSlot, string>;
  /**
   * 演出スロットごとの相対音量 0-100(%)。実際に鳴る音量は
   * seVolume × この値 ÷ 100(さらに素材ごとの gain が掛かる)。既定は全スロット 100。
   */
  seVolumes: Record<ChallengeSeSlot, number>;
  /**
   * モニターの映像演出の全体スイッチ。達成CLEAR・ゲージ満タン・ストック・
   * 全面カット・ダイヤ帯域カットインの動画クリップすべてを一括で止められる。
   */
  fxClipsEnabled: boolean;
  /** 簡易演出(素材を持たない SVG+CSS の軽量アニメ)をモニターに出す。 */
  miniFxEnabled: boolean;
  /**
   * 演出スロットごとの簡易演出の割り当て。値は CHALLENGE_MINI_IDS の id
   * または 'off'(出さない)。
   */
  miniFx: Record<ChallengeSeSlot, string>;
  /**
   * ダイヤの全面カット。**giftBandFx(ダイヤ数帯)より先に評価**され、一致した
   * ギフトは帯域カットインを一切再生しない(matchGiftFullCut)。
   */
  giftFullCut: GiftFullCutConfig;
  /** ダイヤ帯域カットイン(matchGiftBand)。 */
  giftBandFx: GiftBandFxConfig;
  /** 連打ギフトの演出反復。値は動かさず見た目だけ回数ぶん撃つ(rouletteEnabled を除く)。 */
  giftRepeatFx: GiftRepeatFxConfig;
  /**
   * お助け機能(ファンスタンプ)。クリエイター専用のカスタムギフトを「応援」に
   * 割り当てる単一設定。**ルーレット/giftRules/giftDefault のどれよりも先に評価**
   * され、一致したギフトはそれらの規則を通らない(matchFanStamp)。
   */
  fanStamp: FanStampConfig;
  /**
   * チャットスタンプ(サブスクエモート)トリガー。ギフト経路とは独立に
   * comment / emote イベントの emoteId で発動し、演出は fanStamp を流用する。
   */
  stampTriggers: StampTriggerConfig;
  /**
   * タップブースト(フィーバー)。fanStamp の**次・ルーレットより先**に評価され、
   * 一致したギフトは増減規則を通らない(matchTapBoost — fanStamp と同じ先勝ち規約)。
   */
  tapBoost: TapBoostConfig;
  /**
   * お邪魔(タップ封じ)。fanStamp・tapBoost の**次・ルーレットより先**に評価され、
   * 一致したギフトは増減規則を通らない(matchTapLock — tapBoost と同じ先勝ち規約)。
   * tapBoost より後ろなのは、同じ giftId を両方に登録してしまったときに
   * 「ブーストが勝つ」ほうが安全側だから(封印が勝つと配信者のボタンが死ぬ)。
   */
  tapLock: TapLockConfig;
  /**
   * 革命。tapBoost の**次・tapLock より先**に評価され、一致したギフトは増減規則を
   * 通らない(matchRevolution — tapBoost と同じ先勝ち規約)。tapBoost より後ろ
   * なのは tapLock と同じ理由 — 同じ giftId を両方に登録したときはフィーバーが
   * 勝つほうが分かりやすい(どちらもタップ倍率系で、フィーバーの方が大きな山場)。
   */
  revolution: RevolutionConfig;
  /**
   * お題ルーレット。revolution の**次・tapLock より先**に評価され、一致したギフトは
   * 増減規則を通らない(matchQuiz — revolution と同じ先勝ち規約)。発動すると
   * バリア(発動時点の演出キューを消化してから開始・以降のイベントは清算まで
   * 後回し)+ 挑戦ウィンドウ + 投票タイムの長丁場になる。
   */
  quiz: QuizConfig;
  /**
   * 最終ゲート(ラスト◯◯モード)。残数が lowThreshold 以下のとき、タップ経路の
   * 1減算ごとに taps 回のタップが必要になる。フォロー/いいね/ギフト由来の増減と
   * フィーバー(タップブースト)ウィンドウ中のタップは対象外。閾値は lowThreshold に連動。
   */
  finalGate: FinalGateConfig;
}

/** 最終ゲート(ラスト◯◯で連打モード)の設定。 */
export interface FinalGateConfig {
  /** 発動する。既定 true(欠損キーは既定へ倒れる = 保存済み設定の移行を兼ねる)。 */
  enabled: boolean;
  /** 1減算に必要なタップ数。FINAL_GATE_TAPS_MIN..FINAL_GATE_TAPS_MAX。 */
  taps: number;
}

/** 指定コメント妨害の1規則。keyword はコメント本文への部分一致(大文字小文字無視)。 */
export interface ChallengeCommentRule {
  id: string;
  /** 部分一致キーワード。空文字はどのコメントにも一致しない(''.includes 罠のガード)。 */
  keyword: string;
  /** 一致1件あたりの加算量(妨害)。正の数で保持。 */
  amount: number;
}

/** 効果音を割り当てられる演出スロット。gift は演出 tier(ダイヤ数)で分かれる。 */
export type ChallengeSeSlot =
  | 'press'
  | 'follow'
  | 'like'
  | 'gauge-full'
  | 'stock-full'
  | 'comment'
  | 'gift-t1'
  | 'gift-t2'
  | 'gift-t3'
  | 'gift-t4'
  // お助け機能(ファンスタンプ)専用。1ダイヤなので tier だけでは gift-t1 と
  // 区別できず、お助けだけ音や簡易演出を変えられなかったので専用スロットにした。
  | 'helper'
  | 'roulette'
  | 'roulette-near'
  | 'roulette-kick'
  | 'roulette-hit'
  // 超激アツ(ultra)のカウントダウン式演出だけで鳴る2つ。再加速のあとの合図と、
  // 膨らんだ出目が元に戻る瞬間の悲鳴。他のスロットと違い**ボイス素材**を想定して
  // いるので、既定も専用録りを当てる(challenge.ts の DEFAULT_SE_SOUNDS)。
  | 'roulette-hype'
  | 'roulette-hype-back'
  | 'boost-start'
  | 'boost-end'
  | 'achieved';

export type ChallengeStatus = 'idle' | 'running' | 'achieved';

/**
 * モニターが再生する演出1件。id はエンジン生存期間を通して単調増加 —
 * 受信側は「最後に再生した id」だけ覚え、それより新しい項目を再生すれば
 * 冪等になる。reset で配列は消えるが id カウンタは巻き戻さない。
 */
export interface ChallengeEffect {
  id: number;
  /**
   * 'like' は1秒窓で合算して1件にまとめるため nickname を持たない。
   * 'gauge-full' はテスト再生(challenge.testEffect)専用 — ライブ経路の着弾演出は
   * likeGauge.fills の差分駆動で effect を持たないため、実演用にだけ effect を作る。
   */
  kind:
    | 'press'
    | 'follow'
    | 'like'
    | 'gauge-full'
    | 'stock-full'
    | 'comment'
    | 'gift'
    | 'roulette'
    | 'boost-start'
    | 'boost-end'
    | 'tap-lock'
    | 'revolution-start'
    | 'revolution-end'
    | 'quiz-start'
    | 'quiz-end'
    | 'achieved';
  /** カウント変化量(負=減、正=増)。achieved は 0。 */
  amount: number;
  /**
   * この演出を積んだ直後のカウント値。ダッシュボードの履歴ログが「何をされて
   * いくつになったか」を1行で言い切れるようにするため、worker 側で確定した値を
   * そのまま載せる — renderer で amount から逆算すると 0 クランプと
   * リングバッファの取りこぼしでズレる。
   */
  valueAfter: number;
  /** kind='gift' で照明フラッシュ演出を伴うとき true。 */
  flash?: boolean;
  nickname?: string;
  giftName?: string;
  /** kind='gift' の連打数。GiftEvent.repeatCount をそのまま載せる(再計算しない)。 */
  giftCount?: number;
  giftIconUrl?: string;
  /** kind='gift' の名寄せ済み canonical。演出クリップの選択に使う。 */
  canonical?: string;
  diamonds?: number;
  /**
   * kind='comment': 一致した規則のキーワード。rouletteLabel と同じ「effect 1件で
   * 自己完結」の流儀 — 表示側で cfg を引き直すと、規則を変えた瞬間に過去の演出・
   * ログの文言まで変わってしまう。
   */
  commentKeyword?: string;
  /**
   * kind='gift': この演出がお助け機能(ファンスタンプ)由来であること。モニターは
   * ギフトカードの代わりに専用のお助けバナーを出す。**cfg を引き直して判定しない** —
   * モニターの設定は 120 秒ポーリング(CFG_POLL_MS)で古くなりうるので、fxBandClip と同じ
   * 「effect 1件で自己完結」の流儀で worker が焼き込む。
   */
  fanStamp?: true;
  /**
   * kind='tap-lock': 焼き込んだ封印の総尺(ms)。rouletteSegments と同じ
   * 「effect 1件で自己完結」の流儀 — モニターの cfg は 120 秒ポーリング(CFG_POLL_MS)で
   * 古くなりうるので、発動時点の設定を worker が焼き込む。
   */
  tapLockMs?: number;
  /**
   * kind='tap-lock': 封印の絶対期限(ms)。凍結ドレインで遅れて再生されても残り秒が
   * 正しくなるよう、尺ではなく期限も載せる。**権威は ChallengeState.tapLock** で、
   * こちらは告知バナー1枚を自己完結させるための焼き込み。
   */
  tapLockUntilMs?: Ms;
  /**
   * kind='roulette': 盤面(表示順の出目の絶対値リスト)。モニターの設定取得は
   * 120秒ポーリング(CFG_POLL_MS)で古くなりうるため、演出は cfg からではなくここから盤面を
   * 読む — effect 1件で自己完結させる。
   */
  rouletteSegments?: number[];
  /**
   * kind='roulette': **1本目の**当選 index(rouletteSegments 内)。
   * 連打ギフトは1メッセージで N 回抽選するので、全出目は rouletteIndexes に載る
   * (ここは常に rouletteIndexes[0] と同値)。盤面が無い effect をバナーだけに
   * 退避させる rouletteWillSpin の判定がこのフィールドを見るため、単発フィールドを
   * 残してある。**amount は effect 全体の合計**で、1回ぶんの増減ではない。
   */
  rouletteIndex?: number;
  /**
   * kind='roulette': この effect が持つ全スピンの当選 index(到着順)。
   *
   * 「1ギフトメッセージ = 1 effect」の規約 — 連打ギフト(バラ等 giftType 1)は
   * repeatCount ぶん抽選するが、effect を回数ぶん積むと 12→32 件のリングバッファを
   * 一撃で溢れさせ、履歴ログも1ギフトで N 行に膨れる(「履歴ログは1件のまま」規約に
   * 反する)。出目を配列で持たせて effect は1件に保つ。
   * 凍結ドレインの畳み込み(finishDrain)は、**同じ盤面どうしに限り**この配列を
   * 連結する — 盤面が違えば index の意味が違うので畳まない。
   */
  rouletteIndexes?: number[];
  /**
   * kind='roulette': **1本目の**終盤演出パターン(常に roulettePatterns[0] と同値)。
   * rouletteSegments と同じ「effect 1件で自己完結」の流儀 — モニター側で毎回引くと
   * StrictMode の二重レンダーで振り直され、演出が途中で切り替わる。
   * 欠損時は 'slow'(旧 worker 混在の保険)。
   */
  roulettePattern?: RoulettePattern;
  /** kind='roulette': スピンごとの終盤演出パターン。rouletteIndexes と同じ長さ。 */
  roulettePatterns?: RoulettePattern[];
  /**
   * kind='roulette': スピンごとの**実適用量**(rouletteIndexes と同じ並び)。
   * 残量クランプ(終盤の sub 出目が残量を超えた: 残3にマス−10 → 実適用−3)が
   * 発生した effect にだけ載る — 通常経路は名目式(rouletteSegments[index] × 符号 ×
   * 倍率)と同値なので載せない(既存 effect と 1 バイトも変わらない)。
   * 復元(shared の rouletteDraws)はこれがあれば名目式より優先する。名目のままだと
   * モニターの据え置き会計(rouletteRemainingAmount → heldValueFor)が worker と
   * ズレて、リール再生待ちの間 7 セグが水増し表示される(3→10→0)。
   */
  rouletteAmounts?: number[];
  /**
   * kind='roulette': 連結の切り詰め(ROULETTE_DRAWS_MAX)で出目列から落とした
   * 抽選ぶんの増減合計と回数。**値は worker が全抽選ぶん適用済み**なので、出目列に
   * 現れない超過分をここで運ばないと、据え置き会計(rouletteReelPlan の rest)から
   * 漏れてリール再生前に数字だけ動く(出目の先漏れ)。合算バナーの「残りN回ぶん」と
   * 演出ストックの ×N もこの2つを合算する。切り詰めが無ければ載せない。
   */
  rouletteTruncatedAmount?: number;
  rouletteTruncatedCount?: number;
  /**
   * kind='roulette': 実際にリールを回す本数(rouletteIndexes.length 以下)。
   *
   * **値は常に rouletteIndexes.length 回ぶん適用済み**で、ここは見た目の尺だけを
   * 決める。worker が到着時点の cfg で確定させて焼き込み、モニターは読むだけ —
   * モニターの cfg は 120秒ポーリング(CFG_POLL_MS)で古くなりうるので再判定させない
   * (fxRepeat / fxBandClip と同じ「effect 1件で自己完結」の流儀)。
   * 超過ぶんはモニターが合算バナー1枚で締める。欠損時は全部回す。
   */
  rouletteReels?: number;
  /**
   * kind='roulette': 出目の向きが 'sub'(数字が減る)であることの印。'add' では載せない。
   *
   * amount は effect 全体の合計になったので、**そこから1回ぶんの符号は引けない**
   * (合計が 0 になる盤面もありうる)。モニターは
   * `rouletteSegments[index] × (rouletteDirection === 'sub' ? -1 : 1)` で
   * 1スピンぶんの増減を復元する(shared の rouletteDraws が唯一の実装)。
   */
  rouletteDirection?: 'sub';
  /**
   * kind='roulette': モニターの見出しに出す表示名(「{rouletteLabel} ○○がルーレット」)。
   * rouletteSegments と同じ「effect 1件で自己完結」の流儀 — モニターの設定は 30秒
   * ポーリングで古くなりうるので cfg から引き直さない。空なら従来の「○○がルーレット!」。
   */
  rouletteLabel?: string;
  /**
   * kind='roulette': 発火したギフトルーレット行の id(ChallengeRouletteConfig.id)。
   * 行ごとの回転サウンドをモニターが cfg から引き直すための「**行の同一性**」だけを
   * 載せる(音そのものは載せない — RouletteSoundConfig の解説を参照)。
   * **入室ルーレットには載せない** — あちらは rouletteJoin が行の同一性を兼ねる
   * (id を持たない単一設定なので、'join' 等を発明するとユーザーの行 id と衝突する)。
   * 欠損・不明 id(行を削除した/id を変えた)は共通サウンドへ倒れる(音だけの縮退)。
   * **rouletteBoardKey には入れない** — 理由は同関数の解説にある。
   */
  rouletteId?: string;
  /**
   * kind='roulette': 入室ルーレット(初見さん/すべての入室)の印。モニターはこの
   * effect を短縮(16 本目以降・合算 effect の2本目以降)と超焦らしカウント
   * (rouletteTease)の対象外にする — **本数に関係なく**常にフル尺で、worker 抽選の
   * パターンをそのまま再生する。欠損(旧 worker 混在)はギフト扱いへ倒す(演出上の劣化のみ)。
   */
  rouletteJoin?: true;
  /**
   * kind='roulette': 入室(初見)ルーレット由来である印。ギフトルーレットには載らない。
   * モニターはこれで専用キュー(優先度⑥)へ振り分ける。rouletteLabel での推定は不可 —
   * label はユーザー編集可能でギフト行に「初見さん」と付けられると衝突する。
   * rouletteSegments と同じ「effect 1件で自己完結」の流儀。
   */
  rouletteOrigin?: 'join';
  /**
   * kind='roulette': 激熱確定の**実倍率**。載っているときは worker が既に
   * `出目 × ここ` を値へ適用済みで、1スピンぶんの増減は
   * `rouletteSegments[index] × (rouletteDirection === 'sub' ? -1 : 1) × rouletteHotMult`
   * になる(復元は shared の rouletteDraws が唯一の実装)。**通常のルーレットには
   * 載せない**(キーごと出さない = 既存 effect と JSON 比較が素直に保たれる)。
   *
   * **rouletteBoardKey に入れる。** rouletteOrigin と同じ理由 — 倍率が違えば同じ
   * index が別の額を意味するので、畳み込み(mergeRoulette / worker の finishDrain)で
   * 激熱と通常が混ざると値の復元が壊れる。
   *
   * モニターはこの有無で (a) 優先クラス 'hot-roulette'、(b) 8 秒の導入動画、
   * (c) 倍率を戻さない確定、の3つを分岐する。
   */
  rouletteHotMult?: number;
  /**
   * kind='gift' でダイヤ帯域カットインが一致したときのクリップ id。
   * rouletteSegments と同じ「effect 1件で自己完結」の流儀 — モニターの設定は
   * 120秒ポーリング(CFG_POLL_MS)で古くなりうるため、演出パラメータは cfg からではなく
   * ここから読む。
   */
  fxBandClip?: string;
  /** kind='gift': カットインの再生時間(ms)。worker の凍結時間もこれと同期。 */
  fxDurationMs?: number;
  /**
   * kind='gift': カットイン中に流すBGM id。fxBandClip と同じ「effect 1件で
   * 自己完結」の流儀(bgm 無効・'off' のときは載らない)。音量だけは cfg の
   * giftBandFx.bgmVolume から読む(roulette-hit 等の既存前例と同じ)。
   */
  fxBandBgm?: string;
  /**
   * kind='gift': このカットインが全面カット(giftFullCut)由来である印。
   * モニターはこれを見て mp4 の焼き込み音声を鳴らす(帯域カットインは muted で、
   * 音は別ファイルの fxBandBgm 側)。fxBandClip と同じ「effect 1件で自己完結」の
   * 流儀 — モニターの cfg は 120 秒ポーリング(CFG_POLL_MS)で古くなりうるので判定し直させない。
   * 音量だけは cfg の giftFullCut.volume から読む(fxBandBgm の前例と同じ)。
   */
  fxFullCut?: true;
  /**
   * kind='gift': 同じ見た目をモニターが何回撃つか(連打ギフト)。省略/1 = 1回。
   * **値には一切影響しない** — amount/valueAfter/diamonds は連打全体を1回だけ表す。
   * worker が権威(設定の上限と凍結尺の上限で clamp 済み)。giftCount とは別物で、
   * giftCount=50 かつ fxRepeat=5 はありうる(前者は事実、後者は演出方針)。
   * 注意: この effect の見た目は atMs + (fxRepeat-1)*fxRepeatIntervalMs まで続く。
   */
  fxRepeat?: number;
  /**
   * kind='gift': fxRepeat の間隔(ms)。カットイン反復では使わない(尺そのものが間隔)。
   * fxDurationMs と同じく、凍結尺との同期のため effect 側に焼き込む。
   */
  fxRepeatIntervalMs?: number;
  /**
   * kind='boost-start'/'boost-end': タップブーストの倍率。rouletteSegments と同じ
   * 「effect 1件で自己完結」の流儀 — モニターの cfg は 120 秒ポーリング(CFG_POLL_MS)で古く
   * なりうるので、発動時点の設定を worker が焼き込む。
   */
  boostMultiplier?: number;
  /** kind='boost-end': 演出中に溜めたタップ回数。amount = -(tapCount × pressStep × multiplier)。 */
  boostTapCount?: number;
  /**
   * kind='press': この press が最終ゲートの完成(taps 到達による 1 減算)であること。
   * モニターのリング破裂演出の唯一のトリガー。蓄積中(1..taps-1)は effect 自体を
   * 積まないので、press effect の頻度は最終ゲート中むしろ 1/taps に下がる。
   */
  finalGate?: true;
  /**
   * kind='boost-start': タップウィンドウの期限(ms)。
   *
   * **これは「アーム期限切れで強制発動した場合」のフォールバックのタイムライン**
   * (atMs + BOOST_ARM_MAX_MS + 前置き + ウィンドウ)であって、実際の期限ではない。
   * 実際の期限はモニターが challenge.boostCue を撃った時刻から決まる(ChallengeState.boost)。
   *
   * この焼き方が **planBoostStart を1行も変えずにアームを成立させている**:
   * 判定の原点は endsAt - fxDurationMs = atMs + BOOST_ARM_MAX_MS なので、
   * アーム中は elapsed が負 → 常に full(= 起動カットインから満尺)。期限を過ぎると
   * elapsed が正になり従来どおり full → resume → skip へ連続的に劣化し、
   * その時点では worker も同じ時刻で自走しているので**この値がそのまま真になる**。
   * 一見の不整合に見えるが**直してはいけない** — 詳細は shared/boost-start.ts の冒頭。
   */
  boostEndsAtMs?: Ms;
  /**
   * kind='boost-start': 起動カットイン(咆哮)の尺(ms)。0 = この段なし
   * (プレーンモード発動・'off' 選択)。fxDurationMs には前置き+ウィンドウの
   * 総尺が入り、タップウィンドウは boostIntroMs + boostCountMs が明けてから。
   */
  boostIntroMs?: number;
  /** kind='boost-start': カウントダウン(3・2・1)の尺(ms)。0 = この段なし。 */
  boostCountMs?: number;
  /**
   * kind='boost-start': 各段のクリップ id(assets/fx/boost)。rouletteSegments と
   * 同じ「effect 1件で自己完結」の流儀 — モニターの cfg は 120 秒ポーリング(CFG_POLL_MS)で
   * 古くなりうるので、発動時点の選択を worker が焼き込む。欠損 = その段は暗幕。
   */
  boostIntroClip?: string;
  boostCountClip?: string;
  boostLoopClip?: string;
  /**
   * kind='boost-start'/'boost-end': 結果カットシーン(タップウィンドウ終了 →
   * 減算発表の前置き)の尺(ms)。0/欠損 = この段なし('off' 選択・プレーンモード・
   * 旧 worker 混在の保険)。発表シーケンスは boost-end 受信が起点なので end 側が
   * 本線 — start 側にも焼き込むのはテスト再生(自前で締める)のため。
   */
  boostResultMs?: number;
  /** boostResultMs > 0 のときのクリップ id(欠損 = 暗幕)。焼き込みの流儀は boostIntroClip と同じ。 */
  boostResultClip?: string;
  /**
   * kind='revolution-start'/'revolution-end': 革命のタップ倍率。boostMultiplier と
   * 同じ「effect 1件で自己完結」の流儀 — 発動時点の設定を worker が焼き込む。
   */
  revolutionMultiplier?: number;
  /**
   * kind='revolution-start': 窓の期限のフォールバックタイムライン
   * (atMs + REVOLUTION_ARM_MAX_MS + 前置き + 窓)。boostEndsAtMs と同じ規約で、
   * 実際の期限はモニターが challenge.revolutionCue を撃った時刻から決まる
   * (権威は ChallengeState.revolution.endsAtMs)。
   */
  revolutionEndsAtMs?: Ms;
  /**
   * kind='revolution-start': 導入全面カットの尺(ms)。0 = 演出なし(プレーン
   * モード発動 — モニター不在・reduced-motion)。boostIntroMs と同じ焼き込みの流儀。
   */
  revolutionIntroMs?: number;
  /** kind='revolution-start': 開始カウントダウン(5..1)の尺(ms)。0 = この段なし。 */
  revolutionCountMs?: number;
  /** kind='revolution-start'/'revolution-end': 窓の尺(ms)。バナー文言用の焼き込み。 */
  revolutionMs?: number;
  /**
   * kind='revolution-end': 窓の**総減算量**(タップ由来 + 反転いいね由来)。
   * クランプ後の実減少量の合計で、`amount` とは別物 — `amount` は 0 のままにする
   * (革命は窓中に即時反映済みで清算 lump が無く、ここを負にすると valueAfter の
   * 会計とモニターの据え置き計算が壊れる)。結果カットシーンの主役の数字。
   */
  revolutionDownTotal?: number;
  /**
   * kind='revolution-end': 窓中の実タップ数。**導入(11秒)の間に溜めた等倍タップと、
   * 窓に重なったフィーバー窓のタップは含まない** — worker が press の革命枝だけで
   * 数えているため(stats.presses の差分では両方が混ざる)。
   */
  revolutionTapCount?: number;
  /** kind='revolution-end': 反転いいねによる減算(ゲージ満タン + ストック満杯の合計)。 */
  revolutionLikeDown?: number;
  /**
   * kind='revolution-end': 結果カットシーン(全面動画+数字の発表)の尺(ms)。
   * 0/未指定 = 発表なし(バナーだけ)。boostResultMs と同じ焼き込みの流儀で、
   * **窓が自然満了 かつ 減算があった ときだけ**載る(機能OFF は逃げ道であって
   * 祝う場面ではない / stop・reset・達成はそもそも revolution-end を積まない)。
   */
  revolutionResultMs?: number;
  /**
   * kind='quiz-start': お題の盤面(表示順)。rouletteSegments と同じ「effect 1件で
   * 自己完結」の流儀 — モニターの cfg は 120 秒ポーリング(CFG_POLL_MS)で古くなり
   * うるので、回転演出は cfg からではなくここから読む。
   */
  quizPrompts?: string[];
  /** kind='quiz-start': 当選 index(quizPrompts 内)。worker が arm 時に抽選済み。 */
  quizPromptIndex?: number;
  /**
   * kind='quiz-start'/'quiz-end': 確定したお題の本文。quizPrompts[quizPromptIndex]
   * と同値だが、end 側と履歴ログが盤面なしで自己完結できるよう本文も焼き込む。
   */
  quizPrompt?: string;
  /**
   * kind='quiz-start': 導入全面カットの尺(ms)。0 = この段なし(素材 'off'・
   * プレーン発動)。revolutionIntroMs と同じ焼き込みの流儀。
   */
  quizIntroMs?: number;
  /** kind='quiz-start': 導入全面カットのクリップ id。quizIntroMs > 0 のときだけ載る。 */
  quizIntroClip?: string;
  /**
   * kind='quiz-start': 「お題発表準備」区間の尺(ms)。0 = この段なし。
   *
   * cfg ではなく effect から配るのは quizPrompts と同じ理由 — モニターの cfg は
   * 120 秒ポーリング(CFG_POLL_MS)で古くなりうるが、この値は worker が窓の開始
   * 時刻(quizCue の preMs)を決めるのに使った値と**同一でなければならない**。
   */
  quizPrepMs?: number;
  /** kind='quiz-start'/'quiz-end': 挑戦ウィンドウ(制限時間)の尺(ms)。 */
  quizDurationMs?: number;
  /** kind='quiz-start'/'quiz-end': 投票タイムの尺(ms)。 */
  quizVoteMs?: number;
  /**
   * kind='quiz-start'/'quiz-end': 判定の増減幅(設定値・正の数)。end の amount は
   * クランプ後の実増減で、こちらは「±5000」等のバナー文言用の焼き込み。
   */
  quizAmount?: number;
  /**
   * kind='quiz-start': 投票期限のフォールバックタイムライン
   * (atMs + QUIZ_ARM_MAX_MS + 前置き + 窓 + 投票)。boostEndsAtMs と同じ規約で、
   * 実際の期限はモニターが challenge.quizCue を撃った時刻から決まる
   * (権威は ChallengeState.quiz)。
   */
  quizEndsAtMs?: Ms;
  /**
   * kind='quiz-start': **数値到達で発動した**ときのしきい値。ギフト発動では載らない
   * (キーの有無が「どちらのトリガーで来たか」の唯一の印)。告知の文言は
   * shared/challenge.ts の quizThresholdText がここから組む — 発動時に焼き込むのは
   * quizAmount と同じ理由で、モニターの cfg ポーリング(120秒)が古くても文言がズレないため。
   */
  quizThreshold?: number;
  /**
   * kind='quiz-start': 数値到達の**告知の満了時刻(絶対 ms)**。quizThreshold と対で載る。
   *
   * ChallengeState.quiz.announceUntilMs が「告知を今出すか」を決めるのに対し、
   * こちらは**前置きを何ミリ秒待ってから始めるか**をモニターに決めさせるためのもの。
   * `max(0, quizAnnounceEndsAtMs - now)` が残りの告知尺で、
   * 演出が渋滞して告知を見せ切ったあとに前置きが始まる場合は 0 になる
   * (= 待たずに導入カットへ入る)。両方 worker の同じ瞬間から導出される。
   */
  quizAnnounceEndsAtMs?: Ms;
  /** kind='quiz-end': 「よかった」の票数(userId 重複排除済み)。 */
  quizGood?: number;
  /** kind='quiz-end': 「だめ」の票数(同上)。 */
  quizBad?: number;
  /**
   * kind='quiz-end': 結果発表カットシーンの尺(ms)。0/未指定 = 発表なし
   * (プレーン発動・モニター不在)。revolutionResultMs と同じ焼き込みの流儀。
   */
  quizResultMs?: number;
  /**
   * カットイン凍結の解除ドレインで同種の保留演出を1件に畳んだとき、元の件数
   * (2以上のときだけ載る)。amount 等は合算済み。ダッシュボードの履歴ログは
   * これを「×N」として1行にまとめる。省略 = 畳んでいない(1件そのまま)。
   */
  coalesced?: number;
  /**
   * kind='gift' かつ fanStamp: 合算バナーに並べる表示名(到着順・**userId で
   * 重複排除済み**)。先頭 FAN_STAMP_NAMES_MAX 件までしか載せない — 全員ぶん
   * 載せるとリングバッファと delta の IPC が人数に比例して膨らむ。
   * 「ほかN人」の N は fanStampPeople - 並べた件数で出す(唯一の実装は
   * shared/fan-stamp.ts の fanStampBannerParts)。**1人だけのときは載せない** —
   * 従来どおり nickname を使う経路に倒して既存の文言を1ドットも変えないため。
   */
  fanStampNames?: string[];
  /**
   * kind='gift' かつ fanStamp: 重複排除した**人数**。coalesced(メッセージ件数)
   * とも giftCount(総個数)とも別物 — 同じ人が3回押したら people=1 /
   * coalesced=3 / giftCount=3 になる。2以上のときだけ載る。
   */
  fanStampPeople?: number;
  /**
   * kind='follow' かつ coalesced≥2(凍結ドレインの合算)のとき: バナーに並べる
   * 表示名(到着順)。follow は seenFollowers で userId 重複排除済みなので
   * 1 effect = 1人 が保証され、人数は coalesced が兼ねる(fanStampPeople 相当の
   * 別フィールドは持たない)。上限・文字数予算は fan-stamp と共有
   * (FAN_STAMP_NAMES_MAX / FAN_STAMP_NAMES_BUDGET、唯一の実装は
   * shared/fan-stamp.ts の followBannerParts)。**1件のときは載せない** —
   * 従来どおり nickname 経路に倒して既存の文言を1ドットも変えないため。
   */
  followNames?: string[];
  /**
   * テスト再生(challenge.testEffect)由来。値・統計には影響しない演出だけの
   * effect — ダッシュボードの履歴ログはこれを積まない(演出とSEは再生する)。
   */
  test?: true;
  atMs: Ms;
}

/**
 * challenge.testEffect のパラメータ。設定画面の「▶ モニター」ボタンが、実際の
 * モニターウィンドウ上で演出を実演再生するために使う。値・統計・状態は一切
 * 変更しない — 演出(映像/SE)だけを本物の配信経路(effect ring buffer →
 * LiveDelta → playEffect)で流す。
 */
export type ChallengeTestEffectSpec =
  | { kind: 'press' }
  | { kind: 'follow' }
  | { kind: 'like' }
  /** ゲージ満タンの着弾演出(弾→7セグ)の実演。値は変えず着弾チェーンだけ試写する。 */
  | { kind: 'gauge-full' }
  | { kind: 'stock-full' }
  /** ruleId は設定UIの行ごとの ▶ 用。未指定なら最初の keyword 非空の規則で実演する。 */
  | { kind: 'comment'; ruleId?: string }
  /**
   * お助け機能(ファンスタンプ)。設定中の amountEach/flash をそのまま使って
   * 専用バナーを実演する — giftId が未設定でも(=まだ何にも一致しない状態でも)
   * 見た目だけは確認できるようにするため、トリガー一致は評価しない。
   */
  | {
      kind: 'fanStamp';
      /**
       * 複数人ぶんを1枚に畳んだ合算バナーを実演する。省略 = 従来どおり1人ぶん。
       * 合算は worker の窓(FAN_STAMP_FX_WINDOW_MS)でしか起きず設定画面からは
       * 再現できないので、見た目の確認用に印だけを焼き込んだ effect を作る。
       */
      multi?: true;
    }
  /**
   * タップブースト。設定中の multiplier/durationSec/clip をそのまま使って
   * カットイン+タップカウンタを実演する — fanStamp と同じくトリガー一致は
   * 評価しない(giftId 未設定でも見た目を確認できる)。値・凍結には触れない。
   */
  | {
      kind: 'tapBoost';
      /** 実演する行の id。未指定・対象行が消えていたら最初の有効な行で実演する。 */
      boostId?: string;
    }
  | {
      kind: 'gift';
      /** tier(小〜特大)判定とフラッシュ判定に使うダイヤ数。 */
      diamonds: number;
      /**
       * 帯演出行のテスト用。指定時はこのバンドのカットインを強制する(帯域一致は評価しない)。
       * **clip が 'off' の行(無演出)も渡せる** — カットイン抜きの見た目(ギフトカード・
       * 簡易演出・ジングル)だけを実演する。BGM は clip と一緒でないと載らない。
       */
      bandId?: string;
      /**
       * 全面カット行のテスト用。指定時はこの行のカットインを強制する(トリガー一致は評価しない)。
       * bandId と同じく **clip が 'off' の行も渡せる**(カットイン抜きの見た目だけを実演)。
       */
      fullCutId?: string;
      /** 連打反復のテスト用。未指定は1回。bandId 併用時は 1 に倒す(testEffect は凍結を張らないため)。 */
      repeat?: number;
    }
  /**
   * rouletteId は設定UIの行ごとの ▶ ボタン用。未指定なら最初の有効な行を回す。
   * pattern は終盤演出の指定(効果音スロットの試聴で 'kick' を狙い撃ちする)。
   * 未指定なら通常どおり抽選する。
   * join は入室ルーレット(cfg.joinRoulette)の試写 — rouletteId より優先。
   */
  | { kind: 'roulette'; rouletteId?: string; pattern?: RoulettePattern; join?: true }
  /**
   * お邪魔(タップ封じ)。設定中の durationSec/flash をそのまま使って告知バナーを
   * 実演する — fanStamp / tapBoost と同じくトリガー一致は評価しない。
   * **実際には封印しない**(testEffect の規約どおり値・統計・状態には触れない)。
   */
  | {
      kind: 'tapLock';
      /** 実演する行の id。未指定・対象行が消えていたら最初の有効な行で実演する。 */
      lockId?: string;
    }
  /**
   * 革命。設定中の multiplier/durationSec/flash をそのまま使って導入カットイン+
   * カウントダウン+告知バナーを実演する — fanStamp / tapBoost / tapLock と同じく
   * トリガー一致は評価しない。**実際には窓を開かない**(testEffect の規約どおり
   * 値・統計・状態には触れない)。
   */
  | {
      kind: 'revolution';
      /** 実演する行の id。未指定・対象行が消えていたら最初の有効な行で実演する。 */
      revolutionId?: string;
    }
  /**
   * お題ルーレット。設定中のお題リストから抽選し、前置き(回転→決定表示)だけを
   * 実演する — revolution と同じくトリガー一致は評価しない。**窓・投票・値には
   * 一切触れない**(testEffect の規約どおり)。
   */
  | {
      kind: 'quiz';
      /** 実演する行の id。未指定・対象行が消えていたら最初の有効な行で実演する。 */
      quizId?: string;
      /**
       * 数値到達トリガー行の id。指定すると告知(「○○を超えました!」)から始まる
       * **数値発動と同じ通し**で実演する。quizId より優先。
       */
      quizThresholdId?: string;
    }
  | { kind: 'achieved' }
  /**
   * 走行中の▶テスト実演を全種**中断**する(設定画面の「■ 停止」)。effect は積まず、
   * worker の実演窓を畳むだけ — DTO から revolution / quiz / boost キーが消えるので、
   * モニターは既存の state 駆動 abort(revActive / quizActive の false 遷移)で
   * 前置きも走行 HUD も片付ける。革命79秒・お題131秒(導入8+回転18+決定4+準備5+
   * 制限60+投票30+発表6)の長尺を流しっぱなしにしない逃げ道。
   */
  | { kind: 'stopTest' };

/**
 * challenge.boostCue のパラメータ。フィーバー(タップブースト)は worker が
 * ギフト着弾で**予約(arm)するだけ**で、タップ窓はモニターが起動カットインを
 * 実際に再生し始めた瞬間に開く — この型がその合図。
 *
 * なぜ必要か: worker の絶対時刻とモニターの実再生開始は最大 BOOST_ARM_MAX_MS
 * ずれる(舞台が他演出で塞がっている間 pendingBoosts に積まれるため)。
 * 従来はその差を「起動カットインを削る」ことで吸収していた(planBoostStart の
 * resume)。合図で窓の原点をモニター側に移すと、5 秒の咆哮が構造的に必ず満尺で出る。
 */
export type ChallengeBoostCue =
  | {
      /** 起動カットインの再生を開始した = タップ窓を開いてよい。 */
      action: 'start';
      /** 対象の boost-start effect の id。アーム中のものと一致しなければ無視される。 */
      effectId: number;
      /** モニターが再生を開始した時刻(Date.now())。worker 側で now を超えない範囲に丸める。 */
      startedAtMs: Ms;
      /** 実際に再生する前置きの尺(起動カットイン + カウントダウン)。 */
      preMs: number;
    }
  | {
      /** この予約は再生されない(キュー溢れ・開始不可・モニター再読み込み)。 */
      action: 'drop';
      /** 対象の boost-start effect の id。**0 = アーム中のものを種類を問わず解放**。 */
      effectId: number;
    };

/**
 * challenge.revolutionCue のパラメータ。ChallengeBoostCue の鏡像 — 革命も worker が
 * ギフト着弾で**予約(arm)するだけ**で、窓はモニターが導入カットインを実際に
 * 再生し始めた瞬間を原点に開く(導入6秒+カウントダウン5秒の後)。
 *
 * boostCue の拡張ではなく別型なのは、boostCue の冪等判定(effectId 照合・
 * 「0 = アーム中を全解放」)が armedBoost 専用に密結合しており、混ぜると 0 の
 * 意味が二重になるため。
 *
 * drop の挙動だけ boost と違う: **プレーン即発動へ倒す**(演出だけ諦めて窓は
 * 開く)。タップ倍率といいね反転はゲームの状態なので、モニターの都合
 * (キュー溢れ・再読み込み)で 699💎 のギフトが無かったことになってはいけない。
 */
export type ChallengeRevolutionCue =
  | {
      /** 導入カットインの再生を開始した = 前置き明けに窓を開いてよい。 */
      action: 'start';
      /** 対象の revolution-start effect の id。アーム中のものと一致しなければ無視される。 */
      effectId: number;
      /** モニターが再生を開始した時刻(Date.now())。worker 側で now を超えない範囲に丸める。 */
      startedAtMs: Ms;
      /** 実際に再生する前置きの尺(導入カットイン + カウントダウン)。 */
      preMs: number;
    }
  | {
      /** この予約の演出は再生されない → プレーン即発動へ倒す。 */
      action: 'drop';
      /** 対象の revolution-start effect の id。**0 = アーム中のものを種類を問わず対象**。 */
      effectId: number;
    };

/**
 * challenge.quizCue のパラメータ。ChallengeRevolutionCue の鏡像 — お題ルーレットも
 * worker がギフト着弾で**予約(arm)するだけ**で、窓はモニターが「発動時点で
 * 溜まっていた演出キューを消化し切った」あと前置き(導入カット+回転+決定表示)を
 * 実際に再生し始めた瞬間を原点に開く。
 *
 * 別型なのは revolutionCue と同じ理由(effectId 照合が armedQuiz 専用)。
 * drop も revolution と同じ判断: **プレーン即発動へ倒す**(演出だけ諦めて窓と
 * 投票は生かす — ±の判定はゲームの状態なので、モニターの都合でギフトが
 * 無かったことになってはいけない)。
 */
export type ChallengeQuizCue =
  | {
      /** 前置きの再生を開始した = 前置き明けに窓を開いてよい。 */
      action: 'start';
      /** 対象の quiz-start effect の id。アーム中のものと一致しなければ無視される。 */
      effectId: number;
      /** モニターが再生を開始した時刻(Date.now())。worker 側で now を超えない範囲に丸める。 */
      startedAtMs: Ms;
      /** 実際に再生する前置きの尺(導入カット + 回転 + 決定表示)。 */
      preMs: number;
    }
  | {
      /** この予約の演出は再生されない → プレーン即発動へ倒す。 */
      action: 'drop';
      /** 対象の quiz-start effect の id。**0 = アーム中のものを種類を問わず対象**。 */
      effectId: number;
    };

export interface ChallengeStats {
  presses: number;
  /** フォロー妨害の回数(同一ユーザーはチャレンジ1回につき1度だけ数える)。 */
  follows: number;
  /** ギフトによる減算量の合計(正の数で保持)。 */
  giftDown: number;
  /** ギフトによる加算量の合計。 */
  giftUp: number;
  /** いいねによる加算量の合計。 */
  likeUp: number;
  /** いいねストック満杯による加算量の合計(likeUp とは別枠 — likeUp = fills×step の検算を壊さない)。 */
  likeStockUp: number;
  /**
   * 革命(反転)中のいいね満タンによる**減算**量の合計(正の数で保持・クランプ後の
   * 実減少量)。likeUp に混ぜないのは likeUp = 加算 fills×step の検算を壊さないため
   * (likeStockUp と同じ判断)。クランプで満タン1回あたりの額が step 未満になりうる
   * ので、こちらには fills×step の検算は成り立たない。
   */
  likeDown: number;
  /** 革命(反転)中のいいねストック満杯による**減算**量の合計(規約は likeDown と同じ)。 */
  likeStockDown: number;
  /** 指定コメント(commentRules)による加算量の合計。 */
  commentUp: number;
  /** 入室ルーレットによる減算量の合計(正の数で保持)。ギフト由来ではないので giftDown とは別枠。 */
  joinDown: number;
  /** 入室ルーレットによる加算量の合計。 */
  joinUp: number;
  /** ルーレットの回転回数。ギフト・入室の両ルーレットを合算(増減量は giftUp/Down・joinUp/Down が持つ)。 */
  rouletteSpins: number;
  /** お題ルーレットの清算による減算量の合計(正の数で保持)。ギフト由来ではあるが清算は投票なので giftDown とは別枠。 */
  quizDown: number;
  /** お題ルーレットの清算による加算量の合計。 */
  quizUp: number;
}

/**
 * いいね進捗ゲージ。分母(every)と加算量(step)を同梱するのは、renderer の
 * 設定取得(120秒ポーリング(CFG_POLL_MS))とのスキューで分子と分母が食い違うのを防ぐため。
 */
export interface ChallengeLikeGauge {
  /** 端数(0 <= counter < every)。reset で 0 に戻る。 */
  counter: number;
  /** cfg.likeEvery のスナップショット(ゲージの分母)。 */
  every: number;
  /** 満タン1回あたりの加算量(cfg.likeStep)。 */
  step: number;
  /**
   * 満タン到達の累計回数。effect id と同じくエンジン生存期間を通して単調増加で
   * reset でも巻き戻さない — モニターは前回値との比較だけで「満タン到達」を検出
   * でき、counter の増減(閾値跨ぎで増えて見える・reset で減る)と混同しない。
   */
  fills: number;
  /**
   * 満タン到達のうち**革命(反転)中に着弾した**回数の累計。fills と同じ単調増加
   * 規約(reset でも巻き戻さない)で、常に downFills <= fills。
   *
   * モニターの据え置き会計は effect ではなく fills の差分×step から額を自前復元
   * している(加算前提の符号ハードコード)ため、符号をここで運ばないと反転中の
   * 着弾で据え置きが逆方向へ飛ぶ。1つの delta 内に反転前後の満タンが混在しても
   * `upUnits = (fills−prevFills) − (downFills−prevDownFills)` で正確に分解できる —
   * `dir: 'up'|'down'` のような排他フラグではこの境界 tick が復元できない。
   */
  downFills: number;
  /** null = ストックが無効(likeStockCount <= 0 または likeStockStep <= 0)。 */
  stock: ChallengeLikeStock | null;
}

/**
 * いいねストック。ゲージ満タンごとに1個点灯し、count 個で満杯 → step を加算して
 * 点灯数はリセット。count/step を同梱する理由は ChallengeLikeGauge と同じ
 * (120秒設定ポーリング(CFG_POLL_MS)とのスキュー防止)。
 */
export interface ChallengeLikeStock {
  /** 満杯に必要なストック数(cfg.likeStockCount)。 */
  count: number;
  /** 点灯中のストック数(0 <= filled < count)。reset で 0 に戻る。 */
  filled: number;
  /** 満杯1回あたりの加算量(cfg.likeStockStep)。 */
  step: number;
  /** 満杯到達の累計回数。likeGauge.fills と同じ単調増加規約(reset でも巻き戻さない)。 */
  fills: number;
  /** 満杯到達のうち革命(反転)中の回数の累計。規約は ChallengeLikeGauge.downFills と同じ。 */
  downFills: number;
  /**
   * 点灯スロットごとの「そのゲージ区間で最もいいねしたユーザー」。長さ === filled
   * (i 番目 = i 番目に点灯したドット)。モニターはこのアバターをドットに描く。
   */
  slots: Array<ChallengeStockSlot | null>;
  /**
   * 直近の満杯で消費された count 個ぶんのスナップショット。worker の満杯処理は
   * 1 delta 内で完結する(「全点灯 + 全スロット」の状態は配信されない)ため、
   * これが無いと満杯演出(charge/burst)中の最後のドットのアバターがモニターへ
   * 届かない。null = 満杯未経験。
   */
  lastFullSlots: ChallengeStockSlot[] | null;
}

/**
 * いいねストック1個ぶんの区間1位。同数はその区間で先にいいねした方が勝つ
 * (topRank の並びと同じ規約)。
 */
export interface ChallengeStockSlot {
  /** cfg.loadAvatars=false でも worker は載せる(表示可否は renderer の判断)。 */
  avatarUrl: string | null;
  /** 名前は表示しないが、デバッグとアクセシビリティのために持つ。 */
  nickname: string | null;
}

/**
 * ランキング1行。CLEAR リザルトの TOP5 と、モニター下部のライブ TOP3 で共用する。
 * 表示名は worker 側で確定させる — renderer 側に nickname/displayId の
 * フォールバックを持たせると、画面ごとに違う名前が出る。
 */
export interface ChallengeRankRow {
  userId: UserId;
  /** nickname → displayId → '' の順で確定済み。'' なら renderer が「名無し」を出す。 */
  nickname: string;
  /** cfg.loadAvatars=false でも worker は載せる(表示可否は renderer の判断)。 */
  avatarUrl: string | null;
  /** ラン中に受け取った 💎 の合計(GiftEvent.diamonds の素の合計。再計算はしない)。 */
  diamonds: number;
  /** ラン中のいいね件数の合計(LikeEvent.count はそのバッチ分の件数)。 */
  likes: number;
}

/**
 * CLEAR 時に凍結するリザルト。集計対象は「開始→達成」の1ランだけで、配信
 * セッション全体ではない。モニター下部の TOP3(ChallengeState.runRank)も同じ
 * runViewers を同じヘルパーで切り出したもので、TOP5 の先頭3件と必ず一致する。
 *
 * maybeAchieve() で一度だけ組み立ててキャッシュし、以後は同じ値を配る。
 * ChallengeState.result は status==='achieved' のときだけ載る — 走行中の
 * 2Hz delta にアバターURL 10 本を乗せないため。
 */
export interface ChallengeResult {
  /** 達成時刻(achievedMs と同値)。 */
  atMs: Ms;
  /** ランの開始時刻。所要時間の表示に使う。 */
  startedMs: Ms | null;
  /** ラン中にギフトかいいねを1件でも出したユニーク人数。 */
  participants: number;
  /** 💎降順・最大 CHALLENGE_RESULT_TOP_N 件。同数は先に参加した方が上。 */
  gifts: ChallengeRankRow[];
  /** いいね降順・最大 CHALLENGE_RESULT_TOP_N 件。並びの規約は gifts と同じ。 */
  likes: ChallengeRankRow[];
}

export interface ChallengeState {
  status: ChallengeStatus;
  /** 現在値。0 未満にはならない(クランプ)。上方向は無制限。 */
  value: number;
  /** 開始時点の初期値。プログレスバーの分母。 */
  initialValue: number;
  title: string;
  startedMs: Ms | null;
  /**
   * この worker 世代で**最初に** start した時刻(2026-08-21 ユーザー決定)。
   * startedMs と違い stop→start・reset でも張り直さない(worker 再起動でのみ消える)。
   * モニターの「起きている時間」(WakeRow)の錨はこちら — startedMs を錨にすると、
   * 起床から24時間を超えた徹夜配信でランを仕切り直した瞬間に wakeAnchorMs
   * (shared/time.ts)が丸1日前進し、表示が 25時間30分 → 1時間30分 へ巻き戻る。
   * 一度も start していなければキーごと省く(runRank と同じ流儀)。
   */
  firstStartedMs?: Ms;
  achievedMs: Ms | null;
  stats: ChallengeStats;
  /** 新しい順・最大 CHALLENGE_EFFECTS_MAX 件のリングバッファ。 */
  recentEffects: ChallengeEffect[];
  /** null = いいね妨害が無効(likeEvery <= 0 または likeStep <= 0)。 */
  likeGauge: ChallengeLikeGauge | null;
  /** CLEAR 時のリザルト。status!=='achieved' のときは常に null。 */
  result: ChallengeResult | null;
  /**
   * モニター下部のライブギフトランキング(💎降順・最大 CHALLENGE_MONITOR_TOP_N)。
   * 集計範囲は result と同じ「開始→達成」の1ランで、配信セッションの累計ではない —
   * だからチャレンジの開始/リセットでそのまま消える。
   * 該当者がいなければキーごと省く(2Hz の delta にアバターURL を無駄に載せない)。
   */
  runRank?: ChallengeRankRow[];
  /**
   * ダッシュボードの「ランキング表示」で出す全画面ランキング(ギフト/イイネ
   * TOP5)。**キーがあること自体が「表示中」の意味**で、参加者ゼロでも
   * 表示中なら空配列を載せる — runRank の「ゼロならキーごと省く」とは規約が
   * 違うので混同しないこと。非表示のときだけキーごと省く。
   *
   * result との違い: result は CLEAR 時に1度だけ組んで凍結する不変値。こちらは
   * 表示中の毎 delta で組み直すライブ値で、集計元(runViewers)と件数
   * (CHALLENGE_RESULT_TOP_N)は同じ。達成すると worker 側で自動的に畳まれ、
   * CLEAR リザルトへ引き継がれる。
   */
  rankBoard?: ChallengeResult;
  /**
   * ルーレット焦らし短縮(ライブトグル)。**キーの有無が ON/OFF**(rankBoard と
   * 同じ規約)。揮発 — settings.json には載せず、worker 再起動でオフに戻る。
   * 効果は planRouletteSpin の rush 入力(次のリールから fast で確定する。
   * 激熱確定・入室ルーレット・▶試写は対象外)。
   */
  rouletteRush?: true;
  /**
   * カットイン再生中のカウンタ凍結の期限(ms)。null = 凍結なし。
   * ダッシュボードの表示・テスト用 — モニターは自前でクリップ再生中を知っている。
   */
  fxFreezeUntilMs?: number | null;
  /**
   * 押下で**1タップずつ即時に減らした**累計。ラン中は単調増加、start/reset で 0。
   * 0 のときはキーごと省く(未定義 = 0)。
   *
   * モニターが「カットイン据え置き中でもタップぶんだけ数字を下げる」ために読む
   * (shared/fx-hold.ts)。押下は凍結を素通しして値へ即時に効くが、据え置き
   * (heldValue)は演出の開始時点で固定されるため、この累計の増分ぶんだけ
   * 据え置きも下げないと「押しても数字が動かない」に戻る。
   *
   * **ブースト清算(settleBoost)ぶんは含めない** — あちらはロールアップ発表で
   * 見せる契約なので、追従させると発表前に答えが漏れる。
   */
  pressDownTotal?: number;
  /**
   * タップブースト中だけ載る。press RPC は session.nudgeChallenge を通るので、
   * タップのたびに即時 delta で配られる(2Hz を待たない)— モニターのタップ
   * カウンタはこれが唯一のソース。pressStep/multiplier は発動時に焼き込んだ値
   * (ブースト中の設定変更で表示と適用がズレないように)。
   * startsAtMs = タップウィンドウの開始(起動カットイン明け)。それ以前の
   * タップは倍にならない(通常の凍結キュー行き)。
   * ▶テスト実演(testEffect 'tapBoost')のウィンドウ中も同じ形で載る — 計数だけ
   * worker が持ち(値・統計は動かない)、F9/PUSH/Space/モニターの全経路の
   * タップが実演のカウンタにも映る。
   */
  boost?: { tapCount: number; startsAtMs: Ms; endsAtMs: Ms; multiplier: number; pressStep: number } | null;
  /**
   * 凍結中(カットイン/ブースト再生中)にワーカーの保留キュー(pendingOps)で
   * 待っている「演出付きイベント」の予告。凍結中は effect 自体が recentEffects に
   * 載らないため、これが無いとモニターの演出ストック表示がその間だけ盲目になる。
   * 到着順・最大 CHALLENGE_FX_QUEUE_MAX 件。id はワーカー内の採番で、ドレインを
   * 跨いで安定(表示側の React key / スライドアニメの同一性に使う)。
   * 空のときはキーごと省く(2Hz の delta を太らせない)。
   */
  fxQueue?: ChallengeFxQueueItem[];
  /**
   * お邪魔(タップ封じ)中だけ載る。boost と同じ規約で**絶対時刻のみ**を配り、
   * 非封印時はキーごと省く(残り秒は受け手が endsAtMs から計算する)。
   *
   * blocked は弾いたタップの累計。press RPC は session.nudgeChallengeCoalesced を
   * 通るので、押すたびに即時 delta で配られる — 「押したのに効かない」手応えを
   * モニターへ届ける唯一の経路。
   */
  tapLock?: { startsAtMs: Ms; endsAtMs: Ms; blocked: number; nickname?: string; label?: string };
  /**
   * 革命の窓が開いている間だけ載る。boost / tapLock と同じ規約で**絶対時刻のみ**を
   * 配り、非アクティブ時はキーごと省く(残り秒は受け手が endsAtMs から計算する —
   * モニターの終了5秒前カウントダウンもこれが唯一のソース)。
   * multiplier は発動時に焼き込んだ値(窓中の設定変更で表示と適用がズレないように)。
   */
  revolution?: {
    startsAtMs: Ms;
    endsAtMs: Ms;
    multiplier: number;
    nickname?: string;
    label?: string;
    /**
     * ▶テスト実演の窓(testEffect 'revolution')。値・統計・凍結には触れない。
     * 表示コードは実発動と区別しなくてよい — 設定画面の「■ 停止」判定だけが見る。
     */
    test?: true;
  };
  /**
   * お題ルーレットが進行中(アーム〜投票締切)だけ載る。boost / tapLock / revolution と
   * 同じ規約で**絶対時刻のみ**を配り、非進行時はキーごと省く。
   *
   * armed=true の間(バリア〜cue 待ち)は窓の時刻が未確定なので 0 — モニターは
   * このキーの出現で BGM を予告へ切り替え、自分の演出キューが空になったら
   * challenge.quizCue を撃つ。commit 後は armed が落ちて絶対時刻が入る。
   *
   * good/bad は投票のライブ票数(2Hz delta)。blocked は tapLock.blocked と同じ
   * 「押したのに効かない」手応えの累計。goodLabel/badLabel は投票画面の表示語
   * (arm 時に焼き込み — 窓中の設定変更で表示と判定がズレないように)。
   * queued は連続発動の予約待ち件数(0 のときは省く)。
   */
  quiz?: {
    armed?: true;
    startsAtMs: Ms;
    windowEndsAtMs: Ms;
    voteEndsAtMs: Ms;
    prompt: string;
    good: number;
    bad: number;
    blocked: number;
    goodLabel: string;
    badLabel: string;
    nickname?: string;
    label?: string;
    queued?: number;
    /**
     * 数値到達の**告知オーバーレイ**の期限(絶対時刻)。載っている間だけモニターが
     * 「{announceThreshold} を超えました!」を全画面で出す。ギフト発動では載らない。
     *
     * この告知は**幕(ホールド)ではなく常設オーバーレイ** — ドレインキューにも
     * 舞台キューにも載らないので、演出が渋滞していても跨いだ瞬間に割り込んで出る
     * (2026-08-22 ユーザー決定「告知だけ先に割り込む」)。裏では溜まっていた
     * キューが流れ続け、モニターは告知が終わってから quizCue{start} を撃つ。
     */
    announceUntilMs?: Ms;
    /** 告知に出すしきい値。announceUntilMs と対で載る。 */
    announceThreshold?: number;
    /**
     * 告知の瞬間に鳴らす音(発動した `QuizThresholdRule.sound` の**焼き込み**)と、
     * その音量。**id ではなく値を載せる**のが要点 — モニター側の cfg は 120 秒
     * ポーリングで古くなりうるので、行を引き直させると「設定を変えた直後の
     * 1 発だけ古い音」になる(quizPrompts / quizPrepMs と同じ判断)。
     * `'slot'` はスロット流用、`'off'` は無音。
     */
    announceSound?: string;
    announceSoundVolume?: number;
    /**
     * ▶テスト実演の窓(testEffect 'quiz')。値・統計・凍結には触れず、投票は
     * ダミー。**armed とは併存しない**(実演はバリアを持たない — 入口は
     * quiz-start effect で、armed 監視に本物の cue を撃たせてはいけない)。
     */
    test?: true;
  };
  /**
   * 最終ゲート(ラスト◯◯モード)がアクティブな間だけ載る。taps = 現ゲートの蓄積
   * (0..needed-1)、needed = 1減算に必要なタップ数(設定のライブ値)。
   * 非アクティブ時・ブーストウィンドウ/起動カットイン中はキーごと省く
   * (boost / tapLock と同じ規約 — フィーバー中のタップはゲート免除)。
   *
   * press RPC の他窓への配信は nudgeChallengeCoalesced(80ms 間引き)なので、
   * 他窓では taps が最大数個まとめて進む — モニターのリングは stroke-dashoffset の
   * transition で追い付かせる。押下元の窓には press RPC の戻り値で毎タップ届く
   * (モニター自身も押下元)。
   */
  gauntlet?: { taps: number; needed: number };
}

/**
 * ワーカー保留キュー1件ぶんの演出予告(ChallengeState.fxQueue の要素)。
 * follow は「カットイン級」ではないが予告に載せる — 凍結中のフォローが
 * 予告ゼロだと配信者から「フォローされたのに無反応」に見えるため。
 */
export interface ChallengeFxQueueItem {
  /** ワーカー内の単調採番。ドレインまで不変 — 表示側の同一性キー。 */
  id: number;
  kind: 'band' | 'boost' | 'roulette' | 'follow' | 'revolution' | 'quiz';
  /** 行為者(viewer.nickname ?? displayId)。 */
  nickname?: string;
  /**
   * **お題バリア(quizDeferredOps)で清算待ちの予告**。表示上は他の待ちと同じだが、
   * モニターの armed 監視(「発動時点で溜まっていたキューが空になるのを待つ」)は
   * これを**数えてはいけない** — quizDeferredOps は清算まで吐き出されないので、
   * アーム待ちのあいだに演出付きギフトが1件でも届くと待ちが構造的に永久化し、
   * 前置きが一度も再生されないままアーム期限(120秒)で強制発動する。
   * 立てるのは get() の組み立て時だけ(保持している fx オブジェクトは汚さない —
   * 清算で pendingOps へ移送されたあとも印が残ると、次のお題の待ちが狂う)。
   */
  barrier?: true;
  /**
   * 連続ぶんの総回数。省略 = 1。**種別で単位が違う**(FxStockItem.count と同じ規約):
   * - roulette: **抽選回数**(実際に回るリール本数ではない)。ただし
   *   giftRepeatFx.rouletteEnabled = false で本数が1に絞られる設定では 1。
   *   凍結明けにこの予告行がモニターのキュー行へ入れ替わっても ×N が飛ばないよう、
   *   rouletteStockCount と同じ規約に揃えてある。入室ルーレットは常に1抽選なので載らない
   * - band: カットインの反復回数
   * - follow: 1 effect = 1人なので載らない
   */
  count?: number;
}

/**
 * ダッシュボードの履歴ログ1行。
 *
 * recentEffects は worker 側の12件リングバッファで、目を離すと押し出されて消える。
 * renderer は effect を watermark で拾って**こちらに積み直す** — 「残数がなぜ動いたか」を
 * 後から辿れるのはこの配列だけ(worker にも DB にも履歴は無い)。
 *
 * PUSH は連打で洪水になるので、連続する press は1行に畳んで count に回数を持つ。
 */
export interface ChallengeLogEntry {
  /** 先頭 effect の id。React の key 兼、畳み込み済みかの判定に使う。 */
  id: number;
  kind: ChallengeEffect['kind'];
  /** 畳み込み時は最新の effect の時刻。 */
  atMs: Ms;
  /** 畳み込み時は合計。符号の規約は ChallengeEffect.amount と同じ。 */
  amount: number;
  /** 畳み込み時は最新。worker が確定させた値なので renderer では計算しない。 */
  valueAfter: number;
  /** press を畳み込んだ回数。2 以上のときだけ入る。 */
  count?: number;
  nickname?: string;
  giftName?: string;
  giftCount?: number;
  giftIconUrl?: string;
  diamonds?: number;
  /** kind='roulette': どのルーレットが回ったか(設定の label)。複数登録できるため。 */
  rouletteLabel?: string;
  /**
   * 取り込み時点の likeGauge スナップショット。「いいね300件で+3」と書くために要る —
   * 表示時に現在の設定を読むと、途中で設定を変えたとき過去の行まで書き換わる。
   */
  likeEvery?: number;
  likeStep?: number;
  /** kind='comment': 一致した規則のキーワード(effect からそのまま引き継ぐ)。 */
  commentKeyword?: string;
  /** kind='boost-start'/'boost-end': ブースト倍率(effect からそのまま引き継ぐ)。 */
  boostMultiplier?: number;
  /** kind='boost-end': 溜めたタップ回数(effect からそのまま引き継ぐ)。 */
  boostTapCount?: number;
  /**
   * kind='tap-lock': 封印の尺(ms)。likeEvery/likeStep と同じ理由で effect から
   * 引き継ぐ — 表示時に設定を読み直すと、秒数を変えた瞬間に過去のログまで書き換わる。
   */
  tapLockMs?: number;
  /** kind='revolution-start'/'revolution-end': 倍率(effect からそのまま引き継ぐ)。 */
  revolutionMultiplier?: number;
  /** kind='revolution-start'/'revolution-end': 窓の尺 ms(tapLockMs と同じ規約)。 */
  revolutionMs?: number;
  /** kind='revolution-end': 窓の総減算量(effect からそのまま引き継ぐ)。 */
  revolutionDownTotal?: number;
  /** kind='revolution-end': 窓中の実タップ数(同上)。 */
  revolutionTapCount?: number;
  /** kind='revolution-end': 反転いいねによる減算(同上)。 */
  revolutionLikeDown?: number;
  /** kind='quiz-start'/'quiz-end': 確定したお題の本文(effect からそのまま引き継ぐ)。 */
  quizPrompt?: string;
  /** kind='quiz-end': 「よかった」の票数(effect からそのまま引き継ぐ)。 */
  quizGood?: number;
  /** kind='quiz-end': 「だめ」の票数(同上)。 */
  quizBad?: number;
}

// ── Settings / export ────────────────────────────────────────────────────────

/**
 * 表示倍率の既定値。ダッシュボードは 13px 基準の高密度デザインなので、
 * 「文字が小さい」への恒久対応として既定を 200% に置く。
 * Ctrl+0 / ％クリックのリセット先もこの値(main と renderer で共有)。
 */
export const DEFAULT_ZOOM_FACTOR = 2;

/**
 * 設定スキーマの世代。既定値の変更を既存の settings.json へ一度だけ反映するための印で、
 * 上げるのは「保存済みの値を書き換える必要がある」ときだけ(形の追加は validate が吸収する)。
 * 1: 妨害スロットの効果音を専用音へ(migrateChallengeSeSounds)。
 * 2: ルーレットの回転サウンドを刷新 — 回転中BGMを既定オフ、回転ループ音を
 *    spin-reel2、確定音を reel-confirm へ(migrateChallengeSeSounds)。
 * 3: 全面カットの既定行を 2 → 42 へ拡張(migrateChallengeGiftFullCut)。
 *    足すのは v3 で新しく増えた40行だけで、バラ/ローザや利用者が編集した行には触らない。
 * 4: 全面カットのトリガーを実データへ修復(migrateChallengeGiftFullCutTriggers)。
 *    v3 はギフト名を日本語で入れていたが、配信イベントの giftName は表示言語に関係なく
 *    英語で届くため42行中40行が発火していなかった。判明した giftId と英語名へ寄せ直す。
 * 5: チャレンジ演出9スロット(ゲージ満タン/ストック満杯/コメント妨害/お助け/
 *    ルーレットのキックと確定/ブーストのタップ開始と着弾/達成)の効果音を、
 *    Kenney の汎用ライブラリ音から演出ごとの専用録りへ差し替え
 *    (migrateChallengeSeSounds)。寄せるのは旧既定のままだったスロットだけ。
 * 6: 全面カットのトリガーを実データへ再修復(migrateChallengeGiftFullCutTriggersV5)。
 *    v5 が推定で書いた値のうち実配信で一度も当たらなかった行(ミニ花火)を、
 *    受信で確認できた giftId / giftName へ寄せ直す。
 * 7: タップブーストを複数ルール化し、コーギー(gift 6267)の行を1回だけ追加
 *    (migrateChallengeTapBoostCorgi)。単一→配列の入れ替え自体は validateTapBoost が
 *    吸収するので世代印は不要だが、**既存の保存済み設定へ新しい行を配る**のは
 *    validate ではできない(UI の cfg.set も通るので、消した行がその場で復活する)。
 * 8: お助けのスタンプトリガーの既定行15件を追加(migrateChallengeStampTriggers)。
 *    v0.7.7 までの既定は空配列だったので、stampTriggers キーを既に持っている
 *    保存済み設定には既定の変更が届かない。配るのは STAMP_TRIGGER_RULES_V8 だけ。
 * 9: タップブーストの既定行を黒豹(723500・限定ギフトで実質受け取れない)から
 *    ねば〜る君(14463)へ**差し替え**(migrateChallengeTapBoostNebaaru)。
 *    足す移行ではなく寄せ替えなので、旧既定と完全に同じ boost-1 行だけを触り、
 *    倍率・ウィンドウ秒・並び順・ユーザーが編集した行には一切触れない。
 *    黒豹のクリップはカタログに残るので設定画面から選び直せる。
 * 10: 激熱確定の DJメガネ行(gift 11583・倍率 ×10・盤面は全マス 500)を**まだ無ければ
 *    1回だけ**追加(migrateChallengeRouletteDjGlasses)。roulettes キーは既存の保存済み
 *    設定が必ず持っているので、既定(DEFAULT_ROULETTES / 同梱 challenge-default.json)を
 *    直しても届かない — v7 のコーギー行と同じ「足す移行」。
 * 11: お題ルーレットの導入を専用素材へ寄せ替え(migrateChallengeQuizIntro)。
 *    v0.13.0 が配った quiz.introClip: 'off' は「導入は要らない」ではなく
 *    「専用素材がまだ無い」という意味だったので、素材の投入に合わせて
 *    **'off' ちょうどの設定だけ** QUIZ_INTRO_SELF へ引き上げる。v9 の
 *    ねば〜る君と同じ寄せ替えで、cut-* を自分で指名していた人には触らない。
 * 12: お題ルーレットのお題リストを実運用の28件へ寄せ替え(migrateChallengeQuizPrompts)。
 *    v0.13.0 が配った prompts 1件は実運用のお題ではなく「空だと ▶実演 すらできない」
 *    ための**例**だった。quiz.prompts キーは v0.13.0 以降どの保存済み設定も持っていて
 *    validateQuiz の欠損フォールバックを通らないので、既定を直しても既存ユーザーには
 *    届かない — v10 の DJメガネと同じ「移行だけが唯一の経路」。ただし配るのは
 *    **旧既定の1件ちょうど**の設定に限る。自分でお題を編集した人・全部消した人
 *    (prompts: [])のリストは、v9 のねば〜る君と同じ流儀で一切触らない。
 * 13: 激熱確定のユニコーン行(gift 12453・盤面は全マス 2499)とバニーDJ行
 *    (gift 437679・盤面は全マス 1200)を**まだ無ければ1回だけ**追加
 *    (migrateChallengeRouletteHotGifts)。v10 の DJメガネと同じ「足す移行」で、
 *    roulettes キーは保存済み設定が必ず持っているので既定を直しても届かない。
 *    2行あるので **ROULETTES_MAX の残数は行ごとに確認する**(1回だけ見て2行
 *    push すると上限を超える)。倍率は両行とも確率抽選(×5 60% / ×10 30% / ×20 10%)。
 * 14: お題ルーレットの区間BGM を実素材へ寄せ替え(migrateChallengeQuizBgm)。
 *    区間①(発動〜導入の全面カット〜回転)を bgm-quiz-chase、区間⑤(コメント受付)を
 *    bgm-quiz-think にする。**この段だけは現在値を見ずに上書きする** — 他の寄せ替えは
 *    「旧既定ちょうど」を条件にするが、実運用の settings.json は bgm:'off' /
 *    bgmVolume:0(お題の音が丸ごと無音)に倒してあり、その条件では届かないため
 *    (2026-08-22 ユーザー決定)。触るのは quiz の4キーだけで、音量は 0 のときだけ
 *    既定 70 へ戻す(自分で絞っている人の値は残す)。
 * 15: お題ルーレットの「お題考え時(挑戦ウィンドウ)」の区間BGM を keep → off へ
 *    寄せ替え(migrateChallengeQuizThinkBgm)。v14 で区間①に実曲を入れた結果、keep の
 *    連鎖で導入の全面カットから挑戦中までBGMが鳴り続け、「回転が終わって挑戦の時間に
 *    なった」区切りが音で分からなくなったため(2026-08-22 ユーザー決定)。v14 と違い
 *    **keep ちょうどのときだけ**触る — 自分で曲を選んだ人の設定は残す。
 */
export const SETTINGS_VERSION = 15;

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
  /** ダッシュボード3カラムの並び。未設定・壊れた値は既定順へフォールバック(ワーカー再起動不要)。 */
  dashLayout?: DashPaneKey[];
  /** 適用済みの設定世代。未設定(= SETTINGS_VERSION 導入前の settings.json)は 0 とみなす。 */
  settingsVersion?: number;
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
  /**
   * worker イベントループの最大停止時間(ms)。読み出しリセット式なので
   * 「前回どこかが q.diagnostics を読んでから今回まで」の区間の最大値。
   */
  loopLagMaxMs: number;
  /**
   * 取り込み(Batcher)の統計スナップショット。maxFlushMs が跳ねていたら worker の
   * 停止は DB フラッシュ(= ディスク)が犯人 — loopLagMaxMs と突き合わせて読む。
   * loopLagMaxMs と違い**累積値**(読み出しでリセットされない)。
   */
  ingest: {
    flushes: number;
    applied: number;
    duplicates: number;
    dropped: number;
    errors: number;
    maxFlushMs: number;
    queueHigh: number;
    queue: number;
    capture: number;
  };
  quota: QuotaInfo | null;
  gitSha: string;
  buildTime: string;
  appVersion: string;
}
