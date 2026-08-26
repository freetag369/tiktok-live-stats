import { describe, expect, it } from 'vitest';
import { STRIKE_TRAVEL_MAX_MS } from '@shared/boost-settle';
import {
  BANNER_GIFT_SCALE_MS,
  GIFT_SCALE_APPEAR_MS,
  GIFT_SCALE_HOLD_MS,
  GIFT_SCALE_ROLLUP_MAX_MS,
  countUpDisplayAt,
  giftScaleTotalWithStrikeMs,
  planGiftScaleFx,
} from '@shared/gift-scale-fx';

/**
 * ダイヤ増減演出の尺と表示値の純関数。レンダラに DOM テスト環境が無いので、
 * 演出の決定ロジックはここで固定する(boost-settle.spec.ts と同型)。
 */

describe('countUpDisplayAt — 0 から合計値へ単調に増える', () => {
  it('起点は 0・終端はちょうど合計値', () => {
    expect(countUpDisplayAt(1000, 0, 800)).toBe(0);
    expect(countUpDisplayAt(1000, 800, 800)).toBe(1000);
    // 呼び出し側の rAF が1フレーム余分に回っても最終値は揺れない。
    expect(countUpDisplayAt(1000, 5000, 800)).toBe(1000);
  });

  it('負の経過・尺 0 でも壊れない', () => {
    expect(countUpDisplayAt(1000, -50, 800)).toBe(0);
    expect(countUpDisplayAt(1000, 0, 0)).toBe(1000);
    expect(countUpDisplayAt(1000, 10, -5)).toBe(1000);
  });

  it('単調非減少で、合計値を超えない(桁が跳ねて見えない)', () => {
    const total = 1_299_950; // フェニックス 25999💎 × 50
    let prev = -1;
    for (let i = 0; i <= 60; i++) {
      const v = countUpDisplayAt(total, (1100 * i) / 60, 1100);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(v).toBeLessThanOrEqual(total);
      expect(Number.isInteger(v)).toBe(true);
      prev = v;
    }
    expect(prev).toBe(total);
  });

  it('途中で合計値へ到達しない(溜めの手前で数字が止まって見えない)', () => {
    // floor を使う理由の回帰止め。round だと t=0.99 の時点で goal に届く。
    const total = 484_950; // レオンとリリー 9699💎 × 50
    expect(countUpDisplayAt(total, 1099, 1100)).toBeLessThan(total);
  });

  it('決定的(Math.random を使っていない)', () => {
    const a = countUpDisplayAt(9_999, 300, 900);
    const b = countUpDisplayAt(9_999, 300, 900);
    expect(a).toBe(b);
  });

  it('負の合計は 0 に倒す(符号は呼び出し側が付ける)', () => {
    expect(countUpDisplayAt(-500, 400, 800)).toBe(0);
  });
});

describe('planGiftScaleFx — 尺の計画', () => {
  it('桁が増えるほどカウントアップは長いが、上限で頭打ちになる', () => {
    const one = planGiftScaleFx({ amountAbs: 30 });
    const many = planGiftScaleFx({ amountAbs: 1_299_950 });
    expect(one.rollupMs).toBeLessThan(many.rollupMs);
    expect(many.rollupMs).toBeLessThanOrEqual(GIFT_SCALE_ROLLUP_MAX_MS);
  });

  it('totalMs は appear + rollup + hold', () => {
    const p = planGiftScaleFx({ amountAbs: 12_345 });
    expect(p.appearMs).toBe(GIFT_SCALE_APPEAR_MS);
    expect(p.holdMs).toBe(GIFT_SCALE_HOLD_MS);
    expect(p.totalMs).toBe(p.appearMs + p.rollupMs + p.holdMs);
  });

  it('amount 0 / 負でも桁は 1 として扱う(尺が 0 に潰れない)', () => {
    expect(planGiftScaleFx({ amountAbs: 0 }).rollupMs).toBeGreaterThan(0);
    expect(planGiftScaleFx({ amountAbs: -5 }).rollupMs).toBeGreaterThan(0);
  });

  it('【不変条件】着弾までがバナーの尺に収まる(弾がバナー消滅後に飛ばない)', () => {
    // 破ると「どこから飛んできたのか分からない弾」になる。全桁で固定する。
    for (const digits of [1, 2, 3, 4, 5, 6, 7]) {
      const amountAbs = Number('9'.repeat(digits));
      const p = planGiftScaleFx({ amountAbs });
      expect(
        giftScaleTotalWithStrikeMs(p),
        `${digits}桁で着弾がバナー尺を超える`
      ).toBeLessThanOrEqual(BANNER_GIFT_SCALE_MS);
      expect(p.totalMs + STRIKE_TRAVEL_MAX_MS).toBe(giftScaleTotalWithStrikeMs(p));
    }
  });

  it('カウントアップの開始は浮上の立ち上がりが明けてから', () => {
    // ここより早く回すとバナーがまだ拡大中で数字が読めない。
    expect(GIFT_SCALE_APPEAR_MS).toBeGreaterThanOrEqual(BANNER_GIFT_SCALE_MS * 0.2);
  });
});
