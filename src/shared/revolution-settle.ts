/**
 * 革命の結果カットシーン(全面動画 6 秒の上に「①減算合計 →②タップ回数 →③いいね反転」を
 * 順に載せる発表)のタイムライン決定ロジック。
 *
 * boost-settle.ts と同じ判断でここに置く — レンダラのテストが node で書けないので、
 * 演出の決定ロジックは shared に置いて凍結する。worker も REVOLUTION_SETTLE_BUDGET_MS を
 * 凍結の上乗せに使うので、「レンダラの発表尺 ≤ 動画尺」と「配送遅延 ≤ worker の余白」の
 * 両方を revolution-settle.spec.ts が不等式で固定できる。
 *
 * **ブーストの清算発表とは決定的に違う点**: 革命は窓の中で即時に値へ反映済みで、
 * 溜めた清算 lump が無い。したがって据え置き(holdValue)を張らず、7セグへの飛翔も
 * 着弾もしない。発表は動画尺の**中に完全に収まる**(飛翔ぶんの予算が要らない)。
 *
 * ロールアップの算術は再実装しない — boost-settle.ts の rollupDisplayAt / 定数を
 * そのまま再利用する(決定的ハッシュ・Math.random 不使用の契約ごと共有する)。
 */

import {
  BOOST_ROLLUP_BASE_MS,
  BOOST_ROLLUP_MAX_MS,
  BOOST_ROLLUP_PER_DIGIT_MS,
} from './boost-settle';

/**
 * 結果カットシーンの尺(ms)。素材 assets/fx/revolution/result.mp4 の実尺と一致させる
 * (6 秒 = 24fps で 144 フレームちょうど)。尺の権威は素材ではなくこの定数 —
 * モニターは JS タイマーで打ち切る。
 *
 * **導入(REVOLUTION_INTRO_MS = 8秒)とは別の尺**。あちらは「戦闘モードに入る」山場、
 * こちらは戦果を読ませるだけなので短い。両者を等しいと仮定してはいけない。
 */
export const REVOLUTION_RESULT_MS = 6_000;

/** 動画が立ち上がってから①のロールアップを回し始めるまでの間。 */
export const REVOLUTION_RESULT_LEAD_MS = 1_500;

/** ①確定 →②→③ を出す間隔。 */
export const REVOLUTION_RESULT_STEP_MS = 400;

/** 幕引きのフェード。.fx-clip-opaque の CSS transition と一致させること。 */
export const REVOLUTION_RESULT_FADE_MS = 400;

/**
 * worker が凍結(fxFreezeUntilMs)に上乗せする、結果カットシーンぶんの余白。
 * ≒ delta 配送遅延(~525ms)+ 余白。動画尺そのものは worker が別途加算する。
 *
 * ブーストの BOOST_SETTLE_BUDGET_MS(4000)より遥かに小さいのは、飛翔と着弾が無いため。
 * **ベストエフォート**である点に注意 — 他演出の最中に revolution-end が届くと
 * モニターは持ち越すので、凍結のほうが先に切れうる。値の正しさには一切影響しない
 * (据え置きを張らないので、幕の裏で数字が動いても幕明けに飛ばない)。
 */
export const REVOLUTION_SETTLE_BUDGET_MS = 1_000;

/** 結果カットシーンの各段(すべて動画開始からの絶対オフセット ms)。 */
export interface RevolutionResultPlan {
  /** 全面動画の尺。0 = 発表を丸ごとスキップ(呼び出し側はバナーだけ出す)。 */
  resultMs: number;
  /** ①のロールアップ開始。 */
  leadMs: number;
  /** ①のロールアップ尺(桁数でスケール)。 */
  rollupMs: number;
  /** ①が全桁確定する時刻。 */
  lockAtMs: number;
  /** ②タップ回数を出す時刻。 */
  tapAtMs: number;
  /** ③いいね反転を出す時刻。 */
  likeAtMs: number;
  /** 幕引きのフェードを始める時刻。 */
  fadeAtMs: number;
  /** 発表シーケンスの総尺。0 = スキップ。飛翔が無いので resultMs と一致する。 */
  totalMs: number;
}

const EMPTY: RevolutionResultPlan = {
  resultMs: 0,
  leadMs: 0,
  rollupMs: 0,
  lockAtMs: 0,
  tapAtMs: 0,
  likeAtMs: 0,
  fadeAtMs: 0,
  totalMs: 0,
};

/**
 * 結果カットシーンのタイムラインを決める。
 *
 * 減らせなかった窓(downTotal 0)は全段 0 — 発表するものが無いので呼び出し側は
 * バナーだけで畳む(planBoostSettle がタップ 0 で全段 0 を返すのと同じ判断)。
 * worker 側も同じ条件で revolutionResultMs を焼かないので、ここは二重の防御。
 */
export function planRevolutionResult(input: {
  /** 窓の総減算量(タップ + 反転いいね)。クランプ後の実減少量。 */
  downTotal: number;
  /** 窓中の実タップ数。 */
  tapCount: number;
  /** 反転いいねによる減算(ゲージ + ストック)。 */
  likeDown: number;
  /** worker が焼き込んだ結果カットシーンの尺。0 = 演出なし。 */
  resultMs: number;
}): RevolutionResultPlan {
  const downTotal = Math.max(0, Math.floor(input.downTotal));
  const resultMs = Math.max(0, Math.floor(input.resultMs));
  if (downTotal <= 0 || resultMs <= 0) return EMPTY;

  const digits = String(downTotal).length;
  const rollupMs = Math.min(
    BOOST_ROLLUP_MAX_MS,
    Math.max(BOOST_ROLLUP_BASE_MS, BOOST_ROLLUP_BASE_MS + digits * BOOST_ROLLUP_PER_DIGIT_MS)
  );
  const leadMs = REVOLUTION_RESULT_LEAD_MS;
  const lockAtMs = leadMs + rollupMs;
  return {
    resultMs,
    leadMs,
    rollupMs,
    lockAtMs,
    tapAtMs: lockAtMs + REVOLUTION_RESULT_STEP_MS,
    likeAtMs: lockAtMs + REVOLUTION_RESULT_STEP_MS * 2,
    fadeAtMs: Math.max(0, resultMs - REVOLUTION_RESULT_FADE_MS),
    totalMs: resultMs,
  };
}
