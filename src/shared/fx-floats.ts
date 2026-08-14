/**
 * 保留バナー(いいね妨害 / いいねストック満杯)を「今出すか、持ち越すか」の方針。
 *
 * モニターの規約: これらのバナーは着弾の瞬間に出す —「アニメーション → 通知」。
 * そのため playEffect は演出中に届いたバナーを pendingLikeFloats /
 * pendingStockFloats へ積み、着弾(impactStrike / revealStock)で流す。
 *
 * 問題は「積んだバナーを誰が出すか」が strikeTimers(飛行中チェーン)だけを
 * 見て決まっていたこと。実際にはバナーの持ち主は3種類あり、どれか1つでも
 * 生きていれば後で必ず出る:
 *   - chainActive:   飛行中の着弾チェーン(着弾で出る)
 *   - strikePending: 横取りで pendingStrike へ戻された持ち越し
 *                    (演出明けの drainPendingStrike が本番のチェーンで出す)
 *   - cutinActive:   ルーレット/バンド/ストック/ブーストのカットイン中
 *                    (終了時のウォッチドッグが出す)
 * chainActive しか見ないと、
 *   1. 横取り(startRoulette/startBandFx/startBoostFx 冒頭の flushStrike)で
 *      弾もカットインも持ち越されるのにバナーだけ単独で出てしまい、演出明けの
 *      本番の着弾ではキューが空 → バナーが二度と出ない
 *   2. yieldToCutin(タイマーを張らず queueStrike だけする経路)では保留判定が
 *      false になり、最長45秒のカットインの上に一瞬出て消える
 * の2経路でバナーが失われる — この判定をここに一本化する。
 *
 * 保留の入れ物は**配列ではなくアキュムレータ**(PendingFloat)。ストック満杯の
 * カットイン中は worker が凍結しない(stock-full は fxFreezeUntilMs を張らない)ので
 * flushLikeFx が 1Hz でいいね演出を出し続け、配列で持つと最長7秒ぶん(5〜6件)溜まる。
 * それを revealStock が同期ループで push すると React のバッチで FLOAT_MAX(3枠)の
 * 押し出しが起きて、「満杯の瞬間に＋が3枚同時に出る」になっていた。金額だけを畳んで
 * 描画を flush まで遅らせれば1種類につき必ず1枚 — 枚数の上限は構造で担保する。
 *
 * shared に置くのは fx-drain.ts / live-rows.ts と同じ理由 — レンダラのテスト環境が
 * このリポジトリに無いので、決定ロジックを純関数としてここへ抽出して node の
 * テストで固定する。
 */

export interface FloatHoldState {
  /** 着弾チェーン飛行中(strikeTimers が生きている)。 */
  chainActive: boolean;
  /** 演出明けに再生される持ち越しがある(pendingStrike !== null)。 */
  strikePending: boolean;
  /** ルーレット/バンド/ストック/ブーストのいずれかのカットイン中。 */
  cutinActive: boolean;
}

/**
 * バナーを今出さず保留すべきか。true を返すのは「後で必ず出す持ち主がいる」
 * ときだけ — どれも無ければ即時に出す(着弾が来ずに闇へ消えるのを防ぐ)。
 */
export function shouldDeferFloat(s: FloatHoldState): boolean {
  return s.chainActive || s.strikePending || s.cutinActive;
}

/**
 * 保留バナーを今 flush してよいか(= 出す先の演出が誰もいない状態か)。
 * shouldDeferFloat と常に排他。呼び出し文脈によって渡す state が違う
 * (flushStrike は「チェーンはたった今畳んだ」ので chainActive:false を渡す)
 * ので、判定そのものはこの2関数に集約する。
 */
export function shouldFlushDeferredFloats(s: FloatHoldState): boolean {
  return !shouldDeferFloat(s);
}

/**
 * 保留バナーの中身。React ノードではなく**加算量だけ**を持つのが要点 —
 * 描画を flush まで遅らせることで、保留中に何件届いても1枚に畳める。null = 保留なし。
 */
export interface PendingFloat {
  /** 畳んだ合計加算量(バナーの +N)。 */
  amount: number;
  /**
   * 畳んだ件数。表示には使わない — 「保留が何件来ても出るバナーは1枚」を
   * テストで固定するための観測点(fx-floats.spec.ts)。
   */
  count: number;
}

/** 保留へ1件積む。配列にしないので、flush で出る枚数は構造的に1枚を超えない。 */
export function mergePendingFloat(cur: PendingFloat | null, amount: number): PendingFloat {
  return { amount: (cur?.amount ?? 0) + amount, count: (cur?.count ?? 0) + 1 };
}
