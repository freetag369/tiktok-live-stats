/**
 * 据え置き(heldValue)の押下追従。
 *
 * 【背景】押下は worker の**カットイン凍結を素通しして値へ即時に効く**
 * (worker/challenge.ts の press)。走行中のタップは必ず数字に届くのが約束で、
 * 保留キューへ落としていた頃はカットイン1本で最長 15 秒・連鎖で最大 45 秒ぶん
 * 数字が1も動かなかった。
 *
 * ところがモニターの据え置きは**演出の開始時点で固定**される(heldValueFor が
 * その瞬間の worker 値から「まだ見せていない増減」を差し引いた値)。そのままだと
 * 押下で worker 値が減っても表示は動かず、配信者から見れば凍結時代と同じ
 * 「ボタンが死んでいる」に戻ってしまう。
 *
 * そこで据え置きを張った時点の `pressDownTotal` を基準に記録し、増分ぶんだけ
 * 据え置きも下げる。**未表示の演出ぶん(出目・カットインの増減)は据え置いたまま**
 * なので、結果の先漏れは起きない。
 *
 * 決定ロジックを shared に置くのは fx-drain.ts / fx-floats.ts / boost-settle.ts と
 * 同じ理由 — レンダラのテスト環境がこのリポジトリに無いので、純関数として
 * node の vitest で固定する。
 */

/**
 * 据え置きを張ってから「まだ据え置きへ反映していない」押下ぶん。
 *
 * @param base    据え置きを張った時点の `ChallengeState.pressDownTotal`(未定義は 0)
 * @param total   いまの `pressDownTotal`
 * @param applied すでにこの据え置きから引いた累計
 *
 * **必ず 0 以上**を返す = 据え置きは減る方向にしか動かない。start / reset で
 * `pressDownTotal` が 0 へ戻っても(total < base)数字が跳ね上がらないのはこのため。
 */
export function pressDropSinceHold(base: number, total: number, applied: number): number {
  return Math.max(0, total - base - applied);
}
