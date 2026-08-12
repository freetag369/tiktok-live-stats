import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, screen, shell } from 'electron';
import type { AppSettings, CsvExportSpec } from '@shared/dto';
import { CH_MONITOR_STATE, CH_SETTINGS_PUSH, CH_TOAST, CH_WORKER_STATE, MAIN_HANDLED, type RpcRequest, type RpcResponse } from '@shared/ipc';
import { validateChallengeConfig } from '@shared/challenge';
import { loadSettings, needsWorkerRestart, saveSettings } from './boot-settings';
import { askBackupPath, askCsvPath, askSourceZipPath, offerAdoptDb } from './dialogs';
import { closeMonitorWindow, getMonitorWindow, openMonitorWindow, repositionMonitor } from './monitor-window';
import { configDirIn, defaultDataDir, dbPathIn, docsPath, findExistingDb, isPortable, resourcesDir } from './paths';
import { WorkerHost } from './worker-host';
import { createWindow } from './window';

/**
 * Order matters, and getting it wrong looks like "the app won't start".
 *
 * Electron keys the single-instance lock on the userData path, so the redirect
 * MUST happen first. Taking the lock before the redirect meant every build —
 * portable and installed alike — competed for the lock on the default path even
 * though they open completely different databases: launching the installed build
 * while the portable one ran made it quit instantly and silently.
 */
const dataDir = defaultDataDir();
if (!app.isPackaged || isPortable) app.setPath('userData', dataDir);

if (!app.requestSingleInstanceLock()) {
  // Dying without a word is what made this look like a broken install.
  dialog.showErrorBox(
    'すでに起動しています',
    'TikTokライブ分析 はすでに起動しています。\n\n' +
      'タスクバーで既存のウィンドウを探すか、いったん終了してから起動し直してください。\n\n' +
      `データの保存場所: ${dataDir}`
  );
  app.exit(0);
}

let win: BrowserWindow | null = null;
let host: WorkerHost | null = null;
let settings: AppSettings;

function bootPayload() {
  return {
    dbPath: settings.dbPath,
    userDataDir: dataDir,
    configDir: configDirIn(dataDir),
    resourcesDir: resourcesDir(),
    settings,
    appInfo: {
      gitSha: typeof __GIT_SHA__ === 'string' ? __GIT_SHA__ : 'unknown',
      buildTime: typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '',
      appVersion: app.getVersion(),
    },
  };
}

function toast(level: 'info' | 'warn' | 'error', msgJa: string): void {
  win?.webContents.send(CH_TOAST, { level, msgJa });
}

// ── カウントダウンチャレンジ: モニター窓・ホットキー・可視性 ────────────────

function notifyMonitorState(): void {
  win?.webContents.send(CH_MONITOR_STATE, { open: getMonitorWindow() != null });
}

/**
 * バックプレッシャの集約: メイン窓とモニター窓の**両方**が隠れているときだけ
 * worker を 0.5Hz に落とす。メイン窓のイベント直結のままだと、ダッシュボードを
 * 最小化してモニターだけ見せる運用でカウントダウンがカクつく。
 */
function syncVisibility(): void {
  const visible = (w: BrowserWindow | null): boolean =>
    !!w && !w.isDestroyed() && !w.isMinimized() && w.isVisible();
  host?.send({ t: 'visibility', hidden: !visible(win) && !visible(getMonitorWindow()) });
}

function openMonitor(): void {
  // 冪等化: 開いている窓に対してリスナーを積み増さない(重複 open で
  // did-finish-load ごとにポートが多重配線され、worker 側の番犬がメイン窓の
  // ポートまで閉じ得る)。
  const existing = getMonitorWindow();
  if (existing) {
    existing.focus();
    notifyMonitorState();
    return;
  }
  const mon = openMonitorWindow(
    join(__dirname, '../preload/index.js'),
    settings.challenge.monitorDisplayId,
    settings.challenge.monitorWindowed,
    () => {
      notifyMonitorState();
      syncVisibility();
    }
  );
  host?.attachRenderer(mon.webContents);
  // Re-handshake the firehose port after a reload (メイン窓と同じ流儀)。
  mon.webContents.on('did-finish-load', () => {
    const m = getMonitorWindow();
    if (m) host?.attachRenderer(m.webContents);
  });
  mon.on('hide', syncVisibility);
  mon.on('minimize', syncVisibility);
  mon.on('show', syncVisibility);
  mon.on('restore', syncVisibility);
  notifyMonitorState();
  syncVisibility();
}

