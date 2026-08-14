import { join } from 'node:path';
import { BrowserWindow, shell, type WebContents } from 'electron';

/**
 * The window is created hidden to avoid a white flash, which means something
 * must reveal it — and `ready-to-show` alone is not dependable. It fires after
 * the first frame is painted, and on this machine it sometimes never arrived:
 * the process ran, the window existed with the right title, and it stayed
 * `visible=False` forever. From outside, that is indistinguishable from the app
 * failing to start.
 *
 * So: reveal on the first of three signals, and never let the user stare at
 * nothing because one compositor event went missing.
 */
export function revealWhenReady(win: BrowserWindow, focus = true): void {
  let shown = false;
  const reveal = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    if (focus) win.focus();
  };
  win.once('ready-to-show', reveal);
  win.webContents.once('did-finish-load', reveal);
  win.webContents.once('did-fail-load', reveal);
  setTimeout(reveal, 5000);
}

/** Nothing in this app should ever navigate. Comments can contain links. */
export function hardenWebContents(wc: WebContents): void {
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (url !== wc.getURL()) e.preventDefault();
  });
  attachDevToolsHotkey(wc);
}

/**
 * 開発者ツールの開閉。**この関数はメイン窓とモニター窓の唯一の共通点**なので、
 * ここに1つ足せば両方の窓で効く。
 *
 * 必要な理由: Windows では `Menu.setApplicationMenu(null)` で既定メニューごと
 * 消してあるため、既定の Ctrl+Shift+I アクセラレータも一緒に消えている。
 * 「重い」「演出が出ない」の調査に使える口がアプリ内に一切無い状態だった。
 *
 * 注意点2つ:
 * - **F12 と Ctrl+Shift+I の両方**を受ける。チャレンジのホットキーは
 *   globalShortcut で OS 全体を先取りするので、ユーザーが F12 を割り当てて
 *   いると before-input-event までそもそも届かない。
 * - **必ず detach で開く。** モニター窓は背面ディスプレイに出していてカメラに
 *   映るため、docked で開くとステージが割れて配信事故になる。
 */
function attachDevToolsHotkey(wc: WebContents): void {
  wc.on('before-input-event', (_e, input) => {
    if (input.type !== 'keyDown') return;
    const hit = input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i');
    if (!hit) return;
    if (wc.isDevToolsOpened()) wc.closeDevTools();
    else wc.openDevTools({ mode: 'detach' });
  });
}

export function createWindow(preload: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0f1116',
    title: 'TikTokライブ分析',
    webPreferences: {
      preload,
      // The renderer displays untrusted, attacker-controlled text (viewer
      // nicknames and comments). It gets no Node, no shared context, and a sandbox.
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: false,
    },
  });

  revealWhenReady(win);
  hardenWebContents(win.webContents);

  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return win;
}
