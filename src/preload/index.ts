import { contextBridge, ipcRenderer, webFrame } from 'electron';
import { CH_FEED_PORT, CH_MONITOR_STATE, CH_TOAST, CH_WORKER_STATE } from '@shared/ipc';
import type { LiveMessage, RpcMethod, RpcParams, RpcResponse, RpcResult, ToastMsg, WorkerState } from '@shared/ipc';

/**
 * ~60 lines, zero logic. The renderer is sandboxed and holds no Node reference;
 * everything it can do is enumerated here.
 */

let livePort: MessagePort | null = null;
const liveSubs = new Set<(m: LiveMessage) => void>();

ipcRenderer.on(CH_FEED_PORT, (e) => {
  livePort?.close();
  livePort = e.ports[0] ?? null;
  if (!livePort) return;
  livePort.onmessage = (ev) => {
    for (const cb of liveSubs) cb(ev.data as LiveMessage);
  };
  livePort.start();
});

// Fallback if the direct port handshake ever fails; identical payloads.
ipcRenderer.on('live-fallback', (_e, m: LiveMessage) => {
  for (const cb of liveSubs) cb(m);
});

const api = {
  async rpc<K extends RpcMethod>(method: K, params: RpcParams<K>): Promise<RpcResult<K>> {
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const res = (await ipcRenderer.invoke('rpc', { id, method, params })) as RpcResponse<K>;
    if (!res.ok) throw new Error(res.error.message);
    return res.result;
  },

  onLive(cb: (m: LiveMessage) => void): () => void {
    liveSubs.add(cb);
    return () => liveSubs.delete(cb);
  },

  onWorkerState(cb: (s: WorkerState) => void): () => void {
    const h = (_e: unknown, s: WorkerState) => cb(s);
    ipcRenderer.on(CH_WORKER_STATE, h);
    return () => ipcRenderer.off(CH_WORKER_STATE, h);
  },

  onToast(cb: (t: ToastMsg) => void): () => void {
    const h = (_e: unknown, t: ToastMsg) => cb(t);
    ipcRenderer.on(CH_TOAST, h);
    return () => ipcRenderer.off(CH_TOAST, h);
  },

  /** チャレンジモニター窓の開閉通知(ダッシュボードのボタン表記の同期用)。 */
  onMonitorState(cb: (s: { open: boolean }) => void): () => void {
    const h = (_e: unknown, s: { open: boolean }) => cb(s);
    ipcRenderer.on(CH_MONITOR_STATE, h);
    return () => ipcRenderer.off(CH_MONITOR_STATE, h);
  },

  /**
   * Display scale. webFrame is one of the few Electron modules available inside a
   * sandboxed preload, so the renderer can resize itself without opening a hole
   * back to Node.
   */
  setZoom(factor: number): number {
    const clamped = Math.min(2.5, Math.max(0.6, Number(factor) || 1));
    webFrame.setZoomFactor(clamped);
    return clamped;
  },

  getZoom(): number {
    return webFrame.getZoomFactor();
  },
} as const;

export type Api = typeof api;

contextBridge.exposeInMainWorld('api', api);
