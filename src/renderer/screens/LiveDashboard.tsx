import { useEffect, useMemo, useRef, useState } from 'react';
import type { ChallengeLogEntry, ViewerFilter, ViewerTableRow } from '@shared/dto';
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
          {/* 進行中は sticky でここに貼り付く(challenge-card.stuck)。入室アラートは
              最大12枚積まれるので、下に置くと配信が盛り上がるほど見えなくなる。 */}
          <ChallengeCard />

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

/** 履歴ログの行頭アイコン。ギフトだけは実アイコン画像に差し替わる。 */
const LOG_ICON: Record<ChallengeLogEntry['kind'], string> = {
  press: '🔘',
  follow: '👤',
  like: '💗',
  'stock-full': '💚',
  gift: '🎁',
  roulette: '🎰',
  achieved: '🏁',
};

function hms(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** running の間だけ1秒ごとに再描画する(経過時間の表示用)。 */
function useNowTick(active: boolean): void {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
}

/** ログ行の「何をされたか」。名前と増減量は行の上段が持つので、ここは中身だけ。 */
function logWhat(e: ChallengeLogEntry): string {
  switch (e.kind) {
    case 'press':
      return `ボタン ${num(e.count ?? 1)}回`;
    case 'follow':
      return 'フォロー(妨害)';
    case 'like': {
      if (!e.likeEvery) return 'いいね(妨害)';
      // amount は step の倍数。何回ぶん満タンになったかを件数に戻して見せる。
      const units = e.likeStep && e.likeStep > 0 ? Math.max(1, Math.round(e.amount / e.likeStep)) : 1;
      return `いいね ${num(units * e.likeEvery)}件到達`;
    }
    case 'stock-full':
      return 'いいねストック満杯(妨害)';
    case 'gift': {
      const name = e.giftName ?? 'ギフト';
      const cnt = e.giftCount && e.giftCount > 1 ? ` ×${num(e.giftCount)}` : '';
      const dia = e.diamonds ? ` 💎${num(e.diamonds)}` : '';
      return `${name}${cnt}${dia}`;
    }
    case 'roulette': {
      const name = e.giftName ? `(${e.giftName})` : '';
      return `ルーレット 出目${e.amount > 0 ? '+' : ''}${num(e.amount)}${name}`;
    }
    case 'achieved':
      return 'カウント 0 に到達';
  }
}

/** ギフトはアイコン画像、それ以外は絵文字。読み込み失敗は絵文字へ落とす。 */
function LogIcon({ e }: { e: ChallengeLogEntry }): React.JSX.Element {
  const [failed, setFailed] = useState(false);
  if ((e.kind === 'gift' || e.kind === 'roulette') && e.giftIconUrl && !failed) {
    return (
      <img
        className="clog-ico img"
        src={e.giftIconUrl}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailed(true)}
      />
    );
  }
  return (
    <span className="clog-ico" aria-hidden>
      {LOG_ICON[e.kind]}
    </span>
  );
}

function ChallengeLogRow({ e }: { e: ChallengeLogEntry }): React.JSX.Element {
  // 符号の規約は effect と同じ: 正=増える=妨害(赤) / 負=減る=前進(緑)。
  const dir = e.amount > 0 ? 'up' : e.amount < 0 ? 'down' : 'flat';
  const who =
    e.kind === 'press'
      ? 'PUSH'
      : e.kind === 'like'
        ? 'いいね'
        : e.kind === 'stock-full'
          ? 'ストック'
          : e.kind === 'achieved'
            ? '達成!'
            : (e.nickname ?? '—');
  return (
    <div className={`clog ${dir}${e.kind === 'achieved' ? ' clear' : ''}`}>
      <div className="clog-top">
        <span className="clog-time num">{hms(e.atMs)}</span>
        <LogIcon e={e} />
        <span className="clog-who">{who}</span>
        <span className="clog-amt num">
          {e.kind === 'achieved' ? '' : e.amount > 0 ? `+${num(e.amount)}` : num(e.amount)}
        </span>
      </div>
      <div className="clog-sub">
        <span className="clog-what">{logWhat(e)}</span>
        <span className="clog-after num">→ {num(e.valueAfter)}</span>
      </div>
    </div>
  );
}

let punchSeq = 0;