let registeredHotkey: string | null = null;
let hotkeySeq = 0;

/**
 * 物理ボタン(=キーボードとして振る舞う USB ボタン)用のグローバルホットキー。
 * アプリにフォーカスが無くても届く。登録失敗(他アプリと衝突)でも起動は止めない。
 */
function syncChallengeHotkey(): void {
  if (registeredHotkey) {
    try {
      globalShortcut.unregister(registeredHotkey);
    } catch {
      /* unregister 失敗は無害 */
    }
    registeredHotkey = null;
  }
  const acc = settings.challenge.hotkey;
  if (!acc || !settings.challenge.enabled) return;
  try {
    const ok = globalShortcut.register(acc, () => {
      // 既存の RPC 経路に相乗り — correlation と worker 起動中のキューイングが手に入る。
      void host?.rpc({
        id: `hk-${Date.now().toString(36)}-${hotkeySeq++}`,
        method: 'challenge.press',
        params: undefined,
      });
    });
    if (ok) registeredHotkey = acc;
    else toast('warn', `ホットキー ${acc} は他のアプリに使われています。設定で変更してください。`);
  } catch {
    toast('warn', `ホットキー ${acc} を登録できませんでした。設定を確認してください。`);
  }
}

function readDoc(name: string): string {
  const p = docsPath(name);
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : '';
  } catch {
    return '';
  }
}

