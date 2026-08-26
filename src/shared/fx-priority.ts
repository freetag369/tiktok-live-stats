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
 *   ④boost ④.5 tap-lock(お邪魔) ⑤helper(お助け) ⑥join-roulette(初見)
 *   ⑥.5 hot-roulette(激熱確定ルーレット)
 *   ⑦band(カットイン)
 *   ⑧other(ギフトルーレット・コメント等リスト外全部)
 * ⑥.5 hot-roulette は 2026-08-18 にユーザーが band の直前を選択。激熱確定は
 * 「その回だけ倍率が本物になる」1本 43 秒の山場で、専用ギフトでしか出ない —
 * 通常のギフトルーレット(⑧)と同じ列で待たせると、先に届いた普通のスピンの
 * 後ろで数分待つことになり、視聴者が撃った瞬間との因果が読めなくなる。
 * band より上なのは、カットインは何度でも出るが激熱確定は出ないから。
 * boost が④なのはリアルタイム性の例外(原案は⑦) — フィーバーは worker 絶対時刻で
 * 走り(worker はルーレットでは凍結しない)、下位に回すと planBoostStart の期限切れ
 * で映像演出ごと消えるため、短尺の満タン系にだけ道を譲る位置をユーザーが選んだ。
 * ④.5 tap-lock(お邪魔・タップ封じ)は 2026-08-18 にユーザーが boost の直後を選択。
 * 理由は boost が④に居るのと同じ — 封印は worker の絶対時刻で走り、モニターが何を
 * 再生していようが時間は減る。band(⑦)の後ろに並べると、band のドレインが数本
 * 詰まっただけで「残り数秒」になってから告知バナーが出る(= 何が起きたか分からない
 * まま復帰する)。boost より下なのはフィーバーのほうが大きな山場だから。
 * ⑦.5 revolution(革命)は 2026-08-20 にユーザーが「通常ギフトルーレットの前だけ」を
 * 選択(band と other の間。初見⑥・激熱確定⑥.5 は革命より上のまま)。革命は
 * お助け系だが helper(⑤)には同居させない — あちらはファンスタンプの±Nバナーで、
 * こちらは 11 秒の導入カットイン+窓を持つ別種の山場。
 * ⑦.55 universe(一撃クリア・TIKTOK UNIVERSE 44,999💎)は 2026-08-26 にユーザーが
 * revolution の直後(quiz の直前)を選択。カウントを 0 にしてランを終わらせる
 * 25 秒の山場(導入カット8秒 + 30段の減算連打9秒 + 締めカット8秒)。band(⑦)より
 * 下なのは revolution と同じ位置づけ。**開始順は quiz と同じくこの表では決まらない**
 * — バリア方式(モニターの universe.armed 監視 + worker の universeDeferredOps)が
 * 支配する。ここへの登録は universe-end の持ち越しとバナーの取り出し順の保険。
 * ⑤.6 lion(ライオン・Lion 29,999💎)は 2026-08-26 にユーザーが「お助けの直後・
 * 初見ルーレットより上」を選択。カウントを +1,499,950(29,999 × 50)積み上げる
 * 43 秒の妨害(導入カット10秒 + 29,999 が1枚 + ボイス + 49 連打12秒 + 全面カット10秒
 * + 合計発表5秒)。gift-scale(⑤.5)の直後なのは、あちらの「お助けの直後」という
 * 決定(同日・fx-priority.spec が等式で凍結)を崩さずに実質の要件(初見・激熱確定・
 * band より先)を満たせるから — gift-scale は 1.6 秒の浮上バナーなので、43 秒の幕の
 * 前に通しても失うものが無い。**開始順は universe / quiz と同じくこの表では決まらない**
 * — バリア方式(モニターの lion.armed 監視 + worker の lionDeferredOps)が支配する。
 * ここへの登録は lion-end のバナーの取り出し順の保険。
 * ⑦.6 quiz(お題ルーレット)は 2026-08-21 に追加。序列上は revolution の直後だが、
 * **実際の開始順はこの表では決まらない** — ユーザー決定は「発動時点で溜まっていた
 * キューを全部消化してから開始・発動以降のキューは優先が高くても後回し」の
 * バリア方式で、モニターは quiz.armed の間ドレインが空になるのを待ってから
 * 始動する(worker 側は armedQuiz バリアで以降のイベントを清算まで deferred)。
 * ここへの登録は quiz-end(結果発表)の持ち越しキューとバナーの取り出し順の保険。
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
  'tap-lock',
  'helper',
  // ダイヤ増減の「N 浮上 → カウントアップ → ドン」(2026-08-26 ユーザー決定 —
  // お助けの直後・入室ルーレットより先)。高額ギフトの手応えを他の演出に埋もれさせない。
  'gift-scale',
  // ライオン(Lion 29,999💎 の妨害・43秒のカットシーン)(2026-08-26 ユーザー決定 —
  // 「お助けの直後・初見ルーレットより上」)。gift-scale の**直後**に置くのは、
  // あちらが 1.6 秒の浮上バナーで「高額ギフトの手応えを埋もれさせない」ためだけの
  // 軽い演出だから — 43 秒の幕の前に通してやっても失うものが無く、gift-scale 側の
  // 「お助けの直後」というユーザー決定(fx-priority.spec が等式で凍結)も保てる。
  // 実質の要件(初見・激熱確定・band より先に出す)はこの位置で満たされる。
  'lion',
  'join-roulette',
  'hot-roulette',
  'band',
  'revolution',
  'universe',
  'quiz',
  'other',
] as const;

