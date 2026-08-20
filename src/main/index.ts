import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { app, BrowserWindow, dialog, globalShortcut, ipcMain, Menu, protocol, screen, shell } from 'electron';
import type { AppSettings, ChallengeConfig, CsvExportSpec } from '@shared/dto';
import { CH_MONITOR_STATE, CH_SETTINGS_PUSH, CH_TOAST, CH_WORKER_STATE, MAIN_HANDLED, type RpcRequest, type RpcResponse } from '@shared/ipc';
import { clearChallengeDefault, defaultSettings, loadChallengeDefault, loadSettings, needsWorkerRestart, sanitizeSettings, saveChallengeDefault, saveSettings } from './boot-settings';
import { CUSTOM_SOUND_EXTS, importSoundFile, parseByteRange, resolveCustomSoundPath, soundMimeType, soundsDirIn } from './custom-sounds';
import { askBackupPath, askCsvPath, askSoundImportPath, askSourceZipPath, offerAdoptDb } from './dialogs';
import { closeMonitorWindow, getMonitorWindow, getMonitorWindowPid, openMonitorWindow, repositionMonitor } from './monitor-window';
import { configDirIn, defaultDataDir, docsPath, findExistingDb, isPortable, resourcesDir } from './paths';
import { attachConsoleCapture, diagLogDir, initDiagLog, recentDiag, report } from './diag-log';
import { startMetricsSampler, stopMetricsSampler } from './metrics';
import { startLoopLagMeter } from '../worker/loop-lag';
import { WorkerHost } from './worker-host';
import { resetAutoRecoverBudget, tryAutoRecoverMonitor, watchDashboardWindow, watchMonitorWindow } from './window-health';
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

/**
 * カスタム回転音(config/sounds/)の配信スキーム。**app.whenReady より前が必須**
 * (ready 後の registerSchemesAsPrivileged は無効)なのでトップレベルに置く —
 * boot() 内へ移すと packaged でだけ media 再生が黙って失敗する。
 * stream: true が <audio>/<video> 再生の要件、secure: true が dev
 * (http://localhost ページ)からの読み込みブロック回避。ハンドラ本体は boot() 内。
 */
protocol.registerSchemesAsPrivileged([
  { scheme: 'app-sound', privileges: { secure: true, stream: true, supportFetchAPI: true } },
]);

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

/**
 * モニター窓を作り直す。手動(monitor.restart)と自動復旧(window-health)の
 * 唯一の合流点 — close が非同期なので 350ms 挟む。openMonitor 経由なので
 * MessagePort の再アタッチ・monitorOpen 通知・ディスプレイ設定の読み直しは自動。
 */
function restartMonitorWindow(): void {
  if (getMonitorWindow()) {
    closeMonitorWindow();
    setTimeout(() => openMonitor(), 350);
  } else {
    openMonitor();
  }
}

