import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUIZ_SPIN_BEATS } from '@shared/challenge';

/**
 * お題ルーレットの笑点(寄席)風演出の凍結(2026-08-22)。
 *
 * quiz-fx.spec.ts と同じ「ソースを読んで不変条件を固定する」流儀
 * (vitest の environment は 'node' なので MonitorView.tsx を実行できない)。
 * ここが見るのは**和風リニューアルで入った役物と、拍表と CSS の噛み合わせ**だけで、
 * バリア方式・ホールド・DOM 順といった土台側は quiz-fx.spec.ts の担当。
 *
 * 読み口は CRLF を正規化する — Windows CI は CRLF でチェックアウトするので、
 * 素の indexOf('\n…') 系は開発機で緑・タグビルドで赤になる(既知の罠)。
 */

const read = (p: string): string => readFileSync(join(__dirname, p), 'utf8').replaceAll('\r\n', '\n');
const view = read('../../src/renderer/monitor/MonitorView.tsx');
const css = read('../../src/renderer/styles/monitor.css');

/** quiz 節(monitor.css の末尾)。ここから下だけを検査する。 */
const quizCss = css.slice(css.indexOf('お題ルーレット(quiz)'));

describe('緞帳は幕開けの拍(openMs)の内側で開き切る', () => {
  it('.qz-curtain のアニメ尺 <= QUIZ_SPIN_BEATS.openMs', () => {
    // 開き切る前に回転が見えてしまう/開いた後に無駄な間が空く、のどちらも
    // 拍表と CSS がズレた時にだけ起きる。数値は手で二重管理せず機械照合する。
    const m = quizCss.match(/animation:\s*qz-curtain-[lr]\s+(\d+)ms/g);
    expect(m, '.qz-curtain のアニメ宣言が見つからない').not.toBeNull();
    expect(m!.length).toBe(2);
    for (const decl of m!) {
      const ms = Number(/(\d+)ms/.exec(decl)![1]);
      expect(ms, `${decl} が openMs(${QUIZ_SPIN_BEATS.openMs}ms)を超えている`).toBeLessThanOrEqual(
        QUIZ_SPIN_BEATS.openMs
      );
    }
  });

  it('緞帳は左右とも 100% 以上ずれて画面外へ抜ける(端に赤い帯を残さない)', () => {
    for (const name of ['qz-curtain-l', 'qz-curtain-r']) {
      const at = quizCss.indexOf(`@keyframes ${name}`);
      expect(at, `@keyframes ${name} が無い`).toBeGreaterThanOrEqual(0);
      const body = quizCss.slice(at, quizCss.indexOf('}\n', quizCss.indexOf('100%', at)));
      expect(body).toMatch(/translateX\(-?10[0-9]%\)/);
    }
  });
});

describe('焦らしの合図(cue)は CSS と MonitorView の両側に揃っている', () => {
  it('3種の cue クラスが CSS に定義されている', () => {
    for (const cue of ['fake', 'near', 'crawl']) {
      expect(quizCss, `.quiz-screen.qz-${cue} が無い`).toContain(`.quiz-screen.qz-${cue} .qz-prompt`);
    }
  });

  it('MonitorView は cue から className を組み立て、key にも混ぜる', () => {
    // className だけ変えても React は再マウントしないので、key に混ぜないと
    // フェイクストップの見得が一度も再生されない。
    expect(view).toContain('qz-${quizSpin.cue}');
    expect(view).toContain('${quizSpin.cue ?? \'\'}');
  });

  it('cue の効果音は既存スロットの流用(新しい ChallengeSeSlot を作らない)', () => {
    const at = view.indexOf('function startQuizFx(');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, view.indexOf('function finishQuizIntro(', at));
    expect(body).toContain("playSeSlot('roulette-kick')");
    expect(body).toContain("playSeSlot('roulette-near')");
    expect(body).toContain("playSeSlot('roulette-hype')");
  });
});

describe('役物(緞帳・提灯・座布団)の置き場所', () => {
  it('緞帳は回転にだけ出す — 決定や準備に置くと開くアニメが二度目を再生する', () => {
    const spin = view.indexOf('quiz-screen quiz-spin');
    const reveal = view.indexOf('quiz-screen quiz-reveal');
    expect(spin).toBeGreaterThanOrEqual(0);
    expect(reveal).toBeGreaterThan(spin);
    expect(view.slice(spin, reveal)).toContain('qz-curtain');
    // 決定より後ろ(決定・準備・窓・投票・発表)には緞帳を置かない。
    expect(view.slice(reveal)).not.toContain('qz-curtain');
  });

  it('緞帳は本文より DOM 順で後ろ = 手前に描いて幕が開くまで隠す', () => {
    const spin = view.indexOf('quiz-screen quiz-spin');
    const prompt = view.indexOf('className="qz-prompt"', spin);
    const curtain = view.indexOf('qz-curtain', spin);
    const lanterns = view.indexOf('qz-lanterns', spin);
    expect(prompt).toBeGreaterThan(spin);
    expect(curtain).toBeGreaterThan(prompt);
    // 提灯は緞帳よりさらに後ろ = 常に最前。
    expect(lanterns).toBeGreaterThan(curtain);
  });

  it('座布団は決定のときだけ積む(点数には紐づかない飾り)', () => {
    const reveal = view.indexOf('quiz-screen quiz-reveal');
    const prep = view.indexOf('quiz-screen quiz-prep');
    expect(view.slice(reveal, prep)).toContain('qz-zabuton');
    expect(view.slice(prep)).not.toContain('qz-zabuton');
  });
});

describe('お題の文字は shared の純関数が決める(CSS は据わり値)', () => {
  it('本文を出す5箇所すべてがインライン fontSize を持つ', () => {
    for (const where of ['spin', 'reveal', 'prep', 'window', 'vote', 'settle']) {
      expect(view, `${where} に quizFontPx が当たっていない`).toContain(`, '${where}', landscape)`);
    }
  });

  it('CSS の据わり値は残す(関数を通らない経路でも文字が消えない)', () => {
    expect(quizCss).toMatch(/\.quiz-screen \.qz-prompt \{[\s\S]*?font-size: \d+px;/);
  });
});

describe('恒久ルール', () => {
  it('quiz 節は transition を使わない(animation と併用すると消え際が壊れる)', () => {
    // CSS Transitions は「その property が CSS Animation の効果下にあるとき
    // transition の値をカスケードに足さない」— ルーレットの動画で溶かした罠。
    expect(quizCss).not.toMatch(/^\s*transition\s*:/m);
  });

  it('和風トークンは quiz 節のスコープに閉じる(tokens.css を汚さない)', () => {
    const tokens = read('../../src/renderer/styles/tokens.css');
    expect(tokens).not.toContain('--qz-');
    for (const t of ['--qz-washi', '--qz-gold', '--qz-crimson', '--qz-brush', '--qz-mincho']) {
      expect(quizCss, `${t} が quiz 節に無い`).toContain(t);
    }
  });

  it('毛筆フォントは同梱前でも OS の明朝へ落ちる(font-src は self のみ)', () => {
    expect(quizCss).toMatch(/--qz-brush:[^;]*'Yu Mincho'/);
    expect(quizCss).toMatch(/--qz-mincho:[^;]*serif/);
  });
});
