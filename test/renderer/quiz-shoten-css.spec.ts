import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { QUIZ_SPIN_BEATS } from '@shared/challenge';
import {
  QUIZ_FIT_LANDSCAPE,
  QUIZ_FIT_PORTRAIT,
  QUIZ_PAD,
  quizBoxPx,
  quizTwoLineH,
  type QuizFitWhere,
} from '@shared/quiz-fit';

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

  /**
   * 2026-08-23 に足した静止拍。**当選を掴んだまま 1.4 秒止まる**見得で、
   * ここが「決定したお題と発表が違う」の修正の見える側(quiz-spin.spec が算術を凍結)。
   */
  it('静止拍(settle)の見得が CSS にある — 当選の札が金にロックする', () => {
    expect(quizCss).toContain('.quiz-screen.qz-settle .qz-prompt');
    expect(quizCss).toContain('@keyframes qz-settle');
  });
});

describe('役物(緞帳・提灯)の置き場所', () => {
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

  /**
   * 2026-08-23 ユーザー指定で座布団を撤去した(「下の3つが並んでいるのでいらない」)。
   * 点数にも票数にも紐づかない飾りでありながら、画面下部 160px を占めて
   * 本文の枠(QUIZ_FIT_*.reveal の maxH)を削っていた。
   * **戻すなら maxH の再計算とセット**なので、両方をここで凍結する。
   */
  it('座布団は出さない(撤去済み — 決定の本文の枠を削っていた)', () => {
    // JSX の要素として出ていないこと。撤去の経緯コメントに class 名が
    // 出てくるので、**属性の形**(className="qz-zabuton")で引く。
    expect(view).not.toContain('className="qz-zabuton"');
    // CSS の実体も残っていないこと(セレクタが1本も無い)。
    expect(quizCss).not.toMatch(/^\.[^\n]*qz-zabuton/m);
    // 決定の本文枠は回転と**完全に同じ**(座布団を避ける必要が無くなった上に、
    // 連続する2画面で札の外形が変わらないようにするため)。
    expect(QUIZ_FIT_PORTRAIT.reveal).toEqual(QUIZ_FIT_PORTRAIT.spin);
    expect(QUIZ_FIT_LANDSCAPE.reveal).toEqual(QUIZ_FIT_LANDSCAPE.spin);
  });

  /**
   * 2026-08-23: 提灯は position:absolute で本文の外に居るが、見出しを大きくすると
   * 上下中央寄せの中身が伸びてぶつかる。上余白で「高座の下だけ使う」形にした。
   * padding-top の式と提灯の高さは**対で効いている** — 片方だけ動かさないこと。
   */
  it('提灯ぶんの上余白を .quiz-screen が持つ(見出しの拡大と衝突させない)', () => {
    expect(quizCss).toContain('padding: calc(24px + 68px * var(--qz-deco)) 20px 0;');
    expect(quizCss).toContain('height: calc(68px * var(--qz-deco));');
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
    // 2026-08-23 の拡大倍率も quiz 節に閉じる(tokens.css は全画面が連動する)。
    for (const t of ['--qz-scale', '--qz-head', '--qz-num', '--qz-deco']) {
      expect(tokens, `${t} が tokens.css へ漏れている`).not.toContain(t);
      expect(quizCss, `${t} が quiz 節に無い`).toContain(t);
    }
  });

  it('毛筆フォントは同梱前でも OS の明朝へ落ちる(font-src は self のみ)', () => {
    expect(quizCss).toMatch(/--qz-brush:[^;]*'Yu Mincho'/);
    expect(quizCss).toMatch(/--qz-mincho:[^;]*serif/);
  });
});

/**
 * 札の外形は文字数に依存しない(2026-08-22 ユーザー指摘の再発防止)。
 *
 * 壊れ方は2つあり、どちらも「テストは緑なのに配信で札が暴れる」形で出る:
 *  (a) MonitorView がインラインの width/height を渡さなくなる
 *      → 親が align-items:center なので札が中身に追従して伸縮する
 *  (b) CSS の padding を直して quiz-fit.ts の QUIZ_PAD を直し忘れる
 *      → 外形と内寸(組版に渡す maxW/maxH)がズレて、文字がはみ出すか余る
 */
