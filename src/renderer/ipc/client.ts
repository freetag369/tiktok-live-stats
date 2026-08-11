import { useCallback, useEffect, useRef, useState } from 'react';
import type { RpcMethod, RpcParams, RpcResult } from '@shared/ipc';

export function rpc<K extends RpcMethod>(method: K, params: RpcParams<K>): Promise<RpcResult<K>> {
  return window.api.rpc(method, params);
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
  const paramsRef = useRef(params);
  paramsRef.current = params;

  useEffect(() => {
    if (opts?.skip) return;
    let cancelled = false;
    if (inflight.current) return;
    inflight.current = true;
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
      });
    return () => {
      cancelled = true;
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
