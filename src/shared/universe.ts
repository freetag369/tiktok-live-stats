/**
 * 一撃クリア(TIKTOK UNIVERSE・44,999💎)の尺と段組。
 *
 * shared に置くのは `revolution-settle.ts` / `boost-settle.ts` と同じ理由 —
 * 演出の決定ロジックを純関数にして node の vitest で凍結する
 * (renderer には `@renderer` エイリアスも mp4/mp3 のローダも無く、
 * `vitest.config.ts` の環境では import できない)。
 *
 * **尺の権威は素材ではなくこの定数**。モニターは `onEnded` を使わず JS タイマーで
 * 打ち切るので、素材の実尺とここがズレると幕だけが早く/遅く終わる。
 * **差し替えるときは定数と素材のフレーム数を必ず一緒に動かすこと**
 * (`REVOLUTION_RESULT_VIDEO_MS` の注記と同じ規約)。
 */

import {
  BOOST_ROLLUP_BASE_MS,
  BOOST_ROLLUP_MAX_MS,
  BOOST_ROLLUP_PER_DIGIT_MS,
} from './boost-settle';

/** 導入カットイン。素材契約: `assets/fx/universe/intro.mp4` = 192 フレーム @ 24fps。 */
export const UNIVERSE_INTRO_MS = 8_000;

/** 残量の分割数(ユーザー決定 2026-08-26: 30分割)。 */
export const UNIVERSE_DRAIN_STEPS = 30;

/** 1段の間隔(ユーザー決定: 等間隔 300ms)。 */
export const UNIVERSE_STEP_MS = 300;

/** −N 連打の総尺。9,000 を直書きしないこと(段数か間隔を変えたときに二重管理になる)。 */
export const UNIVERSE_DRAIN_MS = UNIVERSE_DRAIN_STEPS * UNIVERSE_STEP_MS;

/** 締めカットイン。素材契約: `assets/fx/universe/outro.mp4` = 192 フレーム @ 24fps。 */
export const UNIVERSE_OUTRO_MS = 8_000;

/** 演出の総尺 = 8 + 9 + 8 = 25 秒(ユーザー確定値。`universe.spec.ts` が等式で凍結)。 */
export const UNIVERSE_TOTAL_MS = UNIVERSE_INTRO_MS + UNIVERSE_DRAIN_MS + UNIVERSE_OUTRO_MS;

/** 幕引きのフェード。monitor.css の `.fx-clip-opaque` / `.universe-screen` の transition と一致必須。 */
export const UNIVERSE_FADE_MS = 400;

/**
 * 減算合計の発表(「いくら減ったか」)が出ている尺。締めのカットインの**頭に重ねて**
 * 出し、explosion の余韻は数字なしで見せ切るのでカットインより短い。
 * `UNIVERSE_OUTRO_MS` を超えないことは `universe.spec.ts` が不等式で凍結する。
 */
export const UNIVERSE_TOTAL_REVEAL_MS = 4_500;

/**
 * アーム期限(モニターが「発動時点で溜まっていたキュー」を消化し切るのを待つ上限)。
 * `QUIZ_ARM_MAX_MS` と同じ 120 秒 — 理由も同じで、バリア方式は溜まっていた
 * カットインを全部流し終えるまで待つため、`BOOST_ARM_MAX_MS`(60秒)では足りない。
 */
export const UNIVERSE_ARM_MAX_MS = 120_000;

/**
 * `clampFutureMs` の上限(時計飛び・NTP 巻き戻しの安全弁)。演出は一発きりで
 * 延長も重ねがけも無いので総尺そのもの。
 */
export const UNIVERSE_MAX_MS = UNIVERSE_TOTAL_MS;

/**
 * バリアで清算待ちにできる op の上限。`QUIZ_DEFERRED_OPS_MAX` と同じ 512
 * (`GIFT_FX_PENDING_OPS_MAX` の 256 より大きいのは、25 秒のあいだ**全 op**を
 * 止めるため — 革命の「fx 付きだけ」より溜まる量が多い)。
 */
