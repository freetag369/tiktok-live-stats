import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * お題ルーレットのモニター配線の凍結(ソース文字列検査)。
 *
 * vitest は environment:'node' で MonitorView.tsx を実行できないため、
 * fx-video-pool.spec / fx-backdrop.spec と同じ「ソースを読んで不変条件を固定する」
 * 流儀で、壊れると黙って見え方だけが崩れる配線を検査する。
 *
 * 読み口は CRLF を正規化する — Windows CI は CRLF でチェックアウトするので、
 * 素の indexOf('\n…') 系は開発機で緑・タグビルドで赤になる(既知の罠)。
 */

const read = (p: string): string => readFileSync(join(__dirname, p), 'utf8').replaceAll('\r\n', '\n');
const view = read('../../src/renderer/monitor/MonitorView.tsx');
const css = read('../../src/renderer/styles/monitor.css');

describe('バリア方式の配線(armed 監視が唯一の開始入口)', () => {
  it('quiz-start はドレインキューに積まない — pendingQuizStart に預けるだけ', () => {
    // playEffect の case 'quiz-start' が pendingQuizzes.push を含むと、開始が
    // ドレイン順(優先度)で決まってしまい「キュー消化を待つ」ユーザー決定が壊れる。
    const at = view.indexOf("case 'quiz-start': {");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, view.indexOf("case 'quiz-end': {", at));
    expect(body).toContain('pendingQuizStart.current = e;');
    expect(body).not.toContain('pendingQuizzes.current.push');
  });

  it('armed 監視は「空になった」の全条件を見る(fxQueue / boost / revolution / ドレイン / 舞台)', () => {
    const at = view.indexOf('const quizArmed =');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, at + 1600);
    for (const cond of [
      'challenge?.boost != null',
      'challenge?.revolution != null',
      'challenge?.fxFreezeUntilMs != null',
      'challenge?.fxQueue?.length',
      'peekNextDrainKind(drainQueuesView())',
      'anyCutinHold()',
      'stageBusy()',
    ]) {
      expect(body, `armed 監視のゲートに ${cond} が無い`).toContain(cond);
    }
  });

  it('startQuizFx は quizCue{start} を撃つ(実再生開始が窓の原点 — 革命と同じ設計)', () => {
    const at = view.indexOf('function startQuizFx');
    const body = view.slice(at, view.indexOf('function finishQuizIntro'));
    expect(body).toContain("rpc('challenge.quizCue'");
    expect(body).toContain("action: 'start'");
    // ▶実演では撃たない(実発動のアームを試写の時刻でコミットさせない)。
    expect(body).toContain('if (!e.test) {');
  });
});

describe('ホールドの3点セット(漏れると幕の上に粒子・CLEAR が生える既知事故)', () => {
  it('opaqueCutinActive / anyCutinHold に quizHold と quizResultHold が並ぶ', () => {
    for (const fn of ['function opaqueCutinActive', 'function anyCutinHold']) {
      const at = view.indexOf(fn);
      expect(at, `${fn} が無い`).toBeGreaterThanOrEqual(0);
      const body = view.slice(at, view.indexOf('}', view.indexOf('return', at)));
      expect(body, `${fn} に quizHold が無い`).toContain('quizHold.current');
      expect(body, `${fn} に quizResultHold が無い`).toContain('quizResultHold.current');
    }
  });

  it('fxHoldBusy に quiz の最前面 state 4種が並ぶ', () => {
    const at = view.indexOf('const fxHoldBusy =');
    const body = view.slice(at, at + 1600);
    for (const s of ['quizClip !== null', 'quizSpin !== null', 'quizReveal !== null', 'quizSettle !== null']) {
      expect(body, `fxHoldBusy に ${s} が無い`).toContain(s);
    }
  });

  it('番犬が quiz / quizResult を見て既存の締め関数で解除する', () => {
    expect(view).toContain('d.quiz !== 0 && now > d.quiz');
    expect(view).toContain('d.quizResult !== 0 && now > d.quizResult');
  });
});

describe('DOM 順と CSS(z-index 禁止の恒久ルール)', () => {
  it('quiz のオーバーレイは .fx-layer 内・.roulette-screen より後・.floats より前', () => {
    const layer = view.indexOf('className="fx-layer"');
    const roulette = view.indexOf('roulette-screen', layer);
    const spin = view.indexOf('quiz-screen quiz-spin', layer);
    const settle = view.indexOf('quiz-settle', layer);
    const floats = view.indexOf('className="floats"', layer);
    expect(roulette).toBeGreaterThan(layer);
    expect(spin).toBeGreaterThan(roulette);
    expect(settle).toBeGreaterThan(spin);
    expect(floats).toBeGreaterThan(settle);
  });

  it('quiz の CSS 節は z-index を宣言しない(重なり順は DOM 順が決める)', () => {
    const at = css.indexOf('お題ルーレット(quiz)');
    expect(at).toBeGreaterThanOrEqual(0);
    // コメント中の「z-index:50 の中」という説明文は許す — 検査は宣言行だけ。
    expect(css.slice(at)).not.toMatch(/^\s*z-index\s*:/m);
  });

  it('バナー色クラス .float.banner-quiz が定義されている', () => {
    expect(css).toContain('.float.banner-quiz {');
  });

  it('窓・投票のオーバーレイは reduced-motion でも消さない(状態の説明であって演出ではない)', () => {
    const at = css.indexOf('お題ルーレット(quiz)');
    const media = css.indexOf('@media (prefers-reduced-motion: reduce)', at);
    expect(media).toBeGreaterThan(at);
    const body = css.slice(media);
    // display:none で消すのは前置きと発表だけ。
    expect(body).toContain('.quiz-screen,');
    expect(body).toContain('.quiz-settle {');
    expect(body).not.toContain('.quiz-window-overlay {\n    display: none');
    expect(body).not.toContain('.quiz-vote-overlay {\n    display: none');
  });
});
