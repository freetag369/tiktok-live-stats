import type { NormalizedEvent, NormViewer, UserId } from '@shared/events';
import type { StampTriggerMatch } from '@shared/challenge';
import type {
  ChallengeBoostCue,
  ChallengeConfig,
  ChallengeEffect,
  ChallengeFxQueueItem,
  ChallengeRankRow,
  ChallengeResult,
  ChallengeState,
  ChallengeStats,
  ChallengeStatus,
  ChallengeStockSlot,
  ChallengeTestEffectSpec,
  RoulettePattern,
  TapBoostRule,
  TapLockRule,
} from '@shared/dto';
import {
  CHALLENGE_EFFECTS_MAX,
  CHALLENGE_FX_QUEUE_MAX,
  CHALLENGE_MONITOR_TOP_N,
  CHALLENGE_RESULT_TOP_N,
  BOOST_ARM_MAX_MS,
  BOOST_COMMIT_MAX_LAG_MS,
  GIFT_FX_FREEZE_MARGIN_MS,
  GIFT_FX_FREEZE_MAX_MS,
  GIFT_FX_PENDING_OPS_CRITICAL_EXTRA,
  GIFT_FX_PENDING_OPS_MAX,
  JOIN_ROULETTE_MIN_GAP_MS,
  LIKE_FX_WINDOW_MS,
  ROULETTE_DRAWS_MAX,
  ROULETTE_HOT_PATTERNS,
  rouletteHotMultiplier,
  drawRouletteIndex,
  rouletteRarity,
  giftFxRepeat,
  rouletteBoardKey,
  rouletteDrawCount,
  rouletteReelCount,
  matchCommentRule,
  matchFanStamp,
  matchGiftBand,
  matchGiftFullCut,
  matchGiftRule,
  matchRoulette,
  matchStampTriggers,
  matchTapBoost,
  matchTapLock,
  tapBoostActivationCount,
  tapLockActivationCount,
  TAP_LOCK_MAX_MS,
  TAP_BOOST_COUNT_MS,
  TAP_BOOST_INTRO_MS,
} from '@shared/challenge';
import { BOOST_SETTLE_BUDGET_MS, TAP_BOOST_RESULT_MS } from '@shared/boost-settle';
import { clampFutureMs } from '@shared/time';
import { drawRoulettePattern } from '@shared/roulette-fx';
import { BoundedSet } from '@shared/bounded-set';
import {
  FAN_STAMP_FX_WINDOW_MS,
  FAN_STAMP_NAMES_MAX,
  mergeFanStampName,
} from '@shared/fan-stamp';

/** runViewers の値。DTO(ChallengeRankRow)と違い、表示名は未確定のまま持つ。 */
interface RunParticipant {
  userId: UserId;
  nickname?: string;
  displayId?: string;
  avatarUrl?: string;
  diamonds: number;
  likes: number;
}

/**
 * お助け(ファンスタンプ)合算窓のアキュムレータ。**見た目と音の材料だけ**を持つ —
 * 値・統計・ランキングはイベントごとに適用済みで、ここには一切依存しない。
 *
 * 配列で effect を溜めずスカラに畳むのは fx-floats.ts の PendingFloat と同じ理由:
 * 「窓内に何件来ても flush で出るバナーは必ず1枚」を構造で担保するため。
 */
/**
 * お助け合算経路(accumulateFanStampFx / fanStampCoalesceOp)の入力。gift イベントの
 * 部分型 — スタンプ(サブスクエモート)トリガーも同じ経路を通すために、実際に
 * 読むフィールドだけへ絞ってある(スタンプは repeatCount=一致個数・diamonds=0)。
 */
interface FanStampFxSource {
  viewer: NormViewer;
  repeatCount: number;
  diamonds: number;
}

interface FanStampAcc {
  /** 畳んだ合計増減(バナーの ±N)。 */
  amount: number;
  /** 畳んだメッセージ件数(履歴ログの ×N = ChallengeEffect.coalesced)。 */
  count: number;
  /** 畳んだ総個数(各イベントの repeatCount の総和 = バナーの ×N)。 */
  giftCount: number;
  /** 畳んだ総ダイヤ数。 */
  diamonds: number;
  /** 1件でも flash 指定があれば照明を出す(finishDrain の merge と同じ規約)。 */
  flash: boolean;
  /** バナーに並べる表示名(最大 FAN_STAMP_NAMES_MAX 件)。 */
  names: string[];
  /** 重複排除した人数。 */
  people: number;
  /** 人数の重複排除キー。nickname は空や変化がありうるので **userId** で持つ。 */
  seen: BoundedSet<UserId>;
}

/**
 * 参加者マップの上限。長時間配信で数万ユニークのいいねが来てもワーカーの
 * メモリが伸び続けないよう、HARD 到達で上位だけ残して間引く。表示は TOP5 なので
 * KEEP は十分に安全側(間引きの発火は約 3600 ユニークごと)。
 */
const RUN_VIEWERS_KEEP = 200;
const RUN_VIEWERS_HARD = 4000;

/**
 * カウントダウンチャレンジの状態機械。
 *
 * onEvent の第5の独立した消費者(batcher/agg/feed/alerts と並列)で、DB には
 * 一切書かない — 状態はワーカープロセスのメモリのみ。寿命もワーカーと同じで、
 * SessionManager.reset()(接続のたびに走る)では消えない。配信の手動再接続で
 * 進行中のチャレンジが飛ぶと配信事故になるため。
 */
