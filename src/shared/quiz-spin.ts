/**
 * お題ルーレットの回転演出(全画面テキストの減速差し替え)のタイムライン決定ロジック。
 *
 * 既存ルーレットのリール(roulette-fx.ts — 150px 固定幅ブロックの CSS アニメ)は
 * 使わない — お題は最長 60 文字の文章で、リールの幾何(ROULETTE_BLOCK_W が着地代数の
 * 唯一の出所)に載らない。代わりに「中央の大テキストを interval で差し替え、終盤ほど
 * 間隔が伸びて当選お題で止まる」方式にする。
 *
 * revolution-settle.ts / boost-settle.ts と同じ判断でここに置く — レンダラのテストが
 * node で書けないので、演出の決定ロジックは shared に置いて凍結する。
 *
 * **アンチリーク**: worker は当選 index(quizPromptIndex)を effect に焼き込み済みで、
 * ここは「見せ方」を決めるだけ。差し替えの並びは常に当選 index で終わるよう逆算する
 * (rouletteStrip が盤面側を回転させるのと同じ発想 — 途中経過から答えは読めない。
 * ただし数式は決定的で、Math.random は使わない — StrictMode の二重レンダーで
 * 振り直されない、が既存規約)。
 */

import { QUIZ_SPIN_MS } from './challenge';

/** 差し替えの回数(開始表示を除く)。お題が1件ならそのまま1回で確定する。 */
export const QUIZ_SPIN_STEPS = 24;

/** 回転の1コマ。atMs は回転開始からのオフセット、show は表示するお題の index。 */
export interface QuizSpinTick {
  atMs: number;
  show: number;
}

/**
 * 回転のコマ列を決める。時刻写像は easeIn(二乗)— コマの**間隔**が序盤は密
 * (数十 ms)、終盤は疎(~500ms)になり「減速して止まる」が出る(easeOut だと
 * 間隔が縮む = 加速して止まる、になるので逆)。最後のコマは必ず
 * show === winnerIndex・atMs ≧ totalMs(丸めの単調化で数 ms 出ることがある。
 * 呼び出し側はこのコマの後に決定表示へ遷移する)。
 *
 * 表示列は winnerIndex から逆算した連番の巡回 — 全お題が最低1回は流れる
 * (count > STEPS のときは飛び飛びになるが、上限 QUIZ_PROMPTS_MAX=50 < 2×STEPS
 * なので実用上ほぼ全件見える)。
 */
export function quizSpinTicks(
  promptCount: number,
  winnerIndex: number,
  totalMs: number = QUIZ_SPIN_MS
): QuizSpinTick[] {
  const count = Math.max(1, Math.floor(promptCount));
  const winner = Math.min(count - 1, Math.max(0, Math.floor(winnerIndex)));
  if (count === 1) return [{ atMs: Math.max(0, Math.floor(totalMs)), show: winner }];
  const n = QUIZ_SPIN_STEPS;
  const out: QuizSpinTick[] = [];
  let prev = -1;
  for (let i = 1; i <= n; i++) {
    const p = i / n;
    const eased = p * p;
    // 単調増加を強制(丸めで同時刻に潰れたコマは1msずらす — setTimeout の発火順を
    // コードの並びに依存させない)。
    const atMs = Math.max(prev + 1, Math.round(totalMs * eased));
    prev = atMs;
    const show = (((winner - (n - i)) % count) + count) % count;
    out.push({ atMs, show });
  }
  // 丸め・単調化で最後のコマが totalMs を超えないよう締め直す(show は winner のまま)。
  const last = out[out.length - 1]!;
  last.atMs = Math.max(last.atMs, Math.floor(totalMs));
  return out;
}
