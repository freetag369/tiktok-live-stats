import { useEffect, useMemo, useState } from 'react';
import type { ViewerFilter, ViewerTableRow } from '@shared/dto';
import type { FeedItem } from '@shared/ipc';
import { compact, diamondsToJpy, num } from '@shared/format';
import { formatDurationJa, relativeDayJa } from '@shared/time';
import { rpc, useQuery, useDebounced } from '../ipc/client';
import { dismissAlert, liveRow, setChallenge, useLive } from '../state/liveStore';
import { openViewer, setSort, useUi } from '../state/uiStore';
import { Avatar, Bar, Observed, TierBadge, useStickyTop } from '../components/common';
import { MemoButton } from '../components/Memo';
import { ObservedLegend, ViewerTable } from '../components/ViewerTable';
import { useChallengeSe } from '../lib/useChallengeSe';

const FILTERS: Array<{ k: ViewerFilter; label: string }> = [
  { k: 'all', label: 'すべて' },
  { k: 'present', label: '今いる人' },
  { k: 'firstTime', label: '初見' },
  { k: 'regular', label: '常連以上' },
  { k: 'vip', label: 'VIP' },
  { k: 'gifter', label: 'ギフター' },
];

export function LiveDashboard(): React.JSX.Element {
  const { sessionId, totals, feed, alerts, missions, droppedFeed, version } = useLive();
  const { sort, desc, filter, search, settings, showJoins, showRecord, memoNonce } = useUi();
  const debouncedSearch = useDebounced(search, 250);
  const visibleFeed = useMemo(() => (showJoins ? feed : feed.filter((f) => f.k !== 'j')), [feed, showJoins]);
  // Keeps the newest comment in view unless the user has deliberately scrolled back.
  const feedRef = useStickyTop(visibleFeed[0]?.id);

  // The database is the source of truth. Live deltas fill the gap between
  // refreshes so the numbers never appear to go backwards mid-stream.
  const { data } = useQuery(
    'q.viewerTable',
    { sessionId, sort, desc, filter, search: debouncedSearch, limit: 5000 },
    [sessionId, sort, desc, filter, debouncedSearch, memoNonce, Math.floor(version / 6)]
  );

  const rows = useMemo<ViewerTableRow[]>(() => {
    const base = data?.rows ?? [];
    return base.map((r) => {
      const l = liveRow(r.userId);
      if (!l) return r;
      return {
        ...r,
        likesCurrent: Math.max(r.likesCurrent, l.likes),
        commentsCurrent: Math.max(r.commentsCurrent, l.comments),
        diamondsCurrent: Math.max(r.diamondsCurrent, l.diamonds),
        heartMeCurrent: Math.max(r.heartMeCurrent, l.heartMe),
        presentNow: r.presentNow || l.lastSeenMs > 0,
      };
    });
  }, [data, version]);

  const jpy = settings?.diamondToJpy ?? 0.5;

  return (
    <div className="dash">
      {/* ── comments (leftmost: the surface watched most during a stream) ── */}
      <section className="pane">
        <header>
          <strong>コメント</strong>
          <span className="faint" style={{ fontSize: 11 }}>
            新しい順
          </span>
          {droppedFeed > 0 ? (
            <span className="faint" style={{ fontSize: 11 }}>
              省略 {num(droppedFeed)}
            </span>
          ) : null}
        </header>
        {/* Newest first, and the view is pulled back to the top on each tick so a
            new comment is never hidden above the fold. */}
        <div className="body" ref={feedRef}>
          {visibleFeed.map((f) => (
            <FeedRow
              key={f.id}
              item={f}
              showAvatars={settings?.loadAvatars ?? true}
              showRecord={showRecord}
            />
          ))}
          {visibleFeed.length === 0 ? <div className="empty">配信を開始するとコメントが流れます。</div> : null}
        </div>
        <footer
          className="row wrap"
          style={{ padding: '4px 10px', borderTop: '1px solid var(--line)', justifyContent: 'space-between', gap: 6 }}
        >
          <span className="faint" style={{ fontSize: 10.5 }}>
            <span style={{ color: 'var(--pink)' }}>■</span> 初見{'　'}
            <span style={{ color: 'var(--violet)' }}>■</span> VIP・常連{'　'}
            <span style={{ color: 'var(--gold)' }}>■</span> 質問・ギフト{'　'}
            <span style={{ color: 'var(--green)' }}>■</span> フォロー
          </span>
          <span className="row" style={{ gap: 10 }}>
            <label className="row faint" style={{ fontSize: 11, cursor: 'pointer', gap: 4, whiteSpace: 'nowrap' }}>
              <input
                type="checkbox"
                checked={showRecord}
                onChange={(e) => useUi.setState({ showRecord: e.target.checked })}
              />
              記録
            </label>
            <label className="row faint" style={{ fontSize: 11, cursor: 'pointer', gap: 4, whiteSpace: 'nowrap' }}>
              <input type="checkbox" checked={showJoins} onChange={(e) => useUi.setState({ showJoins: e.target.checked })} />
              入室
            </label>
          </span>
        </footer>
      </section>

      {/* ── viewers ─────────────────────────────────────────────────────── */}
      <section className="pane">
        <header>
          <strong>視聴者</strong>
          {/* The table holds everyone ever recorded; saying just "361人" during a
              live stream reads as the room size and is wildly wrong. */}
          <span className="faint num">
            今 {num(totals.uniqueViewers)}人
            <span className="faint"> / 記録 {num(data?.total ?? rows.length)}人</span>
          </span>
          <div className="spacer" />
          <input
            type="search"
            placeholder="名前・@・よみがな"
            value={search}
            style={{ width: 170 }}
            onChange={(e) => useUi.setState({ search: e.target.value })}
          />
          <select value={filter} onChange={(e) => useUi.setState({ filter: e.target.value as ViewerFilter })}>
            {FILTERS.map((f) => (
              <option key={f.k} value={f.k}>
                {f.label}
              </option>
            ))}
          </select>
        </header>
        <ViewerTable
          rows={rows}
          sort={sort}
          desc={desc}
          onSort={setSort}
          onPick={openViewer}
          showAvatars={settings?.loadAvatars ?? true}
        />
        <footer style={{ padding: '5px 10px', borderTop: '1px solid var(--line)' }}>
          <ObservedLegend />
        </footer>
      </section>

      {/* ── alerts + totals + missions ──────────────────────────────────── */}
      <section className="pane">
        <header>
          <strong>入室 &amp; サマリー</strong>
        </header>
        <div className="body" style={{ padding: 10 }}>
          {alerts.map((a) => (
            <div
              key={`${a.kind}-${a.userId}-${a.atMs}`}
              className={`alert-card ${a.kind === 'gift' ? 'gift' : a.isFirstEver ? 'first' : `t${a.vipTier}`}`}
              onClick={() => dismissAlert(a.userId)}
              title="クリックで消す"
            >
              <div className="row">
                <Avatar url={a.avatarUrl} name={a.nickname} size={30} enabled={settings?.loadAvatars ?? true} />
                <div style={{ minWidth: 0 }}>
                  <div className="alert-name">{a.nickname}</div>
                  {a.readingKana ? <div className="alert-kana">{a.readingKana}</div> : null}
                </div>
                <div className="spacer" />
                {a.kind === 'gift' ? (
                  <span className="badge t3">ギフト</span>
                ) : a.isFirstEver ? (
                  <span className="badge first">初見さん</span>
                ) : (
                  <TierBadge tier={a.vipTier} />
                )}
              </div>

              {a.kind === 'gift' && a.gift ? (
                // A 4,888-diamond gift scrolling past as one grey line is a
                // thank-you that never happens. This is the moment of the stream.
                <div style={{ marginTop: 8 }}>
                  <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--gold)' }}>
                    {a.gift.name}
                    {a.gift.count > 1 ? ` ×${a.gift.count}` : ''}
                  </div>
                  <div style={{ fontSize: 15, fontWeight: 700 }}>
                    {num(a.gift.diamonds)} 💎
                    <span className="faint" style={{ fontSize: 12, fontWeight: 400 }}>
                      {' '}
                      （{diamondsToJpy(a.gift.diamonds, jpy)}）
                    </span>
                  </div>
                  <div className="muted" style={{ marginTop: 4, fontSize: 12 }}>
                    {a.visits > 0 ? `${num(a.visits)}回目の来店 · ` : ''}累計💎 {compact(a.diamondsLifetime + a.gift.diamonds)}
                  </div>
                  {a.note ? <div style={{ color: 'var(--gold)', marginTop: 3, fontSize: 12 }}>📝 {a.note}</div> : null}
                </div>
              ) : a.isFirstEver ? (
                <div className="muted" style={{ marginTop: 6 }}>
                  はじめての来店です。名前を呼んで歓迎しましょう。
                </div>
              ) : (
                <div style={{ marginTop: 6, fontSize: 12 }}>
                  <div className="muted">
                    {num(a.visits)}回目の来店 · 前回 {relativeDayJa(a.prevVisitMs)} · 累計💎 {compact(a.diamondsLifetime)}
                    {a.heartMeLifetime > 0 ? ` · ハトミー ${num(a.heartMeLifetime)}` : ''}
                  </div>
                  {a.note ? <div style={{ color: 'var(--gold)', marginTop: 3 }}>📝 {a.note}</div> : null}
                  {a.lastComments.length > 0 ? (
                    <div className="faint" style={{ marginTop: 3 }}>
                      前回の話: {a.lastComments[0]}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ))}

          <ChallengeCard />

          {missions.length > 0 ? (
            <div className="card" style={{ marginBottom: 10 }}>
              <h3>報酬ミッション</h3>
              {missions.map((m) => (
                <div className="mission" key={m.id}>
                  <div className="lbl">
                    <span>{m.labelJa}</span>
                    <span className="num">
                      {num(m.current)} / {num(m.target)}
                      {m.projected != null ? <span className="faint"> （このペースで {num(m.projected)}）</span> : null}
                    </span>
                  </div>
                  <Bar value={m.current} target={m.target} done={m.done} pace={m.windowElapsed} />
                </div>
              ))}
            </div>
          ) : null}

          <div className="card">
            <h3>
              この配信 <span className="faint">{formatDurationJa(totals.elapsedMs)}</span>
            </h3>
            <div className="stats">
              <Stat k="同接" v={totals.viewers == null ? '—' : num(totals.viewers)} />
              <Stat k="ピーク同接" v={num(totals.peakViewers)} />
              {/* TikTok's cumulative entry count — far larger than 同接, and the
                  number the app used to mislabel as 同接 before real data settled it. */}
              <Stat k="累計視聴者" v={num(totals.totalViewers)} />
              <Stat k="観測ユニーク" v={num(totals.uniqueViewers)} sub={`初見 ${num(totals.firstTimers)}`} observed />
              <Stat k="コメント" v={num(totals.comments)} />
              <Stat k="ルーム総いいね" v={compact(totals.roomTotalLikes)} />
              <Stat k="観測いいね" v={compact(totals.observedLikes)} observed />
              <Stat k="ダイヤ" v={num(totals.diamonds)} sub={diamondsToJpy(totals.diamonds, jpy)} />
              <Stat k="ハートミー" v={num(totals.heartMe)} />
              <Stat k="新規フォロワー" v={num(totals.newFollowers)} />
              <Stat k="シェア" v={num(totals.shares)} />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

/**
 * カウントダウンチャレンジの操作カード。
 *
 * 数字の即時性が命: ボタンは rpc の戻り値で自分の画面を即更新し、worker の
 * nudge delta が同時にモニター窓を更新する。両方受けても状態全量なので冪等。
 */
function ChallengeCard(): React.JSX.Element | null {
  const challenge = useLive((s) => s.challenge);
  const settings = useUi((s) => s.settings);
  const [monitorOpen, setMonitorOpen] = useState(false);
  const enabled = settings?.challenge.enabled ?? false;

  useEffect(() => {
    if (!enabled) return;
    void rpc('challenge.get', undefined).then(setChallenge);
    void rpc('monitor.status', undefined).then((r) => setMonitorOpen(r.open));
    return window.api.onMonitorState((s) => setMonitorOpen(s.open));
  }, [enabled]);

  // 効果音: モニターが開いている間はモニター側が鳴らす — こちらは active=false で
  // watermark だけ進め、閉じた瞬間に過去演出が一斉に鳴るのを防ぐ(early return より
  // 前に置く: hooks ルール)。
  useChallengeSe(challenge, {
    active: enabled && !monitorOpen,
    enabled: settings?.challenge.seEnabled ?? true,
    volume: settings?.challenge.seVolume ?? 70,
    sounds: settings?.challenge.seSounds,
  });

  if (!enabled || !settings) return null;

  const st = challenge?.status ?? 'idle';
  const value = challenge?.value ?? settings.challenge.initialValue;
  const call = (m: 'challenge.start' | 'challenge.stop' | 'challenge.reset' | 'challenge.press') =>
    void rpc(m, undefined).then(setChallenge);

  // 直近の変動ログ。press は連打で洪水になる(数字とパンチで見えている)ので除外。
  const fxLog = (challenge?.recentEffects ?? [])
    .filter((e) => e.kind === 'follow' || e.kind === 'like' || e.kind === 'gift')
    .slice(0, 4);

  return (
    <div className="card challenge-card" style={{ marginBottom: 10 }}>
      <h3>
        {challenge?.title ?? settings.challenge.title}{' '}
        {st === 'running' ? (
          <span className="badge t1">進行中</span>
        ) : st === 'achieved' ? (
          <span className="badge t3">達成!</span>
        ) : (
          <span className="badge">停止中</span>
        )}
      </h3>
      <div className={`challenge-value${st === 'achieved' ? ' done' : ''}`}>{num(value)}</div>
      {fxLog.length > 0 ? (
        <div className="challenge-log">
          {fxLog.map((e) => (
            // id は単調増加 — 新規行だけ新規マウントされ、登場アニメが1回走る。
            <div key={e.id} className={`challenge-log-item ${e.amount > 0 ? 'up' : 'down'}`}>
              <span className="amt">{e.amount > 0 ? `+${num(e.amount)}` : num(e.amount)}</span>
              <span className="lbl">
                {e.kind === 'follow'
                  ? `フォロー ${e.nickname ?? ''}`
                  : e.kind === 'like'
                    ? 'いいね'
                    : `${e.giftName ?? 'ギフト'} ${e.nickname ?? ''}`}
              </span>
            </div>
          ))}
        </div>
      ) : null}
      <button
        className="challenge-btn"
        disabled={st !== 'running'}
        onClick={() => call('challenge.press')}
        title={settings.challenge.hotkey ? `ホットキー: ${settings.challenge.hotkey}` : undefined}
      >
        PUSH
        <span className="sub">−{num(settings.challenge.pressStep)}</span>
      </button>
      <div className="row wrap" style={{ marginTop: 8 }}>
        {st === 'running' ? (
          <button className="btn small" onClick={() => call('challenge.stop')}>
            一時停止
          </button>
        ) : (
          <button className="btn small primary" onClick={() => call('challenge.start')}>
            開始
          </button>
        )}
        <button className="btn small" onClick={() => call('challenge.reset')}>
          リセット
        </button>
        <button
          className="btn small"
          onClick={() => void rpc(monitorOpen ? 'monitor.close' : 'monitor.open', undefined)}
        >
          {monitorOpen ? 'モニターを閉じる' : 'モニターを開く'}
        </button>
      </div>
      {challenge?.likeGauge && st === 'running' ? (
        <div className="challenge-like-mini" title="いいね進捗(満タンで加算)">
          <i
            style={{
              width: `${Math.min(100, (challenge.likeGauge.counter / Math.max(1, challenge.likeGauge.every)) * 100)}%`,
            }}
          />
          <span>
            ♥ {num(challenge.likeGauge.counter)}/{num(challenge.likeGauge.every)} → +
            {num(challenge.likeGauge.step)}
          </span>
        </div>
      ) : null}
      <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
        フォローで +{num(settings.challenge.followStep)}(妨害)
        {settings.challenge.likeEvery > 0
          ? ` ・ いいね${num(settings.challenge.likeEvery)}件で +${num(settings.challenge.likeStep)}`
          : ''}
        {settings.challenge.hotkey ? ` ・ ホットキー ${settings.challenge.hotkey}` : ''}
        {challenge ? ` ・ 押下 ${num(challenge.stats.presses)} / 妨害 ${num(challenge.stats.follows)}` : ''}
        {challenge && challenge.stats.likeUp > 0 ? ` / いいね+${num(challenge.stats.likeUp)}` : ''}
      </div>
    </div>
  );
}

function Stat({ k, v, sub, observed }: { k: string; v: string; sub?: string; observed?: boolean }) {
  return (
    <div className="stat">
      <div className="k">
        {k}
        {observed ? <Observed /> : null}
      </div>
      <div className={`v${sub ? ' sm' : ''}`}>{v}</div>
      {sub ? <div className="k">{sub}</div> : null}
    </div>
  );
}

/**
 * The commenter's record, inline.
 *
 * Reading "おつかれさま" tells you nothing; reading it next to 「12回目 · 前回 昨日 ·
 * 累計💎498」 tells you to thank them by name. Lifetime figures ride along on the
 * feed row; this stream's numbers are merged from the live aggregate so they are
 * never a few seconds stale.
 */
function Record({ f }: { f: FeedItem }) {
  const live = liveRow(f.u);
  const parts: React.ReactNode[] = [];

  // Same set of figures as the 視聴者 table, so the two read identically and the
  // streamer never has to cross-reference mid-stream.
  if (f.k === 'j' ? f.first : f.vis === 0) {
    parts.push(
      <span key="new" style={{ color: 'var(--pink)' }}>
        初めての来店
      </span>
    );
  } else {
    parts.push(<span key="v">来店{num(f.vis)}</span>);
  }

  const likeNow = live?.likes ?? 0;
  if (likeNow > 0) parts.push(<span key="l">今回💗{compact(likeNow)}</span>);
  const likeAll = (f.ll ?? 0) + likeNow;
  if (likeAll > 0)
    parts.push(
      <span key="la" className="faint">
        累計💗{compact(likeAll)}
      </span>
    );

  const diaNow = live?.diamonds ?? 0;
  if (diaNow > 0)
    parts.push(
      <span key="dn" style={{ color: 'var(--gold)' }}>
        今回💎{compact(diaNow)}
      </span>
    );
  const diaAll = (f.dl ?? 0) + diaNow;
  if (diaAll > 0)
    parts.push(
      <span key="da" className="faint">
        累計💎{compact(diaAll)}
      </span>
    );

  const hm = (f.hl ?? 0) + (live?.heartMe ?? 0);
  if (hm > 0)
    parts.push(
      <span key="h" style={{ color: 'var(--pink)' }}>
        ハトミー{num(hm)}
      </span>
    );

  if (f.pv) parts.push(<span key="p">前回 {relativeDayJa(f.pv)}</span>);

  return (
    <div className="feed-rec">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? ' · ' : ''}
          {p}
        </span>
      ))}
      {f.note ? <span style={{ color: 'var(--gold)' }}> · 📝{f.note}</span> : null}
    </div>
  );
}

function FeedRow({
  item: f,
  showAvatars,
  showRecord,
}: {
  item: FeedItem;
  showAvatars: boolean;
  showRecord: boolean;
}) {
  const rec = showRecord ? <Record f={f} /> : null;
  if (f.k === 'c') {
    // 初見 / VIP / 質問 share this lane with everything else and are told apart by
    // colour, so there is only one place to look.
    const cls =
      f.tri === 'question'
        ? 'tri-q'
        : f.tri === 'first'
          ? 'tri-first'
          : f.tri === 'vip' || f.vt >= 2
            ? 'tri-vip'
            : f.vt === 1
              ? 'tri-regular'
              : '';
    const tag =
      f.tri === 'question' ? (
        <span className="tag q">質問</span>
      ) : f.tri === 'first' ? (
        <span className="tag first">初見</span>
      ) : f.tri === 'vip' || f.vt >= 2 ? (
        <span className="tag vip">VIP</span>
      ) : null;
    return (
      <div className={`feed-item ${cls}`}>
        <Avatar url={f.a} name={f.n} size={18} enabled={showAvatars} />
        <div className="txt">
          <div>
            {tag} <span className="who">{f.n}</span>
            {f.kana ? <span className="kana">（{f.kana}）</span> : null}{' '}
            <MemoButton viewer={{ userId: f.u, nickname: f.n, note: f.note, readingKana: f.kana }} /> {f.txt}
          </div>
          {rec}
        </div>
      </div>
    );
  }
  if (f.k === 'g') {
    return (
      <div className={`feed-item gift${f.dia >= 100 ? ' big' : ''}`}>
        <Avatar url={f.a} name={f.n} size={18} enabled={showAvatars} />
        <div className="txt">
          <div>
            <span className="who" style={{ color: 'var(--gold)' }}>
              {f.n}
            </span>
            {f.kana ? <span className="kana">（{f.kana}）</span> : null}{' '}
            <MemoButton viewer={{ userId: f.u, nickname: f.n, note: f.note, readingKana: f.kana }} /> が{' '}
            <span style={{ color: 'var(--gold)' }}>{f.gift}</span>
            {f.cnt > 1 ? ` ×${f.cnt}` : ''}
            <span className="faint"> （{num(f.dia)}💎）</span>
          </div>
          {rec}
        </div>
      </div>
    );
  }
  if (f.k === 'j') {
    return (
      <div className="feed-item join">
        <div className="txt">
          <div>
            {f.n} が入室{f.first ? <span className="badge first"> 初見</span> : ''}
          </div>
          {rec}
        </div>
      </div>
    );
  }
  return (
    <div className="feed-item social">
      <div className="txt">
        <div>
          {f.n} が{f.sub === 'follow' ? 'フォロー' : f.sub === 'share' ? 'シェア' : 'サブスク'}しました
        </div>
        {rec}
      </div>
    </div>
  );
}
