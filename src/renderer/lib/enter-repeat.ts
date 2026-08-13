/**
 * Enter の押しっぱなしで「ボタンが連打される」のを止める。
 *
 * ブラウザ既定では、フォーカスされた <button> の活性化キーは非対称になっている:
 *   Space … keyup で1回だけ click(押しっぱなしでもリピートしない)
 *   Enter … keydown ごとに click(＝OS のキーリピートでそのまま連発する)
 * ダッシュボードの PUSH は1回で残数が減るので、一度クリックしてフォーカスが
 * 残ったまま Enter を押しっぱなしにすると残数が一気に溶ける。Enter も Space と
 * 同じ「押しっぱなしでも1回」に揃える。
 *
 * 止めるのは capture 段階で **リピート分の既定動作だけ**。最初の1回は素通しなので
 * 押した瞬間に反応する手応えは変わらない。また preventDefault が消すのは既定動作
 * (button の activation / form の submit)だけで、明示的な keydown リスナーは
 * そのまま走る — MonitorView の Space/Enter は自前で `ev.repeat` を見ている。
 *
 * テキスト入力中の Enter 連打(textarea の改行など)は対象外。
 *
 * @returns 解除する関数(エントリで貼りっぱなしにする前提なので通常は使わない)
 */
export function installEnterRepeatGuard(): () => void {
  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key !== 'Enter' || !ev.repeat) return;
    const t = ev.target as HTMLElement | null;
    if (t && (t.isContentEditable || t.tagName === 'TEXTAREA')) return;
    ev.preventDefault();
  };
  window.addEventListener('keydown', onKeyDown, true);
  return () => window.removeEventListener('keydown', onKeyDown, true);
}
