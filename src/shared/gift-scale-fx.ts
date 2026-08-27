/**
 * ダイヤ増減演出(「N 浮上 → 数字が合計値まで駆け上がる → ドンとカウントに着弾」)の
 * 尺の計画と、カウントアップの表示値。
 *
 * shared に置くのは boost-settle.ts / fx-stage.ts と同じ理由 — このリポジトリには
 * レンダラの DOM テスト環境が無い(vitest は node 環境のみ)ので、演出の**決定ロジックは
 * 必ず純関数として切り出して node のテストで固定する**。
 *
 * Math.random は使わない(StrictMode の二重レンダーで値が変わるのと、テストで固定
 * できなくなるため — boost-settle.ts の spinDigit と同じ規律)。ここは経過時刻だけの
 * 関数なのでそもそも乱数を必要としない。
 */

import { STRIKE_TRAVEL_MAX_MS } from './boost-settle';

/**
 * `.float.banner-gift-scale` の浮上アニメーションの尺。**monitor.css の
 * `animation-duration` と同値**でなければならない(fx-stage.spec.ts が CSS を読んで
 * 固定する)。ユーザー要件の「N 浮上が現れる(間 3S)」がこの値。
 */
export const BANNER_GIFT_SCALE_MS = 3_000;

/**
 * 浮上の立ち上がりが終わって数字が読める時刻。`floatup` の 0%→22%(monitor.css)が
 * 立ち上がりなので、その明け際からカウントアップを始める。ここより早く回し始めると
 * バナーがまだ拡大中で数字が読めない。
 */
export const GIFT_SCALE_APPEAR_MS = 660;

/** カウントアップの基礎尺。桁数に応じて下の PER_DIGIT ぶん伸びる。 */
export const GIFT_SCALE_ROLLUP_BASE_MS = 600;
/** 1桁あたりの追加尺。桁が多いほど「駆け上がっている」時間を長く見せる。 */
export const GIFT_SCALE_ROLLUP_PER_DIGIT_MS = 90;
/** カウントアップの上限尺。7桁(百万)でも頭打ちにして総尺の不変条件を守る。 */
export const GIFT_SCALE_ROLLUP_MAX_MS = 1_100;

/**
 * 合計値に到達してから発射するまでの溜め(「ドン」の直前の静止)。
 * boost の BOOST_ROLLUP_HOLD_MS と同じ役目 — 到達した数字を読ませる間。
 */
export const GIFT_SCALE_HOLD_MS = 450;

/** 演出の段取り。すべて「浮上が出た瞬間」からの相対ミリ秒。 */
export interface GiftScalePlan {
  /** カウントアップを始める時刻。 */
  appearMs: number;
  /** カウントアップの尺。 */
  rollupMs: number;
  /** 到達後の溜め。 */
  holdMs: number;
  /** 発射する時刻(= appearMs + rollupMs + holdMs)。着弾の飛翔は含まない。 */
  totalMs: number;
}

/**
 * 増減量から段取りを決める。`amountAbs` は符号を落とした表示桁数の元(実減少量規約で
 * クランプ済みの値の絶対値を渡すこと — 名目値を渡すと桁が実際より多くなる)。
 *
 * **不変条件**: `totalMs + STRIKE_TRAVEL_MAX_MS <= BANNER_GIFT_SCALE_MS`。
 * 破ると着弾がバナーの消滅より後になり、「どこから飛んできたのか分からない弾」になる。
 * gift-scale-fx.spec.ts が全桁で固定する。
 */
export function planGiftScaleFx(input: { amountAbs: number }): GiftScalePlan {
  const n = Math.max(0, Math.floor(input.amountAbs));
  const digits = n <= 0 ? 1 : String(n).length;
  const rollupMs = Math.min(
    GIFT_SCALE_ROLLUP_MAX_MS,
    GIFT_SCALE_ROLLUP_BASE_MS + digits * GIFT_SCALE_ROLLUP_PER_DIGIT_MS
  );
  const appearMs = GIFT_SCALE_APPEAR_MS;
  const holdMs = GIFT_SCALE_HOLD_MS;
  return { appearMs, rollupMs, holdMs, totalMs: appearMs + rollupMs + holdMs };
}

