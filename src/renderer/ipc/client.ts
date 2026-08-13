import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpcMethod, RpcParams, RpcResult } from '@shared/ipc';
import { toast } from '../state/uiStore';

export function rpc<K extends RpcMethod>(method: K, params: RpcParams<K>): Promise<RpcResult<K>> {
  return window.api.rpc(method, params);
}

/**
 * fire-and-forget の操作系 RPC。rpc() は失敗時に throw するため、素の
 * `void rpc(...)` はワーカー再起動中や DB ロック時に unhandled rejection +
 * ユーザーへの無通知になる。必ずエラートーストへ落とす。
 */
export function rpcFire<K extends RpcMethod>(method: K, params: RpcParams<K>, label?: string): void {
  rpc(method, params).catch((e: Error) => {
    toast({ level: 'error', msgJa: `${label ?? method} に失敗しました: ${e.message}` });
  });
}

/**
 * Query hook with in-flight de-duplication. The dashboard re-queries on every
 * 2 Hz delta, and without this a slow query would stack up behind itself.
 */
export function useQuery<K extends RpcMethod>(
  method: K,
  params: RpcParams<K>,
  deps: readonly unknown[],
  opts?: { skip?: boolean }
): { data: RpcResult<K> | null; error: string | null; loading: boolean; reload: () => void } {
  const [data, setData] = useState<RpcResult<K> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const inflight = useRef(false);
  // 飛行中に deps/reload が来たときの「もう一度」の予約。単に捨てると、
  // 完了後の再試行トリガーが無く data が古いまま固着する(別ビューアの詳細を
  // 開いたのに前の人の統計が出続ける、reload が無反応、など)。
  const rerun = useRef<(() => void) | null>(null);
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (opts?.skip) return;
    let cancelled = false;
    const runOnce = () => {
      if (inflight.current) {
        rerun.current = runOnce;
        return;
      }
      inflight.current = true;
      rerun.current = null;
      setLoading(true);
      rpc(method, paramsRef.current)
        .then((r) => {
          if (!cancelled) {
            setData(r);
            setError(null);
          }
        })
        .catch((e: Error) => {
          if (!cancelled) setError(e.message);
        })
        .finally(() => {
          inflight.current = false;
          if (!cancelled) setLoading(false);
          // 飛行中に予約された最新の1回だけを実行(それより古い予約は上書き済み)。
          const next = rerun.current;
          rerun.current = null;
          next?.();
        });
    };
    runOnce();
    return () => {
      cancelled = true;
      // この effect が予約した再実行は無効化する(新しい effect が自分の分を積む)。
      if (rerun.current === runOnce) rerun.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, opts?.skip]);

  const reload = useCallback(() => setNonce((n) => n + 1), []);
  return { data, error, loading, reload };
}

export function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setV(value), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return v;
}
