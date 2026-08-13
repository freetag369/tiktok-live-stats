import { useEffect, useState } from 'react';
import { compact, diamondsToJpy, num, percent, score as fmtScore } from '@shared/format';
import { formatDateJa, relativeDayJa } from '@shared/time';
import { TIER_LABEL_JA } from '@shared/scoring';
import { rpc, useQuery } from '../ipc/client';
import { openViewer, toast, useUi } from '../state/uiStore';
import { useLive } from '../state/liveStore';
import { Avatar, Observed, TierBadge } from '../components/common';

type Tab = 'comments' | 'gifts' | 'likes' | 'memo';

export function ViewerDetail(): React.JSX.Element | null {
  const userId = useUi((s) => s.selectedViewer);
  const settings = useUi((s) => s.settings);
  const sessionId = useLive((s) => s.sessionId);
  const [tab, setTab] = useState<Tab>('comments');
  const [kana, setKana] = useState('');
  const [note, setNote] = useState('');
  const [dirty, setDirty] = useState(false);

  const { data, reload } = useQuery('q.viewer', { userId: userId ?? '', sessionId }, [userId, sessionId], {
    skip: !userId,
  });

  useEffect(() => {
    if (data) {
      setKana(data.row.readingKana ?? '');
      setNote(data.row.note ?? '');
      setDirty(false);
      setTab('comments');
    }
  }, [data?.row.userId]);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === 'Escape') openViewer(null);
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  if (!userId) return null;
  const r = data?.row;

  async function save(): Promise<void> {
    if (!userId) return;
    try {
      await rpc('m.viewerMeta', { userId, patch: { readingKana: kana || null, note: note || null } });
      setDirty(false);
      reload();
      toast({ level: 'info', msgJa: '保存しました。' });
    } catch (e) {
      toast({ level: 'error', msgJa: `保存に失敗しました: ${(e as Error).message}` });
    }
  }

  async function setTier(tier: number | null): Promise<void> {
    if (!userId) return;
    try {
      await rpc('m.viewerMeta', { userId, patch: { vipTierManual: tier } });
      reload();
    } catch (e) {
      toast({ level: 'error', msgJa: `VIP設定に失敗しました: ${(e as Error).message}` });
    }
  }

  async function forget(mode: 'block' | 'purge'): Promise<void> {
    if (!userId) return;
    const msg =
      mode === 'block'
        ? 'この人を今後記録しないようにします。これまでの記録は残ります。よろしいですか？'
        : 'この人の記録をすべて削除します。元に戻せません。よろしいですか？';
    if (!window.confirm(msg)) return;
    try {
      await rpc('m.forgetViewer', { userId, mode });
      openViewer(null);
      toast({ level: 'info', msgJa: mode === 'block' ? '今後は記録しません。' : '削除しました。' });
    } catch (e) {
      toast({ level: 'error', msgJa: `処理に失敗しました: ${(e as Error).message}` });
    }
  }

  return (
    <div className="modal-bg" onClick={() => openViewer(null)}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header>
          {r ? (
            <>
              <Avatar url={r.avatarUrl} name={r.nickname} size={40} enabled={settings?.loadAvatars ?? true} />
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {r.nickname} <TierBadge tier={r.vipTier} />
                  {r.vipSource === 'manual' ? <span className="badge">手動</span> : null}
                </div>
                <div className="faint">@{r.displayId}</div>
              </div>
            </>
          ) : (
            <div>読み込み中…</div>
          )}
          <div className="spacer" />
          <button className="btn small" onClick={() => openViewer(null)}>
            閉じる
          </button>
        </header>

        <div className="body">
          {r ? (
            <>
              <div className="stats" style={{ gridTemplateColumns: 'repeat(4, 1fr)', marginBottom: 14 }}>
                <S k="来店回数" v={num(r.visits)} observed />
                <S k="初回来店" v={formatDateJa(r.firstSeenMs)} small />
                <S k="最終来店" v={relativeDayJa(r.lastSeenMs)} small />
                <S k="連続来店" v={`${num(r.consecutiveStreak)} 回`} />
                <S k="今回いいね" v={compact(r.likesCurrent)} observed />
                <S k="前回いいね" v={compact(r.likesPrev)} observed />
                <S k="累計いいね" v={compact(r.likesLifetime)} observed />
                <S k="貢献度スコア" v={fmtScore(r.score)} />
                <S k="今回💎" v={num(r.diamondsCurrent)} />
                <S k="前回💎" v={num(r.diamondsPrev)} />
                <S
                  k="累計💎"
                  v={num(r.diamondsLifetime)}
                  small
                  sub={diamondsToJpy(r.diamondsLifetime, settings?.diamondToJpy ?? 0.5)}
                />
                <S k="ハートミー累計" v={num(r.heartMeLifetime)} />
              </div>

              {data.identityHistory.length > 1 ? (
                <div className="notice info" style={{ marginBottom: 12 }}>
                  名前の変更履歴：
                  {data.identityHistory.map((h, i) => (
                    <span key={i}>
                      {i > 0 ? ' → ' : ' '}
                      {h.nickname}（@{h.displayId}）
                    </span>
                  ))}
                </div>
              ) : null}

              <div className="tabs">
                {(
                  [
                    ['comments', 'コメント履歴'],
                    ['gifts', 'ギフト履歴'],
                    ['likes', 'いいね推移'],
                    ['memo', 'メモ・設定'],
                  ] as Array<[Tab, string]>
                ).map(([k, label]) => (
                  <button key={k} className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>
                    {label}
                  </button>
                ))}
              </div>

              {tab === 'comments' ? <CommentTab userId={userId} /> : null}
              {tab === 'gifts' ? <GiftTab userId={userId} totals={data.giftTotals} /> : null}
              {tab === 'likes' ? <LikeTab userId={userId} /> : null}
              {tab === 'memo' ? (
                <div className="grid" style={{ maxWidth: 560 }}>
                  <label className="field">
                    よみがな（名前を呼ぶとき用）
                    <input
                      type="text"
                      value={kana}
                      onChange={(e) => {
                        setKana(e.target.value);
                        setDirty(true);
                      }}
                      placeholder="例: たろう"
                    />
                  </label>
                  <label className="field">
                    メモ（誕生日・好きな話題・NG話題など）
                    <textarea
                      rows={5}
                      value={note}
                      onChange={(e) => {
                        setNote(e.target.value);
                        setDirty(true);
                      }}
                    />
                  </label>
                  <div className="row">
                    <button className="btn primary" onClick={() => void save()} disabled={!dirty}>
                      保存
                    </button>
                  </div>

                  <div>
                    <div className="muted" style={{ marginBottom: 6 }}>
                      VIP 段階（手動で設定すると自動判定に上書きされません）
                    </div>
                    <div className="row wrap">
                      {[0, 1, 2, 3].map((t) => (
                        <button
                          key={t}
                          className={`btn small${r.vipSource === 'manual' && r.vipTier === t ? ' primary' : ''}`}
                          onClick={() => void setTier(t)}
                        >
                          {TIER_LABEL_JA[t]}
                        </button>
                      ))}
                      <button className="btn small" onClick={() => void setTier(null)}>
                        自動に戻す
                      </button>
                    </div>
                  </div>

                  <div className="row wrap" style={{ marginTop: 8 }}>
                    <button className="btn small danger" onClick={() => void forget('block')}>
                      今後は記録しない
                    </button>
                    <button className="btn small danger" onClick={() => void forget('purge')}>
                      過去のデータも削除
                    </button>
                  </div>
                  <div className="faint" style={{ fontSize: 11 }}>
                    「今後は記録しない」は過去の記録を残したまま、以後のイベントを保存しません。
                  </div>
                </div>
              ) : null}
            </>
          ) : (
            <div className="empty">読み込み中…</div>
          )}
        </div>
      </div>
    </div>
  );
}

