import type { RoulettePattern } from './dto';
import { ROULETTE_SEGMENTS_MAX } from './challenge';

/**
 * ギフトルーレット演出の幾何とパターン — 純関数のみ。DOM も React も触らない。
 *
 * ここ(shared)に置く理由: 着地位置・走行距離・盤面の並べ方は「演出の正しさ」
 * そのもの(着地は必ず当選 index / 添字が負にならない / 開始フレームから結果を
 * 逆算できない)なので、test/unit で検算できる場所に置く。
 *
 * ── 結果を先に漏らさないための2つの構造 ──────────────────────────────────
 *
 * 1. **当選位置を定数 ROULETTE_TARGET_BLOCK に固定し、盤面のほうを回す。**
 *    旧実装は targetBlock = SPIN_LOOPS*n + index で index に依存していたため、
 *    (a) インライン変数 --rl-shift から当選 index が一次式で逆算でき(OBS の
 *        ブラウザソース経由で DOM が読める立場の人に平文で答えを見せていた)、
 *    (b) 総移動距離が index に比例するのに尺は固定 = リールの速度が結果と
 *        相関していた(常連は序盤の流れの速さで高 index を当てられる)。
 *    当選が必ず strip[TARGET_BLOCK] に来るよう並びを回転させれば、--rl-shift も
 *    ブロック総数も全スピンで同一になり、どちらの漏れも消える。
 *
 * 2. **走行距離にジッタを入れる。** 1 だけでは足りない — 走行距離が整数ブロックの
 *    定数だと、開始時に窓の中央にいるのは必ず「当選の run 個手前」に固定される。
 *    既定盤面(6件)なら「開始時に中央にある値の N 個先が必ず当選」となり、盤面の
 *    並びを覚えた常連には1フレーム目で読めてしまう(速度の漏れを潰したつもりが
 *    位相の漏れに移し替わるだけ)。run に 0..n-1 のジッタを足せば開始フレームの
 *    情報量がゼロになる。ジッタは高速域(序盤)だけが吸収するので、割合で書いて
 *    ある終盤の段には一切影響しない。
 */

/**
 * ブロック1個のステップ幅(px)。**px の数値の唯一の出所。**
 * monitor.css はブロック幅も窓幅も --rl-w / --rl-gap から calc() で導くので、
 * 「ブロック幅 + 左右マージン = ステップ幅」は代数的に保証される。
 */
export const ROULETTE_BLOCK_W = 150;
/** ブロックの左右マージン(px)。ブロック幅 = BLOCK_W - GAP*2。 */
export const ROULETTE_BLOCK_GAP = 6;

/** 通常スピンの走行距離の基準(ブロック数)。6秒でも間延びしない移動量。 */
const RUN_BASE = 44;
/** 短縮スピン(キュー消化)の走行距離の基準。900ms に収まる距離。 */
const RUN_BASE_FAST = 10;

/**
 * ストリップ上の当選ブロックの**固定位置**。走行距離の最大値 + 1 以上であること —
 * 開始時は「当選の run 個手前」が窓の中央にいて、その左隣も描かれている必要がある。
 */
export const ROULETTE_TARGET_BLOCK = RUN_BASE + ROULETTE_SEGMENTS_MAX;
/**
 * ストリップの総ブロック数。着地時は当選の左右1個ずつが窓に見え、パターン3の
 * キックは当選を 0.1 ブロック行き過ぎるので、右側に 2 個ぶんの余白を持たせる。
 */
export const ROULETTE_STRIP_LEN = ROULETTE_TARGET_BLOCK + 3;

/**
 * 表示するブロック列。当選が必ず strip[ROULETTE_TARGET_BLOCK] に来るよう盤面を
 * 回転させる。並びは元の盤面の巡回のままなので、見た目は普通のリールに見える。
 */
export function rouletteStrip(segments: readonly number[], index: number): number[] {
  const n = segments.length;
  if (n === 0) return [];
  // (TARGET + offset) % n === index を満たす offset。負の剰余を避けて正規化する。
  const offset = (((index - ROULETTE_TARGET_BLOCK) % n) + n) % n;
  const out: number[] = [];
  for (let i = 0; i < ROULETTE_STRIP_LEN; i++) out.push(segments[(i + offset) % n]!);
  return out;
}

/**
 * 走行距離(ブロック数)。seed は effect.id — 到着順の通番で、抽選結果とは無関係。
 * 0..n-1 のジッタを足して「開始時に中央にある値から当選を数えられる」を潰す。
 */
export function rouletteRun(seed: number, segmentCount: number, fast: boolean): number {
  const n = Math.max(1, segmentCount);
  const base = fast ? RUN_BASE_FAST : RUN_BASE;
  // seed は単調増加なので % n はジッタとして一様。負値も安全側へ丸める。
  const jitter = ((Math.trunc(seed) % n) + n) % n;
  return base + jitter;
}

/** 終盤の演出パターン。値は CSS のクラス名(rl-p-*)とキーフレーム名の接尾辞になる。 */
export const ROULETTE_PATTERNS: readonly RoulettePattern[] = ['slow', 'pop', 'kick'];

/**
 * 終盤パターンの抽選。**出目とは独立に引くこと** — パターンが結果と相関した瞬間、
 * 「キックが来たら大当たり」が学習されて演出が結果の予告になる。
 * rand は 0 <= r < 1(worker の注入済み rand。テストでは固定値)。
 */
export function drawRoulettePattern(rand: () => number): RoulettePattern {
  const i = Math.floor(rand() * ROULETTE_PATTERNS.length);
  return ROULETTE_PATTERNS[Math.min(ROULETTE_PATTERNS.length - 1, Math.max(0, i))]!;
}

/**
 * 「止まりそう」の効果音を鳴らす時刻(スピン尺に対する割合)。
 * 規則は全パターン共通で**当選の1つ手前のブロックに着いた瞬間** — そこから先は
 * 保持・フェイク停止・溜めで、リールが「あと1個で止まる」状態に入る。
 * monitor.css の各 rl-run-* が `var(--rl-w) * 1` に到達する段と一致させること
 * (slow 80% / pop 74% / kick 70%)。fast は段が無いので 1(= 鳴らさない。
 * ROULETTE_SPIN_SE_END_AT と同じ番兵の使い方)。
 */
export const ROULETTE_NEAR_STOP_AT: Record<RoulettePattern | 'fast', number> = {
  slow: 0.8,
  pop: 0.74,
  kick: 0.7,
  fast: 1,
};

/**
 * キックが入る時刻(スピン尺に対する割合)。monitor.css の rl-run-kick の
 * 87.5% と一致させること — 効果音をここで鳴らす。
 */
export const ROULETTE_KICK_AT = 0.875;

/**
 * 回転ループ音(カチカチ)を止める時刻(スピン尺に対する割合)。
 * リールが「止まって見える」区間でカラカラ鳴り続けると、ポンポンの保持や
 * キックのフェイク停止の「止まった」錯覚が音で割れるため、終盤の段に入る
 * ところでループを閉じる。monitor.css の各 rl-run-* の段の入りと揃えること。
 * fast は段が無いので 1(= リール停止まで鳴らしてよい)。
 */
export const ROULETTE_SPIN_SE_END_AT: Record<RoulettePattern | 'fast', number> = {
  slow: 0.94,
  pop: 0.5,
  kick: 0.48,
  fast: 1,
};