export type FxPriorityClass = (typeof FX_PRIORITY_ORDER)[number];

/** ランク(FX_PRIORITY_ORDER の添字)。小さいほど優先。 */
export function fxRank(c: FxPriorityClass): number {
  return FX_PRIORITY_ORDER.indexOf(c);
}

// ── 登録簿1: ドレインキューの種別 ─────────────────────────────────────────
// fx-drain.ts の FxDrainQueues のキューと1対1。新キューを足すときはここへ登録。

export const FX_DRAIN_KINDS = [
  'strike',
  'boost',
  'join-roulette',
  'hot-roulette',
  'band',
  'revolution',
  'quiz',
  'roulette',
] as const;
export type FxDrainKind = (typeof FX_DRAIN_KINDS)[number];

/**
 * ドレイン種別 → 優先クラス。strike は内容依存(like を含めば②・stock のみ③)
 * なので代表値だけここに置き、実ランクは strikeClass() で引く。
 */
export const DRAIN_PRIORITY = {
  strike: 'strike-like',
  boost: 'boost',
  'join-roulette': 'join-roulette',
  'hot-roulette': 'hot-roulette', // 激熱確定(cfg.roulettes[].hot)は band の直前
  band: 'band',
  revolution: 'revolution', // 革命は band の直後・通常ギフトルーレットの直前(2026-08-20)
  quiz: 'quiz', // お題ルーレット(quiz-end の結果発表)は revolution の直後(2026-08-21)
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
  'gift-scale',
  'comment',
  'like-float',
  'stock-float',
  'roulette-result',
  'roulette-rest',
  'roulette-result-hot',
  'roulette-rest-hot',
  'boost-announce',
  'boost-result',
  'tap-lock',
  'revolution-announce',
  'revolution-result',
  'universe',
  'lion',
  'quiz-announce',
  'quiz-result',
] as const;
export type FxBannerKind = (typeof FX_BANNER_KINDS)[number];

