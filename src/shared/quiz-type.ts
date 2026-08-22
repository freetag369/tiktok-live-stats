/**
 * お題の文字を「画面いっぱいだが必ず収まる」大きさに決める組版ロジック(2026-08-22)。
 *
 * 【なぜ要るか】モニターは 540×960(横は 1280×720)の固定ステージで、お題本文は
 * CSS の固定 font-size(52px)だった。実際のお題は「変顔をする」のような 5〜10 文字が
 * 大半で、固定サイズだと画面の 1 割ほどしか占めず配信で読めない。かといって一律に
 * 大きくすると上限の 60 文字(QUIZ_PROMPT_LEN_MAX)がステージからはみ出す。
 * → **文字数から font-size を逆算する**のがこの関数。
 *
 * quiz-spin.ts / quiz-settle.ts と同じ判断でここに置く — レンダラのテスト環境が
 * このリポジトリに無いので、演出の決定ロジックは純関数として shared に置き node の
 * vitest で凍結する。**決定的**(Math.random 不使用・同じ入力なら同じ出力)なので、
 * StrictMode の二重レンダーでも字の大きさが振れない。
 *
 * 【CSS 側との約束】ステージはビューポート単位を使わない固定 px 設計なので、
 * ここも px で計算する。呼び出し側は返り値を **インライン style の fontSize** に流し、
 * CSS の font-size 宣言は「関数を通らない経路(reduced-motion 等)の据わり値」として
 * 残す。CSS には clamp() を書かない(monitor.css に clamp は 0 件 — 恒久ルール)。
 */

/**
 * 1 文字の全角換算幅。日本語フォントの全角は 1em ちょうど、ASCII と半角カナは
 * おおむねその半分。プロポーショナルなので実際は 0.4〜0.6em と幅があるが、
 * 平均の 0.5 を採り、はみ出し側には fitWidth の安全率(SAFETY)で余裕を持たせる。
 */
function charWidthEm(code: number): number {
  // ASCII(制御文字を含む)。
  if (code < 0x80) return 0.5;
  // 半角カナ(U+FF61〜U+FF9F)。
  if (code >= 0xff61 && code <= 0xff9f) return 0.5;
  // それ以外(漢字・かな・全角記号・絵文字)は全角として数える。
  return 1;
}

/**
 * 文字列の全角換算幅(em)。改行は含めず、行ごとの幅は quizPromptFontPx が
 * 分割して扱う。テストから直接呼べるよう export する。
 */
export function quizTextWidthEm(text: string): number {
  let w = 0;
  // for...of で回すのはサロゲートペア(絵文字)を 1 文字として数えるため。
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    w += charWidthEm(code);
  }
  return w;
}

/** quizPromptFontPx の入力。すべてステージ座標系の px。 */
export interface QuizFitOpts {
  /** 本文が使える横幅(コンテナ幅 - 左右パディング)。 */
  maxW: number;
  /** 本文が使える高さ(見出し・タイマー等を除いた残り)。 */
  maxH: number;
  /** 上限。ここに張り付くのが「短いお題は画面いっぱい」の状態。 */
  maxPx: number;
  /** 下限。ここまで縮めても収まらなければ諦めてこの値を返す(はみ出しは CSS が切る)。 */
  minPx: number;
  /** CSS の line-height と一致させること。ズレると高さの見積もりが外れる。 */
  lineHeight: number;
  /** 探索の刻み(px)。既定 2 — 1 だと刻みが細かすぎて見た目の差が出ない。 */
  stepPx?: number;
}

/**
 * 横幅の安全率。charWidthEm の 0.5 近似と、フォントごとの字送りの差を吸収する。
 * 1.0 にすると ASCII 混じりの長文がまれに 1 文字はみ出す。
 */
const SAFETY = 0.98;

/**
 * text が maxW×maxH に収まる最大の font-size(px)を返す。
 *
 * 折り返しの見積もりは `overflow-wrap: anywhere`(= どこでも折れる)前提の素朴な
 * モデル: 1 行に入る全角文字数 = floor(maxW / fs)、行数 = ceil(幅 / 1行文字数)。
 * CJK は実際どこでも折れるので、この近似は実レイアウトとよく一致する。
 * 明示的な改行(\n)は行を分ける — 貼り付けで改行が混ざっても高さを読み違えない。
 *
 * 探索は maxPx から stepPx 刻みで下げる**線形探索**。二分探索にしないのは、
 * 「収まる/収まらない」が行数の階段関数で単調とは限らない(fs を下げると 1 行に
 * 入る文字数が増えて行数が飛びで減る)ため — 上から順に見て最初に収まった値が
 * 素直に「一番大きく出せる値」になる。
 */
export function quizPromptFontPx(text: string, o: QuizFitOpts): number {
  const step = Math.max(1, Math.floor(o.stepPx ?? 2));
  const maxPx = Math.max(1, Math.floor(o.maxPx));
  const minPx = Math.max(1, Math.min(maxPx, Math.floor(o.minPx)));
  const lineH = o.lineHeight > 0 ? o.lineHeight : 1.2;
  const usableW = Math.max(1, o.maxW * SAFETY);
  const usableH = Math.max(1, o.maxH);
  // 空文字は上限で返す(0 除算も行数 0 も作らない)。
  const segments = text.split('\n').map((s) => quizTextWidthEm(s));
  if (segments.every((w) => w <= 0)) return maxPx;

  for (let fs = maxPx; fs >= minPx; fs -= step) {
    const perLine = Math.floor(usableW / fs);
    // 1 文字も入らない大きさは論外(次の候補へ)。
    if (perLine < 1) continue;
    let lines = 0;
    for (const w of segments) {
      // 空行も 1 行として数える(改行ぶんの高さは実際に取られる)。
      lines += Math.max(1, Math.ceil(w / perLine));
    }
    if (lines * fs * lineH <= usableH) return fs;
  }
  return minPx;
}