export const UNIVERSE_DEFERRED_OPS_MAX = 512;


/**
 * 数字1文字の実測比(font-size に対する幅)。**`--num`(= Segoe UI / Yu Gothic UI /
 * Meiryo)を tabular-nums で組んだときの実測値**。ブラウザで採寸:
 * 192px の「-33」= 308px(102.7/文字)、「-1500」= 516px(103.2/文字)→ **0.538**。
 *
 * ⚠ **測り直すときは必ず tokens.css を読み込んだ状態で測ること。** 素の
 * sans-serif フォールバックだと 0.85 前後になり、その値で組むと文字が
 * 必要以上に小さくなる(初版で実際に踏んだ)。
 */
export const UNIVERSE_CHAR_RATIO = 0.54;

/** 合計の最大サイズ(短い数字はここで頭打ち)。`.revolution-settle .rs-amt` と同値。 */
export const UNIVERSE_TOTAL_MAX_PX = 170;
export const UNIVERSE_TOTAL_MAX_PX_LANDSCAPE = 132;

/**
 * パネルの内寸(ステージ幅 − 左右マージン − `.ut-box` の padding×2)。
 * **monitor.css の `.ut-box` の padding と対**なので、片方を変えたら必ず両方直す。
 * 縦 540 − 16×2(余白) − 28×2(padding) = 452 / 横 1280 − 16×2 − 48×2 = 1152。
 */
const TOTAL_INNER_W = { portrait: 452, landscape: 1152 };

/**
 * -N ポップの内寸。`.ud-tick` は左右いっぱい(left:0/right:0)のセンタリングだが、
 * 左右の寄りを padding 3% で作っているぶん**両側から引く**必要がある
 * (片側だけ引くと、寄せた方向へはみ出して overflow:hidden に切られる —
 * 実機プレビューで 5 文字「-1500」の下段が右端で切れて発覚)。
 * 縦 540 − 16×2 = 508 / 横 1280 − 38×2 = 1204。
 * **monitor.css の `.ud-tick.s0/.s1` の padding と対**なので必ず一緒に直すこと。
 */
const TICK_INNER_W = { portrait: 508, landscape: 1204 };

/** -N ポップの最大サイズ = **ユーザー決定の3倍**(初版 64 / 48 → 192 / 144)。 */
export const UNIVERSE_TICK_MAX_PX = 192;
export const UNIVERSE_TICK_MAX_PX_LANDSCAPE = 144;

/**
 * -N ポップの font-size(px)。**3倍(192)を上限に、桁が増えたぶんだけ縮める**。
 * 縦ステージ(540px)では 5 文字「-1500」が 192px でちょうど 516px = ぎりぎり収まる
 * ので、実運用の 3〜5 文字は**丸ごと 3 倍のまま**。6 文字以上(初期値が 10 万超の
 * 設定)だけが縮み、`.fx-layer` の overflow:hidden で切られるのを防ぐ。
 */
export function universeTickFontPx(amount: number, landscape: boolean): number {
  const inner = landscape ? TICK_INNER_W.landscape : TICK_INNER_W.portrait;
  const cap = landscape ? UNIVERSE_TICK_MAX_PX_LANDSCAPE : UNIVERSE_TICK_MAX_PX;
  return Math.max(
    40,
    Math.min(cap, Math.floor(inner / (totalChars(amount) * UNIVERSE_CHAR_RATIO)))
  );
}

/** '-' を含めた文字数。 */
function totalChars(total: number): number {
  return String(Math.max(0, Math.floor(total))).length + 1;
}

/**
 * 合計の font-size(px)。**桁数から逆算してステージに収める** —
 * 縦ステージは 540px しか無く、170px 固定だと 3 桁でも溢れる(実測 994px)。
 * 設定画面の `quizPromptFontPx` と同じ「サイズは shared で決め、インライン style で
 * 当てる」流儀(CSS の font-size は据わり値として残す)。
 */