/**
 * カウントダウンチャレンジの操作カード。
 *
 * 配信者が「いま何が起きて残数がどう動いたか」を追える唯一の窓。モニター窓は
 * 視聴者向けに派手な演出を出すが、こちらは逆に**文字で残す**のが役目 —
 * 演出は流れて消えるが、企画中に目を離した数十秒を埋められるのはログだけ。
 *
 * 数字の即時性が命: ボタンは rpc の戻り値で自分の画面を即更新し、worker の
 * nudge delta が同時にモニター窓を更新する。両方受けても状態全量なので冪等。
 */
function ChallengeCard(): React.JSX.Element | null {
  const challenge = useLive((s) => s.challenge);
  const log = useLive((s) => s.challengeLog);
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
    volumes: settings?.challenge.seVolumes,
  });

  // 値が動いたら1回だけ跳ねさせる(モニターの punch と同型)。punch は**消さない** —
  // null に戻すと key が変わって数字が再マウントされ、差分バブルが消えるたびに
  // アニメが再生されてしまう。バブル側は最後に opacity:0 で止まる。
  const prevValue = useRef<number | null>(null);
  const [punch, setPunch] = useState<{ key: number; diff: number } | null>(null);
  useEffect(() => {
    const v = challenge?.value;
    if (v == null) return;
    const was = prevValue.current;
    prevValue.current = v;
    if (was === null || was === v) return;
    setPunch({ key: ++punchSeq, diff: v - was });
  }, [challenge?.value]);

  // ホットキー(F9)・物理USBボタン・モニター窓の Space から押されたときも
  // PUSH ボタンを光らせる。press effect ではなく stats.presses を見る —
  // 経路を問わず必ず増えるうえ、リングバッファから押し出されても取りこぼさない。
  const prevPresses = useRef<number | null>(null);
  const [hit, setHit] = useState(0);
  useEffect(() => {
    const p = challenge?.stats.presses;
    if (p == null) return;
    const was = prevPresses.current;
    prevPresses.current = p;
    if (was === null || p <= was) return;
    setHit((k) => k + 1);
  }, [challenge?.stats.presses]);

  const st = challenge?.status ?? 'idle';
  const running = st === 'running';
  const achieved = st === 'achieved';
  useNowTick(running);
  // 新着ログは上に積まれる。ユーザーが遡っている間は追従しない。
  const logRef = useStickyTop(log[0]?.id);

  if (!enabled || !settings) return null;

  const value = challenge?.value ?? settings.challenge.initialValue;
  const initial = challenge?.initialValue ?? settings.challenge.initialValue;
  const done = Math.max(0, initial - value);
  const lowThreshold = settings.challenge.lowThreshold;
  const low = running && lowThreshold > 0 && value <= lowThreshold;
  const elapsedMs =
    challenge?.startedMs != null ? (challenge.achievedMs ?? Date.now()) - challenge.startedMs : null;
  const call = (m: 'challenge.start' | 'challenge.stop' | 'challenge.reset' | 'challenge.press') =>
    void rpc(m, undefined).then(setChallenge);

  return (
    <div className={`card challenge-card${running || achieved ? ' stuck' : ''}${achieved ? ' cleared' : ''}`}>
      <div className="ch-head">
        <strong>{challenge?.title ?? settings.challenge.title}</strong>
        {running ? (
          <span className="badge t1">進行中</span>
        ) : achieved ? (
          <span className="badge t3">達成!</span>
        ) : (
          <span className="badge">{challenge?.startedMs ? '一時停止中' : '停止中'}</span>
        )}
        <div className="spacer" />
        {elapsedMs != null ? (
          <span className="faint num" title={achieved ? '達成までにかかった時間' : '開始からの経過'}>
            {formatDurationJa(elapsedMs)}
          </span>
        ) : null}
      </div>

      {/* 進行中なのにモニターが閉じている = 背面モニターに演出が何も出ていない。
          気づかないまま企画が進むと配信事故になるので目立たせる。 */}
      {running && !monitorOpen ? (
        <button className="ch-warn" onClick={() => void rpc('monitor.open', undefined)}>
          モニター未表示 — 演出が出ていません（クリックで開く）
        </button>
      ) : null}

      <div className="ch-value-wrap">
        <div
          key={punch?.key ?? 0}
          className={`challenge-value${achieved ? ' done' : ''}${low ? ' low' : ''}${
            punch ? (punch.diff > 0 ? ' up' : ' down') : ''
          }`}
        >
          {num(value)}
        </div>
        {punch ? (
          <span key={punch.key} className={`ch-delta ${punch.diff > 0 ? 'up' : 'down'}`}>
            {punch.diff > 0 ? `▲+${num(punch.diff)}` : `▼${num(punch.diff)}`}
          </span>
        ) : null}
      </div>

      {/* 初期値→0 の進捗。妨害で初期値を超えることがあるので必ず 0 で下限を切る。 */}
      <div className="ch-prog">
        <Bar value={done} target={initial} done={achieved} />
        <div className="ch-prog-lbl">
          <span>
            進捗 {num(done)} / {num(initial)}
          </span>
          <span className="faint num">
            {initial > 0 ? `${Math.min(100, Math.round((done / initial) * 100))}%` : ''}
          </span>
        </div>
      </div>

      {/* 履歴。worker のリングバッファは12件で消えるので、renderer 側に積み直した
          challengeLog(最大50件)を出す。ここだけが「後から辿れる」唯一の場所。 */}
      {log.length > 0 ? (
        <div className="ch-log" ref={logRef}>
          {log.map((e) => (
            <ChallengeLogRow key={e.id} e={e} />
          ))}
        </div>
      ) : running ? (
        <div className="ch-log empty">まだ動きがありません</div>
      ) : null}

      <button
        className="challenge-btn"
        disabled={!running}
        onClick={() => call('challenge.press')}
        title={settings.challenge.hotkey ? `ホットキー: ${settings.challenge.hotkey}` : undefined}
      >
        PUSH
        <span className="sub">−{num(settings.challenge.pressStep)}</span>
        {/* ホットキー等こちらのクリック以外で押されたときの手応え。key で毎回再生。 */}
        {hit > 0 ? <i className="hit" key={hit} /> : null}
      </button>

      <div className="row wrap" style={{ marginTop: 8 }}>
        {running ? (
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

      {challenge?.likeGauge ? (
        <div className="challenge-like-mini" title="いいね進捗(満タンで加算)">
          <i
            style={{
              width: `${Math.min(100, (challenge.likeGauge.counter / Math.max(1, challenge.likeGauge.every)) * 100)}%`,
            }}
          />
          <span>
            ♥ {num(challenge.likeGauge.counter)}/{num(challenge.likeGauge.every)} → +
            {num(challenge.likeGauge.step)}
            {challenge.likeGauge.fills > 0 ? `（満タン ${num(challenge.likeGauge.fills)}回）` : ''}
            {challenge.likeGauge.stock
              ? ` ${'●'.repeat(challenge.likeGauge.stock.filled)}${'○'.repeat(Math.max(0, challenge.likeGauge.stock.count - challenge.likeGauge.stock.filled))} 満杯で+${num(challenge.likeGauge.stock.step)}`
              : ''}
          </span>
        </div>
      ) : null}

      {challenge ? (
        <div className="ch-stats">
          <span className="cs">
            <b>{num(challenge.stats.presses)}</b> PUSH
          </span>
          <span className="cs up">
            <b>{num(challenge.stats.follows)}</b> フォロー
          </span>
          {challenge.stats.likeUp > 0 ? (
            <span className="cs up">
              💗 <b>+{num(challenge.stats.likeUp)}</b>
            </span>
          ) : null}
          {challenge.stats.likeStockUp > 0 ? (
            <span className="cs up">
              💚 <b>+{num(challenge.stats.likeStockUp)}</b>
            </span>
          ) : null}
          {challenge.stats.giftUp > 0 ? (
            <span className="cs up">
              🎁 <b>+{num(challenge.stats.giftUp)}</b>
            </span>
          ) : null}
          {challenge.stats.giftDown > 0 ? (
            <span className="cs down">
              🎁 <b>−{num(challenge.stats.giftDown)}</b>
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="faint" style={{ fontSize: 11, marginTop: 6 }}>
        フォローで +{num(settings.challenge.followStep)}(妨害)
        {settings.challenge.likeEvery > 0
          ? ` ・ いいね${num(settings.challenge.likeEvery)}件で +${num(settings.challenge.likeStep)}`
          : ''}
        {settings.challenge.hotkey ? ` ・ ホットキー ${settings.challenge.hotkey}` : ''}
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
