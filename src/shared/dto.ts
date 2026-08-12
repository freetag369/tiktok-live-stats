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
}

/**
 * ギフト → 演出クリップの割り当て。上から順に評価し、最初に canonical が
 * 一致した1件を使う。一致が無ければダイヤ数の tier クリップに落ちる。
 */
export interface ChallengeGiftClip {
  id: string;
  /** normalize 済みの canonical('dragon' 等、gift-aliases 由来)。 */
  canonical: string;
  /** クリップ id(renderer/lib/fx.ts の FX_CLIPS)または 'off'(この規則では出さない)。 */
  clip: string;
  /**
   * 簡易演出 id(shared/challenge.ts の CHALLENGE_MINI_IDS)または 'off'。
   * 映像クリップとは独立 — 両方出す/片方だけ、を1行で決められる。
   */
  mini: string;
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
 * ダイヤ帯域カットインの設定。バンド一致時は giftClips(canonical別)より優先して
 * 全画面カットインを再生し、再生中はカウンタを凍結する(worker の fxFreeze)。
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
  giftRules: ChallengeGiftRule[];
  /** どの規則にも一致しないギフトの既定動作。null なら無視。 */
  giftDefault: { mode: 'fixed' | 'perDiamond'; amount: number } | null;
  /** ギフトルーレット。トリガー一致時は giftRules/giftDefault より優先。 */
  roulette: ChallengeRouletteConfig;
  /** diamonds がこの値以上のギフトは規則に関係なく照明フラッシュ。null で無効。 */
  flashMinDiamonds: number | null;
  /** グローバルホットキー(Electron accelerator)。'' で無効。 */
  hotkey: string;
  /** モニターを出すディスプレイ。null = 自動(最後の非プライマリ)。 */
  monitorDisplayId: number | null;
  /** true = 全画面にせず通常のウィンドウ(枠付き・移動/リサイズ可)で出す。 */
  monitorWindowed: boolean;
  /** 残数がこの値以下になるとモニターの数字が点滅する。 */
  lowThreshold: number;
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
  /** ギフト/達成の演出クリップ(映像)をモニターに重ねる。 */
  fxClipsEnabled: boolean;
  /** ギフト → クリップの割り当て。空なら全ギフトが tier クリップになる。 */
  giftClips: ChallengeGiftClip[];
  /** 簡易演出(素材を持たない SVG+CSS の軽量アニメ)をモニターに出す。 */
  miniFxEnabled: boolean;
  /**
   * 演出スロットごとの簡易演出の割り当て。値は CHALLENGE_MINI_IDS の id
   * または 'off'(出さない)。ギフトは giftClips 側の mini が優先される。
   */
  miniFx: Record<ChallengeSeSlot, string>;
  /** ダイヤ帯域カットイン。一致時は giftClips より優先(matchGiftBand)。 */
  giftBandFx: GiftBandFxConfig;
}

/** 効果音を割り当てられる演出スロット。gift は演出 tier(ダイヤ数)で分かれる。 */
export type ChallengeSeSlot =
  | 'press'
  | 'follow'
  | 'like'
  | 'gauge-full'
  | 'stock-full'
  | 'gift-t1'
  | 'gift-t2'
  | 'gift-t3'
  | 'gift-t4'
  | 'roulette'
  | 'roulette-hit'
  | 'achieved';

export type ChallengeStatus = 'idle' | 'running' | 'achieved';

/**
 * モニターが再生する演出1件。id はエンジン生存期間を通して単調増加 —
 * 受信側は「最後に再生した id」だけ覚え、それより新しい項目を再生すれば
 * 冪等になる。reset で配列は消えるが id カウンタは巻き戻さない。
 */
export interface ChallengeEffect {
  id: number;
  /** 'like' は1秒窓で合算して1件にまとめるため nickname を持たない。 */
  kind: 'press' | 'follow' | 'like' | 'stock-full' | 'gift' | 'roulette' | 'achieved';
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
   * kind='roulette': 盤面(表示順の出目の絶対値リスト)。モニターの設定取得は
   * 30秒ポーリングで古くなりうるため、演出は cfg からではなくここから盤面を
   * 読む — effect 1件で自己完結させる。
   */
  rouletteSegments?: number[];
  /** kind='roulette': 当選 index(rouletteSegments 内)。amount は符号適用後の実増減量。 */
  rouletteIndex?: number;
  /**
   * kind='gift' でダイヤ帯域カットインが一致したときのクリップ id。
   * rouletteSegments と同じ「effect 1件で自己完結」の流儀 — モニターの設定は
   * 30秒ポーリングで古くなりうるため、演出パラメータは cfg からではなく
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
  /** いいねによる加算量の合計。 */
  likeUp: number;
  /** いいねストック満杯による加算量の合計(likeUp とは別枠 — likeUp = fills×step の検算を壊さない)。 */
  likeStockUp: number;
  /** ルーレットの回転回数。増減量の合計は giftDown/giftUp に合算する(ギフト起因のため)。 */
  rouletteSpins: number;
}

/**
 * いいね進捗ゲージ。分母(every)と加算量(step)を同梱するのは、renderer の
 * 設定取得(30秒ポーリング)とのスキューで分子と分母が食い違うのを防ぐため。
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
  /** null = ストックが無効(likeStockCount <= 0 または likeStockStep <= 0)。 */
  stock: ChallengeLikeStock | null;
}

/**
 * いいねストック。ゲージ満タンごとに1個点灯し、count 個で満杯 → step を加算して
 * 点灯数はリセット。count/step を同梱する理由は ChallengeLikeGauge と同じ
 * (30秒設定ポーリングとのスキュー防止)。
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
}

/**
 * CLEAR リザルトのランキング1行。表示名は worker 側で確定させる —
 * renderer 側に nickname/displayId のフォールバックを持たせると、画面ごとに
 * 違う名前が出る。
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
 * セッション全体ではない(モニター下部の TOP3 はセッション全体 — 別物)。
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
  achievedMs: Ms | null;
  stats: ChallengeStats;
  /** 新しい順・最大 CHALLENGE_EFFECTS_MAX 件のリングバッファ。 */
  recentEffects: ChallengeEffect[];
  /** null = いいね妨害が無効(likeEvery <= 0 または likeStep <= 0)。 */
  likeGauge: ChallengeLikeGauge | null;
  /** CLEAR 時のリザルト。status!=='achieved' のときは常に null。 */
  result: ChallengeResult | null;
  /**
   * カットイン再生中のカウンタ凍結の期限(ms)。null = 凍結なし。
   * ダッシュボードの表示・テスト用 — モニターは自前でクリップ再生中を知っている。
   */
  fxFreezeUntilMs?: number | null;
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
  /**
   * 取り込み時点の likeGauge スナップショット。「いいね300件で+3」と書くために要る —
   * 表示時に現在の設定を読むと、途中で設定を変えたとき過去の行まで書き換わる。
   */
  likeEvery?: number;
  likeStep?: number;
}

// ── Settings / export ────────────────────────────────────────────────────────

/**
 * 表示倍率の既定値。ダッシュボードは 13px 基準の高密度デザインなので、
 * 「文字が小さい」への恒久対応として既定を 200% に置く。
 * Ctrl+0 / ％クリックのリセット先もこの値(main と renderer で共有)。
 */
export const DEFAULT_ZOOM_FACTOR = 2;

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
