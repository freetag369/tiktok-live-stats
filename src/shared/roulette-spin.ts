/**
 * 1スピンぶんの再生方針 — 「フル尺か短縮(fast)か」と「超焦らし(jack 3種)の
 * カウントを通すか」の決定表。
 *
 * 【2026-08-17 ユーザー決定】連打(コンボ)の2本目以降を無条件で短縮する方式を
 * 廃止し、**本数**で切る:
 * - 1〜ROULETTE_FULL_REELS(15)本目 = フル尺(抽選パターンどおり 6/7.5/12/24秒)
 * - 16〜ROULETTE_REELS_MAX(20)本目 = 短縮(fast)
 * - 21本目以降 = 合算バナー1枚(rouletteReelPlan の rest 側の管轄)
 *
 * 併せて2つ:
 * - **激熱確定(hot)は本数に関係なく常にフル尺・超焦らしも素通し** — 倍率の段は
 *   ultra の donAts にしか無いので、短縮も jack への差し替えも倍率を消してしまう。
 * - **リールが2本以上ある effect では超焦らしのカウントを一切通さない** —
 *   worker が抽選したパターンをそのまま再生する(降格も強制発動もしない)。
 *   カウントが進むのはリール1本の単発ルーレットだけ。旧実装が「連打の1本目を
 *   並びの締めとして数える」としていた根拠(2本目以降は短縮でゴーストを出せない)
 *   がフル尺化で消滅したため。
 * - **凍結明け/キュー満杯の合算 effect(coalesced ≥ 2)は従来どおり1本目だけ
 *   フル尺**。合算は同じ盤面というだけで**別人どうし**を畳んでおり(worker の
 *   finishDrain / shared の mergeRoulette)、見出しは先頭の1人に固定される。
 *   フル尺化すると「別人20人ぶんが A さんの連打として2分回る」ので除外する。
 *
 * 'fast' の実装一式(ROULETTE_SPIN_FAST_MS / ROULETTE_REVEAL_FAST_MS /
 * RUN_BASE_FAST / ROULETTE_PATTERN_TIMING.fast / @keyframes rl-run-fast /
 * RouletteSpinKey の 'fast')は温存 — **発動条件だけがここに移った。**
 *
 * 【2026-08-20】**焦らし短縮(rush)** — ダッシュボードのライブトグル
 * (ChallengeState.rouletteRush、揮発)。ON の間は本数に関係なく短縮する。
 * startRoulette は毎リールここを呼び直すので「回転中の1本は完走し、次の
 * リールから短縮/OFF に戻せば次からフル尺」がリール境界で自然に成立する。
 * join / hot の免除はそのまま(rush より強い)。test(▶試写)も rush では
 * 短縮しない — 試写は抽選パターンをそのまま見せるのが目的。
 *
 * shared に置くのは fx-strike-route.ts / fx-drain.ts / roulette-tease.ts と
 * 同じ理由 — レンダラのテスト環境がこのリポジトリに無いので、決定ロジックを
 * 純関数として node の vitest で固定する(test/unit/roulette-spin.spec.ts)。
 */

import { ROULETTE_FULL_REELS } from './challenge';

