import type { QuizFitOpts } from './quiz-type';

/**
 * お題ルーレットの「札」の実寸と、その中に入る本文の組版条件。
 *
 * **この2つを1か所に置くのが要点。** 以前は MonitorView にローカル定数として
 * `maxW`(= CSS の max-width − padding×2 の手写し)と `maxH`(= ステージ高から
 * 見出し・タイマー・提灯を引いた**机上の残り**)だけがあり、後者はどの CSS 宣言にも
 * 対応していなかった。札は `width` / `height` を持たず `max-width` だけだったので、
 * 実際の外形は**中身に追従して伸縮**していた(親が align-items:center なので
 * shrink-to-fit)。本文の font-size 自体も文字数から逆算されるため、
 * 「文字数 → 文字サイズ → 札の縦横」と二段で効き、回転中は候補が入れ替わるたびに
 * 札が毎コマ暴れていた。
 *
 * 2026-08-22 のユーザー決定で **札の外形は固定**になった:
 * - 外形 = `quizBoxPx()` が返す w×h。MonitorView がインライン style で当てる
 *   (font-size と同じ流儀。CSS の max-width は据わり値として残す)。
 * - 内寸 = `maxW` × `maxH`。**`maxH` は「maxPx の2行分」**で、ここが札の高さの根拠。
 * - 長いお題は `quizPromptFontPx` が行数を増やして字を小さくするので、必ず収まる。
 *
 * CSS(monitor.css の quiz 節)を直すときは **`QUIZ_PAD` を必ず一緒に直すこと**。
 * 対応は test/renderer/quiz-shoten-css.spec.ts が機械照合している。
 */

/** 本文を出す場所。CSS のクラスと1対1(announce だけ札ではなく素の数字)。 */
export type QuizFitWhere = 'announce' | 'spin' | 'reveal' | 'prep' | 'window' | 'vote' | 'settle';

/** 札の padding(CSS の写し)。上下は縦の外形、左右は横の外形に効く。 */
export interface QuizPad {
  /** CSS の padding-top。 */
  top: number;
  /** CSS の padding-left / right(左右同値)。 */
  x: number;
  /** CSS の padding-bottom(視覚重心を上げるため top より大きい札がある)。 */
  bottom: number;
}

/**
 * padding は縦横で共通(倍率トークンを掛けていないため)。
 * announce だけ札を持たない(`.qz-th-num` は素の数字)ので 0。
 */
export const QUIZ_PAD: Record<QuizFitWhere, QuizPad> = {
  // .qz-th-num は padding を持たない(金屏風の上に直接置く数字)。
  announce: { top: 0, x: 0, bottom: 0 },
  // .quiz-screen .qz-prompt — 回転・決定・準備で共用。
  spin: { top: 26, x: 24, bottom: 30 },
  reveal: { top: 26, x: 24, bottom: 30 },
  prep: { top: 26, x: 24, bottom: 30 },
  // .quiz-window-overlay .qw-prompt
  window: { top: 18, x: 22, bottom: 22 },
  // .quiz-vote-overlay .qv-prompt
  vote: { top: 10, x: 18, bottom: 13 },
  // .quiz-settle .qs-prompt
  settle: { top: 9, x: 18, bottom: 12 },
};

/** 「2行分」の内寸を出す。maxH の唯一の根拠(小数は切り上げ)。 */
export function quizTwoLineH(maxPx: number, lineHeight: number): number {
  return Math.ceil(2 * maxPx * lineHeight);
}

/**
 * 縦ステージ(540×960)。
 *
 * `maxW` は札の外形 − padding×2:
 * - 回転/決定/準備: 500 − 24×2 = 452
 * - 挑戦中: 500 − 22×2 = 456
 * - 投票/結果: 500 − 18×2 = 464
 *
 * **回転と決定は同じ maxPx**(140)にしてある — 連続する2画面で札の外形が変わると
 * 「文字数で変わる」のと同じ不快さが出るため。準備だけは下に残り秒があるので小さい。
 */
