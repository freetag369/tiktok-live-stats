import { MessageChannelMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron';
import { RPC_TIMEOUT_MS } from '@shared/constants';
import type { AppSettings, StoreCapabilities } from '@shared/dto';
import type { RpcRequest, RpcResponse, WorkerState } from '@shared/ipc';
import { CH_FEED_PORT } from '@shared/ipc';
import { reportWorkerLine } from './diag-log';
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
  /** クラッシュ後の自動再起動タイマー。shutdown で必ず止める(終了処理中の再 fork 防止)。 */
  private restartTimer: NodeJS.Timeout | null = null;
  /**
   * 再起動カウンタのリセットタイマー。再起動後 60 秒生き延びたら restarts を 0 に
   * 戻す — これが無いと「数時間に1回ずつ落ちる」耐久配信で累計5回に達した瞬間、
   * 以後 worker が永久に dead になりモニターが全停止する。60秒未満で落ち続ける
   * 場合はリセットが走らずカウントが進むので、従来のスピン防止は保たれる。
   */
  private stableTimer: NodeJS.Timeout | null = null;
  /**
   * メイン窓とモニター窓 — firehose ポートはウィンドウごとに1本張る。
   * lite = モニター窓(viewers/feed を worker が送らない — shared/live-lite.ts)。
   * フラグを Map で持つのは、worker 再起動(ready)や did-finish-load の
   * 再ハンドシェイクでも同じ種別で張り直すため。
   */
  private wcs = new Map<WebContents, { lite: boolean }>();
  /**
   * クラッシュ自動再起動に使う boot ペイロード。設定変更のたびに refreshBoot で
   * 差し替える — start() 時のクロージャのままだと、再起動で古い設定に巻き戻る。
   */
  private bootPayload: Parameters<WorkerHost['start']>[0] | null = null;

  caps: StoreCapabilities | null = null;
  missionError: string | null = null;

  constructor(private readonly deps: WorkerHostDeps) {}

  /** 診断メトリクス用 — 現在の worker の OS pid(未起動・停止中・spawn 失敗は null)。 */
  get pid(): number | null {
    return this.proc?.pid ?? null;
  }

  start(boot: {
    dbPath: string;
    userDataDir: string;
    configDir: string;
    resourcesDir: string;
    settings: AppSettings;
    appInfo: { gitSha: string; buildTime: string; appVersion: string };
  }): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
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

    // console はそのまま(開発時の見え方を変えない)+ 診断リングにも積む。
    // これで worker のイベントループ遅延警告が事後に読める。
    proc.stdout?.on('data', (d: Buffer) => {
      const line = d.toString().trimEnd();
      console.log('[worker]', line);
      reportWorkerLine('info', '[worker] ' + line);
    });
    proc.stderr?.on('data', (d: Buffer) => {
      const line = d.toString().trimEnd();
      console.error('[worker]', line);
      reportWorkerLine('error', '[worker] ' + line);
    });

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
          if (this.restarts > 0) {
            this.stableTimer = setTimeout(() => {
              this.stableTimer = null;
              this.restarts = 0;
            }, 60_000);
            this.stableTimer.unref?.();
          }
          this.flushQueue();
          for (const [wc, o] of this.wcs) this.wireFeedPort(wc, o.lite);
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
      // 60秒未満で落ちた場合はリセットさせない(スピン防止のカウントを保つ)。
      if (this.stableTimer) {
        clearTimeout(this.stableTimer);
        this.stableTimer = null;
      }
      for (const [id, p] of this.pending) {
        clearTimeout(p.timer);
        p.resolve({ id, ok: false, error: { code: 'WORKER_DOWN', message: 'ワーカーが停止しました。' } });
      }
      this.pending.clear();
      if (this.stopping) {
        this.deps.onState('dead');
        this.failQueue();
        return;
      }
      // A crash must not end the session silently — restart, but give up rather
      // than spin if it keeps dying.
      if (this.restarts < 5) {
        this.restarts++;
        this.deps.onState('restarting', `exit ${code}`);
        this.restartTimer = setTimeout(() => {
          this.restartTimer = null;
          this.start(this.bootPayload ?? boot);
        }, 1000 * this.restarts);
      } else {
        this.deps.onState('dead', `exit ${code}`);
        // dead になったら flushQueue は二度と呼ばれない — 起動待ちキューの
        // Promise を放置すると renderer の await が永遠に戻らず UI が固まる。
        this.failQueue();
      }
    });
  }

  /** 起動待ちキューを全部 WORKER_DOWN で解決する(dead 遷移時)。 */
  private failQueue(): void {
    const q = this.queue;
    this.queue = [];
    for (const item of q) {
      item.resolve({ id: item.req.id, ok: false, error: { code: 'WORKER_DOWN', message: 'ワーカーが停止しました。' } });
    }
  }

  /** Renderer gets a direct line to the worker; 20k events/min never touch main. */
  attachRenderer(wc: WebContents, opts?: { lite?: boolean }): void {
    const prev = this.wcs.get(wc);
    // opts 省略の再ハンドシェイクでは登録済みの種別を保つ(既定は full —
    // 間引き漏れは無害だが、メイン窓を誤って lite にするとフィードが消える)。
    const lite = opts?.lite ?? prev?.lite ?? false;
    if (!prev) {
      wc.once('destroyed', () => this.wcs.delete(wc));
    }
    this.wcs.set(wc, { lite });
    // リロード後の再ハンドシェイクを含め、呼ばれるたびに新しいポートを張る。
    // 古いポートは worker 側が close イベントで自己清掃する。
    if (this.ready) this.wireFeedPort(wc, lite);
  }

  private wireFeedPort(wc: WebContents, lite: boolean): void {
    if (!this.proc || wc.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    this.proc.postMessage({ t: 'feedPort', lite }, [port1]);
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
    // クラッシュ直後(proc なし・再起動タイマー保留中)に終了すると、タイマーが
    // 発火して終了処理中に新しい worker が fork される。必ずここで止める。
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
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
