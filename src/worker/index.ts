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
for (const sig of ['uncaughtException', 'unhandledRejection'] as const) {
  process.on(sig, (err: unknown) => {
    post({ t: 'fatal', message: (err as Error)?.message ?? String(err) });
    try {
      store?.close();
    } catch {
      /* best effort */
    }
  });
}

post({ t: 'boot-request' });
