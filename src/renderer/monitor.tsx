import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { ErrorBoundary } from './components/ErrorBoundary';
import { MonitorView } from './monitor/MonitorView';
import { attachLive } from './state/liveStore';
import { installEnterRepeatGuard } from './lib/enter-repeat';
import { installErrorHooks } from './lib/install-error-hooks';
import './styles/monitor.css';

// モニター窓は challenge / totals / sessionId しか使わないので lite 購読 —
// 視聴者マージとフィード取り込みを省いて常時フォアグラウンド窓の負荷を抑える。
attachLive({ lite: true });

// Enter 押しっぱなしのボタン連打を止める(Space と同じ「1回だけ」に揃える)。
// この窓の Space/Enter 押下は MonitorView が自前で ev.repeat を見ている。
installEnterRepeatGuard();

// 捕まえ損ねた例外を main の診断リングへ(窓の再起動はしない — 下の理由参照)。
installErrorHooks('monitor');

/**
 * この窓は**配信者の背面に映っている**。フォールバックは放送に耐えることが最優先で、
 * 読める英文のエラーカードは黒画面よりはるかに悪い(「機材が止まっている」ではなく
 * 「このアプリは壊れている」が数時間、録画にも残る)。
 * よって: 窓の地色と同じ純黒 + カメラ距離では読めない極小の印だけ。印を置くのは、
 * プレビューを覗いた操作者が「停止」と「待機中の黒」を区別できるようにするため。
 * 「読み込み中…」を再利用してはいけない — 永久に嘘をつくことになる。
 *
 * 復旧は main が持つ(この窓は復旧のたびに破棄されるので、窓の中のカウンタでは
 * ループを観測できない)。monitor.restart ではなく monitor.crashed を撃つのは、
 * 前者を「人が押す無条件の手段」として残すため。
 */
function MonitorFallback(): React.JSX.Element {
  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: '#000',
        color: 'rgba(255,255,255,0.18)',
        fontSize: 11,
        display: 'flex',
        alignItems: 'flex-end',
        justifyContent: 'flex-end',
        padding: 6,
      }}
    >
      monitor stopped — restarting
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={() => <MonitorFallback />}
      onError={(error, info) => {
        void window.api
          .rpc('monitor.crashed', {
            message: error.message,
            componentStack: info.componentStack ?? undefined,
          })
          .catch(() => undefined);
      }}
    >
      <MonitorView />
    </ErrorBoundary>
  </StrictMode>
);
