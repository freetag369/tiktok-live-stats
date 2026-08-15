/**
 * このスレッドが止まっていた時間の計測。
 *
 * worker は単一スレッドで node:sqlite も同期なので、重いクエリが走っている間は
 * `challenge.press` の RPC メッセージが**配送すらされない**。つまりこの数字が
 * そのまま「ボタンが効かない時間」になる — 体感の重さと1対1で対応する唯一の
 * 指標なので、他の何を測るよりも先にこれを見ること。
 *
 * 1秒ごとの期待時刻とのズレを取り、読み出しでリセットする(直近区間の最大)。
 *
 * index.ts から切り出したのは循環 import を避けるため — q.diagnostics で
 * rpc-server がこの値を読むが、index.ts に置いたままだと rpc-server → index →
 * rpc-server の輪になる(値自体は deps 注入で渡すが、entry を経由しない
 * 独立モジュールにしておけば node の vitest からもそのまま読める)。
 */

const LOOP_LAG_TICK_MS = 1000;
/** これを超えたら stdout に警告を出す(main が拾ってコンソールへ流す)。 */
const LOOP_LAG_WARN_MS = 500;
const LOOP_LAG_WARN_EVERY_MS = 30_000;

let loopLagMaxMs = 0;
let lastLagWarnMs = 0;

/** 直近区間のイベントループ最大遅延(ms)。読み出すとリセットされる。 */
export function drainLoopLagMaxMs(): number {
  const v = loopLagMaxMs;
  loopLagMaxMs = 0;
  return v;
}

export function startLoopLagMeter(): void {
  let expected = Date.now() + LOOP_LAG_TICK_MS;
  const t = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + LOOP_LAG_TICK_MS;
    if (lag <= 0) return;
    if (lag > loopLagMaxMs) loopLagMaxMs = lag;
    if (lag >= LOOP_LAG_WARN_MS && now - lastLagWarnMs >= LOOP_LAG_WARN_EVERY_MS) {
      lastLagWarnMs = now;
      console.warn(`[worker] イベントループが ${lag}ms 停止しました(この間ボタンの操作は届きません)`);
    }
  }, LOOP_LAG_TICK_MS);
  t.unref?.();
}
