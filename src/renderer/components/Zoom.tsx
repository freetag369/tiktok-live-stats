import { useCallback, useEffect, useRef, useState } from 'react';
import { DEFAULT_ZOOM_FACTOR } from '@shared/dto';
import { rpc } from '../ipc/client';
import { useUi } from '../state/uiStore';

const MIN = 0.6;
const MAX = 2.5;
const STEP = 0.1;

/** Snap to a tenth so repeated steps do not drift to 1.0999999999. */
const round = (n: number): number => Math.round(n * 10) / 10;

/**
 * 表示倍率.
 *
 * The dashboard is deliberately dense — a live stream is read at a glance — but
 * dense means small, and small is unreadable on a 4K panel or for anyone who does
 * not want to lean in. Scale is a first-class control, not a hidden preference:
 * buttons in the title bar, Ctrl +/-/0, and Ctrl+wheel.
 */
export function ZoomControls(): React.JSX.Element {
  const settings = useUi((s) => s.settings);
  const [zoom, setZoom] = useState(DEFAULT_ZOOM_FACTOR);
  const applied = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Apply the persisted scale once, when settings first arrive.
  useEffect(() => {
    if (!settings || applied.current) return;
    applied.current = true;
    setZoom(window.api.setZoom(settings.zoomFactor ?? DEFAULT_ZOOM_FACTOR));
  }, [settings]);

  const apply = useCallback((next: number) => {
    const z = window.api.setZoom(round(Math.min(MAX, Math.max(MIN, next))));
    setZoom(z);
    // Debounced: holding Ctrl+wheel should not write the file on every notch.
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void rpc('cfg.set', { zoomFactor: z }).catch(() => undefined);
    }, 600);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      // Both the main row and the numpad, and both '+' and '=' on JIS/US layouts.
      if (e.key === '+' || e.key === ';' || e.key === '=' || e.key === 'Add') {
        e.preventDefault();
        apply(window.api.getZoom() + STEP);
      } else if (e.key === '-' || e.key === 'Subtract') {
        e.preventDefault();
        apply(window.api.getZoom() - STEP);
      } else if (e.key === '0') {
        e.preventDefault();
        apply(DEFAULT_ZOOM_FACTOR);
      }
    };
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      apply(window.api.getZoom() + (e.deltaY < 0 ? STEP : -STEP));
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('wheel', onWheel);
    };
  }, [apply]);

  return (
    <div className="zoom" title="表示倍率（Ctrl と ＋ / − / 0、Ctrl＋ホイールでも変えられます）">
      <button className="btn small" onClick={() => apply(zoom - STEP)} disabled={zoom <= MIN} aria-label="小さく">
        −
      </button>
      <button className="zoom-val" onClick={() => apply(DEFAULT_ZOOM_FACTOR)} title={`クリックで既定の${DEFAULT_ZOOM_FACTOR * 100}%に戻す`}>
        {Math.round(zoom * 100)}%
      </button>
      <button className="btn small" onClick={() => apply(zoom + STEP)} disabled={zoom >= MAX} aria-label="大きく">
        ＋
      </button>
    </div>
  );
}
