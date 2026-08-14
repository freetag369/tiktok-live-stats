import type { RoulettePattern } from './dto';
import { ROULETTE_PATTERNS } from './dto';
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
 * 設計上の最大行き過ぎ量(ブロック)。overrun のフェイク着地(-1.0)と溜め(-1.08)が
 * 最深で、キック系の行き過ぎ(≤0.12)はその内側。キーフレームを書くときは
 * この値を超えないこと — 超えるとストリップの右端が窓に入って空白が見える。
 * STRIP_LEN との代数関係は test/unit/roulette-fx.spec.ts が固定している。
 */
export const ROULETTE_MAX_OVERSHOOT = 1.2;
/**
 * ストリップの総ブロック数。着地時は当選の左右1個ずつが窓に見え、さらに overrun は
 * 当選を丸ごと1個(溜め込みで最大 1.08)行き過ぎるので、右側に 3 個ぶんの余白を
 * 持たせる — 行き過ぎ x のとき窓の右端は当選の x + 1.5 個右まで描画が要る。
 * 余白は全スピン一律なので「ノード数が出目に依存しない」構造は崩れない。
 */
export const ROULETTE_STRIP_LEN = ROULETTE_TARGET_BLOCK + 4;

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

/**
 * 終盤の演出パターン全種。一覧の実体は dto.ts(challenge.ts と共有するため —
 * ここから import すると循環になる)。re-export は worker/テストの import 先を
 * 変えないための互換。
 */
export { ROULETTE_PATTERNS };

/**
 * 終盤パターンの抽選。**出目とは独立に引くこと** — パターンが結果と相関した瞬間、
 * 「キックが来たら大当たり」が学習されて演出が結果の予告になる。
 * rand は 0 <= r < 1(worker の注入済み rand。テストでは固定値)。
 *
 * allowed は設定(ルーレット行のチェック)による許可リスト。未知値は無視し、
 * 空・未指定・全滅なら全パターンへ倒す — 設定不備でスピンを止めない。
 * 許可リストは出目と無相関なので抽選の独立性は崩れない。
 * **rand() の消費は常にちょうど1回** — fxRand の消費数を分岐で変えない。
 */
export function drawRoulettePattern(
  rand: () => number,
  allowed?: readonly RoulettePattern[]
): RoulettePattern {
  const pool = allowed?.length ? ROULETTE_PATTERNS.filter((p) => allowed.includes(p)) : [];
  const src: readonly RoulettePattern[] = pool.length > 0 ? pool : ROULETTE_PATTERNS;
  const i = Math.floor(rand() * src.length);
  return src[Math.min(src.length - 1, Math.max(0, i))]!;
}

/** 1スピン内の SE タイミング一式(スピン尺 0..1 に対する割合)。 */
export interface RoulettePatternTiming {
  /**
   * 「止まりそう」の効果音。規則は全パターン共通で**当選(超焦らし系はゴースト)の
   * 1つ手前 = k=1 帯に入った瞬間** — そこから先は保持・フェイク・溜めの領域。
   * 1 は番兵(鳴らさない。fast は段が無い)。
   */
  nearAt: number;
  /**
   * 回転ループ音(カチカチ)を止める時刻。リールが「止まって見える」区間で
   * カラカラ鳴り続けると保持やフェイク停止の錯覚が音で割れるため、終盤の段に
   * 入るところで閉じる。1 は番兵(fast = リール停止まで鳴らしてよい)。
   */
  quietAt: number;
  /**
   * キック級の衝撃(SE 'roulette-kick' + 画面揺れ)。値は**予備動作(溜め)の入り**の
   * キーフレームに置く(旧 ROULETTE_KICK_AT = kick 87.5% の規約を踏襲)。
   * doublefake は2発、衝撃の無いパターンは空。
   */
  kickAts: readonly number[];
  /**
   * 段・ホップ・微停止への到達の「コツン」(near SE の弱再生)。鳴らしすぎると
   * 焦らしが騒がしくなるので、1スピン 4 発までに抑える。
   */
  stepAts: readonly number[];
}

/**
 * パターンごとの SE タイミング。**monitor.css の対応キーフレームと散文で同期しない** —
 * CSS 側の該当キーフレーム行に「cue:near / cue:quiet / cue:kick / cue:step」の
 * コメントマーカーを置き、test/unit/roulette-css.spec.ts がこのテーブルと機械照合する。
 * 値を変えるときは必ず CSS のマーカーとセットで動かすこと(片方だけだとテストが落ちる)。
 */
export const ROULETTE_PATTERN_TIMING: Record<RoulettePattern | 'fast', RoulettePatternTiming> = {
  slow: { nearAt: 0.8, quietAt: 0.94, kickAts: [], stepAts: [] },
  pop: { nearAt: 0.77, quietAt: 0.5, kickAts: [], stepAts: [0.58, 0.67] },
  kick: { nearAt: 0.68, quietAt: 0.48, kickAts: [0.87], stepAts: [0.58] },
  overrun: { nearAt: 0.68, quietAt: 0.5, kickAts: [0.85], stepAts: [] },
  crawl: { nearAt: 0.72, quietAt: 0.48, kickAts: [], stepAts: [0.56, 0.66, 0.76] },
  doublefake: { nearAt: 0.765, quietAt: 0.48, kickAts: [0.7, 0.89], stepAts: [] },
  restart: { nearAt: 0.8, quietAt: 0.6, kickAts: [0.655], stepAts: [] },
  teeter: { nearAt: 0.65, quietAt: 0.48, kickAts: [], stepAts: [0.74, 0.78, 0.82, 0.895] },
  stairs: { nearAt: 0.8, quietAt: 0.48, kickAts: [], stepAts: [0.54, 0.615, 0.7] },
  blackout: { nearAt: 0.64, quietAt: 0.72, kickAts: [0.72], stepAts: [0.89] },
  jackstop: { nearAt: 0.66, quietAt: 0.48, kickAts: [0.88], stepAts: [0.58] },
  jackslip: { nearAt: 0.7, quietAt: 0.48, kickAts: [], stepAts: [0.76, 0.82, 0.88] },
  jackback: { nearAt: 0.68, quietAt: 0.5, kickAts: [0.88], stepAts: [0.74] },
  fast: { nearAt: 1, quietAt: 1, kickAts: [], stepAts: [] },
};
