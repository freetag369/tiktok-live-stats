import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * <video> ホルダーのメディアプール規律(armVideoPlay / armClipPlay)。
 *
 * モニターは演出のたびに key 再マウントで <video> を作り捨てる設計なので、
 * (1) 解放: ref cleanup の pause + removeAttribute('src') + load が無いと
 *     Chromium のレンダラ毎メディアプレイヤ上限に達し、play() が reject し始めて
 *     時間が経つと演出動画だけ出なくなる(diag.log の「play() が拒否された」)。
 * (2) 失敗の接続: autoplay の失敗は promise の reject としてしか現れない
 *     (error イベントは出ない)ので、全ホルダーが arm 経由で各層の finisher へ
 *     落とすこと — 放置すると尺いっぱい黒画面のまま固着する。
 * (3) 取り壊しガード: cleanup の pause()/load() は pending の play() を
 *     AbortError で落とす。旧要素からの遅延 reject をそのまま finisher へ流すと、
 *     band の反復2発目・boost のフェーズ遷移・ultra の後続ウィンドウを
 *     巻き添えで畳む — catch は「まだ DOM にいる要素」の拒否だけを本物と扱う。
 *
 * fx-stage.spec.ts の「ソース不変条件」と同型(レンダラのテスト環境が無いための
 * 機械的な担保)。
 */

const MONITOR = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8').replace(/\r\n/g, '\n');
const ROULETTE = readFileSync(resolve('src/renderer/monitor/RouletteFx.tsx'), 'utf8').replace(/\r\n/g, '\n');

/** コンポーネント直下(2スペースインデント)の関数本文を切り出す。 */
function fnBody(src: string, name: string): string {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\r?\\n {2}\\}`));
  expect(m, `${name} が見つからない`).toBeTruthy();
  return m![0];
}

/** JSX の <video> 開きタグ(行末が <video)だけを数える — コメント中の <video> は拾わない。 */
function videoTags(src: string): number {
  return [...src.matchAll(/<video$/gm)].length;
}

describe('MonitorView の <video> ホルダー(ソース不変条件)', () => {
  it('全ホルダーが armVideoPlay を通る(<video> の数と呼び出しが 1:1)', () => {
    const labels = [...MONITOR.matchAll(/armVideoPlay\(v, '([^']+)'/g)].map((m) => m[1]);
    expect(videoTags(MONITOR)).toBe(labels.length);
    // ラベルは diag.log の識別子。ホルダーを増減したらこの一覧も更新すること。
    expect(labels.sort()).toEqual(
      ['band-cutin', 'boost-cutin', 'fx-clip', 'fx-strike', 'revolution-cutin', 'rl-hot-intro', 'stock-cutin'].sort()
    );
  });

  it('ref は armVideoPlay の cleanup を返す(返さないと解放が走らない)', () => {
    // 式体の `=>` か明示 `return` のどちらか。素の文として呼ぶと React 19 の
    // ref cleanup に乗らず、メディアプレイヤが GC 任せで漏れる。
    const wired = [...MONITOR.matchAll(/(?:=>\s*|return )armVideoPlay\(v,/g)].length;
    expect(wired).toBe([...MONITOR.matchAll(/armVideoPlay\(v,/g)].length);
  });

  it('<video> は必ず key 再マウント(src 張り替えの再利用は arm ガードと衝突する)', () => {
    expect([...MONITOR.matchAll(/<video\r?\n\s*key=\{/g)].length).toBe(videoTags(MONITOR));
  });

  it('cleanup は「DOM から外れた要素」だけを pause + src 除去 + load で解放する', () => {
    const fn = fnBody(MONITOR, 'armVideoPlay');
    const micro = fn.indexOf('queueMicrotask');
    const guard = fn.indexOf('if (v.isConnected) return;');
    const pause = fn.indexOf('v.pause();');
    const rmSrc = fn.indexOf("v.removeAttribute('src');");
    const load = fn.indexOf('v.load();');
    for (const at of [micro, guard, pause, rmSrc, load]) expect(at).toBeGreaterThanOrEqual(0);
    // commit 完了待ち → 切断チェック → 解放三点セット、の順。
    expect(micro).toBeLessThan(guard);
    expect(guard).toBeLessThan(pause);
    expect(pause).toBeLessThan(rmSrc);
    expect(rmSrc).toBeLessThan(load);
  });

  it('play() の reject は取り壊し起因(切断済み要素)を握りつぶしてから finisher へ流す', () => {
    const fn = fnBody(MONITOR, 'armVideoPlay');
    const guard = fn.indexOf('if (!v.isConnected) return;');
    const fail = fn.indexOf('onFail();');
    expect(
      guard,
      '取り壊しガードが無い(旧要素の AbortError が現行演出を巻き添えで畳む)'
    ).toBeGreaterThanOrEqual(0);
    expect(fail).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(fail);
  });
});

describe('RouletteFx の <video> ホルダー(armClipPlay — armVideoPlay の意図的な複製)', () => {
  it('ultra のウィンドウは armClipPlay を ref にそのまま渡す(<video> は1つだけ)', () => {
    expect(videoTags(ROULETTE)).toBe(1);
    expect(ROULETTE).toContain('ref={armClipPlay}');
  });

  it('cleanup の解放三点セット(pause + src 除去 + load)と切断チェックを持つ', () => {
    const fn = fnBody(ROULETTE, 'armClipPlay');
    const guard = fn.indexOf('if (v.isConnected) return;');
    const pause = fn.indexOf('v.pause();');
    const rmSrc = fn.indexOf("v.removeAttribute('src');");
    const load = fn.indexOf('v.load();');
    for (const at of [guard, pause, rmSrc, load]) expect(at).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(pause);
    expect(pause).toBeLessThan(rmSrc);
    expect(rmSrc).toBeLessThan(load);
  });

  it('play() の reject は取り壊し起因を握りつぶす(後続ウィンドウの巻き添え防止)', () => {
    const fn = fnBody(ROULETTE, 'armClipPlay');
    const guard = fn.indexOf('if (!v.isConnected) return;');
    const kill = fn.indexOf('setClip(null)');
    expect(guard, '取り壊しガードが無い').toBeGreaterThanOrEqual(0);
    expect(kill).toBeGreaterThanOrEqual(0);
    expect(guard).toBeLessThan(kill);
  });
});
