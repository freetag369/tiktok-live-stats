import { describe, expect, it } from 'vitest';
import {
  formatFrameLine,
  shouldEscalate,
  summarizeFrames,
} from '../../src/renderer/lib/frame-meter';

/**
 * フレームタイム計測(2026-08-22)の純関数部。rAF 常駐部はブラウザ実機の
 * 領分(diag.log の [frame] 行で確認)なので、ここでは集計と整形だけを固定する。
 * renderer ソースを import するため test/renderer/ に置く。
 */

describe('summarizeFrames', () => {
  it('空窓はゼロ要約(起動直後・遮蔽中に NaN を出さない)', () => {
    expect(summarizeFrames([])).toEqual({ n: 0, p50: 0, p95: 0, max: 0, j34: 0, j50: 0, j100: 0 });
  });

  it('60Hz 定常はジャンクゼロ', () => {
    const dts = Array.from({ length: 600 }, () => 16.7);
    const s = summarizeFrames(dts);
    expect(s.n).toBe(600);
    expect(s.p50).toBe(17);
    expect(s.p95).toBe(17);
    expect(s.j34).toBe(0);
    expect(s.j50).toBe(0);
    expect(s.j100).toBe(0);
  });

  it('ヒッチは閾値ごとに数える(34/50/100 は境界を含まない)', () => {
    const s = summarizeFrames([16, 34, 35, 50, 51, 100, 128]);
    expect(s.j34).toBe(5); // 35, 50, 51, 100, 128
    expect(s.j50).toBe(3); // 51, 100, 128
    expect(s.j100).toBe(1); // 128
    expect(s.max).toBe(128);
  });

  it('p95 は昇順 95% 位置(入力順に依存しない)', () => {
    const dts = [...Array.from({ length: 95 }, () => 16), ...Array.from({ length: 5 }, () => 80)];
    // 並べ替えても同じ。
    const shuffled = [...dts].reverse();
    expect(summarizeFrames(dts).p95).toBe(summarizeFrames(shuffled).p95);
    expect(summarizeFrames(dts).p95).toBe(80);
  });
});

describe('formatFrameLine', () => {
  it('[frame] プレフィックス+1行固定(diag-log のファイル専用経路の契約)', () => {
    const line = formatFrameLine(
      { n: 3597, p50: 17, p95: 18, max: 128, j34: 3, j50: 1, j100: 0 },
      { count: 2, totalMs: 310.4, maxMs: 200 },
      []
    );
    expect(line).toBe('[frame] n=3597 p50=17 p95=18 max=128 j34=3 j50=1 j100=0 task=2/310ms');
    expect(line).not.toContain('\n');
  });

  it('media 実測があるときだけ付ける', () => {
    const line = formatFrameLine(
      { n: 10, p50: 16, p95: 16, max: 20, j34: 0, j50: 0, j100: 0 },
      { count: 0, totalMs: 0, maxMs: 0 },
      [
        { label: 'band-cutin', count: 2, maxMs: 420.6 },
        { label: 'rl-clip', count: 1, maxMs: 90 },
      ]
    );
    expect(line).toContain('media=band-cutin:421×2,rl-clip:90×1');
  });
});

describe('shouldEscalate', () => {
  const base = { n: 100, p50: 16, p95: 17, max: 30, j34: 0, j50: 0, j100: 0 };

  it('定常は上げない', () => {
    expect(shouldEscalate(base)).toBe(false);
  });

  it('p95 > 50ms(定常コマ落ち)で上げる', () => {
    expect(shouldEscalate({ ...base, p95: 51 })).toBe(true);
    expect(shouldEscalate({ ...base, p95: 50 })).toBe(false);
  });

  it('明確なヒッチが窓内5回以上で上げる', () => {
    expect(shouldEscalate({ ...base, j100: 5 })).toBe(true);
    expect(shouldEscalate({ ...base, j100: 4 })).toBe(false);
  });

  it('空窓(遮蔽中)は上げない', () => {
    expect(shouldEscalate({ ...base, n: 0, p95: 999 })).toBe(false);
  });
});
