import { describe, expect, it } from 'vitest';
import {
  BOOST_ROLLUP_BASE_MS,
  BOOST_ROLLUP_HOLD_MS,
  BOOST_ROLLUP_MAX_MS,
  BOOST_ROLLUP_SPIN_FRAME_MS,
  BOOST_SETTLE_BUDGET_MS,
  STRIKE_TRAVEL_MAX_MS,
  planBoostSettle,
  rollupDisplayAt,
} from '@shared/boost-settle';

describe('planBoostSettle — 清算発表のタイムライン', () => {
  it('タップ 0 / 減算 0 は全段 0(発表を丸ごとスキップ)', () => {
    expect(planBoostSettle({ amount: 0, tapCount: 3, resultMs: 4000 })).toEqual({
      resultMs: 0,
      rollupMs: 0,
      holdMs: 0,
      totalMs: 0,
    });
    expect(planBoostSettle({ amount: 30, tapCount: 0, resultMs: 4000 })).toEqual({
      resultMs: 0,
      rollupMs: 0,
      holdMs: 0,
      totalMs: 0,
    });
  });

  it('rollupMs は桁数でスケールし、clamp が効く', () => {
    const d1 = planBoostSettle({ amount: 5, tapCount: 1, resultMs: 0 });
    const d3 = planBoostSettle({ amount: 150, tapCount: 3, resultMs: 0 });
    const d7 = planBoostSettle({ amount: 1_500_000, tapCount: 100, resultMs: 0 });
    expect(d1.rollupMs).toBeGreaterThanOrEqual(BOOST_ROLLUP_BASE_MS);
    expect(d3.rollupMs).toBeGreaterThan(d1.rollupMs);
    expect(d7.rollupMs).toBe(BOOST_ROLLUP_MAX_MS);
  });

  it('totalMs = resultMs + rollupMs + holdMs(結果カットシーンなしは resultMs 0)', () => {
    const p = planBoostSettle({ amount: 30, tapCount: 3, resultMs: 4000 });
    expect(p.resultMs).toBe(4000);
    expect(p.holdMs).toBe(BOOST_ROLLUP_HOLD_MS);
    expect(p.totalMs).toBe(4000 + p.rollupMs + p.holdMs);
    const noClip = planBoostSettle({ amount: 30, tapCount: 3, resultMs: 0 });
    expect(noClip.totalMs).toBe(noClip.rollupMs + noClip.holdMs);
  });

  it('予算整合: 発表シーケンス(resultMs 除く)+ 飛翔 + 配送遅延が worker の凍結予算に収まる', () => {
    // worker は fxFreezeUntilMs に resultMs + BOOST_SETTLE_BUDGET_MS を上乗せする
    // (worker/challenge.ts activateBoost)。レンダラの発表は boost-end 受信
    // (最悪 ~525ms 遅延)から rollup(上限)→ hold → strike 飛翔(上限)なので、
    // この不等式が破れると凍結明けの保留演出が着弾前に割り込む。
    expect(BOOST_SETTLE_BUDGET_MS).toBeGreaterThanOrEqual(
      525 + BOOST_ROLLUP_MAX_MS + BOOST_ROLLUP_HOLD_MS + STRIKE_TRAVEL_MAX_MS
    );
  });
});

describe('rollupDisplayAt — パチンコ式桁ロック', () => {
  const AMOUNT = 1234;
  const ROLLUP = 1900;
  const SEED = 42;

  it('done 時は必ず対象の数字列そのもの', () => {
    const r = rollupDisplayAt(AMOUNT, ROLLUP, ROLLUP, SEED);
    expect(r).toEqual({ text: '1234', locked: 4, done: true });
    // 超過してもそのまま(rAF の最終フレームが多少遅れても安全)。
    expect(rollupDisplayAt(AMOUNT, ROLLUP + 500, ROLLUP, SEED).text).toBe('1234');
  });

  it('同じ入力なら常に同じ表示(決定的 — StrictMode 二重レンダー対策)', () => {
    for (const ms of [0, 130, 460, 900, 1500]) {
      const a = rollupDisplayAt(AMOUNT, ms, ROLLUP, SEED);
      const b = rollupDisplayAt(AMOUNT, ms, ROLLUP, SEED);
      expect(a).toEqual(b);
    }
    // seed が違えば回転中の見た目は(高確率で)変わる — 全フレーム一致はしない。
    const spinsA: string[] = [];
    const spinsB: string[] = [];
    for (let ms = 0; ms < 500; ms += BOOST_ROLLUP_SPIN_FRAME_MS) {
      spinsA.push(rollupDisplayAt(AMOUNT, ms, ROLLUP, 1).text);
      spinsB.push(rollupDisplayAt(AMOUNT, ms, ROLLUP, 2).text);
    }
    expect(spinsA.join('|')).not.toBe(spinsB.join('|'));
  });

  it('locked は経過時間に対して単調非減少で、確定済みの上位桁は巻き戻らない', () => {
    let prevLocked = 0;
    for (let ms = 0; ms <= ROLLUP; ms += 25) {
      const r = rollupDisplayAt(AMOUNT, ms, ROLLUP, SEED);
      expect(r.locked).toBeGreaterThanOrEqual(prevLocked);
      // 確定済みの桁は真の値と一致している。
      expect(r.text.slice(0, r.locked)).toBe(String(AMOUNT).slice(0, r.locked));
      expect(r.text).toHaveLength(String(AMOUNT).length);
      prevLocked = r.locked;
    }
  });

  it('最終桁は rollupMs 到達まで確定しない(最後の1桁で焦らす)', () => {
    const n = String(AMOUNT).length;
    const r = rollupDisplayAt(AMOUNT, ROLLUP - 1, ROLLUP, SEED);
    expect(r.done).toBe(false);
    expect(r.locked).toBeLessThanOrEqual(n - 1);
  });

  it('1桁でも成立する', () => {
    expect(rollupDisplayAt(5, 0, 900, SEED).done).toBe(false);
    expect(rollupDisplayAt(5, 900, 900, SEED)).toEqual({ text: '5', locked: 1, done: true });
  });
});
