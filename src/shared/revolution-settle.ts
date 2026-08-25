/**
 * 革命の結果カットシーン(全面動画の上に「タップの戦果」と「いいね反転」を左右に出し、
 * 衝突(ドーン)で合計をカウントアップする発表)のタイムライン決定ロジック。
 *
 * boost-settle.ts と同じ判断でここに置く — レンダラのテストが node で書けないので、
 * 演出の決定ロジックは shared に置いて凍結する。worker も REVOLUTION_SETTLE_BUDGET_MS を
 * 凍結の上乗せに使うので、「レンダラの発表尺 ≤ 演出尺」と「配送遅延 ≤ worker の余白」の
 * 両方を revolution-settle.spec.ts が不等式で固定できる。
 *
 * **ブーストの清算発表とは決定的に違う点**: 革命は窓の中で即時に値へ反映済みで、
 * 溜めた清算 lump が無い。したがって据え置き(holdValue)を張らず、7セグへの飛翔も
 * 着弾もしない。発表は演出尺の**中に完全に収まる**(飛翔ぶんの予算が要らない)。
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
 * 素材 assets/fx/revolution/result.mp4 の実尺(6 秒 = 24fps で 144 フレームちょうど)。
 * 演出尺(REVOLUTION_RESULT_MS)より短いぶんは、ホルダーが loop も onEnded も持たない
 * ので**最終フレーム静止**で持つ(素材の終端は深紅の残光に沈む暗い絵 — 静止で破綻しない。
 * ユーザー決定 2026-08-25)。12 秒素材へ差し替えるときはこの定数だけ実尺に合わせること。
 */
export const REVOLUTION_RESULT_VIDEO_MS = 6_000;

/**
 * 結果カットシーンの演出尺(ms)。尺の権威は素材ではなくこの定数 — モニターは
 * JS タイマーで打ち切る。worker の凍結上乗せ・番犬期限もここから導出される。
 *
 * **導入(REVOLUTION_INTRO_MS = 8秒)とは別の尺**。あちらは「戦闘モードに入る」山場、
 * こちらは二者の戦果→衝突→合計まで読ませる発表。両者を等しいと仮定してはいけない。
 */
export const REVOLUTION_RESULT_MS = 12_000;

/** 動画が立ち上がってからタップ側のロールアップを回し始めるまでの間。 */
export const REVOLUTION_RESULT_LEAD_MS = 1_500;

/** タップ確定 → いいね側登場、いいね確定 → 溜め開始、の間隔。 */
export const REVOLUTION_RESULT_STEP_MS = 400;

/** 衝突前の「溜め」(両者が振動する)の尺。 */
export const REVOLUTION_CHARGE_MS = 600;

/**
 * 両者が中央へ飛ぶ(飛翔)の尺。CSS keyframes(rev-clash-left / rev-clash-right)の
 * animation-duration と一致させること。
 */
export const REVOLUTION_CLASH_TRAVEL_MS = 300;

/** 幕引きのフェード。.fx-clip-opaque の CSS transition と一致させること。 */
export const REVOLUTION_RESULT_FADE_MS = 400;

/**
 * worker が凍結(fxFreezeUntilMs)に上乗せする、結果カットシーンぶんの余白。
 * ≒ delta 配送遅延(~525ms)+ 余白。演出尺そのものは worker が別途加算する。
 *
 * ブーストの BOOST_SETTLE_BUDGET_MS(4000)より遥かに小さいのは、飛翔と着弾が無いため。
 * **ベストエフォート**である点に注意 — 他演出の最中に revolution-end が届くと
 * モニターは持ち越すので、凍結のほうが先に切れうる。値の正しさには一切影響しない
 * (据え置きを張らないので、幕の裏で数字が動いても幕明けに飛ばない)。
 */
export const REVOLUTION_SETTLE_BUDGET_MS = 1_000;