/**
 * 経過 `elapsedMs` 時点の表示値。0 → `total` へ easeOutCubic で**単調非減少**に増える。
 *
 * boost の `rollupDisplayAt`(桁ロック方式)とは**別物**で、流用してはいけない:
 * あちらの契約は「確定済みの額を焦らして開示する」で、未確定桁は `spinDigit` の
 * 擬似乱数で回る。画面には 837 → 832 のような**増減しない数字**が出るので、
 * ユーザー要件の「数字がどんどん増えていく」には一切見えない。
 *
 * `elapsedMs` が負でも 0 を返し、`rollupMs` 以降は常に `total` を返す(呼び出し側の
 * rAF ループが1フレーム余分に回っても最終値が揺れない)。
 */
export function countUpDisplayAt(total: number, elapsedMs: number, rollupMs: number): number {
  const goal = Math.max(0, Math.round(total));
  if (rollupMs <= 0 || elapsedMs >= rollupMs) return goal;
  if (elapsedMs <= 0) return 0;
  const t = elapsedMs / rollupMs;
  const eased = 1 - Math.pow(1 - t, 3);
  // floor で「最後の1フレームだけ goal に届く」形にする(round だと t=0.99 で goal に
  // 到達してしまい、溜めの手前で数字が止まって見える)。
  return Math.min(goal, Math.floor(goal * eased));
}

/** 発射から着弾までを含めた総尺。モニターの安全弁と実演の previewMs はこれを使う。 */
export function giftScaleTotalWithStrikeMs(plan: GiftScalePlan): number {
  return plan.totalMs + STRIKE_TRAVEL_MAX_MS;
}

/**
 * `.float .f-amt` の基準フォントサイズ(倍率1換算)。monitor.css の
 * `font-size: calc(48px * var(--float-scale))` と同値。
 */
export const GIFT_SCALE_AMT_BASE_PX = 48;

/**
 * バナーの内寸(倍率1換算)。`.float` は width 260px・左右 padding 8px・枠 3px なので
 * 260 − (8+3)×2 = 238px。**にじみ(text-shadow)の逃げに少し余らせて 232px** を使う。
 */
export const GIFT_SCALE_AMT_INNER_PX = 232;

/**
 * `--num`(Segoe UI 等)の数字1文字の送り(em)。monitor.css の注記にある実測
 * 「10文字が 96px で 576px」= 0.6em を採る。桁区切りのカンマと符号はこれより細いので
 * この値は安全側(実際はもう少し余る)。
 */
export const GIFT_SCALE_AMT_ADVANCE_EM = 0.6;

/** これ以上小さくすると配信画面で読めない下限(倍率1換算)。 */
export const GIFT_SCALE_AMT_MIN_PX = 26;

/**
 * ダイヤ増減の額をバナー幅に収めるフォントサイズ(倍率1換算)。
 *
 * この機能の額は **−1,999,950(10文字)** まで伸びるので、基準の 48px のままだと
 * `.float .f-amt` の `text-overflow: ellipsis` に食われて「-125,…」のように
 * **桁が読めなくなる**(2026-08-27 実機で観測)。桁数から先に縮めておく。
 *
 * **確定後の文字数で決めること。** カウントアップの途中(短い数字)で決めると、
 * 桁が増えるたびに字が縮んで暴れる。
 */
export function giftScaleAmtFontPx(chars: number): number {
  if (chars <= 0) return GIFT_SCALE_AMT_BASE_PX;
  const fit = GIFT_SCALE_AMT_INNER_PX / (chars * GIFT_SCALE_AMT_ADVANCE_EM);
  return Math.max(GIFT_SCALE_AMT_MIN_PX, Math.min(GIFT_SCALE_AMT_BASE_PX, Math.floor(fit)));
}
