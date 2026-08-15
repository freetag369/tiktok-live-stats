/**
 * 演出終了時の「持ち越しキュー」ドレイン方針。
 *
 * モニターの排他規約: 据え置き(heldValue)の持ち主は常に1人。ルーレット/
 * カットイン/ブースト/ストック着弾の各 finish は、末尾で持ち越しキューから
 * **次の1演出だけ**を選んで開始し、何も無ければ保留中のいいね着弾
 * (pendingStrike)を流す。この「どのキューをどの順で見るか」が4箇所の
 * finish にインラインで重複しており、安全弁(expire)経路がこの連鎖を持たず
 * キューが宙に浮くバグの温床だった — 方針をここに一本化する。
 *
 * 順序は2種類:
 * - 'roulette-first': finishRoulette 用。自キュー(スピンの連鎖)を優先するが、
 *                     **ブーストだけはさらに先** — worker のフィーバーは絶対時刻で
 *                     走る(worker はルーレットでは凍結しない)ので、スピン連鎖の
 *                     後ろに並ばせると planBoostStart の期限切れで演出ごと消える。
 *                     ルーレットの値は適用済みで、表示が後回しになっても失われない。
 * - 'standard':       finishBandFx / finishStockCutin / finishBoostFx / expire 用。
 *                     ブースト(タップのゲーム性を持つので待たせない)→ カットイン
 *                     → スピンの順。
 *
 * achieved(CLEAR 演出)は常に最初に取り出して「再生」する — 開始スロットは
 * 消費しない(リザルトは独立タイマーで出るため、次演出と並走してよい)。
 *
 * shared に置くのは live-rows.ts / challenge.ts の appendChallengeLog と同じ理由 —
 * レンダラのテスト環境がこのリポジトリに無いので、決定ロジックを純関数として
 * ここへ抽出して node のテストで固定する。キュー配列は in-place で shift する。
 */

export type FxDrainOrder = 'roulette-first' | 'standard';

export interface FxDrainQueues<T> {
  /** CLEAR 演出の持ち越し(1件)。呼び出し側は戻り値の achieved を再生したら null に戻すこと。 */
  achieved: T | null;
  /** 他演出中に届いたブースト(4件上限は積む側の規約)。 */
  boosts: T[];
  /** 他演出中に届いたカットイン(2件上限は積む側の規約)。 */
  bands: T[];
  /** 他演出中に届いたルーレット(ROULETTE_QUEUE_MAX は積む側の規約)。 */
  roulettes: T[];
}

export interface FxDrainResult<T> {
  /** 先に「再生」すべき CLEAR 演出(開始スロットを消費しない)。 */
  achieved: T | null;
  /** 次に「開始」すべき演出。null = 開始するものが無い。 */
  next: { kind: 'roulette' | 'boost' | 'band'; effect: T } | null;
  /**
   * 保留中のいいね着弾(drainPendingStrike)を流してよいか。次演出を始める
   * パスでは流さない — start* の冒頭 flushStrike に出したばかりのチェーンを
   * 畳ませないため(finishRoulette の従来コメントの規約)。
   */
  drainStrike: boolean;
}

export function drainFxQueues<T>(q: FxDrainQueues<T>, order: FxDrainOrder): FxDrainResult<T> {
  const achieved = q.achieved;
  const take = (kind: 'roulette' | 'boost' | 'band', arr: T[]): FxDrainResult<T> | null => {
    const e = arr.shift();
    return e === undefined ? null : { achieved, next: { kind, effect: e }, drainStrike: false };
  };
  const seq: Array<['roulette' | 'boost' | 'band', T[]]> =
    order === 'roulette-first'
      ? [
          ['boost', q.boosts],
          ['roulette', q.roulettes],
          ['band', q.bands],
        ]
      : [
          ['boost', q.boosts],
          ['band', q.bands],
          ['roulette', q.roulettes],
        ];
  for (const [kind, arr] of seq) {
    const r = take(kind, arr);
    if (r) return r;
  }
  return { achieved, next: null, drainStrike: true };
}

/**
 * 1回の runFxDrain で試す最大件数。到達しない上限(下の停止性の議論を参照)で、
 * 将来 start が新たにキューへ積むようになった場合の暴走止め。
 * **各キューの上限を上げたらここも上げること** — 到達可能になると
 * 「まだ残っているのに drainStrike へ倒れる」= 持ち越しが1周ぶん遅れる。
 */
export const FX_DRAIN_MAX_STEPS = 64;

export interface FxDrainStep<T> {
  kind: 'roulette' | 'boost' | 'band';
  effect: T;
}

export interface FxDrainRun<T> {
  /** 先に「再生」した CLEAR 演出(開始スロットを消費しない)。 */
  achieved: T | null;
  /** 実際に開始した演出。null = 誰も始まらなかった。 */
  started: FxDrainStep<T> | null;
  /** 断られて捨てた演出(捨てた順・ログ用)。 */
  skipped: FxDrainStep<T>[];
  /** 保留着弾を流してよいか。started === null と常に一致する。 */
  drainStrike: boolean;
}

/**
 * 「何かが実際に始まるまで」ドレインし続けるドライバ。
 *
 * 従来の呼び出し側は drainFxQueues の結果を**1件だけ**試し、start* が断った場合
 * (素材欠損 / prefers-reduced-motion / 期限切れ)でもそのまま return していた。
 * 断られると hold が張られず onIdle も drainPendingStrike も走らないので、
 * pendingStrike が宙に浮いたまま floatHoldState().strikePending が true で固着し、
 * 以降のいいね/ストックのバナーが shouldDeferFloat で**永久に**保留される。
 * 正しくは「断られたら次のキューへ落ちる」で、出口は必ず
 * 「started(誰かが始まった)」か「drainStrike(誰も始まらなかった)」の2つだけ。
 *
 * 停止性: drainFxQueues は next を返す前にキューから shift 済みなので、各周回は
 * 必ず return するか要素を1つ消費する。start は積まない(3つの start* は effect を
 * 読むだけ)ので、上限は boosts(4) + bands(4) + roulettes(24) + 1 = 33 < 64。
 * maxSteps に達した場合も **drainStrike: true** 側へ倒す — pendingStrike を
 * 宙に浮かせないことを最優先する。
 *
 * drainFxQueues 本体は1文字も変えない(test/unit/fx-drain.spec.ts の順序契約を維持)。
 */
export function runFxDrain<T>(
  q: FxDrainQueues<T>,
  order: FxDrainOrder,
  hooks: {
    /** CLEAR 演出の再生。最初の1回だけ、どの start よりも前に呼ばれる。 */
    playAchieved?: (e: T) => void;
    /** 演出の開始。false = 断った(次のキューへ落ちる)。 */
    start: (kind: 'roulette' | 'boost' | 'band', effect: T) => boolean;
  },
  maxSteps: number = FX_DRAIN_MAX_STEPS
): FxDrainRun<T> {
  let achieved: T | null = null;
  const skipped: FxDrainStep<T>[] = [];
  for (let i = 0; i < maxSteps; i++) {
    const r = drainFxQueues(q, order);
    if (r.achieved !== null && achieved === null) {
      achieved = r.achieved;
      // 2周目以降に同じ CLEAR を拾わせない(再生は1回だけ)。
      q.achieved = null;
      hooks.playAchieved?.(r.achieved);
    }
    if (!r.next) return { achieved, started: null, skipped, drainStrike: true };
    if (hooks.start(r.next.kind, r.next.effect)) {
      return { achieved, started: r.next, skipped, drainStrike: false };
    }
    skipped.push(r.next);
  }
  return { achieved, started: null, skipped, drainStrike: true };
}
