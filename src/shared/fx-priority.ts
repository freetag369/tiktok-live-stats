/**
 * 演出の優先順位の**唯一の権威**。左(index 小)ほど優先。
 *
 * 【規約 — 必読】**新しい演出・バナー種別を追加するときは、必ずこの序列の
 * どこに入るかを判断し、ユーザーに挿入位置を確認してからここへ登録すること。**
 * 未登録は `satisfies` と網羅 switch で typecheck が赤になり、値レベルの凍結は
 * fx-priority.spec.ts が赤になる(vitest は型検査をしないため両方必要)。
 *
 * 序列はユーザー決定(2026-08-16 確定):
 *   ①follow ②strike-like(いいね満タン) ③strike-stock(ストック満タン)
 *   ④boost ⑤helper(お助け) ⑥join-roulette(初見) ⑦band(カットイン)
 *   ⑧other(ギフトルーレット・コメント等リスト外全部)
 * boost が④なのはリアルタイム性の例外(原案は⑦) — フィーバーは worker 絶対時刻で
 * 走り(worker はルーレットでは凍結しない)、下位に回すと planBoostStart の期限切れ
 * で映像演出ごと消えるため、短尺の満タン系にだけ道を譲る位置をユーザーが選んだ。
 *
 * 序列と**遮蔽(shared/fx-occlusion.ts)は別軸**。序列は「いつ出すか」、遮蔽は
 * 「被さっている幕の下で何を出すか」。満タン系②③は舞台キューを迂回して常時実行
 * (fx-strike-route.ts)なので、カットイン中は序列ではなく遮蔽で見え方が決まる —
 * ルーレットの暗幕越しなら全部見せ、不透明カットインの下では音だけにする
 * (2026-08-17 ユーザー決定)。
 *
 * 「優先」は**待ち行列の取り出し順の並び替えのみ** — 再生中の演出は中断しない
 * (唯一の例外はルーレット連鎖のリール境界の譲り合い = shouldYieldSpinChain)。
 * achieved(CLEAR)は序列外の「並走再生」(開始スロットを消費しない)なので
 * この表に載せない — 載せると CLEAR が舞台を塞ぐ逆効果しかない(fx-drain.ts)。
 *
 * shared に置くのは fx-drain.ts / fx-stage.ts と同じ理由 — 決定ロジックを
 * 純関数として node のテストで固定する。
 */

import type { ChallengeEffect } from './dto';

export const FX_PRIORITY_ORDER = [
  'follow',
  'strike-like',
  'strike-stock',
  'boost',
  'helper',
  'join-roulette',
  'band',
  'other',
] as const;

export type FxPriorityClass = (typeof FX_PRIORITY_ORDER)[number];

/** ランク(FX_PRIORITY_ORDER の添字)。小さいほど優先。 */
export function fxRank(c: FxPriorityClass): number {
  return FX_PRIORITY_ORDER.indexOf(c);
}

// ── 登録簿1: ドレインキューの種別 ─────────────────────────────────────────
// fx-drain.ts の FxDrainQueues のキューと1対1。新キューを足すときはここへ登録。

export const FX_DRAIN_KINDS = ['strike', 'boost', 'join-roulette', 'band', 'roulette'] as const;
export type FxDrainKind = (typeof FX_DRAIN_KINDS)[number];

/**
 * ドレイン種別 → 優先クラス。strike は内容依存(like を含めば②・stock のみ③)
 * なので代表値だけここに置き、実ランクは strikeClass() で引く。
 */
export const DRAIN_PRIORITY = {
  strike: 'strike-like',
  boost: 'boost',
  'join-roulette': 'join-roulette',
  band: 'band',
  roulette: 'other', // ギフトルーレットは「その他」(ユーザー指定のリスト外)
} as const satisfies Record<FxDrainKind, FxPriorityClass>;

