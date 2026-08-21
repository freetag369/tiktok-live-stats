/**
 * 演出終了時の「持ち越しキュー」ドレイン方針。
 *
 * モニターの排他規約: 据え置き(heldValue)の持ち主は常に1人。各 finish は
 * 末尾で持ち越しキューから**次の1演出だけ**を選んで開始する。「どのキューを
 * どの順で見るか」の権威は **fx-priority.ts の FX_PRIORITY_ORDER**(ユーザー決定の
 * 8ランク序列)で、ここはそれをキュー走査に写すだけ — 順序リテラルを二重に
 * 持たない(かつては 'roulette-first'/'standard' の2順序がここに直書きされて
 * いたが、序列の一元化で廃止した)。
 *
 * strike(いいね満タン/ストック満タンの保留着弾)は序列②③の一級市民。
 * かつては「誰も始まらなかったときだけ流すフォールスルー」で、ルーレットや
 * カットインに常に追い越されていた(ユーザー実機検証で確認された実害)。
 * さらに 2026-08-16 の「着弾は常時実行」(shared/fx-strike-route.ts)で、strike は
 * 通常このドレインを**通らなくなった** — 飛行中の合算はチェーン終端の直結、
 * カットイン中は visuals-only ビートで即時に出る。ここの strike キューは安全弁・
 * 番犬・レースで pendingStrike に残った分を拾う最後の網として残している
 * (序列②③の凍結はユーザー決定のまま変更しない)。
 *
 * achieved(CLEAR 演出)は序列外 — 常に最初に取り出して「再生」する。開始
 * スロットは消費しない(リザルトは独立タイマーで出るため、次演出と並走してよい)。
 *
 * shared に置くのは live-rows.ts / fx-stage.ts と同じ理由 — レンダラのテスト環境が
 * このリポジトリに無いので、決定ロジックを純関数として node のテストで固定する。
 * キュー配列は in-place で shift する。
 */

import { DRAIN_PRIORITY, FX_DRAIN_KINDS, fxRank, strikeClass, type FxDrainKind } from './fx-priority';

/** 保留着弾の合算(pendingStrike)。like/stock を1本のチェーンに畳む既存設計のまま。 */
export interface FxStrikePending {
  like: number;
  stock: number;
}

/**
 * T = 素の effect(boosts/bands)。R = ルーレットキューの要素型 — レンダラは
 * 連鎖の譲り合い(リール境界プリエンプション)の再開位置を持つラッパー
 * `{ e, resumeAt, queuedAtMs }` を入れる。既定 R=T なのでラッパーを使わない
 * テストは従来どおり素の effect で書ける。ここは要素の中身を一切覗かない。
 */
export interface FxDrainQueues<T, R = T> {
  /** CLEAR 演出の持ち越し(1件)。呼び出し側は戻り値の achieved を再生したら null に戻すこと。 */
  achieved: T | null;
  /** 保留着弾の合算(1件)。取り出し側が null へ戻す(shift と同じ「先に取る」規律)。 */
  strike: FxStrikePending | null;
  /** 他演出中に届いたブースト(PENDING_BOOSTS_MAX は積む側の規約)。 */
  boosts: T[];
  /** 他演出中に届いたカットイン(PENDING_BANDS_MAX は積む側の規約)。 */
  bands: T[];
  /** 他演出中に届いた革命の導入カットイン(PENDING_REVOLUTIONS_MAX は積む側の規約)。 */
  revolutions: T[];
  /**
   * お題ルーレットの結果発表(quiz-end)の持ち越し(PENDING_QUIZZES_MAX は積む側の
   * 規約)。**quiz-start はここへ積まない** — 開始はモニターの armed 監視(バリア
   * 方式)が担い、ドレインには乗らない非対称。
   */
  quizzes: T[];
  /** 初見(入室)ルーレット(JOIN_ROULETTE_QUEUE_MAX は積む側の規約)。 */
  joinRoulettes: R[];
  /** 激熱確定ルーレット(ROULETTE_HOT_QUEUE_MAX は積む側の規約)。 */
  hotRoulettes: R[];
  /** ギフトルーレット(ROULETTE_QUEUE_MAX は積む側の規約)。 */
  roulettes: R[];
}

