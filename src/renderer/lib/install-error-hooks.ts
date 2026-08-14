/**
 * レンダラの捕まえ損ねた例外を main の診断リングへ送る。
 * 両エントリ(main.tsx / monitor.tsx)で createRoot の**前**に1回だけ呼ぶ。
 *
 * ここで窓の再起動はしない。とくに unhandledrejection は絶対に契機にしない —
 * MonitorView は worker 再起動中の rpc 失敗を意図的に握りつぶしており
 * (`.catch(() => undefined)` が5箇所、「worker 復帰後の delta / 次の押下で回復する」
 * とコメント済み)、ここで再起動を掛けると **worker が瞬断するたびにモニターが
 * 落ちる**。窓を作り直してよいのは描画の例外(エラーバウンダリ)だけ。
 */

import type { DiagScope } from '@shared/diag-ring';

/** 同じ文言を送り続けない(rAF 内の throw は毎秒60件出る)。 */
const seen = new Map<string, number>();
const DEDUPE_MS = 5_000;

function send(scope: 'dashboard' | 'monitor', level: 'warn' | 'error', message: string): void {
  const now = Date.now();
  const last = seen.get(message);
  if (last !== undefined && now - last < DEDUPE_MS) return;
  seen.set(message, now);
  // Map が育たないように、古い印は掃除する(上限も掛ける)。
  if (seen.size > 200) {
    for (const [k, t] of seen) if (now - t > DEDUPE_MS) seen.delete(k);
  }
  // 通知が失敗しても本体は続行する(worker 再起動中など)。
  void window.api.rpc('diag.report', { scope, level, message }).catch(() => undefined);
}

export function installErrorHooks(scope: Extract<DiagScope, 'dashboard' | 'monitor'>): void {
  /*
   * capture: true にしてはいけない — 素材の読み込み失敗(mp4/mp3 が 80本ある)まで
   * 拾ってリングをノイズで埋める。あちらは armVideoPlay が既に正しく扱っている。
   */
  window.addEventListener('error', (ev) => {
    const err = ev.error as Error | undefined;
    const where = ev.filename ? ` @${ev.filename}:${ev.lineno}` : '';
    send(scope, 'error', `[diag] 未捕捉の例外: ${err?.stack ?? ev.message}${where}`);
  });

  window.addEventListener('unhandledrejection', (ev) => {
    const r = ev.reason as { stack?: string; message?: string } | undefined;
    send(scope, 'warn', `[diag] 未処理の reject: ${r?.stack ?? r?.message ?? String(ev.reason)}`);
  });
}
