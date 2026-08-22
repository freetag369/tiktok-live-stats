import { describe, expect, it } from 'vitest';
import { QUIZ_PROMPT_LEN_MAX } from '@shared/challenge';
import { quizPromptFontPx, quizTextWidthEm, type QuizFitOpts } from '@shared/quiz-type';

/**
 * お題の自動組版の凍結。守りたい契約は3つ:
 *   (1) 短いお題は上限に張り付く(= 画面いっぱいになる)
 *   (2) 上限文字数(QUIZ_PROMPT_LEN_MAX)でも**必ず**枠に収まる
 *   (3) 決定的(StrictMode の二重レンダーで字の大きさが振れない)
 */

/** 縦ステージ(540×960)の回転画面。monitor.css の実値と揃えること。 */
const PORTRAIT: QuizFitOpts = {
  maxW: 500,
  maxH: 760,
  maxPx: 150,
  minPx: 28,
  lineHeight: 1.18,
};

/** 横ステージ(1280×720)。幅は広いが高さが足りない。 */
const LANDSCAPE: QuizFitOpts = {
  maxW: 1080,
  maxH: 460,
  maxPx: 120,
  minPx: 24,
  lineHeight: 1.18,
};

/** 関数が使っているのと同じ素朴モデルで「本当に収まるか」を検算する。 */
function layoutFits(text: string, fs: number, o: QuizFitOpts): boolean {
  const perLine = Math.floor((o.maxW * 0.98) / fs);
  if (perLine < 1) return false;
  const lines = text
    .split('\n')
    .reduce((n, seg) => n + Math.max(1, Math.ceil(quizTextWidthEm(seg) / perLine)), 0);
  return lines * fs * o.lineHeight <= o.maxH;
}

describe('quizTextWidthEm', () => {
  it('全角は1・ASCIIと半角カナは0.5で数える', () => {
    expect(quizTextWidthEm('変顔をする')).toBe(5);
    expect(quizTextWidthEm('abcd')).toBe(2);
    expect(quizTextWidthEm('ｱｲｳｴｵ')).toBe(2.5);
    expect(quizTextWidthEm('')).toBe(0);
  });

  it('サロゲートペア(絵文字)は1文字として数える', () => {
    // '😀' は UTF-16 で2要素だが、字としては1つぶんの幅。
    expect(quizTextWidthEm('😀')).toBe(1);
  });
});

describe('quizPromptFontPx', () => {
  it('短いお題は上限に張り付く(画面いっぱい)', () => {
    expect(quizPromptFontPx('変顔をする', PORTRAIT)).toBe(PORTRAIT.maxPx);
    expect(quizPromptFontPx('一発ギャグ', PORTRAIT)).toBe(PORTRAIT.maxPx);
  });

  it('空文字は上限(0除算も行数0も作らない)', () => {
    expect(quizPromptFontPx('', PORTRAIT)).toBe(PORTRAIT.maxPx);
  });

  it('上限文字数(60)でも必ず枠に収まる — 縦・横の両ステージ', () => {
    const long = 'あ'.repeat(QUIZ_PROMPT_LEN_MAX);
    for (const o of [PORTRAIT, LANDSCAPE]) {
      const fs = quizPromptFontPx(long, o);
      expect(fs).toBeGreaterThanOrEqual(o.minPx);
      expect(fs).toBeLessThanOrEqual(o.maxPx);
      expect(layoutFits(long, fs, o), `fs=${fs} が枠からはみ出す`).toBe(true);
    }
  });

  it('長いお題は現行の固定 52px より大きく出せる(この変更の目的)', () => {
    const long = 'あ'.repeat(QUIZ_PROMPT_LEN_MAX);
    expect(quizPromptFontPx(long, PORTRAIT)).toBeGreaterThan(52);
  });

  it('文字数が増えるほど小さくなる(単調に非増加)', () => {
    let prev = Infinity;
    for (const n of [1, 5, 10, 20, 30, 40, 50, 60]) {
      const fs = quizPromptFontPx('あ'.repeat(n), PORTRAIT);
      expect(fs, `${n}文字で前より大きくなった`).toBeLessThanOrEqual(prev);
      prev = fs;
    }
  });

  it('同じ文字数でも英数字のほうが大きく出せる(半角ぶん幅が空く)', () => {
    const jp = quizPromptFontPx('あ'.repeat(40), PORTRAIT);
    const en = quizPromptFontPx('a'.repeat(40), PORTRAIT);
    expect(en).toBeGreaterThan(jp);
  });

  it('改行は行として数える(貼り付けで改行が混ざっても高さを読み違えない)', () => {
    const oneLine = quizPromptFontPx('あああ', PORTRAIT);
    const many = quizPromptFontPx('あ\nあ\nあ\nあ\nあ\nあ\nあ\nあ', PORTRAIT);
    expect(many).toBeLessThan(oneLine);
  });

  it('どうやっても収まらないときは minPx を返す(はみ出しは CSS が切る)', () => {
    const tiny: QuizFitOpts = { maxW: 60, maxH: 40, maxPx: 150, minPx: 28, lineHeight: 1.18 };
    expect(quizPromptFontPx('あ'.repeat(QUIZ_PROMPT_LEN_MAX), tiny)).toBe(28);
  });

  it('決定的 — 同じ入力は同じ値(StrictMode の二重レンダー安全)', () => {
    const s = 'テレビショッピングの名調子で';
    expect(quizPromptFontPx(s, PORTRAIT)).toBe(quizPromptFontPx(s, PORTRAIT));
  });

  it('刻みは stepPx の倍数で maxPx から下りる', () => {
    const fs = quizPromptFontPx('あ'.repeat(30), { ...PORTRAIT, stepPx: 2 });
    expect((PORTRAIT.maxPx - fs) % 2).toBe(0);
  });
});
