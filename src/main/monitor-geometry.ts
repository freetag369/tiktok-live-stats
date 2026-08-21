/**
 * repositionMonitor の「迷子判定」だけを electron 非依存で切り出した純関数。
 * (monitor-window.ts は BrowserWindow/screen を import するため vitest の
 * electron スタブから直接読めない — metrics.ts と同じ分離の理由。)
 */

/** Electron.Rectangle と構造互換(型だけの都合で electron は import しない)。 */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * 窓の矩形がいずれかのディスプレイに1pxでも掛かっているか。
 * 「掛かっていれば見えている」と緩く判定する — 配信者は OBS の構図の都合で窓を
 * 半分画面外に置くことがあり、閾値を設けるとその配置を「迷子」と誤認して勝手に
 * 動かしてしまう(まさに直したい事故)。完全に画面外のときだけ迷子扱いにする。
 */
export function boundsOnAnyDisplay(bounds: Rect, displays: readonly Rect[]): boolean {
  return displays.some((d) => {
    const w = Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x);
    const h = Math.min(bounds.y + bounds.height, d.y + d.height) - Math.max(bounds.y, d.y);
    return w > 0 && h > 0;
  });
}
