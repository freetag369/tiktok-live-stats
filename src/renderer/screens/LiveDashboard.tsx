import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ChallengeLogEntry, ViewerFilter, ViewerTableRow } from '@shared/dto';
import type { FeedItem } from '@shared/ipc';
import { CFG_POLL_MS, VIEWER_PAGE_SIZE } from '@shared/constants';
import { DEFAULT_DASH_LAYOUT, dashTemplate, moveDashPane, normalizeDashLayout, type DashPaneKey } from '@shared/dash-layout';
import { compact, diamondsToJpy, num } from '@shared/format';
import { formatDurationJa, relativeDayJa } from '@shared/time';
import { rpc, rpcFire, useQuery, useDebounced } from '../ipc/client';
import { dismissAlert, liveRow, setChallenge, useLive } from '../state/liveStore';
import { openViewer, setSettings, setSort, toast, useUi } from '../state/uiStore';
import { Avatar, Bar, Observed, TierBadge, useStickyTop } from '../components/common';
import { MemoButton } from '../components/Memo';
import type { ConfirmOptions } from '../components/ConfirmDialog';
import { useConfirm } from '../components/ConfirmDialog';
import { ObservedLegend, ViewerTable } from '../components/ViewerTable';
import { useChallengeSe } from '../lib/useChallengeSe';

/** data 未着時に毎レンダー新しい [] を作らないための安定参照。 */
const EMPTY_ROWS: ViewerTableRow[] = [];

const FILTERS: Array<{ k: ViewerFilter; label: string }> = [
  { k: 'all', label: 'すべて' },
  { k: 'present', label: '今いる人' },
  { k: 'firstTime', label: '初見' },
  { k: 'regular', label: '常連以上' },
  { k: 'vip', label: 'VIP' },
  { k: 'gifter', label: 'ギフター' },
];

/** ヘッダー内の操作系。ここを掴んだときは並び替えではなく本来の操作をさせる。 */
const HEADER_CONTROLS = 'input, select, button, textarea, a, [contenteditable]';

/**
 * ダッシュボード3カラムの並び替え。
 *
 * DOM の記述順は動かさず CSS order だけを差し替える — 視聴者テーブルの仮想化と
 * コメントの追従スクロールは、ノードが DOM 上を移動すると位置を失うため。
 * 幅は位置ではなくパネルに紐づく(DASH_TRACK)ので、サマリーをどこへ動かしても 310px。
 */