export type FxDrainNext<T, R = T> =
  | { kind: 'strike'; strike: FxStrikePending }
  | { kind: 'boost'; effect: T }
  | { kind: 'band'; effect: T }
  | { kind: 'revolution'; effect: T }
  | { kind: 'quiz'; effect: T }
  | { kind: 'join-roulette'; effect: R }
  | { kind: 'hot-roulette'; effect: R }
  | { kind: 'roulette'; effect: R };

export interface FxDrainResult<T, R = T> {
  /** 先に「再生」すべき CLEAR 演出(開始スロットを消費しない)。 */
  achieved: T | null;
  /** 次に「開始」すべき演出。null = 開始するものが無い。 */
  next: FxDrainNext<T, R> | null;
}

/**
 * ドレイン種別の走査順。FX_PRIORITY_ORDER から導出する(ここに並びを直書き
 * しない)。strike は like/stock で②/③に割れるが、どちらも boost(④)より
 * 上なので走査位置は常に先頭 — 実クラスは strikeClass() が権威。
 */
export const FX_DRAIN_SEQ: readonly FxDrainKind[] = [...FX_DRAIN_KINDS].sort(
  (a, b) => fxRank(DRAIN_PRIORITY[a]) - fxRank(DRAIN_PRIORITY[b])
);

/**
 * ルーレット系3種(初見・激熱確定・ギフト)のキューを種別から引く。分岐を1箇所に
 * 閉じるのは、走査(drainFxQueues)・先読み(peekNextDrainKind)・ランク集計
 * (bestDrainRank)の3つが同じ対応表を使う担保がこれしかないため。
 */
function rouletteQueueOf<T, R>(
  q: FxDrainQueues<T, R>,
  kind: 'join-roulette' | 'hot-roulette' | 'roulette'
): R[] {
  return kind === 'join-roulette'
    ? q.joinRoulettes
    : kind === 'hot-roulette'
      ? q.hotRoulettes
      : q.roulettes;
}

export function drainFxQueues<T, R = T>(q: FxDrainQueues<T, R>): FxDrainResult<T, R> {
  const achieved = q.achieved;
  for (const kind of FX_DRAIN_SEQ) {
    // どの分岐も「返す前にキューから取る」規律(shift-before-return)を守る —
    // runFxDrain の停止性(各周回は必ず1要素消費する)の根拠。
    if (kind === 'strike') {
      if (q.strike !== null) {
        const strike = q.strike;
        q.strike = null;
        return { achieved, next: { kind, strike } };
      }
    } else if (kind === 'boost' || kind === 'band' || kind === 'revolution' || kind === 'quiz') {
      const e = (
        kind === 'boost' ? q.boosts : kind === 'band' ? q.bands : kind === 'revolution' ? q.revolutions : q.quizzes
      ).shift();
      if (e !== undefined) return { achieved, next: { kind, effect: e } };
    } else {
      const e = rouletteQueueOf(q, kind).shift();
      if (e !== undefined) return { achieved, next: { kind, effect: e } };
    }
  }
  return { achieved, next: null };
}

/**
 * 次に出るドレイン種別を**取り出さずに**覗く。finishRoulette の BGM 即断
 * (次がルーレット系なら鳴りっぱなし/カットイン系なら即断)と、連鎖の
 * 譲り判定のログ用。
 */
export function peekNextDrainKind<T, R = T>(q: FxDrainQueues<T, R>): FxDrainKind | null {
  for (const kind of FX_DRAIN_SEQ) {
    const has =
      kind === 'strike'
        ? q.strike !== null
        : kind === 'boost'
          ? q.boosts.length > 0
          : kind === 'band'
            ? q.bands.length > 0
            : kind === 'revolution'
              ? q.revolutions.length > 0
              : kind === 'quiz'
                ? q.quizzes.length > 0
                : rouletteQueueOf(q, kind).length > 0;
    if (has) return kind;
  }
  return null;
}

/**
 * 待機中ドレインの最高ランク(最小添字)。空なら null。strike は内容依存
 * (like 含み=②/stock のみ=③)なので strikeClass で実クラスを引く。
 * pickStageNext のバナー vs ドレイン比較の入力。
 */
