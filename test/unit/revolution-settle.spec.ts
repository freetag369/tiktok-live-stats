/**
 * 革命の結果カットシーン(二者対決 → 衝突 → 合計カウントアップ)のタイムライン。
 *
 * boost-settle.spec.ts の鏡像。**予算の不等式がこのファイルの本体**:
 * レンダラの発表シーケンスは演出尺の中に完全に収まらなければならない
 * (はみ出すと、幕が畳まれた後に数字だけが宙に浮いたまま残る)。
 */
import { describe, expect, it } from 'vitest';
import { BOOST_ROLLUP_BASE_MS, BOOST_ROLLUP_MAX_MS, rollupDisplayAt } from '@shared/boost-settle';
import {
  REVOLUTION_CHARGE_MS,
  REVOLUTION_CLASH_TRAVEL_MS,
  REVOLUTION_RESULT_FADE_MS,
  REVOLUTION_RESULT_LEAD_MS,
  REVOLUTION_RESULT_MS,
  REVOLUTION_RESULT_STEP_MS,
  REVOLUTION_RESULT_VIDEO_MS,
  REVOLUTION_SETTLE_BUDGET_MS,
  countupDisplayAt,
  planRevolutionResult,
} from '@shared/revolution-settle';
import { REVOLUTION_INTRO_MS } from '@shared/challenge';

const FULL = { downTotal: 128, tapCount: 42, likeDown: 2, resultMs: REVOLUTION_RESULT_MS };