/** 結果カットシーンの各段(すべて動画開始からの絶対オフセット ms)。 */
export interface RevolutionResultPlan {
  /** 演出尺。0 = 発表を丸ごとスキップ(呼び出し側はバナーだけ出す)。 */
  resultMs: number;
  /**
   * タップ由来の減算(= downTotal − likeDown、0 クランプ)。DTO には載せず
   * ここで一元計算する — worker の恒等式(downTotal = tapDown + likeDown)が
   * challenge-revolution.spec で凍結されているので導出で足りる。
   */
  tapDown: number;
  /** タップ側パネルの登場 + ロールアップ開始。 */
  leadMs: number;
  /** タップ側のロールアップ尺(桁数でスケール)。 */
  tapRollupMs: number;
  /** タップ側が全桁確定する時刻。 */
  tapLockAtMs: number;
  /** いいね側パネルの登場 + ロールアップ開始。 */
  likeAtMs: number;
  /** いいね側のロールアップ尺。 */
  likeRollupMs: number;
  /** いいね側が全桁確定する時刻。 */
  likeLockAtMs: number;
  /** 両者の「溜め」(振動)開始。 */
  chargeAtMs: number;
  /** 両者が中央へ飛び始める時刻。 */
  flyAtMs: number;
  /** 衝突(ドーン)= フラッシュ / シェイク / SE / 合計カウントアップ開始。 */
  clashAtMs: number;
  /** 合計のカウントアップ尺(桁数でスケール)。 */
  countupMs: number;
  /** 合計が確定してパンチが入る時刻。 */
  totalLockAtMs: number;
  /** 幕引きのフェードを始める時刻。 */
  fadeAtMs: number;
  /** 発表シーケンスの総尺。0 = スキップ。飛翔(7セグへの)が無いので resultMs と一致する。 */
  totalMs: number;
}

const EMPTY: RevolutionResultPlan = {
  resultMs: 0,
  tapDown: 0,
  leadMs: 0,
  tapRollupMs: 0,
  tapLockAtMs: 0,
  likeAtMs: 0,
  likeRollupMs: 0,
  likeLockAtMs: 0,
  chargeAtMs: 0,
  flyAtMs: 0,
  clashAtMs: 0,
  countupMs: 0,
  totalLockAtMs: 0,
  fadeAtMs: 0,
  totalMs: 0,
};

/** ロールアップ / カウントアップの尺(planBoostSettle と同じ式 — 第2の真実を作らない)。 */
function rollupMsFor(amount: number): number {
  const digits = String(Math.max(0, amount)).length;
  return Math.min(
    BOOST_ROLLUP_MAX_MS,
    Math.max(BOOST_ROLLUP_BASE_MS, BOOST_ROLLUP_BASE_MS + digits * BOOST_ROLLUP_PER_DIGIT_MS)
  );
}

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

  // likeDown は downTotal を超えない(worker の恒等式)。壊れた入力でも
  // tapDown が負にならないよう両側からクランプする。
  const likeDown = Math.min(downTotal, Math.max(0, Math.floor(input.likeDown)));
  const tapDown = downTotal - likeDown;

  const tapRollupMs = rollupMsFor(tapDown);
  const likeRollupMs = rollupMsFor(likeDown);
  const countupMs = rollupMsFor(downTotal);
  const leadMs = REVOLUTION_RESULT_LEAD_MS;
  const tapLockAtMs = leadMs + tapRollupMs;
  const likeAtMs = tapLockAtMs + REVOLUTION_RESULT_STEP_MS;
  const likeLockAtMs = likeAtMs + likeRollupMs;
  const chargeAtMs = likeLockAtMs + REVOLUTION_RESULT_STEP_MS;
  const flyAtMs = chargeAtMs + REVOLUTION_CHARGE_MS;
  const clashAtMs = flyAtMs + REVOLUTION_CLASH_TRAVEL_MS;
  const totalLockAtMs = clashAtMs + countupMs;
  return {
    resultMs,
    tapDown,
    leadMs,
    tapRollupMs,
    tapLockAtMs,
    likeAtMs,
    likeRollupMs,
    likeLockAtMs,
    chargeAtMs,
    flyAtMs,
    clashAtMs,
    countupMs,
    totalLockAtMs,
    fadeAtMs: Math.max(0, resultMs - REVOLUTION_RESULT_FADE_MS),
    totalMs: resultMs,
  };
}

/**
 * 衝突後の合計カウントアップの表示値(0 → amount の easeOutCubic・単調増加)。
 * rollupDisplayAt(ドラムロール = 桁が暴れてから上位桁順にロック)とは絵が違う —
 * 「ぶつかって数字が増える」の要件どおり、値そのものが駆け上がる。
 * 乱数を使わないので seed 不要・決定的。done のとき text は必ず String(amount)。
 */
export function countupDisplayAt(
  amount: number,
  elapsedMs: number,
  countupMs: number
): { text: string; done: boolean } {
  const total = Math.max(0, Math.floor(amount));
  if (countupMs <= 0 || elapsedMs >= countupMs) return { text: String(total), done: true };
  const t = Math.max(0, elapsedMs) / countupMs;
  const eased = 1 - Math.pow(1 - t, 3);
  return { text: String(Math.min(total, Math.floor(total * eased))), done: false };
}
