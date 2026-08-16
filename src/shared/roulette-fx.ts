import type { RoulettePattern, RouletteSpinKey, RouletteTier } from './dto';
import { ROULETTE_PATTERNS, ROULETTE_PATTERN_TIER } from './dto';
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
 *
 * ── 信頼度方式(v0.7.3〜)による構造の更新 ─────────────────────────────────
 *
 * パターン抽選は出目の珍しさで条件付ける(drawRoulettePattern の rarity 引数)。
 * これに伴い走行距離と尺は**パターンの段位**(light/mid/heavy)の関数になった。
 * 段位は開始フレームから .rl-p-* クラスとして DOM に見えている情報なので、
 * 距離・尺が段位で変わっても**パターン自身が示す以上の情報は漏れない**。
 * 一方 --rl-shift とノード総数は引き続き全スピン一律 — 出目そのものは今も
 * DOM から逆算できない。演出が出目について語るのは「確率のヒント」まで
 * (どのパターンも全レア度帯で正の重みを持つ — ガセあり)であり、確定情報ではない。
 */

/**
 * ブロック1個のステップ幅(px)。**px の数値の唯一の出所。**
 * monitor.css はブロック幅も窓幅も --rl-w / --rl-gap から calc() で導くので、
 * 「ブロック幅 + 左右マージン = ステップ幅」は代数的に保証される。
 */
export const ROULETTE_BLOCK_W = 150;
/** ブロックの左右マージン(px)。ブロック幅 = BLOCK_W - GAP*2。 */
export const ROULETTE_BLOCK_GAP = 6;

/**
 * 通常スピンの走行距離の基準(ブロック数)。light/mid/heavy は尺(rouletteSpinMs)へ
 * 比例させ、序盤のリール速度を段位に依らずほぼ一定に保つ(44/6秒 ≒ 55/7.5秒 ≒
 * 88/12秒)。比例させないと heavy が「初速の遅いスピン」に見えてカクつきになる。
 * ultra は heavy と同距離 — 走り込みが尺の先頭 ~24% に収まる(残りは動画ウィンドウ
 * とマス移動)ので初速は保たれ、TARGET/STRIP の幾何も不変で済む。距離を増やすと
 * TARGET が動いて「ノード数・shift が全スピン一律」の構造ごと組み直しになる。
 */
const RUN_BASE: Record<RouletteTier, number> = { light: 44, mid: 55, heavy: 88, ultra: 88 };
/** 短縮スピン(コンボ2本目以降)の走行距離の基準。900ms に収まる距離。 */
const RUN_BASE_FAST = 10;

/**
 * ストリップ上の当選ブロックの**固定位置**。走行距離の最大値 + 1 以上であること —
 * 開始時は「当選の run 個手前」が窓の中央にいて、その左隣も描かれている必要がある。
 * 基準は最長の heavy(最大 run = RUN_BASE.heavy + ジッタ n-1 ≦ TARGET - 1)。
 */
export const ROULETTE_TARGET_BLOCK = RUN_BASE.heavy + ROULETTE_SEGMENTS_MAX;
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
 * key はスピンの種類('fast' か再生パターン)— 基準距離は段位で決まる(RUN_BASE)。
 */
