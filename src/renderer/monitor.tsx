import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MonitorView } from './monitor/MonitorView';
import { attachLive } from './state/liveStore';
import { installEnterRepeatGuard } from './lib/enter-repeat';
import './styles/monitor.css';

// モニター窓は challenge / totals / sessionId しか使わないので lite 購読 —
// 視聴者マージとフィード取り込みを省いて常時フォアグラウンド窓の負荷を抑える。
attachLive({ lite: true });

// Enter 押しっぱなしのボタン連打を止める(Space と同じ「1回だけ」に揃える)。
// この窓の Space/Enter 押下は MonitorView が自前で ev.repeat を見ている。
installEnterRepeatGuard();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <MonitorView />
  </StrictMode>
);
