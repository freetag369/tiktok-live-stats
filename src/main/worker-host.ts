import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { RPC_TIMEOUT_MS } from '@shared/constants';
import type { AppSettings, StoreCapabilities } from '@shared/dto';
import type { RpcRequest, RpcResponse, WorkerState } from '@shared/ipc';
import { CH_FEED_PORT } from '@shared/ipc';
import { workerEntry } from './paths';

interface Pending {
  resolve: (r: RpcResponse) => void;
  timer: NodeJS.Timeout;
}

export interface WorkerHostDeps {
  onState: (s: WorkerState, detail?: string) => void;
  onLive: (m: unknown) => void;
  onFatal: (message: string) => void;
}

/**
 * Owns the utilityProcess lifecycle and the two channels:
 *   main <-> worker   RPC over the parent port (low volume, needs correlation)
 *   worker -> renderer  the firehose, over a direct MessagePort main only brokers
 */
export class WorkerHost {
  private proc: UtilityProcess | null = null;
  private pending = new Map<string, Pending>();
  private queue: Array<{ req: RpcRequest; resolve: (r: RpcResponse) => void }> = [];
  private ready = false;
  private restarts = 0;
  private stopping = false;
  /** メイン窓とモニター窓 — firehose ポートはウィンドウごとに1本張る。 */
  private wcs = new Set<WebContents>();
  /**
   * クラッシュ自動再起動に使う boot ペイロード。設定変更のたびに refreshBoot で
   * 差し替える — start() 時のクロージャのままだと、再起動で古い設定に巻き戻る。
   */
  private bootPayload: Parameters<WorkerHost['start']>[0] | null = null;

  caps: StoreCapabilities | null = null;
  missionError: string | null = null;

  constructor(private readonly deps: WorkerHostDeps) {}

  start(boot: {
    dbPath: string;
    userDataDir: string;
    configDir: string;
    resourcesDir: string;
    settings: AppSettings;
    appInfo: { gitSha: string; buildTime: string; appVersion: string };
  }): void {
    this.stopping = false;
    this.ready = false;
    this.bootPayload = boot;
    this.deps.onState('starting');

    const proc = utilityProcess.fork(workerEntry(), [], {
      // node:sqlite is a release candidate and warns on every open.
      execArgv: ['--no-warnings'],
      stdio: 'pipe',
      serviceName: 'tiktok-live-stats-worker',
    });
    this.proc = proc;

    proc.stdout?.on('data', (d: Buffer) => console.log('[worker]', d.toString().trimEnd()));
    proc.stderr?.on('data', (d: Buffer) => console.error('[worker]', d.toString().trimEnd()));

    proc.on('message', (msg: Record<string, unknown>) => {
      switch (msg?.t) {
        case 'boot-request':
          proc.postMessage({ t: 'boot', ...boot });
          return;
        case 'ready':
          this.caps = msg.caps as StoreCapabilities;
          this.missionError = (msg.missionError as string) ?? null;
          this.ready = true;
          this.deps.onState('ready');
          this.flushQueue();
          for (const wc of this.wcs) this.wireFeedPort(wc);
          return;
        case 'rpcResult': {
          const res = msg.res as RpcResponse;
          const p = this.pending.get(res.id);
          if (p) {
            clearTimeout(p.timer);
            this.pending.delete(res.id);
            p.resolve(res);
          }
          return;
        }
        case 'live':
          this.deps.onLive(msg.m);
          return;
        case 'fatal':
          this.deps.onFatal(String(msg.message ?? ''));
          return;
        case 'shutdownDone':
          proc.kill();
          return;
      }
    });

    proc.on('exit', (code) => {
      this.ready = false;
      this.proc = null;
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ id, ok: false, error: { code: 'WORKER_DOWN', message: 'ワーカーが停止しました。' } });
      }
      this.pending.clear();
      if (this.stopping) {
        this.deps.onState('dead');
        return;
      }
      // A crash must not end the session silently — restart, but give up rather
      // than spin if it keeps dying.
      if (this.restarts < 5) {
        this.restarts++;
        this.deps.onState('restarting', `exit ${code}`);
        setTimeout(() => this.start(this.bootPayload ?? boot), 1000 * this.restarts);
      } else {
        this.deps.onState('dead', `exit ${code}`);
      }
    });
  }

  /** Renderer gets a direct line to the worker; 20k events/min never touch main. */
  attachRenderer(wc: WebContents): void {
    if (!this.wcs.has(wc)) {
      this.wcs.add(wc);
      wc.once('destroyed', () => this.wcs.delete(wc));
    }
    // リロード後の再ハンドシェイクを含め、呼ばれるたびに新しいポートを張る。
    // 古いポートは worker 側が close イベントで自己清掃する。
    if (this.ready) this.wireFeedPort(wc);
  }

  private wireFeedPort(wc: WebContents): void {
    if (!this.proc || wc.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.proc.postMessage({ t: 'feedPort' }, [port1]);
    wc.postMessage(CH_FEED_PORT, null, [port2]);
  }

  send(msg: unknown): void {
    this.proc?.postMessage(msg);
  }

  rpc(req: RpcRequest): Promise<RpcResponse> {
    if (!this.proc) {
      return Promise.resolve({ id: req.id, ok: false, error: { code: 'WORKER_DOWN', message: 'ワーカーが停止しています。' } });
    }
    if (!this.ready) {
      // Brief startup window — hold a bounded number of requests instead of failing.
      if (this.queue.length >= 32) {
        return Promise.resolve({ id: req.id, ok: false, error: { code: 'WORKER_DOWN', message: '起動中です。' } });
      }
      return new Promise((resolve) => this.queue.push({ req, resolve }));
    }
    return this.dispatch(req);
  }

  private dispatch(req: RpcRequest): Promise<RpcResponse> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        resolve({ id: req.id, ok: false, error: { code: 'TIMEOUT', message: '応答がタイムアウトしました。' } });
      }, RPC_TIMEOUT_MS);
      timer.unref?.();
      this.pending.set(req.id, { resolve, timer });
      this.proc?.postMessage({ t: 'rpc', req });
    });
  }

  private flushQueue(): void {
    const q = this.queue;
    this.queue = [];
    for (const item of q) void this.dispatch(item.req).then(item.resolve);
  }

  /** 設定変更を自動再起動用ペイロードにも反映する(worker には別途 settings を送る)。 */
  refreshBoot(boot: Parameters<WorkerHost['start']>[0]): void {
    this.bootPayload = boot;
  }

  async restart(boot: Parameters<WorkerHost['start']>[0]): Promise<void> {
    await this.shutdown();
    this.restarts = 0;
    this.start(boot);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    if (!this.proc) return;
    const p = this.proc;
    p.postMessage({ t: 'shutdown' });
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          p.kill();
        } catch {
          /* already gone */
        }
        resolve();
      }, 4000);
      p.once('exit', () => {
        clearTimeout(t);
        resolve();
      });
    });
    this.proc = null;
  }
}
