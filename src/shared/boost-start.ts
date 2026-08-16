/**
 * 持ち越されたタップブースト(boost-start)を凍結明けに「全部出す / 途中から出す /
 * 見送る」の決定。boost-settle.ts(フィーバーの**終わり**のタイムライン)と対になる
 * 「**始まり**のタイムライン」。
 *
 * なぜ必要か: worker のフィーバーは絶対時刻で走る。activateBoost が
 * boostStartMs / boostUntilMs を決めて boostEndsAtMs を effect に焼き込み、
 * settleBoost はその時刻で勝手に清算する。一方モニターは、他の演出(ルーレット連鎖は
 * 最長 ~19 秒)を再生中なら boost-start を pendingBoosts へ積んで後で再生する。
 * **worker はルーレットでは凍結しない**ので、キューから出す時点で既に終わっている
 * フィーバーがありうる — そのまま再生すると不透明シネマを最大 26 秒出したまま
 * TAP カウンタが 0 から動かず、押下は動画の裏で不可視に適用される。
 *
 * shared に置くのは fx-drain.ts / fx-floats.ts / boost-settle.ts と同じ理由 —
 * レンダラのテスト環境がこのリポジトリに無い(vitest は node 環境のみ、
 * tsconfig.node.json は src/renderer を含まない)ので、演出の決定ロジックは
 * 純関数としてここへ出し、node のテストで固定する。
 */

import type { ChallengeEffect } from './dto';

/**
 * これ未満しか残っていないフィーバーは再生しない。不透明な全画面シネマを出す
 * 価値が無く、出した直後に boost-end が来て打ち切られるだけになる。
 * TAP_BOOST_DURATION_MIN_SEC(5秒)より十分小さいので、最短設定のフィーバーを
 * 即時ドレインで取りこぼすことはない。
 */
export const BOOST_RESUME_MIN_MS = 1500;

/**
 * 「遅れ」と見なさない猶予。これ以内なら従来どおり頭から全部再生する
 * (= 持ち越しでない通常経路とビット単位で同じ挙動)。
 * delta 配送の最悪遅延(~525ms・boost-settle.ts の BOOST_SETTLE_BUDGET_MS の
 * 内訳参照)+ finish 系の同期処理 + 1フレームを飲む値。
 */
export const BOOST_START_GRACE_MS = 750;

/**
 * 途中参加でカウントダウン段(3・2・1)を出す最小残り。これ未満なら段ごと捨てて
 * 即タップウィンドウに入る — カウントダウンは映像に数字が焼き込まれていて
 * 「1」がタップ開始と同期する契約なので、中途半端に出すと嘘をつくことになる。
 */
export const BOOST_RESUME_COUNT_MIN_MS = 600;

/** planBoostStart の入力。ChallengeEffect からは boostStartTiming() で作る。 */
export interface QueuedBoostTiming {
  /** effect.atMs — 発動時刻(endsAtMs 欠損時の代替原点)。 */
  atMs: number;
  /** effect.boostEndsAtMs — タップウィンドウの絶対期限。欠損 = 旧 worker 混在。 */
  endsAtMs?: number | undefined;
  /** effect.boostIntroMs ?? 0(起動カットイン)。 */
  introMs: number;
  /** effect.boostCountMs ?? 0(3・2・1)。 */
  countMs: number;
  /** effect.fxDurationMs ?? 0(前置き + ウィンドウの総尺)。 */
  totalMs: number;
}

export type BoostStartPlan =
  | { action: 'skip'; reason: 'ended' | 'tail' }
  | { action: 'full' }
  | {
      /** 途中参加。前置きの残りだけを段の実尺どおりに組み直す。 */
      action: 'resume';
      phase: 'count' | 'window';
      /**
       * 起動カットイン段の残り尺。前置きの残りが**カウント段の実尺を超えた**ぶんが
       * ここに入る(= まだ咆哮の途中)。phase==='window' なら 0。
       *
       * これを持たずに前置きの残りを丸ごと countMs へ入れていたのが v0.7.2 の
       * バグ — カウント素材は 3.0 秒固定で `<video loop>` は window 段でしか
       * 立たないため、段が 3 秒を超えると **3・2・1 が終わってから静止フレームで
       * 数秒待つ**ことになり、「1 がタップ開始と同期する」契約
       * (challenge.ts の TAP_BOOST_COUNT_MS)が壊れていた。
       */
      introMs: number;
      /** カウントダウン段の残り尺。**段の実尺(countMs)を超えない**。phase==='window' なら 0。 */
      countMs: number;
      /** 開始時点から数えた残り総尺(= endsAt - nowMs)。startBoostFx の totalMs に渡す。 */
      remainingMs: number;
    };

/**
 * 決定本体。時間が進むと full → resume → skip の一方向にしか遷移しない
 * (boost-start.spec.ts が掃引で固定)。
 */
export function planBoostStart(t: QueuedBoostTiming, nowMs: number): BoostStartPlan {
  const total = Math.max(0, Math.floor(t.totalMs));
  const intro = Math.max(0, Math.floor(t.introMs));
  const count = Math.max(0, Math.floor(t.countMs));

  // 旧 worker + 尺欠損。時刻の根拠がまったく無いので従来どおり素通しする(fail-open)。
  // 実害は無い — 呼び出し側の boostWillStart が fxDurationMs >= 1000 で断る。
  if (t.endsAtMs == null && total <= 0) return { action: 'full' };

  const endsAt = t.endsAtMs ?? t.atMs + total;
  const remaining = endsAt - nowMs;

  if (remaining <= 0) return { action: 'skip', reason: 'ended' };
  if (remaining < BOOST_RESUME_MIN_MS) return { action: 'skip', reason: 'tail' };

  // 原点は atMs ではなく endsAt - total。こうすると elapsed + remaining === total が
  // 恒等式になり、2つのフィールドが食い違っても内部矛盾が起きない。
  const elapsed = nowMs - (endsAt - total);

  // 負(未来の effect / 時計ずれ)もここに落ちる = 従来挙動。
  if (elapsed <= BOOST_START_GRACE_MS) return { action: 'full' };

  const preRemaining = intro + count - elapsed;
  if (
    count > 0 &&
    preRemaining >= BOOST_RESUME_COUNT_MIN_MS &&
    remaining - preRemaining >= BOOST_RESUME_MIN_MS
  ) {
    // 前置きの残りは**後ろの段から埋める** — カウント段は実尺を超えず、
    // 余った先頭ぶんが起動カットインの残りになる。守るのは「ウィンドウが開く時刻」
    // (= preRemaining の合計)で、そこは分け方に依らず不変。
    const countMs = Math.min(count, preRemaining);
    return {
      action: 'resume',
      phase: 'count',
      introMs: preRemaining - countMs,
      countMs,
      remainingMs: remaining,
    };
  }
  return { action: 'resume', phase: 'window', introMs: 0, countMs: 0, remainingMs: remaining };
}

/** ChallengeEffect → QueuedBoostTiming。フィールド対応の唯一の権威。 */
export function boostStartTiming(e: ChallengeEffect): QueuedBoostTiming {
  return {
    atMs: e.atMs,
    endsAtMs: e.boostEndsAtMs,
    introMs: e.boostIntroMs ?? 0,
    countMs: e.boostCountMs ?? 0,
    totalMs: e.fxDurationMs ?? 0,
  };
}
