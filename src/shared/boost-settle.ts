/**
 * タップブーストの清算発表(結果カットシーン → パチンコ風「-N」ロールアップ →
 * 7セグへ着弾)のタイムライン決定ロジック。
 *
 * MonitorView(レンダラ)はここの純関数を消費するだけにする — vitest は
 * node 環境のみでレンダラのテストが書けないため、演出の決定ロジックは
 * shared に置いて node で固定する(fx-drain.ts と同じ判断)。
 * worker も BOOST_SETTLE_BUDGET_MS を凍結時間の上乗せに使う — 定数を
 * 1箇所に置くことで「レンダラの演出尺 ≤ worker の凍結余白」の整合を
 * テストで検証できる(boost-settle.spec.ts)。
 */

/**
 * 結果カットシーン(resultClip)の尺(ms)。intro/count と同じ「実尺焼き込み」方式 —
 * assets/fx/boost/ の result-* 素材はすべてこの実尺で揃える。worker は発動時点で
 * 凍結長を確定する必要があるため、素材ごとの可変尺にはしない。
 */
export const TAP_BOOST_RESULT_MS = 4000;

/** ロールアップ(桁回転→確定)の基本尺。桁数に応じて伸びる。 */
export const BOOST_ROLLUP_BASE_MS = 900;
/** 1桁あたりの追加尺。桁が多いほど「上位桁から順にロック」の見せ場が長い。 */
export const BOOST_ROLLUP_PER_DIGIT_MS = 250;
/** ロールアップの上限。減算量が巨大でも発表が間延びしない天井。 */
export const BOOST_ROLLUP_MAX_MS = 2200;
/** 全桁確定後の溜め(発射までの静止)。パチンコの「確定→ドン」の間。 */
export const BOOST_ROLLUP_HOLD_MS = 650;
/** 回転中の桁が切り替わるフレーム間隔(ms)。rollupDisplayAt の時間量子。 */
export const BOOST_ROLLUP_SPIN_FRAME_MS = 50;

/*
 * 弾の飛翔時間。fx.strike と着弾タイマーに同じ値を渡すので、数字が変わる瞬間と
 * 弾の到達はフレーム単位で一致する。飛距離で決めるのは縦横で距離が倍以上違うため
 * (縦は約 340px、横は約 700px)。固定値にすると横だけ弾が速すぎて何が飛んだか読めない。
 * (MonitorView から移設 — BUDGET との整合を node テストで固定するため shared に置く。)
 */
export const STRIKE_TRAVEL_MS = 300;
export const STRIKE_TRAVEL_MIN_MS = 260;
export const STRIKE_TRAVEL_MAX_MS = 420;

/**
 * worker が凍結(fxFreezeUntilMs)に上乗せする、清算発表(boost-end 受信後)の
 * 最悪予算。≒ delta 配送遅延(~525ms) + ロールアップ上限 + 溜め + 飛翔上限 + 余白。
 * レンダラの発表シーケンス(resultMs を除く)は必ずこの予算内に収まること —
 * boost-settle.spec.ts が不等式で固定する。resultMs は worker が別途加算する。
 */
export const BOOST_SETTLE_BUDGET_MS = 4000;

/** 清算発表シーケンスの各段の尺。totalMs = resultMs + rollupMs + holdMs(飛翔は実測)。 */
export interface BoostSettlePlan {
  /** 結果カットシーンの尺。0 = この段なし(resultClip 'off' / プレーンモード)。 */
  resultMs: number;
  /** 「-N」ロールアップの尺。0 = 発表なし(タップ 0)。 */
  rollupMs: number;
  /** 確定後の溜め。0 = 発表なし。 */
  holdMs: number;
  /** 発表シーケンスの総尺(飛翔を除く)。0 = 発表を丸ごとスキップ(従来の軽い着弾)。 */
  totalMs: number;
}

/**
 * 清算発表のタイムラインを決める。タップ 0(発表するものが無い)は全段 0 —
 * 呼び出し側は従来どおり軽い着弾だけで畳む(worker 側の凍結引き戻しと対)。
 * amount は減算量の絶対値(正)で渡す。
 */
export function planBoostSettle(input: {
  amount: number;
  tapCount: number;
  resultMs: number;
}): BoostSettlePlan {
  const amount = Math.floor(input.amount);
  if (input.tapCount <= 0 || amount <= 0) {
    return { resultMs: 0, rollupMs: 0, holdMs: 0, totalMs: 0 };
  }
  const digits = String(amount).length;
  const rollupMs = Math.min(
    BOOST_ROLLUP_MAX_MS,
    Math.max(BOOST_ROLLUP_BASE_MS, BOOST_ROLLUP_BASE_MS + digits * BOOST_ROLLUP_PER_DIGIT_MS)
  );
  const resultMs = Math.max(0, Math.floor(input.resultMs));
  const holdMs = BOOST_ROLLUP_HOLD_MS;
  return { resultMs, rollupMs, holdMs, totalMs: resultMs + rollupMs + holdMs };
}

/**
 * 決定的な擬似乱数(回転中の桁の見た目)。Math.random は使わない —
 * StrictMode の二重レンダーやテストで毎回同じ絵になるよう、seed(effect.id)+
 * 桁位置 + フレーム番号から引く(roulettePattern の「1回引いて焼き込む」と
 * 同じ動機を、毎フレーム値が要るのでステートレスなハッシュで満たす)。
 */
function spinDigit(seed: number, digitIndex: number, frame: number): number {
  let h = (Math.imul(seed | 0, 374761393) + Math.imul(digitIndex + 1, 668265263) + Math.imul(frame + 1, 2246822519)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) % 10;
}

export interface RollupDisplay {
  /** 表示する数字列(符号なし)。done 時は必ず String(amount)。 */
  text: string;
  /** 確定済みの桁数(上位から)。経過時間に対して単調非減少。 */
  locked: number;
  /** 全桁確定したか。 */
  done: boolean;
}

/**
 * ロールアップの経過時刻 elapsedMs 時点の表示を返す(純関数)。
 * パチンコ式に上位桁から順にロックされ、未確定桁は spinDigit で回転する。
 * 最後の桁は rollupMs 到達で確定 — done 時に text === String(amount)。
 */
export function rollupDisplayAt(
  amount: number,
  elapsedMs: number,
  rollupMs: number,
  seed: number
): RollupDisplay {
  const target = String(Math.max(0, Math.floor(amount)));
  const n = target.length;
  if (rollupMs <= 0 || elapsedMs >= rollupMs) {
    return { text: target, locked: n, done: true };
  }
  const progress = Math.max(0, elapsedMs) / rollupMs;
  // 上位桁から (i+1)/(n+1) の進捗でロック — 最終桁だけは rollupMs 到達(上の
  // 早期 return)まで回り続け、「最後の1桁で焦らす」パチンコの間を作る。
  const locked = Math.min(n - 1, Math.floor(progress * (n + 1)));
  const frame = Math.floor(Math.max(0, elapsedMs) / BOOST_ROLLUP_SPIN_FRAME_MS);
  let text = target.slice(0, locked);
  for (let i = locked; i < n; i++) {
    text += String(spinDigit(seed, i, frame));
  }
  return { text, locked, done: false };
}
