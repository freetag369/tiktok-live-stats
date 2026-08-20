import type { ChallengeConfig, ChallengeState, ChallengeStatus } from '@shared/dto';

/**
 * ライブ画面のチャレンジ操作カードの表示状態。
 *
 * 切り出す理由: 「PUSH が押せるか」「確認ダイアログを出すか」「モニター未表示の
 * 警告を出すか」は**配信事故に直結する条件**なのに、4350 行の LiveDashboard の中に
 * 散らばっていて単体で検証できなかった。worker が落ちて PUSH が灰色のまま固着した
 * 事故(v0.7.x)もこの層の話。
 *
 * `nowMs` を引数で受けるのはこのリポジトリの規約に合わせるため(時刻は依存注入が
 * 第一選択 — ChallengeEngine の ctor と同じ流儀)。
 */
export interface ChallengeCardView {
  status: ChallengeStatus;
  running: boolean;
  achieved: boolean;
  /** バッジの文言。startedMs が残っていれば「一時停止中」、無ければ「停止中」。 */
  badge: '進行中' | '達成!' | '一時停止中' | '停止中';
  /** 一度でも開始したか = 開始し直しで失うものがあるか。 */
  hasRun: boolean;
  /** モニターに全画面ランキングが出ているか(rankBoard の有無がそのまま表示状態)。 */
  rankShown: boolean;
  /** ルーレット焦らし短縮が ON か(rouletteRush の有無がそのまま表示状態)。 */
  rouletteRushOn: boolean;
  /** PUSH を押せるか。**お邪魔(タップ封じ)中は false**(worker も弾く)。 */
  pushEnabled: boolean;
  /**
   * お邪魔(タップ封じ)中か。判定は絶対期限と nowMs の比較で、worker の
   * tapLock キーの有無だけを見ない — 期限切れの古いスナップショットが後着しても
   * ボタンが灰色に固着しないようにするため(この層が担当する事故そのもの)。
   */
  tapLocked: boolean;
  /** お邪魔の残り(ms)。非封印なら null。負にはしない。 */
  tapLockRemainingMs: number | null;
  /** お邪魔を発動させた視聴者の表示名(分かれば)。 */
  tapLockNickname: string | null;
  /** 「モニター未表示 — 演出が出ていません」を出すか。 */
  warnMonitorClosed: boolean;
  title: string;
  value: number;
  initial: number;
  /** 進捗バーの分子。0 未満にはしない。 */
  done: number;
  /** 経過時間。未開始なら null。達成後は達成時刻で止まる。 */
  elapsedMs: number | null;
}

export function challengeCardView(
  challenge: ChallengeState | null,
  cfg: ChallengeConfig,
  monitorOpen: boolean,
  nowMs: number
): ChallengeCardView {
  const status = challenge?.status ?? 'idle';
  const running = status === 'running';
  const achieved = status === 'achieved';
  // reset だけが startedMs を消す。stop は残す(一時停止の意味論)ので、
  // これがそのまま「途中の値と統計を持っているか」の判定になる。
  const hasRun = challenge?.startedMs != null;
  const value = challenge?.value ?? cfg.initialValue;
  const initial = challenge?.initialValue ?? cfg.initialValue;
  // お邪魔(タップ封じ)。worker が唯一の判定者だが、PUSH を灰色にして残り秒を
  // 出すのはここ — モニターを閉じている配信者にとっては**これが唯一の説明**になる
  // (封印は演出ではなくゲームのルールなので、モニターの有無に関わらず効く)。
  const lock = challenge?.tapLock ?? null;
  const tapLockRemainingMs = lock != null ? Math.max(0, lock.endsAtMs - nowMs) : null;
  const tapLocked = tapLockRemainingMs != null && tapLockRemainingMs > 0;
  return {
    status,
    running,
    achieved,
    badge: running ? '進行中' : achieved ? '達成!' : hasRun ? '一時停止中' : '停止中',
    hasRun,
    rankShown: challenge?.rankBoard != null,
    rouletteRushOn: challenge?.rouletteRush === true,
    // 排他スケジューリング(2026-08-20)により封印とフィーバー窓は同時に生きない
    // ので、「窓は開いているのに PUSH が灰色」の不整合は worker 側が作らない。
    pushEnabled: running && !tapLocked,
    tapLocked,
    tapLockRemainingMs,
    tapLockNickname: lock?.nickname ?? null,
    // 走行中なのにモニターが閉じている = 演出が誰にも見えていない。閉じたままの
    // 配信を1本まるごと無演出で終えるのを防ぐための警告。
    warnMonitorClosed: running && !monitorOpen,
    title: challenge?.title ?? cfg.title,
    value,
    initial,
    done: Math.max(0, initial - value),
    elapsedMs:
      challenge?.startedMs != null ? (challenge.achievedMs ?? nowMs) - challenge.startedMs : null,
  };
}
