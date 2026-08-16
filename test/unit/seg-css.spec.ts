import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 7セグの残像・負荷対策(v0.7.2 後の第2弾)のソース不変条件。
 *
 * - パンチは key={punchKey} の**再マウントではなく classList リプレイ**で再生する。
 *   再マウントに戻すと、数字が動くたびにフィルタ付きポリゴン最大42個の SVG を
 *   破棄→再生成し、弱い GPU で残像・GC ジッタが再発する。
 * - 発光(drop-shadow)は .seg.on 個別ではなく .seg-digit(桁単位)に集約。
 * - lowblink は .seg-row 1要素の opacity 明滅(個別 fill アニメの無限再評価を廃止)。
 * - punchglow は punch-* クラスにスコープ(無条件発火の廃止)。
 * fx-stage.spec.ts / fx-hold-safety.spec.ts と同型の機械的担保。
 */

const SRC = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8');
const CSS = readFileSync(resolve('src/renderer/styles/monitor.css'), 'utf8');

/** 行頭セレクタの非ネストブロックを切り出す。 */
function cssBlock(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = CSS.match(new RegExp(`(?:^|\\n)${esc} \\{[^}]*\\}`));
  expect(m, `${selector} のブロックが見つからない`).toBeTruthy();
  return m![0];
}

describe('パンチの classList リプレイ(key 再マウントの廃止)', () => {
  it('.countdown に key={punchKey} が無い(再マウント復活の検出)', () => {
    expect(SRC).not.toContain('key={punchKey}');
  });

  it('リプレイ effect は remove → リフロー → add の順', () => {
    const removeAt = SRC.indexOf("classList.remove('punch-down', 'punch-up', 'punch-strike')");
    const reflowAt = SRC.indexOf('void el.offsetWidth');
    const addAt = SRC.indexOf('classList.add(`punch-${punchDir}`)');
    expect(removeAt).toBeGreaterThanOrEqual(0);
    expect(reflowAt).toBeGreaterThan(removeAt);
    expect(addAt).toBeGreaterThan(reflowAt);
  });

  it('segCls は punch-* を持たない(React className との二重管理の防止)', () => {
    // 規則そのものは seg-class.ts へ切り出し済み(test/renderer/seg-class.spec.ts が
    // 「punch-* を含めない」を全 status で検証する)。ここは配線だけを見る —
    // MonitorView が自前で組み直していたら、その式に punch-* が混ざりうる。
    const m = SRC.match(/const segCls = countdownClass\([\s\S]*?\);/);
    expect(m, 'segCls は countdownClass から作ること').toBeTruthy();
    expect(m![0]).not.toContain('punch-');
    // 切り出し先も punch-* を**文字列として**持たない。コメントでの言及は許す
    // (className に載るのはクォートされた文字列だけなので、そこだけを見る)。
    const SEG_CLASS = readFileSync(resolve('src/renderer/monitor/seg-class.ts'), 'utf8');
    expect(SEG_CLASS).not.toMatch(/['"`]punch-/);
  });

  it('punchglow は punch-* クラスにだけスコープされる(無条件発火の再発防止)', () => {
    expect(cssBlock('.countdown::after')).not.toContain('animation');
    for (const dir of ['down', 'up', 'strike']) {
      expect(cssBlock(`.countdown.punch-${dir}::after`)).toContain('animation: punchglow');
    }
  });
});

describe('7セグ発光の桁単位集約と lowblink の軽量化', () => {
  it('drop-shadow は .seg-digit(桁単位)にあり、.seg.on 個別には無い', () => {
    expect(cssBlock('.seg-digit')).toContain('drop-shadow(0 0 10px var(--seg-glow))');
    expect(cssBlock('.seg.on')).not.toContain('filter');
  });

  it('lowblink は .seg-row の opacity 明滅(.seg.on 個別の無限 fill アニメは廃止)', () => {
    expect(cssBlock('.countdown.low .seg-row')).toContain('lowblink-row');
    expect(CSS).not.toMatch(/\.countdown\.low \.seg\.on/);
  });

  it('segflash(セグ個別)は fill だけ動かし、グローは segdigitflash(桁単位)が撃つ', () => {
    const flash = CSS.match(/@keyframes segflash \{[\s\S]*?\n\}/);
    expect(flash).toBeTruthy();
    expect(flash![0]).not.toContain('filter');
    expect(CSS).toMatch(/@keyframes segdigitflash \{/);
    expect(cssBlock('.countdown.punch-strike .seg-digit')).toContain('segdigitflash');
  });
});

describe('mix-blend 合成の不変条件(monitor.css の警告コメントの機械化)', () => {
  it('.fx-clip の screen 合成は維持される', () => {
    expect(cssBlock('.fx-clip')).toContain('mix-blend-mode: screen');
  });

  it('.monitor-root に合成を壊すプロパティを足していない', () => {
    const root = cssBlock('.monitor-root');
    for (const bad of ['z-index', 'opacity', 'filter', 'isolation', 'transform']) {
      expect(root, `.monitor-root に ${bad} がある — 合成の境界が壊れる`).not.toContain(bad);
    }
  });
});
