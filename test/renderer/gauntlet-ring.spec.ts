import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { gauntletRing } from '../../src/renderer/monitor/gauntlet-ring';
import { GauntletRing } from '../../src/renderer/monitor/GauntletRing';

/**
 * 最終ゲートの進捗リング。規則(いつ出すか)は gauntletRing 純関数、描画は
 * GauntletRing の実レンダー(seven-seg.spec.ts と同じ renderToStaticMarkup —
 * jsdom 不要)、配線は MonitorView のソース検査(seg-class.spec.ts と同型)で見る。
 */

describe('gauntletRing — 表示規則', () => {
  it('gauntlet キーが載っているときだけ模型を返す', () => {
    expect(gauntletRing({ status: 'running', gauntlet: { taps: 2, needed: 30 } })).toEqual({
      ticks: 30,
      lit: 2,
    });
    expect(gauntletRing({ status: 'running' })).toBeNull();
    expect(gauntletRing(null)).toBeNull();
    expect(gauntletRing(undefined)).toBeNull();
  });

  it('走行中以外は gauntlet が残っていても出さない(停止直後の古いスナップショット防御)', () => {
    expect(gauntletRing({ status: 'idle', gauntlet: { taps: 2, needed: 30 } })).toBeNull();
    expect(gauntletRing({ status: 'achieved', gauntlet: { taps: 2, needed: 30 } })).toBeNull();
  });

  it('lit は 0..ticks へクランプ(taps 設定を下げた直後の1フレーム防御)', () => {
    expect(gauntletRing({ status: 'running', gauntlet: { taps: 40, needed: 30 } })?.lit).toBe(30);
    expect(gauntletRing({ status: 'running', gauntlet: { taps: -1, needed: 30 } })?.lit).toBe(0);
  });

  it('needed < 2 は不正(検証の下限は 2)— 出さない', () => {
    expect(gauntletRing({ status: 'running', gauntlet: { taps: 0, needed: 1 } })).toBeNull();
    expect(gauntletRing({ status: 'running', gauntlet: { taps: 0, needed: 0 } })).toBeNull();
  });
});

describe('GauntletRing — 描画', () => {
  function render(lit: number, ticks: number): string {
    return renderToStaticMarkup(createElement(GauntletRing, { ring: { ticks, lit } }));
  }

  it('data-gauntlet に lit/ticks を出す(E2E の読み取り口)', () => {
    expect(render(2, 30)).toContain('data-gauntlet="2/30"');
    expect(render(0, 3)).toContain('data-gauntlet="0/3"');
  });

  it('点灯レイヤの dasharray は「点灯 残り」', () => {
    const html = render(12, 30);
    expect(html).toMatch(/gr-lit[^>]*stroke-dasharray:\s*12 18/);
  });

  it('pathLength = ticks で目盛りの単位を固定する(要素数は ticks に比例しない)', () => {
    const html = render(5, 999);
    expect(html).toMatch(/pathLength="999"/);
    // 個別目盛り DOM を作らない — rect は 4 枚まで(track/lit/sep/flash)。
    expect(html.match(/<rect/g)?.length ?? 0).toBeLessThanOrEqual(4);
  });

  it('脈動フラッシュは lit > 0 のときだけ(0 目盛りで光ると開幕から明滅する)', () => {
    expect(render(0, 30)).not.toContain('gr-flash');
    expect(render(1, 30)).toContain('gr-flash');
  });
});

describe('MonitorView / monitor.css の配線(規則を自前で書き直していないこと)', () => {
  const SRC = readFileSync('src/renderer/monitor/MonitorView.tsx', 'utf8');
  const CSS = readFileSync('src/renderer/styles/monitor.css', 'utf8');

  it('ring は gauntletRing から作る', () => {
    expect(SRC).toMatch(/const ring = gauntletRing\(/);
  });

  it('条件のインライン再実装が残っていない', () => {
    expect(SRC).not.toMatch(/challenge\.gauntlet\s*&&\s*challenge\.status/);
  });

  it('リング用クラスを .countdown(segCls)へ足していない — punch/classList 規約の防御', () => {
    expect(SRC).not.toMatch(/segCls[^;]*gauntlet/);
  });

  it('CSS: .countdown 本体に gauntlet 系の animation を足していない(punch-* と取り合う)', () => {
    // .countdown { ... } 本体ブロックだけを切り出して検査(seg-css.spec.ts と同じ発想)。
    const body = CSS.match(/\.countdown \{[^}]*\}/)?.[0] ?? '';
    expect(body).not.toContain('animation');
    expect(body).not.toContain('gauntlet');
  });

  it('CSS: リングはタップを遮らない(pointer-events: none)', () => {
    const block = CSS.match(/\.gauntlet-ring \{[^}]*\}/)?.[0] ?? '';
    expect(block).toContain('pointer-events: none');
    expect(block).toContain('grid-area: count');
  });
});
