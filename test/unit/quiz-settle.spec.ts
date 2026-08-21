import { describe, expect, it } from 'vitest';
import { QUIZ_RESULT_MS } from '@shared/challenge';
import {
  QUIZ_RESULT_FADE_MS,
  QUIZ_RESULT_VERDICT_MS,
  QUIZ_RESULT_VOTES_MS,
  planQuizResult,
} from '@shared/quiz-settle';

/**
 * 結果発表(票数 → 判定 → ±N)のタイムラインの凍結。
 * revolution-settle.spec と同じ「発表は尺の中に完全に収まる」不等式が本体。
 */
describe('planQuizResult', () => {
  it('resultMs 0(プレーン発動)は全段 0 — 呼び出し側はバナーだけで畳む', () => {
    const p = planQuizResult({ amount: -5000, resultMs: 0 });
    expect(p.totalMs).toBe(0);
    expect(p.rollupMs).toBe(0);
  });

  it('段の順序と包含: votes(0) < verdict < amount、fade は総尺の内側', () => {
    const p = planQuizResult({ amount: -5000, resultMs: QUIZ_RESULT_MS });
    expect(p.votesAtMs).toBe(0);
    expect(p.verdictAtMs).toBe(QUIZ_RESULT_VOTES_MS);
    expect(p.amountAtMs).toBe(QUIZ_RESULT_VOTES_MS + QUIZ_RESULT_VERDICT_MS);
    expect(p.amountAtMs + p.rollupMs).toBeLessThanOrEqual(p.totalMs);
    expect(p.fadeAtMs).toBe(QUIZ_RESULT_MS - QUIZ_RESULT_FADE_MS);
    expect(p.totalMs).toBe(QUIZ_RESULT_MS);
  });

  it('±0(引き分け・無投票)でも発表はする — amount 段だけロールアップ 0', () => {
    const p = planQuizResult({ amount: 0, resultMs: QUIZ_RESULT_MS });
    expect(p.totalMs).toBe(QUIZ_RESULT_MS);
    expect(p.rollupMs).toBe(0);
  });

  it('増加(だめ多数)でも同じタイムライン(符号は表示側の責務)', () => {
    expect(planQuizResult({ amount: 5000, resultMs: QUIZ_RESULT_MS })).toEqual(
      planQuizResult({ amount: -5000, resultMs: QUIZ_RESULT_MS })
    );
  });
});