export function bestDrainRank<T, R = T>(q: FxDrainQueues<T, R>): number | null {
  let best: number | null = null;
  const consider = (rank: number): void => {
    if (best === null || rank < best) best = rank;
  };
  if (q.strike !== null) consider(fxRank(strikeClass(q.strike)));
  if (q.boosts.length > 0) consider(fxRank(DRAIN_PRIORITY.boost));
  if (q.bands.length > 0) consider(fxRank(DRAIN_PRIORITY.band));
  if (q.revolutions.length > 0) consider(fxRank(DRAIN_PRIORITY.revolution));
  if (q.quizzes.length > 0) consider(fxRank(DRAIN_PRIORITY.quiz));
  if (q.joinRoulettes.length > 0) consider(fxRank(DRAIN_PRIORITY['join-roulette']));
  if (q.hotRoulettes.length > 0) consider(fxRank(DRAIN_PRIORITY['hot-roulette']));
  if (q.roulettes.length > 0) consider(fxRank(DRAIN_PRIORITY.roulette));
  return best;
}

/**
 * 1回の runFxDrain で試す最大件数。到達しない上限(下の停止性の議論を参照)で、
 * 将来 start が新たにキューへ積むようになった場合の暴走止め。
 * **各キューの上限を上げたらここも上げること** — 到達可能になると
 * 「まだ残っているのに idle へ倒れる」= 持ち越しが1周ぶん遅れる。
 * 見積: strike(1) + boosts(4) + bands(4) + revolutions(3) + quizzes(2) +
 * joinRoulettes(4) + hotRoulettes(8) + roulettes(24) + 1 = 51 < 64。
 * (revolutions は結果カットシーン導入時に 2→3 — この行の更新漏れが2度起きたので、
 * 検算は fx-drain.spec の「上限の到達不能性」テストが定数から導出して固定している。)
 */
export const FX_DRAIN_MAX_STEPS = 64;

export interface FxDrainRun<T, R = T> {
  /** 先に「再生」した CLEAR 演出(開始スロットを消費しない)。 */
  achieved: T | null;
  /** 実際に開始した演出。null = 誰も始まらなかった(idle — 保留バナー回収へ)。 */
  started: FxDrainNext<T, R> | null;
  /** 断られて捨てた演出(捨てた順・ログ用)。 */
  skipped: FxDrainNext<T, R>[];
}

/**
 * 「何かが実際に始まるまで」ドレインし続けるドライバ。
 *
 * start が断った場合(素材欠損 / prefers-reduced-motion / 期限切れ / 据え置け
 * ない strike)は次のキューへ落ちる。出口は必ず「started(誰かが始まった)」か
 * 「started: null(誰も始まらなかった = idle)」の2つだけ — 従来の drainStrike
 * フラグは strike の一級市民化で廃止し、idle 時の保留バナー回収は呼び出し側の
 * started === null 分岐が担う。
 *
 * 停止性: drainFxQueues は next を返す前にキューから取り済みなので、各周回は
 * 必ず return するか要素を1つ消費する。start は積まない(各 start* は effect を
 * 読むだけ)。maxSteps に達した場合も started: null 側へ倒す。
 */
export function runFxDrain<T, R = T>(
  q: FxDrainQueues<T, R>,
  hooks: {
    /** CLEAR 演出の再生。最初の1回だけ、どの start よりも前に呼ばれる。 */
    playAchieved?: (e: T) => void;
    /** 演出の開始。false = 断った(次のキューへ落ちる)。 */
    start: (next: FxDrainNext<T, R>) => boolean;
  },
  maxSteps: number = FX_DRAIN_MAX_STEPS
): FxDrainRun<T, R> {
  let achieved: T | null = null;
  const skipped: FxDrainNext<T, R>[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = drainFxQueues(q);
    if (r.achieved !== null && achieved === null) {
      achieved = r.achieved;
      // 2周目以降に同じ CLEAR を拾わせない(再生は1回だけ)。
      q.achieved = null;
      hooks.playAchieved?.(r.achieved);
    }
    if (!r.next) return { achieved, started: null, skipped };
    if (hooks.start(r.next)) {
      return { achieved, started: r.next, skipped };
    }
    skipped.push(r.next);
  }
  return { achieved, started: null, skipped };
}