function openMonitor(): void {
  // 冪等化: 開いている窓に対してリスナーを積み増さない(重複 open で
  // did-finish-load ごとにポートが多重配線され、worker 側の番犬がメイン窓の
  // ポートまで閉じ得る)。
  const existing = getMonitorWindow();
  if (existing) {
    existing.focus();
    notifyMonitorState();
    // 開いているのに worker 側の monitorOpen が false に食い違っていると、
    // fxAllowed() が立たずカットインが「モニター未表示」で抑止され続ける。
    // setMonitorOpen は冪等(同値なら no-op)なので、真実(=窓は開いている)を
    // 毎回送り直して自己修復させる。
    host?.send({ t: 'monitorOpen', open: true });
    return;
  }
  const mon = openMonitorWindow(
    join(__dirname, '../preload/index.js'),
    settings.challenge.monitorDisplayId,
    settings.challenge.monitorWindowed,
    () => {
      notifyMonitorState();
      syncVisibility();
      // 閉で凍結許可を落とす — 誰も再生しないカットインのために worker が
      // カウントダウンを止め続けないように(challenge.fxCaps の対)。
      host?.send({ t: 'monitorOpen', open: false });
    }
  );
  host?.attachRenderer(mon.webContents);
  host?.send({ t: 'monitorOpen', open: true });
  // 診断: この窓の console を main のリングへ。レンダラ側は1行も変えずに
  // 既存の fxWarn 21箇所と fx エンジンの警告が事後に読めるようになる。
  attachConsoleCapture(mon.webContents, 'monitor');
  // エラーバウンダリが構造的に見られない側(OOM・GPU 巻き添え・sad tab)を拾う。
  watchMonitorWindow(mon, { restartMonitor: restartMonitorWindow, toast });
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
        // 起動時(loadSettings)と同じ防御をこの経路にも — UI から来た値でも
        // clamp してからエンジンに渡す。challenge だけでなく scoring の負の重みや
        // 非有限の diamondToJpy 等も、DB のスコアに永続化される前にここで止める。
        const next: AppSettings = sanitizeSettings(settings, req.params as Partial<AppSettings>);
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
        // 保存を両ウィンドウへ即時プッシュ — モニターの保険ポーリング(CFG_POLL_MS=120秒)を待つと
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

      // デフォ保存 — チャレンジ設定を config/challenge-default.json へ書き出す。
      // 以後このファイルが既定(defaultSettings / 「すべて既定に戻す」の戻り先)になり、
      // 他PCの同じ場所へコピーすればそのPCでも同じ内容が既定になる。
      case 'challengeDefault.save': {
        const path = saveChallengeDefault(dataDir, req.params as ChallengeConfig);
        return { id, ok: true, result: { path } } as RpcResponse;
      }

      case 'challengeDefault.get': {
        const custom = loadChallengeDefault(dataDir);
        return {
          id,
          ok: true,
          result: { cfg: custom ?? defaultSettings(dataDir).challenge, custom: custom != null },
        } as RpcResponse;
      }

      // 「同梱デフォで更新」 — ユーザーのデフォ保存を消し、同梱の公開デフォ
      // (resources/challenge-default.json、無ければ組み込み既定)を実効既定に戻す。
      case 'challengeDefault.clear': {
        const removed = clearChallengeDefault(dataDir);
        return {
          id,
          ok: true,
          result: { removed, cfg: defaultSettings(dataDir).challenge },
        } as RpcResponse;
      }

      // カスタム回転音の取込み — 選択ダイアログ → config/sounds/ へコピー。
      // キャンセルは null(file.pickDataDir と同じ流儀)、サイズ超過などは
      // VALIDATION エラー → renderer の rpc() throw → トースト。
      case 'sound.importCustom': {
        const src = await askSoundImportPath(win, CUSTOM_SOUND_EXTS);
        if (!src) return { id, ok: true, result: null } as RpcResponse;
        const r = importSoundFile(dataDir, src);
        if (!r.ok) return { id, ok: false, error: { code: 'VALIDATION', message: r.message } };
        return { id, ok: true, result: { file: r.file } } as RpcResponse;
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

      case 'file.openDataDir': {
        // openPath は throw せずエラー文字列を返す — 捨てると失敗が成功に見える。
        const openErr = await shell.openPath(dataDir);
        if (openErr) return { id, ok: false, error: { code: 'INTERNAL', message: openErr } };
        return { id, ok: true, result: undefined } as RpcResponse;
      }

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
        const openErr = await shell.openPath(p);
        if (openErr) return { id, ok: false, error: { code: 'INTERNAL', message: openErr } };
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

      // 窓ごと作り直す。close は非同期(BrowserWindow の 'closed' でシングルトンが null に
      // なる)なので、続けて open すると monitor-window の冪等ガードに当たって死にかけの窓を
      // focus するだけになる。cfg.set の monitorWindowed 変更と同じ 350ms を挟む。
      // openMonitor() 経由なので MessagePort の再アタッチ・monitorOpen 通知・現在の
      // ディスプレイ設定の読み直しはすべて自動で走る。閉じているときは待たずに開く。
      case 'monitor.restart': {
        // 手動は無条件 — 自動復旧が止まったあと人が押して直す、が通常の運用なので
        // ここで予算も戻す(ループガードは自動側にだけ掛ける)。
        resetAutoRecoverBudget();
        restartMonitorWindow();
        return { id, ok: true, result: { open: true } } as RpcResponse;
      }

      case 'monitor.crashed': {
        const c = req.params as { message: string; componentStack?: string };
        report(
          'monitor',
          'error',
          ['[diag] モニターの描画が例外で停止: ' + c.message, c.componentStack ?? ''].join('\n').trimEnd()
        );
        tryAutoRecoverMonitor('render-error', { restartMonitor: restartMonitorWindow, toast });
        return { id, ok: true, result: undefined } as RpcResponse;
      }

      case 'diag.report': {
        const d = req.params as { scope: 'dashboard' | 'monitor'; level: 'warn' | 'error'; message: string };
        report(d.scope, d.level, d.message);
        return { id, ok: true, result: undefined } as RpcResponse;
      }

      case 'diag.recent':
        return { id, ok: true, result: recentDiag(100) } as RpcResponse;

      case 'diag.openLogDir': {
        const dir = diagLogDir();
        if (!dir) return { id, ok: false, error: { code: 'INTERNAL', message: 'ログフォルダが未初期化です' } };
        const derr = await shell.openPath(dir);
        if (derr) return { id, ok: false, error: { code: 'INTERNAL', message: derr } };
        return { id, ok: true, result: undefined } as RpcResponse;
      }

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
  // 設定より先に — loadSettings 中の警告も拾えるようにする。
  initDiagLog(dataDir);
  // main 側の停止メーター(worker/loop-lag と同じ実装。別バンドルなので状態も別)。
  // worker の「イベントループが Nms 停止」と時刻を突き合わせることで、停止が
  // worker 単独(DB/コード)かマシン全体(ディスク・AV・スリープ)かを diag.log
  // だけで切り分ける — 実配信で観測した21秒停止の原因特定のための計器。
  startLoopLagMeter((lagMs) => {
    report('main', 'error', `[diag] main イベントループが ${lagMs}ms 停止しました(worker 側の警告と時刻を突き合わせる)`);
  });
  settings = loadSettings(dataDir);

  await app.whenReady();

  // カスタム回転音の読み口。デフォルトセッション登録なのでメイン窓(試聴)と
  // モニター窓(本番)の両方に効く。resolveCustomSoundPath が containment の
  // 最終防衛線(config/sounds/ 外は 404)。
  // ディレクトリはここで1回だけ作る — ハンドラ内で mkdir すると、ループ音の
  // 再生と Range 要求のたびに syscall が増えるうえ、読み取りが書き込みを伴う。
  //
  // **Range は自前で処理する。** net.fetch(file://) に丸投げすると req のヘッダが
  // 引き継がれず、Chromium が投げた `Range: bytes=N-` に対しても常に 200 + 全体を
  // 返してしまう。加えて file:// の応答は Content-Length を持たないので長さ不明
  // ストリーム扱いになり、WAV/OGG の duration が Infinity になる。実測では、
  // モニターがカットイン動画を並行再生してバッファが追い出される状況で、数MB級の
  // WAV をループさせるとループ折返しの再取得が要求と食い違い、
  // PIPELINE_ERROR_READ でその回の回転音が死ぬ(以後その要素は復帰しない)。
  const soundsDir = soundsDirIn(dataDir);
  protocol.handle('app-sound', (req) => {
    const p = resolveCustomSoundPath(soundsDir, new URL(req.url).pathname);
    if (!p) return new Response(null, { status: 404 });
    let size: number;
    try {
      const st = statSync(p);
      if (!st.isFile()) return new Response(null, { status: 404 });
      size = st.size;
    } catch {
      return new Response(null, { status: 404 }); // 取り込んだファイルを消した等
    }
    const type = soundMimeType(p);
    const range = parseByteRange(req.headers.get('range'), size);
    if (range === 'invalid') {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = Readable.toWeb(createReadStream(p, { start, end })) as ReadableStream;
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
    };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    return new Response(body, { status: range ? 206 : 200, headers });
  });

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
      // モニター窓にも配る — MonitorView は ready への遷移で fxCaps を即時再申告する
      // (再送がモニターの 120 秒ポーリング頼みだった頃は、worker の起動レース/
      // 再起動から最大2分、カットインが全部「モニター未表示/動きの抑制」で
      // 拒否されていた — dev 起動直後の実配信ログで実測した穴)。
      getMonitorWindow()?.webContents.send(CH_WORKER_STATE, s);
      // worker 再起動で凍結許可(monitorOpen/fxCaps)は既定 false に戻る —
      // 窓の開閉状態は main から再送する(fxCaps は上記のモニター側 effect が再送)。
      if (s === 'ready') host?.send({ t: 'monitorOpen', open: getMonitorWindow() != null });
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

  attachConsoleCapture(win.webContents, 'dashboard');

  // 診断メトリクス: 60秒ごとに各プロセスの RSS/CPU を logs/diag.log へ。
  // 配布先の「何時間目からどのプロセスが太るか」をログだけで追うため。
  // getAppMetrics ごと deps 注入なのは metrics.ts を electron 非依存に保つため。
  startMetricsSampler({
    getAppMetrics: () => app.getAppMetrics(),
    getMainWindowPid: () => (win && !win.isDestroyed() ? win.webContents.getOSProcessId() : null),
    getMonitorWindowPid,
    getWorkerPid: () => host?.pid ?? null,
  });

  watchDashboardWindow(win, {
    toast,
    onRepeatCrash: (reason) => {
      // 短時間の再発 = 本当に壊れている。ここだけは操作者を止める。
      void dialog
        .showMessageBox({
          type: 'error',
          title: '画面が繰り返し停止しました',
          message: '画面のプロセスが短時間に繰り返し停止しました(' + reason + ')。',
          detail: '再読み込みで直らない場合はアプリを再起動してください。集計データは保存されています。',
          buttons: ['再読み込み', '閉じる'],
          defaultId: 0,
          cancelId: 1,
        })
        .then((r) => {
          if (r.response === 0 && win && !win.isDestroyed()) win.reload();
        });
    },
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
  stopMetricsSampler(); // unref 済みだが、終了処理中の採取(半壊状態の getAppMetrics)を避ける
  globalShortcut.unregisterAll();
});

// 初期化失敗(書込不可のポータブルUSB・権限のないフォルダ等)を無言で握らない —
// ウィンドウが出ないままプロセスだけ残るのが一番わかりにくい壊れ方になる。
void boot().catch((e) => {
  try {
    dialog.showErrorBox(
      '起動に失敗しました',
      `${(e as Error)?.message ?? String(e)}\n\nデータフォルダに書き込めない可能性があります。`
    );
  } finally {
    app.exit(1);
  }
});
