import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MonitorView } from './monitor/MonitorView';
import { attachLive } from './state/liveStore';
import './styles/monitor.css';

// モニター窓は challenge / totals / sessionId しか使わないので lite 購読 —
// 視聴者マージとフィード取り込みを省いて常時フォアグラウンド窓の負荷を抑える。
attachLive({ lite: true });

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MonitorView />
  </StrictMode>
);