describe('planRevolutionResult — 発表のタイムライン', () => {
  it('減算 0 は全段 0(発表を丸ごとスキップ = バナーだけ)', () => {
    // 本番経路(test なし)では worker も同じ条件で revolutionResultMs を焼かないので
    // 二重の防御。▶実演だけは test 印で例外(次の it)。
    const p = planRevolutionResult({ ...FULL, downTotal: 0 });
    expect(p.totalMs).toBe(0);
    expect(p.resultMs).toBe(0);
    expect(p.countupMs).toBe(0);
  });

  it('▶実演(test)は減算 0 でも発表を出す — 押さなかった人にも結末を見せる', () => {
    // worker は実演では downTotal 0 でも testRevolutionResultMs を焼く
    // (worker/challenge.ts の実演コメントと対)。段の単調増加も 0 額で保たれること。
    const p = planRevolutionResult({
      ...FULL,
      downTotal: 0,
      tapCount: 0,
      likeDown: 0,
      test: true,
    });
    expect(p.totalMs).toBe(REVOLUTION_RESULT_MS);
    expect(p.tapDown).toBe(0);
    expect(p.leadMs).toBeLessThan(p.tapLockAtMs);
    expect(p.clashAtMs).toBeLessThan(p.totalLockAtMs);
    expect(p.totalLockAtMs).toBeLessThan(p.fadeAtMs);
  });

  it('resultMs 0(プレーン発動・機能OFF)も全段 0 — 実演の test 印でも覆らない', () => {
    expect(planRevolutionResult({ ...FULL, resultMs: 0 }).totalMs).toBe(0);
    // reduced-motion / モニター不在では worker が実演でも resultMs 0 を焼く。
    expect(planRevolutionResult({ ...FULL, resultMs: 0, test: true }).totalMs).toBe(0);
  });

  it('tapDown は downTotal − likeDown を plan が一元計算する(DTO には載せない)', () => {
    expect(planRevolutionResult(FULL).tapDown).toBe(126);
    // likeDown が downTotal を超える壊れた入力でも負にならない(両側クランプ)。
    expect(planRevolutionResult({ ...FULL, likeDown: 999 }).tapDown).toBe(0);
    expect(planRevolutionResult({ ...FULL, likeDown: -5 }).tapDown).toBe(128);
  });

  it('countupMs は桁数でスケールし、clamp が効く', () => {
    const one = planRevolutionResult({ ...FULL, downTotal: 7 }).countupMs;
    const three = planRevolutionResult({ ...FULL, downTotal: 128 }).countupMs;
    expect(three).toBeGreaterThan(one);
    expect(one).toBeGreaterThanOrEqual(BOOST_ROLLUP_BASE_MS);
    expect(planRevolutionResult({ ...FULL, downTotal: 999_999_999 }).countupMs).toBe(
      BOOST_ROLLUP_MAX_MS
    );
  });

  it('段は必ず lead → tapLock → like → likeLock → charge → fly → clash → totalLock → fade の順で単調増加する', () => {
    const p = planRevolutionResult(FULL);
    expect(p.leadMs).toBeLessThan(p.tapLockAtMs);
    expect(p.tapLockAtMs).toBeLessThan(p.likeAtMs);
    expect(p.likeAtMs).toBeLessThan(p.likeLockAtMs);
    expect(p.likeLockAtMs).toBeLessThan(p.chargeAtMs);
    expect(p.chargeAtMs).toBeLessThan(p.flyAtMs);
    expect(p.flyAtMs).toBeLessThan(p.clashAtMs);
    expect(p.clashAtMs).toBeLessThan(p.totalLockAtMs);
    expect(p.totalLockAtMs).toBeLessThan(p.fadeAtMs);
  });

  it('溜めと飛翔の尺は定数どおり(CSS keyframes の animation-duration と対)', () => {
    const p = planRevolutionResult(FULL);
    expect(p.flyAtMs - p.chargeAtMs).toBe(REVOLUTION_CHARGE_MS);
    expect(p.clashAtMs - p.flyAtMs).toBe(REVOLUTION_CLASH_TRAVEL_MS);
  });

  it('totalMs === resultMs(7セグへの飛翔が無いので発表は演出尺そのもの)', () => {
    // ブーストと決定的に違う点: 据え置きを張らず 7 セグへ発射もしないので、
    // STRIKE_TRAVEL_MAX_MS ぶんの予算が要らない。
    const p = planRevolutionResult(FULL);
    expect(p.totalMs).toBe(REVOLUTION_RESULT_MS);
  });

  it('★予算整合: 最悪ケースの発表シーケンスが演出尺に収まる', () => {
    // ここが割れたら、幕が畳まれた後に数字だけが宙に残る。
    // 二者のロールアップ + 合計のカウントアップが全部 clamp 上限でも収まること。
    const worst =
      REVOLUTION_RESULT_LEAD_MS +
      BOOST_ROLLUP_MAX_MS + // タップ側
      REVOLUTION_RESULT_STEP_MS +
      BOOST_ROLLUP_MAX_MS + // いいね側
      REVOLUTION_RESULT_STEP_MS +
      REVOLUTION_CHARGE_MS +
      REVOLUTION_CLASH_TRAVEL_MS +
      BOOST_ROLLUP_MAX_MS + // 合計カウントアップ
      REVOLUTION_RESULT_FADE_MS;
    expect(worst).toBeLessThanOrEqual(REVOLUTION_RESULT_MS);
  });

  it('★予算整合: 最大桁でも合計のロックが最低 1 秒は読める', () => {
    const p = planRevolutionResult({ ...FULL, downTotal: 999_999_999, likeDown: 500_000_000 });
    expect(p.fadeAtMs - p.totalLockAtMs).toBeGreaterThanOrEqual(1_000);
  });

  it('worker の凍結余白は delta 配送遅延(~525ms)を上回る', () => {
    expect(REVOLUTION_SETTLE_BUDGET_MS).toBeGreaterThanOrEqual(525);
  });

  it('素材の契約: どちらも 24fps でフレーム数ちょうど(導入8秒/192f・結果6秒/144f)', () => {
    // 導入と結果は**別の尺**。等しいと仮定するコードを書かないための凍結。
    expect(REVOLUTION_INTRO_MS).toBe(8_000);
    expect((REVOLUTION_INTRO_MS / 1000) * 24).toBe(192);
    expect(REVOLUTION_RESULT_VIDEO_MS).toBe(6_000);
    expect((REVOLUTION_RESULT_VIDEO_MS / 1000) * 24).toBe(144);
  });

  it('演出尺は素材尺以上(12秒・不足ぶんは最終フレーム静止で持つ)', () => {
    // 素材(6秒)を 12 秒素材へ差し替えるときは VIDEO_MS だけ実尺に合わせる。
    expect(REVOLUTION_RESULT_MS).toBe(12_000);
    expect(REVOLUTION_RESULT_MS).toBeGreaterThanOrEqual(REVOLUTION_RESULT_VIDEO_MS);
  });

  it('ロールアップは boost-settle の実装を再利用している(第2の真実を作らない)', () => {
    // 決定的ハッシュ(Math.random 不使用)の契約ごと共有していることの確認。
    const p = planRevolutionResult(FULL);
    const a = rollupDisplayAt(126, 100, p.tapRollupMs, 7);
    const b = rollupDisplayAt(126, 100, p.tapRollupMs, 7);
    expect(a.text).toBe(b.text);
    expect(rollupDisplayAt(126, p.tapRollupMs, p.tapRollupMs, 7)).toEqual({
      text: '126',
      locked: 3,
      done: true,
    });
  });
});

describe('countupDisplayAt — 衝突後の合計カウントアップ', () => {
  it('決定的かつ単調増加で、done のとき厳密値に着く', () => {
    const dur = 1_650;
    let prev = -1;
    for (let t = 0; t <= dur; t += 50) {
      const r = countupDisplayAt(128, t, dur);
      const v = Number(r.text);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(128);
      prev = v;
      // 同じ入力は同じ出力(rAF の再実行で数字が揺れない)。
      expect(countupDisplayAt(128, t, dur).text).toBe(r.text);
    }
    expect(countupDisplayAt(128, dur, dur)).toEqual({ text: '128', done: true });
    expect(countupDisplayAt(128, dur + 999, dur)).toEqual({ text: '128', done: true });
  });

  it('開始時は 0 から立ち上がる(ぶつかった瞬間に答えが出ない)', () => {
    expect(countupDisplayAt(128, 0, 1_650).text).toBe('0');
  });

  it('尺 0 は即確定(reduced-motion や壊れた入力の縮退)', () => {
    expect(countupDisplayAt(128, 0, 0)).toEqual({ text: '128', done: true });
  });
});