/** planRouletteSpin の入力。すべて呼び出し側(startRoulette)が持っている値。 */
export interface RouletteSpinInput {
  /**
   * この effect の何本目か(0 始まり)。**再生ラン内の通番ではなく絶対位置** —
   * §6b の譲りは同じ effect を resumeAt = at + 1 で自キューへ戻すので、
   * ランごとに数え直すと譲るたびにカウンタが巻き戻り16本目がフル尺に戻る。
   */
  at: number;
  /** 実際に回すリール総数(rouletteReelPlan(e).reels.length)。 */
  reels: number;
  /** e.coalesced ?? 1。2以上 = 凍結明け/キュー満杯の合算(別人が混ざりうる)。 */
  coalesced: number;
  /** e.rouletteJoin === true。入室ルーレットは本数に関係なく常にフル尺。 */
  join: boolean;
  /** e.test === true(パターン別の ▶ 試写)。抽選パターンをそのまま見せる。 */
  test: boolean;
  /**
   * e.rouletteHotMult != null(激熱確定)。**短縮も超焦らしの差し替えも免除する。**
   *
   * 免除しないと値が壊れる: 倍率の段(ドン)は ROULETTE_PATTERN_TIMING の donAts に
   * 乗っているが、それを持つのは ultra だけ。超焦らしが lion を jackstop へ差し替えたり
   * (rouletteTeaseStep)、16本目以降が 'fast' になったりすると donAts が消え、
   * **リールは素の出目のまま止まるのに worker は 倍率込みの値を適用済み**という
   * 食い違いになる(確定バナーと 7セグだけが倍の数字を出す)。
   * 入室ルーレット(join)を丸ごと免除しているのと同じ構造の免除。
   */
  hot: boolean;
  /** 設定 challenge.rouletteTease.enabled(cfg 未取得は false)。 */
  teaseEnabled: boolean;
  /**
   * ChallengeState.rouletteRush === true(ダッシュボードの「焦らし短縮」ライブ
   * トグル)。ON なら本数に関係なく短縮する。join / hot / test は免除。
   */
  rush: boolean;
  /**
   * ギフトルーレットキューの残り件数。drainFxQueues は shift 済みなので、
   * これがそのまま「後続の並び」になる(runDrain のコメント参照)。
   */
  queueRest: number;
}

/** planRouletteSpin の出力。 */
export interface RouletteSpinPlan {
  /** true = 短縮スピン。setRoulette の fast / rouletteAbortMs のキーに使う。 */
  short: boolean;
  /**
   * null = 超焦らしカウントを**通さない**(素通し = 抽選パターンをそのまま再生)。
   * 非 null はそのまま rouletteTeaseStep の opts.lastOne へ渡す。
   */
  tease: { lastOne: boolean } | null;
}

/**
 * フル尺で回す本数。合算 effect は「同じ人の連打」ではないので1本だけ
 * (= ≤v0.7.7 の挙動)。入室ルーレットは short 側で丸ごと免除する。
 */
function fullReelsFor(coalesced: number): number {
  return coalesced > 1 ? 1 : ROULETTE_FULL_REELS;
}

/**
 * 短縮判定と超焦らしゲートを1本で返す。**short は draw.pattern に依存しない** —
 * 依存させると尺から出目の情報が漏れる経路が増える。
 */
export function planRouletteSpin(s: RouletteSpinInput): RouletteSpinPlan {
  // 激熱確定は本数に関係なく常にフル尺(入室ルーレットと同じ免除)。倍率の段は
  // ultra の donAts にしか無いので、短縮すると倍率が一度も上がらない。
  // rush(焦らし短縮トグル)は本数の境界を無視して短縮に倒す。ただし ▶試写は
  // 抽選パターンをそのまま見せるのが目的なので rush では潰さない(既存の
  // 本数境界側は従来どおり test を見ない = 挙動凍結)。
  const short =
    !s.join && !s.hot && (s.at >= fullReelsFor(s.coalesced) || (s.rush && !s.test));
  // 素通しの条件。短縮スピンは段が無くてゴーストを出せないので元から対象外。
  // 激熱確定も素通し — 超焦らしの差し替え先(jack 3種)は heavy 段位で donAts を
  // 持たないため、通すと倍率が消える。
  const skip = short || s.hot || s.reels > 1 || s.join || s.test || !s.teaseEnabled;
  if (skip) return { short, tease: null };
  // ここに来るのは reels === 1 のときだけ = at は常に 0(単発 effect は
  // more が偽なので §6b の unshift を通れず resumeAt > 0 になり得ない)。
  // 式に at === 0 を残すのは「並びの最後の1本」という座標の意味の明示。
  return { short, tease: { lastOne: s.at === 0 && s.queueRest === 0 } };
}
