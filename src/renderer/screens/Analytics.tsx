import { useMemo, useState } from 'react';
import type { MatrixMetric } from '@shared/dto';
import { compact, num, score as fmtScore } from '@shared/format';
import { WEEKDAY_JA, relativeDayJa } from '@shared/time';
import { useQuery } from '../ipc/client';
import { openViewer } from '../state/uiStore';
import { Avatar, Observed, TierBadge } from '../components/common';
import { useUi } from '../state/uiStore';

const METRICS: Array<{ k: MatrixMetric; label: string }> = [
  { k: 'avgViewers', label: '平均同接' },
  { k: 'peakViewers', label: 'ピーク同接' },
  { k: 'newFollowers', label: '新規フォロワー' },
  { k: 'diamonds', label: 'ダイヤ' },
  { k: 'uniqueViewers', label: 'ユニーク視聴者' },
  { k: 'sessions', label: '配信回数' },
];

export function Analytics(): React.JSX.Element {
  return (
    <div className="screen">
      <h2>分析</h2>
      <div className="grid" style={{ gridTemplateColumns: '1fr' }}>
        <Matrix />
        <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
          <Churn kind="churn" />
          <Churn kind="dormant" />
          <Leaderboard />
        </div>
      </div>
    </div>
  );
}

/** 時間帯 × 曜日 — the only way to find your own ゴールデンタイム, since TikTok's own history caps at 60 days. */
function Matrix(): React.JSX.Element {
  const [metric, setMetric] = useState<MatrixMetric>('avgViewers');
  const { data } = useQuery('q.matrix', { metric }, [metric]);

  const { grid, max } = useMemo(() => {
    const g = new Map<string, { value: number; sessions: number }>();
    let m = 0;
    for (const c of data ?? []) {
      g.set(`${c.weekday}-${c.hour}`, { value: c.value, sessions: c.sessions });
      if (c.value > m) m = c.value;
    }
    return { grid: g, max: m };
  }, [data]);

  const hours = Array.from({ length: 24 }, (_, i) => i);

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 10 }}>
        <h3 style={{ margin: 0 }}>時間帯 × 曜日</h3>
        <div className="spacer" />
        <select value={metric} onChange={(e) => setMetric(e.target.value as MatrixMetric)}>
          {METRICS.map((m) => (
            <option key={m.k} value={m.k}>
              {m.label}
            </option>
          ))}
        </select>
      </div>
      {max === 0 ? (
        <div className="empty">
          まだ配信の記録が足りません。
          <br />
          <span className="faint">配信を重ねるほど、自分にとって最も伸びる時間帯が見えてきます。</span>
        </div>
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <div className="matrix" style={{ minWidth: 700 }}>
            <div />
            {hours.map((h) => (
              <div className="hd" key={`h${h}`}>
                {h}
              </div>
            ))}
            {[1, 2, 3, 4, 5, 6, 0].map((wd) => (
              <FragmentRow key={wd} wd={wd} hours={hours} grid={grid} max={max} />
            ))}
          </div>
          <div className="faint" style={{ fontSize: 11, marginTop: 8 }}>
            配信の<b>開始時刻</b>で集計しています（日本時間）。数字はセル内の平均値です。
          </div>
        </div>
      )}
    </div>
  );
}

function FragmentRow({
  wd,
  hours,
  grid,
  max,
}: {
  wd: number;
  hours: number[];
  grid: Map<string, { value: number; sessions: number }>;
  max: number;
}) {
  return (
    <>
      <div className="hd" style={{ lineHeight: '24px' }}>
        {WEEKDAY_JA[wd]}
      </div>
      {hours.map((h) => {
        const c = grid.get(`${wd}-${h}`);
        const t = c ? Math.min(1, c.value / max) : 0;
        return (
          <div
            key={`${wd}-${h}`}
            className="cell"
            title={c ? `${WEEKDAY_JA[wd]} ${h}時台 — ${num(c.value)}（${c.sessions}回の配信）` : `${WEEKDAY_JA[wd]} ${h}時台 — 配信なし`}
            style={
              c
                ? { background: `rgba(41, 214, 196, ${0.18 + t * 0.82})`, color: t > 0.45 ? '#06231f' : 'var(--fg)' }
                : undefined
            }
          >
            {c ? compact(c.value) : ''}
          </div>
        );
      })}
    </>
  );
}