export function universeTotalFontPx(total: number, landscape: boolean): number {
  const inner = landscape ? TOTAL_INNER_W.landscape : TOTAL_INNER_W.portrait;
  const cap = landscape ? UNIVERSE_TOTAL_MAX_PX_LANDSCAPE : UNIVERSE_TOTAL_MAX_PX;
  return Math.max(
    48,
    Math.min(cap, Math.floor(inner / (totalChars(total) * UNIVERSE_CHAR_RATIO)))
  );
}

/**
 * 数字欄の固定幅(px)。**カウントアップで桁が増えてもパネルが伸縮しない**ようにする
 * (0 → 合計へ駆け上がる間、文字数は 1 桁ずつ増えるので、幅を固定しないと
 * `.ut-box` が shrink-to-fit で毎フレーム揺れる)。
 */
export function universeTotalWidthPx(total: number, landscape: boolean): number {
  return Math.ceil(
    totalChars(total) * universeTotalFontPx(total, landscape) * UNIVERSE_CHAR_RATIO
  );
}

/** 減算1段ぶん。 */
export interface UniverseStep {
  /** 0..UNIVERSE_DRAIN_STEPS-1。 */
  index: number;
  /** 演出開始(導入カットインの先頭)からの絶対オフセット。 */
  atMs: number;
  /** この段の減算量(≥ 0。from < 段数のときは 0 の段が混ざる)。 */
  amount: number;
  /** この段を出したあとに 7セグへ出す残量。最終段は必ず 0。 */
  remain: number;
}

/** `planUniverseClear` の返り。全部「演出開始からの絶対オフセット」。 */
export interface UniverseClearPlan {
  /** 起点(= コミット時点のカウント残量)。 */
  from: number;
  /** 導入カットインの実再生尺。素材なし/カットイン無効なら 0。 */
  introMs: number;
  /** 導入のフェード開始。introMs が 0 なら 0。 */
  introFadeAtMs: number;
  /** 減算フェーズの開始 = introMs。 */
  drainAtMs: number;
  /** 減算フェーズの尺。**from に依らず常に UNIVERSE_DRAIN_MS**(§段数を縮めない理由)。 */
  drainMs: number;
  steps: UniverseStep[];
  /** 締めカットインの開始。 */
  outroAtMs: number;
  /** 締めカットインの実再生尺。素材なし/カットイン無効なら 0。 */
  outroMs: number;
  /**
   * 減算合計の発表が出る時刻。**締めカットインの開始と同時**(= 30 段を削り切った
   * 瞬間)。`from <= 0` で演出ごとスキップのときは 0。
   */
  totalAtMs: number;
  /** 合計のカウントアップ(0 → from)の尺。桁数で伸びる(boost / revolution と共有のスケール)。 */
  totalCountupMs: number;
  /** 合計のフェード開始(消えたあとは explosion の余韻だけが残る)。 */
  totalFadeAtMs: number;
  /** 幕引きのフェード開始。 */
  fadeAtMs: number;
  /** 演出の総尺。**0 = 演出を丸ごとスキップ**(呼び出し側はバナー1枚へ縮退)。 */
  totalMs: number;
}

const EMPTY: UniverseClearPlan = {
  from: 0,
  introMs: 0,
  introFadeAtMs: 0,
  drainAtMs: 0,
  drainMs: 0,
  steps: [],
  outroAtMs: 0,
  outroMs: 0,
  totalAtMs: 0,
  totalCountupMs: 0,
  totalFadeAtMs: 0,
  fadeAtMs: 0,
  totalMs: 0,
};

/**
 * 合計のカウントアップ尺。**boost / revolution とスケールを共有する**
 * (`revolution-settle.ts` の rollupMsFor と同式 — 第二の真実を作らない)。
 */
function countupMsFor(amount: number): number {
  const digits = String(Math.max(0, amount)).length;
  return Math.min(
    BOOST_ROLLUP_MAX_MS,
    Math.max(BOOST_ROLLUP_BASE_MS, BOOST_ROLLUP_BASE_MS + digits * BOOST_ROLLUP_PER_DIGIT_MS)
  );
}

