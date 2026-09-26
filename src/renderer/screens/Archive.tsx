import { useCallback, useEffect, useRef, useState } from 'react';
import type { ArchiveItem, ArchiveKind, ArchiveQuery, CsvExportSpec } from '@shared/dto';
import { diamondsToJpy, num } from '@shared/format';
import { formatDateJa, formatDurationJa, formatElapsedJa } from '@shared/time';
import { rpc, useDebounced, useQuery } from '../ipc/client';
import { openArchive, openViewer, toast, useUi } from '../state/uiStore';
import { Avatar } from '../components/common';
import { Top } from './Sessions';

const PAGE = 300;

/**
 * 配信ごとのコメント・ギフトを、ライブで流れた順にもう一度読む画面。
 * 記録自体は配信中に DB へ落ちているので、ここは読み出しと絞り込みだけ。
 */
export function Archive(): React.JSX.Element {
  const sessionId = useUi((s) => s.archiveSession);
  const { data: sessions } = useQuery('q.sessions', { limit: 300 }, []);

  // Land on the latest stream instead of an empty screen — and move off a stream
  // that no longer exists (purged), which would otherwise sit on 「読み込み中…」
  // forever and could later show a new stream that reused the same id.
  useEffect(() => {
    if (!sessions) return;
    if (sessionId != null && sessions.rows.some((s) => s.sessionId === sessionId)) return;
    const next = sessions.rows[0]?.sessionId ?? null;
    if (next !== sessionId) openArchive(next);
  }, [sessionId, sessions]);

  const exp = (spec: CsvExportSpec, label: string) =>
    void rpc('file.exportCsv', spec)
      .then((r) => r && toast({ level: 'info', msgJa: `${label} ${num(r.rows)}件を書き出しました。` }))
      .catch((e: Error) => toast({ level: 'error', msgJa: e.message }));

  return (
    <div className="screen">
      <div className="row wrap" style={{ marginBottom: 12, gap: 8 }}>
        <h2 style={{ margin: 0 }}>アーカイブ</h2>
        <select
          value={sessionId ?? ''}
          onChange={(e) => openArchive(e.target.value === '' ? null : Number(e.target.value))}
          style={{ minWidth: 320 }}
        >
          {sessionId == null ? <option value="">配信を選択…</option> : null}
          {sessions?.rows.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {`${formatDateJa(s.startedMs)}\u3000${formatDurationJa(s.durationMs)}\u3000コメント${num(s.comments)}\u3000💎${num(s.diamonds)}${s.endedMs == null ? '\u3000（配信中）' : ''}`}
            </option>
          ))}
        </select>
        <div className="spacer" />
        <button
          className="btn small primary"
          disabled={sessionId == null}
          onClick={() => sessionId != null && exp({ kind: 'timeline', sessionId }, 'アーカイブ')}
        >
          この配信をCSVで保存
        </button>
        <button
          className="btn small"
          disabled={sessionId == null}
          onClick={() => sessionId != null && exp({ kind: 'comments', sessionId }, 'コメント')}
        >
          コメントのみ
        </button>
        <button
          className="btn small"
          disabled={sessionId == null}
          onClick={() => sessionId != null && exp({ kind: 'gifts', sessionId }, 'ギフト')}
        >
          ギフトのみ
        </button>
      </div>

      {sessionId == null ? (
        <div className="empty">
          {sessions && sessions.rows.length === 0
            ? '配信の記録がまだありません。配信を記録すると、ここでコメントとギフトを見返せます。'
            : '配信履歴から配信を選ぶか、上のリストから選択してください。'}
        </div>
      ) : (
        <SessionArchive key={sessionId} sessionId={sessionId} />
      )}
    </div>
  );
}

// ── data ────────────────────────────────────────────────────────────────────

type Filters = Omit<ArchiveQuery, 'limit' | 'offset'>;

const itemKey = (it: ArchiveItem): string => `${it.kind}:${it.msgId}`;

/**
 * Not useQuery: that hook skips a request while one is in flight, which is right
 * for the 2 Hz dashboard but wrong here — a fast filter change must win, and
 * 「もっと見る」 appends instead of replacing.
 */