describe('札の外形は固定(文字数で変わらない)', () => {
  const BOXED: QuizFitWhere[] = ['spin', 'reveal', 'prep', 'window', 'vote', 'settle'];

  it('本文6箇所すべてがインラインで外形(width/height)を受け取る', () => {
    for (const where of BOXED) {
      expect(view, `${where} に quizBoxStyle が当たっていない`).toContain(
        `...quizBoxStyle('${where}', landscape)`
      );
    }
    // 見出し札も同様(画面ごとに文字数が違うので幅を内容任せにできない)。
    expect(view).toContain('style={{ width: quizLabelWidthPx(landscape) }}');
  });

  it('外形 = 内寸 + padding(quiz-fit.ts の導出が自己整合)', () => {
    for (const landscape of [false, true]) {
      const fit = landscape ? QUIZ_FIT_LANDSCAPE : QUIZ_FIT_PORTRAIT;
      for (const where of BOXED) {
        const pad = QUIZ_PAD[where];
        const box = quizBoxPx(where, landscape);
        expect(box.w).toBe(fit[where].maxW + pad.x * 2);
        expect(box.h).toBe(fit[where].maxH + pad.top + pad.bottom);
      }
    }
  });

  it('★内寸の高さは「maxPx の2行分」(ユーザー決定そのものの凍結)', () => {
    for (const fit of [QUIZ_FIT_PORTRAIT, QUIZ_FIT_LANDSCAPE]) {
      for (const where of BOXED) {
        const o = fit[where];
        expect(o.maxH, `${where} の maxH が2行分でない`).toBe(quizTwoLineH(o.maxPx, o.lineHeight));
      }
    }
  });

  it('CSS の padding と QUIZ_PAD が一致している(二重管理の見張り)', () => {
    const padOf = (selector: string): string => {
      const at = quizCss.indexOf(selector);
      expect(at, `${selector} が見つからない`).toBeGreaterThan(-1);
      const m = /padding: (\d+)px (\d+)px (\d+)px;/.exec(quizCss.slice(at, at + 400));
      expect(m, `${selector} の padding が3値の px 指定でない`).not.toBeNull();
      return m ? `${m[1]}/${m[2]}/${m[3]}` : '';
    };
    const expected = (where: QuizFitWhere): string =>
      `${QUIZ_PAD[where].top}/${QUIZ_PAD[where].x}/${QUIZ_PAD[where].bottom}`;
    expect(padOf('.quiz-screen .qz-prompt {')).toBe(expected('spin'));
    expect(padOf('.quiz-window-overlay .qw-prompt {')).toBe(expected('window'));
    expect(padOf('.quiz-vote-overlay .qv-prompt {')).toBe(expected('vote'));
    expect(padOf('.quiz-settle .qs-prompt {')).toBe(expected('settle'));
  });

  it('上下中央寄せに flex/grid を使わない(本文の折返しが死ぬ)', () => {
    // 匿名 flex アイテムになると overflow-wrap: anywhere が効かず、長いお題が
    // 1行のまま札からはみ出す。ブロックのまま align-content で寄せること。
    for (const sel of [
      '.quiz-screen .qz-prompt {',
      '.quiz-window-overlay .qw-prompt {',
      '.quiz-vote-overlay .qv-prompt {',
      '.quiz-settle .qs-prompt {',
    ]) {
      const at = quizCss.indexOf(sel);
      // ブロックの閉じ括弧まで(固定長で切ると次の規則の display:flex を拾う)。
      const body = quizCss.slice(at, quizCss.indexOf(String.fromCharCode(10) + String.fromCharCode(125), at));
      expect(body, `${sel} に align-content が無い`).toContain('align-content: center;');
      expect(body, `${sel} が flex/grid になっている`).not.toMatch(/display: (flex|grid);/);
    }
  });

  /**
   * 札の高さを増やすと下の要素が画面外へ押し出される。特に**横の準備画面**が
   * 一番苦しい(見出しが --qz-head 2 倍で 126px あるため)。実測で詰めた値を
   * 机上でも見張っておく — はみ出しは配信中に初めて気付く類の事故なので。
   */
  it('画面ごとの縦合計がステージ高に収まる(横の準備が最も苦しい)', () => {
    // 係数は **capturePage の実測から起こした値**(2026-08-22)。
    // 縦: 見出し 81px / 残り秒 115px、横: 見出し 146px / 残り秒 138px。
    // .quiz-screen の上余白 = 24 + 68 * --qz-deco(縦 1.3 / 横 1.4)。
    const topPad = (landscape: boolean): number => 24 + 68 * (landscape ? 1.4 : 1.3);
    // 見出し札 = font-size 40 * --qz-head(縦 1.1 / 横 2)× 毛筆の行送り 1.45
    //          + 上下 padding(6 + 9)* --qz-head。
    const label = (landscape: boolean): number => {
      const head = landscape ? 2 : 1.1;
      return 40 * head * 1.45 + (6 + 9) * head;
    };
    for (const landscape of [false, true]) {
      const stage = landscape ? 720 : 960;
      const room = stage - topPad(landscape);
      // 回転・決定: 見出し + gap 20 + 札
      const spin = label(landscape) + 20 + quizBoxPx('spin', landscape).h;
      expect(spin, `spin(${landscape}) がはみ出す`).toBeLessThanOrEqual(room);
      // 準備: 見出し + gap + 札 + gap + 残り秒(font-size 92 * --qz-num。
      // 数字は行送り 1.0 相当で組まれるので実測どおり素の font-size を使う)。
      const num = landscape ? 1.5 : 1.25;
      const prep = label(landscape) + 20 + quizBoxPx('prep', landscape).h + 20 + 92 * num;
      expect(prep, `prep(${landscape}) がはみ出す`).toBeLessThanOrEqual(room);
    }
  });
});
