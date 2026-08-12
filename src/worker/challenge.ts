import type { NormalizedEvent, NormViewer, UserId } from '@shared/events';
import type {
  ChallengeConfig,
  ChallengeEffect,
  ChallengeRankRow,
  ChallengeResult,
  ChallengeState,
  ChallengeStats,
  ChallengeStatus,
} from '@shared/dto';
import {
  CHALLENGE_EFFECTS_MAX,
  CHALLENGE_RESULT_TOP_N,
  GIFT_FX_FREEZE_MARGIN_MS,
  GIFT_FX_FREEZE_MAX_MS,
  GIFT_FX_PENDING_OPS_MAX,
  LIKE_FX_WINDOW_MS,
  drawRouletteIndex,
  matchGiftBand,
  matchGiftRule,
  matchRouletteTrigger,
} from '@shared/challenge';

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
  private stats: ChallengeStats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, rouletteSpins: 0 };
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
  /**
   * ラン中の参加者集計(CLEAR リザルトの TOP5 専用)。集計範囲は「開始→達成」の
   * 1ランだけで、セッション全体ではない — start/reset でクリアする。
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
  /** 生成直後は true — 起動後の最初の delta で初期状態をモニターへ配るため。 */
  private dirty = true;

  constructor(
    private readonly getConfig: () => ChallengeConfig,
    private readonly now: () => number = Date.now,
    /** ルーレット抽選の乱数源。テストで固定値を注入する(now と同じ流儀)。 */
    private readonly rand: () => number = Math.random
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
    this.stats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, rouletteSpins: 0 };
    this.recentEffects = [];
    this.seenFollowers.clear();
    this.runViewers.clear();
    this.result = null;
    this.resetLikeAccumulators();
    // 前ラン由来の保留分を新ランへ持ち込まない(値は initialValue で始める規約)。
    this.pendingOps = [];
    this.fxFreezeUntilMs = null;
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
    this.forceApplyPendingOps();
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
    this.status = 'idle';
    this.value = this.getConfig().initialValue;
    this.startedMs = null;
    this.achievedMs = null;
    this.stats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, rouletteSpins: 0 };
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
        // いいねストック: ゲージ満タン units 回ぶん点灯し、規定数で追加ボーナス(妨害)。
        // ゲージ有効(上の早期 return を抜けた)が前提の従属機能なので、ここに置く。
        if (cfg.likeStockCount > 0 && cfg.likeStockStep > 0) {
          this.likeStocks += units;
          const stockUnits = Math.floor(this.likeStocks / cfg.likeStockCount);
          if (stockUnits > 0) {
            this.likeStocks -= stockUnits * cfg.likeStockCount;
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
      // リザルトのギフトランキングは規則に紐づかないギフトも数える —
      // matchGiftRule の早期 return より前に置くこと(後ろに置くと、カウントに
      // 効かないギフトがランキングから消える)。dirty は立てない: リザルトは
      // 達成まで誰にも見えないので、ここで 2Hz の push を増やす理由がない。
      if (e.diamonds > 0) this.touchParticipant(e.viewer).diamonds += e.diamonds;

      // ギフトルーレット。トリガー一致時は giftRules/giftDefault を評価しない —
      // ルーレットが増減の写像を置き換える(既定の perDiamond +1 との二重適用防止)。
      // 抽選も値適用もここで即時確定し、モニターは「確定済みの出目」を演出として
      // 遅延再生するだけ(like 着弾の据え置きと同じ解法)。連打でも1イベント=1スピン
      // (heart_me は giftType 4 で1メッセージずつ届く。type 1 連打は normalize.ts が
      // repeatEnd で1件に畳み済み)。
      const rl = cfg.roulette;
      if (rl.enabled && matchRouletteTrigger(rl, { canonical: e.canonical, giftId: e.giftId, giftName: e.giftName })) {
        return this.applyOrQueue(() => {
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
            nickname: e.viewer.nickname ?? e.viewer.displayId,
            ...(e.giftName ? { giftName: e.giftName } : {}),
            ...(e.repeatCount > 1 ? { giftCount: e.repeatCount } : {}),
            ...(e.iconUrl ? { giftIconUrl: e.iconUrl } : {}),
            diamonds: e.diamonds,
            atMs: this.now(),
          });
          this.maybeAchieve(this.now()); // direction:'sub' なら 0 到達しうる
          this.dirty = true;
        });
      }

      // e.diamonds は normalize.ts が diamondEach × repeatCount を一度だけ計算した
      // 確定値。ここでは絶対に再計算しない(全体規約)。
      // バンド(ダイヤ帯域カットイン)も到着時点の設定で確定する — 凍結明けの
      // 実行時に設定を読み直すと、同じギフトの判定が設定変更のタイミングで
      // 揺れるため。増減規則に一致しないギフトでもバンド一致なら演出は出す
      // (overFlash の「規則が空でも照明だけは出す」と同じ精神)。
      const m = matchGiftRule(cfg, { canonical: e.canonical, giftId: e.giftId, diamonds: e.diamonds });
      const band = matchGiftBand(cfg, { canonical: e.canonical, giftId: e.giftId, diamonds: e.diamonds });
      if (!m && !band) return false;
      const giftOp = (allowBand: boolean): void => {
        const amount = m?.amount ?? 0;
        if (amount < 0) this.stats.giftDown += -amount;
        else if (amount > 0) this.stats.giftUp += amount;
        this.value = Math.max(0, this.value + amount);
        const atMs = this.now();
        const b = allowBand ? band : null;
        // 動画長ではなく設定の秒数が権威(モニターは loop + タイマーで合わせる)。
        const fxDurationMs = b ? Math.min(b.durationSec * 1000, GIFT_FX_FREEZE_MAX_MS) : 0;
        this.pushEffect({
          kind: 'gift',
          amount,
          ...(m?.flash ? { flash: true } : {}),
          nickname: e.viewer.nickname ?? e.viewer.displayId,
          ...(e.giftName ? { giftName: e.giftName } : {}),
          // 連打数。diamonds と同じく normalize.ts の確定値をそのまま載せる。
          ...(e.repeatCount > 1 ? { giftCount: e.repeatCount } : {}),
          ...(e.iconUrl ? { giftIconUrl: e.iconUrl } : {}),
          // モニターが演出クリップを選ぶのに使う(増減量の判定とは別経路)。
          ...(e.canonical ? { canonical: e.canonical } : {}),
          // カットインは effect 1件で自己完結させる(rouletteSegments と同じ流儀)。
          ...(b ? { fxBandClip: b.clip, fxDurationMs } : {}),
          // BGM も同じ流儀で id を effect に載せる(音量だけは cfg から読む)。
          // 判定は到着時点の cfg — fxBandClip と同じタイミングで確定させる。
          ...(b && b.bgm !== 'off' && cfg.giftBandFx.bgmEnabled ? { fxBandBgm: b.bgm } : {}),
          diamonds: e.diamonds,
          atMs,
        });
        // 凍結はトリガーギフト自身の値適用+push の後に張る — valueAfter 規約を
        // 守りつつ、以降のイベントを演出明けまで保留する。
        if (b) this.fxFreezeUntilMs = atMs + fxDurationMs + GIFT_FX_FREEZE_MARGIN_MS;
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
                  ? { count: cfg.likeStockCount, filled: this.likeStocks, step: cfg.likeStockStep, fills: this.stockFills }
                  : null,
            }
          : null,
      // 達成中だけ載せる — running 中に載せるとアバターURL 10 本が 2Hz の delta
      // 全部に乗る。生成後は書き換えないので、コピーせず同じ参照を返してよい
      // (worker→main は postMessage の structuredClone を通る)。
      result: this.status === 'achieved' ? this.result : null,
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
    while (this.pendingOps.length > 0) {
      if (this.status !== 'running') {
        this.pendingOps = [];
        break;
      }
      this.pendingOps.shift()!();
      if (this.fxFreezeUntilMs !== null) break;
    }
  }

  /** stop 用の強制適用。保留分を残さず適用する(ドレイン中の再凍結は無視)。 */
  private forceApplyPendingOps(): void {
    this.fxFreezeUntilMs = null;
    while (this.pendingOps.length > 0) {
      if (this.status !== 'running') break;
      this.pendingOps.shift()!();
      this.fxFreezeUntilMs = null;
    }
    this.pendingOps = [];
  }

  /** 達成演出は1回だけ。達成後は press/follow/gift すべて無効(status ガード)。 */
  private maybeAchieve(atMs: number): void {
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
      p = { userId: v.userId, diamonds: 0, likes: 0 };
      this.runViewers.set(v.userId, p);
      if (this.runViewers.size > RUN_VIEWERS_HARD) this.pruneRunViewers();
    }
    if (v.nickname) p.nickname = v.nickname;
    if (v.displayId) p.displayId = v.displayId;
    if (v.avatarUrl) p.avatarUrl = v.avatarUrl;
    // prune で今作った p が Map から落ちることはあるが、その場合も加算が捨てられる
    // だけで安全(TOP5 に届かない参加者なので結果は変わらない)。
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
   * CLEAR 時点で1度だけ組む。以後は不変(達成後はイベントを受け付けないので
   * 変わりようもない)。Map は挿入順 = 初参加順、Array#sort は安定なので、
   * 同数は先に参加した方が上位になる。
   */
  private buildResult(atMs: number): ChallengeResult {
    const all = [...this.runViewers.values()];
    const top = (key: 'diamonds' | 'likes'): ChallengeRankRow[] =>
      all
        .filter((p) => p[key] > 0)
        .sort((a, b) => b[key] - a[key])
        .slice(0, CHALLENGE_RESULT_TOP_N)
        .map((p) => ({
          userId: p.userId,
          nickname: p.nickname ?? p.displayId ?? '',
          avatarUrl: p.avatarUrl ?? null,
          diamonds: p.diamonds,
          likes: p.likes,
        }));
    return {
      atMs,
      startedMs: this.startedMs,
      participants: all.length,
      gifts: top('diamonds'),
      likes: top('likes'),
    };
  }

  private resetLikeAccumulators(): void {
    // seenLikeMsgIds は gift 同様クリアしない — 再開直後に再配信された古い
    // いいねを新しいランに数えないため。
    this.likeCounter = 0;
    // stockFills(満杯累計)は巻き戻さない — likeFills と同じ単調増加規約。
    this.likeStocks = 0;
    this.likeFxPending = 0;
    this.likeFxLastMs = 0;
  }

  /**
   * 合算窓が明けていたら、窓内に積んだいいね演出を1件にまとめて出す。
   * いいねが止まった後の残りも 2Hz tick 側から最大約1.5秒で表示される。
   */
  private flushLikeFx(): void {
    if (this.likeFxPending <= 0 || this.status !== 'running') return;
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
    this.recentEffects.unshift({ id: this.nextEffectId++, valueAfter: this.value, ...e });
    while (this.recentEffects.length > CHALLENGE_EFFECTS_MAX) this.recentEffects.pop();
  }
}
