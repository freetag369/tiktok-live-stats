import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SevenSeg } from '../../src/renderer/monitor/SevenSeg';

/**
 * 7セグの実レンダー。
 *
 * ここはカウントダウンの**数字そのもの**を描く場所なのに、これまで一度も
 * レンダーされていなかった(test/unit/seg-css.spec.ts は MonitorView.tsx と
 * monitor.css を**文字列として**読む検査で、SevenSeg.tsx には触れていない)。
 *
 * jsdom は要らない。react-dom は既に devDependency にあり、
 * renderToStaticMarkup は DOM 無しの node 環境でそのまま動く。
 * effect / ref / state は走らないが、ここは props → マークアップの純関数なので
 * 必要な範囲を全部押さえられる。
 */

/** 点灯しているセグメント数(class="seg on")。 */
function litCount(html: string): number {
  return html.match(/class="seg on"/g)?.length ?? 0;
}

/** 桁の数(.seg-digit の svg)。 */
function digitCount(html: string): number {
  return html.match(/class="seg-digit"/g)?.length ?? 0;
}

function render(value: number, digits: number): string {
  return renderToStaticMarkup(createElement(SevenSeg, { value, digits }));
}

/** 数字ごとの点灯セグメント数(SEG のビットマップから導いた期待値)。 */
const LIT_PER_DIGIT: Record<string, number> = {
  '0': 6,
  '1': 2,
  '2': 5,
  '3': 5,
  '4': 4,
  '5': 5,
  '6': 6,
  '7': 3,
  '8': 7,
  '9': 6,
};

describe('SevenSeg — 数字の描画', () => {
  it('現在値を aria-label に生の数字で出す(E2E とスクリーンリーダーの読み取り口)', () => {
    expect(render(1234, 4)).toContain('aria-label="1234"');
    expect(render(0, 4)).toContain('aria-label="0"');
  });

  it('0〜9 のセグメント点灯数が定義どおり', () => {
    for (const [ch, lit] of Object.entries(LIT_PER_DIGIT)) {
      // digits=1 にして 1 桁だけ描かせる。
      const html = render(Number(ch), 1);
      expect(litCount(html), `${ch} の点灯数`).toBe(lit);
    }
  });

  it('「1」は右の2本だけ、「8」は全部点く(向きの取り違えを検出)', () => {
    expect(litCount(render(1, 1))).toBe(2);
    expect(litCount(render(8, 1))).toBe(7);
  });

  it('桁数に満たない上位はゴースト桁(枠は描くが全消灯)', () => {
    const html = render(7, 4);
    expect(digitCount(html)).toBe(4);
    // 点いているのは「7」の3本だけ。残り3桁は消灯。
    expect(litCount(html)).toBe(LIT_PER_DIGIT['7']!);
  });

  it('値が桁数を超えたら桁を増やす(妨害で初期値を超えることがある)', () => {
    // 4桁指定に 5 桁の値。詰めずに桁を足す。
    expect(digitCount(render(12345, 4))).toBe(5);
    expect(render(12345, 4)).toContain('aria-label="12345"');
  });

  it('負の値は 0 に、小数は切り捨てにクランプされる', () => {
    expect(render(-50, 4)).toContain('aria-label="0"');
    expect(render(12.9, 4)).toContain('aria-label="12"');
  });

  it('内側の svg は aria-hidden で、読み上げは外側の1つだけ', () => {
    const html = render(42, 4);
    expect(html.match(/aria-hidden/g)?.length).toBe(digitCount(html));
    expect(html.match(/aria-label=/g)?.length).toBe(1);
    expect(html).toContain('role="img"');
  });

  it('消灯セグメントも常に描く(桁幅の確保と色補間のため)', () => {
    // 1桁 = 7本。点灯 + 消灯 = 7。
    const html = render(1, 1);
    const off = html.match(/class="seg"/g)?.length ?? 0;
    expect(litCount(html) + off).toBe(7);
  });
});
