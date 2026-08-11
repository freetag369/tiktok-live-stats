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