function S({ k, v, sub, observed, small }: { k: string; v: string; sub?: string; observed?: boolean; small?: boolean }) {
  return (
    <div className="stat">
      <div className="k">
        {k}
        {observed ? <Observed /> : null}
      </div>
      <div className={`v${small || sub ? ' sm' : ''}`}>{v}</div>
      {sub ? <div className="k">{sub}</div> : null}
    </div>
  );
}

function CommentTab({ userId }: { userId: string }) {
  const [q, setQ] = useState('');
  const { data } = useQuery('q.comments', { userId, text: q || undefined, limit: 500 }, [userId, q]);
  return (
    <div>
      <input
        type="search"
        placeholder="コメントを検索"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ width: '100%', marginBottom: 10 }}
      />
      <div className="faint" style={{ marginBottom: 6 }}>
        {data ? `${num(data.total)}件` : '…'}
      </div>
      <div style={{ maxHeight: 380, overflow: 'auto' }}>
        <table className="data">
          <tbody>
            {data?.rows.map((c) => (
              <tr key={c.msgId}>
                <td style={{ width: 150, color: 'var(--fg-faint)' }}>{formatDateJa(c.tsMs)}</td>
                <td>
                  {c.isQuestion ? <span className="badge">質問</span> : null} {c.content}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {data && data.rows.length === 0 ? <div className="empty">該当するコメントはありません。</div> : null}
      </div>
    </div>
  );
}

function GiftTab({ userId, totals }: { userId: string; totals: Array<{ giftName: string; count: number; diamonds: number; canonical: string | null; iconUrl: string | null }> }) {
  const { data } = useQuery('q.gifts', { userId, limit: 300 }, [userId]);
  return (
    <div>
      {totals.length > 0 ? (
        <div className="card" style={{ marginBottom: 12 }}>
          <h3>ギフト内訳</h3>
          <table className="data">
            <thead>
              <tr>
                <th>ギフト</th>
                <th className="n">個数</th>
                <th className="n">ダイヤ</th>
              </tr>
            </thead>
            <tbody>
              {totals.map((g, i) => (
                <tr key={i} style={g.canonical === 'heart_me' ? { color: 'var(--pink)' } : undefined}>
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
        </div>
      ) : (
        <div className="empty">ギフトの記録はありません。</div>
      )}
      {data && data.rows.length > 0 ? (
        <div style={{ maxHeight: 260, overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th>日時</th>
                <th>ギフト</th>
                <th className="n">個数</th>
                <th className="n">💎</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((g) => (
                <tr key={g.msgId}>
                  <td style={{ color: 'var(--fg-faint)' }}>{formatDateJa(g.tsMs)}</td>
                  <td>
                    {g.giftName ?? g.giftId}
                    {g.isBoxGift ? <span className="badge" title="ボックスギフトはダイヤ数が不正確な場合があります"> 箱</span> : null}
                  </td>
                  <td className="n">{num(g.repeatCount)}</td>
                  <td className="n">{num(g.diamonds)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function LikeTab({ userId }: { userId: string }) {
  const { data } = useQuery('q.likeSeries', { userId, limitSessions: 30 }, [userId]);
  const rows = data ?? [];
  const max = Math.max(1, ...rows.map((r) => r.likes));
  return (
    <div>
      <div className="faint" style={{ marginBottom: 8 }}>
        配信ごとの観測いいね数
        <Observed />
      </div>
      <div className="row" style={{ alignItems: 'flex-end', gap: 4, height: 140, overflowX: 'auto' }}>
        {rows.map((r) => (
          <div key={r.sessionId} style={{ textAlign: 'center', minWidth: 26 }}>
            <div
              title={`${formatDateJa(r.startedMs)} — ${num(r.likes)} いいね / ${num(r.diamonds)}💎`}
              style={{
                height: Math.max(2, (r.likes / max) * 110),
                background: r.diamonds > 0 ? 'var(--gold)' : 'var(--accent-dim)',
                borderRadius: 3,
              }}
            />
            <div className="faint" style={{ fontSize: 9, marginTop: 3 }}>
              {compact(r.likes)}
            </div>
          </div>
        ))}
      </div>
      {rows.length === 0 ? <div className="empty">まだデータがありません。</div> : null}
      {rows.length > 0 ? (
        <div className="faint" style={{ marginTop: 10, fontSize: 11 }}>
          コメント率 {percent(rows.filter((r) => r.comments > 0).length, rows.length)} · ギフト率{' '}
          {percent(rows.filter((r) => r.diamonds > 0).length, rows.length)}
        </div>
      ) : null}
    </div>
  );
}