function Churn({ kind }: { kind: 'churn' | 'dormant' }): React.JSX.Element {
  const settings = useUi((s) => s.settings);
  const { data } = useQuery('q.churn', { kind, limit: 30 }, [kind]);
  const title = kind === 'churn' ? '常連チャーンアラート' : '休眠ギフター';
  const hint =
    kind === 'churn'
      ? 'いつものペースより長く来ていない常連さんです。次の配信で名前を呼ぶか、声をかける価値があります。'
      : '過去にギフトをくれたのに、しばらく来ていない人です。最も反応が返りやすい相手です。';

  return (
    <div className="card">
      <h3>{title}</h3>
      <div className="faint" style={{ fontSize: 11, marginBottom: 8 }}>
        {hint}
      </div>
      {data && data.length > 0 ? (
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <table className="data">
            <tbody>
              {data.map((r) => (
                <tr key={r.userId} style={{ cursor: 'pointer' }} onClick={() => openViewer(r.userId)}>
                  <td style={{ width: 26 }}>
                    <Avatar url={r.avatarUrl} name={r.nickname} size={20} enabled={settings?.loadAvatars ?? true} />
                  </td>
                  <td>
                    {r.nickname} <TierBadge tier={r.vipTier} />
                    {r.note ? (
                      <div className="faint" style={{ fontSize: 11 }}>
                        📝 {r.note}
                      </div>
                    ) : null}
                  </td>
                  <td className="n" style={{ whiteSpace: 'nowrap' }}>
                    {relativeDayJa(r.lastSeenMs)}
                    <div className="faint" style={{ fontSize: 10 }}>
                      {kind === 'churn' && r.overdueRatio
                        ? `いつもの ${r.overdueRatio.toFixed(1)} 倍`
                        : `累計 ${compact(r.diamondsLifetime)}💎`}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">対象はいません。</div>
      )}
    </div>
  );
}

function Leaderboard(): React.JSX.Element {
  const settings = useUi((s) => s.settings);
  const [scope, setScope] = useState<'lifetime' | 'month' | 'week'>('lifetime');
  const { data } = useQuery('q.leaderboard', { scope, metric: scope === 'lifetime' ? 'score' : 'diamonds', limit: 30 }, [scope]);

  return (
    <div className="card">
      <div className="row" style={{ marginBottom: 8 }}>
        <h3 style={{ margin: 0 }}>常連ランキング</h3>
        <div className="spacer" />
        <select value={scope} onChange={(e) => setScope(e.target.value as typeof scope)}>
          <option value="lifetime">累計スコア</option>
          <option value="month">今月の💎</option>
          <option value="week">今週の💎</option>
        </select>
      </div>
      {data && data.rows.length > 0 ? (
        <div style={{ maxHeight: 320, overflow: 'auto' }}>
          <table className="data">
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.userId} style={{ cursor: 'pointer' }} onClick={() => openViewer(r.userId)}>
                  <td style={{ width: 24, color: 'var(--fg-faint)' }}>{r.rank}</td>
                  <td style={{ width: 26 }}>
                    <Avatar url={r.avatarUrl} name={r.nickname} size={20} enabled={settings?.loadAvatars ?? true} />
                  </td>
                  <td>
                    {r.nickname} <TierBadge tier={r.vipTier} />
                  </td>
                  <td className="n">{scope === 'lifetime' ? fmtScore(r.value) : compact(r.value)}</td>
                  <td className="n faint" style={{ width: 54 }}>
                    {num(r.visits)}回
                    <Observed />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty">まだデータがありません。</div>
      )}
    </div>
  );
}
