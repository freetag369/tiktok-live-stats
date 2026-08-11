import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MonitorView } from './monitor/MonitorView';
import { attachLive } from './state/liveStore';
import './styles/monitor.css';

// liveStore は窓に依存しない — メイン窓と同じ delta/feed 購読をそのまま使う。
attachLive();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MonitorView />
  </StrictMode>
);
