/**
 * 窓の健全性監視と自動復旧(main プロセス)。
 *
 * このアプリはモニター窓を配信者の背面に出したまま数時間放置される。
 * これまで、レンダラが死んでも(描画中の throw / OOM / GPU プロセス巻き添え)
 * 誰も気づかず、真っ黒な窓が配信に映り続けるだけだった —
 * render-process-gone も unresponsive も購読していなかった。
 *
 * ループガードを main に置く理由: モニター窓は復旧のたびに**破棄**されるので、
 * レンダラ内のカウンタは毎回 0 に戻りループを観測できない。判断ロジック自体は
 * shared/restart-guard.ts の純関数(node のテストで固定)。
 */

import type { BrowserWindow } from 'electron';
import { decideAutoRecover } from '@shared/restart-guard';
import { report } from './diag-log';

/** unresponsive で即断しないための猶予。 */
const UNRESPONSIVE_GRACE_MS = 10_000;

let history: number[] = [];

export interface RecoverHooks {
  /** 実際に窓を作り直す(main の monitor.restart と同じ手順)。 */
  restartMonitor: () => void;
  /** ダッシュボードへの通知。 */
  toast: (level: 'info' | 'warn' | 'error', msgJa: string) => void;
}

/**
 * 自動復旧を試みる。ループガードに引っかかったら復旧せず、
 * 手動の「モニター再起動」ボタンを案内する。
 */
export function tryAutoRecoverMonitor(reason: string, hooks: RecoverHooks): void {
  const d = decideAutoRecover(history, Date.now());
  history = d.history;
  if (!d.allow) {
    report('main', 'error', `[diag] モニターの自動復旧を停止(${reason}) — 短時間に繰り返しすぎ`);
    hooks.toast(
      'error',
      'モニターの自動復旧を停止しました。ダッシュボードの「モニター再起動」を押してください。'
    );
    return;
  }
  report('main', 'warn', `[diag] モニターを自動復旧(${reason})`);
  hooks.toast('warn', 'モニターが停止したため再起動しました。');
  hooks.restartMonitor();
}

/**
 * 手動復旧は予算をリセットする — 人が明示的に押したなら、そこから数え直す。
 * (自動が止まったあとユーザーがボタンを押して直した、が普通の運用。)
 */
export function resetAutoRecoverBudget(): void {
  history = [];
}

/**
 * モニター窓のクラッシュ/無応答を監視する。openMonitor から窓ごとに1回呼ぶ。
 *
 * unresponsive で即再起動してはいけない: この窓は rAF + 動画デコードを
 * 回しっぱなしで backgroundThrottling も切ってあるため、長い GC や 4K の
 * キーフレームで Chromium の無応答ヒューリスティックは普通に誤爆する。
 * 猶予を置き、responsive が来たら取り消す。
 */
export function watchMonitorWindow(mon: BrowserWindow, hooks: RecoverHooks): void {
  mon.webContents.on('render-process-gone', (_e, details) => {
    // レンダラのプロセスごと死んだ経路 — React のエラーバウンダリでは
    // 構造的に捕まえられない側(OOM・GPU 巻き添え・sad tab)。
    report('main', 'error', `[diag] モニターのレンダラが停止: ${details.reason} (exit ${details.exitCode})`);
    tryAutoRecoverMonitor(`render-process-gone:${details.reason}`, hooks);
  });

  let graceTimer: NodeJS.Timeout | null = null;
  const cancelGrace = (): void => {
    if (graceTimer !== null) {
      clearTimeout(graceTimer);
      graceTimer = null;
    }
  };
  mon.on('unresponsive', () => {
    report('main', 'warn', '[diag] モニターが無応答 — 猶予後に再判定');
    cancelGrace();
    graceTimer = setTimeout(() => {
      graceTimer = null;
      if (mon.isDestroyed()) return;
      report('main', 'error', '[diag] モニターが無応答のまま — 自動復旧する');
      tryAutoRecoverMonitor('unresponsive', hooks);
    }, UNRESPONSIVE_GRACE_MS);
    graceTimer.unref?.();
  });
  mon.on('responsive', () => {
    if (graceTimer !== null) report('main', 'info', '[diag] モニターが応答を回復(自動復旧は見送り)');
    cancelGrace();
  });
  mon.on('closed', cancelGrace);
}

/**
 * ダッシュボード窓の監視。こちらは人が見ている前提なので方針が逆 —
 * 初回は黙って reload(操作者がやることと同じで、権威状態は worker/main が
 * 持っているので失うものが無い)、短時間の再発だけダイアログで止める。
 */
export function watchDashboardWindow(
  win: BrowserWindow,
  hooks: { toast: RecoverHooks['toast']; onRepeatCrash: (reason: string) => void }
): void {
  let lastCrashMs = 0;
  win.webContents.on('render-process-gone', (_e, details) => {
    const now = Date.now();
    report('main', 'error', `[diag] ダッシュボードのレンダラが停止: ${details.reason}`);
    if (now - lastCrashMs < 5 * 60_000) {
      hooks.onRepeatCrash(details.reason);
      return;
    }
    lastCrashMs = now;
    hooks.toast('warn', '画面が停止したため再読み込みしました。');
    if (!win.isDestroyed()) win.reload();
  });
}
