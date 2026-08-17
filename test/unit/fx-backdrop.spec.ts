/**
 * 「後ろで少し見える / 音だけ聞こえる」を成立させている**構造**の凍結。
 *
 * 2026-08-17 ユーザー決定の 3 行(fx-occlusion.ts 参照)のうち、
 * 見え方そのものを作っているのは JS ではなく **CSS の重なり順**である:
 *
 *   .monitor-root                       ← z-index を付けるのは禁止
 *     video.fx-clip          (screen 合成・z-index なし)  ← 満杯の全画面クリップ
 *     video.fx-strike        (screen 合成・z-index なし)  ← 着弾クリップ
 *     video.fx-clip-opaque   (opacity .96・z-index なし)  ← ギフト/ストック/ブースト
 *     div.fx-layer           z-index: 50
 *        canvas.fx-canvas / .flash / .mini                ← 不透明動画より必ず**手前**
 *        .roulette-screen    rgba(5, 3, 10, 0.8) の半透明暗幕
 *
 * ここから 2 つの帰結が出て、それぞれが実装の前提になっている:
 *  (a) クリップ 2 本はルーレット暗幕の下 = 約 20% 透けて「後ろで少し見える」。
 *      だから fxImpactPlan の 'sheer' は 'none' と同じ内容でよい(小細工は不要)。
 *  (b) 粒子・照明・簡易演出は fx-layer(z-index:50)の中なので**不透明動画より手前**。
 *      だから 'opaque' では JS 側で黙らせないと「音だけ」にならない。
 *
 * この 4 点(z-index:50 / クリップに z-index 無し / 暗幕の α / JSX の並び)が
 * 動くと、着弾側のコードは一切壊れていないのに見え方だけが黙って壊れる。
 *
 * 注意: 「クリップに opacity が無いこと」は**凍結しない** — .fx-clip:opacity 1 /
 * .fx-clip-opaque:opacity .96 / .fx-strike:opacity 1 は実在し、幕そのものだから。
 * 禁止されているのは z-index / filter / isolation / transform の追加(mix-blend-mode
 * が壊れて黒い矩形になる。monitor.css:1343-1348 の警告)。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_PATH = join(__dirname, '../../src/renderer/styles/monitor.css');
const css = readFileSync(CSS_PATH, 'utf8');
const VIEW_PATH = join(__dirname, '../../src/renderer/monitor/MonitorView.tsx');
const view = readFileSync(VIEW_PATH, 'utf8');

/**
 * `<selector> { ... }` の本文を取り出す。roulette-css.spec.ts の ruleBody と同じ
 * 役割だが、正規表現のエスケープを避けて indexOf で書いてある(セレクタに . や -
 * が入るため)。入れ子を含まない素のルール専用。
 */
function ruleBody(selector: string): string {
  const head = `${selector} {`;
  const at = css.indexOf(head);
  expect(at, `${selector} が monitor.css に無い`).toBeGreaterThanOrEqual(0);
  const start = at + head.length;
  const end = css.indexOf('}', start);
  expect(end, `${selector} のルールが閉じていない`).toBeGreaterThan(start);
  return css.slice(start, end);
}

describe('演出レイヤの重なり順(CSS)', () => {
  it('.fx-layer の z-index:50 が「粒子は不透明カットインより手前」の根拠', () => {
    // ここが変わると、fxImpactPlan の 'opaque' で粒子を黙らせている意味が消える
    // (逆に下げると今度はルーレットの手前に出て暗幕越しに見えなくなる)。
    expect(ruleBody('.fx-layer')).toContain('z-index: 50');
  });

  it('クリップ 3 種は z-index を持たない(重なり順は DOM 順が決める)', () => {
    // z-index を足すと mix-blend-mode: screen の合成相手が変わり、黒が抜けずに
    // UI を覆う「黒い矩形」になる — 過去に長時間溶かした罠。
    for (const sel of ['.fx-clip', '.fx-strike', '.fx-clip-opaque']) {
      expect(ruleBody(sel), `${sel} に z-index を足してはいけない`).not.toContain('z-index');
    }
  });

  it('.fx-clip と .fx-strike は screen 合成(= 背面に置いても黒が抜ける)', () => {
    expect(ruleBody('.fx-clip')).toContain('mix-blend-mode: screen');
    expect(ruleBody('.fx-strike')).toContain('mix-blend-mode: screen');
  });

  it('ルーレットの暗幕は半透明 — これが「後ろで少し見える」の実体', () => {
    // 不透明にすると満杯の背面再生が「音だけ」に退化する(ユーザー要望が破れる)。
    expect(ruleBody('.roulette-screen')).toContain('rgba(5, 3, 10, 0.8)');
  });

  it('不透明カットインは実際に不透明 — これが「音だけ」の実体', () => {
    const body = ruleBody('.fx-clip-opaque');
    expect(body).toContain('opacity: 0.96');
    expect(body).toContain('background: #000');
  });
});

describe('演出ホルダーの DOM 順(MonitorView の JSX)', () => {
  it('満杯のクリップ 2 本は不透明カットインより前 = 背面に描かれる', () => {
    const fxClip = view.indexOf('className="fx-clip"');
    const fxStrike = view.indexOf('className="fx-strike"');
    const opaque = view.indexOf('fx-clip fx-clip-opaque');
    const layer = view.indexOf('className="fx-layer"');
    for (const [name, at] of Object.entries({ fxClip, fxStrike, opaque, layer })) {
      expect(at, `${name} が MonitorView.tsx に無い`).toBeGreaterThanOrEqual(0);
    }
    // 並べ替えると満杯の演出がカットインの手前に出て、要望が黙って壊れる。
    expect(fxClip).toBeLessThan(fxStrike);
    expect(fxStrike).toBeLessThan(opaque);
    expect(opaque).toBeLessThan(layer);
  });

  it('クリップ 3 種は .monitor-root 直下(fx-layer の中に入れない)', () => {
    // fx-layer の中に入れると z-index:50 のスタッキングコンテキストに閉じ込められ、
    // screen 合成の相手が UI 全体でなくなる(= 黒い矩形)。JSX 上は
    // .fx-layer の開始タグより前にあることが「直下」の機械的な証拠。
    const layer = view.indexOf('<div className="fx-layer">');
    expect(layer).toBeGreaterThanOrEqual(0);
    expect(view.lastIndexOf('className="fx-clip"')).toBeLessThan(layer);
    expect(view.lastIndexOf('className="fx-strike"')).toBeLessThan(layer);
    expect(view.lastIndexOf('fx-clip fx-clip-opaque')).toBeLessThan(layer);
  });
});
