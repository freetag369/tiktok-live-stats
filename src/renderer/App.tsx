import { useEffect } from 'react';
import { rpc } from './ipc/client';
import { attachLive, setChallenge, useLive } from './state/liveStore';
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
  // version を購読しない — セレクタなしだと delta のたび(4〜6Hz)にルートツリー
  // 全体が再レンダーされる。status/workerState は状態遷移時しか変わらない。
  const status = useLive((s) => s.status);
  const workerState = useLive((s) => s.workerState);

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

  // タップブースト中のメイン窓 Space。カウンタはモニター窓に出るが、配信者は
  // ダッシュボード/設定画面を見ながら叩くことが多く、「モニターにフォーカスが
  // 無いと Space が効かない」を解消する。boost(実発動・▶実演の両方で載る)が
  // 無いときは素通し — 通常時の Space の意味(スクロール/ボタン活性)を奪わない。
  // どの画面でも効くよう App に常設する(routes は排他レンダーのため)。
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key !== ' ' || ev.repeat) return;
      // 入力系は素通し。BUTTON はブラウザ既定の Space 活性化(keyup で click)に
      // 任せる — 拾うと PUSH ボタンのフォーカス時に二重押しになる。
      const t = ev.target as HTMLElement | null;
      if (t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(t.tagName))) return;
      if (useLive.getState().challenge?.boost == null) return;
      ev.preventDefault();
      void rpc('challenge.press', undefined).then(setChallenge).catch(() => undefined);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
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
