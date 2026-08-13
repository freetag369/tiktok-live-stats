import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { installEnterRepeatGuard } from './lib/enter-repeat';
import './styles/app.css';

// Enter 押しっぱなしのボタン連打を止める(Space と同じ「1回だけ」に揃える)。
installEnterRepeatGuard();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
