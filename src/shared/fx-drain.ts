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
 * 順序は2種類あり、**どちらも従来挙動の保存**(統一ではない):
 * - 'roulette-first': finishRoulette 用。自キュー(短縮スピンの連鎖)を最優先。
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
  /** 他演出中に届いたブースト(2件上限は積む側の規約)。 */
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
          ['roulette', q.roulettes],
          ['boost', q.boosts],
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