/**
 * 残量 `from` を UNIVERSE_DRAIN_STEPS 段へ割る。**唯一の権威**(worker も
 * モニターもこれを通す — 第二の真実を作らない)。
 *
 * 式は `floor(from*(i+1)/n) − floor(from*i/n)`。この形を選んだ理由:
 *
 * 1. **合計が厳密に from** — 望遠鏡和なので `floor(from) − floor(0) = from`。
 *    「`ceil(from/n)` を n−1 回 + 残り」方式だと、from が大きいとき最終段だけが
 *    極端に小さく(または負に)なる。
 * 2. **段差は高々 1** — 実数 x と d ≥ 0 について `floor(x+d) − floor(x)` は
 *    `floor(d)` か `ceil(d)`。ここでは d = from/n なので全段が
 *    `floor(from/30) ≤ amount ≤ ceil(from/30)` に収まり、見た目が均一になる。
 * 3. **端数が等間隔に散る**(Bresenham と同じ分配)— 先頭にも末尾にも固まらない
 *    ので「等間隔 300ms」の連打と噛み合う。
 * 4. **決定的**(整数演算のみ・`Math.random` 不使用)— `revolution-settle.ts` と
 *    同じ契約。同じ入力なら worker とモニターで必ず同じ段になる。
 *
 * `remain` は単調非増加で、`steps[n-1].remain === 0` が構造的に保証される。
 */
export function planUniverseDrain(from: number): UniverseStep[] {
  const total = Math.max(0, Math.floor(from));
  const n = UNIVERSE_DRAIN_STEPS;
  const steps: UniverseStep[] = [];
  for (let i = 0; i < n; i++) {
    const cutBefore = Math.floor((total * i) / n);
    const cutAfter = Math.floor((total * (i + 1)) / n);
    steps.push({
      index: i,
      atMs: i * UNIVERSE_STEP_MS,
      amount: cutAfter - cutBefore,
      remain: total - cutAfter,
    });
  }
  return steps;
}

/**
 * 25 秒の段組を決める。素材が無い/カットインが無効なときは `introMs` / `outroMs`
 * を 0 で渡す — 段が前へ詰まり総尺も縮む(0 件許容 glob の縮退と対)。
 *
 * `from <= 0` は degenerate(既に 0)なので `totalMs: 0` を返し、呼び出し側は
 * 演出を出さずにバナー1枚へ倒す(`planRevolutionResult` が `downTotal <= 0` で
 * 全段 0 を返すのと同じ判断)。
 */
export function planUniverseClear(input: {
  from: number;
  introMs: number;
  outroMs: number;
}): UniverseClearPlan {
  const from = Math.max(0, Math.floor(input.from));
  if (from <= 0) return EMPTY;
  const introMs = Math.max(0, Math.floor(input.introMs));
  const outroMs = Math.max(0, Math.floor(input.outroMs));
  const drainAtMs = introMs;
  const outroAtMs = drainAtMs + UNIVERSE_DRAIN_MS;
  const totalMs = outroAtMs + outroMs;
  const steps = planUniverseDrain(from).map((s) => ({ ...s, atMs: drainAtMs + s.atMs }));
  return {
    from,
    introMs,
    introFadeAtMs: introMs > 0 ? Math.max(0, introMs - UNIVERSE_FADE_MS) : 0,
    drainAtMs,
    drainMs: UNIVERSE_DRAIN_MS,
    steps,
    outroAtMs,
    outroMs,
    // 発表は締めのカットインと同時に始まる(30 段を削り切った瞬間の「ドン」)。
    totalAtMs: outroAtMs,
    totalCountupMs: countupMsFor(from),
    // 発表そのもののフェード。演出の終端は超えない(素材なしで outroMs が 0 でも
    // はみ出さないよう totalMs で頭打ちにする)。
    totalFadeAtMs: Math.max(
      outroAtMs,
      Math.min(totalMs, outroAtMs + UNIVERSE_TOTAL_REVEAL_MS) - UNIVERSE_FADE_MS
    ),
    fadeAtMs: Math.max(0, totalMs - UNIVERSE_FADE_MS),
    totalMs,
  };
}