export function rouletteRun(seed: number, segmentCount: number, key: RouletteSpinKey): number {
  const n = Math.max(1, segmentCount);
  const base = key === 'fast' ? RUN_BASE_FAST : RUN_BASE[ROULETTE_PATTERN_TIER[key]];
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

/** 出目の珍しさの帯。パターン段位の重み付け(ROULETTE_TIER_WEIGHTS)の添字。 */
export type RouletteRarityBand = 'common' | 'uncommon' | 'rare';
/** p がこれ未満なら rare(既定盤面の 1000pt/1% 行が入る想定)。 */
export const ROULETTE_RARITY_RARE = 0.05;
/** p がこれ未満なら uncommon(既定盤面の 100pt/9% 行が入る想定)。以上は common。 */
export const ROULETTE_RARITY_UNCOMMON = 0.15;

/** rarity(0..1)→ 帯。未指定・非有限は null = 帯なし(旧来の一様抽選に倒す)。 */
export function rouletteRarityBand(rarity?: number): RouletteRarityBand | null {
  if (rarity == null || !Number.isFinite(rarity)) return null;
  if (rarity < ROULETTE_RARITY_RARE) return 'rare';
  if (rarity < ROULETTE_RARITY_UNCOMMON) return 'uncommon';
  return 'common';
}

/**
 * 信頼度マトリクス: 帯ごとのパターン段位の取り分(相対重み)。
 *
 * **全マスが正であること** — これが旧「パターン⊥出目」不変条件の置き換え。
 * どの帯でもどの段位も出得る(通常出目の激アツ = ガセ、大当たりの軽い演出 = 逆演出)
 * ので、演出は期待感を上げるだけで結果を確定も除外もしない。
 * 既定盤面 {30,25,20,15,9,1}% での帰結: 超激アツ(ultra)率 1.6%/スピン、
 * 超激アツ時の大当たり率 ≒15.6%(基礎1%の約16倍)・ガセ率 ≒56%。
 * 激アツ(heavy)率 6.6%/スピン、激アツ時の大当たり率 ≒6.1%。
 * 大当たり側から見ると: 25% で超激アツ・40% で激アツ・8% で通常変動(逆演出)。
 */
export const ROULETTE_TIER_WEIGHTS: Record<RouletteRarityBand, Record<RouletteTier, number>> = {
  common: { light: 70, mid: 24, heavy: 5, ultra: 1 },
  uncommon: { light: 38, mid: 38, heavy: 19, ultra: 5 },
  rare: { light: 8, mid: 27, heavy: 40, ultra: 25 },
};

/**
 * pool 内の各パターンの抽選重み。帯の段位取り分を pool 内の同段位パターン数で
 * 頭割りする — チェックの本数に依らず段位の取り分が保たれる(kick だけ許可でも
 * mid 全部許可でも mid の出やすさは同じ)。pool に無い段位は脱落し、残りが
 * 合計で再正規化される(累積走査側は総和で割るので正規化は自動)。
 * band が null(rarity 未指定)は全て 1 = 旧来の一様抽選。
 */
export function roulettePatternWeights(
  pool: readonly RoulettePattern[],
  band: RouletteRarityBand | null
): number[] {
  if (band == null) return pool.map(() => 1);
  const w = ROULETTE_TIER_WEIGHTS[band];
  const count: Record<RouletteTier, number> = { light: 0, mid: 0, heavy: 0, ultra: 0 };
  for (const p of pool) count[ROULETTE_PATTERN_TIER[p]] += 1;
  return pool.map((p) => {
    const tier = ROULETTE_PATTERN_TIER[p];
    return w[tier] / count[tier];
  });
}

/**
 * 終盤パターンの抽選。**出目の珍しさ(rarity)で段位の重みを条件付ける** — パチンコの
 * 信頼度方式。レアな出目ほど激アツ(heavy)が出やすいが、全パターンが全帯で正の
 * 重みを持つ(ROULETTE_TIER_WEIGHTS 参照)ので演出は結果の確定予告にならない。
 * rand は 0 <= r < 1(worker の注入済み fxRand。テストでは固定値)。
 * rarity は当選 index の出現確率(challenge.ts の rouletteRarity)。未指定なら一様。
 *
 * allowed は設定(ルーレット行のチェック)による許可リスト。未知値は無視し、
 * 空・未指定・全滅なら全パターンへ倒す — 設定不備でスピンを止めない。
 * **rand() の消費は常にちょうど1回** — fxRand の消費数を分岐で変えない
 * (rarity の有無・allowed の形に依らず。worker の出目再現性の前提)。
 * 境界の規約は drawRouletteIndex と同じ: rand=0 は先頭(canonical 順で最初の
 * 正重み)、rand→1 は末尾の正重みへ倒す。
 */
export function drawRoulettePattern(
  rand: () => number,
  allowed?: readonly RoulettePattern[],
  rarity?: number
): RoulettePattern {
  const pool = allowed?.length ? ROULETTE_PATTERNS.filter((p) => allowed.includes(p)) : [];
  const src: readonly RoulettePattern[] = pool.length > 0 ? pool : ROULETTE_PATTERNS;
  const weights = roulettePatternWeights(src, rouletteRarityBand(rarity));
  const total = weights.reduce((s, x) => s + x, 0);
  let r = rand() * total;
  for (let i = 0; i < src.length; i++) {
    r -= weights[i]!;
    if (r < 0) return src[i]!;
  }
  // 浮動小数の端(r がちょうど 0 まで減り切らない)は末尾へ(重みは常に正)。
  return src[src.length - 1]!;
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
  /**
   * 超激アツ(ultra)専用: 全画面動画のウィンドウ列(スピン尺 0..1 の割合)。
   * at = 動画の表示+再生開始(最初のウィンドウは quietAt と同時刻 — 回転ループ音を
   * ここで閉じる)、out = 動画終端の「一撃」の瞬間 = 溶暗の開始(RL_CLIP_FADE_MS)。
   * **一撃がリールを押す**因果を見せるため、各 out の
   * **RL_CLIP_FADE_MS 後 〜 +0.04** に必ず step / kick / nearAt のどれかを置く —
   * 「動画が消え切ってから拍が来る」ことでマス移動が動画に覆われない
   * (この不等式は roulette-fx.spec.ts が整数 ms で固定している)。
   * 動画ファイル(assets/fx/rl/<pattern>-<n>.mp4)はウィンドウ実尺ぴったりに
   * トリム済みで、終端の一撃ポーズで最終フレーム静止 → そこへ溶暗が被る
   * (loop しない)。空白時間を作らないため、尺のズレは半フレーム以内に保つこと。
   * ultra 以外と 'fast' は未定義(動画なし)。
   */
  clips?: readonly RouletteClipWindow[];
}

/** 動画ウィンドウ1枚。at/out はスピン尺 0..1 の割合。 */
export interface RouletteClipWindow {
  at: number;
  out: number;
}

/**
 * 動画の溶暗(フェードアウト)の実時間(ms)。monitor.css の **`.rl-clip.out` の
 * animation** と同期(transition は使わない — 理由は monitor.css の解説)。
 * 480 = 0.02 × ROULETTE_SPIN_ULTRA_MS。これは「一撃 → リールの拍」の標準間隔
 * (16窓中10窓)と一致し、**溶暗が終わり切った瞬間に拍が始まる**設計になる。
 */
export const RL_CLIP_FADE_MS = 480;
/**
 * 溶暗の完了から <video> を DOM から外すまでの余白(ms)。
 * 0 だと React のコミット遅延ぶんだけアニメーションの最後が切られて、
 * 直そうとしている「プツッ」がフェードの尻尾で再発する。
 */
export const RL_CLIP_REMOVE_MS = 600;

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
  // ── 超激アツ(ultra・24秒)。quietAt = clips[0].at(最初の動画で回転音を閉じる)。
  //    各 clips[].out(動画の一撃)の直後に step/kick/near が続く — 上の clips の解説を参照。
  dragon: {
    nearAt: 0.855,
    quietAt: 0.27,
    kickAts: [0.92, 0.955],
    stepAts: [0.495, 0.695],
    clips: [
      { at: 0.27, out: 0.475 },
      { at: 0.53, out: 0.675 },
      { at: 0.73, out: 0.835 },
    ],
  },
  unicorn: {
    nearAt: 0.79,
    quietAt: 0.27,
    kickAts: [],
    stepAts: [0.5, 0.53, 0.86, 0.93],
    clips: [
      { at: 0.27, out: 0.478 },
      { at: 0.56, out: 0.768 },
    ],
  },
  whale: {
    nearAt: 0.815,
    quietAt: 0.265,
    kickAts: [0.945],
    stepAts: [0.493, 0.665],
    clips: [
      { at: 0.265, out: 0.473 },
      { at: 0.52, out: 0.645 },
      { at: 0.695, out: 0.795 },
      { at: 0.835, out: 0.925 },
    ],
  },
  phoenix: {
    nearAt: 0.815,
    quietAt: 0.3,
    kickAts: [0.95],
    stepAts: [0.485, 0.66],
    clips: [
      // out は「拍の 480ms 前」に置く(溶暗が終わってから羽ばたきの衝撃波が届く)。
      { at: 0.3, out: 0.465 },
      { at: 0.515, out: 0.64 },
      { at: 0.69, out: 0.79 },
      { at: 0.83, out: 0.93 },
    ],
  },
  lion: {
    nearAt: 0.865,
    quietAt: 0.27,
    kickAts: [0.49, 0.695, 0.935],
    stepAts: [],
    clips: [
      // out は「飛び掛かり(kick 0.49)の 480ms 前」— 爪の一撃が消えてから叩き込む。
      { at: 0.27, out: 0.47 },
      { at: 0.53, out: 0.675 },
      { at: 0.74, out: 0.844 },
    ],
  },
  fast: { nearAt: 1, quietAt: 1, kickAts: [], stepAts: [] },
};

/** 超激アツ(動画つき)パターンの一覧。canonical 順を保つ。 */
export const ROULETTE_ULTRA_PATTERNS: readonly RoulettePattern[] = ROULETTE_PATTERNS.filter(
  (p) => ROULETTE_PATTERN_TIER[p] === 'ultra'
);

/**
 * 超激アツ動画クリップの id 一覧(`<pattern>-<n>`、n は 1 始まり)。
 * 実体は src/renderer/assets/fx/rl/<id>.mp4 — 対応は test/unit の
 * roulette-clip-catalog.spec.ts が突き合わせる(素材未投入の間はスキップ)。
 */
export function rouletteUltraClipIds(): string[] {
  const out: string[] = [];
  for (const p of ROULETTE_ULTRA_PATTERNS) {
    const clips = ROULETTE_PATTERN_TIMING[p].clips ?? [];
    for (let n = 1; n <= clips.length; n++) out.push(`${p}-${n}`);
  }
  return out;
}
