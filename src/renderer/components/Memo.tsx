import { useEffect, useRef, useState } from 'react';
import { rpc } from '../ipc/client';
import { toast, useUi } from '../state/uiStore';

/**
 * クイックメモ.
 *
 * A memo is only worth having if it can be written the moment the thought occurs —
 * mid-stream, without losing the comment lane behind a full-screen modal. This is
 * a small popover anchored to whatever was clicked; it writes straight to the
 * viewer row, so it survives every future broadcast.
 */
interface Target {
  userId: string;
  nickname: string;
  note: string | null;
  readingKana: string | null;
  x: number;
  y: number;
}

let openMemo: ((t: Target) => void) | null = null;

/** Opens the editor for a viewer, anchored near the element that was clicked. */
export function editMemo(
  e: React.MouseEvent,
  v: { userId: string; nickname: string; note?: string | null; readingKana?: string | null }
): void {
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  openMemo?.({
    userId: v.userId,
    nickname: v.nickname,
    note: v.note ?? null,
    readingKana: v.readingKana ?? null,
    x: Math.min(r.left, window.innerWidth - 340),
    y: Math.min(r.bottom + 6, window.innerHeight - 260),
  });
}

/** The 📝 affordance shown on rows. Filled when a memo already exists. */
export function MemoButton({
  viewer,
}: {
  viewer: { userId: string; nickname: string; note?: string | null; readingKana?: string | null };
}): React.JSX.Element {
  const has = Boolean(viewer.note);
  return (
    <button
      className={`memo-btn${has ? ' has' : ''}`}
      title={has ? `メモ: ${viewer.note}` : 'メモを書く'}
      onClick={(e) => editMemo(e, viewer)}
    >
      {has ? '📝' : '＋'}
    </button>
  );
}

export function MemoEditor(): React.JSX.Element | null {
  const [t, setT] = useState<Target | null>(null);
  const [note, setNote] = useState('');
  const [kana, setKana] = useState('');
  const [busy, setBusy] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    openMemo = (target) => {
      setT(target);
      setNote(target.note ?? '');
      setKana(target.readingKana ?? '');
    };
    return () => {
      openMemo = null;
    };
  }, []);

  useEffect(() => {
    if (t) setTimeout(() => ref.current?.focus(), 30);
  }, [t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setT(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!t) return null;

  async function save(): Promise<void> {
    if (!t) return;
    setBusy(true);
    try {
      await rpc('m.viewerMeta', {
        userId: t.userId,
        patch: { note: note.trim() || null, readingKana: kana.trim() || null },
      });
      // Reflect it immediately on the currently-loaded viewer table.
      useUi.setState((s) => ({ ...s, memoNonce: (s.memoNonce ?? 0) + 1 }));
      toast({ level: 'info', msgJa: `${t.nickname} のメモを保存しました。` });
      setT(null);
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="memo-scrim" onClick={() => setT(null)} />
      <div className="memo-pop" style={{ left: t.x, top: t.y }} onClick={(e) => e.stopPropagation()}>
        <div className="row" style={{ marginBottom: 6 }}>
          <strong style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.nickname}</strong>
          <div className="spacer" />
          <span className="faint" style={{ fontSize: 10.5 }}>
            Esc で閉じる
          </span>
        </div>
        <textarea
          ref={ref}
          rows={4}
          value={note}
          placeholder="例: 誕生日 3/4 / ゲームの話が好き / 名前は「たろう」"
          onChange={(e) => setNote(e.target.value)}
          onKeyDown={(e) => {
            // Ctrl+Enter saves — the hands are already on the keyboard mid-stream.
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void save();
          }}
          style={{ width: '100%', resize: 'vertical' }}
        />
        <input
          type="text"
          value={kana}
          placeholder="よみがな（名前を呼ぶとき用）"
          onChange={(e) => setKana(e.target.value)}
          style={{ width: '100%', marginTop: 6 }}
        />
        <div className="row" style={{ marginTop: 8 }}>
          <button className="btn small primary" onClick={() => void save()} disabled={busy}>
            保存
          </button>
          <button className="btn small" onClick={() => setT(null)}>
            キャンセル
          </button>
          <div className="spacer" />
          <span className="faint" style={{ fontSize: 10.5 }}>
            Ctrl+Enter
          </span>
        </div>
        <div className="faint" style={{ fontSize: 10.5, marginTop: 6 }}>
          次回以降の配信でも残り、入室時とコメント欄に表示されます。
        </div>
      </div>
    </>
  );
}
