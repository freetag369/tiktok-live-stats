import { readFileSync } from 'node:fs';
import { join } from 'node:path';
// Type-only: erased at build time, so the worker bundle has no electron dependency.
import type { MessagePortMain } from 'electron';
import type { RpcRequest } from '@shared/ipc';
import type { LiveMessage } from '@shared/ipc';
import type { AppSettings, ScoringConfig } from '@shared/dto';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { DEFAULT_SCORING } from '@shared/scoring';
import { ChallengeEngine } from './challenge';
import { SessionManager } from './session';
import { Store } from './store/index';
import { MissionStore, createRpcServer } from './rpc-server';

/**
 * utilityProcess entry (ESM).
 *
 * The connector is ESM-only and node:sqlite is fully synchronous, so both live
 * here rather than in main: a 500 ms analytics scan in the main process would
 * freeze the window AND stall the websocket read loop at the same time.
 */

interface BootMessage {
  t: 'boot';
  dbPath: string;
  userDataDir: string;
  configDir: string;
  resourcesDir: string;
  settings: AppSettings;
  appInfo: { gitSha: string; buildTime: string; appVersion: string };
}

type InMessage =
  | BootMessage
  | { t: 'rpc'; req: RpcRequest }
  | { t: 'settings'; settings: AppSettings }
  | { t: 'visibility'; hidden: boolean }
  /** モニター窓の開閉(main 発)。カットイン凍結の許可条件の片翼。 */
  | { t: 'monitorOpen'; open: boolean }
  | { t: 'shutdown' };

let store: Store | null = null;
let session: SessionManager | null = null;
let missions: MissionStore | null = null;
let challenge: ChallengeEngine | null = null;
let handle: ((req: RpcRequest) => Promise<unknown>) | null = null;
let settings: AppSettings | null = null;
/** ウィンドウごとに1本。メイン窓とモニター窓で複数になる。 */
let feedPorts: MessagePortMain[] = [];

function post(msg: unknown): void {
  process.parentPort?.postMessage(msg);
}

/** Live traffic goes straight to the renderer; main only brokered the handshake. */
function pushLive(m: LiveMessage): void {
  let delivered = false;
  for (const p of [...feedPorts]) {
    try {
      p.postMessage(m);
      delivered = true;
    } catch {
      feedPorts = feedPorts.filter((x) => x !== p);
    }
  }
  // 全ポート死亡時のみ main 経由へフォールバック(firehose を main に流さない)。
  if (!delivered) post({ t: 'live', m });
}

function loadGiftAliases(resourcesDir: string): {
  idAliases: Record<string, string>;
  nameRules: Array<{ canonical: string; match: string[] }>;
} {
  try {
    const raw = JSON.parse(readFileSync(join(resourcesDir, 'gift-aliases.default.json'), 'utf8')) as {
      idAliases?: Record<string, string>;
      nameRules?: Array<{ canonical: string; match: string[] }>;
    };
    return { idAliases: raw.idAliases ?? {}, nameRules: raw.nameRules ?? [] };
  } catch {
    return { idAliases: {}, nameRules: [] };
  }
}