/** Answered in main: these touch the filesystem, dialogs, or the worker's own config. */
async function handleMainRpc(req: RpcRequest): Promise<RpcResponse> {
  const id = req.id;
  try {
    switch (req.method) {
      case 'cfg.get':
        return { id, ok: true, result: settings } as RpcResponse;

      case 'cfg.set': {
        const prev = settings;
        const next: AppSettings = { ...settings, ...(req.params as Partial<AppSettings>) };
        // 起動時(loadSettings)と同じ防御をこの経路にも — UI から来た値でも
        // clamp してからエンジンに渡す(pressStep 負値などが素通りしないように)。
        next.challenge = validateChallengeConfig(next.challenge);
        const restart = needsWorkerRestart(settings, next);
        settings = next;
        saveSettings(dataDir, settings);
        if (restart) {
          await host?.restart(bootPayload());
        } else {
          host?.send({ t: 'settings', settings });
          // クラッシュ自動再起動が古い設定に巻き戻らないようにペイロードも更新。
          host?.refreshBoot(bootPayload());
        }
        // 保存を両ウィンドウへ即時プッシュ — モニターの30秒ポーリングを待つと
        // 「▶ モニター」の実演が保存前の割り当てで再生されうる。
        win?.webContents.send(CH_SETTINGS_PUSH, settings);
        getMonitorWindow()?.webContents.send(CH_SETTINGS_PUSH, settings);
        // チャレンジ関連の main 側リソースを追随させる。
        syncChallengeHotkey();
        if (prev.challenge.monitorWindowed !== settings.challenge.monitorWindowed && getMonitorWindow()) {
          // 枠(frame)は生成時にしか変えられないため、開いていれば作り直す。
          closeMonitorWindow();
          setTimeout(() => openMonitor(), 350);
        } else if (prev.challenge.monitorDisplayId !== settings.challenge.monitorDisplayId) {
          repositionMonitor(settings.challenge.monitorDisplayId, settings.challenge.monitorWindowed);
        }
        return { id, ok: true, result: { workerRestarted: restart } } as RpcResponse;
      }

      case 'file.exportCsv': {
        const spec = req.params as CsvExportSpec;
        const path = await askCsvPath(win, spec.kind);
        if (!path) return { id, ok: true, result: null } as RpcResponse;
        const res = await host!.rpc({ id: `${id}:w`, method: 'w.exportCsv', params: { spec, path } });
        if (!res.ok) return { id, ok: false, error: res.error };
        return { id, ok: true, result: { path, rows: (res.result as { rows: number }).rows } } as RpcResponse;
      }

      case 'file.backup': {
        const path = await askBackupPath(win);
        if (!path) return { id, ok: true, result: null } as RpcResponse;
        const res = await host!.rpc({ id: `${id}:w`, method: 'w.backup', params: { path } });
        if (!res.ok) return { id, ok: false, error: res.error };
        return { id, ok: true, result: { path } } as RpcResponse;
      }

      case 'file.openDataDir':
        await shell.openPath(dataDir);
        return { id, ok: true, result: undefined } as RpcResponse;

      /**
       * Point this build at a database that lives somewhere else.
       *
       * The portable and installed builds keep separate databases by design, so
       * someone who recorded months of history with one and then installs the
       * other would otherwise open an empty app and conclude the data was lost.
       */
      case 'file.pickDataDir': {
        const picked = await dialog.showOpenDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
          title: 'データベースを選ぶ（analytics.db）',
          defaultPath: settings.dbPath,
          filters: [{ name: 'SQLite データベース', extensions: ['db'] }],
          properties: ['openFile'],
        });
        if (picked.canceled || !picked.filePaths[0]) return { id, ok: true, result: null } as RpcResponse;
        const chosen = picked.filePaths[0];

        // Confirm it is one of ours before rebinding — pointing the app at an
        // unrelated .db would fail obscurely inside the migration runner.
        let viewers = 0;
        try {
          const { DatabaseSync } = await import('node:sqlite');
          const probe = new DatabaseSync(chosen, { readOnly: true });
          viewers = Number((probe.prepare('SELECT COUNT(*) AS c FROM viewer').get() as { c: number }).c);
          probe.close();
        } catch {
          return {
            id,
            ok: false,
            error: { code: 'VALIDATION', message: 'このファイルは本アプリのデータベースではないようです。' },
          };
        }

        settings = { ...settings, dbPath: chosen };
        saveSettings(dataDir, settings);
        await host?.restart(bootPayload());
        return { id, ok: true, result: { dbPath: chosen, viewers } } as RpcResponse;
      }

      case 'file.openMissions': {
        const p = join(configDirIn(dataDir), 'missions.json');
        if (!existsSync(p)) {
          // Seed the editable copy from the bundled default on first open.
          const src = join(resourcesDir(), 'missions.default.json');
          if (existsSync(src)) {
            const { copyFileSync } = await import('node:fs');
            copyFileSync(src, p);
          }
        }
        await shell.openPath(p);
        return { id, ok: true, result: undefined } as RpcResponse;
      }

      case 'file.saveSource': {
        const path = await askSourceZipPath(win, app.getVersion());
        if (!path) return { id, ok: true, result: null } as RpcResponse;
        // AGPL conveyance: the archive ships beside the installer.
        const bundled = docsPath(`tiktok-live-stats-source-${app.getVersion()}.zip`);
        if (existsSync(bundled)) {
          const { copyFileSync } = await import('node:fs');
          copyFileSync(bundled, path);
          return { id, ok: true, result: { path } } as RpcResponse;
        }
        return {
          id,
          ok: false,
          error: {
            code: 'INTERNAL',
            message: 'ソースアーカイブが同梱されていません。SOURCE-OFFER.txt のリポジトリから取得してください。',
          },
        };
      }

      case 'app.licenses':
        return {
          id,
          ok: true,
          result: {
            license: readDoc('LICENSE'),
            sourceOffer: readDoc('SOURCE-OFFER.txt'),
            thirdParty: readDoc('THIRD-PARTY-NOTICES.md'),
          },
        } as RpcResponse;

      case 'monitor.open':
        openMonitor();
        return { id, ok: true, result: { open: true } } as RpcResponse;

      case 'monitor.close':
        closeMonitorWindow();
        return { id, ok: true, result: { open: false } } as RpcResponse;

      case 'monitor.status':
        return { id, ok: true, result: { open: getMonitorWindow() != null } } as RpcResponse;

      case 'monitor.displays': {
        const primaryId = screen.getPrimaryDisplay().id;
        const result = screen.getAllDisplays().map((d) => ({
          id: d.id,
          label: d.label || `ディスプレイ ${d.id}`,
          primary: d.id === primaryId,
          width: d.size.width,
          height: d.size.height,
        }));
        return { id, ok: true, result } as RpcResponse;
      }

      default:
        return { id, ok: false, error: { code: 'VALIDATION', message: `未対応: ${req.method}` } };
    }
  } catch (e) {
    return { id, ok: false, error: { code: 'INTERNAL', message: (e as Error)?.message ?? String(e) } };
  }
}

