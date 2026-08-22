/**
 * お題ルーレットの区間別BGM(2026-08-22)の**選曲判断**。
 *
 * quiz-spin.ts / quiz-settle.ts と同じ判断でここに置く — レンダラのテストが node で
 * 書けない(vitest の environment は 'node')ので、演出の決定ロジックは shared に
 * 置いて凍結する。モニター側に残るのは「いつフェーズが変わったか」と
 * 「Audio 要素をどう差し替えるか」だけ。
 *
 * 区間の並び(2026-08-22 ユーザー決定):
 *
 *   ① spin   発動(アーム)〜導入カット〜回転        … QuizConfig.bgm
 *   ② reveal お題発表(決定パンチ表示)              … revealBgm
 *   ★ prep   お題発表準備(prepSec・0でスキップ)     … prepBgm
 *   ③ window お題考え時(挑戦ウィンドウ durationSec) … thinkBgm
 *   ④ vote   コメント受付時(投票タイム voteSec)     … voteBgm
 *   ⑤ outro  終了後(投票締切から outroSec)          … outroDownBgm / outroUpBgm
 *
 * ⑤ だけはフェーズ機械ではなく quiz-end effect の着弾で駆動する(投票締切の瞬間に
 * 鳴らしたいのと、増減の符号で曲が変わるため)。
 */

import { QUIZ_BGM_KEEP } from './challenge';
import type { QuizConfig } from './dto';

/** フェーズ機械が扱う区間(⑤ outro は別経路なので含まない)。 */
export type QuizBgmPhase = 'spin' | 'reveal' | 'prep' | 'window' | 'vote';

/** 鳴らす曲の指定。id === 'off' は「この区間は無音にする」。 */
export interface QuizBgmPick {
  id: string;
  /** 0-100 の絶対音量(seVolume は掛からない — rouletteSound と同じ規約)。 */
  volume: number;
}

/**
 * 区間の曲を決める。`'keep'` を返したら**何もしない**(前の区間の曲がそのまま鳴り続ける)。
 * 呼び出し側で `=== 'keep'` を先に弾くこと — `{ id: 'keep' }` を再生しようとしないため
 * 意図的に別の型にしてある。
 */
export function quizBgmForPhase(cfg: QuizConfig, phase: QuizBgmPhase): QuizBgmPick | 'keep' {
  const [id, volume] = slotOf(cfg, phase);
  return id === QUIZ_BGM_KEEP ? 'keep' : { id, volume };
}

function slotOf(cfg: QuizConfig, phase: QuizBgmPhase): [string, number] {
  switch (phase) {
    // 区間①は先頭なので 'keep' を持たない(validateQuiz が既定へ倒す)。
    case 'spin':
      return [cfg.bgm, cfg.bgmVolume];
    case 'reveal':
      return [cfg.revealBgm, cfg.revealBgmVolume];
    case 'prep':
      return [cfg.prepBgm, cfg.prepBgmVolume];
    case 'window':
      return [cfg.thinkBgm, cfg.thinkBgmVolume];
    case 'vote':
      return [cfg.voteBgm, cfg.voteBgmVolume];
  }
}

/** 終了後BGM の指定。holdMs 経過後に停止する。 */
export interface QuizOutroPick extends QuizBgmPick {
  /** 投票締切から鳴らし続ける尺(ms)。outroSec * 1000。 */
  holdMs: number;
}

/**
 * 終了後(区間⑤)の曲を決める。
 *
 * - `amount < 0`(減算 = 「よかった」多数)→ outroDownBgm
 * - `amount > 0`(増加 = 「だめ」多数)  → outroUpBgm
 * - **`amount === 0`(引き分け・無投票)→ `null` = 無音**(2026-08-22 ユーザー決定)
 * - `outroSec === 0` → `null`(機能そのものが無効)
 *
 * `'keep'` は「投票中の曲をそのまま holdMs だけ延長する」。呼び出し側は
 * 再生中のハンドルの所有権を移すだけでよい(鳴らし直さない)。
 * `holdMs` が要るので `'keep'` でも尺を返す — 戻り値はタプルにしてある。
 */
export function quizOutroBgmFor(
  cfg: QuizConfig,
  amount: number
): { pick: QuizOutroPick | 'keep'; holdMs: number } | null {
  if (cfg.outroSec <= 0) return null;
  // ±0 は無音 — 引き分け・無投票で「勝ち曲」も「負け曲」も鳴らさない。
  if (amount === 0) return null;
  const id = amount < 0 ? cfg.outroDownBgm : cfg.outroUpBgm;
  const volume = amount < 0 ? cfg.outroDownBgmVolume : cfg.outroUpBgmVolume;
  const holdMs = cfg.outroSec * 1000;
  return { pick: id === QUIZ_BGM_KEEP ? 'keep' : { id, volume, holdMs }, holdMs };
}
