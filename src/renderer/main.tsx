import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import { installEnterRepeatGuard } from './lib/enter-repeat';
import { installErrorHooks } from './lib/install-error-hooks';
import './styles/app.css';

// Enter 押しっぱなしのボタン連打を止める(Space と同じ「1回だけ」に揃える)。
installEnterRepeatGuard();

// 捕まえ損ねた例外を main の診断リングへ。
installErrorHooks('dashboard');

/**
 * 操作者の窓なので、モニターとは方針が逆 — 原因と復旧手段をそのまま出す。
 * **自動リロードはしない**: 検索文字列・選択中の視聴者・スクロール位置を黙って
 * 捨てることになり、失敗が続けば見えないループになる。
 * 集計の権威は worker/main にあるので、再読み込みで失うものは無い。
 */
function DashboardFallback({ error, reset }: { error: Error; reset: () => void }): React.JSX.Element {
  return (
    <div style={{ padding: 24, maxWidth: 760, margin: '40px auto', lineHeight: 1.7 }}>
      <h2 style={{ margin: '0 0 8px' }}>画面の描画が停止しました</h2>
      <p style={{ margin: '0 0 12px', opacity: 0.85 }}>
        集計データと配信の接続は worker 側で動き続けています。この画面を再読み込みしても失われません。
      </p>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          background: 'rgba(0,0,0,0.25)',
          padding: 12,
          borderRadius: 6,
          fontSize: 12,
          maxHeight: 220,
          overflow: 'auto',
        }}
      >
        {[error.message, ...(error.stack ?? '').split(/\r?\n/).slice(0, 10)].join('\n')}
      </pre>
      <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
        <button type="button" onClick={() => location.reload()}>
          再読み込み
        </button>
        <button type="button" onClick={reset}>
          この画面だけ再表示
        </button>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={(error, reset) => <DashboardFallback error={error} reset={reset} />}
      onError={(error, info) => {
        void window.api
          .rpc('diag.report', {
            scope: 'dashboard',
            level: 'error',
            message: '[diag] 画面の描画が例外で停止: ' + error.message + (info.componentStack ?? ''),
          })
          .catch(() => undefined);
      }}
    >
      <App />
    </ErrorBoundary>
  </StrictMode>
);