function useArchive(q: Filters) {
  const [items, setItems] = useState<ArchiveItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);

  const load = useCallback(
    (offset: number) => {
      const my = ++seq.current;
      setLoading(true);
      rpc('q.archive', { ...q, limit: PAGE, offset })
        .then((p) => {
          if (my !== seq.current) return;
          setTotal(p.total);
          // OFFSET paging over a live stream shifts under new rows (newest-first,
          // or backlog replayed after a reconnect), so the next page can repeat
          // rows already shown. Drop those instead of rendering them twice.
          setItems((prev) => {
            if (offset === 0) return p.rows;
            const seen = new Set(prev.map(itemKey));
            return [...prev, ...p.rows.filter((r) => !seen.has(itemKey(r)))];
          });
          setError(null);
        })
        .catch((e: Error) => {
          if (my === seq.current) setError(e.message);
        })
        .finally(() => {
          if (my === seq.current) setLoading(false);
        });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [q.sessionId, q.kind, q.text, q.questionsOnly, q.minDiamonds, q.newestFirst]
  );

  useEffect(() => {
    load(0);
  }, [load]);

  return { items, total, loading, error, more: () => load(items.length) };
}

// ── screen body ─────────────────────────────────────────────────────────────

function SessionArchive({ sessionId }: { sessionId: number }): React.JSX.Element {
  const settings = useUi((s) => s.settings);
  const [kind, setKind] = useState<ArchiveKind>('all');
  const [questionsOnly, setQuestionsOnly] = useState(false);
  const [search, setSearch] = useState('');
  const [minDia, setMinDia] = useState('');
  const [newestFirst, setNewestFirst] = useState(false);

  const text = useDebounced(search.trim(), 250);
  const minDiamonds = useDebounced(Math.max(0, Number(minDia) || 0), 250);

  const { items, total, loading, error, more } = useArchive({
    sessionId,
    kind,
    text: text || undefined,
    questionsOnly: questionsOnly || undefined,
    minDiamonds: minDiamonds > 0 ? minDiamonds : undefined,
    newestFirst: newestFirst || undefined,
  });

  const { data: detail } = useQuery('q.sessionDetail', { sessionId }, [sessionId]);
  const { data: giftSummary } = useQuery('q.sessionGiftSummary', { sessionId }, [sessionId]);
  const startedMs = detail?.startedMs ?? 0;
  const showAvatars = settings?.loadAvatars ?? true;

  return (
    <div className="grid archive-grid">
      <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
        <div className="row wrap archive-filters">
          <div className="row" style={{ gap: 4 }}>
            {(
              [
                ['all', '両方'],
                ['comments', 'コメントのみ'],
                ['gifts', 'ギフトのみ'],
              ] as Array<[ArchiveKind, string]>
            ).map(([k, label]) => (
              <button
                key={k}
                className={`btn small${kind === k ? ' primary' : ''}`}
                disabled={questionsOnly}
                onClick={() => setKind(k)}
              >
                {label}
              </button>
            ))}
          </div>
          <label className="row" style={{ cursor: 'pointer', gap: 4 }}>
            <input type="checkbox" checked={questionsOnly} onChange={(e) => setQuestionsOnly(e.target.checked)} />
            <span>質問のみ</span>
          </label>
          <input
            type="search"
            placeholder="コメント・ギフト名を検索"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <label className="row" style={{ gap: 4 }}>
            <span>💎</span>
            <input
              type="number"
              min={0}
              value={minDia}
              onChange={(e) => setMinDia(e.target.value)}
              disabled={kind === 'comments' || questionsOnly}
              style={{ width: 70 }}
            />
            <span>以上</span>
          </label>
          <label className="row" style={{ cursor: 'pointer', gap: 4 }}>
            <input type="checkbox" checked={newestFirst} onChange={(e) => setNewestFirst(e.target.checked)} />
            <span>新しい順</span>
          </label>
          <span className="faint">{num(total)}件</span>
        </div>

        <div className="archive-list">
          {items.map((it) => (
            <ArchiveRow key={itemKey(it)} item={it} startedMs={startedMs} showAvatars={showAvatars} />
          ))}
          {error ? <div className="notice">{error}</div> : null}
          {loading && items.length === 0 ? <div className="empty">読み込み中…</div> : null}
          {!loading && !error && items.length === 0 ? <div className="empty">該当する記録はありません。</div> : null}
          {items.length < total ? (
            <div className="row" style={{ justifyContent: 'center', padding: 10 }}>
              <button className="btn small" onClick={more} disabled={loading}>
                {loading ? '読み込み中…' : `もっと見る（残り ${num(total - items.length)}件）`}
              </button>
            </div>
          ) : null}
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h3>この配信</h3>
          {detail ? (
            <>
              <div className="faint" style={{ marginBottom: 8 }}>
                {formatDateJa(detail.startedMs)} · {formatDurationJa(detail.durationMs)}
                {detail.endedMs == null ? ' · 配信中' : ''}
              </div>
              <div className="stats" style={{ gridTemplateColumns: 'repeat(2, 1fr)' }}>
                <Stat k="コメント" v={num(detail.comments)} />
                {/* stream_session.gifts counts a streak once; the 内訳 below sums repeat_count. */}
                <Stat k="ギフト回数(連打は1回)" v={num(giftSummary?.gifts ?? 0)} />
                <Stat k="ダイヤ" v={num(detail.diamonds)} sub={diamondsToJpy(detail.diamonds, settings?.diamondToJpy ?? 0.5)} />
                <Stat k="ハートミー" v={num(detail.heartMe)} />
              </div>
            </>
          ) : (
            <div className="empty">読み込み中…</div>
          )}
        </div>

        <div className="card">
          <h3>ギフト内訳</h3>
          {giftSummary && giftSummary.byGift.length > 0 ? (
            <table className="data">
              <thead>
                <tr>
                  <th>ギフト</th>
                  <th className="n">個数</th>
                  <th className="n">ダイヤ</th>
                </tr>
              </thead>
              <tbody>
                {giftSummary.byGift.map((g) => (
                  <tr key={g.giftId} style={g.canonical === 'heart_me' ? { color: 'var(--pink)' } : undefined}>
                    <td>
                      {g.giftName}
                      {g.canonical === 'heart_me' ? <span className="badge first"> ハトミー</span> : null}
                    </td>
                    <td className="n">{num(g.count)}</td>
                    <td className="n">{num(g.diamonds)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty">ギフトの記録はありません。</div>
          )}
        </div>

        {detail ? <Top title="ギフト上位" rows={detail.topGifters} unit="💎" /> : null}
      </div>
    </div>
  );
}

function Stat({ k, v, sub }: { k: string; v: string; sub?: string }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className={`v${sub ? ' sm' : ''}`}>{v}</div>
      {sub ? <div className="k">{sub}</div> : null}
    </div>
  );
}

/** Same look as the live feed so a re-read feels like the stream did. */
function ArchiveRow({ item: it, startedMs, showAvatars }: { item: ArchiveItem; startedMs: number; showAvatars: boolean }) {
  const ts = <span className="archive-ts">{startedMs ? formatElapsedJa(it.tsMs - startedMs) : ''}</span>;
  const open = () => openViewer(it.userId);
  const title = `${formatDateJa(it.tsMs)}\u3000@${it.displayId}\u3000クリックで視聴者の詳細`;

  if (it.kind === 'comment') {
    const cls = it.isQuestion ? 'tri-q' : it.vipTier >= 2 ? 'tri-vip' : it.vipTier === 1 ? 'tri-regular' : '';
    return (
      <div className={`feed-item archive-row ${cls}`} onClick={open} title={title}>
        {ts}
        <Avatar url={it.avatarUrl} name={it.nickname} size={18} enabled={showAvatars} />
        <div className="txt">
          {it.isQuestion ? <span className="tag q">質問</span> : it.vipTier >= 2 ? <span className="tag vip">VIP</span> : null}{' '}
          <span className="who">{it.nickname}</span> {it.content}
        </div>
      </div>
    );
  }
  return (
    <div className={`feed-item archive-row gift${it.diamonds >= 100 ? ' big' : ''}`} onClick={open} title={title}>
      {ts}
      <Avatar url={it.avatarUrl} name={it.nickname} size={18} enabled={showAvatars} />
      <div className="txt">
        <span className="who" style={{ color: 'var(--gold)' }}>
          {it.nickname}
        </span>{' '}
        が <span style={{ color: 'var(--gold)' }}>{it.giftName}</span>
        {it.repeatCount > 1 ? ` ×${it.repeatCount}` : ''}
        <span className="faint"> （{num(it.diamonds)}💎）</span>
        {it.canonical === 'heart_me' ? <span className="badge first"> ハトミー</span> : null}
        {it.isBoxGift ? (
          <span className="badge" title="ボックスギフトはダイヤ数が不正確な場合があります">
            {' '}
            箱
          </span>
        ) : null}
      </div>
    </div>
  );
}