export const BANNER_PRIORITY = {
  follow: 'follow',
  helper: 'helper',
  'gift-card': 'other',
  // ダイヤ増減のバナーは effect 側の分類(fxClassForEffect の 'gift-scale')と揃える。
  // 'other' のままだと bannerWinsByRank の厳密 < 判定で band(⑨)のドレインに
  // 構造的に永久に負け、飢餓弁(BANNER_STARVE_MS)が開くまで結果が出ない —
  // boost-announce / tap-lock / roulette-*-hot / revolution / quiz が踏んだのと同じ罠。
  'gift-scale': 'gift-scale',
  comment: 'other',
  'like-float': 'other',
  'stock-float': 'other',
  'roulette-result': 'other',
  'roulette-rest': 'other',
  // 激熱確定のバナーは effect 側の分類(fxClassForEffect の 'hot-roulette')と揃える。
  // ⑧のままだと bannerWinsByRank の厳密 < 判定で band(⑦)のドレインに勝てず、
  // 飢餓弁(BANNER_STARVE_MS)が開くまで確定額が読めない — boost-announce /
  // tap-lock が 2026-08-17 に同じ罠で修正されたのと同型。
  'roulette-result-hot': 'hot-roulette',
  'roulette-rest-hot': 'hot-roulette',
  // フィーバーのバナーは effect 側の分類(fxClassForEffect の boost-start /
  // boost-end → 'boost' = ④)と揃える。⑧のままだと bannerWinsByRank が厳密 <
  // 判定なので、band(⑦)のドレインが1件でもキューに居る限り**構造的に永久に
  // 勝てず**、フィーバー結果が出ないまま順番待ちの底に沈む(2026-08-17 修正)。
  'boost-announce': 'boost',
  'boost-result': 'boost',
  // お邪魔の告知バナーは effect 側の分類(fxClassForEffect の tap-lock)と揃える —
  // 揃えないと bannerWinsByRank の厳密 < 判定で band のドレインに永久に負ける。
  'tap-lock': 'tap-lock',
  // 革命のバナーも effect 側の分類(revolution-start/-end → 'revolution')と揃える —
  // boost-announce / tap-lock / roulette-*-hot が踏んだのと同じ罠(厳密 < 判定)の予防。
  'revolution-announce': 'revolution',
  'revolution-result': 'revolution',
  // 一撃クリアのバナーも effect 側の分類(universe-start/-end → 'universe')と揃える。
  // 1種類しか無いのは、25 秒の演出が終わってから「誰が撃ったか」を1枚出すだけだから
  // (発動の告知は幕そのものが兼ねる)。
  universe: 'universe',
  // ライオンのバナーも effect 側の分類(lion-start/-end → 'lion')と揃える。
  // universe と同じく1種類だけ — 43 秒のカットシーンが終わってから「誰が撃ったか」を
  // 1枚出すだけで、発動の告知は幕そのものが兼ねる。
  lion: 'lion',
  // お題ルーレットのバナーも effect 側の分類(quiz-start/-end → 'quiz')と揃える —
  // 'other' のままだと bannerWinsByRank の厳密 < 判定で band のドレインに永久に負ける
  // (boost-announce / tap-lock / revolution が踏んだのと同じ罠)。
  'quiz-announce': 'quiz',
  'quiz-result': 'quiz',
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
    case 'tap-lock':
      return 'tap-lock';
    case 'boost-start':
    case 'boost-end':
      return 'boost';
    case 'revolution-start':
    case 'revolution-end':
      return 'revolution';
    case 'universe-start':
    case 'universe-end':
      // universe-start はドレインキューに積まない(モニターが universe.armed の
      // 監視で始動するバリア方式)。universe-end も結果カットシーンを持たない
      // (締めのカットインは 25 秒の中)ので、この分類が効くのはバナーの
      // 取り出し順だけ — それでも登録するのは、'other' のままだと
      // bannerWinsByRank の厳密 < 判定で band のドレインに永久に負けるため。
      return 'universe';
    case 'lion-start':
    case 'lion-end':
      // universe とまったく同じ構造 — lion-start はドレインキューに積まない
      // (モニターが lion.armed の監視で始動するバリア方式)。lion-end も結果
      // カットシーンを持たない(合計の発表は 43 秒の中の最後の段)ので、この分類が
      // 効くのはバナーの取り出し順だけ。それでも登録するのは 'other' のままだと
      // bannerWinsByRank の厳密 < 判定で band のドレインに永久に負けるため。
      return 'lion';
    case 'quiz-start':
    case 'quiz-end':
      // quiz-start はドレインキューに積まない(モニターが armed 監視で始動する
      // バリア方式)ので、この分類が効くのは quiz-end(結果発表)の持ち越しだけ。
      return 'quiz';
    case 'roulette':
      // 入室(⑥)→ 激熱確定(⑥.5)→ 通常のギフトルーレット(⑧)。入室を先に見るのは
      // 入室ルーレットが hot を持たない(RouletteHotConfig の解説)ので排他だから。
      return e.rouletteOrigin === 'join'
        ? 'join-roulette'
        : e.rouletteHotMult != null
          ? 'hot-roulette'
          : 'other';
    case 'gift':
      // お助け(ファンスタンプ)は⑥。ダイヤ増減の浮上は⑦。カットイン付きギフトは⑨。
      // 素のギフトは⑫。giftScale をカットインより先に見るのは、カットインが
      // 終わってから浮上へバトンタッチする(モニターの finishBandFx)ので、
      // 順番待ちの中では浮上としての順位で扱うのが正しいため。
      return e.fanStamp
        ? 'helper'
        : e.giftScale === true
          ? 'gift-scale'
          : e.fxBandClip != null
            ? 'band'
            : 'other';
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
