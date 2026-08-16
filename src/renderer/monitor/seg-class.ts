import type { ChallengeStatus } from '@shared/dto';

/**
 * 7セグ(.countdown)の見た目を決める純関数。MonitorView から切り出してある。
 *
 * 切り出す理由: 元は 4350 行のコンポーネントの中にインラインで書かれていて、
 * 検証手段が monitor.css と MonitorView.tsx を**文字列として読む**検査しか
 * 無かった。規則そのものはここで単体テストし、配線(MonitorView が実際に
 * これを呼んでいること)だけをソース検査に残す、という分担にする。
 *
 * punch-* は**ここに含めない** — 付け外しは punchKey の useLayoutEffect が
 * classList リプレイで行う。className と二重管理になると、同方向の連続パンチで
 * アニメーションが再スタートしなくなる(v0.7.3 で潰した回帰)。
 */
export function countdownClass(a: {
  status: ChallengeStatus;
  /** 据え置き(heldValue)を解決したあとの表示値。 */
  shownValue: number;
  lowThreshold: number;
}): string {
  const achieved = a.status === 'achieved';
  const running = a.status === 'running';
  return [
    'countdown',
    achieved ? 'clear' : '',
    // 点滅は**走行中だけ**。達成後や一時停止中に低い値を保持していても点滅しない
    // (配信が終わった画面で数字がチカチカし続けるのを避ける)。
    running && a.shownValue <= a.lowThreshold ? 'low' : '',
  ].join(' ');
}

/**
 * 表示する桁数。初期値の桁数に合わせ、最低4桁は確保する。
 * 据え置き中も**桁数は据え置かない**(initialValue 由来なのでランの間は不変)。
 */
export function segDigits(initialValue: number): number {
  return Math.max(4, String(initialValue).length);
}