function useDashLayout() {
  const settings = useUi((s) => s.settings);
  const [order, setOrder] = useState<DashPaneKey[]>(() => [...DEFAULT_DASH_LAYOUT]);
  const [dragKey, setDragKey] = useState<DashPaneKey | null>(null);
  const [overKey, setOverKey] = useState<DashPaneKey | null>(null);
  const applied = useRef(false);

  // 保存済みの並びは設定が最初に届いた一度だけ当てる(ZoomControls と同じ形)。
  // 自分の保存が settings プッシュで返ってきても、ドラッグ直後の表示を上書きしない。
  useEffect(() => {
    if (!settings || applied.current) return;
    applied.current = true;
    setOrder(normalizeDashLayout(settings.dashLayout));
  }, [settings]);

  const drop = useCallback(
    (from: DashPaneKey, to: DashPaneKey) => {
      setDragKey(null);
      setOverKey(null);
      const next = moveDashPane(order, from, to);
      // 動いていないなら書かない — moveDashPane は同じ並びなら元の配列を返す。
      if (next === order) return;
      setOrder(next);
      void rpc('cfg.set', { dashLayout: next }).catch(() => undefined);
    },
    [order]
  );

  /** <section className="pane"> に展開する props。 */
  const pane = (key: DashPaneKey) => {
    const slot = order.indexOf(key);
    const cls = ['pane'];
    if (dragKey === key) cls.push('dragging');
    if (overKey === key && dragKey !== key) cls.push('drop-over');
    return {
      className: cls.join(' '),
      style: { order: slot } as React.CSSProperties,
      // 狭い幅で「3枚目を下段全幅」にする CSS は、DOM 順ではなく見た目の位置で引く。
      'data-slot': slot + 1,
      onDragOver: (e: React.DragEvent<HTMLElement>) => {
        // 掴んでいるのが自分のパネルでないなら受けない(外部からのファイル等)。
        if (!dragKey) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (overKey !== key) setOverKey(key);
      },
      onDragLeave: (e: React.DragEvent<HTMLElement>) => {
        // 子要素へ移っただけの dragleave でハイライトを消さない。
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOverKey((k) => (k === key ? null : k));
      },
      onDrop: (e: React.DragEvent<HTMLElement>) => {
        e.preventDefault();
        const from = dragKey ?? (e.dataTransfer.getData('text/plain') as DashPaneKey);
        if (from) drop(from, key);
      },
    };
  };

  /** 見出し帯(掴む場所)に展開する props。 */
  const grab = (key: DashPaneKey) => ({
    // draggable は掴んだ瞬間に決める。常時 true だと検索欄の文字を選択できなくなる。
    // pointerdown → mousedown → dragstart の順なので、ここで間に合う。
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => {
      const t = e.target as Element | null;
      e.currentTarget.draggable = !(t instanceof Element && t.closest(HEADER_CONTROLS));
    },
    onDragStart: (e: React.DragEvent<HTMLElement>) => {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', key);
      // ドラッグ中の影は既定のまま見出し帯そのもの — パネル全体だと画面を覆ってしまう。
      // 何が動くかは元パネルの半透明(.dragging)と行き先の点線(.drop-over)で示す。
      setDragKey(key);
    },
    onDragEnd: (e: React.DragEvent<HTMLElement>) => {
      e.currentTarget.draggable = false;
      setDragKey(null);
      setOverKey(null);
    },
  });

  return { order, pane, grab };
}

/** 掴めることを示すだけの飾り。 */
function Grip(): React.JSX.Element {
  return (
    <span className="pane-grip" aria-hidden="true" title="見出しをドラッグすると配置を入れ替えられます">
      ⠿
    </span>
  );
}

