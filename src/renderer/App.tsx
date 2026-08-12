import { useEffect } from 'react';
import { rpc } from './ipc/client';
import { attachLive, useLive } from './state/liveStore';
import { go, setSettings, toast, useUi, type Route } from './state/uiStore';
import { StatusChip } from './components/common';
import { ZoomControls } from './components/Zoom';
import { MemoEditor } from './components/Memo';
import { Connect } from './screens/Connect';
import { LiveDashboard } from './screens/LiveDashboard';
import { Sessions } from './screens/Sessions';
import { Analytics } from './screens/Analytics';
import { Settings } from './screens/Settings';
import { Challenge } from './screens/Challenge';
import { Licenses } from './screens/Licenses';
import { ViewerDetail } from './screens/ViewerDetail';

const NAV: Array<[Route, string]> = [
  ['connect', '接続'],
  ['live', 'ライブ'],
  ['challenge', 'チャレンジ'],
  ['sessions', '配信履歴'],
  ['analytics', '分析'],
  ['settings', '設定'],
];

export function App(): React.JSX.Element {
  const route = useUi((s) => s.route);
  const toasts = useUi((s) => s.toasts);
  const { status, workerState } = useLive();

  useEffect(() => {
    const off = attachLive();
    const offToast = window.api.onToast((t) => toast(t));
    void rpc('cfg.get', undefined).then(setSettings).catch(() => undefined);
    // Recover the live view after a renderer reload mid-stream.
    void rpc('conn.status', undefined)
      .then((s) => {
        useLive.setState({ status: s.status, sessionId: s.sessionId, quota: s.quota });
        if (s.status.state === 'live') go('live');
      })
      .catch(() => undefined);
    return () => {
      off();
      offToast();
    };
  }, []);

  return (
    <div className="app">
      <div className="topbar">
        <div className="brand">TikTokライブ分析</div>
        <nav className="nav">
          {NAV.map(([k, label]) => (
            <button key={k} className={route === k ? 'active' : ''} onClick={() => go(k)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <ZoomControls />
        {workerState !== 'ready' ? (
          <span className="chip warn">
            <i className="dot" />
            {workerState === 'starting' ? '記録エンジン起動中' : workerState === 'restarting' ? '再起動中' : '停止しました'}
          </span>
        ) : null}
        <StatusChip status={status} />
      </div>

      <div className="main">
        {route === 'connect' ? <Connect /> : null}
        {route === 'live' ? <LiveDashboard /> : null}
        {route === 'challenge' ? <Challenge /> : null}
        {route === 'sessions' ? <Sessions /> : null}
        {route === 'analytics' ? <Analytics /> : null}
        {route === 'settings' ? <Settings /> : null}
        {route === 'licenses' ? <Licenses /> : null}
      </div>

      <ViewerDetail />
      <MemoEditor />

      <div className="toast-wrap">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`}>
            {t.msgJa}
          </div>
        ))}
      </div>
    </div>
  );
}
