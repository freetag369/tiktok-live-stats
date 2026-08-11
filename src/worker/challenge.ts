import type { NormalizedEvent, UserId } from '@shared/events';
import type { ChallengeConfig, ChallengeEffect, ChallengeState, ChallengeStats, ChallengeStatus } from '@shared/dto';
import { CHALLENGE_EFFECTS_MAX, matchGiftRule } from '@shared/challenge';

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
  private stats: ChallengeStats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0 };
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
  /** 生成直後は true — 起動後の最初の delta で初期状態をモニターへ配るため。 */
  private dirty = true;

  constructor(
    private readonly getConfig: () => ChallengeConfig,
    private readonly now: () => number = Date.now
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
    this.stats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0 };
    this.recentEffects = [];
    this.seenFollowers.clear();
    this.dirty = true;
    return this.get();
  }

  /** 値は凍結表示のため残す。startedMs も統計表示用に残す。 */
  stop(): ChallengeState {
    this.status = 'idle';
    this.dirty = true;
    return this.get();
  }

  reset(): ChallengeState {
    this.status = 'idle';
    this.value = this.getConfig().initialValue;
    this.startedMs = null;
    this.achievedMs = null;
    this.stats = { presses: 0, follows: 0, giftDown: 0, giftUp: 0 };
    this.recentEffects = [];
    this.seenFollowers.clear();
    this.dirty = true;
    return this.get();
  }

  /** idle/achieved 中のホットキーはエラーにせず無視する(配信中の誤爆対策)。 */
  press(): ChallengeState {
    if (this.status !== 'running') return this.get();
    const step = this.getConfig().pressStep;
    this.value = Math.max(0, this.value - step);
    this.stats.presses++;
    this.pushEffect({ kind: 'press', amount: -step, atMs: this.now() });
    this.maybeAchieve(this.now());
    this.dirty = true;
    return this.get();
  }

  // ── TikTok イベント ──────────────────────────────────────────────────────

  /** 戻り値 true = 状態が変わった(呼び出し側が即時 delta を送る)。 */
  handleEvent(e: NormalizedEvent): boolean {
    if (this.status !== 'running') return false;
    const cfg = this.getConfig();

    // フォロー = 妨害。normalize.ts の契約どおり sub === 'follow' のみで判定する
    // (libType 'follow' は実配信では来ない — WebcastSocialMessage 経由)。
    if (e.kind === 'social' && e.sub === 'follow') {
      if (this.seenFollowers.has(e.viewer.userId)) return false;
      this.seenFollowers.add(e.viewer.userId);
      if (cfg.followStep <= 0) return false;
      this.value += cfg.followStep;
      this.stats.follows++;
      // atMs は e.tsMs(TikTokサーバ時刻)ではなくローカル時計。モニターの
      // 「5秒より古い演出はスキップ」判定と同じ時計で比較させるため。
      this.pushEffect({
        kind: 'follow',
        amount: cfg.followStep,
        nickname: e.viewer.nickname ?? e.viewer.displayId,
        atMs: this.now(),
      });
      this.dirty = true;
      return true;
    }

    if (e.kind === 'gift') {
      // 再接続バックログの二重適用ガード(DB の INSERT OR IGNORE と同じ役割)。
      if (this.seenGiftMsgIds.has(e.msgId)) return false;
      this.seenGiftMsgIds.add(e.msgId);
      this.seenGiftMsgIdOrder.push(e.msgId);
      while (this.seenGiftMsgIdOrder.length > 512) {
        this.seenGiftMsgIds.delete(this.seenGiftMsgIdOrder.shift()!);
      }
      // e.diamonds は normalize.ts が diamondEach × repeatCount を一度だけ計算した
      // 確定値。ここでは絶対に再計算しない(全体規約)。
      const m = matchGiftRule(cfg, { canonical: e.canonical, giftId: e.giftId, diamonds: e.diamonds });
      if (!m) return false;
      if (m.amount < 0) this.stats.giftDown += -m.amount;
      else if (m.amount > 0) this.stats.giftUp += m.amount;
      this.value = Math.max(0, this.value + m.amount);
      this.pushEffect({
        kind: 'gift',
        amount: m.amount,
        ...(m.flash ? { flash: true } : {}),
        nickname: e.viewer.nickname ?? e.viewer.displayId,
        ...(e.giftName ? { giftName: e.giftName } : {}),
        ...(e.iconUrl ? { giftIconUrl: e.iconUrl } : {}),
        diamonds: e.diamonds,
        atMs: this.now(),
      });
      this.maybeAchieve(this.now());
      this.dirty = true;
      return true;
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
    return {
      status: this.status,
      value: this.value,
      initialValue: this.getConfig().initialValue,
      title: this.getConfig().title,
      startedMs: this.startedMs,
      achievedMs: this.achievedMs,
      stats: { ...this.stats },
      recentEffects: this.recentEffects.map((e) => ({ ...e })),
    };
  }

  /** 変化していたら1回だけ状態を返す(pushDelta の相乗り用)。 */
  drainIfChanged(): ChallengeState | null {
    if (!this.dirty) return null;
    this.dirty = false;
    return this.get();
  }

  // ── 内部 ─────────────────────────────────────────────────────────────────

  /** 達成演出は1回だけ。達成後は press/follow/gift すべて無効(status ガード)。 */
  private maybeAchieve(atMs: number): void {
    if (this.value > 0 || this.status !== 'running') return;
    this.status = 'achieved';
    this.achievedMs = atMs;
    this.pushEffect({ kind: 'achieved', amount: 0, atMs });
  }

  private pushEffect(e: Omit<ChallengeEffect, 'id'>): void {
    this.recentEffects.unshift({ id: this.nextEffectId++, ...e });
    while (this.recentEffects.length > CHALLENGE_EFFECTS_MAX) this.recentEffects.pop();
  }
}
