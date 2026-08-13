import type { NormalizedEvent, NormViewer, UserId } from '@shared/events';
import type {
  ChallengeConfig,
  ChallengeEffect,
  ChallengeRankRow,
  ChallengeResult,
  ChallengeState,
  ChallengeStats,
  ChallengeStatus,
  ChallengeStockSlot,
  ChallengeTestEffectSpec,
} from '@shared/dto';
import {
  CHALLENGE_EFFECTS_MAX,
  CHALLENGE_MONITOR_TOP_N,
  CHALLENGE_RESULT_TOP_N,
  GIFT_FX_FREEZE_MARGIN_MS,
  GIFT_FX_FREEZE_MAX_MS,
  GIFT_FX_PENDING_OPS_MAX,
  LIKE_FX_WINDOW_MS,
  drawRouletteIndex,
  giftFxRepeat,
  giftFxRouletteSpins,
  matchCommentRule,
  matchFanStamp,
  matchGiftBand,
  matchGiftFullCut,
  matchGiftRule,
  matchRoulette,
} from '@shared/challenge';
import { drawRoulettePattern } from '@shared/roulette-fx';

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
  private stats: ChallengeStats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, rouletteSpins: 0 };
  private recentEffects: ChallengeEffect[] = [];
  /** reset でも巻き戻さない — モニターの冪等再生(既再生 id 比較)が壊れるため。 */
  private nextEffectId = 1;
  /** フォロー妨害はチャレンジ1回につきユーザー1度だけ(付け外しスパム対策)。 */
  private seenFollowers = new Set<UserId>();
  /**
   * ギフトの msgId 重複排除。手動での停止→再接続は processInitialData: true で
   * バックログを再配信するため(adapter.ts 参照)、これが無いと直前のギフトが
   * 二重適用される。start/reset でも消さない — 再開直後に再配信された古い
   * ギフトは新しいランにも数えてはいけない。
   */
  private seenGiftMsgIds = new Set<string>();
  private seenGiftMsgIdOrder: string[] = [];
  /** like の msgId 重複排除(gift と同じ再接続バックログ対策。高頻度なので容量大きめ)。 */
  private seenLikeMsgIds = new Set<string>();
  private seenLikeMsgIdOrder: string[] = [];
  /** comment の msgId 重複排除(like と同じ再接続バックログ対策)。 */
  private seenCommentMsgIds = new Set<string>();
  private seenCommentMsgIdOrder: string[] = [];
  /**
   * ラン中の参加者集計。CLEAR リザルトの TOP5 と、モニターに常時出るライブ TOP3
   * (ChallengeState.runRank)の**唯一のソース**。集計範囲は「開始→達成」の
   * 1ランだけで、セッション全体ではない — start/reset でクリアする。だから
   * ダッシュボードの「リセット」でモニターのランキングもその場で空になる。
   * エンジン全体の規約どおり DB には一切書かない。
   */
  private runViewers = new Map<UserId, RunParticipant>();
  /** CLEAR 時に1度だけ組み立てて凍結する。生成後は絶対に書き換えない。 */
  private result: ChallengeResult | null = null;
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
   * ダイヤ帯域カットイン再生中のカウンタ凍結の期限。null = 凍結なし。
   * status は変えない — 'idle' は「停止」の意味で使われており(モニターの
   * 「一時停止中」表示)、凍結中もイベントの受付・集計は続くため別概念。
   * 専用タイマーは持たず、イベント入口と 2Hz tick(drainIfChanged)で lazy に
   * 解除する — STRIKE_ABORT_MS と同じ「必ず収束する安全弁」の流儀。
   */
  private fxFreezeUntilMs: number | null = null;
  /**
   * 凍結中に届いたイベントの値適用+演出の保留キュー(dedup・ランキング集計は
   * 凍結中も即時に回る — 取りこぼしゼロの肝)。解除時に到着順で実行し、途中で
   * 新たなバンドギフトが出たら再凍結してドレインを中断する(連続ギフトが
   * 1本ずつ順に演出される)。
   */
  private pendingOps: Array<() => void> = [];
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
     * 検査しているテストが演出を変えただけで壊れる。(2) そもそも演出パターンは
     * 出目と相関してはいけない(相関するとキック=大当たりが学習されて予告になる)
     * ので、乱数源を分けておくほうが意図に忠実。
     */
    private readonly fxRand: () => number = Math.random
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
    this.stats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, rouletteSpins: 0 };
    this.recentEffects = [];
    this.seenFollowers.clear();
    this.runViewers.clear();
    this.result = null;
    this.resetLikeAccumulators();
    // 前ラン由来の保留分を新ランへ持ち込まない(値は initialValue で始める規約)。
    this.pendingOps = [];
    this.fxFreezeUntilMs = null;
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
      this.forceApplyPendingOps();
    } finally {
      this.stopping = false;
    }
    this.status = 'idle';
    // 停止後に合算待ちの演出が漏れないように捨てる(値には適用済み)。
    this.likeFxPending = 0;
    this.dirty = true;
    return this.get();
  }

  reset(): ChallengeState {
    // 直後に initialValue で上書きするので保留分は適用せず捨てる。
    this.pendingOps = [];
    this.fxFreezeUntilMs = null;
    this.armFreezeTimer();
    this.status = 'idle';
    this.value = this.getConfig().initialValue;
    this.startedMs = null;
    this.achievedMs = null;
    this.stats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, rouletteSpins: 0 };
    this.recentEffects = [];
    this.seenFollowers.clear();
    this.runViewers.clear();
    this.result = null;
    this.resetLikeAccumulators();
    this.dirty = true;
    return this.get();
  }

  /** idle/achieved 中のホットキーはエラーにせず無視する(配信中の誤爆対策)。 */
  press(): ChallengeState {
    if (this.status !== 'running') return this.get();
    this.flushFxFreeze(this.now());
    // 凍結中はキューへ(カウンタ一時停止の一貫性 — 数字は演出後に動く)。
    this.applyOrQueue(() => {
      const step = this.getConfig().pressStep;
      this.value = Math.max(0, this.value - step);
      this.stats.presses++;
      this.pushEffect({ kind: 'press', amount: -step, atMs: this.now() });
      this.maybeAchieve(this.now());
      this.dirty = true;
    });
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
          amount: fs.amountEach,
          ...(fs.flash ? { flash: true } : {}),
          fanStamp: true,
          nickname: 'テスト',
          giftName: 'ファンスタンプ',
          // 演出 tier は t1(1ダイヤ)相当。実運用のファンスタンプも1ダイヤ。
          diamonds: 1,
        };
        break;
      }
      case 'gift': {
        const m = matchGiftRule(cfg, { canonical: spec.canonical, giftId: 'test', diamonds: spec.diamonds });
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
          giftName: spec.canonical ?? 'テストギフト',
          ...(spec.canonical ? { canonical: spec.canonical } : {}),
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
      case 'roulette': {
        // 行ごとの実演。未指定・対象行が消えていたら最初の有効な行(GiftBandFx の
        // bandId と同じ流儀)。1件も無ければ積む演出が無いのでそのまま抜ける。
        const rl =
          cfg.roulettes.find((r) => r.id === spec.rouletteId) ?? cfg.roulettes.find((r) => r.enabled);
        if (!rl) return;
        const idx = drawRouletteIndex(rl.segments, this.rand);
        const seg = rl.segments[idx]!;
        e = {
          kind: 'roulette',
          amount: rl.direction === 'sub' ? -seg.amount : seg.amount,
          rouletteSegments: rl.segments.map((s) => s.amount),
          rouletteIndex: idx,
          // 効果音スロットの試聴は 'kick' を狙い撃ちしたいので spec の指定を優先する。
          roulettePattern: spec.pattern ?? drawRoulettePattern(this.fxRand),
          ...(rl.label !== '' ? { rouletteLabel: rl.label } : {}),
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
    this.dirty = true;
  }

  // ── TikTok イベント ──────────────────────────────────────────────────────

  /** 戻り値 true = 状態が変わった(呼び出し側が即時 delta を送る)。 */
  handleEvent(e: NormalizedEvent): boolean {
    if (this.status !== 'running') return false;
    // 凍結期限が来ていればここで解除する(2Hz tick と並ぶ lazy 解除の入口)。
    this.flushFxFreeze(this.now());
    const cfg = this.getConfig();

    // フォロー = 妨害。normalize.ts の契約どおり sub === 'follow' のみで判定する
    // (libType 'follow' は実配信では来ない — WebcastSocialMessage 経由)。
    // dedup(seenFollowers)は凍結中も即時に回し、値適用+演出だけを保留する。
    if (e.kind === 'social' && e.sub === 'follow') {
      if (this.seenFollowers.has(e.viewer.userId)) return false;
      this.seenFollowers.add(e.viewer.userId);
      if (cfg.followStep <= 0) return false;
      return this.applyOrQueue(() => {
        this.value += cfg.followStep;
        this.stats.follows++;
        // atMs は e.tsMs(TikTokサーバ時刻)ではなくローカル時計。モニターの
        // 「5秒より古い演出はスキップ」判定と同じ時計で比較させるため。
        // 凍結明けの実行でも this.now() を読むので、このゲートで死なない。
        this.pushEffect({
          kind: 'follow',
          amount: cfg.followStep,
          nickname: e.viewer.nickname ?? e.viewer.displayId,
          atMs: this.now(),
        });
        this.dirty = true;
      });
    }

    // 指定コメント = 妨害。キーワード部分一致で規則の量だけ増える(上から先勝ち)。
    // 連投対策は入れない — 打たれるたび毎回反応する(いいね妨害と同じ「祭り」方向。
    // ユーザーの明示選択)。二重適用を防ぐのは msgId dedup だけ。
    if (e.kind === 'comment') {
      // 再接続バックログの二重適用ガード(like と同じ)。規則ガードより前に通す —
      // 規則なしの間に届いた msgId も、後から規則を足した再配信では二重に数えない。
      if (this.seenCommentMsgIds.has(e.msgId)) return false;
      this.seenCommentMsgIds.add(e.msgId);
      this.seenCommentMsgIdOrder.push(e.msgId);
      while (this.seenCommentMsgIdOrder.length > 1024) {
        this.seenCommentMsgIds.delete(this.seenCommentMsgIdOrder.shift()!);
      }
      // 規則は到着時点の cfg で確定させる(バンド判定と同じ規約 — 凍結明けに
      // 読み直すと、同じコメントの判定が設定変更のタイミングで揺れる)。
      const rule = matchCommentRule(cfg, e.content);
      if (!rule) return false;
      const nickname = e.viewer.nickname ?? e.viewer.displayId;
      return this.applyOrQueue(() => {
        this.value += rule.amount; // 加算方向のみなので maybeAchieve もクランプも不要
        this.stats.commentUp += rule.amount;
        this.pushEffect({
          kind: 'comment',
          amount: rule.amount,
          nickname,
          commentKeyword: rule.keyword,
          atMs: this.now(),
        });
        this.dirty = true;
        return true;
      });
    }

    // いいね = 妨害。likeEvery 件ごとに likeStep 増える(余りは繰り越し)。
    if (e.kind === 'like') {
      // 再接続バックログの二重適用ガード(gift と同じ)。like は高頻度なので容量 1024。
      // 設定ガードより前に通す — いいね妨害が無効でもリザルトのランキングは集計する。
      if (this.seenLikeMsgIds.has(e.msgId)) return false;
      this.seenLikeMsgIds.add(e.msgId);
      this.seenLikeMsgIdOrder.push(e.msgId);
      while (this.seenLikeMsgIdOrder.length > 1024) {
        this.seenLikeMsgIds.delete(this.seenLikeMsgIdOrder.shift()!);
      }
      // e.count は「このバッチのいいね数」(累計ではない — events.ts の契約)。
      const add = Math.max(0, e.count);
      if (add === 0) return false; // 件数ゼロのイベントで delta を出さない

      // イイネランキングはゲージ設定と独立に集計する(妨害 OFF でも順位は出す)。
      // dedup と同じく凍結中も即時 — 保留するのは値適用+演出だけ。
      this.touchParticipant(e.viewer).likes += add;

      // ここから下は「いいね妨害」= カウント加算。無効なら値には触らない。
      if (cfg.likeEvery <= 0 || cfg.likeStep <= 0) return false;
      return this.applyOrQueue(() => {
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
        const nowMs = this.now();
        if (nowMs - this.likeFxLastMs >= LIKE_FX_WINDOW_MS) {
          this.pushEffect({ kind: 'like', amount: this.likeFxPending, atMs: nowMs });
          this.likeFxPending = 0;
          this.likeFxLastMs = nowMs;
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
            this.pushEffect({ kind: 'stock-full', amount: bonus, atMs: nowMs });
          }
        }
        this.dirty = true;
        return true;
      });
    }

    if (e.kind === 'gift') {
      // 再接続バックログの二重適用ガード(DB の INSERT OR IGNORE と同じ役割)。
      if (this.seenGiftMsgIds.has(e.msgId)) return false;
      this.seenGiftMsgIds.add(e.msgId);
      this.seenGiftMsgIdOrder.push(e.msgId);
      while (this.seenGiftMsgIdOrder.length > 512) {
        this.seenGiftMsgIds.delete(this.seenGiftMsgIdOrder.shift()!);
      }
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

      // ファンスタンプ(お助け)。ルーレット・giftRules・giftDefault の**どれよりも先**に
      // 評価し、一致したら増減の写像を丸ごと置き換える — ルーレットが giftRules に対して
      // 果たしているのと同じ「先勝ち」の役割(二重適用防止)。ルーレットより上に置くのは、
      // 同じ giftId を両方に登録された設定で「お助けのはずが数字が増える」という説明の
      // つかない挙動を作らないため。
      const fs = matchFanStamp(cfg, { canonical: e.canonical, giftId: e.giftId, giftName: e.giftName });

      // ギフトルーレット。複数登録できるが、回るのは上から見て最初に一致した1件だけ
      //(matchRoulette の先勝ち)。トリガー一致時は giftRules/giftDefault を評価しない —
      // ルーレットが増減の写像を置き換える(既定の perDiamond +1 との二重適用防止)。
      // 抽選も値適用もここで即時確定し、モニターは「確定済みの出目」を演出として
      // 遅延再生するだけ(like 着弾の据え置きと同じ解法)。連打でも1イベント=1スピン
      // (heart_me は giftType 4 で1メッセージずつ届く。type 1 連打は normalize.ts が
      // repeatEnd で1件に畳み済み)。
      // お助け一致時は matchRoulette 自体を評価しない — 抽選(this.rand)を消費させない。
      const rl = fs
        ? null
        : matchRoulette(cfg, { canonical: e.canonical, giftId: e.giftId, giftName: e.giftName });
      if (rl) {
        // 連打ギフトの反復スピン。ルーレットは抽選なので、反復するには出目を N 回
        // 引くしかない — **ここだけは値の増減も回数ぶんになる**(他の演出反復は
        // 見た目だけで値を動かさない)。既定トリガーの heart_me は giftType 4 で
        // 1メッセージずつ届くため repeatCount は 1 で、実質 1 スピンのまま。
        const spins = giftFxRouletteSpins(cfg, e.repeatCount);
        return this.applyOrQueue(() => {
          for (let i = 0; i < spins; i++) {
            // ドレイン中に 0 到達したら残りは回さない(達成後のイベントは
            // 元のタイムラインでも無視されるため — flushFxFreeze と同じ判断)。
            if (i > 0 && this.status !== 'running') break;
            const idx = drawRouletteIndex(rl.segments, this.rand);
            const seg = rl.segments[idx]!;
            const amount = rl.direction === 'sub' ? -seg.amount : seg.amount;
            if (amount < 0) this.stats.giftDown += -amount;
            else this.stats.giftUp += amount;
            this.stats.rouletteSpins++;
            this.value = Math.max(0, this.value + amount);
            this.pushEffect({
              kind: 'roulette',
              amount,
              rouletteSegments: rl.segments.map((s) => s.amount),
              rouletteIndex: idx,
              // 終盤の演出パターンも effect に載せる。**出目を引いたあとに、出目とは
              // 無関係に引く** — 相関するとキック=大当たりが学習されて予告になる。
              roulettePattern: drawRoulettePattern(this.fxRand),
              // 表示名も effect に載せて自己完結させる(モニターの cfg は 30秒
              // ポーリングで古くなりうる — rouletteSegments と同じ理由)。
              ...(rl.label !== '' ? { rouletteLabel: rl.label } : {}),
              nickname: e.viewer.nickname ?? e.viewer.displayId,
              ...(e.giftName ? { giftName: e.giftName } : {}),
              ...(e.repeatCount > 1 ? { giftCount: e.repeatCount } : {}),
              ...(e.iconUrl ? { giftIconUrl: e.iconUrl } : {}),
              diamonds: e.diamonds,
              atMs: this.now(),
            });
            this.maybeAchieve(this.now()); // direction:'sub' なら 0 到達しうる
          }
          this.dirty = true;
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
      if (!m && !band && !fullCut) return false;
      const giftOp = (allowBand: boolean): void => {
        const amount = m?.amount ?? 0;
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
          // モニターが演出クリップを選ぶのに使う(増減量の判定とは別経路)。
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
        }
        this.maybeAchieve(atMs);
        this.dirty = true;
      };
      // キュー溢れ時はカットイン(と再凍結)を捨てて値だけ適用する(値の正しさ優先)。
      return this.applyOrQueue(() => giftOp(true), () => giftOp(false));
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
    this.dirty = true;
  }

  // ── スナップショット ─────────────────────────────────────────────────────

  /** dirty を落とさないスナップショット。 */
  get(): ChallengeState {
    const cfg = this.getConfig();
    // モニター下部のライブランキング。result(TOP5)と違い走行中も載せる —
    // モニターにとって唯一のランキング情報源で、増えるアバターURL も3本だけ。
    const runRank = this.topRank('diamonds', CHALLENGE_MONITOR_TOP_N);
    return {
      status: this.status,
      value: this.value,
      initialValue: cfg.initialValue,
      title: cfg.title,
      startedMs: this.startedMs,
      achievedMs: this.achievedMs,
      stats: { ...this.stats },
      recentEffects: this.recentEffects.map((e) => ({ ...e })),
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
      fxFreezeUntilMs: this.fxFreezeUntilMs,
    };
  }

  /** 変化していたら1回だけ状態を返す(pushDelta の相乗り用)。 */
  drainIfChanged(): ChallengeState | null {
    // 2Hz tick が凍結解除の安全弁 — イベントが途絶えても最大 500ms 遅れで解除する。
    this.flushFxFreeze(this.now());
    this.flushLikeFx();
    if (!this.dirty) return null;
    this.dirty = false;
    return this.get();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  // ── カットイン凍結(fxFreeze) ────────────────────────────────────────────

  private isFxFrozen(): boolean {
    return this.fxFreezeUntilMs !== null;
  }

  /** 凍結期限に合わせてワンショットタイマーを張り直す(null なら外すだけ)。 */
  private armFreezeTimer(): void {
    if (this.freezeTimer !== null) {
      clearTimeout(this.freezeTimer);
      this.freezeTimer = null;
    }
    if (this.fxFreezeUntilMs === null) return;
    // +25ms: flushFxFreeze の「期限ちょうど」比較を確実に越えてから発火する。
    const delay = Math.max(0, this.fxFreezeUntilMs - this.now()) + 25;
    const t = setTimeout(() => {
      this.freezeTimer = null;
      this.flushFxFreeze(this.now());
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
   * 能力が失われた瞬間に凍結中なら即時解除する共通処理。
   * 戻り値 = 状態が変わった(呼び出し側は nudge して delta を配ること)。
   */
  private applyFxCapsChange(): boolean {
    if (this.fxAllowed() || !this.isFxFrozen()) return false;
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
   */
  private applyOrQueue(op: () => boolean | void, overflowOp?: () => boolean | void): boolean {
    if (!this.isFxFrozen()) return op() !== false;
    if (this.pendingOps.length >= GIFT_FX_PENDING_OPS_MAX) {
      return (overflowOp ?? op)() !== false;
    }
    this.pendingOps.push(() => void op());
    return false;
  }

  /**
   * 凍結の期限が来ていたら解除し、保留分を到着順に適用する。ドレイン中に新たな
   * バンドギフトが凍結を張り直したら中断する(残りは次の解除で — 連続ギフトが
   * 1本ずつ順に演出される)。ドレイン中に 0 到達で achieved になったら残りは
   * 捨てる — 達成後のイベントは元のタイムラインでも無視されるため。
   */
  private flushFxFreeze(nowMs: number): void {
    if (this.fxFreezeUntilMs === null || nowMs < this.fxFreezeUntilMs) return;
    this.fxFreezeUntilMs = null;
    this.dirty = true;
    // ドレイン中の演出は迂回バッファへ(finishDrain が同種を畳んで ring へ移す)。
    this.drainFx = [];
    try {
      while (this.pendingOps.length > 0) {
        if (this.status !== 'running') {
          this.pendingOps = [];
          break;
        }
        this.pendingOps.shift()!();
        if (this.fxFreezeUntilMs !== null) break;
      }
    } finally {
      this.finishDrain();
    }
    // 再凍結(ドレイン中断)なら次の期限で張り直し、解除完了なら外す。
    this.armFreezeTimer();
  }

  /** stop 用の強制適用。保留分を残さず適用する(ドレイン中の再凍結は無視)。 */
  private forceApplyPendingOps(): void {
    this.fxFreezeUntilMs = null;
    this.drainFx = [];
    try {
      while (this.pendingOps.length > 0) {
        if (this.status !== 'running') break;
        this.pendingOps.shift()!();
        this.fxFreezeUntilMs = null;
      }
      this.pendingOps = [];
    } finally {
      this.finishDrain();
    }
    this.armFreezeTimer();
  }

  /**
   * ドレイン迂回バッファを閉じ、同種の演出を1件に畳んで ring へ移す。
   * 値・統計は各 op で適用済み — ここで畳むのは**見た目と履歴の行**だけ。
   * 畳み規則: press/like/follow/stock-full は全件→1件(amount 合算+coalesced)、
   * comment は keyword 単位、gift は canonical 単位(カットイン付きは畳まない —
   * ドレインを中断させた再凍結ギフトで、カットインは effect 1件で自己完結する
   * 契約)、roulette は新しい3件を盤面つきで残し古い分を1件に(盤面なしは
   * モニターがバナーのみ再生する既存フォールバックに乗る)、achieved は単独。
   * 1件だけのグループは原型のまま(coalesced を付けない)。
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
        if (group.some((e) => e.giftCount != null)) merged.giftCount = sum('giftCount');
        if (group.some((e) => e.diamonds != null)) merged.diamonds = sum('diamonds');
        // 反復演出は畳んだら意味を失う(1件ぶんの見た目で十分)。
        delete merged.fxRepeat;
        delete merged.fxRepeatIntervalMs;
      }
      if (last.kind === 'roulette') {
        // 盤面を落としてバナーのみのフォールバックへ(リールを N 回逆再生しない)。
        delete merged.rouletteSegments;
        delete merged.rouletteIndex;
        delete merged.roulettePattern;
      }
      out.push(merged);
    };
    // グループ分け(到着順を保つ)。
    const groups = new Map<string, ChallengeEffect[]>();
    const singles: ChallengeEffect[] = [];
    const ROULETTE_KEEP = 3;
    const rouletteAll = buf.filter((e) => e.kind === 'roulette');
    const rouletteOld = new Set(rouletteAll.slice(0, Math.max(0, rouletteAll.length - ROULETTE_KEEP)));
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
          key = rouletteOld.has(e) ? 'roulette:old' : null;
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
  }

  /** 達成演出は1回だけ。達成後は press/follow/gift すべて無効(status ガード)。 */
  private maybeAchieve(atMs: number): void {
    // stop() の強制適用中は達成させない — 直後に idle で上書きされるため、
    // achieved effect とリザルトだけが半端に生成されて配信されてしまう。
    if (this.stopping) return;
    if (this.value > 0 || this.status !== 'running') return;
    this.status = 'achieved';
    this.achievedMs = atMs;
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
   * CLEAR 時点で1度だけ組む。以後は不変(達成後はイベントを受け付けないので
   * 変わりようもない)。
   */
  private buildResult(atMs: number): ChallengeResult {
    return {
      atMs,
      startedMs: this.startedMs,
      participants: this.runViewers.size,
      gifts: this.topRank('diamonds', CHALLENGE_RESULT_TOP_N),
      likes: this.topRank('likes', CHALLENGE_RESULT_TOP_N),
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
    if (nowMs - this.likeFxLastMs < LIKE_FX_WINDOW_MS) return;
    this.pushEffect({ kind: 'like', amount: this.likeFxPending, atMs: nowMs });
    this.likeFxPending = 0;
    this.likeFxLastMs = nowMs;
    this.dirty = true;
  }

  /**
   * 演出を1件積む。valueAfter はここで一括してスタンプする — 呼び出し側5箇所は
   * すべて this.value を更新し終えてから呼ぶ規約なので、この一点で正しくなる
   * (flushLikeFx だけは演出が遅れて出るが、値はその時点で適用済みなので
   * 「いま何になっているか」として正しい)。
   */
  private pushEffect(e: Omit<ChallengeEffect, 'id' | 'valueAfter'>): void {
    const effect: ChallengeEffect = { id: this.nextEffectId++, valueAfter: this.value, ...e };
    // ドレイン中は迂回バッファへ(id 採番と valueAfter は通常どおり済ませてから —
    // id の単調性は watermark 冪等再生の生命線)。finishDrain が ring へ移す。
    if (this.drainFx !== null) {
      this.drainFx.push(effect);
      return;
    }
    this.recentEffects.unshift(effect);
    while (this.recentEffects.length > CHALLENGE_EFFECTS_MAX) this.recentEffects.pop();
  }
}
