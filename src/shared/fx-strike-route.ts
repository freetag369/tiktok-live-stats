/**
 * いいねゲージ/ストック着弾(strike)の経路決定。
 *
 * 【背景 — 2026-08-16 ユーザー決定】着弾は**舞台キューに入れず常時実行**する。
 * かつては ±N バナー表示中(stageBusy)に pendingStrike へ退避 → pumpStage の
 * ドレイン待ちだったため、バナーがほぼ常時出ている実配信では follow(rank0)に
 * 負け続け、「ゲージは溜まるのに着弾が一切出ない」ように見えた(実害報告)。
 * 本方式では入力に stageBusy が**存在しない** — バナーは着弾を止めない。
 *
 * 4値の意味:
 * - none:     着弾なし(fill 差分ゼロ)か停止中 — 従来の値のみパンチ経路へ。
 * - coalesce: 自分のチェーンが飛行中 — pendingStrike へ合算し、チェーン終端の
 *             continueStrikeChain が**間合いなし直結**で即再生する。舞台キュー
 *             ではなく直列化バッファ(最大遅延は現行チェーン1本ぶんで有界)。
 * - beat:     カットイン(ルーレット/フィーバー/バンド/ストックカットイン)が
 *             再生中か直後に始まる — 据え置き(heldValue)の持ち主に触らず、
 *             visuals-only の着弾ビート(光・パンチ・SE・粒子)を即時に撃つ。
 *             数字は関数型 updater の増加追従のみ(fx-hold と対称)。±N バナーは
 *             触らない — 単枠置換なのでカットイン自身の確定バナーを消してしまう。
 *             保留は合算されたままカットイン終了時のウォッチドッグ等が出す。
 * - chain:    それ以外 — フルチェーン(据え置きあり)を即時に張る。バナー表示中
 *             でも張る(これが「常時実行」の本体)。
 *
 * 'defer'(舞台待ち)という出力は**存在しない**。それがこの変更の主張そのもの。
 *
 * 決定ロジックを shared に置くのは fx-drain.ts / fx-hold.ts と同じ理由 —
 * レンダラのテスト環境がこのリポジトリに無いので、純関数として node の
 * vitest で固定する。
 */

export type StrikeRoute = 'none' | 'coalesce' | 'beat' | 'chain';

export interface StrikeRouteInput {
  /** likeDelta > 0 || stockDelta > 0(fills 差分由来の着弾があるか)。 */
  hasFill: boolean;
  /** challenge.status === 'running'。停止中は演出しない(従来どおり)。 */
  running: boolean;
  /** strikeTimers.current.length > 0(自分のチェーンが飛行中)。 */
  chainFlying: boolean;
  /** anyCutinHold()(ルーレット/バンド/ブースト/ストックカットインの据え置き中)。 */
  cutinActive: boolean;
  /** 同一デルタに未再生のルーレット/ブースト/バンドが相乗り(直後に必ず start* が走る)。 */
  cutinImminent: boolean;
}

/**
 * 上から先勝ち。chainFlying が cutin 系より**先**なのが重要 — ストックカットイン中
 * (strikeTimers が生きている)は coalesce になり、終端の直結が full/beat を
 * その時点の状態で再判定する。
 */
export function routeStrike(s: StrikeRouteInput): StrikeRoute {
  if (!s.hasFill || !s.running) return 'none';
  if (s.chainFlying) return 'coalesce';
  if (s.cutinActive || s.cutinImminent) return 'beat';
  return 'chain';
}
