/**
 * 据え置き(heldValue)の押下追従。モニターの MonitorView がこの1式だけを使って
 * 「カットイン中でもタップぶんだけ数字を下げる」を実現するので、境界はここで固定する。
 *
 * レンダラのテスト環境がこのリポジトリに無いため、決定ロジックは shared の
 * 純関数に出してある(fx-drain / fx-floats / boost-settle と同じ理由)。
 */
import { describe, expect, it } from 'vitest';
import { pressDropSinceHold } from '@shared/fx-hold';

describe('pressDropSinceHold — 据え置きから引く押下ぶん', () => {
  it('据え置きを張ってからの増分のうち、まだ引いていない分を返す', () => {
    // 据え置き時 base=10。いま 13 まで押されていて、うち 1 は引き済み → 残り 2。
    expect(pressDropSinceHold(10, 13, 1)).toBe(2);
  });

  it('押されていなければ 0(据え置きは動かない)', () => {
    expect(pressDropSinceHold(10, 10, 0)).toBe(0);
    expect(pressDropSinceHold(0, 0, 0)).toBe(0);
  });

  it('引き終わっていれば 0 — 同じ delta で二重に引かない', () => {
    expect(pressDropSinceHold(10, 15, 5)).toBe(0);
  });

  it('**負を返さない** — start / reset で累計が 0 に戻っても数字が跳ね上がらない', () => {
    // ラン切り替えで pressDownTotal は 0 へ戻る。据え置きの持ち主がまだ居ると
    // total < base になるが、ここが負を返すと「押していないのに数字が増える」。
    expect(pressDropSinceHold(120, 0, 30)).toBe(0);
    expect(pressDropSinceHold(120, 100, 0)).toBe(0);
  });

  it('applied が進むと差分だけを返し続ける(据え置きは単調に減る)', () => {
    let applied = 0;
    const step = (total: number): number => {
      const d = pressDropSinceHold(5, total, applied);
      applied += d;
      return d;
    };
    expect(step(6)).toBe(1);
    expect(step(6)).toBe(0); // 同じ値の delta が再送されても増えない
    expect(step(9)).toBe(3);
    expect(applied).toBe(4); // 合計は total - base に一致
  });
});