export const QUIZ_FIT_PORTRAIT: Record<QuizFitWhere, QuizFitOpts> = {
  // 告知は札を持たない(数字だけ)ので、従来どおり画面の余白いっぱいを予算にする。
  // maxPx は「桁区切り 6〜7 文字が1行に収まる」上限(452 × 0.98 / 3em ≒ 147)。
  announce: { maxW: 452, maxH: 430, maxPx: 146, minPx: 40, lineHeight: 1.1 },
  spin: { maxW: 452, maxH: quizTwoLineH(140, 1.18), maxPx: 140, minPx: 30, lineHeight: 1.18 },
  reveal: { maxW: 452, maxH: quizTwoLineH(140, 1.18), maxPx: 140, minPx: 30, lineHeight: 1.18 },
  prep: { maxW: 452, maxH: quizTwoLineH(112, 1.18), maxPx: 112, minPx: 26, lineHeight: 1.18 },
  window: { maxW: 456, maxH: quizTwoLineH(116, 1.18), maxPx: 116, minPx: 26, lineHeight: 1.18 },
  vote: { maxW: 464, maxH: quizTwoLineH(86, 1.2), maxPx: 86, minPx: 22, lineHeight: 1.2 },
  settle: { maxW: 464, maxH: quizTwoLineH(64, 1.2), maxPx: 64, minPx: 20, lineHeight: 1.2 },
};

/**
 * 横ステージ(1280×720)。**縦より上下が苦しい** — 特に準備は
 * 見出し(126)+ gap 20 + 札 + gap 20 + 残り秒(166)が 600.8px(720 − 上余白)に
 * 収まる必要があり、札は 268px が上限。maxPx 88 の2行 = 264px で収めてある。
 */
export const QUIZ_FIT_LANDSCAPE: Record<QuizFitWhere, QuizFitOpts> = {
  announce: { maxW: 1032, maxH: 230, maxPx: 150, minPx: 36, lineHeight: 1.1 },
  spin: { maxW: 1032, maxH: quizTwoLineH(112, 1.18), maxPx: 112, minPx: 26, lineHeight: 1.18 },
  reveal: { maxW: 1032, maxH: quizTwoLineH(112, 1.18), maxPx: 112, minPx: 26, lineHeight: 1.18 },
  prep: { maxW: 1032, maxH: quizTwoLineH(88, 1.18), maxPx: 88, minPx: 24, lineHeight: 1.18 },
  window: { maxW: 1036, maxH: quizTwoLineH(88, 1.18), maxPx: 88, minPx: 24, lineHeight: 1.18 },
  vote: { maxW: 964, maxH: quizTwoLineH(64, 1.2), maxPx: 64, minPx: 20, lineHeight: 1.2 },
  settle: { maxW: 964, maxH: quizTwoLineH(52, 1.2), maxPx: 52, minPx: 20, lineHeight: 1.2 },
};

export function quizFit(where: QuizFitWhere, landscape: boolean): QuizFitOpts {
  return (landscape ? QUIZ_FIT_LANDSCAPE : QUIZ_FIT_PORTRAIT)[where];
}

/** 札の外形(px)。box-sizing:border-box なので padding を含む値。 */
export interface QuizBox {
  w: number;
  h: number;
}

/**
 * 札の外形。**文字数に一切依存しない**のがこの関数の存在理由。
 * MonitorView が `style={{ width, height }}` で当て、CSS の max-width より優先される。
 */
export function quizBoxPx(where: QuizFitWhere, landscape: boolean): QuizBox {
  const fit = quizFit(where, landscape);
  const pad = QUIZ_PAD[where];
  return { w: fit.maxW + pad.x * 2, h: fit.maxH + pad.top + pad.bottom };
}

/**
 * 見出し札(`.qz-label`)の幅。**本文の札と同じ幅に揃える**(2026-08-22 ユーザー決定)
 * — 見出しは画面ごとに文字数が違う(「大喜利」3文字 / 「準備してください」8文字)ので、
 * 幅を内容任せにすると画面が変わるたびに札の外形が動く。
 * 告知(札を持たない画面)も同じ幅の帯にして、金屏風の4画面で見出しの外形を揃える。
 */
export function quizLabelWidthPx(landscape: boolean): number {
  return quizBoxPx('spin', landscape).w;
}
