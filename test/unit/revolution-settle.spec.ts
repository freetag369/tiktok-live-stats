/**
 * 革命の結果カットシーン(全面動画 6 秒 + 戦果の発表)のタイムライン。
 *
 * boost-settle.spec.ts の鏡像。**予算の不等式がこのファイルの本体**:
 * レンダラの発表シーケンスは動画尺の中に完全に収まらなければならない
 * (はみ出すと、幕が畳まれた後に数字だけが宙に浮いたまま残る)。
 */
import { describe, expect, it } from 'vitest';
import { BOOST_ROLLUP_BASE_MS, BOOST_ROLLUP_MAX_MS, rollupDisplayAt } from '@shared/boost-settle';
import {
  REVOLUTION_RESULT_FADE_MS,
  REVOLUTION_RESULT_LEAD_MS,
  REVOLUTION_RESULT_MS,
  REVOLUTION_RESULT_STEP_MS,
  REVOLUTION_SETTLE_BUDGET_MS,
  planRevolutionResult,
} from '@shared/revolution-settle';
import { REVOLUTION_INTRO_MS } from '@shared/challenge';

const FULL = { downTotal: 128, tapCount: 42, likeDown: 2, resultMs: REVOLUTION_RESULT_MS };

describe('planRevolutionResult — 発表のタイムライン', () => {
  it('減算 0 は全段 0(発表を丸ごとスキップ = バナーだけ)', () => {
    // worker も同じ条件で revolutionResultMs を焼かないので、ここは二重の防御。
    const p = planRevolutionResult({ ...FULL, downTotal: 0 });
    expect(p.totalMs).toBe(0);
    expect(p.resultMs).toBe(0);
    expect(p.rollupMs).toBe(0);
  });

  it('resultMs 0(プレーン発動・機能OFF)も全段 0', () => {
    expect(planRevolutionResult({ ...FULL, resultMs: 0 }).totalMs).toBe(0);
  });

  it('rollupMs は桁数でスケールし、clamp が効く', () => {
    const one = planRevolutionResult({ ...FULL, downTotal: 7 }).rollupMs;
    const three = planRevolutionResult({ ...FULL, downTotal: 128 }).rollupMs;
    expect(three).toBeGreaterThan(one);
    expect(one).toBeGreaterThanOrEqual(BOOST_ROLLUP_BASE_MS);
    expect(planRevolutionResult({ ...FULL, downTotal: 999_999_999 }).rollupMs).toBe(
      BOOST_ROLLUP_MAX_MS
    );
  });

  it('段は必ず lead → lock → tap → like の順で単調増加する', () => {
    const p = planRevolutionResult(FULL);
    expect(p.leadMs).toBeLessThan(p.lockAtMs);
    expect(p.lockAtMs).toBeLessThan(p.tapAtMs);
    expect(p.tapAtMs).toBeLessThan(p.likeAtMs);
  });

  it('totalMs === resultMs(飛翔が無いので発表は動画尺そのもの)', () => {
    // ブーストと決定的に違う点: 据え置きを張らず 7 セグへ発射もしないので、
    // STRIKE_TRAVEL_MAX_MS ぶんの予算が要らない。
    const p = planRevolutionResult(FULL);
    expect(p.totalMs).toBe(REVOLUTION_RESULT_MS);
  });

  it('★予算整合: 最悪ケースの発表シーケンスが動画尺に収まる', () => {
    // ここが割れたら、幕(6秒)が畳まれた後に数字だけが宙に残る。
    const worst =
      REVOLUTION_RESULT_LEAD_MS +
      BOOST_ROLLUP_MAX_MS +
      REVOLUTION_RESULT_STEP_MS * 2 +
      REVOLUTION_RESULT_FADE_MS;
    expect(worst).toBeLessThanOrEqual(REVOLUTION_RESULT_MS);
  });

  it('★予算整合: 最大桁でも likeAtMs がフェード開始より前に来る', () => {
    const p = planRevolutionResult({ ...FULL, downTotal: 999_999_999 });
    expect(p.likeAtMs).toBeLessThan(p.fadeAtMs);
  });

  it('worker の凍結余白は delta 配送遅延(~525ms)を上回る', () => {
    expect(REVOLUTION_SETTLE_BUDGET_MS).toBeGreaterThanOrEqual(525);
  });

  it('素材の契約: どちらも 24fps でフレーム数ちょうど(導入8秒/192f・結果6秒/144f)', () => {
    // 導入と結果は**別の尺**。等しいと仮定するコードを書かないための凍結。
    expect(REVOLUTION_INTRO_MS).toBe(8_000);
    expect((REVOLUTION_INTRO_MS / 1000) * 24).toBe(192);
    expect(REVOLUTION_RESULT_MS).toBe(6_000);
    expect((REVOLUTION_RESULT_MS / 1000) * 24).toBe(144);
  });

  it('ロールアップは boost-settle の実装を再利用している(第2の真実を作らない)', () => {
    // 決定的ハッシュ(Math.random 不使用)の契約ごと共有していることの確認。
    const p = planRevolutionResult(FULL);
    const a = rollupDisplayAt(128, 100, p.rollupMs, 7);
    const b = rollupDisplayAt(128, 100, p.rollupMs, 7);
    expect(a.text).toBe(b.text);
    expect(rollupDisplayAt(128, p.rollupMs, p.rollupMs, 7)).toEqual({
      text: '128',
      locked: 3,
      done: true,
    });
  });
});