export function LiveDashboard(): React.JSX.Element {
  const sessionId = useLive((s) => s.sessionId);
  const totals = useLive((s) => s.totals);
  const feed = useLive((s) => s.feed);
  const alerts = useLive((s) => s.alerts);
  const missions = useLive((s) => s.missions);
  const droppedFeed = useLive((s) => s.droppedFeed);
  const version = useLive((s) => s.version);
  const { sort, desc, filter, search, settings, showJoins, showRecord, memoNonce } = useUi();
  const debouncedSearch = useDebounced(search, 250);
  const visibleFeed = useMemo(() => (showJoins ? feed : feed.filter((f) => f.k !== 'j')), [feed, showJoins]);
  // Keeps the newest comment in view unless the user has deliberately scrolled back.
  const feedRef = useStickyTop(visibleFeed[0]?.id);

  // The database is the source of truth. Live deltas fill the gap between
  // refreshes so the numbers never appear to go backwards mid-stream.
  //
  // リフレッシュは壁時計8秒 — version 連動(≈2秒)だと、全期間 viewer テーブルを
  // 走査するこのクエリが取り込みと同じワーカースレッドを DB サイズ比例で食い続ける。
  // 8秒の空白は下の liveRow マージが埋めるので見た目は変わらない。
  // ユーザー操作(ソート・絞り込み・検索・メモ)は deps に残るため即時反映。
  const [dbTick, setDbTick] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setDbTick((t) => t + 1), 8000);
    return () => window.clearInterval(id);
  }, []);
  const { data } = useQuery(
    'q.viewerTable',
    { sessionId, sort, desc, filter, search: debouncedSearch, limit: VIEWER_PAGE_SIZE },
    [sessionId, sort, desc, filter, debouncedSearch, memoNonce, dbTick]
  );

  // live 値のマージは ViewerTable の仮想化行(見えている ~30 行)の描画内で行う。
  // 以前はここで version(rAF レート)ごとに最大 5000 行を再マップしていた。
  const rows = data?.rows ?? EMPTY_ROWS;

  const jpy = settings?.diamondToJpy ?? 0.5;
  const dash = useDashLayout();

  return (
    <div className="dash" style={{ '--dash-cols': dashTemplate(dash.order) } as React.CSSProperties}>
      {/* ── comments (leftmost: the surface watched most during a stream) ── */}
      <section {...dash.pane('comments')}>
        <header {...dash.grab('comments')}>
          <Grip />
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
              liveTick={showRecord ? Math.floor(version / 6) : 0}
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
      <section {...dash.pane('viewers')}>
        <header {...dash.grab('viewers')}>
          <Grip />
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
          liveTick={version}
        />
        <footer style={{ padding: '5px 10px', borderTop: '1px solid var(--line)' }}>
          <ObservedLegend />
        </footer>
      </section>

      {/* ── alerts + totals + missions ──────────────────────────────────── */}
      <section {...dash.pane('summary')}>
        <header {...dash.grab('summary')}>
          <Grip />
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
  // 実演専用 kind(test 付きなのでログには積まれない)— 型の網羅性のためだけの行。
  'gauge-full': '💗',
  'stock-full': '💚',
  comment: '💬',
  gift: '🎁',
  roulette: '🎰',
  'boost-start': '⚡',
  'boost-end': '⚡',
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

/**
 * ログ行の「何をされたか」。名前と増減量は行の上段が持つので、ここは中身だけ。
 *
 * maskRoulette=true ならルーレットの出目を落とす(cfg.hideRouletteResultInLog)。
 */
function logWhat(e: ChallengeLogEntry, maskRoulette: boolean): string {
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
    // 実演専用 kind(test 付きなのでログには積まれない)— 型の網羅性のためだけの行。
    case 'gauge-full':
      return 'いいねゲージ満タン(妨害)';
    case 'stock-full':
      return 'いいねストック満杯(妨害)';
    case 'comment':
      return e.commentKeyword ? `コメント「${e.commentKeyword}」(妨害)` : 'コメント(妨害)';
    case 'gift': {
      const name = e.giftName ?? 'ギフト';
      const cnt = e.giftCount && e.giftCount > 1 ? ` ×${num(e.giftCount)}` : '';
      const dia = e.diamonds ? ` 💎${num(e.diamonds)}` : '';
      return `${name}${cnt}${dia}`;
    }
    case 'roulette': {
      // ルーレットは複数登録できるので、どれが回ったかを設定の表示名で示す。
      // 表示名が空の行は従来どおり実ギフト名で照合できるようにする。
      const label = e.rouletteLabel || e.giftName;
      const name = label ? `(${label})` : '';
      // 伏せるときは「どのルーレットが回ったか」だけ残す — 回った事実まで
      // 消すと、リールが止まったあとにログを辿れなくなる。
      if (maskRoulette) return `ルーレット${name}`;
      return `ルーレット 出目${e.amount > 0 ? '+' : ''}${num(e.amount)}${name}`;
    }
    case 'boost-start': {
      const gift = e.giftName ? `(${e.giftName})` : '';
      return `タップブースト発動 ×${num(e.boostMultiplier ?? 1)}${gift}`;
    }
    case 'boost-end':
      return `ブースト終了 タップ×${num(e.boostTapCount ?? 0)}`;
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

function ChallengeLogRow({
  e,
  maskRoulette,
}: {
  e: ChallengeLogEntry;
  maskRoulette: boolean;
}): React.JSX.Element {
  // 符号の規約は effect と同じ: 正=増える=妨害(赤) / 負=減る=前進(緑)。
  const dir = e.amount > 0 ? 'up' : e.amount < 0 ? 'down' : 'flat';
  // ルーレットの結果を伏せる行。符号(と赤緑)は残す — 増減の向きは
  // ルーレットごとの direction 設定で固定なので、符号からは何も漏れない。
  const masked = maskRoulette && e.kind === 'roulette';
  const who =
    e.kind === 'press'
      ? 'PUSH'
      : e.kind === 'like'
        ? 'いいね'
        : e.kind === 'stock-full'
          ? 'ストック'
          : e.kind === 'boost-end'
            ? 'フィーバー'
            : e.kind === 'achieved'
              ? '達成!'
              : (e.nickname ?? '—');
  return (
    <div
      className={`clog ${dir}${e.kind === 'achieved' ? ' clear' : ''}`}
      // 「?」が何なのか説明が無いと不具合に見える。
      title={masked ? 'ルーレットの結果は設定で伏せています(チャレンジ設定 → ギフトルーレット)' : undefined}
    >
      <div className="clog-top">
        <span className="clog-time num">{hms(e.atMs)}</span>
        <LogIcon e={e} />
        <span className="clog-who">{who}</span>
        <span className="clog-amt num">
          {e.kind === 'achieved'
            ? ''
            : masked
              ? e.amount > 0
                ? '+?'
                : e.amount < 0
                  ? '-?'
                  : '?'
              : e.amount > 0
                ? `+${num(e.amount)}`
                : num(e.amount)}
        </span>
      </div>
      <div className="clog-sub">
        <span className="clog-what">{logWhat(e, maskRoulette)}</span>
        <span className="clog-after num">→ {masked ? '?????' : num(e.valueAfter)}</span>
      </div>
    </div>
  );
}

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
  // モニター再起動の連打よけ。窓の作り直しは close→350ms→open なので、その間は押させない。
  const [restarting, setRestarting] = useState(false);
  const restartTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const enabled = settings?.challenge.enabled ?? false;

  // workerState を依存に入れ、worker 再起動(クラッシュ自動復帰・設定変更)で
  // 'ready' へ戻るたびに取り直す。challenge は worker のメモリのみで、再起動で
  // idle に戻っても delta は来ない — 取り直さないと「running 表示のまま押しても
  // 無反応」「idle のまま PUSH が灰色固着」の両方が起きる。
  const workerState = useLive((s) => s.workerState);
  useEffect(() => {
    if (!enabled) return;
    const refetch = (): void => {
      void rpc('challenge.get', undefined).then(setChallenge).catch(() => undefined); // delta 経由で回復する
    };
    refetch();
    void rpc('monitor.status', undefined)
      .then((r) => setMonitorOpen(r.open))
      .catch(() => undefined); // onMonitorState 購読で回復する
    // 保険ポーリング(MonitorView.tsx の CFG_POLL_MS と同じ)— イベント取りこぼし
    // からの自己回復。ルート切替の再マウントに頼らず、開きっぱなしでも揃う。
    const t = setInterval(refetch, CFG_POLL_MS);
    const off = window.api.onMonitorState((s) => setMonitorOpen(s.open));
    return () => {
      clearInterval(t);
      off();
    };
  }, [enabled, workerState]);

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

  // ホットキー(F9)・物理USBボタン・モニター窓の Space から押されたときも
  // PUSH ボタンを光らせる。press effect ではなく stats.presses を見る —
  // 経路を問わず必ず増えるうえ、リングバッファから押し出されても取りこぼさない。
  const prevPresses = useRef<number | null>(null);
  const [hit, setHit] = useState(0);

  // 企画が飛ぶ操作(リセット/開始し直し)と配信中の一時停止は一度確認する。
  const [confirmNode, confirm] = useConfirm();

  // 起床時刻(何時起き)。入力中は自分の draft を出す — cfg.set → cfg.get の往復で
  // カーソル下の値が巻き戻らないようにするため。
  const [wakeDraft, setWakeDraft] = useState<string | null>(null);
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (wakeTimer.current) clearTimeout(wakeTimer.current);
      if (restartTimer.current) clearTimeout(restartTimer.current);
    },
    [],
  );

  /**
   * challenge は cfg.set で**丸ごと**置き換わる(main の浅いマージはトップレベルの
   * キーまで)。かつ、この窓の store は設定のプッシュを購読していない(購読して
   * いるのはモニター窓だけ)ので古いことがある。よって送る直前に cfg.get で全量を
   * 取り直し、wakeTime だけ差し替える read-modify-write にする。
   */
  const commitWake = useCallback(async (v: string): Promise<void> => {
    try {
      const cur = await rpc('cfg.get', undefined);
      await rpc('cfg.set', { challenge: { ...cur.challenge, wakeTime: v === '' ? null : v } });
      setSettings(await rpc('cfg.get', undefined));
    } catch (e) {
      toast({ level: 'error', msgJa: (e as Error).message });
    } finally {
      setWakeDraft(null);
    }
  }, []);
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
  const elapsedMs =
    challenge?.startedMs != null ? (challenge.achievedMs ?? Date.now()) - challenge.startedMs : null;
  // PUSH/開始/停止が無言で失敗すると配信事故になる — 必ずトーストへ落とす。
  const call = (
    m: 'challenge.start' | 'challenge.stop' | 'challenge.reset' | 'challenge.press' | 'challenge.toggleRank'
  ) =>
    void rpc(m, undefined)
      .then(setChallenge)
      .catch((e: Error) => toast({ level: 'error', msgJa: `チャレンジ操作に失敗しました: ${e.message}` }));
  // 押し間違いは配信中だと取り返しがつかない(値も統計もログも戻せない)。
  const callConfirmed = (m: 'challenge.start' | 'challenge.stop' | 'challenge.reset', o: ConfirmOptions) =>
    void confirm(o).then((ok) => {
      if (ok) call(m);
    });
  // 一度でも開始していれば途中の値と統計がある。reset だけが startedMs を消すので、
  // これがそのまま「失うものがあるか」の判定になる(バッジの一時停止中と同じ条件)。
  const hasRun = challenge?.startedMs != null;
  // モニターに全画面ランキングが出ているか。worker は表示中だけ rankBoard を
  // 載せるので、キーの有無がそのまま表示状態になる(別途フラグを持たない)。
  const rankShown = challenge?.rankBoard != null;

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
        <button className="ch-warn" onClick={() => rpcFire('monitor.open', undefined, 'モニターを開く')}>
          モニター未表示 — 演出が出ていません（クリックで開く）
        </button>
      ) : null}

      {/* 残数はこの1要素だけ・key は固定。以前は値が動くたびに key を付け替えて
          再マウントし拡大アニメを流していたが、transform で合成レイヤーに昇格した
          古いノードの描画が sticky なカードの中に残り、数字が縦に積み上がって
          見える不具合が出た。ここはその場で書き換えるだけにして、動き・色変化・
          差分バブル(▲+1)は持たせない。何が起きたかはログ欄が受け持つ。 */}
      <div className={`challenge-value${achieved ? ' done' : ''}`}>{num(value)}</div>

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
          {/* マスクは描画時に読む(ログ行へ焼き込まない)— like 行の likeEvery とは
              逆の判断。伏せるかどうかはイベントの性質ではなく表示の好みで、
              企画のあとにスイッチを切って答え合わせできるほうが目的に合う。 */}
          {log.map((e) => (
            <ChallengeLogRow key={e.id} e={e} maskRoulette={settings.challenge.hideRouletteResultInLog} />
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
        {/* 何時起き。入力途中や不正値では DOM の value が必ず '' になるので、
            '' は自動保存しない(クリアの確定は onBlur だけが行う)。 */}
        {settings.challenge.wakeEnabled ? (
          <label
            className="row"
            style={{ gap: 6 }}
            title="起きた時刻。モニターの左下に「起床 5:30 / 18時間42分」と出ます"
          >
            <span className="faint">起床</span>
            <input
              type="time"
              value={wakeDraft ?? settings.challenge.wakeTime ?? ''}
              onChange={(e) => {
                const v = e.target.value;
                setWakeDraft(v);
                if (wakeTimer.current) clearTimeout(wakeTimer.current);
                if (v === '') return;
                wakeTimer.current = setTimeout(() => void commitWake(v), 600);
              }}
              onBlur={() => {
                if (wakeTimer.current) clearTimeout(wakeTimer.current);
                if (wakeDraft === null) return;
                if (wakeDraft === (settings.challenge.wakeTime ?? '')) {
                  setWakeDraft(null);
                  return;
                }
                void commitWake(wakeDraft);
              }}
            />
          </label>
        ) : null}
        {running ? (
          <button
            className="btn small"
            onClick={() =>
              callConfirmed('challenge.stop', {
                title: 'カウントダウンを一時停止しますか？',
                message: `残り ${num(value)} は保持されます。止まっている間は PUSH もフォロー・ギフト・いいねも数字に反映されません。`,
                confirmLabel: '一時停止する',
              })
            }
          >
            一時停止
          </button>
        ) : (
          <button
            className="btn small primary"
            onClick={() =>
              hasRun
                ? callConfirmed('challenge.start', {
                    title: '最初から始め直しますか？',
                    message: `いまの残り ${num(value)} と進捗・統計は引き継がれません。初期値 ${num(initial)} から新しく始めます。`,
                    detail: '一時停止の続きから再開する方法はありません。',
                    confirmLabel: '最初から始める',
                    danger: true,
                  })
                : call('challenge.start')
            }
          >
            開始
          </button>
        )}
        <button
          className="btn small"
          onClick={() =>
            callConfirmed('challenge.reset', {
              title: 'カウントダウンをリセットしますか？',
              message: `残り ${num(value)} と、これまでの進捗・統計・ログがすべて消えて初期値 ${num(initial)} に戻ります。`,
              detail: '元に戻せません。',
              confirmLabel: 'リセットする',
              danger: true,
            })
          }
        >
          リセット
        </button>
        {/* モニターの全画面ランキングのトグル。表示中かどうかは worker が権威で、
            challenge.rankBoard の有無がそのまま表す(ホットキーや他の窓から
            切り替わってもこの文言が追従する)。値・統計には触らないので確認は不要。
            モニターが閉じていると出しても誰にも見えないので、その場合だけ注意書き。 */}
        <button
          className={`btn small${rankShown ? ' primary' : ''}`}
          onClick={() => call('challenge.toggleRank')}
          title={
            monitorOpen
              ? 'モニターにギフト/イイネ TOP5 を全画面で出します'
              : 'モニターが閉じています — 先に「モニターを開く」を押してください'
          }
        >
          {rankShown ? 'ランキングを消す' : 'ランキング表示'}
        </button>
        <button
          className="btn small"
          onClick={() => rpcFire(monitorOpen ? 'monitor.close' : 'monitor.open', undefined, 'モニターの開閉')}
        >
          {monitorOpen ? 'モニターを閉じる' : 'モニターを開く'}
        </button>
        {/* 固まった・真っ黒になった・表示ディスプレイがずれた窓の復旧用。窓ごと作り直すが、
            残数も統計もログも worker が持っているのでそのまま出直す(失うものは無い)。
            よって確認ダイアログは挟まない — 復旧が遅れる方が事故になる。 */}
        <button
          className="btn small ok"
          disabled={restarting}
          onClick={() => {
            setRestarting(true);
            if (restartTimer.current) clearTimeout(restartTimer.current);
            restartTimer.current = setTimeout(() => setRestarting(false), 1200);
            rpcFire('monitor.restart', undefined, 'モニターの再起動');
          }}
          title="モニター窓を閉じて開き直します。固まった・真っ黒になった・表示ディスプレイがずれたときに使ってください(残数や統計は消えません)"
        >
          {restarting ? '再起動中…' : 'モニター再起動'}
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
          {challenge.stats.commentUp > 0 ? (
            <span className="cs up">
              💬 <b>+{num(challenge.stats.commentUp)}</b>
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
        {settings.challenge.commentRules.length > 0 ? ' ・ 指定コメントで加算(妨害)' : ''}
        {settings.challenge.hotkey ? ` ・ ホットキー ${settings.challenge.hotkey}` : ''}
      </div>

      {confirmNode}
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

/**
 * memo 必須 — フィードは最大300行を 4〜6Hz で親が再レンダーする。アイテムは
 * 安定参照なので、memo で新着行だけの差分描画に落ちる。「記録」行は liveRow()
 * の生データを読むため、粗い liveTick(約1.5秒刻み)で意図的に memo を破る。
 */
const FeedRow = memo(function FeedRow({
  item: f,
  showAvatars,
  showRecord,
}: {
  item: FeedItem;
  showAvatars: boolean;
  showRecord: boolean;
  /** 値は未使用。showRecord 時に live 数字を追従させるための世代カウンタ。 */
  liveTick?: number;
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
});