export class ChallengeEngine {
  private status: ChallengeStatus = 'idle';
  private value: number;
  private startedMs: number | null = null;
  private achievedMs: number | null = null;
  private stats: ChallengeStats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, joinDown: 0, joinUp: 0, rouletteSpins: 0 };
  private recentEffects: ChallengeEffect[] = [];
  /**
   * get() が返す recentEffects のコピーのキャッシュ。press 連打(フィーバー中は
   * 1タップ = get() 2回: RPC の戻り値 + nudge の delta)のたびに最大32件を
   * ディープコピーし直すのは無駄が大きい — ring が変わったときだけ作り直す。
   * 共有しても安全: worker→main は postMessage の structuredClone を通り、
   * worker 内は push 後の effect を書き換えない(全 effect が焼き込み自己完結)。
   */
  private effectsSnapshot: ChallengeEffect[] | null = null;
  /** reset でも巻き戻さない — モニターの冪等再生(既再生 id 比較)が壊れるため。 */
  private nextEffectId = 1;
  /**
   * フォロー妨害はチャレンジ1回につきユーザー1度だけ(付け外しスパム対策)。
   * 上限つき — 耐久ランでフォロワー数に比例して育たないように(溢れの副作用は
   * 5万人超の後に最初期のフォロワーの付け外しがもう一度効くだけ)。
   */
  private seenFollowers = new BoundedSet<UserId>(50_000);
  /**
   * フォロー診断の要約カウンタ(60秒に1行へ畳む)。適用は1行/件で出すが、
   * 重複スキップと followStep<=0 は実配信で洪水になる(実測 455件/h 級)ので
   * 件数だけ数えて次の到達時にまとめて出す。start/reset で seenFollowers と
   * 一緒にクリアする。
   */
  private followDupCount = 0;
  private followDupLogMs: number | null = null;
  private followStep0Count = 0;
  private followStep0LogMs: number | null = null;
  /**
   * 入室ルーレットはチャレンジ1回につきユーザー1度だけ(再入室・再接続バック
   * ログの再配信対策)。target が first/all のどちらでも適用する。容量は
   * seenFollowers と同じ判断(溢れの副作用も同じ — 最初期の入室者がもう一度効くだけ)。
   */
  private seenJoiners = new BoundedSet<UserId>(50_000);
  /**
   * 直近の入室ルーレット発火時刻。JOIN_ROULETTE_MIN_GAP_MS 未満の連続入室は
   * 値ごと黙って捨てる(レイド対策 — shared/challenge.ts の定数コメント参照)。
   */
  private joinRouletteLastMs = 0;
  /**
   * ギフトの msgId 重複排除。手動での停止→再接続は processInitialData: true で
   * バックログを再配信するため(adapter.ts 参照)、これが無いと直前のギフトが
   * 二重適用される。start/reset でも消さない — 再開直後に再配信された古い
   * ギフトは新しいランにも数えてはいけない。
   */
  private seenGiftMsgIds = new BoundedSet<string>(512);
  /** like の msgId 重複排除(gift と同じ再接続バックログ対策。高頻度なので容量大きめ)。 */
  private seenLikeMsgIds = new BoundedSet<string>(1024);
  /** comment の msgId 重複排除(like と同じ再接続バックログ対策)。 */
  private seenCommentMsgIds = new BoundedSet<string>(1024);
  /** emote(WebcastEmoteChatMessage)の msgId 重複排除(comment と同じ対策)。 */
  private seenEmoteMsgIds = new BoundedSet<string>(512);
  /**
   * ラン中の参加者集計。CLEAR リザルトの TOP5 と、モニターに常時出るライブ TOP3
   * (ChallengeState.runRank)の**唯一のソース**。集計範囲は「開始→達成」の
   * 1ランだけで、セッション全体ではない — start/reset でクリアする。だから
   * ダッシュボードの「リセット」でモニターのランキングもその場で空になる。
   * エンジン全体の規約どおり DB には一切書かない。
   */
  private runViewers = new Map<UserId, RunParticipant>();
  /**
   * ラン中のユニーク参加者**数**の権威。**runViewers.size ではなくこれ**を使う
   * — あちらは pruneRunViewers で「💎上位200 ∪ いいね上位200」まで間引かれるので、
   * 4000 ユニークを超えた配信では CLEAR リザルトもランキング盤も参加者数が
   * 約400で頭打ちになっていた(毎回ほぼ同じ数字が出るので壊れているのが丸わかりだった)。
   * ライフサイクルは runViewers と完全に同じ — start/reset でクリア、stop では残す。
   */
  private runParticipants = 0;
  /**
   * 再訪 dedup(間引きで消えた人が戻っても二重に数えないため)。以前は素の
   * Set<UserId> で 1 ランのユニーク数に比例して育つ唯一の無制限コレクション
   * だった — BoundedSet 化(cap は seenFollowers と同じ 50,000)で耐久配信の
   * ヒープ成長を止める。cap 内なら参加者数は厳密。超過後の副作用は「ここからも
   * runViewers の剪定でも消えた最初期の参加者が再訪したときだけ +1 の過大計上」
   * のみ(単調増加は保たれ、過少にはならない)。runViewers に生き残っている
   * 上位者は Map ヒットが先にガードするので二重計上されない。
   */
  private runParticipantSeen = new BoundedSet<UserId>(50_000);
  /**
   * ランキングの材料(runViewers の行・表示名・剪定・start/reset)が変わるたびに
   * 増える単調カウンタ。topRankCached がこれで再計算の要否を判定する。
   */
  private rankVersion = 0;
  /** topRank の結果キャッシュ(`${key}:${n}` 別)。version 一致ならヒット。 */
  private rankCache = new Map<string, { version: number; rows: ChallengeRankRow[] }>();
  /** CLEAR 時に1度だけ組み立てて凍結する。生成後は絶対に書き換えない。 */
  private result: ChallengeResult | null = null;
  /**
   * ダッシュボードの「ランキング表示」トグル。true の間だけ get() が rankBoard
   * (TOP5×2 の生スナップショット)を載せ、モニターが全画面で出す。
   * 既定 false = delta にアバターURL 10 本を常時載せない(result と同じ理由)。
   */
  private rankShown = false;
  /** いいねの端数繰り越し(likeEvery 未満の余り)。 */
  private likeCounter = 0;
  /**
   * 満タン(likeEvery 到達)の累計回数。nextEffectId と同じく reset でも
   * 巻き戻さない — モニターのゲージが前回値との比較だけで満タン演出を発火でき、
   * counter の見かけの増減(閾値跨ぎ・reset)と区別できるようにするため。
   */
  private likeFills = 0;
  /** 点灯中のいいねストック数(0 <= likeStocks < likeStockCount)。reset で 0。 */
  private likeStocks = 0;
  /** ストック満杯の累計回数。likeFills と同じく単調増加で reset でも巻き戻さない。 */
  private stockFills = 0;
  /**
   * 現在のゲージ区間(likeCounter が 0→every の間)のユーザー別いいね集計。
   * 満タンのたびに 1 位を確定してクリアする。Map の挿入順 = 区間内の初いいね順で、
   * 同数のタイブレークに使う(topRank と同じ「先着が勝つ」規約)。
   * runViewers を使わないのは、pruneRunViewers で区間途中にユーザーが消えうるのと、
   * あちらはラン累計でありゲージ区間の集計ではないため。
   */
  private segTally = new Map<UserId, { likes: number; avatarUrl: string | null; nickname: string | null }>();
  /** 点灯スロット(likeStocks と同数・同順)。i 番目 = i 番目に点灯したドットの区間1位。 */
  private stockSlots: ChallengeStockSlot[] = [];
  /**
   * 直近の満杯で消費されたスロット一式(count 個)。満杯処理は1 delta 内で完結し
   * 「全点灯 + 全スロット」の状態は配信されないため、モニターの満杯演出
   * (charge/burst の全点灯表示)はこのスナップショットからアバターを引く。
   * stockFills と同じく reset でもクリアしない — 演出が reset を跨いで再生中でも
   * 参照が生きるように。
   */
  private lastFullSlots: ChallengeStockSlot[] | null = null;
  /** effect 未表示のいいね加算分(LIKE_FX_WINDOW_MS 窓の合算)。 */
  private likeFxPending = 0;
  private likeFxLastMs = 0;
  /**
   * 凍結中に即時適用した押下の、effect 未表示ぶんの合算。
   *
   * 押下は凍結を素通しして値へ即時に効く(press のコメント参照)が、effect まで
   * 1タップ1件で積むと、連打がリングバッファ(CHALLENGE_EFFECTS_MAX)を押し流して
   * 待っているカットイン/ルーレットが配られる前に落ちる。さらに押下 SE と簡易演出が
   * カットインの音と絵に重なる。よって値だけ先に動かし、演出はここへ畳んで
   * 解除後に1件だけ出す(likeFxPending / fanStampFx と同じ流儀)。
   */
  private pendingPressFx: { amount: number; count: number } | null = null;
  /**
   * 押下で**1タップずつ即時に減らした**累計。ラン中は単調増加で start/reset のみ 0。
   *
   * モニターが「カットイン据え置き中でもタップぶんだけ数字を下げる」ために読む
   * (shared/fx-hold.ts)。ブースト清算(settleBoost)ぶんは**含めない** — あちらは
   * ロールアップ発表で見せるので、追従させると発表前に答えが漏れる。
   */
  private pressDownTotal = 0;
  /**
   * 最終ゲート(ラスト◯◯モード)の現ゲートの蓄積タップ(0..taps-1)。
   * 必要タップ数は保持しない — press のたびに finalGate.taps のライブ値を読む
   * (lowThreshold と同じ「設定変更が即効く」流儀)。start/stop/reset で 0 に戻し、
   * 妨害(+N)で閾値を上抜けたときは press 側の遅延評価で捨てる。
   * ブースト開始では**温存**する(フィーバーはボーナスであり、進捗没収の罰にしない)。
   */
  private gauntletTaps = 0;
  /**
   * お助け(ファンスタンプ)の合算窓の期限。null = 窓なし(次の1件は「先頭」)。
   *
   * LIKE_FX_WINDOW_MS(固定長)と違い**期限を絶対時刻で直接持つ**のは、窓長が
   * 可変だから — カットイン付きのお助けでは「凍結が明けるまで」がそのまま窓に
   * なる(giftOp が fxFreezeUntilMs と max を取る)。
   */
  private fanStampFxUntilMs: number | null = null;
  /** 窓内に届いたお助けの合算(effect 未表示ぶん)。null = 保留なし。 */
  private fanStampFx: FanStampAcc | null = null;
  /**
   * ダイヤ帯域カットイン再生中のカウンタ凍結の期限。null = 凍結なし。
   * status は変えない — 'idle' は「停止」の意味で使われており(モニターの
   * 「一時停止中」表示)、凍結中もイベントの受付・集計は続くため別概念。
   * 専用タイマーは持たず、イベント入口と 2Hz tick(drainIfChanged)で lazy に
   * 解除する — STRIKE_ABORT_MS と同じ「必ず収束する安全弁」の流儀。
   */
  private fxFreezeUntilMs: number | null = null;
  /**
   * タップブースト(フィーバー)の期限。null = 非ブースト。シネマティックモード
   * (fxAllowed)では fxFreezeUntilMs をこれより resultMs + BOOST_SETTLE_BUDGET_MS +
   * GIFT_FX_FREEZE_MARGIN_MS 遅く張る — settleBoost が必ず凍結ドレインより先に
   * 走り、boost-end effect の id が保留イベントの id より小さくなる(モニターの
   * 再生順の生命線)うえ、清算発表(結果カットシーン→ロールアップ→着弾)の間も
   * 保留イベントの演出が割り込まない。
   */
  private boostUntilMs: number | null = null;
  /**
   * タップウィンドウの開始時刻。シネマティックモードでは発動 + TAP_BOOST_INTRO_MS
   * (起動カットイン=3/2/1カウントダウン動画の尺)、プレーンモードでは発動即。
   * ウィンドウ前(起動カットイン中)のタップは倍にならず通常の凍結キューへ落ちる。
   */
  private boostStartMs = 0;
  /** ブースト中に「数えるだけ」で溜めたタップ回数(シネマティックモードのみ)。 */
  private boostTapCount = 0;
  /**
   * 発動時の設定を焼き込む(凍結中の設定変更で倍率や1タップの重みが揺れない
   * ように — effect への焼き込みと同じ「到着時点で確定」の規約)。
   */
  private boostMultiplier = 1;
  private boostPressStep = 1;
  /**
   * 結果カットシーン(発動時の resultClip 選択)の焼き込み。boostMultiplier と
   * 同じ「到着時点で確定」の規約 — settle 時に cfg を引き直さない。
   * resultMs 0 = 段なし(プレーンモード・'off' 選択)。
   */
  private boostResultMs = 0;
  private boostResultClip = '';
  /**
   * fxAllowed()=false で発動した印(プレーンモード)。カットインも溜めも無しで、
   * press が即時に pressStep × multiplier を減算する — 見えない演出のために
   * カウントが止まる事故を作らず、5倍のゲーム性だけ残す。
   */
  private boostPlain = false;
  /**
   * 発動予約(アーム)。ギフト着弾で組み、**モニターが起動カットインを再生し始めた
   * 合図(boostCue)でコミット**してタップ窓を開く。こうすると映像とタップ計数が
   * 必ず揃い、planBoostStart の resume(起動カットイン破棄)が正常系から消える。
   *
   * 不変条件(テストで固定):
   *  - armedBoost !== null ⟹ boostUntilMs === null(窓はまだ開いていない)
   *  - armedBoost !== null ⟹ fxFreezeUntilMs !== null(暫定凍結を必ず張る)
   * 後者は**連打コンボの直列化が依存している** — activateBoost が同期的に凍結を
   * 張るおかげで、1メッセージ内の2本目以降が applyOrQueue で pendingOps へ落ちる。
   * ここで凍結を張らないと全部が即時発動して互いを強制清算し合う。
   *
   * プレーンモード(fxAllowed()=false)はアームしない — 映像が無いので待つ理由がなく、
   * 「カットインも溜めも無し、倍率だけ」の契約どおり即発動する。
   */
  private armedBoost: {
    /** 対応する boost-start effect の id(合図の照合キー)。 */
    id: number;
    /** ギフト着弾時刻(診断とフォールバックの原点)。 */
    atMs: number;
    /** atMs + BOOST_ARM_MAX_MS。ここを過ぎたら worker が自走する。 */
    deadlineMs: number;
    /** 到着時点で確定した焼き込み(activateBoost と同じ規約)。 */
    introMs: number;
    countMs: number;
    durationMs: number;
    resultMs: number;
    resultClip: string;
    multiplier: number;
    pressStep: number;
  } | null = null;
  /**
   * ▶テスト実演(testEffect 'tapBoost')のタップウィンドウ。null = 実演なし。
   * testEffect は値・統計・凍結に触れない契約だが、タップカウンタの実源が
   * モニター窓のローカル計数だけだと「モニターにフォーカスが無いと数字が
   * 動かない」ため、計数だけは worker が持つ — press RPC(F9 / PUSH ボタン /
   * メイン窓 Space / モニター)の全経路が実発動と同じ1本に統一される。
   * ウィンドウ中の press は実値を減らさずここへ数える(配信中に実演しても
   * 実カウントが溶けない)。倍率/pressStep は実演開始時に焼き込む。
   */
  private testBoostUntilMs: number | null = null;
  private testBoostStartMs = 0;
  private testBoostTapCount = 0;
  private testBoostMultiplier = 1;
  private testBoostPressStep = 1;
  // ── お邪魔(タップ封じ) ──────────────────────────────────────────────────
  /**
   * 封印の期限(絶対 ms)。null = 非封印。boostUntilMs と同じ流儀で専用タイマーは
   * 持たず、flushFxFreeze(唯一の時計入口)で lazy に解除する。
   *
   * **永続化しない** — settings.json にも DB にも書かない(このエンジンの規約)。
   * 30 秒の罰が再起動をまたいで生き残ったら、それはもう罰ではなく故障になる。
   */
  private tapLockUntilMs: number | null = null;
  /** 封印の開始時刻(モニターの残り割合の分母)。 */
  private tapLockStartMs = 0;
  /** 発動時に焼き込んだ総尺(ms)。延長のたびに実尺へ更新する。 */
  private tapLockTotalMs = 0;
  /**
   * 封印中に弾いたタップの累計。press が dirty を立てて配るので、モニターは
   * この増分で「押したのに効かない」手応えを出せる。発動のたびに 0 から数え直す。
   */
  private tapLockBlocked = 0;
  /** 発動させた視聴者の表示名(告知バナーと PUSH の説明に使う)。 */
  private tapLockNickname = '';
  /** 発動した行の表示名(label)。空なら表示側が既定文言を使う。 */
  private tapLockLabel = '';
  /**
   * 凍結中に届いたイベントの値適用+演出の保留キュー(dedup・ランキング集計は
   * 凍結中も即時に回る — 取りこぼしゼロの肝)。解除時に到着順で実行し、途中で
   * 新たなバンドギフトが出たら再凍結してドレインを中断する(連続ギフトが
   * 1本ずつ順に演出される)。
   * fx はモニターの演出ストック表示に出す予告(カットイン/ブースト/ルーレット
   * だけ非 null)。凍結中は effect が recentEffects に載らないため、これが
   * ChallengeState.fxQueue の唯一のソースになる。
   */
  private pendingOps: Array<{ run: () => void; fx: ChallengeFxQueueItem | null }> = [];
  /** fxQueue の採番。ドレインを跨いで安定な表示キーのため単調増加。 */
  private fxQueueSeq = 0;
  /**
   * 現在の凍結エピソード中に溢れ弁(overflowOp)へ落ちた件数。ドレインで 0 に
   * 戻し、サマリを1行残す(flushOverflowDiag)。溢れは連発しうるので、ログは
   * エピソード先頭の1行+サマリ1行の最大2行に抑える。
   */
  private pendingOverflowCount = 0;
  /**
   * ドレイン(凍結解除)中の演出の迂回バッファ。非 null の間、pushEffect は
   * ring ではなくここへ積み、finishDrain が同種を1件に畳んでから ring へ移す。
   * 迂回しないと最大 GIFT_FX_PENDING_OPS_MAX 件の演出が一気に ring(12件)へ
   * 流れ、超過分が黙って消える(履歴ログからも欠落)うえ、生き残った12件は
   * atMs が解除時点に揃って鮮度ゲートを全通過し、同時再生ストームになる。
   */
  private drainFx: ChallengeEffect[] | null = null;
  /** stop() の強制適用中。maybeAchieve を抑止する(stop = 一時停止の意味論)。 */
  private stopping = false;
  /**
   * 凍結期限のワンショットタイマー。イベントも 2Hz tick も止まった状態
   * (配信終了後など)でも凍結が自然解除されるようにする最後の安全弁。
   * 発火で dirty になったら onFreezeExpired(session.nudgeChallenge)を呼ぶ。
   */
  private freezeTimer: ReturnType<typeof setTimeout> | null = null;
  private onFreezeExpired: (() => void) | null = null;
  /**
   * モニターの再生能力(A2)。両方 true のときだけカットイン凍結を張る —
   * モニター窓が閉じている・OS の「動きを減らす」が有効などでカットインが
   * 実際には再生されないのに、カウントダウンだけ 6〜45 秒止まる事故を防ぐ。
   * 既定 false = モニターが名乗り出るまで凍結しない(fail-open)。
   */
  private monitorOpen = false;
  private monitorBandFx = false;
  /** 生成直後は true — 起動後の最初の delta で初期状態をモニターへ配るため。 */
  private dirty = true;

  constructor(
    private readonly getConfig: () => ChallengeConfig,
    private readonly now: () => number = Date.now,
    /** ルーレット抽選の乱数源。テストで固定値を注入する(now と同じ流儀)。 */
    private readonly rand: () => number = Math.random,
    /**
     * 演出だけの乱数源。**抽選(rand)とは別に持つ。**
     * 理由は2つ: (1) 抽選の乱数列に演出都合の消費を混ぜると、出目の再現性を
     * 検査しているテストが演出を変えただけで壊れる。(2) パターンと出目の相関は
     * 信頼度方式(drawRoulettePattern の rarity 引数)による**設計値**であって、
     * 乱数の共有から生まれる偶発であってはならない — 出目は fxRand から独立のまま、
     * 演出だけが出目の珍しさを参照する一方向の依存に保つ。
     */
    private readonly fxRand: () => number = Math.random,
    /**
     * ギフト判定の診断ログの出口(now と同じ流儀で注入する)。
     * 既定は stdout — main/worker-host.ts が `[worker]` を付けて中継し、
     * diag-log.ts の KEEP_PREFIX が拾って logs/diag.log へ落とす。
     * ユニットテストは no-op を渡す(370件ぶんの出力で結果が埋もれるため)。
     */
    private readonly diag: (message: string) => void = (m) => console.log(m)
  ) {
    this.value = this.getConfig().initialValue;
  }

  // ── 操作(RPC から) ──────────────────────────────────────────────────────

  start(): ChallengeState {
    const cfg = this.getConfig();
    this.status = 'running';
    this.value = cfg.initialValue;
    this.startedMs = this.now();
    this.achievedMs = null;
    this.stats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, joinDown: 0, joinUp: 0, rouletteSpins: 0 };
    this.recentEffects = [];
    this.effectsSnapshot = null;
    this.seenFollowers.clear();
    this.resetFollowDiagCounters();
    this.seenJoiners.clear();
    // クールダウンも一緒に流す — 前回の最後の抽選から 10 秒以内に始めた
    // チャレンジで、開始直後の入室が黙って捨てられるのを防ぐ。
    this.joinRouletteLastMs = 0;
    this.runViewers.clear();
    this.runParticipants = 0;
    this.runParticipantSeen.clear();
    this.rankVersion++;
    this.result = null;
    // 新ランは空のランキングから始まる。出しっぱなしのボードを引き継ぐと
    // モニターが「全員 —」の全画面で始まってしまう。
    this.rankShown = false;
    this.resetLikeAccumulators();
    this.resetFanStampFx();
    // 前ラン由来の保留分を新ランへ持ち込まない(値は initialValue で始める規約)。
    this.pendingOps = [];
    this.pendingPressFx = null;
    this.pressDownTotal = 0;
    // 最終ゲートの蓄積も新ランへ持ち込まない(見えない進捗を跨がせない)。
    this.gauntletTaps = 0;
    this.fxFreezeUntilMs = null;
    // ブーストも清算せず破棄(pendingOps と同じ判断 — 新ランは素の状態で始める)。
    this.clearBoost();
    // お邪魔も同じ — 新ランは素の状態で始める(前ランの罰を持ち込まない)。
    this.clearTapLock();
    // ▶実演の窓も破棄 — press() は実演ブロックを最優先で見るので、実演の残り窓を
    // 跨いで開始すると開幕のタップが全部テストカウンタに吸われて実値が減らない。
    this.clearTestBoost();
    this.armFreezeTimer();
    this.dirty = true;
    return this.get();
  }

  /**
   * 値は凍結表示のため残す。startedMs も統計表示用に残す。
   * runViewers/result も残す — 誤クリックで集計が消えないように。status が
   * idle になるので get() はリザルトを載せない(モニターは通常画面へ戻る)。
   */
  stop(): ChallengeState {
    // 凍結中の保留分は捨てず強制適用する — stop は「値を残す」規約のため、
    // 受け取り済みのギフト/いいねが闇に消えると集計と値が食い違う。
    // stopping フラグで maybeAchieve を抑止する — 以前は保留分に 0 到達が
    // 含まれると achieved effect を push した直後に idle で上書きし、
    // 「値0・idle・リザルト無しでクラッカーだけ鳴る」半端な絵になっていた。
    // stop は一時停止の意味論なので、達成判定ごと保留にする(残 op の適用も
    // status 遷移で break しなくなり、取りこぼしが消える)。
    this.stopping = true;
    try {
      // まだ映像が始まっていない予約は無言で捨てる。タップも値も1つも動いて
      // いないので清算するものが無く、停止後にフィーバーを始める意味も無い
      // (settleBoost は boostUntilMs null で早期 return するのでここが唯一の出口)。
      this.armedBoost = null;
      // 溜めたタップを闇に落とさない — stop は「値を残す」規約なので、保留 op の
      // 強制適用より先にブーストを清算する(boost-end が保留分より先に並ぶ)。
      this.settleBoost(this.now(), true);
      this.forceApplyPendingOps();
    } finally {
      this.stopping = false;
    }
    this.status = 'idle';
    // 停止後に合算待ちの演出が漏れないように捨てる(値には適用済み)。
    this.likeFxPending = 0;
    // 押下も同じ — 値は適用済みなので、停止したあとに押下音だけ鳴らさない
    // (pressDownTotal は「ランの累計」なので stop では残す)。
    this.pendingPressFx = null;
    // 停止で最終ゲートの蓄積は捨てる — stop→start は initialValue から再開する
    // 意味論なので、見えない進捗を次のランへ跨がせない(clearTapLock と同じ判断)。
    this.gauntletTaps = 0;
    this.resetFanStampFx();
    this.clearTestBoost();
    // 停止は一時停止だが封印は跨がせない — 再開したら見えないボタンが死んでいる、
    // が最悪の体験(pendingPressFx / testBoost を捨てるのと同じ判断)。
    this.clearTapLock();
    this.dirty = true;
    return this.get();
  }

  reset(): ChallengeState {
    // 直後に initialValue で上書きするので保留分は適用せず捨てる。
    this.pendingOps = [];
    this.pendingPressFx = null;
    this.pressDownTotal = 0;
    this.gauntletTaps = 0;
    this.fxFreezeUntilMs = null;
    this.clearBoost();
    this.clearTapLock();
    this.clearTestBoost();
    this.armFreezeTimer();
    this.status = 'idle';
    this.value = this.getConfig().initialValue;
    this.startedMs = null;
    this.achievedMs = null;
    this.stats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, joinDown: 0, joinUp: 0, rouletteSpins: 0 };
    this.recentEffects = [];
    this.effectsSnapshot = null;
    this.seenFollowers.clear();
    this.resetFollowDiagCounters();
    this.seenJoiners.clear();
    // クールダウンも一緒に流す — 前回の最後の抽選から 10 秒以内に始めた
    // チャレンジで、開始直後の入室が黙って捨てられるのを防ぐ。
    this.joinRouletteLastMs = 0;
    this.runViewers.clear();
    this.runParticipants = 0;
    this.runParticipantSeen.clear();
    this.rankVersion++;
    this.result = null;
    this.rankShown = false;
    this.resetLikeAccumulators();
    this.resetFanStampFx();
    this.dirty = true;
    return this.get();
  }

  /**
   * ダッシュボードの「ランキング表示」ボタン。モニターの全画面ランキングを
   * 出す/消すだけで、値・統計・集計・演出には一切触らない。
   *
   * status を見ないのは意図的 — 一時停止中や達成後に「さっきのランは誰が
   * 1位だったか」を出したい場面があり、runViewers は stop() では消えないため
   * そのまま出せる(消えるのは start/reset のとき)。
   */
  toggleRank(): ChallengeState {
    this.rankShown = !this.rankShown;
    this.dirty = true;
    return this.get();
  }

  /**
   * 配信終了でランキングを畳む(SessionManager.stop から)。モニター下部の TOP3 が
   * sessionId で自動的に消えるのと挙動を揃えるため。
   *
   * **戻り値は「実際に変化したか」** — 呼び出し側はこれが true のときだけ delta を
   * 送る。stop() の時点で 2Hz tick はもう止まっているので、押していない配信の
   * 終了ごとに無駄な delta を撃たないための判定。
   *
   * runViewers は消さない(集計は stop の規約どおり残す) — 再開せずもう一度
   * 押せば、そのランの順位をまた出せる。
   */
  hideRank(): boolean {
    if (!this.rankShown) return false;
    this.rankShown = false;
    this.dirty = true;
    return true;
  }

  /** idle/achieved 中のホットキーはエラーにせず無視する(配信中の誤爆対策)。 */
  press(): ChallengeState {
    // ▶テスト実演のタップウィンドウ中は status を問わず「数えるだけ」—
    // 設定画面からの実演(大抵 idle)でもカウンタが動き、配信中の実演でも
    // 実値を減らさない。ウィンドウ前(起動カットイン中)は素通し(実発動と
    // 同じく倍にならない — idle なら下の status ガードで無視される)。
    if (this.testBoostUntilMs !== null) {
      const nowMs = this.now();
      if (nowMs >= this.testBoostUntilMs) {
        this.clearTestBoost(); // 期限切れの lazy 掃除
      } else if (nowMs >= this.testBoostStartMs) {
        this.testBoostTapCount++;
        this.dirty = true;
        return this.get();
      }
    }
    // 機能そのものが OFF なら数字は動かさない。ゲートを**テスト実演ブロックの後**に
    // 置くのは、設定画面の「▶ モニター」が OFF のまま実演するのが正しい使い方だから
    // (有効化する前に演出を見て決める)。実演のタップ計数は上で return 済み。
    if (!this.getConfig().enabled) return this.get();
    if (this.status !== 'running') return this.get();
    const nowMs = this.now();
    // 期限切れブーストの清算は flushFxFreeze の冒頭(settleBoost)が行う。
    this.flushFxFreeze(nowMs);
    // タップウィンドウ中のタップは applyOrQueue に入れない — シネマティック
    // モードでは「数えるだけ」(値・統計・effect は settleBoost が一括で確定する。
    // effect を積まないので ring を食い潰さない)、プレーンモードでは即時×倍率。
    // 起動カットイン中(boostStartMs 前)はここを通らず、下の専用ブロックで
    // 凍結キューへ落ちる(3/2/1 の前のタップは倍にも即時にもならない)。
    if (this.boostUntilMs !== null && nowMs >= this.boostStartMs && nowMs < this.boostUntilMs) {
      if (this.boostPlain) {
        const step = this.boostPressStep * this.boostMultiplier;
        // クランプ後の実減少量。effect の amount も「画面上で実際に減った量」で
        // 揃える(flushPressFx と同じ規約 — 名目 step を焼くと、最後の1押しで
        // モニターのラッチ表示(valueAfter - amount)が step ぶん上へ飛ぶ)。
        const boostApplied = Math.min(step, this.value);
        // 1タップずつ即時に減る経路なので pressDownTotal に載せる(清算方式の
        // シネマティックとは逆 — あちらは settleBoost の発表で見せるので載せない)。
        this.pressDownTotal += boostApplied;
        this.value -= boostApplied;
        this.stats.presses++;
        this.pushEffect({
          kind: 'press',
          // -0 を作らない(settleBoost の boost-end と同じ理由)。
          amount: boostApplied === 0 ? 0 : -boostApplied,
          boostMultiplier: this.boostMultiplier,
          atMs: nowMs,
        });
        // 凍結中(モニターが途中で開いてカットインが走った等)は達成を見送る —
        // 押下経路の達成は必ず演出明け(flushFxFreeze の末尾)に出す。
        if (!this.isFxFrozen()) this.maybeAchieve(nowMs);
      } else {
        this.boostTapCount++;
      }
      this.dirty = true;
      return this.get();
    }
    // ── お邪魔(タップ封じ) ────────────────────────────────────────────────
    // **この位置が仕様そのもの**なので動かさないこと:
    //  - フィーバーのタップ窓(すぐ上の分岐)より**下** = 開いている窓は免除
    //    (2026-08-18 ユーザー決定)。窓の中のタップは封印中でも通り倍率も乗る。
    //  - 3・2・1(すぐ下の分岐)より**上** = 封印中のタップを applyOrQueue に積まない。
    //    下に置くと封印明けに溜まったぶんが一気に落ち、「封印」ではなく「遅延」になる
    //    (お邪魔が奪ったはずのカウントをそのまま返してしまう)。
    //  - flushFxFreeze(上)より**下** = 期限切れの解除を必ず先に見る。上に置くと、
    //    連打している配信者が唯一の呼び出し元なのに解除処理へ到達せず
    //    **封印が自分自身を閉じ込める**。
    //  - enabled / status ガード(上)より**下** = チャレンジ OFF を逃げ道として残す。
    //  - 押下凍結(下)より**上** = 「タップは凍結を素通しする」は演出の遅延の話。
    //    封印は演出ではなくゲームの状態なので、そちらの契約を意図的に上書きする。
    // 弾いたタップは**捨てる**(溜めない)。
    if (this.tapLockUntilMs !== null) {
      this.tapLockBlocked++;
      this.dirty = true;
      return this.get();
    }
    // フィーバーの起動カットイン(咆哮 → 3・2・1)中だけは**従来どおり凍結キューへ**。
    // 倍率が乗らないのは元からだが、ここは即時にもしない — 3・2・1 は「まだ押す
    // 時間ではない」合図で、フライングで数字が動くと溜めの意味が消える。溜めたぶんは
    // boost-end の後にドレインで通常適用される(取りこぼしはゼロ)。
    if (this.boostUntilMs !== null && nowMs < this.boostStartMs) {
      this.applyOrQueue(() => {
        const introStep = this.getConfig().pressStep;
        const introApplied = Math.min(introStep, this.value);
        this.value -= introApplied;
        this.stats.presses++;
        this.pressDownTotal += introApplied;
        // クランプ後の実減少量を焼く(flushPressFx / 通常経路と同じ規約)。
        this.pushEffect({
          kind: 'press',
          amount: introApplied === 0 ? 0 : -introApplied,
          atMs: this.now(),
        });
        this.maybeAchieve(this.now());
        this.dirty = true;
      });
      return this.get();
    }
    // ── 最終ゲート(ラスト◯◯モード)────────────────────────────────────────
    // **この位置が仕様そのもの**なので動かさないこと:
    //  - ブーストのタップ窓(上の分岐)より**下** = フィーバー中は免除(2026-08-19
    //    ユーザー決定)。窓の中のタップは従来どおり倍率で即時に効く。
    //  - tapLock(上)より**下** = 封印中のタップはゲートに蓄積されず捨てられる
    //    (封印の契約を維持 — 蓄積すると「封印」ではなく「ゲート充填時間」になる)。
    //  - 起動カットイン(上)より**下** = 3・2・1 中のタップは従来どおり凍結キュー行き。
    //    「まだ押す時間ではない」の契約をゲートで上書きしない。
    // ゲート中は 1 タップ = 蓄積 1、taps 到達で**常に 1** 減算(pressStep は使わない —
    // pressStep>1 だと終盤が数字飛びして「最後の10個を1つずつ削り切る」演出が破綻する)。
    // 蓄積中は effect を積まない(29発で recentEffects リングを押し流さない —
    // シネマティックブーストの「数えるだけ」と同じ判断)。進捗は get() の gauntlet が運ぶ。
    {
      const fg = this.getConfig().finalGate;
      const gateActive = fg.enabled && this.value > 0 && this.value <= this.getConfig().lowThreshold;
      if (!gateActive && this.gauntletTaps > 0) {
        // 妨害(+N)で閾値を上抜けた / 設定でオフに変わった — 蓄積は捨てる(遅延評価)。
        // 唯一の未カバーは「上抜け後、一度も押さないまま応援ギフトで再突入」で旧蓄積が
        // 残るケースだが、配信者が押していない間の話なので実害なし。
        this.gauntletTaps = 0;
        this.dirty = true;
      }
      if (gateActive) {
        // presses は全経路で「タップ実数」の規約(ブースト清算も tap 数を加算する)。
        // 蓄積タップも実タップなので毎回数える。
        this.stats.presses++;
        this.gauntletTaps++;
        if (this.gauntletTaps < fg.taps) {
          this.dirty = true;
          return this.get(); // 値は動かさない。effect も積まない(進捗は gauntlet が運ぶ)。
        }
        // taps 到達 — 1 だけ減算してゲートを巻き直す。
        this.gauntletTaps = 0;
        // クランプ規約(通常経路と同じ)。gateActive が value>0 を保証するが形は揃える。
        const gateApplied = Math.min(1, this.value);
        this.value -= gateApplied;
        this.pressDownTotal += gateApplied;
        if (this.isFxFrozen()) {
          // 凍結中は演出だけ畳む(通常経路と同じ規約)。finalGate の印は
          // 畳み込みで失われるが、破裂演出はゲート完成の1件ずつに出すものなので
          // 凍結明けの合算1件で鳴らさないのはむしろ正しい。
          // **ただし幕がまだ上がっていない(アーム済みフィーバー待ち)なら畳まない** —
          // 重ねる相手が居ないのに黙ると、ゲートを削り切った手応えだけが消える。
          // maybeAchieve はここでも呼ばない(達成は凍結明けに出す規約を維持)。
          if (this.fxCurtainUp()) {
            const fx = (this.pendingPressFx ??= { amount: 0, count: 0 });
            fx.amount += gateApplied;
            fx.count++;
          } else {
            this.pushEffect({
              kind: 'press',
              amount: gateApplied === 0 ? 0 : -gateApplied,
              finalGate: true,
              atMs: nowMs,
            });
          }
        } else {
          this.pushEffect({
            kind: 'press',
            amount: gateApplied === 0 ? 0 : -gateApplied,
            finalGate: true,
            atMs: nowMs,
          });
          this.maybeAchieve(nowMs);
        }
        this.dirty = true;
        return this.get();
      }
    }
    // 押下は**凍結を素通しして即時に効く**(applyOrQueue に入れない)。保留キューへ
    // 落としていた頃は、カットイン1本で最長 15 秒・連鎖で最大 45 秒ぶん数字が1も
    // 動かず、配信者からはボタンが死んで見えた。走行中のタップは必ず届くのが約束。
    // 演出(押下 SE・簡易演出)だけは凍結中まとめて pendingPressFx へ畳み、解除後に
    // 1件だけ出す — カットインの音と絵に重ねない・リングを連打で押し流さないため。
    const step = this.getConfig().pressStep;
    // クランプ後の実減少量。pressDownTotal はモニターの据え置き追従が読むので、
    // 「画面上で実際に減った量」と一致していなければならない。
    const applied = Math.min(step, this.value);
    if (this.isFxFrozen()) {
      // 0 到達後は値も統計も動かさない。達成は凍結明け(flushFxFreeze の末尾)まで
      // 待つ規約なので、その間の連打で presses だけが膨らむのを防ぐ
      // (達成後の press が無視されるのと同じ扱い)。
      if (this.value === 0) return this.get();
      this.value -= applied;
      this.stats.presses++;
      this.pressDownTotal += applied;
      // 幕が上がっている間だけ畳む。アーム済みフィーバーの待ち(最長 60 秒・
      // ルーレット連鎖の裏なら実測でも十数秒)は**まだ何も映っていない**ので、
      // 畳む理由(カットインの音と絵に重ねない)が存在しない。
      // 値・stats・pressDownTotal・達成の先送りは上のまま = 意味論は不変。
      if (this.fxCurtainUp()) {
        const fx = (this.pendingPressFx ??= { amount: 0, count: 0 });
        fx.amount += applied;
        fx.count++;
      } else {
        this.pushEffect({ kind: 'press', amount: applied === 0 ? 0 : -applied, atMs: nowMs });
      }
      this.dirty = true;
      return this.get();
    }
    this.value -= applied;
    this.stats.presses++;
    this.pressDownTotal += applied;
    // effect の amount もクランプ後の applied で焼く — pressDownTotal と同じ
    // 「画面上で実際に減った量」規約(凍結経路の flushPressFx と意味を揃える)。
    this.pushEffect({ kind: 'press', amount: applied === 0 ? 0 : -applied, atMs: nowMs });
    this.maybeAchieve(nowMs);
    this.dirty = true;
    return this.get();
  }

  /**
   * 演出のテスト再生(設定画面の「▶ モニター」)。value/stats/status/凍結/
   * dedup には一切触れない — 演出だけを本物の経路(ring buffer → delta →
   * playEffect)で流す。status ガードも無し: 停止中でも実演できるのが目的。
   *
   * pushEffect は使わない — あちらは valueAfter に this.value をスタンプする
   * 規約で、amount ≠ 0 のテストだとモニターのラッチ表示(valueAfter - amount)
   * が現在値からズレて、演出中に数字が飛んで見える。ここでは
   * valueAfter = value + amount とし、ラッチ開始値 = 現在値に揃える(演出明けは
   * worker の実値へ収束するので表示は動かない)。
   */
  testEffect(spec: ChallengeTestEffectSpec): void {
    const cfg = this.getConfig();
    const atMs = this.now();
    let e: Omit<ChallengeEffect, 'id' | 'valueAfter' | 'test' | 'atMs'>;
    switch (spec.kind) {
      case 'press':
        e = { kind: 'press', amount: -cfg.pressStep };
        break;
      case 'follow':
        e = { kind: 'follow', amount: cfg.followStep, nickname: 'テスト' };
        break;
      case 'like':
        e = { kind: 'like', amount: Math.max(1, cfg.likeStep) };
        break;
      case 'gauge-full':
        // 着弾演出(弾→7セグ)の実演。ライブ経路では likeGauge.fills の差分駆動で
        // effect を持たないため、実演専用の kind を流す — モニターは e.test のときだけ
        // 現在値のまま着弾チェーン(弾・segフラッシュ・SE・簡易演出)を試写する。
        e = { kind: 'gauge-full', amount: Math.max(1, cfg.likeStep) };
        break;
      case 'stock-full':
        e = { kind: 'stock-full', amount: Math.max(1, cfg.likeStockStep) };
        break;
      case 'comment': {
        // 行ごとの実演(ruleId)。未指定・対象行が消えていたら最初の keyword 非空の行、
        // 1件も無ければダミー(+10)で演出だけ見せる(roulette の行フォールバックと同型)。
        const rule =
          cfg.commentRules.find((r) => r.id === spec.ruleId) ??
          cfg.commentRules.find((r) => r.keyword !== '');
        e = {
          kind: 'comment',
          amount: Math.max(1, rule?.amount ?? 10),
          nickname: 'テスト',
          ...(rule && rule.keyword !== '' ? { commentKeyword: rule.keyword } : {}),
        };
        break;
      }
      case 'fanStamp': {
        // 設定中の値をそのまま1個ぶん適用する(連打は再現しない)。トリガー
        // (giftId 等)は評価しない — 未設定でもバナーの見た目を確認できるのが目的。
        const fs = cfg.fanStamp;
        e = {
          kind: 'gift',
          ...(fs.flash ? { flash: true } : {}),
          fanStamp: true,
          giftName: 'ファンスタンプ',
          // 合算バナー(複数人ぶんを1枚に畳んだ形)の実演。実際の合算は worker の
          // 窓でしか起きず設定画面からは再現できないので、印だけを焼き込んで見た目を出す。
          ...(spec.multi
            ? {
                amount: fs.amountEach * 6,
                nickname: 'たろう',
                giftCount: 6,
                coalesced: 6,
                fanStampNames: ['たろう', 'はなこ', 'じろう'],
                fanStampPeople: 5,
              }
            : { amount: fs.amountEach, nickname: 'テスト' }),
          // 演出 tier は t1(1ダイヤ)相当。実運用のファンスタンプも1ダイヤ。
          diamonds: 1,
        };
        break;
      }
      case 'gift': {
        const m = matchGiftRule(cfg, { giftId: 'test', diamonds: spec.diamonds });
        const band = spec.bandId ? (cfg.giftBandFx.bands.find((b) => b.id === spec.bandId) ?? null) : null;
        const usableBand = band && band.clip !== 'off' ? band : null;
        // 全面カット行の実演。bandId と同じ流儀で「行を名指ししたら一致判定は
        // 評価しない」— トリガー(ギフト名)が未設定でも見た目を確認できるのが目的。
        // 指定時は帯域より優先する(本番の giftOp と同じ順序)。
        const fullCut = spec.fullCutId
          ? (cfg.giftFullCut.rules.find((r) => r.id === spec.fullCutId) ?? null)
          : null;
        const usableFullCut = fullCut && fullCut.clip !== 'off' ? fullCut : null;
        const cutClip = usableFullCut ? usableFullCut.clip : (usableBand?.clip ?? null);
        const cutDurationSec = usableFullCut ? usableFullCut.durationSec : (usableBand?.durationSec ?? 0);
        const fxDurationMs = cutClip ? Math.min(cutDurationSec * 1000, GIFT_FX_FREEZE_MAX_MS) : 0;
        const testRep = cutClip
          ? 1
          : giftFxRepeat(cfg, spec.repeat ?? 1, { banded: false, fxDurationMs: 0 });
        e = {
          kind: 'gift',
          amount: m?.amount ?? 0,
          ...(m?.flash ? { flash: true } : {}),
          nickname: 'テスト',
          giftName: 'テストギフト',
          // カットインは effect 1件で自己完結の流儀(handleEvent と同じ)。
          // fxFreezeUntilMs は張らない — テストで実イベントの適用を止めない。
          ...(cutClip ? { fxBandClip: cutClip, fxDurationMs } : {}),
          ...(usableFullCut ? { fxFullCut: true as const } : {}),
          ...(!usableFullCut && usableBand && usableBand.bgm !== 'off' && cfg.giftBandFx.bgmEnabled
            ? { fxBandBgm: usableBand.bgm }
            : {}),
          // 連打反復の実演。カットイン併用時は 1 に倒す — testEffect は凍結を
          // 張らない契約なので、反復させると数字が演出中に動いてしまう。
          ...(testRep > 1 ? { fxRepeat: testRep, fxRepeatIntervalMs: cfg.giftRepeatFx.intervalMs } : {}),
          diamonds: spec.diamonds,
        };
        break;
      }
      case 'tapBoost': {
        // 設定中の durationSec/multiplier/クリップ選択をそのまま使って実演する。
        // トリガー一致は評価しない(fanStamp と同じ — 未設定でも見た目を確認
        // できるのが目的)。凍結もブースト状態も作らない(testEffect の契約)—
        // モニターは e.test を見て、据え置きなしで前置き→ウィンドウ→着弾を試写する。
        // 行ごとの実演(ルーレットの rouletteId と同じ流儀)。未指定・対象行が
        // 消えていたら最初の有効な行。1行も無ければ積む演出が無いので抜ける。
        const tb =
          cfg.tapBoost.rules.find((r) => r.id === spec.boostId) ?? cfg.tapBoost.rules.find((r) => r.enabled);
        if (!tb) return;
        const durationMs = tb.durationSec * 1000;
        const introMs = tb.introClip !== 'off' ? TAP_BOOST_INTRO_MS : 0;
        const countMs = tb.countClip !== 'off' ? TAP_BOOST_COUNT_MS : 0;
        const resultMs = tb.resultClip !== 'off' ? TAP_BOOST_RESULT_MS : 0;
        // タップ計数のウィンドウを worker 側に登録する(値・統計・凍結は不変)。
        // 実ブースト進行中・**アーム中**は登録しない — モニターも他演出中の実演は
        // スキップするので、実カウンタを乗っ取らないのが正。アーム中は
        // boostUntilMs がまだ null(armedBoost ⟹ boostUntilMs === null の不変条件)
        // なので、armedBoost も見ないと commit 後の実タップが実演に吸われる。
        if (this.boostUntilMs === null && this.armedBoost === null) {
          this.testBoostStartMs = atMs + introMs + countMs;
          this.testBoostUntilMs = this.testBoostStartMs + durationMs;
          this.testBoostTapCount = 0;
          this.testBoostMultiplier = tb.multiplier;
          this.testBoostPressStep = cfg.pressStep;
        }
        e = {
          kind: 'boost-start',
          amount: 0,
          boostMultiplier: tb.multiplier,
          boostEndsAtMs: atMs + introMs + countMs + durationMs,
          boostIntroMs: introMs,
          boostCountMs: countMs,
          ...(introMs > 0 ? { boostIntroClip: tb.introClip } : {}),
          ...(countMs > 0 ? { boostCountClip: tb.countClip } : {}),
          ...(tb.loopClip !== 'off' ? { boostLoopClip: tb.loopClip } : {}),
          // テストは boost-end が来ない(自前で締める)ので start 側の焼き込みが
          // 結果段の唯一のソース — 実演でも結果カットシーン→発表まで試写できる。
          ...(resultMs > 0 ? { boostResultMs: resultMs, boostResultClip: tb.resultClip } : {}),
          fxDurationMs: introMs + countMs + durationMs,
          ...(tb.flash ? { flash: true } : {}),
          nickname: 'テスト',
        };
        break;
      }
      case 'tapLock': {
        // 設定中の durationSec/label をそのまま使って告知バナーだけ実演する。
        // トリガー一致は評価しない(fanStamp / tapBoost と同じ)。**実際には封印
        // しない** — testEffect は値・統計・状態に触れない契約で、設定画面は配信中にも
        // 開けるので、ここで本当にラッチすると本番のボタンが死ぬ。
        const tl =
          cfg.tapLock.rules.find((r) => r.id === spec.lockId) ?? cfg.tapLock.rules.find((r) => r.enabled);
        if (!tl) return;
        const lockMs = tl.durationSec * 1000;
        e = {
          kind: 'tap-lock',
          amount: 0,
          tapLockMs: lockMs,
          tapLockUntilMs: atMs + lockMs,
          ...(tl.label !== '' ? { giftName: tl.label } : {}),
          ...(tl.flash ? { flash: true } : {}),
          nickname: 'テスト',
        };
        break;
      }
      case 'roulette': {
        // 行ごとの実演。未指定・対象行が消えていたら最初の有効な行(GiftBandFx の
        // bandId と同じ流儀)。1件も無ければ積む演出が無いのでそのまま抜ける。
        // spec.join は入室ルーレットの試写 — 単一設定なので行解決は不要。enabled は
        // 見ない(既存の試写規約: 「チェックする前に見てみたい」の道具)。
        // ギフト行だけ別変数に割る — rl は JoinRouletteConfig との合併型で .id を
        // 引けないため(入室ルーレットは id を持たない単一設定)。
        const gr = spec.join
          ? null
          : (cfg.roulettes.find((r) => r.id === spec.rouletteId) ??
            cfg.roulettes.find((r) => r.enabled) ??
            null);
        const rl = spec.join ? cfg.joinRoulette : gr;
        if (!rl) return;
        const idx = drawRouletteIndex(rl.segments, this.rand);
        const seg = rl.segments[idx]!;
        // 効果音スロットの試聴は 'kick' を狙い撃ちしたいので spec の指定を優先する。
        // spec.pattern は行のチェック(patterns)の**外でも通す** — 設定UIの
        // パターン別 ▶ は「チェックする前に見てみたい」の道具なので、許可リストで
        // 弾くと試し見ができなくなる。抽選に任せる経路だけ許可リストへ従う
        // (rarity の条件付けもライブ経路と同じ — 実演と本番で分布を変えない)。
        // 激熱確定は入室ルーレットには無い(RouletteHotConfig の解説)ので gr 側だけ見る。
        // 実演でも本番と同じ倍率・同じ絵柄3種を通す — 「実演では出るのに本番で違う」を作らない。
        const hotMult = rl.direction === 'sub' ? 1 : rouletteHotMultiplier(gr?.hot);
        const pat =
          spec.pattern ??
          drawRoulettePattern(
            this.fxRand,
            hotMult > 1 ? ROULETTE_HOT_PATTERNS : rl.patterns,
            rouletteRarity(rl.segments, idx)
          );
        // 実演は常に1スピン。ライブ経路と同じ配列形で積む(モニターの再生経路を
        // 分岐させない — 分岐すると実演では出るのに本番で出ない事故が起きる)。
        e = {
          kind: 'roulette',
          amount: (rl.direction === 'sub' ? -seg.amount : seg.amount) * hotMult,
          rouletteSegments: rl.segments.map((s) => s.amount),
          rouletteIndex: idx,
          rouletteIndexes: [idx],
          roulettePattern: pat,
          roulettePatterns: [pat],
          rouletteReels: 1,
          ...(hotMult > 1 ? { rouletteHotMult: hotMult } : {}),
          ...(rl.direction === 'sub' ? { rouletteDirection: 'sub' as const } : {}),
          ...(rl.label !== '' ? { rouletteLabel: rl.label } : {}),
          // 本番(handleEvent の join 経路)と effect の形を揃える — 試写でも
          // モニターの「入室ルーレットは短縮・超焦らしカウントの対象外」が同じに効く。
          // 行の同一性(行ごとの回転サウンドの引き当て先)も本番と同じ形で載せる。
          // **spec.rouletteId ではなく実際に回った gr.id** を焼くこと — この経路は
          // 対象行が消えていたら「最初の有効な行」へ倒すので、spec を鵜呑みにすると
          // 実演した盤面と鳴る音がズレる。
          // rouletteOrigin(由来印)も本番と同型に — 試写だけ専用キューに乗らないと
          // 「実演では出るのに本番で出ない」の逆事故(実演だけ通常キュー)が起きる。
          ...(spec.join
            ? { rouletteJoin: true as const, rouletteOrigin: 'join' as const }
            : gr
              ? { rouletteId: gr.id }
              : {}),
          nickname: 'テスト',
        };
        break;
      }
      case 'achieved':
        e = { kind: 'achieved', amount: 0 };
        break;
    }
    this.recentEffects.unshift({
      id: this.nextEffectId++,
      valueAfter: this.value + e.amount,
      test: true,
      atMs,
      ...e,
    });
    while (this.recentEffects.length > CHALLENGE_EFFECTS_MAX) this.recentEffects.pop();
    this.effectsSnapshot = null;
    this.dirty = true;
  }

  // ── TikTok イベント ──────────────────────────────────────────────────────

  /**
   * 戻り値 true = 状態が変わった(呼び出し側が即時 delta を送る)。
   *
   * joinFirstEver は join イベントの初見判定(session.ts の metaOf 由来)。
   * 省略可能なのは呼び出し互換のため — リプレイ/テストの1引数呼び出しでは
   * 常に false になり、target:'first' の入室ルーレットは発火しない(正しい挙動:
   * リプレイの視聴者は既に DB に記録済みで初見ではない)。
   */
  handleEvent(e: NormalizedEvent, joinFirstEver = false): boolean {
    // 機能そのものが OFF なら妨害も応援も受け付けない。以前は enabled を見るのが
    // ホットキー登録(main/index.ts)とダッシュボードのカード表示(LiveDashboard.tsx)
    // だけで、OFF にしてもギフト・いいね・フォローが数字を動かし続けていた
    // (モニターを開いていればクリックでも減った)。
    if (!this.getConfig().enabled) return false;
    if (this.status !== 'running') return false;
    // 凍結期限が来ていればここで解除する(2Hz tick と並ぶ lazy 解除の入口)。
    this.flushFxFreeze(this.now());
    const cfg = this.getConfig();

    // フォロー = 妨害。normalize.ts の契約どおり sub === 'follow' のみで判定する
    // (libType 'follow' は実配信では来ない — WebcastSocialMessage 経由)。
    // dedup(seenFollowers)は凍結中も即時に回し、値適用+演出だけを保留する。
    if (e.kind === 'social' && e.sub === 'follow') {
      const nowMs = this.now();
      if (this.seenFollowers.has(e.viewer.userId)) {
        this.followDupCount++;
        if (this.followDupLogMs === null || nowMs - this.followDupLogMs >= 60_000) {
          this.socialDiag(`重複スキップ ×${this.followDupCount}(直近60秒・再接続バックログ含む)`);
          this.followDupCount = 0;
          this.followDupLogMs = nowMs;
        }
        return false;
      }
      this.seenFollowers.add(e.viewer.userId);
      if (cfg.followStep <= 0) {
        // 「フォロー妨害が発生しない」の最有力原因は設定 0 — 必ず痕跡を残す。
        this.followStep0Count++;
        if (this.followStep0LogMs === null || nowMs - this.followStep0LogMs >= 60_000) {
          this.socialDiag(`followStep=0 のため無効 ×${this.followStep0Count}(直近60秒)`);
          this.followStep0Count = 0;
          this.followStep0LogMs = nowMs;
        }
        return false;
      }
      const nick = e.viewer.nickname ?? e.viewer.displayId;
      if (this.isFxFrozen() && this.pendingOps.length < GIFT_FX_PENDING_OPS_MAX) {
        this.socialDiag(`受信 userId=${e.viewer.userId} → 凍結中 → 保留 +${cfg.followStep}`);
      }
      const followOp = (allowFx: boolean): void => {
        this.value += cfg.followStep;
        this.stats.follows++;
        this.socialDiag(`適用 +${cfg.followStep} nick=${JSON.stringify(nick ?? null)}(値 ${this.value})`);
        // atMs は e.tsMs(TikTokサーバ時刻)ではなくローカル時計。モニターの
        // 「5秒より古い演出はスキップ」判定と同じ時計で比較させるため。
        // 凍結明けの実行でも this.now() を読むので、このゲートで死なない。
        if (allowFx) {
          this.pushEffect({
            kind: 'follow',
            amount: cfg.followStep,
            nickname: nick,
            atMs: this.now(),
          });
        }
        this.dirty = true;
      };
      return this.applyOrQueue(
        () => followOp(true),
        // キュー溢れ時はバナーを捨てて値だけ適用する(gift 経路の縮退 op と同型)。
        // 以前は overflowOp が無く、フル op が凍結中に即時実行されてカットインの
        // 真上にフォローバナーが出ていた。
        () => followOp(false),
        // 凍結中の予告(演出ストック表示)。follow は 1 effect = 1人 なので count 無し。
        { kind: 'follow', ...(nick !== undefined ? { nickname: nick } : {}) }
      );
    }

    // 入室ルーレット。入室(action=1)で自動的に1スピン回り、出目をカウントへ
    // 即時適用する(ギフトルーレット同様、モニターのリールは確定済みの出目の
    // 遅延再生)。target:'first' なら初見さん(joinFirstEver)のみ、'all' なら誰でも。
    if (e.kind === 'join') {
      // action=1 のみ(events.ts の契約: 3 は SUBSCRIBED)。join に msgId は無いが、
      // seenJoiners の dedup が再接続バックログの二重適用ガードを兼ねる。
      if (e.action !== 1) return false;
      const jr = cfg.joinRoulette;
      if (!jr.enabled) return false;
      if (jr.target === 'first' && !joinFirstEver) return false;
      // dedup はクールダウンより先・凍結中も即時(seenFollowers と同じ規約)。
      // 逆順にすると「窓で捨てられた人が再入室で当たる」の非決定が生まれる。
      if (this.seenJoiners.has(e.viewer.userId)) return false;
      this.seenJoiners.add(e.viewer.userId);
      // レイド対策: 窓内の超過分は値ごと黙って捨てる(演出起点の機能なので値の
      // 完全性は要らない)。キューに積まない = モニターのルーレットキューと
      // リングバッファを入室だけで食い潰さない。窓は op の外で即時更新する —
      // 凍結中の保留に載った分も窓を進めないと、解除の瞬間にまとめて回る。
      const nowMs = this.now();
      if (nowMs - this.joinRouletteLastMs < JOIN_ROULETTE_MIN_GAP_MS) return false;
      this.joinRouletteLastMs = nowMs;
      const nickname = e.viewer.nickname ?? e.viewer.displayId;
      return this.applyOrQueue(() => {
        // ギフトルーレットと同じ骨格(抽選→値適用→pushEffect→maybeAchieve)。
        // 常に1スピン1リール — 連打の概念が無いので rouletteDrawCount は通さない。
        const idx = drawRouletteIndex(jr.segments, this.rand);
        const seg = jr.segments[idx]!;
        const amount = jr.direction === 'sub' ? -seg.amount : seg.amount;
        if (amount < 0) this.stats.joinDown += -amount;
        else this.stats.joinUp += amount;
        this.stats.rouletteSpins++;
        this.value = Math.max(0, this.value + amount);
        // 終盤の演出パターンは出目を引いたあと、出目の珍しさ(rarity)で段位を
        // 重み付けして引く(ギフト経路と同じ信頼度方式 — ガセありなので予告に
        // ならない。詳細は roulette-fx.ts の ROULETTE_TIER_WEIGHTS)。
        const pat = drawRoulettePattern(this.fxRand, jr.patterns, rouletteRarity(jr.segments, idx));
        this.pushEffect({
          kind: 'roulette',
          amount,
          rouletteSegments: jr.segments.map((s) => s.amount),
          rouletteIndex: idx,
          rouletteIndexes: [idx],
          roulettePattern: pat,
          roulettePatterns: [pat],
          rouletteReels: 1,
          ...(jr.direction === 'sub' ? { rouletteDirection: 'sub' as const } : {}),
          // label は validateJoinRoulette が空を許さないので必ず載る —
          // rouletteBoardKey がギフトルーレットと衝突しないのはこの label のおかげ。
          rouletteLabel: jr.label,
          // モニターはこの印で短縮(16 本目以降・合算 effect)と超焦らしカウントを
          // 免除する — 初見さんの1本は本数に関係なく常にフル尺・抽選パターンのまま。
          rouletteJoin: true,
          // 由来印 — モニターの専用キュー(優先度⑥)振り分けと rouletteBoardKey の
          // ギフトルーレット分離が読む。label での推定はユーザー編集で衝突しうる。
          rouletteOrigin: 'join',
          nickname,
          atMs: this.now(),
        });
        // 達成判定は pushEffect の**後**(ギフト経路と同じ id 順契約)。
        this.maybeAchieve(this.now()); // direction:'sub' なら 0 到達しうる
        this.dirty = true;
      }, undefined, { kind: 'roulette', nickname });
    }

    // 指定コメント = 妨害。キーワード部分一致で規則の量だけ増える(上から先勝ち)。
    // 連投対策は入れない — 打たれるたび毎回反応する(いいね妨害と同じ「祭り」方向。
    // ユーザーの明示選択)。二重適用を防ぐのは msgId dedup だけ。
    if (e.kind === 'comment') {
      // 再接続バックログの二重適用ガード(like と同じ)。規則ガードより前に通す —
      // 規則なしの間に届いた msgId も、後から規則を足した再配信では二重に数えない。
      if (!this.seenCommentMsgIds.add(e.msgId)) return false;
      // スタンプ(サブスクエモート)トリガー。コメント妨害より**先勝ち** — スタンプ
      // だけのメッセージは content が ' ' なのでキーワードに当たらないが、本文と
      // スタンプが同居するメッセージで両方発動する紛らわしさを作らない(fanStamp が
      // ギフト規則に対して果たすのと同じ役割)。emoteId は設定と突き合わせる唯一の
      // 手掛かりなので、載っていたら一致の成否まで必ず記録する(gift の受信行と同じ)。
      if (e.emoteIds !== undefined && e.emoteIds.length > 0) {
        const st = matchStampTriggers(cfg, e.emoteIds);
        this.stampDiag(
          `受信 emoteIds=[${e.emoteIds.join(',')}]` +
            (st ? ` → 一致 ×${st.count} 合計=${st.amount}` : ' → 不一致')
        );
        if (st) return this.applyStampTrigger(e.viewer, st);
      }
      // 規則は到着時点の cfg で確定させる(バンド判定と同じ規約 — 凍結明けに
      // 読み直すと、同じコメントの判定が設定変更のタイミングで揺れる)。
      const rule = matchCommentRule(cfg, e.content);
      if (!rule) return false;
      const nickname = e.viewer.nickname ?? e.viewer.displayId;
      const commentOp = (allowFx: boolean): boolean => {
        this.value += rule.amount; // 加算方向のみなので maybeAchieve もクランプも不要
        this.stats.commentUp += rule.amount;
        if (allowFx) {
          this.pushEffect({
            kind: 'comment',
            amount: rule.amount,
            nickname,
            commentKeyword: rule.keyword,
            atMs: this.now(),
          });
        }
        this.dirty = true;
        return true;
      };
      // キュー溢れ時はバナーを捨てて値だけ適用する(follow と同じ縮退)。
      return this.applyOrQueue(
        () => commentOp(true),
        () => commentOp(false)
      );
    }

    // スタンプ(サブスクエモート)単独メッセージ(WebcastEmoteChatMessage)。実データの
    // 本線はチャット添付(上の comment 分岐)だが、ライブラリはエモート専用型も
    // 定義しているので、どちらで届いても同じトリガーが効くようにする。
    if (e.kind === 'emote') {
      if (!this.seenEmoteMsgIds.add(e.msgId)) return false;
      const ids = e.emoteIds ?? (e.emoteId !== undefined ? [e.emoteId] : []);
      if (ids.length === 0) return false;
      const st = matchStampTriggers(cfg, ids);
      this.stampDiag(
        `受信(単独) emoteIds=[${ids.join(',')}]` +
          (st ? ` → 一致 ×${st.count} 合計=${st.amount}` : ' → 不一致')
      );
      if (!st) return false;
      return this.applyStampTrigger(e.viewer, st);
    }

    // いいね = 妨害。likeEvery 件ごとに likeStep 増える(余りは繰り越し)。
    if (e.kind === 'like') {
      // 再接続バックログの二重適用ガード(gift と同じ)。like は高頻度なので容量 1024。
      // 設定ガードより前に通す — いいね妨害が無効でもリザルトのランキングは集計する。
      if (!this.seenLikeMsgIds.add(e.msgId)) return false;
      // e.count は「このバッチのいいね数」(累計ではない — events.ts の契約)。
      const add = Math.max(0, e.count);
      if (add === 0) return false; // 件数ゼロのイベントで delta を出さない

      // イイネランキングはゲージ設定と独立に集計する(妨害 OFF でも順位は出す)。
      // dedup と同じく凍結中も即時 — 保留するのは値適用+演出だけ。
      this.touchParticipant(e.viewer).likes += add;
      // 順位が動いたので 2Hz tick に相乗りさせる(gift 経路と同じ判断)。これが
      // 無いと、いいね妨害が無効の設定ではモニター下部のライブ TOP3 が他の
      // イベントが来るまで更新されなかった。
      this.dirty = true;

      // ここから下は「いいね妨害」= カウント加算。無効なら値には触らない。
      if (cfg.likeEvery <= 0 || cfg.likeStep <= 0) return false;
      const likeOp = (allowFx: boolean): boolean => {
        this.likeCounter += add;
        // 区間集計は op の内側 — 凍結中の適用順を likeCounter(区間境界の定義)と
        // 揃える。閉包が e.viewer を掴むので到着時点のアバターURL が使える。
        this.tallySegment(e.viewer, add);
        const units = Math.floor(this.likeCounter / cfg.likeEvery);
        if (units === 0) {
          // 端数のみ — カウント値は不変だがゲージ(likeGauge.counter)は動く。
          // like は高頻度(全メッセージの約9割)なので即時 push はせず、
          // dirty だけ立てて 2Hz の定期 tick(drainIfChanged)に相乗りさせる。
          this.dirty = true;
          return false;
        }
        this.likeCounter -= units * cfg.likeEvery;
        this.likeFills += units;
        const amount = units * cfg.likeStep;
        this.value += amount; // 加算方向のみなので maybeAchieve もクランプも不要
        this.stats.likeUp += amount;
        this.likeFxPending += amount;
        // 演出は合算窓ごとに1件だけ(窓内の分は flushLikeFx がまとめて出す)。
        // 縮退時(allowFx=false)は積むだけ — 溜まった likeFxPending は次の
        // 通常経路か flushLikeFx がまとめて出す。
        const nowMs = this.now();
        if (allowFx) {
          // 過去時刻の記録なので未来はあり得ない — 時計の後方ステップで未来に
          // 取り残されると、演出がステップ幅ぶん抑止される(値は無事)。
          this.likeFxLastMs = clampFutureMs(this.likeFxLastMs, nowMs, 0);
          if (nowMs - this.likeFxLastMs >= LIKE_FX_WINDOW_MS) {
            this.pushEffect({ kind: 'like', amount: this.likeFxPending, atMs: nowMs });
            this.likeFxPending = 0;
            this.likeFxLastMs = nowMs;
          }
        }
        // 満タン = 区間の締め。1位を確定して集計をクリアする(ストック無効でも
        // 区間境界はゲージの機能なので必ず締める)。1バッチが複数区間を跨ぐ場合
        // (units >= 2)はバッチ全量を締めた区間に計上し、全スロットに同じ1位を
        // 積む — 表示用機能なので厳密な按分はしない(そのバッチの送り主が支配的
        // 貢献者であることがほぼ常)。
        const segTop = this.takeSegmentTop();
        // いいねストック: ゲージ満タン units 回ぶん点灯し、規定数で追加ボーナス(妨害)。
        // ゲージ有効(上の早期 return を抜けた)が前提の従属機能なので、ここに置く。
        if (cfg.likeStockCount > 0 && cfg.likeStockStep > 0) {
          this.likeStocks += units;
          for (let i = 0; i < units; i++) {
            this.stockSlots.push(segTop ?? { avatarUrl: null, nickname: null });
          }
          const stockUnits = Math.floor(this.likeStocks / cfg.likeStockCount);
          if (stockUnits > 0) {
            this.likeStocks -= stockUnits * cfg.likeStockCount;
            // 消費は FIFO(点灯順)。最後の1満杯ぶんを演出用に写す。
            const consumed = this.stockSlots.splice(0, stockUnits * cfg.likeStockCount);
            this.lastFullSlots = consumed.slice(-cfg.likeStockCount);
            this.stockFills += stockUnits;
            const bonus = stockUnits * cfg.likeStockStep;
            this.value += bonus; // 加算方向のみなので maybeAchieve もクランプも不要
            this.stats.likeStockUp += bonus;
            // 満杯はゲージ満タンより一桁稀なイベントなので合算窓は使わず即 push。
            if (allowFx) this.pushEffect({ kind: 'stock-full', amount: bonus, atMs: nowMs });
          }
        }
        this.dirty = true;
        return true;
      };
      // キュー溢れ時は演出(いいねバナー/ストック満杯)を捨てて値だけ適用する。
      // 以前は overflowOp が無くフル op が凍結中に即時実行され、「凍結中はいいね
      // バナーを出さない」規約が溢れ時だけ破れていた。
      return this.applyOrQueue(
        () => likeOp(true),
        () => likeOp(false)
      );
    }

    if (e.kind === 'gift') {
      // 再接続バックログの二重適用ガード(DB の INSERT OR IGNORE と同じ役割)。
      if (!this.seenGiftMsgIds.add(e.msgId)) return false;
      // ギフトランキングは規則に紐づかないギフトも数える — matchGiftRule の早期
      // return より前に置くこと(後ろに置くと、カウントに効かないギフトが
      // ランキングから消える)。dirty はここで立てる: モニターの TOP3 がこれを
      // 見ているので、増減規則にもバンドにも一致しないギフト(下の `!m && !band`)や
      // 凍結中に積まれたギフトでも順位は動かないといけない。戻り値 true にはしない —
      // 演出と違い、順位の 2Hz tick 相乗り(最大 500ms)は見て分からない。
      if (e.diamonds > 0) {
        this.touchParticipant(e.viewer).diamonds += e.diamonds;
        this.dirty = true;
      }

      // 受信そのものの記録。**giftName は原文のまま**出すこと — 設定側は小文字で
      // 保存する規約(validateGiftFullCut)なので、小文字化して出すと「実際に何が
      // 届いたか」が分からなくなり、この行の唯一の存在意義が消える。
      this.giftDiag(
        `受信 giftId=${e.giftId} giftName=${JSON.stringify(e.giftName ?? null)}` +
          ` type=${e.giftType ?? '-'} repeat=${e.repeatCount} 💎=${e.diamonds}` +
          ` canonical=${e.canonical ?? '-'}`
      );

      // ファンスタンプ(お助け)。ルーレット・giftRules・giftDefault の**どれよりも先**に
      // 評価し、一致したら増減の写像を丸ごと置き換える — ルーレットが giftRules に対して
      // 果たしているのと同じ「先勝ち」の役割(二重適用防止)。ルーレットより上に置くのは、
      // 同じ giftId を両方に登録された設定で「お助けのはずが数字が増える」という説明の
      // つかない挙動を作らないため。
      const fs = matchFanStamp(cfg, { canonical: e.canonical, giftId: e.giftId, giftName: e.giftName });
      // お助けは最初に評価され、一致すると増減の写像を丸ごと置き換える。設定した
      // giftId が合っているかを配信中に確かめる唯一の手掛かりなので必ず記録する
      // (ファンスタンプはカスタムギフトで、ID を取り違えても「効かない」としか見えない)。
      if (fs) this.giftDiag(`→ お助け(ファンスタンプ)一致 1個あたり=${fs.amountEach}`);

      // タップブースト(フィーバー)。fanStamp の**次・ルーレットより先**に評価する
      // (matchTapBoost の規約 — 同じ giftId を両方に登録した誤設定では fanStamp が
      // 勝つ)。一致したらこのギフトは増減規則を一切通らず「発動」だけが起きる —
      // トリガーギフト自体は値を動かさない(減るのは溜めたタップの一括反映)。
      // applyOrQueue 経由なので、進行中のカットイン/ブースト凍結中に届いた2本目は
      // ドレイン(前のブーストの清算後)で直列に発動する。
      const tb = fs ? null : matchTapBoost(cfg, { canonical: e.canonical, giftId: e.giftId, giftName: e.giftName });
      if (tb) {
        // ここで return するので全面カットは**評価すらされない**。同じギフトを
        // タップブーストと全面カットの両方に登録した設定で「カットインが出ない」
        // と見える唯一の説明なので、必ず記録する。
        this.giftDiag('→ タップブースト一致(全面カットは評価されません)');
        // 連打コンボは normalize.ts が1メッセージに畳むので、**repeatCount 回ぶん
        // 発動を積む**(ルーレットの rouletteDrawCount と同じ理由 — 見ないと
        // 「2個贈ったのにフィーバー1回」になる)。1本目が凍結を張るので、2本目
        // 以降は pendingOps に落ちて清算後に直列発動する。プレーンモードは凍結が
        // 無く activateBoost が前を即時清算してしまう(最後の1本しか残らない)
        // ため1回に畳む — どうせ演出も出ない。
        const times = this.fxAllowed() ? tapBoostActivationCount(e.repeatCount) : 1;
        if (times < e.repeatCount) {
          this.giftDiag(`→ ブースト連打 ${e.repeatCount}個 — 発動は${times}回に制限`);
        }
        let changed = false;
        const boostNick = e.viewer.nickname ?? e.viewer.displayId;
        for (let i = 0; i < times; i++) {
          if (
            this.applyOrQueue(
              () => this.activateBoost(tb, e),
              undefined,
              { kind: 'boost', nickname: boostNick },
              // critical: 溢れ弁の即時実行で activateBoost が凍結中に走ると、
              // 進行中のフィーバーを窓の途中で強制清算した上で凍結を最長 82 秒へ
              // 張り直す — 課金ギフトの発動なのでキャップを少し超えても積む。
              true
            )
          ) {
            changed = true;
          }
        }
        return changed;
      }

      // お邪魔(タップ封じ)。fanStamp・タップブーストの**次・ルーレットより先**。
      // 一致したらこのギフトはルーレットも増減規則も全面カットも通らない(先勝ち)。
      const tl = fs
        ? null
        : matchTapLock(cfg, { canonical: e.canonical, giftId: e.giftId, giftName: e.giftName });
      if (tl) {
        // ここで return するのでルーレット/全面カットは評価すらされない。記録が
        // 無いと giftId の打ち間違いが診断不能になる(タップブーストと同じ理由)。
        this.giftDiag(
          `→ お邪魔(タップ封じ)一致 id=${tl.id} ${tl.durationSec}秒(ルーレット/全面カットは評価されません)`
        );
        // **期限のラッチは applyOrQueue に通さず即時**。カットイン凍結中にキューへ
        // 落とすと、封印の開始が最長 45 秒(GIFT_FX_FREEZE_MAX_TOTAL_MS)、アーム中なら
        // 60 秒(BOOST_ARM_MAX_MS)後ろ倒しになり、しかもその間タップは押下凍結の分岐で
        // **普通に通る**(投げた視聴者から見て何も起きない)。さらに pendingOps が
        // 溢れると即時実行へ化けるので、負荷で挙動が変わってしまう。
        // dedup(seenGiftMsgIds)より後に居るのは必須 — 手動再接続のバックログ再生で
        // 毎回封印がかかるのを防ぐ。
        this.activateTapLock(tl, e);
        // 告知バナー(と amountEach ≠ 0 のときの値適用)だけは通常どおり凍結キューへ。
        // fx 予告は付けない — 予告(ChallengeFxQueueItem)はカットイン級の「待ち」を
        // 見せる仕組みで、封印は待たずに即発効している。
        const lockNick = e.viewer.nickname ?? e.viewer.displayId;
        const amount = tl.amountEach * e.repeatCount;
        const lockMs = this.tapLockTotalMs;
        const lockUntil = this.tapLockUntilMs ?? this.now();
        this.applyOrQueue(() => {
          // クランプは実行時(凍結明けの残量が基準 — clampDownAmount の doc 参照)。
          const applied = this.clampDownAmount(amount);
          if (applied < 0) this.stats.giftDown += -applied;
          else if (applied > 0) this.stats.giftUp += applied;
          this.value = Math.max(0, this.value + applied);
          const atMs = this.now();
          this.pushEffect({
            kind: 'tap-lock',
            amount: applied,
            nickname: lockNick,
            tapLockMs: lockMs,
            tapLockUntilMs: lockUntil,
            ...(tl.label !== '' ? { giftName: tl.label } : {}),
            ...(tl.flash ? { flash: true } : {}),
            atMs,
          });
          this.maybeAchieve(atMs);
          this.dirty = true;
        });
        return true;
      }

      // ギフトルーレット。複数登録できるが、回るのは上から見て最初に一致した1件だけ
      //(matchRoulette の先勝ち)。トリガー一致時は giftRules/giftDefault を評価しない —
      // ルーレットが増減の写像を置き換える(既定の perDiamond +1 との二重適用防止)。
      // 抽選も値適用もここで即時確定し、モニターは「確定済みの出目」を演出として
      // 遅延再生するだけ(like 着弾の据え置きと同じ解法)。
      //
      // 連打(giftType 1: バラ・指ハート等)は normalize.ts が repeatEnd で1件に
      // 畳んで repeatCount を載せてくるので、**1メッセージで repeatCount 回抽選する**。
      // heart_me は giftType 4 で1メッセージずつ届くため repeatCount は常に 1。
      // お助け一致時は matchRoulette 自体を評価しない — 抽選(this.rand)を消費させない。
      const rl = fs
        ? null
        : matchRoulette(cfg, { canonical: e.canonical, giftId: e.giftId, giftName: e.giftName });
      if (rl) {
        // タップブーストと同じ理由で記録する — ルーレットに登録したギフトは
        // 全面カットに同じ行を作っても永久に再生されない(先勝ちで早期 return)。
        this.giftDiag(`→ ルーレット一致 id=${rl.id}(全面カットは評価されません)`);
        // **抽選回数は贈られた個数そのもの**(rouletteDrawCount)。演出用の
        // giftRepeatFx.max は掛けない — 掛けると視聴者が贈った個数ぶんの値が消える
        // (v0.5.4 の不具合: バラ17連打が5回ぶんしか反映されなかった)。
        const draws = rouletteDrawCount(e.repeatCount);
        return this.applyOrQueue(() => {
          // 出目は**1 effect にまとめて**載せる(dto.ts の rouletteIndexes 参照)。
          // 1スピン1 effect にすると、17連打がリングバッファを一撃で溢れさせ、
          // 履歴ログも1ギフトで17行に膨れる(「履歴ログは1件のまま」規約に反する)。
          const idxs: number[] = [];
          const pats: RoulettePattern[] = [];
          let total = 0;
          // 激熱確定(行ごとの設定・100% 発動)。1 = 通常のルーレットで、以下の式は
          // 従来と 1 バイトも変わらない。検証(validateRouletteHot)が direction:'sub' の
          // 行から hot を落とすので、ここで向きを再判定する必要はない。
          // 二重防御で direction も見る — 検証は 'sub' の行から hot を落とすが、
          // 手編集の settings.json が通ってきたときに 0 クランプ(this.value の
          // Math.max(0, ...))とモニターの据え置き会計がズレるのを防ぐ。
          const hotMult = rl.direction === 'sub' ? 1 : rouletteHotMultiplier(rl.hot);
          for (let i = 0; i < draws; i++) {
            const idx = drawRouletteIndex(rl.segments, this.rand);
            const seg = rl.segments[idx]!;
            // **倍率込みで適用する。** モニター側の復元(shared の rouletteDraws)も
            // 同じ式なので、据え置き会計と worker の値が常に一致する。
            const amount = (rl.direction === 'sub' ? -seg.amount : seg.amount) * hotMult;
            if (amount < 0) this.stats.giftDown += -amount;
            else this.stats.giftUp += amount;
            this.stats.rouletteSpins++;
            this.value = Math.max(0, this.value + amount);
            total += amount;
            idxs.push(idx);
            // 終盤の演出パターンも effect に載せる。出目を引いたあと、出目の
            // 珍しさ(rarity)で段位を重み付けして引く — パチンコの信頼度方式。
            // レア出目ほど激アツが出やすいがガセもある(結果の確定予告にはならない。
            // 詳細は roulette-fx.ts の ROULETTE_TIER_WEIGHTS)。fxRand の消費は
            // 従来どおり1抽選1回 — 出目(this.rand)の再現性には影響しない。
            // 激熱確定は絵柄を3種(獅子・黄金龍・不死鳥)に固定する — 導入動画と
            // スピンの絵を対にする仕様なので、行の patterns(チェック)は見ない。
            // **fxRand の消費はどちらの枝でもちょうど1回**(drawRoulettePattern の規約)。
            pats.push(
              drawRoulettePattern(
                this.fxRand,
                hotMult > 1 ? ROULETTE_HOT_PATTERNS : rl.patterns,
                rouletteRarity(rl.segments, idx)
              )
            );
            // 0 到達したら残りは回さない(達成後のイベントは元のタイムラインでも
            // 無視されるため — flushFxFreeze と同じ判断)。direction:'sub' のみ起きる。
            if (this.value === 0) break;
          }
          this.pushEffect({
            kind: 'roulette',
            // amount は effect 全体の合計。1回ぶんの増減は rouletteDraws が
            // rouletteSegments と rouletteDirection から復元する。
            amount: total,
            rouletteSegments: rl.segments.map((s) => s.amount),
            rouletteIndex: idxs[0]!,
            rouletteIndexes: idxs,
            roulettePattern: pats[0]!,
            roulettePatterns: pats,
            // 見た目の尺だけ到着時点の cfg で確定させて焼き込む(fxRepeat と同じ流儀)。
            // **値は idxs.length 回ぶん適用済み** — ここで削れるのはリール本数だけ。
            rouletteReels: rouletteReelCount(cfg, idxs.length),
            // 激熱確定の実倍率。通常は**キーごと出さない**(既存 effect と同一の形)。
            // rouletteBoardKey に入るので、これがあるだけで畳み込みも分離される。
            ...(hotMult > 1 ? { rouletteHotMult: hotMult } : {}),
            ...(rl.direction === 'sub' ? { rouletteDirection: 'sub' as const } : {}),
            // 表示名も effect に載せて自己完結させる(モニターの cfg は 120秒
            // ポーリング(CFG_POLL_MS)で古くなりうる — rouletteSegments と同じ理由)。
            ...(rl.label !== '' ? { rouletteLabel: rl.label } : {}),
            // 行の同一性。**音そのものは載せない** — モニターが resolveRouletteSound で
            // cfg から引き直す(dto.ts の rouletteId / RouletteSoundConfig 参照)。
            // こうしておくと、キュー待ちのスピンにも設定変更が即時に効く。
            rouletteId: rl.id,
            nickname: e.viewer.nickname ?? e.viewer.displayId,
            ...(e.giftName ? { giftName: e.giftName } : {}),
            ...(e.repeatCount > 1 ? { giftCount: e.repeatCount } : {}),
            ...(e.iconUrl ? { giftIconUrl: e.iconUrl } : {}),
            diamonds: e.diamonds,
            atMs: this.now(),
          });
          // 達成判定は pushEffect の**後**。先に呼ぶと achieved effect の id が
          // ルーレットより小さくなり、モニターが CLEAR を先に再生してしまう。
          this.maybeAchieve(this.now()); // direction:'sub' なら 0 到達しうる
          this.dirty = true;
        }, undefined, {
          kind: 'roulette',
          nickname: e.viewer.nickname ?? e.viewer.displayId,
          // 予告の ×N は**モニターのキュー行(rouletteStockCount)と同じ規約** —
          // 抽選回数。ただしリールが1本に絞られる設定(rouletteEnabled=false)では
          // 本数。ここだけ本数にすると、凍結が明けて予告行がキュー行へ入れ替わる
          // 瞬間に ×20 → ×47 と数字が跳ねる(値は最初から draws ぶん動いている)。
          // draws は op 実行前の値なので、direction:'sub' で 0 到達 break した
          // ときだけ実 effect より多く出る(≤v0.7.8 の rouletteReelCount(cfg, draws)
          // も同じ draws を見ていたので、新規の劣化ではない)。
          count: rouletteReelCount(cfg, draws) === 1 ? 1 : draws,
        });
      }

      // e.diamonds は normalize.ts が diamondEach × repeatCount を一度だけ計算した
      // 確定値。ここでは絶対に再計算しない(全体規約)。
      // バンド(ダイヤ帯域カットイン)も到着時点の設定で確定する — 凍結明けの
      // 実行時に設定を読み直すと、同じギフトの判定が設定変更のタイミングで
      // 揺れるため。増減規則に一致しないギフトでもバンド一致なら演出は出す
      // (overFlash の「規則が空でも照明だけは出す」と同じ精神)。
      //
      // お助けの「1個につき -N」は **repeatCount 基準**。diamonds(= diamondEach ×
      // repeatCount)を使うと、2ダイヤ以上のカスタムギフトを作られた瞬間に N 倍ずれる。
      // repeatCount も normalize.ts の確定値で、ここでは再計算しない(diamonds と同じ規約)。
      const m = fs
        ? {
            amount: fs.amountEach * Math.max(1, e.repeatCount),
            // 高額ギフトの照明は規則を問わず出す(matchGiftRule の overFlash と同じ精神)。
            flash: fs.flash || (cfg.flashMinDiamonds != null && e.diamonds >= cfg.flashMinDiamonds),
          }
        : matchGiftRule(cfg, { canonical: e.canonical, giftId: e.giftId, diamonds: e.diamonds });
      // カットイン抑止。giftBandFx.excludeGiftIds は書き換えない(設定の二重管理を作らない)。
      // 両方 null なら fxDurationMs は 0 になり、下の `if (cutClip)` を通らないので
      // **凍結も張られない** — 1ダイヤのファンスタンプが届くたびに 6 秒カウントが
      // 止まる事故を、専用フラグを増やさずに塞ぐ。
      //
      // 全面カット(giftFullCut)は**ダイヤ数帯(giftBandFx)より先に評価**する。
      // 一致したら帯域は評価すらしない — 「バラなら必ずバラのカットイン」を、
      // ダイヤ数がどの帯に入るかと無関係に成立させるため(ユーザー要件の優先度)。
      // suppressBandFx は全面カットにも効かせる。この印は「このギフトではカット
      // インを一切出さない」という意味で付いており、1ダイヤ高頻度のファンスタンプが
      // 5 秒カウントを止める事故は帯域と全面カットのどちらでも同じだから。
      const fullCut =
        fs?.suppressBandFx === true
          ? null
          : matchGiftFullCut(cfg, { canonical: e.canonical, giftId: e.giftId, giftName: e.giftName });
      const band =
        fs?.suppressBandFx === true || fullCut
          ? null
          : matchGiftBand(cfg, { canonical: e.canonical, giftId: e.giftId, diamonds: e.diamonds });
      // 全面カットの成否。**外れたときこそ出す** — 42行のトリガーは giftId が空の
      // ものが多く英語ギフト名の推定に頼っているので、「届いたのに一致しなかった」
      // が分からないと直しようがない(v3 で40行が無言のまま死んでいた原因)。
      this.giftDiag(
        fs?.suppressBandFx === true
          ? '→ お助け(suppressBandFx)によりカットインは抑止'
          : fullCut
            ? `→ 全面カット一致 id=${fullCut.id} clip=${fullCut.clip}`
            : `→ 全面カット不一致 → 帯域=${band ? band.id : 'なし'}`
      );
      if (!m && !band && !fullCut) return false;
      const giftOp = (allowBand: boolean): void => {
        // 応援(負)方向は残量でクランプ(clampDownAmount の doc 参照)。
        const amount = this.clampDownAmount(m?.amount ?? 0);
        if (amount < 0) this.stats.giftDown += -amount;
        else if (amount > 0) this.stats.giftUp += amount;
        this.value = Math.max(0, this.value + amount);
        const atMs = this.now();
        const b = allowBand ? band : null;
        const fc = allowBand ? fullCut : null;
        // 全面カットと帯域カットインはモニターから見ると同じ1本のカットイン
        // (同じ <video> 枠・同じ据え置き・同じ凍結)。違うのは「誰が選んだか」と
        // 音の出どころだけなので、ここで1組に畳んでから effect へ焼き込む。
        const cutClip = fc ? fc.clip : b ? b.clip : null;
        const cutDurationSec = fc ? fc.durationSec : (b?.durationSec ?? 0);
        // 動画長ではなく設定の秒数が権威(モニターは loop + タイマーで合わせる)。
        const fxDurationMs = cutClip ? Math.min(cutDurationSec * 1000, GIFT_FX_FREEZE_MAX_MS) : 0;
        // 連打ギフトの演出反復。**値は1回ぶんのまま** — amount/valueAfter/diamonds/
        // stats/ランキング/履歴ログは連打全体を1件で表す規約を維持し、反復するのは
        // モニターの見た目だけ。回数はここ(到着時点の cfg)で確定させ effect に
        // 焼き込む — fxBandClip と同じ「effect 1件で自己完結」の流儀。
        const rep = giftFxRepeat(cfg, e.repeatCount, { banded: cutClip != null, fxDurationMs });
        this.pushEffect({
          kind: 'gift',
          amount,
          ...(m?.flash ? { flash: true } : {}),
          // お助け(ファンスタンプ)の印。モニターはこれを見てギフトカードの代わりに
          // 専用バナーを出す — cfg を引き直させないため effect 側へ焼き込む
          // (fxBandClip と同じ流儀)。判定は到着時点の fs で確定している。
          ...(fs ? { fanStamp: true as const } : {}),
          nickname: e.viewer.nickname ?? e.viewer.displayId,
          ...(e.giftName ? { giftName: e.giftName } : {}),
          // 連打数。diamonds と同じく normalize.ts の確定値をそのまま載せる。
          ...(e.repeatCount > 1 ? { giftCount: e.repeatCount } : {}),
          ...(e.iconUrl ? { giftIconUrl: e.iconUrl } : {}),
          // バナー合流のキー(下の coalesce)と履歴に使う(増減量の判定とは別経路)。
          ...(e.canonical ? { canonical: e.canonical } : {}),
          // カットインは effect 1件で自己完結させる(rouletteSegments と同じ流儀)。
          ...(cutClip ? { fxBandClip: cutClip, fxDurationMs } : {}),
          // 全面カットの印。モニターはこれを見て mp4 の焼き込み音声を鳴らす
          //(帯域カットインは muted のままで、音は下の fxBandBgm 側)。
          ...(fc ? { fxFullCut: true as const } : {}),
          // BGM も同じ流儀で id を effect に載せる(音量だけは cfg から読む)。
          // 判定は到着時点の cfg — fxBandClip と同じタイミングで確定させる。
          // 全面カット(fc)には載せない — 音声は素材に焼き込んであるので、
          // 別BGMを重ねると二重に鳴る。
          ...(b && b.bgm !== 'off' && cfg.giftBandFx.bgmEnabled ? { fxBandBgm: b.bgm } : {}),
          ...(rep > 1 ? { fxRepeat: rep, fxRepeatIntervalMs: cfg.giftRepeatFx.intervalMs } : {}),
          diamonds: e.diamonds,
          atMs,
        });
        // 凍結はトリガーギフト自身の値適用+push の後に張る — valueAfter 規約を
        // 守りつつ、以降のイベントを演出明けまで保留する。
        // カットインを反復する場合はモニターが尺ぶん直列で流すので、総尺で凍結する
        // (giftFxRepeat が GIFT_FX_FREEZE_MAX_TOTAL_MS で回数を削り済み)。
        // fxAllowed: モニターが実際にカットインを再生できる(窓が開いていて
        // reduced-motion でない)と名乗り出ているときだけ凍結する — 再生されない
        // カットインのためにカウントダウンだけ止まる事故を防ぐ(effect への
        // fxBandClip 焼き込みは無条件のまま: 履歴・後から開いたモニターのため)。
        if (cutClip && this.fxAllowed()) {
          this.fxFreezeUntilMs = atMs + fxDurationMs * rep + GIFT_FX_FREEZE_MARGIN_MS;
          this.armFreezeTimer();
        } else if (cutClip) {
          // 一致したのに再生も一時停止もされない唯一の経路。モニター窓が閉じている
          // (または reduced-motion)ときで、症状は「設定は合っているのに何も起きない」。
          this.giftDiag(`→ カットイン ${cutClip} は再生されません(モニター未表示 / 動きの抑制)`);
        }
        // お助け(ファンスタンプ)の合算窓を張る。**この1件の見た目が終わる時刻**が窓の終端:
        // カットイン無しなら浮上バナーの尺、カットイン有りなら凍結明け(バナーは
        // finishBandFx = カットイン終了時に出るので、そのぶん長い側が正しい)。
        // 窓の中に届いた次のお助けは pushEffect も凍結もせず合算へ回る。
        if (fs) {
          this.fanStampFxUntilMs = Math.max(
            atMs + FAN_STAMP_FX_WINDOW_MS,
            this.fxFreezeUntilMs ?? 0
          );
        }
        this.maybeAchieve(atMs);
        this.dirty = true;
      };
      // お助けの合算窓の中なら「縮退 op」を渡す — 値・統計だけ適用し、演出(バナー/
      // 効果音/簡易演出/カットイン)は撃たずに合算へ積む。見た目は flushFanStampFx が
      // 窓明けに1件だけ出す。
      //
      // 判定は**到着時点**で行う(凍結中でも同じ)。凍結明けの実行時に判定すると、
      // カットインが明けた瞬間に保留分が全員「先頭」に見えてカットインが N 本連鎖する —
      // 直そうとしている症状そのもの。
      //
      // applyOrQueue の外側は一切変えない: 凍結中は縮退 op も pendingOps へ積まれ
      // (「凍結中は値も保留」の既存契約を維持)、凍結明けの drain で到着順に走る。
      // **縮退 op は凍結を張り直さない**ので flushFxFreeze のループが break せず、
      // 保留分が1回のドレインで全部消化される = カットインは先頭の1本だけになる。
      //
      // fs が真なら m は必ず非 null(fs 一致時は m を必ず組み立てているので、
      // 上の「!m && !band && !fullCut なら return false」を通らない)。
      if (fs && this.fanStampFxUntilMs !== null) {
        // 時計の後方ステップで窓が未来に固着すると、以後のお助けが延々と合算に
        // 回り続ける(バナーが出ない)。正当な最大先行幅は「窓長」か「凍結明け」
        // の長い方(:1072 の張り方と同じ形)— 短縮方向にのみ働く。
        const gNow = this.now();
        this.fanStampFxUntilMs = clampFutureMs(
          this.fanStampFxUntilMs,
          gNow,
          Math.max(FAN_STAMP_FX_WINDOW_MS, (this.fxFreezeUntilMs ?? 0) - gNow)
        );
      }
      if (fs && this.fanStampFxUntilMs !== null && this.now() < this.fanStampFxUntilMs) {
        return this.applyOrQueue(() => this.fanStampCoalesceOp(e, m!.amount, m!.flash === true));
      }
      // キュー溢れ時はカットイン(と再凍結)を捨てて値だけ適用する(値の正しさ優先)。
      // 予告(fx)はカットインが実際に付くギフトだけ — バナーだけのギフトは
      // ストック表示に出さない(モニター側の表示対象と揃える)。
      // count(×N)は giftOp の rep(:cutClip/fxDurationMs → giftFxRepeat)と同じ式を
      // 到着時点の cfg で評価する — 予告と実再生の回数を一致させるため。
      return this.applyOrQueue(
        () => giftOp(true),
        () => giftOp(false),
        fullCut || band
          ? {
              kind: 'band',
              nickname: e.viewer.nickname ?? e.viewer.displayId,
              count: giftFxRepeat(cfg, e.repeatCount, {
                banded: true,
                fxDurationMs: Math.min(
                  (fullCut ? fullCut.durationSec : (band?.durationSec ?? 0)) * 1000,
                  GIFT_FX_FREEZE_MAX_MS
                ),
              }),
            }
          : undefined
      );
    }

    return false;
  }

  /**
   * 設定変更の反映。値の差し替えは未開始(リセット直後)のときだけだが、
   * dirty は常に立てる — get() が設定から生で読む title/initialValue の変更を
   * 次の delta でモニターへ届けるため(呼び出し元は実差分時のみ呼ぶ)。
   */
  onConfigChanged(): void {
    if (this.startedMs === null && this.status === 'idle') {
      this.value = this.getConfig().initialValue;
    }
    // 機能そのものを OFF にしたら封印も解除する — 「チャレンジを止める」が固着した
    // 封印からの逃げ道であり続けるため(main のホットキー登録もここで外れる)。
    // 行ごとの enabled: false では既存の封印を消さない(到着時点で確定の規約)。
    if (!this.getConfig().enabled) {
      if (this.tapLockUntilMs !== null) {
        this.clearTapLock();
        this.armFreezeTimer();
      }
      // フィーバーと凍結も逃げ道に含める — 封印だけ解除しても、アーム済みの
      // フィーバーが 60 秒後の期限切れで「無効化済み機能の全画面演出」を強制発動し、
      // 凍結が保留 op を抱えたまま生き続けていた。stop() と同じ規約で畳む:
      // まだ何も動いていない予約は無言で破棄、進行中の窓は清算して溜めタップを
      // 闇に落とさない、保留 op は値だけ強制適用する(受け取り済みのギフト/いいねを
      // 消さない)。
      if (
        this.armedBoost !== null ||
        this.boostUntilMs !== null ||
        this.fxFreezeUntilMs !== null ||
        this.pendingOps.length > 0
      ) {
        this.stopping = true;
        try {
          this.armedBoost = null;
          this.settleBoost(this.now(), true);
          this.forceApplyPendingOps();
        } finally {
          this.stopping = false;
        }
      }
      // ▶実演の窓も一緒に畳む — OFF 後の press が実演カウンタへ吸われない。
      this.clearTestBoost();
    }
    this.dirty = true;
  }

  // ── スナップショット ─────────────────────────────────────────────────────

  /** dirty を落とさないスナップショット。 */
  get(): ChallengeState {
    const cfg = this.getConfig();
    // モニター下部のライブランキング。result(TOP5)と違い走行中も載せる —
    // モニターにとって唯一のランキング情報源で、増えるアバターURL も3本だけ。
    const runRank = this.topRankCached('diamonds', CHALLENGE_MONITOR_TOP_N);
    // 凍結中にワーカーで待っている演出付きイベントの予告(モニターの演出ストック
    // 表示用)。凍結中は effect が recentEffects に載らないため、これが無いと
    // 表示がその間だけ盲目になる。
    const fxQueue = this.pendingOps
      .filter((p) => p.fx !== null)
      .slice(0, CHALLENGE_FX_QUEUE_MAX)
      .map((p) => p.fx!);
    return {
      status: this.status,
      value: this.value,
      initialValue: cfg.initialValue,
      title: cfg.title,
      startedMs: this.startedMs,
      achievedMs: this.achievedMs,
      stats: { ...this.stats },
      // ring が変わったときだけコピーし直す(effectsSnapshot のコメント参照)。
      recentEffects: (this.effectsSnapshot ??= this.recentEffects.map((e) => ({ ...e }))),
      // 設定から生で読むので likeEvery/likeStep の変更も次の delta で同期する。
      likeGauge:
        cfg.likeEvery > 0 && cfg.likeStep > 0
          ? {
              counter: this.likeCounter,
              every: cfg.likeEvery,
              step: cfg.likeStep,
              fills: this.likeFills,
              stock:
                cfg.likeStockCount > 0 && cfg.likeStockStep > 0
                  ? {
                      count: cfg.likeStockCount,
                      filled: this.likeStocks,
                      step: cfg.likeStockStep,
                      fills: this.stockFills,
                      // 長さは filled に揃える(通常は stockSlots と同数だが防御的に
                      // null 埋め/切り詰め)。要素は不変なのでコピー不要 — worker→main
                      // は structuredClone を通る(result と同じ理由)。
                      slots: Array.from({ length: this.likeStocks }, (_, i) => this.stockSlots[i] ?? null),
                      lastFullSlots: this.lastFullSlots,
                    }
                  : null,
            }
          : null,
      // 達成中だけ載せる — running 中に載せるとアバターURL 10 本(ギフト+イイネの
      // TOP5 ぶん)が 2Hz の delta 全部に乗る。生成後は書き換えないので、コピーせず
      // 同じ参照を返してよい(worker→main は postMessage の structuredClone を通る)。
      result: this.status === 'achieved' ? this.result : null,
      // 該当者がいなければキーごと省く(未開始・リセット直後は delta を太らせない)。
      ...(runRank.length > 0 ? { runRank } : {}),
      // 手動の全画面ランキング。**キーの有無がそのまま表示状態**なので、
      // 該当者ゼロでも rankShown なら必ず載せる(runRank と規約が違う点に注意) —
      // 参加者がまだ居ないことをモニターが「—」で見せる必要があるし、
      // ダッシュボードのボタン文言もこのキーの有無だけで決まる。
      // 走行中も毎 delta で組み直すので順位はライブに動く(result は凍結値)。
      ...(this.rankShown ? { rankBoard: this.buildResult(this.now()) } : {}),
      fxFreezeUntilMs: this.fxFreezeUntilMs,
      // 0 のときはキーごと省く(runRank と同じ「2Hz の delta を太らせない」規約)。
      ...(this.pressDownTotal > 0 ? { pressDownTotal: this.pressDownTotal } : {}),
      // 空ならキーごと省く(runRank と同じ「2Hz の delta を太らせない」規約)。
      ...(fxQueue.length > 0 ? { fxQueue } : {}),
      // ブースト中だけ載せる(モニターのタップカウンタの唯一のソース)。press RPC は
      // nudge を通るのでタップのたびに即時 delta で届く。▶テスト実演のウィンドウ中も
      // 同じ形で載せる — モニターの表示コードは実発動と実演を区別しなくてよい。
      ...(this.boostUntilMs !== null
        ? {
            boost: {
              tapCount: this.boostTapCount,
              startsAtMs: this.boostStartMs,
              endsAtMs: this.boostUntilMs,
              multiplier: this.boostMultiplier,
              pressStep: this.boostPressStep,
            },
          }
        : this.testBoostUntilMs !== null && this.now() < this.testBoostUntilMs
          ? {
              boost: {
                tapCount: this.testBoostTapCount,
                startsAtMs: this.testBoostStartMs,
                endsAtMs: this.testBoostUntilMs,
                multiplier: this.testBoostMultiplier,
                pressStep: this.testBoostPressStep,
              },
            }
          : {}),
      // 最終ゲートがアクティブな間だけ載せる(boost/tapLock と同じ「非アクティブ時は
      // キーごと省く」規約)。ブーストウィンドウ・起動カットイン中(boostUntilMs 非 null)は
      // タップがゲート免除なので省く — モニターのリングもフィーバー演出に譲る。
      ...(cfg.finalGate.enabled &&
      this.status === 'running' &&
      this.boostUntilMs === null &&
      this.value > 0 &&
      this.value <= cfg.lowThreshold
        ? { gauntlet: { taps: this.gauntletTaps, needed: cfg.finalGate.taps } }
        : {}),
      // お邪魔(タップ封じ)中だけ載せる(boost と同じ規約 — 絶対時刻のみ・非封印時は
      // キーごと省く)。blocked は「押したのに効かない」手応えの唯一のソース。
      ...(this.tapLockUntilMs !== null
        ? {
            tapLock: {
              startsAtMs: this.tapLockStartMs,
              endsAtMs: this.tapLockUntilMs,
              blocked: this.tapLockBlocked,
              ...(this.tapLockNickname !== '' ? { nickname: this.tapLockNickname } : {}),
              ...(this.tapLockLabel !== '' ? { label: this.tapLockLabel } : {}),
            },
          }
        : {}),
    };
  }

  /** 変化していたら1回だけ状態を返す(pushDelta の相乗り用)。 */
  drainIfChanged(): ChallengeState | null {
    // 2Hz tick が凍結解除の安全弁 — イベントが途絶えても最大 500ms 遅れで解除する。
    this.flushFxFreeze(this.now());
    // ▶テスト実演の期限切れも tick で拾う — press() の lazy 掃除だけだと、press が
    // 来ないまま期限が切れたとき get() が boost キーを黙って省くだけで dirty が
    // 立たず、モニターが最後の delta の古いタップカウンタを保持し続ける。
    if (this.testBoostUntilMs !== null && this.now() >= this.testBoostUntilMs) {
      this.clearTestBoost();
      this.dirty = true;
    }
    this.flushLikeFx();
    this.flushFanStampFx();
    if (!this.dirty) return null;
    this.dirty = false;
    return this.get();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  // ── カットイン凍結(fxFreeze) ────────────────────────────────────────────

  private isFxFrozen(): boolean {
    return this.fxFreezeUntilMs !== null;
  }

  /**
   * **幕が上がっているか**(= 押下の演出を畳む理由が実在するか)。
   *
   * fxFreezeUntilMs は無関係な2つの仕事を1つのラッチでやっている:
   *  - 仕事A(順序): この値・演出を今適用してよいか → **アーム時点で始まる必要がある**
   *    (applyOrQueue の連打直列化が isFxFrozen() に依存している)
   *  - 仕事B(舞台の沈黙): 音をぶつける幕が今そこにあるか → **幕が上がった時に始まるべき**
   * 同じ boolean だと B が最大 BOOST_ARM_MAX_MS(60秒)早く始まり、アーム済みで
   * まだ何も映っていない間の押下が無音になる(ユーザー報告「ブースト演出は始まる前に
   * 音量が消える」のタップ音側)。押下は値へ即時に効いているのに手応えだけが無い状態。
   *
   * **健全性の根拠**: applyOrQueue は凍結中の critical op を**積むか捨てるかしかしない**
   * (即時実行の枝が無い)。つまり activateBoost が走れたということはその瞬間 worker は
   * 非凍結 = 帯域/全面カット/ブーストの幕は出ていない。アーム中に画面へ出られるのは
   * worker が凍結しないルーレットと ±N バナーだけで、**ルーレット中の押下音は
   * 今日でも普通に鳴っている**(非凍結なので)— 新しい音の重なり方を1つも増やさない。
   *
   * commitBoost / commitArmedBoostIfExpired / plainCommitArmedBoost が armedBoost を
   * null にした瞬間に「幕が上がった」へ切り替わる。コミットの契機はモニターの実再生開始
   * (challenge.boostCue)なので、**音の切り替えと映像の開始が構造的に同期する**。
   *
   * **使ってよいのは演出(effect)を出すか畳むかの判定だけ。** 値・stats・
   * pressDownTotal・maybeAchieve の先送りは従来どおり isFxFrozen() で決めること —
   * こちらへ寄せると、アーム中に 0 へ到達した押下がフィーバー前に CLEAR を出す。
   *
   * ※ 将来ルーレットでも凍結を張るようにしたらこの前提が崩れる。必ず見直すこと
   *   (challenge-boost-arm-audio.spec.ts の「帯域凍結では畳む」が検出器)。
   */
  private fxCurtainUp(): boolean {
    return this.isFxFrozen() && this.armedBoost === null;
  }

  /** 凍結期限に合わせてワンショットタイマーを張り直す(null なら外すだけ)。 */
  private armFreezeTimer(): void {
    if (this.freezeTimer !== null) {
      clearTimeout(this.freezeTimer);
      this.freezeTimer = null;
    }
    // アームの期限も**このタイマーが唯一の出口**。配信終了後は 2Hz tick も
    // イベント入口も無いので、ここで見ないと予約が永久に解決しない。
    if (
      this.fxFreezeUntilMs === null &&
      this.armedBoost === null &&
      this.tapLockUntilMs === null &&
      this.boostUntilMs === null
    ) {
      return;
    }
    // +25ms: flushFxFreeze の「期限ちょうど」比較を確実に越えてから発火する。
    // 早い方で起こす — 凍結の暫定期限はアーム期限より必ず後(前置き+ウィンドウぶん)。
    const at = Math.min(
      this.fxFreezeUntilMs ?? Infinity,
      this.armedBoost?.deadlineMs ?? Infinity,
      // お邪魔(タップ封じ)もこのタイマーが唯一の出口 — 配信終了後は 2Hz tick も
      // イベント入口も無いので、ここで見ないとボタンが死んだまま次の配信へ行く。
      this.tapLockUntilMs ?? Infinity,
      // **タップ窓の期限(= 清算の期限)もこのタイマーが起こす。** 凍結期限は清算より
      // resultMs + BOOST_SETTLE_BUDGET_MS + GIFT_FX_FREEZE_MARGIN_MS(結果カット
      // シーン込みで最大 ~8.7秒)後ろなので、これが無いと 2Hz tick(drainIfChanged)が
      // 止まった瞬間 — 配信終了・切断・リプレイ終了 — に boost-end がその尺ぶん
      // 遅れて出る。モニターの安全弁は窓終了 + BOOST_EXPIRE_MARGIN_MS(3秒)なので
      // 必ず先に発火し、expireBoostFx が据え置きごと畳んで**清算発表(結果カット
      // シーン → ロールアップ → 着弾)が丸ごと出ない**。2Hz tick は「最大 500ms
      // 遅れ」の相乗りであって権威ではない — settleBoost に自前の時計を持たせる。
      this.boostUntilMs ?? Infinity
    );
    const delay = Math.max(0, at - this.now()) + 25;
    const t = setTimeout(() => {
      this.freezeTimer = null;
      this.flushFxFreeze(this.now());
      // 早発(注入時計 = Date.now と libuv の単調時計のズレ。NTP 巻き戻しや
      // サスペンド/レジュームで起きる)だと flushFxFreeze が冒頭の
      // 「nowMs < fxFreezeUntilMs なら return」で戻るため、**タイマーだけ消えて
      // 凍結が残る**。配信終了後は 2Hz tick もイベント入口も無いので、ここで
      // 張り直さないと凍結と保留 op が次の RPC まで永久に解除されない。
      // ドレインまで到達した経路は末尾で既に張り直しているので、null ガードで
      // 二重張り(= onFreezeExpired が2回飛ぶ)を防ぐ。
      // 張り直しの delay は「残りのズレ + 25ms」なので、時計が追いつけば収束する。
      if (
        (this.fxFreezeUntilMs !== null ||
          this.armedBoost !== null ||
          this.tapLockUntilMs !== null ||
          this.boostUntilMs !== null) &&
        this.freezeTimer === null
      ) {
        this.armFreezeTimer();
      }
      if (this.dirty) this.onFreezeExpired?.();
    }, delay);
    // worker の shutdown をこのタイマーが引き留めない(テストの後始末も同様)。
    (t as { unref?: () => void }).unref?.();
    this.freezeTimer = t;
  }

  /**
   * 凍結期限タイマー発火時の通知先(session.nudgeChallenge)。配信終了後は
   * 2Hz tick が止まり drainIfChanged が呼ばれない — このコールバックが無いと
   * 「カットイン中に配信が切れる」と凍結と保留 op が次の RPC まで無期限残留する。
   */
  setOnFreezeExpired(cb: (() => void) | null): void {
    this.onFreezeExpired = cb;
  }

  /** モニターの実効再生能力。両方 true のときだけカットイン凍結を張る。 */
  private fxAllowed(): boolean {
    return this.monitorOpen && this.monitorBandFx;
  }

  /**
   * ギフト判定の診断ログ。**呼び出し元は handleEvent の gift 経路だけ**で、
   * そこは冒頭の `status !== 'running'` で弾かれているので、チャレンジ実行中しか出ない。
   *
   * 出口は constructor の `diag`(既定は stdout)。出す内容は「実際に届いた値」と
   * 「どの段で捕まったか」に限る。42行のトリガーは giftId が空のものが多く英語
   * ギフト名の推定に頼っているので、外れたときに何も残らないのが最大の弱点だった
   * (v3 で40行が無言のまま死んだ)。
   */
  private giftDiag(message: string): void {
    this.diag(`[challenge/gift] ${message}`);
  }

  /**
   * フォロー妨害の診断ログ。giftDiag と同じ出口(constructor の diag)・同じ
   * 生存条件(handleEvent 冒頭の status ガードの後段でしか呼ばれない)。
   * follow は従来ログが 0 行で、「発生しない」を実データ(DB)でしか裏取り
   * できなかった — gift(2,600行/実配信)との非対称を埋めるのが目的。
   */
  private socialDiag(message: string): void {
    this.diag(`[challenge/social] ${message}`);
  }

  /**
   * スタンプ(サブスクエモート)トリガーの診断ログ。giftDiag と同じ出口・同じ
   * 生存条件(handleEvent 冒頭の status ガードの後段でしか呼ばれない)。
   * emoteId は配信中に設定値と突き合わせる唯一の手掛かり(gift の受信行と同じ理由)
   * なので、emote が載ったメッセージは一致の成否まで必ず記録する。
   */
  private stampDiag(message: string): void {
    this.diag(`[challenge/stamp] ${message}`);
  }

  /**
   * 能力が失われた瞬間に凍結中なら即時解除する共通処理。
   * 戻り値 = 状態が変わった(呼び出し側は nudge して delta を配ること)。
   */
  private applyFxCapsChange(): boolean {
    if (this.fxAllowed() || !this.isFxFrozen()) return false;
    // モニターが閉じた(カットインが映らなくなった)ら、進行中のブーストも即清算
    // する — 見えない演出のためにタップを溜め続けない。凍結の即時解除より先に
    // 呼ぶこと(settle が保留 op のドレインより先に並ぶ)。
    this.settleBoost(this.now(), true);
    // まだ映像が始まっていない予約は**プレーンモードで即発動**する(破棄しない)。
    // ガードを通過できるのはアーム中も凍結を張っているから(armedBoost の doc 参照)。
    // **強制清算より後に置くこと** — 前に置くと、いま開いたばかりの窓を
    // 直後の settleBoost(force) が即座に閉じてしまう(実行中とアームは排他なので
    // 順序を入れ替えても取りこぼしは起きない)。
    this.plainCommitArmedBoost(this.now(), 'モニター閉 / 動きの抑制');
    this.fxFreezeUntilMs = this.now();
    this.flushFxFreeze(this.now());
    this.armFreezeTimer();
    return this.dirty;
  }

  /** main から: モニター窓の開閉。閉じたら進行中の凍結を即時解除する。 */
  setMonitorOpen(open: boolean): boolean {
    if (this.monitorOpen === open) return false;
    this.monitorOpen = open;
    return this.applyFxCapsChange();
  }

  /**
   * モニターの RPC(challenge.boostCue)から: アーム済みフィーバーの合図。
   * 戻り値 = 状態が変わった(呼び出し側は nudge して delta を配ること — setFxCaps と同じ規約)。
   *
   * 'start' はモニターが起動カットインを**実際に再生し始めた**合図で、ここで
   * タップ窓が開く。'drop' は「この予約は再生されない」の申告で、プレーンモードへ倒す。
   * アームが無い/id が違う合図は黙って無視する(二重コミット・期限切れ後の
   * 遅れた合図・別のフィーバーの合図はすべてここで冪等になる)。
   */
  boostCue(p: ChallengeBoostCue): boolean {
    const a = this.armedBoost;
    if (a === null) return false;
    const nowMs = this.now();
    if (p.action === 'drop') {
      // effectId 0 = 「アーム中のものを種類を問わず解放」(モニターの再マウント時)。
      if (p.effectId !== 0 && p.effectId !== a.id) return false;
      this.plainCommitArmedBoost(nowMs, 'モニターが再生を見送った');
      this.flushFxFreeze(nowMs);
      return true;
    }
    if (p.effectId !== a.id) return false;
    // startedAtMs はモニターの Date.now()。同一マシンの同じ時計だが RPC は
    // renderer → main → worker の postMessage を挟むので少し過去になる。
    // **now を超えさせないのが要** — 未来だとタップ窓が映像より後ろへずれて
    // 開幕の押下を飲む。古すぎる側は時計の異常として切り上げる。
    const startMs = Math.min(Math.max(p.startedAtMs, nowMs - BOOST_COMMIT_MAX_LAG_MS), nowMs);
    // 前置きはモニターが実際に流す尺に従う(焼き込みを超えないようにだけ守る)。
    const preMs = Math.min(Math.max(0, p.preMs), a.introMs + a.countMs);
    this.commitBoost(a, startMs, preMs, true);
    return true;
  }

  /** モニターの RPC(challenge.fxCaps)から: カットインを再生できるか。 */
  setFxCaps(bandFx: boolean): boolean {
    if (this.monitorBandFx === bandFx) return false;
    this.monitorBandFx = bandFx;
    return this.applyFxCapsChange();
  }

  /**
   * 凍結中なら保留キューへ、そうでなければ即時実行する。
   * 戻り値は「状態が変わったか」(op が false を返したら変わっていない)。
   * キュー溢れ時は overflowOp(無ければ op)を即時実行する — 値の正しさ優先で
   * 演出だけを捨てる(ギフトの場合はカットイン抜きの op が渡ってくる)。
   * fx はモニターの演出ストック表示に出す予告(カットイン級のイベントだけ渡す)。
   *
   * critical: 溢れ弁で即時実行に倒してはいけない op(フィーバー発動など、凍結中に
   * 走ると進行中の演出を強制清算した上で凍結を張り直すもの)。上限を追加ヘッド
   * ルームぶんだけ超えてもキューに積み、それも尽きたら**実行せず破棄**する —
   * 「凍結中にフル op が走る」だけは構造的に作らない。
   */
  private applyOrQueue(
    op: () => boolean | void,
    overflowOp?: () => boolean | void,
    fx?: Omit<ChallengeFxQueueItem, 'id'>,
    critical = false
  ): boolean {
    if (!this.isFxFrozen()) return op() !== false;
    if (critical) {
      if (this.pendingOps.length >= GIFT_FX_PENDING_OPS_MAX + GIFT_FX_PENDING_OPS_CRITICAL_EXTRA) {
        this.diag('[challenge] 保留キュー上限(重要op の追加枠も満杯)— フィーバー級の op を破棄');
        return false;
      }
    } else if (this.pendingOps.length >= GIFT_FX_PENDING_OPS_MAX) {
      // 値は正しく入るが演出(カットイン/再凍結)は捨てる。連発しうるので
      // ログはエピソード先頭の1行だけ — 残件数はドレイン時のサマリが持つ。
      if (this.pendingOverflowCount++ === 0) {
        this.diag(
          `[challenge] 保留キュー上限(${GIFT_FX_PENDING_OPS_MAX}件)— 以降は演出を捨て値のみ即時適用`
        );
      }
      return (overflowOp ?? op)() !== false;
    }
    this.pendingOps.push({
      run: () => void op(),
      fx: fx ? { id: ++this.fxQueueSeq, ...fx } : null,
    });
    // 予告付きの保留は fxQueue の変化 = モニターに配るべき変化。値は動いていない
    // (=呼び出し元は false を返す)ので、ここで dirty を立てないと次の delta に乗らない。
    if (fx) this.dirty = true;
    return false;
  }

  /** 溢れ弁エピソードのサマリを1行残してカウンタを戻す(両ドレイン出口から)。 */
  private flushOverflowDiag(): void {
    if (this.pendingOverflowCount === 0) return;
    this.diag(`[challenge] 保留キュー溢れ: この凍結中に計${this.pendingOverflowCount}件の演出を破棄`);
    this.pendingOverflowCount = 0;
  }

  /** フォロー診断の要約カウンタを初期化(start/reset の seenFollowers.clear() と対)。 */
  private resetFollowDiagCounters(): void {
    this.followDupCount = 0;
    this.followDupLogMs = null;
    this.followStep0Count = 0;
    this.followStep0LogMs = null;
  }

  /**
   * 凍結の期限が来ていたら解除し、保留分を到着順に適用する。ドレイン中に新たな
   * バンドギフトが凍結を張り直したら中断する(残りは次の解除で — 連続ギフトが
   * 1本ずつ順に演出される)。ドレイン中に 0 到達で achieved になったら残りは
   * 捨てる — 達成後のイベントは元のタイムラインでも無視されるため。
   */
  private flushFxFreeze(nowMs: number): void {
    // ブーストの清算は凍結ドレインより**必ず先** — boostUntilMs は
    // fxFreezeUntilMs より resultMs + BOOST_SETTLE_BUDGET_MS +
    // GIFT_FX_FREEZE_MARGIN_MS 早く切れるので、凍結解除の時点では常に settle 済み
    // になり、boost-end effect の id < 保留イベントの id が保証される
    // (boostUntilMs null ガードで冪等)。
    // アームの期限切れは**清算より先**に見る — ここで強制発動すると boostUntilMs が
    // 入るので、直後の settleBoost がそのまま同じ時間軸で処理できる。press /
    // handleEvent / drainIfChanged / applyFxCapsChange / 凍結タイマーの全経路が
    // ここを通るので、時計の入口はこの1箇所で足りる。
    this.commitArmedBoostIfExpired(nowMs);
    this.settleBoost(nowMs);
    // 封印の解除は**この位置**(下の早期 return より上)でなければならない —
    // 下だと凍結が同時に切れるときにしか解除されず、事実上いつまでも解けない。
    this.flushTapLock(nowMs);
    if (this.fxFreezeUntilMs === null || nowMs < this.fxFreezeUntilMs) return;
    this.fxFreezeUntilMs = null;
    this.dirty = true;
    // 凍結中に即時適用した押下の演出(合算1件)。**ドレインより先**に出す —
    // ドレイン中のギフトが 0 到達で achieved を積むと、後回しにした押下音が
    // CLEAR の上に乗ってしまう(fanStampCoalesceOp の force flush と同じ理由)。
    this.flushPressFx();
    // ドレイン中の演出は迂回バッファへ(finishDrain が同種を畳んで ring へ移す)。
    this.drainFx = [];
    try {
      while (this.pendingOps.length > 0) {
        if (this.status !== 'running') {
          this.pendingOps = [];
          break;
        }
        // 1件の失敗でドレインを止めない — throw を握らないと残りの保留分が次の
        // 凍結発生まで孤児化し、例外は handleEvent の呼び出し元(onEvent)まで抜ける。
        try {
          this.pendingOps.shift()!.run();
        } catch (err) {
          this.diag(`[challenge] pending op failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        if (this.fxFreezeUntilMs !== null) break;
      }
    } finally {
      this.finishDrain();
    }
    // 溢れ弁エピソードのサマリ(あれば)。再凍結で中断しても「ここまでの分」を出す —
    // 続きの溢れは新しいエピソードとして数え直す。
    this.flushOverflowDiag();
    // 再凍結(ドレイン中断)なら次の期限で張り直し、解除完了なら外す。
    this.armFreezeTimer();
    // ドレイン明けの合算バナーは tick を待たず即出す(finishDrain 済みなので
    // pushEffect は ring へ直行し、id はドレインした演出より後になる)。
    // 再凍結で中断していれば isFxFrozen() が真なのでガードで止まり次の解除へ持ち越す。
    this.flushFanStampFx();
    // 凍結中の押下で 0 に達していた場合の達成はここが唯一の出口 — press() は
    // 凍結中 maybeAchieve を見送るので、達成演出は必ずカットインの後に出る。
    // 再凍結(ドレイン中断)なら次の解除へ持ち越す。2Hz tick と armFreezeTimer の
    // 両方がここを通るので、イベントが途絶えても最大 500ms で到達する。
    if (!this.isFxFrozen()) this.maybeAchieve(nowMs);
  }

  /**
   * 凍結中に溜めた押下の演出を **effect 1件** にまとめて出す(押下 SE・簡易演出が
   * それぞれ1回ずつになる)。値・統計は press() が適用済みなので、ここで動かすのは
   * 見た目だけ。amount は合算、coalesced に実タップ数を載せる(finishDrain の
   * press 畳み込みと同じ形)。
   *
   * 凍結中は出さない — 呼ぶのは flushFxFreeze の解除経路だけで、再凍結中に
   * 誤って呼ばれても持ち越すようガードしておく(flushFanStampFx と同型)。
   */
  private flushPressFx(): void {
    const p = this.pendingPressFx;
    if (p === null || this.isFxFrozen()) return;
    this.pendingPressFx = null;
    this.pushEffect({
      kind: 'press',
      amount: -p.amount,
      ...(p.count > 1 ? { coalesced: p.count } : {}),
      atMs: this.now(),
    });
    this.dirty = true;
  }

  // ── タップブースト(フィーバー) ─────────────────────────────────────────

  /**
   * ブースト発動(applyOrQueue の op として実行される — 凍結明けの遅延発動では
   * this.now() が実行時点を返すので、期限は常に「実際に始まった時刻 + 尺」になる)。
   * トリガーギフト自体は値を動かさない。設定(倍率/1タップの重み)はここで
   * 焼き込み、以後の設定変更の影響を受けない。
   */
  private activateBoost(tb: TapBoostRule, e: Extract<NormalizedEvent, { kind: 'gift' }>): void {
    const atMs = this.now();
    // 実発動が優先 — 実演のタップウィンドウが残っていたら破棄する(press が
    // テスト計数に吸われて実カウンタが動かない事故を防ぐ)。
    this.clearTestBoost();
    // まだ映像が始まっていない予約が残っていたら、ここでプレーンとして発動させる。
    // 直後の settleBoost が boost-end(タップ 0)を積むので、モニター側は
    // 「x.id > boost-end.id」の間引きで**古い持ち越しを確実に捨てられる** —
    // これを撃たないと、後から不透明シネマだけ再生されてタップが1回も数えられない。
    // (到達経路は pendingOps 溢れだけだが、失敗の形が最悪なので塞いでおく。)
    this.plainCommitArmedBoost(atMs, '同じトリガーの再発動');
    // プレーンモード中の再トリガーは即実行で届く(凍結が無いので直列化されない)。
    // 前のブーストを清算してから始める — 溜め直しではなく「延長戦」を2本に分ける。
    this.settleBoost(atMs, true);
    const durationMs = tb.durationSec * 1000;
    const cinematic = this.fxAllowed();
    // プレーンモード化は「起動カットインが飛ばされた」と見た目で区別がつかないので
    // 必ず記録する — この経路は診断ログに1行も残らず、原因究明が band カットインの
    // 警告(:1216)からの推測になっていた。
    if (!cinematic) {
      this.giftDiag('→ フィーバーはプレーンモードで発動(モニター未表示 / 動きの抑制)— 前置きも映像も無し、倍率だけ');
    }
    // 前置き演出(咆哮 → 3/2/1)はシネマティックモードだけ。プレーンモードは
    // 映像が無いので即ウィンドウ開始(カウントダウンなしで待たせない)。
    // 段ごとの 'off' 選択はその段をスキップする(尺ごと詰める)。
    const introMs = cinematic && tb.introClip !== 'off' ? TAP_BOOST_INTRO_MS : 0;
    const countMs = cinematic && tb.countClip !== 'off' ? TAP_BOOST_COUNT_MS : 0;
    // 結果カットシーン(ウィンドウ終了 → 減算発表の前置き)もシネマティックのみ。
    const resultMs = cinematic && tb.resultClip !== 'off' ? TAP_BOOST_RESULT_MS : 0;
    const pressStep = this.getConfig().pressStep;
    // アームの期限。シネマティックではこの時刻が effect に焼く boostEndsAtMs の
    // 原点になり(下)、モニターの planBoostStart はここまで必ず full を返す。
    const deadlineMs = atMs + BOOST_ARM_MAX_MS;
    if (cinematic) {
      // **タップ窓はまだ開かない**(boostUntilMs は null のまま = アーム)。
      // 開くのはモニターが起動カットインを再生し始めた合図(boostCue)を受けた時。
      this.armedBoost = {
        id: 0, // pushEffect の戻り値で埋める(下)
        atMs,
        deadlineMs,
        introMs,
        countMs,
        durationMs,
        resultMs,
        resultClip: resultMs > 0 ? tb.resultClip : '',
        multiplier: tb.multiplier,
        pressStep,
      };
    } else {
      // プレーンモードは待つ理由がない(映像が無い)ので従来どおり即発動。
      this.boostStartMs = atMs;
      this.boostUntilMs = atMs + durationMs;
      this.boostTapCount = 0;
      this.boostMultiplier = tb.multiplier;
      this.boostPressStep = pressStep;
      this.boostResultMs = 0;
      this.boostResultClip = '';
      this.boostPlain = true;
      // 凍結を張らない枝。窓の期限で清算できるよう時計だけは持たせる
      // (commitBoost のプレーン枝と同じ理由)。
      this.armFreezeTimer();
    }
    const effectId = this.pushEffect({
      kind: 'boost-start',
      amount: 0,
      boostMultiplier: tb.multiplier,
      // **フォールバックのタイムライン**(実際の期限ではない)。アーム期限まで
      // コミットが来なかったとき worker が deadlineMs 起点で自走するので、
      // その時のタップ窓の終端がこれ。判定の原点 endsAt - fxDurationMs が
      // deadlineMs になることで、アーム中の planBoostStart は常に full を返す
      // (= 起動カットインが必ず満尺で出る)。dto.ts の boostEndsAtMs の doc 参照。
      boostEndsAtMs: (cinematic ? deadlineMs + introMs + countMs : atMs) + durationMs,
      boostIntroMs: introMs,
      boostCountMs: countMs,
      // クリップは段ごとの選択を焼き込む(effect 1件で自己完結の流儀)。
      ...(introMs > 0 ? { boostIntroClip: tb.introClip } : {}),
      ...(countMs > 0 ? { boostCountClip: tb.countClip } : {}),
      // ループ映像も**シネマティックのみ**。プレーンモードは「カットインも溜めも
      // 無し、倍率のゲーム性だけ残す」契約(boostPlain のコメント参照)なのに、
      // これを無条件に焼くとモニターは前置き 0ms で startWindow() へ直行し、
      // タップウィンドウ映像だけを再生していた。
      ...(cinematic && tb.loopClip !== 'off' ? { boostLoopClip: tb.loopClip } : {}),
      ...(resultMs > 0 ? { boostResultMs: resultMs, boostResultClip: tb.resultClip } : {}),
      // 総尺(前置き+ウィンドウ)。結果カットシーン以降は boost-end 駆動なので含めない —
      // レンダラのウィンドウ段タイマー・boostWillStart の意味を変えないため。
      //
      // プレーンモードは 0。boostWillStart(MonitorView)は
      // `fxDurationMs >= 1000 && !prefersReducedMotion()` だけを見るので、
      // 実尺を載せると**クリップが無くても暗幕(.boost-screen)+タップカウンタで
      // 不透明な全画面が durationMs ぶん出てしまう** — 「カットインも溜めも無し」の
      // 契約に反するうえ、起動カットインが飛ばされたのと同じ見え方になる。
      // 0 にするとモニターは「×N フィーバー発動!」バナーだけを出す。
      fxDurationMs: cinematic ? introMs + countMs + durationMs : 0,
      ...(tb.flash ? { flash: true } : {}),
      nickname: e.viewer.nickname ?? e.viewer.displayId,
      ...(e.giftName ? { giftName: e.giftName } : {}),
      ...(e.repeatCount > 1 ? { giftCount: e.repeatCount } : {}),
      ...(e.iconUrl ? { giftIconUrl: e.iconUrl } : {}),
      diamonds: e.diamonds,
      atMs,
    });
    // 凍結はシネマティックモードだけ(giftOp の fxAllowed ガードと同じ理由)。
    // resultMs(結果カットシーン)+ BOOST_SETTLE_BUDGET_MS(ロールアップ発表→
    // 着弾の最悪予算)+ margin ぶん遅く切れるので、解除ドレインの時点では必ず
    // settle 済みで、発表シーケンス中に保留イベントの演出が割り込まない。
    // タップ 0 で発表するものが無いときは settleBoost が凍結を引き戻す。
    if (cinematic) {
      this.armedBoost!.id = effectId;
      // **暫定**の凍結期限 — 現行の式の boostUntilMs をフォールバック値に置き換えただけ。
      // コミットは必ず**短縮方向**に張り直す(settleBoost の Math.min 引き戻しと同じ流儀)。
      // アーム中も凍結を張るのが要: 連打コンボの直列化(applyOrQueue → pendingOps)は
      // isFxFrozen() に依存していて、外すと1メッセージ内の全発動が即時に走って
      // 互いを強制清算し合う。
      this.fxFreezeUntilMs =
        deadlineMs +
        introMs +
        countMs +
        durationMs +
        resultMs +
        BOOST_SETTLE_BUDGET_MS +
        GIFT_FX_FREEZE_MARGIN_MS;
      this.armFreezeTimer();
    }
    this.dirty = true;
  }

  /**
   * アーム済みフィーバーの発動(**唯一の commit 経路**)。ここでタップ窓が開く。
   * cinematic=false ならプレーンモード(前置きなし・映像なし・凍結なし)で発動する。
   *
   * startMs はモニターが起動カットインを再生し始めた時刻。窓の原点をそこに移すのが
   * この設計の全部 — worker の絶対時刻とモニターの実再生開始のズレが消えるので、
   * planBoostStart が起動カットインを削る理由が構造的に無くなる。
   */
  private commitBoost(
    a: NonNullable<ChallengeEngine['armedBoost']>,
    startMs: number,
    preMs: number,
    cinematic: boolean
  ): void {
    // 実発動が常に優先(activateBoost と同じ判断)。実演の窓が生き残っていると
    // press() の実演ブロックが先に食い、実フィーバーの全タップが実演カウンタへ
    // 吸われて清算が 0 になる。
    this.clearTestBoost();
    this.armedBoost = null;
    this.boostStartMs = startMs + (cinematic ? preMs : 0);
    this.boostUntilMs = this.boostStartMs + a.durationMs;
    this.boostTapCount = 0;
    this.boostMultiplier = a.multiplier;
    this.boostPressStep = a.pressStep;
    this.boostResultMs = cinematic ? a.resultMs : 0;
    this.boostResultClip = cinematic ? a.resultClip : '';
    this.boostPlain = !cinematic;
    if (cinematic) {
      // 暫定期限(deadlineMs 起点)から**実際の再生に合わせて張り直す** = 必ず短縮。
      this.fxFreezeUntilMs =
        this.boostUntilMs + this.boostResultMs + BOOST_SETTLE_BUDGET_MS + GIFT_FX_FREEZE_MARGIN_MS;
    }
    // 凍結の有無に関わらず張り直す — armFreezeTimer は boostUntilMs でも起きるので、
    // プレーンモード(凍結なし)でも窓の期限で必ず清算される。
    this.armFreezeTimer();
    this.dirty = true;
  }

  /**
   * アーム期限切れ = モニターが最後まで再生しなかった。**破棄ではなく強制発動**する
   * (ユーザー決定 — 課金ギフトをもらったのにフィーバーが起きない形を作らない)。
   *
   * 起点は now ではなく **deadlineMs** — こうすると effect に焼いた boostEndsAtMs が
   * そのまま真になり、期限直後に再生を始めたモニターの planBoostStart が整合して
   * 最悪でも従来挙動(resume/skip)へ連続的に着地する。now を使うと期限が前置きぶん
   * 嘘になり、「既に閉じた窓へ向けて 13 秒のシネマを流す」最悪形が生まれる。
   */
  private commitArmedBoostIfExpired(nowMs: number): void {
    const a = this.armedBoost;
    if (a === null || nowMs < a.deadlineMs) return;
    this.giftDiag(
      `→ フィーバーのアーム期限切れ(${Math.round(BOOST_ARM_MAX_MS / 1000)}秒)— モニターの再生を待たず強制発動`
    );
    this.commitBoost(a, a.deadlineMs, a.introMs + a.countMs, true);
  }

  /**
   * アーム中のフィーバーをプレーンモードで即発動する。モニターが閉じた/動きの抑制が
   * 入った/モニターが「再生しない」と言ってきた経路で使う。
   *
   * 破棄しないのは設計意図に従うため: activateBoost はモニターが見えないときも
   * プレーンモードで発動する(「カットインも溜めも無し、倍率のゲーム性だけ残す」)。
   * アームは**その状況が時間的にずれただけ**で、タップも値もまだ1つも動いていない。
   * ここで捨てると「課金ギフトが何も生まない」ケースを新設することになる。
   */
  private plainCommitArmedBoost(nowMs: number, why: string): void {
    const a = this.armedBoost;
    if (a === null) return;
    this.giftDiag(`→ アーム中のフィーバーをプレーンモードで即発動(${why})— 映像なし、倍率だけ`);
    this.commitBoost(a, nowMs, 0, false);
    // プレーンは凍結しない契約(activateBoost の if (cinematic) と対)。
    // ドレインは呼び出し側に任せる — ここで flushFxFreeze を呼ぶと再入する。
    this.fxFreezeUntilMs = nowMs;
    this.armFreezeTimer();
  }

  /**
   * ブーストの清算。溜めたタップを tapCount × pressStep × multiplier として一括
   * 減算し、boost-end effect を積む。boostUntilMs null ガードで冪等 — stop() と
   * flushFxFreeze の両方から呼ばれても二重適用しない。
   * プレーンモードは press が即時適用済みなので lump は 0(boost-end はモニターへの
   * 終了合図と履歴の区切りとして出す)。
   */
  private settleBoost(nowMs: number, force = false): void {
    if (this.boostUntilMs === null) return;
    if (!force && nowMs < this.boostUntilMs) return;
    const until = this.boostUntilMs;
    const tap = this.boostTapCount;
    const mult = this.boostMultiplier;
    const nominal = this.boostPlain ? 0 : tap * this.boostPressStep * mult;
    // 発表も 0 でクランプした「実際に減る量」で行う — 値は Math.max(0, ...) で
    // 守っていたのに effect には名目値を焼き込んでいたので、残量 < タップ合計の
    // クライマックスで清算ロールアップが実際より大きい数字を発表していた
    // (残り 30 でタップ合計 200 → 「-200 → 0」)。
    const amount = Math.min(nominal, this.value);
    const resultMs = this.boostResultMs;
    const resultClip = this.boostResultClip;
    this.clearBoost();
    if (nominal > 0) {
      this.value -= amount;
      this.stats.presses += tap;
    }
    if (amount === 0 && this.fxFreezeUntilMs !== null) {
      // 発表するものが無い(タップ 0、または既に 0 到達済み)。activateBoost が
      // 発表シーケンス(resultMs + BOOST_SETTLE_BUDGET_MS)ぶん先まで張った凍結を
      // 「発表なし時代の期限」(until + margin)まで引き戻す — 出ない演出のために
      // 保留イベントを最大 8 秒待たせない。min() なので凍結を伸ばす方向には決して
      // 働かず、遅延清算(lazy 解除)でも直後の flushFxFreeze がそのままドレインへ進める。
      this.fxFreezeUntilMs = Math.min(this.fxFreezeUntilMs, until + GIFT_FX_FREEZE_MARGIN_MS);
      this.armFreezeTimer();
    }
    this.pushEffect({
      kind: 'boost-end',
      // タップ 0 は -0 を作らない(JSON/表示/テストの等値比較が割れる)。
      amount: amount === 0 ? 0 : -amount,
      boostTapCount: tap,
      boostMultiplier: mult,
      // 結果カットシーンの尺とクリップ(effect 1件で自己完結の流儀 — レンダラは
      // cfg を引き直さない)。発表シーケンスは boost-end 受信が起点なのでこちらが本線。
      // 実際に減る量が 0 なら発表段そのものを省く(0 の発表はしない)。
      ...(amount > 0 && resultMs > 0 ? { boostResultMs: resultMs, boostResultClip: resultClip } : {}),
      atMs: nowMs,
    });
    this.maybeAchieve(nowMs);
    this.dirty = true;
  }

  /** ブースト状態の破棄(start/reset — 清算せず捨てる。pendingOps 破棄と同じ判断)。 */
  private clearBoost(): void {
    // アームもここで落とす — start()/reset() と settle の共通出口なので、
    // 「窓は閉じたのに予約だけ生き残る」を構造的に作らない。
    this.armedBoost = null;
    this.boostUntilMs = null;
    this.boostStartMs = 0;
    this.boostTapCount = 0;
    this.boostResultMs = 0;
    this.boostResultClip = '';
    this.boostPlain = false;
  }

  /** ▶テスト実演のタップ計数の破棄(実発動が優先・stop/reset でも掃除)。 */
  private clearTestBoost(): void {
    this.testBoostUntilMs = null;
    this.testBoostStartMs = 0;
    this.testBoostTapCount = 0;
  }

  // ── お邪魔(タップ封じ) ──────────────────────────────────────────────────

  /**
   * 封印を張る/延長する。**呼び出しは applyOrQueue を通さず即時**(凍結中でも
   * その場でラッチする — 理由は呼び出し側のコメント)。
   *
   * 重ねがけは**延長**(2026-08-18 ユーザー決定)。残り時間へ加算するが上限は
   * TAP_LOCK_MAX_MS — 絶対期限に素朴に += すると 17 連打コンボ1件で 8 分半
   * ボタンが死ぬ。
   */
  private activateTapLock(tl: TapLockRule, e: Extract<NormalizedEvent, { kind: 'gift' }>): void {
    const nowMs = this.now();
    // 連打コンボは normalize.ts が1メッセージへ畳むので repeatCount を見る。
    // ただし封印は直列化できない(1本ずつ順に、が成立しない)ので、掛けるのは
    // 発動回数ではなく**尺**で、そこに上限を課す(tapBoostActivationCount と同じ判断)。
    const times = tapLockActivationCount(e.repeatCount);
    if (times < e.repeatCount) {
      this.giftDiag(`→ お邪魔の連打 ${e.repeatCount}個 — 加算は${times}本ぶんに制限`);
    }
    // 尺は**到着時点で焼き込む**(activateBoost と同じ規約)。以降 flushTapLock は
    // getConfig() を読まない — 読むと途中の設定変更で走行中の封印が伸縮する。
    const addMs = tl.durationSec * 1000 * times;
    // 残っていれば延長、切れていれば now から。**絶対期限に += しない。**
    const base = Math.max(this.tapLockUntilMs ?? 0, nowMs);
    const capped = Math.min(base + addMs, nowMs + TAP_LOCK_MAX_MS);
    if (capped < base + addMs) {
      this.giftDiag(`→ お邪魔の累積が上限(${TAP_LOCK_MAX_MS}ms)に到達 — 延長を打ち切り`);
    }
    if (this.tapLockUntilMs === null) {
      this.tapLockStartMs = nowMs;
      this.tapLockBlocked = 0;
    }
    this.tapLockUntilMs = capped;
    this.tapLockTotalMs = capped - this.tapLockStartMs;
    this.tapLockNickname = e.viewer.nickname ?? e.viewer.displayId ?? '';
    this.tapLockLabel = tl.label;
    // ▶テスト実演の窓が開いていると press が実演ブロックで先に return してしまい、
    // 実演が封印の抜け道になる(activateBoost が同じ理由で落としているのと同型)。
    this.clearTestBoost();
    this.giftDiag(`→ お邪魔発動 残り${Math.round((capped - nowMs) / 1000)}秒`);
    this.dirty = true;
    this.armFreezeTimer();
  }

  /**
   * 封印の遅延解除。**flushFxFreeze の早期 return より上**から呼ぶこと — 下だと
   * 「凍結が同時に切れるときにしか解除されない」= 事実上解除されない。
   *
   * 期限は毎回 clampFutureMs で押さえる。fxFreezeUntilMs と違ってここを省けないのは、
   * あちらの失敗が「バナーが遅れる」なのに対しこちらの失敗は「配信者の物理ボタンが
   * 死んだまま」だから(shared/fx-stage.ts の「時刻ラッチには必ずクランプ」の規約)。
   */
  private flushTapLock(nowMs: number): void {
    if (this.tapLockUntilMs === null) return;
    this.tapLockUntilMs = clampFutureMs(this.tapLockUntilMs, nowMs, TAP_LOCK_MAX_MS);
    if (nowMs < this.tapLockUntilMs) return;
    this.clearTapLock();
    // dirty を立てないと armFreezeTimer の onFreezeExpired が通知を出さず、
    // 配信終了後(2Hz tick が無い)は解除が誰にも届かない。
    this.dirty = true;
    this.armFreezeTimer();
  }

  /** 封印の破棄(start/stop/reset/達成/機能OFF/緊急解除の共通出口)。 */
  private clearTapLock(): void {
    this.tapLockUntilMs = null;
    this.tapLockStartMs = 0;
    this.tapLockTotalMs = 0;
    this.tapLockBlocked = 0;
    this.tapLockNickname = '';
    this.tapLockLabel = '';
  }

  /**
   * 誤爆した封印の緊急解除(challenge.clearTapLock RPC)。停止/リセットと違い
   * ラン(値・統計・順位)には一切触れない — ボタンを直すために配信中のカウント
   * ダウンを潰さずに済ませるための逃げ道。
   * 戻り値 true = 実際に解除した(呼び出し側が delta を配る)。
   */
  clearTapLockNow(): boolean {
    if (this.tapLockUntilMs === null) return false;
    this.giftDiag('→ お邪魔を手動で解除(配信者操作)');
    this.clearTapLock();
    this.dirty = true;
    this.armFreezeTimer();
    return true;
  }

  /** stop 用の強制適用。保留分を残さず適用する(ドレイン中の再凍結は無視)。 */
  private forceApplyPendingOps(): void {
    this.fxFreezeUntilMs = null;
    this.drainFx = [];
    try {
      while (this.pendingOps.length > 0) {
        if (this.status !== 'running') break;
        // flushFxFreeze と同じ理由 — stop の強制適用が1件の失敗で途切れると、
        // 残りが適用されないまま直後の pendingOps = [] で消える。
        try {
          this.pendingOps.shift()!.run();
        } catch (err) {
          this.diag(`[challenge] pending op failed: ${err instanceof Error ? err.message : String(err)}`);
        }
        this.fxFreezeUntilMs = null;
      }
      this.pendingOps = [];
    } finally {
      this.finishDrain();
    }
    this.flushOverflowDiag();
    this.armFreezeTimer();
  }

  /**
   * ドレイン迂回バッファを閉じ、同種の演出を1件に畳んで ring へ移す。
   * 値・統計は各 op で適用済み — ここで畳むのは**見た目と履歴の行**だけ。
   * 畳み規則: press/like/follow/stock-full は全件→1件(amount 合算+coalesced)、
   * comment は keyword 単位、gift は canonical 単位(カットイン付きは畳まない —
   * ドレインを中断させた再凍結ギフトで、カットインは effect 1件で自己完結する
   * 契約)、roulette は**同じ盤面どうしで出目を連結**(盤面が違えば index の意味が
   * 違うので畳まない)、achieved は単独。
   * 1件だけのグループは原型のまま(coalesced を付けない)。
   *
   * ルーレットは以前「新しい3件だけ盤面つきで残し、古い分は盤面を削除」していた。
   * 盤面の無い effect はモニターの rouletteWillSpin が false になりバナーだけに
   * 退避するので、カットイン明けにリールが出ない(「演出が発生しない」の主因)。
   * 出目を配列で持てるようになったので、捨てずに連結して全部回す。
   */
  private finishDrain(): void {
    const buf = this.drainFx;
    this.drainFx = null;
    if (!buf || buf.length === 0) return;
    const out: ChallengeEffect[] = [];
    const merge = (group: ChallengeEffect[]): void => {
      if (group.length === 0) return;
      if (group.length === 1) {
        out.push(group[0]!);
        return;
      }
      const last = group[group.length - 1]!;
      const sum = (k: 'amount' | 'giftCount' | 'diamonds'): number =>
        group.reduce((a, e) => a + (e[k] ?? 0), 0);
      const merged: ChallengeEffect = {
        ...last,
        id: Math.max(...group.map((e) => e.id)),
        amount: sum('amount'),
        // 直近の値が正 — op は到着順に適用済みなので最後の valueAfter が現在値。
        valueAfter: last.valueAfter,
        coalesced: group.length,
        ...(group.some((e) => e.flash) ? { flash: true } : {}),
      };
      if (last.kind === 'gift') {
        // giftCount は連打(repeatCount > 1)のときだけ載る規約なので、単発は 1 と
        // 数えて合算する — `?? 0` で畳むと「単発3件 + 5連打1件」の ×N が 8 ではなく
        // 5 になる。
        if (group.some((e) => e.giftCount != null)) {
          merged.giftCount = group.reduce((a, e) => a + (e.giftCount ?? 1), 0);
        }
        if (group.some((e) => e.diamonds != null)) merged.diamonds = sum('diamonds');
        // 反復演出は畳んだら意味を失う(1件ぶんの見た目で十分)。
        delete merged.fxRepeat;
        delete merged.fxRepeatIntervalMs;
      }
      if (last.kind === 'roulette') {
        // 盤面は同一(グループキーが盤面込み)なので、出目を到着順に連結するだけで
        // モニターは全部のリールを回せる。盤面は落とさない。
        const idxs = group.flatMap((e) => e.rouletteIndexes ?? []).slice(0, ROULETTE_DRAWS_MAX);
        const pats = group.flatMap((e) => e.roulettePatterns ?? []).slice(0, ROULETTE_DRAWS_MAX);
        merged.rouletteSegments = last.rouletteSegments;
        merged.rouletteIndexes = idxs;
        merged.roulettePatterns = pats;
        merged.rouletteIndex = idxs[0] ?? last.rouletteIndex;
        merged.roulettePattern = pats[0] ?? last.roulettePattern;
        // 連結後の本数で引き直す(元の各 effect の rouletteReels は合計にならない)。
        merged.rouletteReels = rouletteReelCount(this.getConfig(), idxs.length);
        // 見出しは先頭の1件に合わせる(連結後の1本目が誰の分かと揃える)。
        const head = group[0]!;
        if (head.nickname != null) merged.nickname = head.nickname;
        // 行の同一性(= 回転サウンドの持ち主)も先頭に揃える(mergeRoulette と同じ
        // 規約 — 連結後に実際に鳴るのは先頭の音)。merged は `{...last}` ベースなので、
        // 先頭が持たないときは delete でキーごと落とす(undefined 値のキーを残さない)。
        if (head.rouletteId != null) merged.rouletteId = head.rouletteId;
        else delete merged.rouletteId;
      }
      if (last.kind === 'follow') {
        // 合算バナーに並べる名前(到着順・同名は畳む。表示上限は fan-stamp と共有)。
        // follow は seenFollowers で userId 重複排除済み = 1 effect = 1人 なので、
        // 人数は coalesced が兼ねる(fanStampPeople 相当は持たない)。
        const names: string[] = [];
        for (const g of group) mergeFanStampName(names, g.nickname ?? '');
        if (names.length >= 1) merged.followNames = names;
        // 見出し(followNames 欠損時のフォールバック)は先頭に揃える(roulette と同じ規約)。
        const head = group[0]!;
        if (head.nickname != null) merged.nickname = head.nickname;
        else delete merged.nickname;
        this.socialDiag(`凍結明け合算 follow ×${group.length}(+${merged.amount})names=${names.join('・')}`);
      }
      out.push(merged);
    };
    // グループ分け(到着順を保つ)。
    const groups = new Map<string, ChallengeEffect[]>();
    const singles: ChallengeEffect[] = [];
    for (const e of buf) {
      let key: string | null;
      switch (e.kind) {
        case 'press':
        case 'like':
        case 'follow':
        case 'stock-full':
          key = e.kind;
          break;
        case 'comment':
          key = `comment:${e.commentKeyword ?? ''}`;
          break;
        case 'gift':
          // カットイン付きは畳まない(再凍結でドレインを中断させた主役)。
          key = e.fxBandClip != null ? null : `gift:${e.canonical ?? e.giftName ?? ''}`;
          break;
        case 'roulette':
          // 盤面をキーに含める — 出目 index は盤面に対する位置なので、ハートミーと
          // バラのように盤面が違うものを畳むと出目の意味が壊れる。判定はモニターの
          // キュー連結と同じ rouletteBoardKey を共有する。
          key = `roulette:${rouletteBoardKey(e)}`;
          break;
        default:
          key = null; // achieved / gauge-full 等は単独
      }
      if (key === null) {
        singles.push(e);
        continue;
      }
      const g = groups.get(key);
      if (g) g.push(e);
      else groups.set(key, [e]);
    }
    for (const g of groups.values()) merge(g);
    out.push(...singles);
    // id 昇順に整列してから ring へ(unshift の繰り返しで新しい順を維持)。
    out.sort((a, b) => a.id - b.id);
    for (const e of out) this.recentEffects.unshift(e);
    while (this.recentEffects.length > CHALLENGE_EFFECTS_MAX) this.recentEffects.pop();
    this.effectsSnapshot = null;
  }

  /** 達成演出は1回だけ。達成後は press/follow/gift すべて無効(status ガード)。 */
  private maybeAchieve(atMs: number): void {
    // stop() の強制適用中は達成させない — 直後に idle で上書きされるため、
    // achieved effect とリザルトだけが半端に生成されて配信されてしまう。
    if (this.stopping) return;
    if (this.value > 0 || this.status !== 'running') return;
    this.status = 'achieved';
    this.achievedMs = atMs;
    // CLEAR リザルト(同じ TOP5×2)が全画面で出るので、手動のランキング表示は
    // 畳む。両方出すとモニターでオーバーレイが二枚重なる。
    this.rankShown = false;
    // 達成したら封印も解除する — 押下せずに 0 到達しうる(sub 方向のルーレット等)。
    // achieved の pushEffect より**前**に置く(すぐ下の「演出を積む前に凍結する」規約)。
    this.clearTapLock();
    // 演出を積む前に凍結する — pushEffect の時点で state は配られうる。
    this.result = this.buildResult(atMs);
    this.pushEffect({ kind: 'achieved', amount: 0, atMs });
  }

  // ── リザルト(ラン中の参加者集計) ───────────────────────────────────────

  /**
   * 参加者を取り出す(無ければ作る)。表示名/アイコンは「空でない最新値」だけで
   * 上書きする — NormViewer の契約どおり、'' や undefined で既存値を潰さない
   * (events.ts の各フィールドのコメント参照)。
   */
  private touchParticipant(v: NormViewer): RunParticipant {
    let p = this.runViewers.get(v.userId);
    if (!p) {
      // 参加者数の集計。**Map ⊆ Seen が(cap 内では)常に成り立つ**ので、ここ
      // (map ミス時)だけで足りる — p が居る = 挿入時に追加済み、剪定は Map から
      // しか消さない、start/reset は両方まとめてクリアする。常連のいいねで毎回
      // add するのを避ける形。**dedup 集合が必須**: 剪定で消えた人が戻ると再び
      // ここを通るので、素のカウンタだと再訪のたびに二重計上して青天井に膨らむ。
      // cap 超過時の精度は runParticipantSeen のコメント参照。
      //
      // コスト実測(bench: handleEvent like ×10,000 / 5,000 ユニーク = ミス率50%の最悪値):
      // Set なし 7.02〜7.08ms → あり 7.58〜7.85ms(**+約0.6ms / +8.5%**)。
      // 実配信のピークが数百件/秒なので 10,000 件 ≒ 30秒ぶん = デューティ比 0.002%。
      // 実際の常連比率ではミス率がこれよりずっと低い。壊れた参加者数(4000ユニークを
      // 超えると約400で頭打ち)を直す対価として妥当と判断した。
      if (this.runParticipantSeen.add(v.userId)) this.runParticipants += 1;
      // 間引きは**挿入前**に回す。挿入後にやると、いま作った 0💎 の p が生存者に
      // 選ばれず Map から外れ、直後の加算が宙に浮く — 間引き直後に初参加した
      // 大口のギフトがランキングから永久に消える(常時見える TOP3 では実害)。
      if (this.runViewers.size >= RUN_VIEWERS_HARD) this.pruneRunViewers();
      p = { userId: v.userId, diamonds: 0, likes: 0 };
      this.runViewers.set(v.userId, p);
    }
    if (v.nickname) p.nickname = v.nickname;
    if (v.displayId) p.displayId = v.displayId;
    if (v.avatarUrl) p.avatarUrl = v.avatarUrl;
    // 呼び出し元は返り値の diamonds/likes を直後に加算する(表示名の上書きも行に
    // 効く)ので、ここで必ずキャッシュを無効化する。再計算は次の topRankCached。
    this.rankVersion++;
    return p;
  }

  /**
   * 💎上位と いいね上位の和集合だけ残す。表示は TOP5 なので下位を捨てても結果は
   * 変わらない(捨てた人が後で大型ギフトを出しても新規として再登録され、その時点
   * からの合計で上位に入り直せる)。挿入順(=初参加順)は詰め直しでも保つ —
   * 同数の並び順の規約に効く。
   */
  private pruneRunViewers(): void {
    const all = [...this.runViewers.values()];
    const survivors = new Set<RunParticipant>([
      ...[...all].sort((a, b) => b.diamonds - a.diamonds).slice(0, RUN_VIEWERS_KEEP),
      ...[...all].sort((a, b) => b.likes - a.likes).slice(0, RUN_VIEWERS_KEEP),
    ]);
    const keep = new Map<UserId, RunParticipant>();
    for (const p of all) if (survivors.has(p)) keep.set(p.userId, p);
    this.runViewers = keep;
    this.rankVersion++;
  }

  /**
   * 上位 n 件を切り出す。CLEAR リザルト(TOP5)とモニターのライブ TOP3 の**唯一の
   * 実装** — 別実装にすると同数の並びが食い違い「TOP3 が TOP5 の先頭3件と一致
   * しない」という説明のつかない絵になる。
   *
   * Map は挿入順 = 初参加順で、挿入位置の判定は厳密な `>` なので同数は先に参加
   * した方が上位に残る(従来の Array#sort が安定ソートだったのと同じ並び)。
   * 中間配列を作らないので、2Hz で最大 RUN_VIEWERS_HARD 件を舐めても割に合う。
   */
  private topRank(key: 'diamonds' | 'likes', n: number): ChallengeRankRow[] {
    if (n <= 0) return [];
    const top: RunParticipant[] = [];
    for (const p of this.runViewers.values()) {
      const val = p[key];
      if (val <= 0) continue;
      let i = top.length;
      while (i > 0 && val > top[i - 1]![key]) i--;
      if (i >= n) continue;
      top.splice(i, 0, p);
      if (top.length > n) top.pop();
    }
    return top.map((p) => ({
      userId: p.userId,
      nickname: p.nickname ?? p.displayId ?? '',
      avatarUrl: p.avatarUrl ?? null,
      diamonds: p.diamonds,
      likes: p.likes,
    }));
  }

  /**
   * topRank の rankVersion 連動キャッシュ。press 連打(ランキングの材料に触れない)
   * では get() が press 1回につき2回走り(press の戻り値 + nudge の pushDelta)、
   * rankShown 中は毎回 4000 件 ×3 本の全走査だった — キーリピート ~30/s で
   * 12万走査/秒。材料が変わらない限り再計算しない。
   *
   * 再計算は既存 topRank をそのまま呼ぶので、並び規約(同数は先着勝ち・
   * TOP3 = TOP5 の先頭3件)は 1 ビットも変わらない。行の参照共有は安全 —
   * worker→main は postMessage の structuredClone を通り(result と同じ判断)、
   * worker 内で ChallengeState を変異させる消費者はいない。
   */
  private topRankCached(key: 'diamonds' | 'likes', n: number): ChallengeRankRow[] {
    const k = `${key}:${n}`;
    const hit = this.rankCache.get(k);
    if (hit !== undefined && hit.version === this.rankVersion) return hit.rows;
    const rows = this.topRank(key, n);
    this.rankCache.set(k, { version: this.rankVersion, rows });
    return rows;
  }

  /**
   * CLEAR 時点で1度だけ組む。以後は不変(達成後はイベントを受け付けないので
   * 変わりようもない)。
   */
  private buildResult(atMs: number): ChallengeResult {
    return {
      atMs,
      startedMs: this.startedMs,
      participants: this.runParticipants,
      gifts: this.topRankCached('diamonds', CHALLENGE_RESULT_TOP_N),
      likes: this.topRankCached('likes', CHALLENGE_RESULT_TOP_N),
    };
  }

  private resetLikeAccumulators(): void {
    // seenLikeMsgIds / seenCommentMsgIds は gift 同様クリアしない — 再開直後に
    // 再配信された古いいいね・コメントを新しいランに数えないため。
    this.likeCounter = 0;
    // stockFills(満杯累計)と lastFullSlots は巻き戻さない — likeFills と同じ
    // 単調増加規約(lastFullSlots は reset を跨いで再生中の満杯演出が参照する)。
    this.likeStocks = 0;
    this.segTally.clear();
    this.stockSlots = [];
    this.likeFxPending = 0;
    this.likeFxLastMs = 0;
  }

  /** 現在のゲージ区間にユーザーのいいねを積む。表示名/アイコンは「空でない最新値」規約。 */
  private tallySegment(v: NormViewer, add: number): void {
    let t = this.segTally.get(v.userId);
    if (!t) {
      t = { likes: 0, avatarUrl: null, nickname: null };
      this.segTally.set(v.userId, t);
    }
    t.likes += add;
    if (v.avatarUrl) t.avatarUrl = v.avatarUrl;
    if (v.nickname) t.nickname = v.nickname;
    else if (!t.nickname && v.displayId) t.nickname = v.displayId;
  }

  /**
   * 区間の1位を確定して集計をクリアする。厳密な `>` でだけ更新するので、同数は
   * 挿入順(= 区間内の初いいね順)で先の方が勝つ — topRank と同じ規約。
   */
  private takeSegmentTop(): ChallengeStockSlot | null {
    let top: { likes: number; avatarUrl: string | null; nickname: string | null } | null = null;
    for (const t of this.segTally.values()) {
      if (!top || t.likes > top.likes) top = t;
    }
    this.segTally.clear();
    return top ? { avatarUrl: top.avatarUrl, nickname: top.nickname } : null;
  }

  /**
   * 合算窓が明けていたら、窓内に積んだいいね演出を1件にまとめて出す。
   * いいねが止まった後の残りも 2Hz tick 側から最大約1.5秒で表示される。
   */
  private flushLikeFx(): void {
    // 凍結中は出さない — 「凍結中のイベントは演出も保留する」契約から
    // like 合算だけが漏れて、カットイン再生中にバナーが割り込んでいた。
    // 解除後の次の tick(最大500ms)で出る。
    if (this.likeFxPending <= 0 || this.status !== 'running' || this.isFxFrozen()) return;
    const nowMs = this.now();
    // 時計の後方ステップ対策(like 経路のクランプと同じ理由)。
    this.likeFxLastMs = clampFutureMs(this.likeFxLastMs, nowMs, 0);
    if (nowMs - this.likeFxLastMs < LIKE_FX_WINDOW_MS) return;
    this.pushEffect({ kind: 'like', amount: this.likeFxPending, atMs: nowMs });
    this.likeFxPending = 0;
    this.likeFxLastMs = nowMs;
    this.dirty = true;
  }

  // ── お助け(ファンスタンプ)の合算 ─────────────────────────────────────

  /** 合算窓を畳んで捨てる(値は適用済みなので、捨てるのは見た目だけ)。 */
  private resetFanStampFx(): void {
    this.fanStampFx = null;
    this.fanStampFxUntilMs = null;
  }

  /**
   * 合算窓の中に届いたお助け1件を積む。**値・統計はここでは触らない**
   * (fanStampCoalesceOp が済ませている) — ここは見た目と音の材料だけ。
   */
  private accumulateFanStampFx(e: FanStampFxSource, amount: number, flash: boolean): void {
    const acc: FanStampAcc = this.fanStampFx ?? {
      amount: 0,
      count: 0,
      giftCount: 0,
      diamonds: 0,
      flash: false,
      names: [],
      people: 0,
      // 人数の重複排除。cap は「1枚のバナーが数える人数」の上限で、
      // 溢れても「ほかN人」が実際より小さくなるだけ(値には無関係)。
      seen: new BoundedSet<UserId>(512),
    };
    acc.amount += amount;
    acc.count += 1;
    acc.giftCount += Math.max(1, e.repeatCount);
    acc.diamonds += e.diamonds;
    if (flash) acc.flash = true;
    // 人数は userId で数える — nickname は空や配信中に変わりうる。
    if (acc.seen.add(e.viewer.userId)) {
      acc.people += 1;
      mergeFanStampName(acc.names, e.viewer.nickname ?? e.viewer.displayId ?? '', FAN_STAMP_NAMES_MAX);
    }
    this.fanStampFx = acc;
  }

  /**
   * 合算窓が明けていたら、窓内に積んだお助けを **effect 1件** にまとめて出す。
   * バナー・効果音(helper)・簡易演出・履歴ログがこれ1件で1回ずつになる。
   *
   * ガードは flushLikeFx と同型。force は「0 到達で achieved になる直前」専用で、
   * achieved より id を先にするために窓と凍結を無視して吐き切る。
   *
   * **カットインは載せない**(fxBandClip 無し)— 先頭の1件が既に1本再生しており、
   * ユーザー決定は「拍手が何個来てもカットインは1本」。
   */
  private flushFanStampFx(force = false): void {
    const p = this.fanStampFx;
    if (p === null) return;
    if (!force) {
      // 凍結中は出さない(「凍結中のイベントは演出も保留する」契約)。
      if (this.status !== 'running' || this.isFxFrozen()) return;
      if (this.fanStampFxUntilMs !== null) {
        // 時計の後方ステップ対策(gift 経路のクランプと同じ理由・同じ上限)。
        const gNow = this.now();
        this.fanStampFxUntilMs = clampFutureMs(
          this.fanStampFxUntilMs,
          gNow,
          Math.max(FAN_STAMP_FX_WINDOW_MS, (this.fxFreezeUntilMs ?? 0) - gNow)
        );
        if (gNow < this.fanStampFxUntilMs) return;
      }
    }
    const nowMs = this.now();
    this.fanStampFx = null;
    this.pushEffect({
      kind: 'gift',
      fanStamp: true,
      amount: p.amount,
      ...(p.flash ? { flash: true as const } : {}),
      // 「ほかN人」を読まない経路(履歴ログの entryFor)のために先頭の1人を入れる。
      ...(p.names[0] != null ? { nickname: p.names[0] } : {}),
      ...(p.giftCount > 1 ? { giftCount: p.giftCount } : {}),
      ...(p.count > 1 ? { coalesced: p.count } : {}),
      // 1人だけなら載せない — 従来の1人文言の経路へ倒して見た目を変えない。
      ...(p.people > 1 ? { fanStampNames: p.names, fanStampPeople: p.people } : {}),
      diamonds: p.diamonds,
      atMs: nowMs,
    });
    // **窓を張り直す** — この合算バナー自身が浮上尺のあいだ画面に出るので、その間に
    // 届いたぶんは「先頭」に戻さず次の1枚へ回す。張り直さないと
    // 「カットイン → 尻バナー → 次が先頭 → またカットイン」で元の症状が周期的に再発する
    // (拍手が鳴り止まない限りカットインは最初の1本だけ、はユーザー決定)。
    this.fanStampFxUntilMs = nowMs + FAN_STAMP_FX_WINDOW_MS;
    this.dirty = true;
  }

  /**
   * 合算窓の中に届いたお助けの「縮退 op」。giftOp から **pushEffect / 凍結 /
   * 連打反復の計算だけを抜いた**もので、値まわりは giftOp と一字一句同じにしてある
   * (畳むのは見た目と音だけ、という全体規約)。
   *
   * ランキング(touchParticipant)は gift 分岐の冒頭・この op の外で済んでいるので
   * 合算しても全件そのまま反映される。
   */
  private fanStampCoalesceOp(e: FanStampFxSource, nominalAmount: number, flash: boolean): void {
    // 応援(負)方向は残量でクランプ(clampDownAmount の doc 参照)。
    const amount = this.clampDownAmount(nominalAmount);
    if (amount < 0) this.stats.giftDown += -amount;
    else if (amount > 0) this.stats.giftUp += amount;
    this.value = Math.max(0, this.value + amount);
    const atMs = this.now();
    this.accumulateFanStampFx(e, amount, flash);
    // 0 到達で achieved になる**前に**必ず吐き切る。後に回すと achieved より
    // effect id が大きくなり、モニターが CLEAR の上へお助けバナーを出す
    // (ルーレットの「達成判定は pushEffect の後」と同じ理由)。
    if (this.value === 0) this.flushFanStampFx(true);
    this.maybeAchieve(atMs);
    this.dirty = true;
  }

  /**
   * スタンプ(サブスクエモート)トリガーの適用。**お助け(fanStamp)のギフト経路の
   * 縮図** — バンド/カットイン/ルーレットが構造的に絡まない(スタンプはギフトでは
   * ない)ので、giftOp から値適用と fanStamp バナー・合算窓だけを写した形。
   * 統計も giftUp/giftDown を使う — モニター・リザルトの「お助け」集計と同じ枠で
   * 見えるのがユーザー決定(演出をお助けと同じにする、の一部)。
   *
   * 合算窓の判定・クランプは gift 経路(handleEvent の fs 分岐)と同じ形。窓の中は
   * 縮退 op(fanStampCoalesceOp)へ、外は effect 1件+窓張りへ。
   */
  private applyStampTrigger(viewer: NormViewer, st: StampTriggerMatch): boolean {
    const src: FanStampFxSource = { viewer, repeatCount: st.count, diamonds: 0 };
    if (this.fanStampFxUntilMs !== null) {
      // 時計の後方ステップ対策(gift 経路のクランプと同じ理由・同じ上限)。
      const gNow = this.now();
      this.fanStampFxUntilMs = clampFutureMs(
        this.fanStampFxUntilMs,
        gNow,
        Math.max(FAN_STAMP_FX_WINDOW_MS, (this.fxFreezeUntilMs ?? 0) - gNow)
      );
    }
    if (this.fanStampFxUntilMs !== null && this.now() < this.fanStampFxUntilMs) {
      return this.applyOrQueue(() => this.fanStampCoalesceOp(src, st.amount, st.flash));
    }
    const stampOp = (allowFx: boolean): void => {
      // 値まわりは fanStampCoalesceOp / giftOp と一字一句同じにしてある
      // (応援方向の残量クランプ含む — clampDownAmount の doc 参照)。
      const amount = this.clampDownAmount(st.amount);
      if (amount < 0) this.stats.giftDown += -amount;
      else if (amount > 0) this.stats.giftUp += amount;
      this.value = Math.max(0, this.value + amount);
      const atMs = this.now();
      if (allowFx) {
        this.pushEffect({
          kind: 'gift',
          fanStamp: true,
          amount,
          ...(st.flash ? { flash: true as const } : {}),
          nickname: viewer.nickname ?? viewer.displayId,
          ...(st.count > 1 ? { giftCount: st.count } : {}),
          diamonds: 0,
          atMs,
        });
      }
      // 合算窓を張る(gift 経路の fs 分岐と同じ式)。スタンプにカットインは無いが、
      // 凍結中に届いた場合は凍結明けまで窓を伸ばす — バナーが出るのは明けてからなので。
      // 縮退時も張る — 窓は「以降を合算に回す」ためのもので、後続の見た目は
      // flushFanStampFx が出す。
      this.fanStampFxUntilMs = Math.max(atMs + FAN_STAMP_FX_WINDOW_MS, this.fxFreezeUntilMs ?? 0);
      this.maybeAchieve(atMs);
      this.dirty = true;
    };
    // キュー溢れ時はバナーを捨てて値だけ適用する(follow / like と同じ縮退)。
    return this.applyOrQueue(
      () => stampOp(true),
      () => stampOp(false)
    );
  }

  /**
   * 応援(負)方向の増減を残量でクランプした「実際に減る量」へ正規化する。
   * 値は Math.max(0, ...) で守られるのに統計(giftDown)と effect の amount が
   * 名目値のままだと、残り 5 に -1000 のお助けで「ギフトで減らした数」が初期値を
   * 超え、バナーも実際より大きい数字を出す — press / boost-end と同じ
   * 「画面上で実際に減った量」規約に揃える。-0 は 0 に正規化する
   * (JSON/表示/テストの等値比較が割れる)。妨害(正)方向はそのまま返す。
   */
  private clampDownAmount(nominal: number): number {
    const clamped = Math.max(nominal, -this.value);
    return clamped === 0 ? 0 : clamped;
  }

  /**
   * 演出を1件積む。valueAfter はここで一括してスタンプする — 呼び出し側5箇所は
   * すべて this.value を更新し終えてから呼ぶ規約なので、この一点で正しくなる
   * (flushLikeFx だけは演出が遅れて出るが、値はその時点で適用済みなので
   * 「いま何になっているか」として正しい)。
   */
  private pushEffect(e: Omit<ChallengeEffect, 'id' | 'valueAfter'>): number {
    const effect: ChallengeEffect = { id: this.nextEffectId++, valueAfter: this.value, ...e };
    // ドレイン中は迂回バッファへ(id 採番と valueAfter は通常どおり済ませてから —
    // id の単調性は watermark 冪等再生の生命線)。finishDrain が ring へ移す。
    if (this.drainFx !== null) {
      this.drainFx.push(effect);
      return effect.id;
    }
    this.recentEffects.unshift(effect);
    while (this.recentEffects.length > CHALLENGE_EFFECTS_MAX) this.recentEffects.pop();
    this.effectsSnapshot = null;
    // 戻り値はアーム(armedBoost.id)の照合キー。**採番規則をここ以外へ写さない** —
    // 呼び出し前に nextEffectId を覗く方式にすると規則が二重化して静かに壊れる。
    return effect.id;
  }
}