/**
 * このスレッドが止まっていた時間の計測。
 *
 * worker は単一スレッドで node:sqlite も同期なので、重いクエリが走っている間は
 * `challenge.press` の RPC メッセージが**配送すらされない**。つまりこの数字が
 * そのまま「ボタンが効かない時間」になる — 体感の重さと1対1で対応する唯一の
 * 指標なので、他の何を測るよりも先にこれを見ること。
 *
 * 1秒ごとの期待時刻とのズレを取り、読み出しでリセットする(直近区間の最大)。
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

function startLoopLagMeter(): void {
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

function boot(m: BootMessage): void {
  settings = m.settings;
  store = new Store();
  const caps = store.open({ dbPath: m.dbPath }, loadGiftAliases(m.resourcesDir));

  const stored = store.getSetting<ScoringConfig>('scoring.v1');
  store.setScoringConfig(stored ?? m.settings.scoring ?? DEFAULT_SCORING);

  missions = new MissionStore(m.configDir, m.resourcesDir);
  challenge = new ChallengeEngine(() => settings?.challenge ?? DEFAULT_CHALLENGE);
  session = new SessionManager({
    store,
    post: pushLive,
    userDataDir: m.userDataDir,
    getSettings: () => ({
      eulerApiKey: settings?.eulerApiKey ?? '',
      captureDebug: settings?.captureDebug ?? false,
      alertMinTier: settings?.alertMinTier ?? 1,
      giftAlertDiamonds: settings?.giftAlertDiamonds ?? 100,
    }),
    getMissionConfig: () => missions!.get(),
    challenge,
  });

  handle = createRpcServer(
    { store, session, challenge, configDir: m.configDir, resourcesDir: m.resourcesDir, appInfo: m.appInfo },
    missions
  ) as unknown as (req: RpcRequest) => Promise<unknown>;

  // 配信終了後(2Hz tick 停止中)でも凍結期限の解除を delta としてモニターへ配る。
  challenge.setOnFreezeExpired(() => session?.nudgeChallenge());

  startLoopLagMeter();

  post({ t: 'ready', caps, missionError: missions.lastError });
}

process.parentPort?.on('message', (e) => {
  // The feed MessagePortMain arrives as a transferable alongside the message.
  const ports = (e as { ports?: MessagePortMain[] }).ports;
  const msg = (e as { data?: InMessage }).data;

  if (ports && ports.length > 0 && msg && (msg as { t?: string }).t === 'feedPort') {
    const p = ports[0]!;
    // ウィンドウのリロード/クローズは close で検知して自己清掃する。
    p.on('close', () => {
      feedPorts = feedPorts.filter((x) => x !== p);
    });
    p.start();
    feedPorts.push(p);
    // 番犬: 再配線が繰り返されても無限に溜めない(窓は高々2枚)。
    while (feedPorts.length > 4) feedPorts.shift()?.close();
    return;
  }
  if (!msg) return;

  void (async () => {
    try {
      switch (msg.t) {
        case 'boot':
          boot(msg);
          return;
        case 'rpc': {
          if (!handle) {
            post({
              t: 'rpcResult',
              res: { id: msg.req.id, ok: false, error: { code: 'WORKER_DOWN', message: '初期化中です。' } },
            });
            return;
          }
          const res = await handle(msg.req);
          post({ t: 'rpcResult', res });
          return;
        }
        case 'settings': {
          const prevScoring = JSON.stringify(settings?.scoring ?? {});
          const prevChallenge = JSON.stringify(settings?.challenge ?? {});
          settings = msg.settings;
          if (store && JSON.stringify(msg.settings.scoring) !== prevScoring) {
            store.setScoringConfig(msg.settings.scoring);
          }
          if (challenge && JSON.stringify(msg.settings.challenge) !== prevChallenge) {
            challenge.onConfigChanged();
            session?.nudgeChallenge(); // タイトル・初期値の変更をモニターへ即反映
          }
          return;
        }
        case 'visibility':
          session?.setHidden(msg.hidden);
          return;
        case 'monitorOpen':
          // 閉→開はモニター側の fxCaps RPC が続けて届く。開→閉で凍結中なら
          // setMonitorOpen が即時解除して true を返すので delta を配る。
          if (challenge?.setMonitorOpen(msg.open)) session?.nudgeChallenge();
          return;
        case 'shutdown':
          await session?.stop('userStopped', false);
          store?.close();
          post({ t: 'shutdownDone' });
          return;
      }
    } catch (err) {
      post({ t: 'fatal', message: (err as Error)?.message ?? String(err) });
    }
  })();
});

// A crash here must not take the record with it: close the session cleanly so the
// next run does not have to guess at an orphan.
// close 後は必ず exit する — 以前は close だけしてプロセスが生き残り、以後の
// 全 DB 書き込みが失敗する半死状態になっていた(RPC は通るが何も保存されない
// 最悪の壊れ方)。exit すれば worker-host の自動再起動(最大5回)に乗る。
let crashing = false;
for (const sig of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(sig, (err: unknown) => {
    if (crashing) return; // 連鎖 fatal(uncaught→rejection)は1回に抑える
    crashing = true;
    post({ t: 'fatal', message: (err as Error)?.message ?? String(err) });
    try {
      store?.close();
    } catch {
      /* best effort */
    }
    // parentPort への post を flush してから死ぬ。
    setImmediate(() => process.exit(1));
  });
}

post({ t: 'boot-request' });
