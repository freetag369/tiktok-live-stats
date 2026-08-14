/**
 * モニター窓の自動復旧のループガード。
 *
 * なぜ main に置く必要があるか: モニター窓は monitor.restart で**破棄**される
 * ので、レンダラ内のカウンタは復旧のたびに 0 に戻り、ループを観測できない。
 * sessionStorage も作り直した BrowserWindow では別名前空間になる。
 * 唯一この判断を保持できるのは、両レンダラより長生きする main プロセスだけ。
 *
 * 決定ロジックだけ純関数としてここへ出す(main のコードは electron を import
 * するので node の vitest から読めない)。fx-drain.ts と同じ判断。
 */

/** この窓のなかで許す自動復旧の回数。 */
export const AUTO_RECOVER_MAX = 3;
/** 回数を数える時間窓(ms)。 */
export const AUTO_RECOVER_WINDOW_MS = 10 * 60 * 1000;

export interface AutoRecoverDecision {
  /** 復旧してよいか。 */
  allow: boolean;
  /** 窓内に落とし込んだ履歴(呼び出し側はこれを次回へ持ち回る)。 */
  history: number[];
  /** allow=false のときに残り時間(ms)— 「あと何分で自動復旧が戻るか」の案内用。 */
  retryAfterMs: number;
}

/**
 * 自動復旧してよいかを決め、履歴を更新して返す。
 *
 * 許可した場合だけ履歴に now を積む — 拒否も積むと、拒否のたびに窓が
 * 後ろへずれて永久に復旧できなくなる。
 */
export function decideAutoRecover(
  history: readonly number[],
  nowMs: number,
  opts: { maxInWindow?: number; windowMs?: number } = {}
): AutoRecoverDecision {
  const maxInWindow = opts.maxInWindow ?? AUTO_RECOVER_MAX;
  const windowMs = opts.windowMs ?? AUTO_RECOVER_WINDOW_MS;
  // 窓から出た履歴は捨てる。時計が巻き戻った(NTP補正)場合、nowMs より未来の
  // 記録は窓内として残る — 数え過ぎる側なので安全(暴走を止め損なわない)。
  const live = history.filter((t) => nowMs - t < windowMs);
  if (live.length >= maxInWindow) {
    const oldest = Math.min(...live);
    return { allow: false, history: live, retryAfterMs: Math.max(0, windowMs - (nowMs - oldest)) };
  }
  return { allow: true, history: [...live, nowMs], retryAfterMs: 0 };
}