async function boot(): Promise<void> {
  settings = loadSettings(dataDir);

  await app.whenReady();

  win = createWindow(join(__dirname, '../preload/index.js'));
  if (process.platform === 'darwin') {
    // mac ではメニューを null にすると Cmd+Q / Cmd+C/V ごとメニューバーが死ぬ。
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        { role: 'appMenu' }, // Cmd+Q, Hide など
        { role: 'editMenu' }, // Cmd+C/V/X/A — これがないとクリップボードが効かない
        { role: 'windowMenu' },
      ])
    );
  } else {
    Menu.setApplicationMenu(null);
  }

  const found = findExistingDb();
  if (!existsSync(settings.dbPath)) {
    const adopt = await offerAdoptDb(win, found, settings.dbPath);
    if (adopt) {
      settings = { ...settings, dbPath: adopt };
      saveSettings(dataDir, settings);
    }
  }

  host = new WorkerHost({
    onState: (s, detail) => {
      win?.webContents.send(CH_WORKER_STATE, s);
      if (s === 'dead') toast('error', `記録エンジンが停止しました。アプリを再起動してください。${detail ? `（${detail}）` : ''}`);
    },
    // Fallback path only — the firehose normally goes worker -> renderer directly.
    onLive: (m) => {
      win?.webContents.send('live-fallback', m);
      getMonitorWindow()?.webContents.send('live-fallback', m);
    },
    onFatal: (message) => toast('error', `内部エラー: ${message}`),
  });

  host.start(bootPayload());
  host.attachRenderer(win.webContents);

  win.on('closed', () => {
    win = null;
    // モニターだけ残ると window-all-closed が発火せずプロセスが浮く。
    closeMonitorWindow();
  });
  // Backpressure: while hidden the worker drops to 0.5 Hz and stops the feed
  // entirely. The database keeps recording everything regardless. モニター窓が
  // 見えている間は落とさない(syncVisibility が両窓を集約する)。
  win.on('hide', syncVisibility);
  win.on('minimize', syncVisibility);
  win.on('show', syncVisibility);
  win.on('restore', syncVisibility);

  // 配信中の HDMI 抜き差しでモニターを置き去りにしない。
  screen.on('display-added', () =>
    repositionMonitor(settings.challenge.monitorDisplayId, settings.challenge.monitorWindowed)
  );
  screen.on('display-removed', () =>
    repositionMonitor(settings.challenge.monitorDisplayId, settings.challenge.monitorWindowed)
  );

  ipcMain.handle('rpc', async (_e, req: RpcRequest): Promise<RpcResponse> => {
    if (MAIN_HANDLED.has(req.method)) return handleMainRpc(req);
    return host!.rpc(req);
  });

  // Re-handshake the firehose port after a renderer reload.
  win.webContents.on('did-finish-load', () => {
    if (win) host?.attachRenderer(win.webContents);
    // ここで初回登録する — boot 直後だと登録失敗トーストが購読前に消えるため。
    syncChallengeHotkey();
  });
}

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

app.on('window-all-closed', () => {
  void (async () => {
    await host?.shutdown();
    app.quit();
  })();
});

// mac では Cmd+Q が主要な終了経路で window-all-closed を経由しないことがある。
// shutdown を待たずに死ぬと worker の DB flush が保証されないため、ここで待つ。
// (window-all-closed 経由で shutdown 済みの場合、2回目の shutdown は即 resolve する)
let shuttingDown = false;
app.on('before-quit', (e) => {
  if (shuttingDown || !host) return;
  e.preventDefault();
  shuttingDown = true;
  void (async () => {
    try {
      await host.shutdown();
    } finally {
      app.quit();
    }
  })();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

void boot();