/** 保留着弾(pendingStrike の合算1件)の実クラス。like を含めば②、stock のみなら③。 */
export function strikeClass(p: { like: number; stock: number }): FxPriorityClass {
  return p.like > 0 ? 'strike-like' : 'strike-stock';
}

// ── 登録簿2: バナー(±N 浮上 .float)の種別 ────────────────────────────────
// pushFloat の必須引数。新しいバナーを足すと型エラーで必ずここへ来る。

export const FX_BANNER_KINDS = [
  'follow',
  'helper',
  'gift-card',
  'comment',
  'like-float',
  'stock-float',
  'roulette-result',
  'roulette-rest',
  'boost-announce',
  'boost-result',
] as const;
export type FxBannerKind = (typeof FX_BANNER_KINDS)[number];

export const BANNER_PRIORITY = {
  follow: 'follow',
  helper: 'helper',
  'gift-card': 'other',
  comment: 'other',
  'like-float': 'other',
  'stock-float': 'other',
  'roulette-result': 'other',
  'roulette-rest': 'other',
  // フィーバーのバナーは effect 側の分類(fxClassForEffect の boost-start /
  // boost-end → 'boost' = ④)と揃える。⑧のままだと bannerWinsByRank が厳密 <
  // 判定なので、band(⑦)のドレインが1件でもキューに居る限り**構造的に永久に
  // 勝てず**、フィーバー結果が出ないまま順番待ちの底に沈む(2026-08-17 修正)。
  'boost-announce': 'boost',
  'boost-result': 'boost',
} as const satisfies Record<FxBannerKind, FxPriorityClass>;

export function bannerRank(kind: FxBannerKind): number {
  return fxRank(BANNER_PRIORITY[kind]);
}

// ── 登録簿3: ChallengeEffect の全 kind の分類(網羅 switch) ────────────────

/**
 * effect 1件の優先クラス。'parallel' = 序列外の並走再生(achieved)。
 * ChallengeEffect['kind'] に新しい値を足すと、この switch が型エラーになる —
 * それが「新演出は必ず順位を判断せよ」の強制点。
 */
export function fxClassForEffect(e: ChallengeEffect): FxPriorityClass | 'parallel' {
  switch (e.kind) {
    case 'achieved':
      return 'parallel';
    case 'follow':
      return 'follow';
    case 'gauge-full':
      return 'strike-like';
    case 'stock-full':
      return 'strike-stock';
    case 'boost-start':
    case 'boost-end':
      return 'boost';
    case 'roulette':
      return e.rouletteOrigin === 'join' ? 'join-roulette' : 'other';
    case 'gift':
      // お助け(ファンスタンプ)は⑤。カットイン付きギフトは⑦。素のギフトは⑧。
      return e.fanStamp ? 'helper' : e.fxBandClip != null ? 'band' : 'other';
    case 'press':
    case 'like':
    case 'comment':
      return 'other';
    default:
      return assertNever(e.kind);
  }
}

function assertNever(x: never): never {
  throw new Error(`未登録の演出種別です — fx-priority.ts に順位を登録してください: ${String(x)}`);
}

// ── 判定ヘルパ ────────────────────────────────────────────────────────────

/**
 * ルーレット連鎖(リール境界)の譲り判定。待機中の最上位が自分より**厳密に**
 * 上位のときだけ譲る(同格・下位には譲らない)。譲り回数の上限は置かない —
 * 回転中の1本は必ず完走するので、譲りの1サイクルごとに連鎖は最低1リール進む
 * (進行保証があり livelock は構造的に起きない)。
 */
export function shouldYieldSpinChain(
  self: FxPriorityClass,
  waiting: readonly FxPriorityClass[]
): boolean {
  const mine = fxRank(self);
  return waiting.some((w) => fxRank(w) < mine);
}

/** 待機クラス群の最高ランク(最小添字)。空なら null。 */
export function bestRank(waiting: readonly FxPriorityClass[]): number | null {
  if (waiting.length === 0) return null;
  return Math.min(...waiting.map(fxRank));
}
