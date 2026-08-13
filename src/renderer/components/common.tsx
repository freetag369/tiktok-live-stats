import { memo, useCallback, useEffect, useRef, useState } from 'react';
import type { AdapterStatus } from '@shared/events';
import { TIER_LABEL_JA } from '@shared/scoring';

/** Every per-viewer like and attendance figure carries this. See §2-2 of the plan. */
export const OBSERVED_TITLE =
  '観測値です。TikTok は視聴者が多い配信でいいね／入室イベントを間引くため、実際の数より少なくなることがあります。';

export function Observed(): React.JSX.Element {
  return (
    <span className="observed" title={OBSERVED_TITLE}>
      ⓘ
    </span>
  );
}

export const Avatar = memo(function Avatar({
  url,
  name,
  size = 22,
  enabled = true,
}: {
  url: string | null | undefined;
  name: string;
  size?: number;
  enabled?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  // URL が更新されたら失敗ラッチを解除 — 同じ userId のアバター URL が差し替わっ
  // ても永久にプレースホルダのまま、を防ぐ。
  const prevUrl = useRef(url);
  if (prevUrl.current !== url) {
    prevUrl.current = url;
    if (failed) setFailed(false);
  }
  const style = { width: size, height: size, fontSize: Math.round(size * 0.42) };
  if (!enabled || !url || failed) {
    return (
      <div className="avatar ph" style={style} aria-hidden>
        {(name || '?').slice(0, 1)}
      </div>
    );
  }
  return (
    <img
      className="avatar"
      style={style}
      src={url}
      alt=""
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
});

export function TierBadge({ tier }: { tier: number }): React.JSX.Element | null {
  if (!tier) return null;
  return <span className={`badge t${tier}`}>{TIER_LABEL_JA[tier] ?? ''}</span>;
}

export function StatusChip({ status }: { status: AdapterStatus }): React.JSX.Element {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const secs = (ms: number) => Math.max(0, Math.ceil((ms - Date.now()) / 1000));
  let cls = '';
  let text = '待機中';

  switch (status.state) {
    case 'idle':
      text = '待機中';
      break;
    case 'resolving':
      text = '確認中…';
      break;
    case 'connecting':
      text = `接続中… (${status.attempt}回目)`;
      break;
    case 'live':
      cls = 'live';
      text = '配信中・記録しています';
      break;
    case 'waitingOffline':
      cls = 'warn';
      text = `オフライン待機中（次の確認まで ${secs(status.nextCheckMs)}秒）`;
      break;
    case 'reconnecting':
      cls = 'warn';
      text = `再接続中（${secs(status.nextAttemptMs)}秒後）`;
      break;
    case 'rateLimited':
      cls = 'warn';
      text = `接続回数の上限（${status.scope === 'day' ? '1日' : status.scope === 'hour' ? '1時間' : '1分'}）— ${Math.ceil(status.retryAfterMs / 1000)}秒待機`;
      break;
    case 'blocked':
      cls = 'err';
      text = 'ブロックの可能性';
      break;
    case 'error':
      cls = status.fatal ? 'err' : 'warn';
      text = status.message;
      break;
    case 'ended':
      text = status.reason === 'streamEnd' ? '配信終了' : `終了（${status.reason}）`;
      break;
  }

  return (
    <span className={`chip ${cls}`} title={status.state === 'blocked' ? status.hint : text}>
      <i className="dot" />
      {text}
    </span>
  );
}

export function Bar({ value, target, done, pace }: { value: number; target: number; done: boolean; pace?: number }) {
  const pct = target > 0 ? Math.min(100, (value / target) * 100) : 0;
  return (
    <div className="bar">
      <i className={done ? 'done' : ''} style={{ width: `${pct}%` }} />
      {pace != null && pace > 0 && pace < 1 ? <span className="pace" style={{ left: `${pace * 100}%` }} /> : null}
    </div>
  );
}

/**
 * Scroll container that sticks to the top unless the user has scrolled away.
 * callback ref を返す: 対象が条件付きレンダー(ログが空の間は描画されない等)でも、
 * 生えた瞬間に scroll リスナーが付く。マウント時 effect + `ref.current` 方式だと
 * 後から生えた要素にはリスナーが一生付かず、追従停止が効かない。
 */
export function useStickyTop(dep: unknown): (el: HTMLDivElement | null) => void {
  const elRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);
  const cleanup = useRef<(() => void) | null>(null);
  const setRef = useCallback((el: HTMLDivElement | null) => {
    cleanup.current?.();
    cleanup.current = null;
    elRef.current = el;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollTop < 24;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    cleanup.current = () => el.removeEventListener('scroll', onScroll);
  }, []);
  useEffect(() => {
    if (stick.current && elRef.current) elRef.current.scrollTop = 0;
  }, [dep]);
  return setRef;
}
