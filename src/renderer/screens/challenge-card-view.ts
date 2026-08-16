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
  /** PUSH を押せるか。 */
  pushEnabled: boolean;
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
  return {
    status,
    running,
    achieved,
    badge: running ? '進行中' : achieved ? '達成!' : hasRun ? '一時停止中' : '停止中',
    hasRun,
    rankShown: challenge?.rankBoard != null,
    pushEnabled: running,
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
