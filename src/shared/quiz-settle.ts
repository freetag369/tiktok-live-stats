/**
 * お題ルーレットの結果発表(投票締切 → 票数 → 判定 → ±N ロールアップ)の
 * タイムライン決定ロジック。revolution-settle.ts の写し — レンダラのテストが
 * node で書けないので、演出の決定ロジックは shared に置いて凍結する。
 *
 * 革命の結果と同じく**全面動画素材は持たない**(DOM のみの発表)。据え置き
 * (holdValue)も張らない — quiz の ± は settleQuiz が quiz-end の瞬間に適用済みで、
 * 発表は「なぜ動いたか」を読ませるだけ。幕の裏で数字が動いても幕明けに飛ばない。
 *
 * ロールアップの算術は boost-settle.ts の定数を再利用する(決定的・Math.random
 * 不使用の契約ごと共有 — revolution-settle.ts と同じ判断)。
 */

import {
  BOOST_ROLLUP_BASE_MS,
  BOOST_ROLLUP_MAX_MS,
  BOOST_ROLLUP_PER_DIGIT_MS,
} from './boost-settle';

/** 票数(よかった N / だめ N)を出してから判定を出すまでの間。 */
export const QUIZ_RESULT_VOTES_MS = 1_800;

/** 判定(成功/失敗/引き分け)を出してから ±N ロールアップを始めるまでの間。 */
export const QUIZ_RESULT_VERDICT_MS = 1_200;

/** 幕引きのフェード。.fx-clip-opaque / .quiz-* の CSS transition と一致させること。 */
export const QUIZ_RESULT_FADE_MS = 400;

/**
 * worker が凍結(fxFreezeUntilMs)に上乗せする余白…は使わない — settleQuiz は
 * resultMs + GIFT_FX_FREEZE_MARGIN_MS だけ張る(発表は resultMs の中に完全に
 * 収まるため。REVOLUTION_SETTLE_BUDGET_MS 相当の配送遅延余白は margin が兼ねる)。
 * ここに定数を置かないのは意図的 — 二重権威を作らない。
 */

/** 結果発表の各段(すべて発表開始からの絶対オフセット ms)。 */
export interface QuizResultPlan {
  /** 発表の総尺(= worker が焼いた quizResultMs)。0 = 発表を丸ごとスキップ。 */
  resultMs: number;
  /** 票数を出す時刻(常に 0 — 発表開始と同時)。 */
  votesAtMs: number;
  /** 判定(成功/失敗/引き分け)を出す時刻。 */
  verdictAtMs: number;
  /** ±N のロールアップを始める時刻。±0(引き分け・無投票)ではこの段をスキップ。 */
  amountAtMs: number;
  /** ロールアップ尺(桁数でスケール。±0 では 0)。 */
  rollupMs: number;
  /** 幕引きのフェードを始める時刻。 */
  fadeAtMs: number;
  /** 発表シーケンスの総尺。0 = スキップ。 */
  totalMs: number;
}

const EMPTY: QuizResultPlan = {
  resultMs: 0,
  votesAtMs: 0,
  verdictAtMs: 0,
  amountAtMs: 0,
  rollupMs: 0,
  fadeAtMs: 0,
  totalMs: 0,
};

/**
 * 結果発表のタイムラインを決める。resultMs 0(プレーン発動・モニター不在)は全段 0 —
 * 呼び出し側はバナーだけで畳む(planRevolutionResult と同じ判断)。
 * ±0(引き分け・無投票)でも発表はする — 「引き分けでした」を読ませるのが
 * 投票タイムの締めなので、amount 段だけをスキップする。
 */
export function planQuizResult(input: {
  /** clamp 済みの実増減(quiz-end の amount)。0 = 引き分け・無投票。 */
  amount: number;
  /** worker が焼き込んだ発表の尺。0 = 演出なし。 */
  resultMs: number;
}): QuizResultPlan {
  const resultMs = Math.max(0, Math.floor(input.resultMs));
  if (resultMs <= 0) return EMPTY;
  const amount = Math.abs(Math.floor(input.amount));
  const digits = amount > 0 ? String(amount).length : 0;
  const rollupMs =
    amount > 0
      ? Math.min(
          BOOST_ROLLUP_MAX_MS,
          Math.max(BOOST_ROLLUP_BASE_MS, BOOST_ROLLUP_BASE_MS + digits * BOOST_ROLLUP_PER_DIGIT_MS)
        )
      : 0;
  return {
    resultMs,
    votesAtMs: 0,
    verdictAtMs: QUIZ_RESULT_VOTES_MS,
    amountAtMs: QUIZ_RESULT_VOTES_MS + QUIZ_RESULT_VERDICT_MS,
    rollupMs,
    fadeAtMs: Math.max(0, resultMs - QUIZ_RESULT_FADE_MS),
    totalMs: resultMs,
  };
}
