/**
 * 超焦らし(大当たり寸止め系 jack 3種)のカウント方式。
 *
 * 出したい体験: 超焦らしは毎回の抽選任せにせず、**5回か7回に1回だけ・並びの
 * 最後のフル尺スピンで必ず**出す。発動回以外で worker の抽選が jack を引いて
 * いたら doublefake へ降格する — jack と doublefake は同じ heavy 段位なので
 * 尺・走行距離・信頼度方式の意味(レア出目ほど重い演出)は保ったまま、
 * 超焦らしの出現だけをこのカウントに一本化できる。
 *
 * パターンは worker が抽選して effect に焼き込み済みで、モニターは再生する
 * だけ — だが「並びの最後の1本」はモニターのキュー状態でしか分からないので、
 * 差し替えの判定はモニター(startRoulette)で行う。出目(どこに止まるか)には
 * 一切触れない。
 *
 * **対象はリール1本の単発ルーレットだけ**(2026-08-17)。連打(コンボ)のリールは
 * 素通しで、抽選パターンがそのまま出る — 旧実装が「連打の1本目を並びの締めとして
 * 数える」としていた根拠(2本目以降は短縮でゴーストを出せない)がフル尺化で消滅
 * したため。enabled / 単発かどうか / 入室ルーレット(rouletteJoin)/ 試写(test)の
 * 素通しゲートは roulette-spin.ts の planRouletteSpin の責務 — この関数群は純粋に保つ。
 *
 * shared に置くのは fx-drain.ts と同じ理由 — レンダラのテスト環境がこの
 * リポジトリに無いので、決定ロジックを純関数として抽出して node のテストで
 * 固定する。乱数は rand: () => number を注入する(drawRoulettePattern と同じ
 * 流儀。ただしこちらはモニター側の Math.random で、worker の fxRand の
 * 「消費はちょうど1回」規約とは無関係の層)。
 */

import type { RoulettePattern } from './dto';
import { ROULETTE_JACK_PATTERNS, ROULETTE_TEASE_COUNTS } from './challenge';

/** カウントの状態。モニターが ref で持つ(セッション内のみ・永続化しない)。 */
export interface RouletteTeaseState {
  /** 次の発動までの残り回数(「並びの最後のフル尺スピン」を1と数える)。 */
  remaining: number;
}

/** jack(超焦らし)判定の唯一の実装。RouletteFx のゴースト表示判定もこれを使う。 */
export function isJackPattern(p: RoulettePattern): boolean {
  return (ROULETTE_JACK_PATTERNS as readonly RoulettePattern[]).includes(p);
}

/** ROULETTE_TEASE_COUNTS(5 or 7)から等確率で発動間隔を引く。 */
export function rouletteTeaseNext(rand: () => number): number {
  const i = Math.min(ROULETTE_TEASE_COUNTS.length - 1, Math.floor(rand() * ROULETTE_TEASE_COUNTS.length));
  return ROULETTE_TEASE_COUNTS[Math.max(0, i)]!;
}

/** 初期状態。初回の発動間隔もランダム(固定だと初回だけ規則的にバレる)。 */
export function rouletteTeaseInit(rand: () => number): RouletteTeaseState {
  return { remaining: rouletteTeaseNext(rand) };
}

/**
 * 1スピンぶんの判定。戻り値の pattern で draw.pattern を差し替えること。
 *
 * - lastOne=false(キューの途中): カウントは進めない(「並びの最後」だけ数える)。
 *   jack は doublefake へ降格 — 発動回以外で超焦らしを見せない。
 * - lastOne=true: remaining を1消費。0 になったら**発動** — 引いた pattern が
 *   jack ならそのまま採用、そうでなければ allowed(設定の rouletteTease.patterns)
 *   から等重み抽選で差し替える。remaining は 5/7 を引き直す。まだ残っていれば
 *   非発動 — jack は doublefake へ降格。
 * - jack 以外(light/mid/heavy の doublefake/ultra)は発動回以外では触らない。
 *
 * allowed が空のときは降格だけ行い発動しない(検証 validateRouletteTease が
 * 空を作らないので保険)。
 */
export function rouletteTeaseStep(
  state: RouletteTeaseState,
  drawn: RoulettePattern,
  opts: { lastOne: boolean; allowed: readonly RoulettePattern[] },
  rand: () => number
): { pattern: RoulettePattern; state: RouletteTeaseState } {
  const demoted: RoulettePattern = isJackPattern(drawn) ? 'doublefake' : drawn;
  if (!opts.lastOne) return { pattern: demoted, state };
  const remaining = state.remaining - 1;
  if (remaining > 0) return { pattern: demoted, state: { remaining } };
  // 発動回。引いた jack はそのまま(信頼度抽選の顔を立てる)、非 jack は
  // allowed から等重みで差し替え。
  const pool = opts.allowed.filter((p) => isJackPattern(p));
  const pattern = isJackPattern(drawn)
    ? drawn
    : pool.length > 0
      ? pool[Math.max(0, Math.min(pool.length - 1, Math.floor(rand() * pool.length)))]!
      : demoted;
  return { pattern, state: { remaining: rouletteTeaseNext(rand) } };
}
