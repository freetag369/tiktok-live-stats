import { join } from 'node:path';
import { BrowserWindow, screen, type Display } from 'electron';
import { boundsOnAnyDisplay } from './monitor-geometry';
import { hardenWebContents, revealWhenReady } from './window';

/**
 * カウントダウンチャレンジの背面モニターウィンドウ(シングルトン)。
 *
 * 配信者の背後に置いた縦型ディスプレイへフルスクリーン表示する前提。
 * alwaysOnTop は使わない — 専用ディスプレイなら不要で、誤ってメイン側に
 * 出たときダッシュボードを塞ぐ事故要因にしかならない。
 */

let monitor: BrowserWindow | null = null;

/**
 * 設定の displayId が実在すればそれ、無ければ「最後の非プライマリ」。
 * ディスプレイが1枚しか無いときはフルスクリーンにするとダッシュボードを
 * 塞ぐので、縦長ウィンドウ(9:16 目安)で妥協する。
 */
function pickDisplay(displayId: number | null): { display: Display; fullscreen: boolean } {
  const all = screen.getAllDisplays();
  const byId = all.find((d) => d.id === displayId);
  if (byId) return { display: byId, fullscreen: true };
  const primaryId = screen.getPrimaryDisplay().id;
  const secondary = all.filter((d) => d.id !== primaryId);
  if (secondary.length > 0) return { display: secondary[secondary.length - 1]!, fullscreen: true };
  return { display: all[0]!, fullscreen: false };
}

export function openMonitorWindow(
  preload: string,
  displayId: number | null,
  windowed: boolean,
  onClosed: () => void
): BrowserWindow {
  if (monitor && !monitor.isDestroyed()) {
    monitor.focus();
    return monitor;
  }
  const picked = pickDisplay(displayId);
  // ウィンドウ表示設定なら常に全画面にしない(移動・リサイズできる普通の窓)。
  const fullscreen = picked.fullscreen && !windowed;
  const { x, y, width, height } = picked.display.bounds;
  // mac の setFullScreen は Spaces 生成+約1秒のアニメーションを伴い、HDMI 抜き差し時の
  // 置き直しと相性が悪い。専用ディスプレイを覆うだけなら simpleFullscreen で足りる。
  const useSimpleFs = process.platform === 'darwin';

  monitor = new BrowserWindow({
    x: x + 50,
    y: y + 50,
    width: fullscreen ? width : 506,
    height: fullscreen ? height : 900,
    minWidth: 270,
    minHeight: 360,
    // 全画面時は配信画面に OS のウィンドウ枠を映さない。ウィンドウ表示時は
    // 枠を付ける — 枠が無いと掴んで動かせず、閉じることもできないため。
    frame: windowed,
    fullscreen: fullscreen && !useSimpleFs,
    backgroundColor: '#000000', // カメラ映り優先の純黒(起動フラッシュ防止も兼ねる)
    show: false,
    skipTaskbar: false, // 事故復旧のためタスクバーには残す
    title: 'チャレンジモニター',
    webPreferences: {
      preload,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
      // mac は他ウィンドウに完全に覆われた窓を occluded と判定して rAF を止め、
      // setTimeout を 1Hz 以下に絞る(Windows には無い挙動で、isVisible() は true のまま)。
      // 演出の据え置き解除は setTimeout の連鎖で、取りこぼし用の保険タイマー自体も
      // setTimeout なので、絞られると7セグが固まったまま戻らない。背面ディスプレイに
      // 出しっぱなしにする窓なので、スロットリングは常に切る。
      backgroundThrottling: false,
    },
  });
  if (useSimpleFs && fullscreen) {
    // simpleFullscreen は「今いるディスプレイ」を覆うため、先に対象へ移動しておく。
    monitor.setBounds(picked.display.bounds);
    monitor.setSimpleFullScreen(true);
  }
  revealWhenReady(monitor, false); // フォーカスは奪わない(配信操作中のため)
  hardenWebContents(monitor.webContents);

  if (process.env.ELECTRON_RENDERER_URL) {
    void monitor.loadURL(`${process.env.ELECTRON_RENDERER_URL}/monitor.html`);
  } else {
    void monitor.loadFile(join(__dirname, '../renderer/monitor.html'));
  }

  monitor.on('closed', () => {
    monitor = null;
    onClosed();
  });
  return monitor;
}

export function closeMonitorWindow(): void {
  monitor?.close();
}

export function getMonitorWindow(): BrowserWindow | null {
  return monitor && !monitor.isDestroyed() ? monitor : null;
}

/**
 * 診断メトリクス用 — モニター窓レンダラの OS pid(窓が無ければ null)。
 * getAppMetrics の一覧は type='Tab' が並ぶだけなので、どれがモニター窓かは
 * この pid を突き合わせて初めて分かる(metrics.ts)。
 */
export function getMonitorWindowPid(): number | null {
  const win = getMonitorWindow();
  return win ? win.webContents.getOSProcessId() : null;
}

/** 配信中の HDMI 抜け対策 — ディスプレイ構成が変わったら置き直す。 */
export function repositionMonitor(displayId: number | null, windowed: boolean, force = false): void {
  const win = getMonitorWindow();
  if (!win) return;
  const picked = pickDisplay(displayId);
  const fullscreen = picked.fullscreen && !windowed;
  const useSimpleFs = process.platform === 'darwin';
  // display-added/removed は無関係なディスプレイの増減(キャプチャ用の仮想
  // ディスプレイ・ドッキング・一部環境のモニタースリープ復帰)でも発火する。
  // ウィンドウ表示で現にどこかの画面に掛かっている窓を無条件に既定位置
  // (+50,+50 506×900)へ戻すと、配信者の手動配置(OBS の構図)がイベントの
  // たびに壊れる。動かしてよいのは (a) 設定変更などの明示指示(force)
  // (b) 全画面との行き来が要る遷移 (c) 消えたディスプレイに取り残されて
  // どの画面にも掛かっていないとき、だけ。
  if (!force && !fullscreen) {
    const winFullscreen = win.isFullScreen() || (useSimpleFs && win.isSimpleFullScreen());
    const displays = screen.getAllDisplays().map((d) => d.bounds);
    if (!winFullscreen && boundsOnAnyDisplay(win.getBounds(), displays)) return;
  }
  if (useSimpleFs) win.setSimpleFullScreen(false);
  else win.setFullScreen(false);
  win.setBounds(
    fullscreen
      ? picked.display.bounds
      : { x: picked.display.bounds.x + 50, y: picked.display.bounds.y + 50, width: 506, height: 900 }
  );
  if (fullscreen) {
    if (useSimpleFs) win.setSimpleFullScreen(true);
    else win.setFullScreen(true);
  }
}
