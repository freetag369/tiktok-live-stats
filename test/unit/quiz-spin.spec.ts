import { describe, expect, it } from 'vitest';
import { QUIZ_SPIN_MS } from '@shared/challenge';
import { QUIZ_SPIN_STEPS, quizSpinTicks } from '@shared/quiz-spin';

/**
 * お題回転のコマ列の凍結。決定的(Math.random 不使用)・単調増加・最後は必ず
 * 当選 index、が契約 — StrictMode の二重レンダーでも同じ列が出る。
 */
describe('quizSpinTicks', () => {
  it('コマ数は QUIZ_SPIN_STEPS、atMs は狭義単調増加、最後は当選 index', () => {
    const ticks = quizSpinTicks(5, 3);
    expect(ticks.length).toBe(QUIZ_SPIN_STEPS);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.atMs).toBeGreaterThan(ticks[i - 1]!.atMs);
    }
    expect(ticks[ticks.length - 1]!.show).toBe(3);
    expect(ticks[ticks.length - 1]!.atMs).toBeGreaterThanOrEqual(QUIZ_SPIN_MS);
  });

  it('表示列は当選から逆算した連番の巡回(途中経過から答えが読めない = 全件が流れる)', () => {
    const count = 4;
    const ticks = quizSpinTicks(count, 1, 6000);
    // 隣接コマは常に +1 の巡回。
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.show).toBe((ticks[i - 1]!.show + 1) % count);
    }
    // 全 index が最低1回は出る(count <= STEPS の範囲)。
    expect(new Set(ticks.map((t) => t.show)).size).toBe(count);
  });

  it('減速 — 序盤の間隔より終盤の間隔が長い(easeIn 写像でコマ間隔が伸びていく)', () => {
    const ticks = quizSpinTicks(10, 0, 6000);
    const first = ticks[1]!.atMs - ticks[0]!.atMs;
    const last = ticks[ticks.length - 1]!.atMs - ticks[ticks.length - 2]!.atMs;
    expect(last).toBeGreaterThan(first * 3);
  });

  it('お題1件は1コマで即確定。範囲外の winner はクランプ', () => {
    expect(quizSpinTicks(1, 0)).toEqual([{ atMs: QUIZ_SPIN_MS, show: 0 }]);
    const t = quizSpinTicks(3, 99, 1000);
    expect(t[t.length - 1]!.show).toBe(2);
    const t2 = quizSpinTicks(3, -5, 1000);
    expect(t2[t2.length - 1]!.show).toBe(0);
  });

  it('決定的 — 同じ入力は同じ列(StrictMode の二重レンダー安全)', () => {
    expect(quizSpinTicks(7, 2)).toEqual(quizSpinTicks(7, 2));
  });
});
