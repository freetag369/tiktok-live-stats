/**
 * ルーレット中のカウント小窓(.count-mirror)の**構造**の凍結。
 *
 * 症状: ルーレット走行中、7セグ本体(.countdown)は grid の通常フロー・z-index
 * なしなので、.fx-layer(z-index:50)の中の .roulette-screen(rgba(5,3,10,.8))に
 * 必ず沈む = 実効 20%。ultra の .rl-clip(opacity .96)が出ている約 31 秒は完全に
 * 不可視。かといって .countdown を手前へ上げると、同じ中央帯を取り合う盤面が
 * 数字に隠れて逆効果になる。
 *
 * 解: 「手前に出す」ではなく「場所を分ける」。fx-layer の中・DOM 順で
 * .roulette-screen より後ろに小窓を置く(.fx-stock / .boost-overlay と同じ手口)。
 *
 * ここで見張るのは、効き目を作っている 4 点:
 *  (a) JSX の DOM 順 — これが逆転すると暗幕の下に戻り、症状が黙って再発する。
 *  (b) z-index を持たないこと — 足すと .monitor-root 直下の mix-blend が壊れる。
 *  (c) 縦 540px での幾何 — .fx-stock と重ならないことを**算術で**確かめる。
 *  (d) 横長の詳細度上書き — 無いと 1 桁 168px に膨らんで小窓が破裂する。
 *
 * 【CRLF】Windows の CI は CRLF でチェックアウトする。開発機と ubuntu で緑でも
 * タグビルドだけ落ちるのを避けるため、読み口で必ず改行を正規化する。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

function read(rel: string): string {
  return readFileSync(join(__dirname, '..', '..', rel), 'utf8').replace(/\r\n/g, '\n');
}

const css = read('src/renderer/styles/monitor.css');
const view = read('src/renderer/monitor/MonitorView.tsx');

/** `<selector> { ... }` の本文。入れ子を含まない素のルール専用(fx-backdrop.spec と同じ)。 */
function ruleBody(selector: string): string {
  const head = `${selector} {`;
  const at = css.indexOf(head);
  expect(at, `${selector} が monitor.css に無い`).toBeGreaterThanOrEqual(0);
  const start = at + head.length;
  const end = css.indexOf('}', start);
  expect(end, `${selector} のルールが閉じていない`).toBeGreaterThan(start);
  return css.slice(start, end);
}

/** `@keyframes <name> { ... }` の本文。中に入れ子の `{}` があるので括弧を数える。 */
function keyframesBody(name: string): string {
  const head = `@keyframes ${name} {`;
  const at = css.indexOf(head);
  expect(at, `@keyframes ${name} が monitor.css に無い`).toBeGreaterThanOrEqual(0);
  let depth = 1;
  let i = at + head.length;
  const start = i;
  while (i < css.length && depth > 0) {
    if (css[i] === '{') depth += 1;
    else if (css[i] === '}') depth -= 1;
    i += 1;
  }
  expect(depth, `@keyframes ${name} が閉じていない`).toBe(0);
  return css.slice(start, i - 1);
}

/** `<prop>: <n>px` を数値で拾う。無ければ null。 */
function px(body: string, prop: string): number | null {
  const m = new RegExp(`(?:^|[;{\\s])${prop}\\s*:\\s*(-?\\d+(?:\\.\\d+)?)px`).exec(body);
  return m ? Number(m[1]) : null;
}

