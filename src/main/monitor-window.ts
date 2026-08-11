import { join } from 'node:path';
import { BrowserWindow, screen, type Display } from 'electron';
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
  onClosed: () => void
): BrowserWindow {
  if (monitor && !monitor.isDestroyed()) {
    monitor.focus();
    return monitor;
  }
  const { display, fullscreen } = pickDisplay(displayId);
  const { x, y, width, height } = display.bounds;

  monitor = new BrowserWindow({
    x: x + 50,
    y: y + 50,
    width: fullscreen ? width : 506,
    height: fullscreen ? height : 900,
    frame: false, // 配信画面に OS のウィンドウ枠を映さない
    fullscreen,
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
    },
  });
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

/** 配信中の HDMI 抜け対策 — ディスプレイ構成が変わったら置き直す。 */
export function repositionMonitor(displayId: number | null): void {
  const win = getMonitorWindow();
  if (!win) return;
  const { display, fullscreen } = pickDisplay(displayId);
  win.setFullScreen(false);
  win.setBounds(
    fullscreen
      ? display.bounds
      : { x: display.bounds.x + 50, y: display.bounds.y + 50, width: 506, height: 900 }
  );
  if (fullscreen) win.setFullScreen(true);
}
