import { describe, expect, it } from 'vitest';
import { QUIZ_RESULT_MS } from '@shared/challenge';
import {
  QUIZ_RESULT_FADE_MS,
  QUIZ_RESULT_VERDICT_MS,
  QUIZ_RESULT_VOTES_MS,
  planQuizResult,
  planTestQuizVotes,
  quizNominalAmount,
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

/**
 * 判定の純関数。**settleQuiz(本番)と ▶テスト実演の共通の権威**なので、
 * ここが唯一の定義であることを凍結する(二重権威を作らない)。
 */
describe('quizNominalAmount', () => {
  it('よかった多数 → 減算 / だめ多数 → 加算 / 引き分け・無投票 → ±0', () => {
    expect(quizNominalAmount(3, 1, 5000)).toBe(-5000);
    expect(quizNominalAmount(1, 3, 5000)).toBe(5000);
    expect(quizNominalAmount(2, 2, 5000)).toBe(0);
    expect(quizNominalAmount(0, 0, 5000)).toBe(0);
  });
});

/**
 * ▶テスト実演のダミー票。ライブ未接続ではコメントが来ないので worker が自前で作る。
 * 決定的であること(数列 rand で凍結できる)と、**必ず決着すること**が本体 —
 * 引き分けだと ±N ロールアップの段が出ず、プレビューの目的を果たさない。
 */
describe('planTestQuizVotes', () => {
  /** 0,0,0,… を返す rand(下限を引く)。 */
  const zeros = (): (() => number) => () => 0;
  /** 与えた数列を順に返す rand。 */
  const seq =
    (...xs: number[]): (() => number) =>
    () =>
      xs.shift() ?? 0;

  it('決定的 — 同じ rand 列なら同じ票列', () => {
    const a = planTestQuizVotes(1000, 30_000, seq(0.4, 0.2, 0.7));
    const b = planTestQuizVotes(1000, 30_000, seq(0.4, 0.2, 0.7));
    expect(a).toEqual(b);
  });

  it('必ず決着する(good と bad が同数にならない)', () => {
    for (let i = 0; i <= 10; i++) {
      for (let j = 0; j <= 10; j++) {
        const votes = planTestQuizVotes(0, 30_000, seq(i / 10, j / 10, 0.3));
        const good = votes.filter((v) => v.good).length;
        expect(good).not.toBe(votes.length - good);
      }
    }
  });

  it('全票が投票窓の内側に落ちる(締切と同時刻を作らない — 清算との順序が実装依存になる)', () => {
    const votes = planTestQuizVotes(1000, 30_000, zeros());
    expect(votes.length).toBeGreaterThan(0);
    for (const v of votes) {
      expect(v.atMs).toBeGreaterThan(1000);
      expect(v.atMs).toBeLessThan(1000 + 30_000);
    }
    // 到着は昇順(worker は先頭から順に消費する)。
    for (let i = 1; i < votes.length; i++) {
      expect(votes[i]!.atMs).toBeGreaterThanOrEqual(votes[i - 1]!.atMs);
    }
  });

  it('rand が 0 でも 1 に近くても票は 1 件以上ある(空の投票タイムを作らない)', () => {
    expect(planTestQuizVotes(0, 30_000, zeros()).length).toBeGreaterThan(0);
    expect(planTestQuizVotes(0, 30_000, seq(0.999, 0.999, 0.999)).length).toBeGreaterThan(0);
  });
});