describe('小窓の DOM 順(MonitorView の JSX)', () => {
  it('fx-layer < ルーレット暗幕 < 確定バナー < 小窓 の順に並ぶ', () => {
    // **この順序が効き目の全て**。小窓を .roulette-screen より前へ動かすと
    // 暗幕(と ultra の全面動画)の下に戻り、「回すと数字が見えない」が再発する。
    // .floats より後ろなのは「残数は一次情報なので何があっても読める」という
    // ユーザー決定(2026-08-18)— 演出ストックが常に最前という従来要件より上。
    const layer = view.indexOf('<div className="fx-layer">');
    const screen = view.indexOf('className={rouletteScreenClass(');
    const floats = view.indexOf('className="floats"');
    const mirror = view.indexOf('className={`${mirrorCls}');
    for (const [name, at] of Object.entries({ layer, screen, floats, mirror })) {
      expect(at, `${name} が MonitorView.tsx に無い`).toBeGreaterThanOrEqual(0);
    }
    expect(layer).toBeLessThan(screen);
    expect(screen).toBeLessThan(floats);
    expect(floats).toBeLessThan(mirror);
  });

  it('小窓は本体と同じ表示値を出す(据え置き中の押下追従がそのまま乗る)', () => {
    // shownValue = heldValue ?? challenge.value。ここを challenge.value に
    // 変えると、走行中のタップで数字が動かなくなる(恒久ルール違反)。
    expect(view).toMatch(/<SevenSeg value=\{shownValue\} digits=\{digits\} \/>[\s\S]{0,80}<\/div>\s*\) : null\}/);
  });

  it('規則は countMirrorClass から作る(本体と二重管理にしない)', () => {
    expect(view).toMatch(/const mirrorCls = countMirrorClass\(/);
    // segCls の行を触ると seg-class.spec の配線検査の抽出範囲が変わる。
    expect(view.indexOf('const segCls = countdownClass(')).toBeLessThan(
      view.indexOf('const mirrorCls = countMirrorClass('),
    );
  });

  it('設定 off で出さない / large で lg が付く', () => {
    // 出現条件は mirrorOn 1本(革命の残り時間ピルが同じ変数を見て位置を切り替える —
    // ここを JSX へ直書きに戻すと、ピルだけ小窓と食い違って重なる)。
    expect(view).toMatch(/const mirrorOn = roulette && countView !== 'off';/);
    expect(view).toMatch(/\{mirrorOn \? \(/);
    expect(view).toMatch(/countView === 'large' \? ' lg' : ''/);
  });
});

describe('小窓の CSS', () => {
  const body = ruleBody('.count-mirror');

  it('z-index を持たない(重なり順は DOM 順が決める)', () => {
    // 足すと .monitor-root 直下の mix-blend-mode: screen の合成相手が変わり、
    // UI が黒い矩形で覆われる(fx-backdrop.spec.ts と同じ罠)。
    expect(body).not.toContain('z-index');
  });

  it('絶対配置で左下に置く', () => {
    expect(body).toContain('position: absolute');
    expect(px(body, 'left')).not.toBeNull();
    expect(px(body, 'bottom')).not.toBeNull();
  });

  it('縦ステージで演出ストックと重ならない(left と right の両指定で幅を断つ)', () => {
    // .fx-stock は right/width 固定。ルーレット中は必ず playing 行が 1 行以上出る
    // (startRoulette が playingFx を立てて refreshFxStock する)ので、
    // left だけの shrink-to-fit では 4 桁で必ず食い込む。
    const stage = /const STAGE_W = (\d+);/.exec(view);
    expect(stage, 'STAGE_W が MonitorView.tsx に無い').not.toBeNull();
    const stageW = Number(stage![1]);

    const stock = ruleBody('.fx-stock');
    const stockRight = px(stock, 'right');
    const stockWidth = px(stock, 'width');
    expect(stockRight, '.fx-stock の right が px で読めない').not.toBeNull();
    expect(stockWidth, '.fx-stock の width が px で読めない').not.toBeNull();

    const mirrorRight = px(body, 'right');
    expect(mirrorRight, '.count-mirror の right が px で読めない').not.toBeNull();

    const mirrorRightEdge = stageW - mirrorRight!;
    const stockLeftEdge = stageW - stockRight! - stockWidth!;
    expect(
      mirrorRightEdge,
      `小窓の右端 ${mirrorRightEdge}px がストックの左端 ${stockLeftEdge}px を越えている`,
    ).toBeLessThanOrEqual(stockLeftEdge);
  });

  it('残数わずかは枠の色だけ振る(数字の opacity は落とさない)', () => {
    // 本体の lowblink-row(1↔0.45)を真似ると、暗幕の 20% と掛かって実効 9% まで
    // 落ちる — それが今回の症状の追い打ちだった。
    expect(keyframesBody('cm-ring')).not.toContain('opacity');
  });

  it('.low は animation を差し替えない(色の変数だけ振る)', () => {
    // animation-name のリストが変わると cm-in が再発火し、残り 10→9 をまたいだ
    // まさにその瞬間(押下追従で数字が動く瞬間)に小窓が消えて滑り込み直す。
    expect(ruleBody('.count-mirror.low')).not.toContain('animation');
  });
});

describe('桁が 0x0 に潰れないための条件(実測で踏んだ罠)', () => {
  // .seg-digit は viewBox だけの SVG で height:auto。**幅が定まらないとアスペクト比
  // から高さを解けず、桁が 0x0 に潰れる**。本体側が無事なのは .seg-row が
  // width:100%(定幅)だから。小窓では flex-basis 0 で同じ状況を作っている。
  it('小窓の .seg-row は flex-basis 0(= 残り幅を丸ごと受け取る定幅)', () => {
    const row = ruleBody('.count-mirror .seg-row');
    expect(row).toMatch(/flex:\s*1\s+1\s+0/);
    expect(row).toContain('min-width: 0');
  });

  it('桁は shrink 可のまま(枠に対して比率を保って痩せる)', () => {
    expect(ruleBody('.count-mirror .seg-digit')).toMatch(/flex:\s*0\s+1\s+\d+px/);
  });

  it('小窓の幅は縦横どちらでも確定している(shrink の分配元が要る)', () => {
    // 縦は left+right、横は width。どちらも外して shrink-to-fit にすると
    // flex-basis 0 の分配元が無くなり、桁がまた潰れる。
    expect(px(ruleBody('.count-mirror'), 'right')).not.toBeNull();
    const land = ruleBody('.stage-scale.landscape .count-mirror');
    expect(land).toContain('right: auto');
    expect(px(land, 'width'), '横長の .count-mirror に width が要る').not.toBeNull();
    expect(
      px(ruleBody('.stage-scale.landscape .count-mirror.lg'), 'width'),
      '横長の .count-mirror.lg に width が要る',
    ).not.toBeNull();
  });
});

describe('横ステージの詳細度上書き', () => {
  it('landscape の 7セグ規則を小窓の中で打ち消す', () => {
    // .stage-scale.landscape .seg-digit(max-height:100%)/ .seg-row(height:100%)は
    // (0,3,0)。.count-mirror .seg-digit は (0,2,0) なので負けて本体の寸法に
    // 引きずられる。(0,4,0) で明示上書きする。
    expect(css).toContain('.stage-scale.landscape .count-mirror .seg-digit {');
    expect(css).toContain('.stage-scale.landscape .count-mirror .seg-row {');
  });
});

describe('革命の残り時間ピル(.revolution-timer)は小窓と場所を取り合わない', () => {
  it('z-index を持たない(小窓と同じ理由)', () => {
    expect(ruleBody('.revolution-timer')).not.toContain('z-index');
  });

  it('横ステージでは小窓の右端より右に置く', () => {
    // 小窓は left:14 / width:460(横長上書き)。ピルの left がその右端より小さいと
    // 残数の桁の上に文字が乗る。.count-mirror の幅を変えたらここが落ちる。
    const mirror = ruleBody('.stage-scale.landscape .count-mirror');
    const width = px(mirror, 'width');
    const left = px(ruleBody('.count-mirror'), 'left');
    const pill = px(ruleBody('.stage-scale.landscape .revolution-timer.at-mirror'), 'left');
    expect(width, '横長の .count-mirror の width が px で読めない').not.toBeNull();
    expect(left, '.count-mirror の left が px で読めない').not.toBeNull();
    expect(pill, 'ピルの left が px で読めない').not.toBeNull();
    expect(pill!, `ピルの left ${pill}px が小窓の右端 ${left! + width!}px に食い込んでいる`).toBeGreaterThanOrEqual(
      left! + width!,
    );
  });

  it('横ステージで演出ストックと重ならない(ピルの左端 < ストックの左端)', () => {
    const stage = /const STAGE_LW = (\d+);/.exec(view);
    expect(stage, 'STAGE_LW が MonitorView.tsx に無い').not.toBeNull();
    const stock = ruleBody('.fx-stock');
    const stockLeftEdge = Number(stage![1]) - px(stock, 'right')! - px(stock, 'width')!;
    const pill = px(ruleBody('.stage-scale.landscape .revolution-timer.at-mirror'), 'left')!;
    expect(pill).toBeLessThan(stockLeftEdge);
  });

  it('縦ステージでは右へ逃がさず小窓の真上へ置く', () => {
    // 縦は小窓(right:258)とストック(left端 296)の隙間が 14px しかないので、
    // 右隣に置く余地は無い。left は据え置き、bottom で小窓を跨ぐ。
    const body = ruleBody('.revolution-timer.at-mirror');
    expect(px(body, 'left')).toBe(px(ruleBody('.count-mirror'), 'left'));
    const bottom = px(body, 'bottom');
    expect(bottom, 'ピルの bottom が px で読めない').not.toBeNull();
    expect(bottom!, 'ピルが小窓(bottom:12)に重なっている').toBeGreaterThan(px(ruleBody('.count-mirror'), 'bottom')!);
  });
});
