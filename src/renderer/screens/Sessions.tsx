import { useMemo } from 'react';
import type { TopRow } from '@shared/dto';
import { compact, diamondsToJpy, num, percent } from '@shared/format';
import { formatDateJa, formatDurationJa } from '@shared/time';
import { rpc, useQuery } from '../ipc/client';
import { openSession, openViewer, toast, useUi } from '../state/uiStore';

export function Sessions(): React.JSX.Element {
  const selected = useUi((s) => s.selectedSession);
  const { data } = useQuery('q.sessions', { limit: 300 }, []);

  return (
    <div className="screen">
      <div className="row" style={{ marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>配信履歴</h2>
        <div className="spacer" />
        <button
          className="btn small"
          onClick={() =>
            void rpc('file.exportCsv', { kind: 'sessions' })
              .then((r) => r && toast({ level: 'info', msgJa: `${num(r.rows)}件を書き出しました。` }))
              .catch((e: Error) => toast({ level: 'error', msgJa: e.message }))
          }
        >
          配信履歴を CSV 出力
        </button>
        <button
          className="btn small"
          onClick={() =>
            void rpc('file.exportCsv', { kind: 'agencyMonthly' })
              .then((r) => r && toast({ level: 'info', msgJa: `${num(r.rows)}ヶ月分を書き出しました。` }))
              .catch((e: Error) => toast({ level: 'error', msgJa: e.message }))
          }
        >
          月次レポート（事務所提出用）
        </button>
      </div>

      <div className="grid" style={{ gridTemplateColumns: selected ? 'minmax(420px, 1fr) 1.3fr' : '1fr' }}>
        <div className="card" style={{ padding: 0, overflow: 'hidden' }}>
          <div style={{ maxHeight: 'calc(100vh - 160px)', overflow: 'auto' }}>
            <table className="data">
              <thead>
                <tr>
                  <th>開始</th>
                  <th className="n">時間</th>
                  <th className="n">ピーク</th>
                  <th className="n">平均</th>
                  <th className="n">視聴者</th>
                  <th className="n">コメント</th>
                  <th className="n">💎</th>
                  <th className="n">ハトミー</th>
                  <th className="n">フォロー</th>
                </tr>
              </thead>
              <tbody>
                {data?.rows.map((s) => (
                  <tr
                    key={s.sessionId}
                    style={{ cursor: 'pointer', background: s.sessionId === selected ? 'var(--bg-3)' : undefined }}
                    onClick={() => openSession(s.sessionId)}
                  >
                    <td>{formatDateJa(s.startedMs)}</td>
                    <td className="n">{formatDurationJa(s.durationMs)}</td>
                    <td className="n">{num(s.peakViewers)}</td>
                    <td className="n">{s.avgViewers == null ? '—' : num(s.avgViewers)}</td>
                    <td className="n">{num(s.uniqueViewers)}</td>
                    <td className="n">{num(s.comments)}</td>
                    <td className="n">{compact(s.diamonds)}</td>
                    <td className="n">{num(s.heartMe)}</td>
                    <td className="n">{num(s.newFollowers)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {data && data.rows.length === 0 ? <div className="empty">配信の記録がありません。</div> : null}
          </div>
        </div>

        {selected != null ? <SessionDetail sessionId={selected} /> : null}
      </div>
    </div>
  );
}

function SessionDetail({ sessionId }: { sessionId: number }): React.JSX.Element {
  const settings = useUi((s) => s.settings);
  const { data: d } = useQuery('q.sessionDetail', { sessionId }, [sessionId]);
  const { data: tl } = useQuery('q.timeline', { sessionId, bucketMs: 60_000 }, [sessionId]);
  const jpy = settings?.diamondToJpy ?? 0.5;

  const delta = useMemo(() => {
    if (!d?.prev) return null;
    const f = (a: number, b: number) => (b === 0 ? null : Math.round(((a - b) / b) * 100));
    return {
      peak: f(d.peakViewers, d.prev.peakViewers),
      diamonds: f(d.diamonds, d.prev.diamonds),
      comments: f(d.comments, d.prev.comments),
      followers: f(d.newFollowers, d.prev.newFollowers),
    };
  }, [d]);

  if (!d) return <div className="card">読み込み中…</div>;

  return (
    <div className="grid">
      <div className="card">
        <div className="row">
          <h3 style={{ margin: 0 }}>{formatDateJa(d.startedMs)} の配信</h3>
          <div className="spacer" />
          <button className="btn small" onClick={() => openSession(null)}>
            閉じる
          </button>
        </div>
        <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginTop: 10 }}>
          <St k="配信時間" v={formatDurationJa(d.durationMs)} />
          <St k="ピーク同接" v={num(d.peakViewers)} d={delta?.peak} />
          <St k="累計視聴者" v={num(d.totalViewers)} />
          <St k="観測ユニーク" v={num(d.uniqueViewers)} />
          <St k="初見" v={num(d.newVsReturning.first)} sub={percent(d.newVsReturning.first, d.funnel.viewers)} />
          <St k="コメント" v={num(d.comments)} d={delta?.comments} />
          <St k="ルーム総いいね" v={compact(d.roomTotalLikes)} />
          <St k="ダイヤ" v={num(d.diamonds)} sub={diamondsToJpy(d.diamonds, jpy)} d={delta?.diamonds} />
          <St k="新規フォロワー" v={num(d.newFollowers)} d={delta?.followers} />
        </div>
        {d.sameWeekdayAvg ? (
          <div className="faint" style={{ marginTop: 10, fontSize: 11 }}>
            同じ曜日の平均：ピーク {num(d.sameWeekdayAvg.peakViewers)} · コメント {num(d.sameWeekdayAvg.comments)} · 💎{' '}
            {num(d.sameWeekdayAvg.diamonds)} · フォロー {num(d.sameWeekdayAvg.newFollowers)}
          </div>
        ) : null}
      </div>

      <div className="card">
        <h3>視聴者の動き</h3>
        <Timeline points={tl ?? []} />
      </div>

      <div className="card">
        <h3>エンゲージメント・ファネル</h3>
        <Funnel f={d.funnel} />
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <Top title="ギフト上位" rows={d.topGifters} unit="💎" />
        <Top title="コメント上位" rows={d.topCommenters} unit="件" />
      </div>
    </div>
  );
}

function St({ k, v, sub, d }: { k: string; v: string; sub?: string; d?: number | null }) {
  return (
    <div className="stat">
      <div className="k">{k}</div>
      <div className="v sm">
        {v}
        {d != null ? (
          <span style={{ fontSize: 11, marginLeft: 5, color: d >= 0 ? 'var(--green)' : 'var(--red)' }}>
            {d >= 0 ? '+' : ''}
            {d}%
          </span>
        ) : null}
      </div>
      {sub ? <div className="k">{sub}</div> : null}
    </div>
  );
}

function Funnel({ f }: { f: { viewers: number; commenters: number; likers: number; gifters: number } }) {
  const steps = [
    { label: '観測した視聴者', v: f.viewers },
    { label: 'コメントした人', v: f.commenters },
    { label: 'いいねした人', v: f.likers },
    { label: 'ギフトをくれた人', v: f.gifters },
  ];
  return (
    <div>
      {steps.map((s, i) => (
        <div key={i} className="mission">
          <div className="lbl">
            <span>{s.label}</span>
            <span className="num">
              {num(s.v)}
              <span className="faint"> （{percent(s.v, f.viewers)}）</span>
            </span>
          </div>
          <div className="bar">
            <i style={{ width: `${f.viewers ? (s.v / f.viewers) * 100 : 0}%` }} />
          </div>
        </div>
      ))}
    </div>
  );
}

function Top({ title, rows, unit }: { title: string; rows: TopRow[]; unit: string }) {
  return (
    <div className="card">
      <h3>{title}</h3>
      {rows.length === 0 ? (
        <div className="empty">なし</div>
      ) : (
        <table className="data">
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.userId} style={{ cursor: 'pointer' }} onClick={() => openViewer(r.userId)}>
                <td style={{ width: 22, color: 'var(--fg-faint)' }}>{i + 1}</td>
                <td>{r.nickname || r.displayId}</td>
                <td className="n">
                  {num(r.value)} {unit}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Inline SVG — a charting library is not worth 200 kB for one line and some ticks. */
function Timeline({ points }: { points: Array<{ tsMs: number; viewers: number | null; diamonds: number; follows: number; comments: number }> }) {
  if (points.length < 2) return <div className="empty">データが足りません。</div>;
  const W = 900;
  const H = 160;
  const pad = 24;
  const xs = points.map((p) => p.tsMs);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const hasViewers = points.some((p) => p.viewers != null && p.viewers > 0);
  const maxV = Math.max(1, ...points.map((p) => p.viewers ?? 0));
  const x = (t: number) => pad + ((t - minX) / Math.max(1, maxX - minX)) * (W - pad * 2);
  const y = (v: number) => H - pad - (v / maxV) * (H - pad * 2);

  const line = points
    .filter((p) => p.viewers != null)
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.tsMs).toFixed(1)},${y(p.viewers!).toFixed(1)}`)
    .join(' ');

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 170 }}>
      <line x1={pad} y1={H - pad} x2={W - pad} y2={H - pad} stroke="var(--line)" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth={1.6} />
      {points.map((p, i) =>
        p.diamonds > 0 ? <circle key={`g${i}`} cx={x(p.tsMs)} cy={H - pad} r={3} fill="var(--gold)" /> : null
      )}
      {points.map((p, i) =>
        p.follows > 0 ? <rect key={`f${i}`} x={x(p.tsMs) - 1} y={H - pad - 7} width={2} height={7} fill="var(--green)" /> : null
      )}
      <text x={pad} y={12} fill="var(--fg-faint)" fontSize={10}>
        {/* Sessions recorded before the 同接 field was corrected have no data;
            saying so beats drawing a flat line labelled "最大 1". */}
        {hasViewers ? `同接 最大 ${maxV}` : '同接の記録なし（この配信は同接を取得していません）'}
      </text>
      <text x={W - pad} y={12} fill="var(--fg-faint)" fontSize={10} textAnchor="end">
        ● ギフト ▮ フォロー
      </text>
    </svg>
  );
}
