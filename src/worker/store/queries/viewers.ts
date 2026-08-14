import type { DatabaseSync } from 'node:sqlite';
import { VIEWER_PAGE_SIZE } from '@shared/constants';
import type { Page, RecallCard, ViewerDetail, ViewerTableQuery, ViewerTableRow } from '@shared/dto';
import type { UserId } from '@shared/events';
import { displayScore, medianIntervalDays } from '@shared/scoring';

/**
 * The dashboard query.
 *
 * `sessionId` is EXPLICIT. A view that defines 今回 as "the viewer's most recent
 * session" shows last week's numbers under 今回いいね for anyone who did not come
 * tonight — a silent, plausible-looking lie. Absent viewers must read zero.
 *
 * `session_id` is a monotonic AUTOINCREMENT key, so "the previous session this
 * viewer attended" is `MAX(session_id) < :sid` — no join to stream_session and no
 * window function on the read path.
 */
const VIEWER_COLS = `
    v.user_id, v.display_id, v.nickname, v.avatar_url, v.reading_kana, v.note,
    v.vip_tier, v.vip_source, v.is_moderator, v.is_subscriber,
    v.first_seen_ms, v.last_seen_ms,
    vl.visits, vl.likes AS likes_lifetime, vl.comments AS comments_lifetime,
    vl.diamonds AS diamonds_lifetime, vl.gifts AS gifts_lifetime,
    vl.heart_me AS heart_me_lifetime, vl.score_e, vl.consecutive_streak,
    COALESCE(cur.likes, 0)     AS likes_current,
    COALESCE(cur.comments, 0)  AS comments_current,
    COALESCE(cur.diamonds, 0)  AS diamonds_current,
    COALESCE(cur.heart_me, 0)  AS heart_me_current,
    COALESCE(cur.is_first_ever, 0) AS is_first_ever,
    CASE WHEN cur.user_id IS NULL THEN 0 ELSE 1 END AS present_now,
    COALESCE(prv.likes, 0)    AS likes_prev,
    COALESCE(prv.diamonds, 0) AS diamonds_prev,
    COALESCE(prv.heart_me, 0) AS heart_me_prev,
    prv.first_seen_ms         AS prev_visit_ms,
    (SELECT c.content FROM comment c
      WHERE c.user_id = v.user_id ORDER BY c.ts_ms DESC LIMIT 1) AS last_comment`;

/** viewer に続く join 群。駆動表を差し替えても中身は同じなので共有する。 */
const VIEWER_JOINS = `
  JOIN viewer_lifetime vl ON vl.user_id = v.user_id
  LEFT JOIN viewer_session_stat cur ON cur.user_id = v.user_id AND cur.session_id = :sid
  LEFT JOIN viewer_session_stat prv ON prv.user_id = v.user_id AND prv.session_id = (
    SELECT MAX(p.session_id) FROM viewer_session_stat p
     WHERE p.user_id = v.user_id AND p.session_id < :sid
  )`;

const VIEWER_SELECT = `
  SELECT ${VIEWER_COLS}
  FROM viewer v${VIEWER_JOINS}
  WHERE v.is_blocked = 0`;

const SORT_SQL: Record<string, string> = {
  lastSeen: 'v.last_seen_ms',
  visits: 'vl.visits',
  likesCurrent: 'likes_current',
  likesLifetime: 'vl.likes',
  diamondsCurrent: 'diamonds_current',
  diamondsLifetime: 'vl.diamonds',
  heartMeLifetime: 'vl.heart_me',
  commentsCurrent: 'comments_current',
  score: 'vl.score_e',
  nickname: 'v.nickname',
};

/**
 * 「今回」列は viewer_session_stat の実列そのものなので、**その配信の参加者だけ**を
 * index で拾って並べれば済む。汎用パスは viewer 全件(= 全期間の累積)を実体化して
 * からソートするため、DB が育つほど遅くなる唯一の残り箇所だった。
 * キーは ViewerSortKey、値は viewer_session_stat の列名。
 */
const SESSION_SORT_COL: Record<string, string> = {
  likesCurrent: 'likes',
  diamondsCurrent: 'diamonds',
  commentsCurrent: 'comments',
};

/**
 * 「累計」列は viewer_lifetime の実列。viewer と 1:1 なので、**viewer_lifetime を
 * 駆動表にすれば** migration 007 の複合索引 (col DESC, user_id ASC) の順に読んで
 * 必要な件数で打ち切れる。汎用パス(viewer 駆動)だと索引が順序付けに使われず、
 * viewer 全件を実体化してからソートするため DB が育つほど遅くなっていた。
 * キーは ViewerSortKey、値は viewer_lifetime の列名。
 */
const LIFETIME_SORT_COL: Record<string, string> = {
  diamondsLifetime: 'diamonds',
  likesLifetime: 'likes',
  heartMeLifetime: 'heart_me',
  visits: 'visits',
  score: 'score_e',
};

/** ゼロ群の ord を正群の後ろへずらすためのゲタ。件数上限(20000)より十分大きい。 */
const ORD_GAP = 1_000_000_000;

const FILTER_SQL: Record<string, string> = {
  all: '',
  firstTime: ' AND COALESCE(cur.is_first_ever, 0) = 1',
  vip: ' AND v.vip_tier >= 2',
  regular: ' AND v.vip_tier >= 1',
  gifter: ' AND vl.diamonds > 0',
  commenter: ' AND COALESCE(cur.comments, 0) > 0',
  present: ' AND cur.user_id IS NOT NULL',
};

function mapRow(r: Record<string, unknown>, halfLifeDays: number, now: number): ViewerTableRow {
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    userId: String(r.user_id),
    displayId: String(r.display_id ?? ''),
    nickname: String(r.nickname ?? ''),
    avatarUrl: (r.avatar_url as string) || null,
    readingKana: (r.reading_kana as string) || null,
    note: (r.note as string) || null,
    vipTier: n('vip_tier'),
    vipSource: String(r.vip_source ?? 'auto'),
    isModerator: n('is_moderator') === 1,
    isSubscriber: n('is_subscriber') === 1,
    visits: n('visits'),
    firstSeenMs: n('first_seen_ms'),
    lastSeenMs: n('last_seen_ms'),
    prevVisitMs: r.prev_visit_ms == null ? null : Number(r.prev_visit_ms),
    isFirstEver: n('is_first_ever') === 1,
    presentNow: n('present_now') === 1,
    likesCurrent: n('likes_current'),
    likesPrev: n('likes_prev'),
    likesLifetime: n('likes_lifetime'),
    commentsCurrent: n('comments_current'),
    commentsLifetime: n('comments_lifetime'),
    diamondsCurrent: n('diamonds_current'),
    diamondsPrev: n('diamonds_prev'),
    diamondsLifetime: n('diamonds_lifetime'),
    giftsLifetime: n('gifts_lifetime'),
    heartMeCurrent: n('heart_me_current'),
    heartMePrev: n('heart_me_prev'),
    heartMeLifetime: n('heart_me_lifetime'),
    score: displayScore(Number(r.score_e ?? 0), halfLifeDays, now),
    consecutiveStreak: n('consecutive_streak'),
    lastComment: (r.last_comment as string) || null,
  };
}

/**
 * 「今回」列ソートの行取得。**汎用パスと1行たりとも並びが変わってはいけない**
 * (回帰テスト: test/integration/viewer-sort-equivalence.spec.ts)。
 *
 * 汎用パスの並びは `ORDER BY COALESCE(cur.<col>,0) <dir>, v.user_id ASC`。
 * これを「値が正の群」と「0 の群」に割ると、
 *   - DESC: 正を値の降順 → そのあと 0 を user_id 昇順
 *   - ASC : 0 を user_id 昇順 → そのあと正を値の昇順
 * と**完全に等価**になる。0 群には「vss 行が無い人」と「vss 行はあるが 0 の人」の
 * 両方が入る点に注意(前者だけにすると後者が消える)。
 *
 * 正の群は viewer_session_stat を **cur という別名で駆動表にする** —
 * こうすると FILTER_SQL / 検索式(cur. や v. を参照する)をそのまま流用できる。
 */
function sessionDrivenRows(
  db: DatabaseSync,
  o: {
    vcol: string;
    dir: 'ASC' | 'DESC';
    filter: string;
    searchSql: string;
    params: Record<string, string | number>;
    limit: number;
    offset: number;
  }
): Array<Record<string, unknown>> {
  const { vcol, dir, filter, searchSql, limit, offset } = o;
  // offset ぶんは両群から余分に取っておかないと、結合後に足りなくなる。
  const take = Math.min(limit + offset, 20000);
  const posOrder = `cur.${vcol} ${dir}, cur.user_id ASC`;

  const positives = `
    SELECT cur.user_id AS uid, ROW_NUMBER() OVER (ORDER BY ${posOrder}) AS ord
      FROM viewer_session_stat cur
      JOIN viewer v ON v.user_id = cur.user_id
      JOIN viewer_lifetime vl ON vl.user_id = v.user_id
     WHERE cur.session_id = :sid AND cur.${vcol} > 0 AND v.is_blocked = 0${filter}${searchSql}
     ORDER BY ${posOrder}
     LIMIT ${take}`;

  const zeros = `
    SELECT v.user_id AS uid, ROW_NUMBER() OVER (ORDER BY v.user_id ASC) AS ord
      FROM viewer v${VIEWER_JOINS}
     WHERE v.is_blocked = 0 AND COALESCE(cur.${vcol}, 0) = 0${filter}${searchSql}
     ORDER BY v.user_id ASC
     LIMIT ${take}`;

  const first = dir === 'DESC' ? positives : zeros;
  const second = dir === 'DESC' ? zeros : positives;

  const sql = `
    WITH picked AS (
      SELECT uid, ord FROM (${first})
      UNION ALL
      SELECT uid, ${ORD_GAP} + ord FROM (${second})
      ORDER BY ord
      LIMIT ${limit} OFFSET ${offset}
    )
    SELECT ${VIEWER_COLS}
      FROM picked
      JOIN viewer v ON v.user_id = picked.uid${VIEWER_JOINS}
     ORDER BY picked.ord`;
  return db.prepare(sql).all(o.params) as Array<Record<string, unknown>>;
}

/**
 * 「累計」列ソートの行取得。並びは汎用パスと完全に同じ
 * (`ORDER BY vl.<col> <dir>, v.user_id ASC` — viewer と viewer_lifetime は
 * user_id で 1:1 なので `vl.user_id` と `v.user_id` は同値)。
 *
 * 「今回」列と違って群分けは要らない — 0 も含めて単一の順序で並ぶため、
 * 索引を頭から読んで必要件数で打ち切るだけで済む。
 *
 * cur(今回セッションの行)は FILTER_SQL が参照しうるので選抜側にも残す。
 * 索引で早期終了するぶんしか引かないので、主キー参照のコストは無視できる。
 */
function lifetimeDrivenRows(
  db: DatabaseSync,
  o: {
    lcol: string;
    dir: 'ASC' | 'DESC';
    filter: string;
    searchSql: string;
    params: Record<string, string | number>;
    limit: number;
    offset: number;
  }
): Array<Record<string, unknown>> {
  const { lcol, dir, filter, searchSql, limit, offset } = o;
  const order = `vl.${lcol} ${dir}, vl.user_id ASC`;
  const sql = `
    WITH picked AS (
      SELECT vl.user_id AS uid, ROW_NUMBER() OVER (ORDER BY ${order}) AS ord
        FROM viewer_lifetime vl
        JOIN viewer v ON v.user_id = vl.user_id
        LEFT JOIN viewer_session_stat cur ON cur.user_id = v.user_id AND cur.session_id = :sid
       WHERE v.is_blocked = 0${filter}${searchSql}
       ORDER BY ${order}
       LIMIT ${limit} OFFSET ${offset}
    )
    SELECT ${VIEWER_COLS}
      FROM picked
      JOIN viewer v ON v.user_id = picked.uid${VIEWER_JOINS}
     ORDER BY picked.ord`;
  return db.prepare(sql).all(o.params) as Array<Record<string, unknown>>;
}

export function getSessionViewerTable(
  db: DatabaseSync,
  sessionId: number | null,
  q: ViewerTableQuery,
  halfLifeDays: number,
  now = Date.now(),
  /**
   * 既知の総件数。渡されたら COUNT SQL を実行しない。
   * COUNT は viewer 全件(= 全期間の累積)を走査するので DB が育つほど重くなる
   * 一方、用途は「記録 N人」の表示だけで分単位でしか動かない。呼び出し側
   * (Store)が TTL キャッシュを持つ。
   */
  knownTotal?: number,
  /** テスト専用。true で「今回」列も汎用パスに通し、新旧の並びを突き合わせる。 */
  forceLegacy = false
): Page<ViewerTableRow> {
  // A null session means "browsing history" — 今回 is then the latest stream.
  const sid =
    sessionId ??
    (db.prepare('SELECT MAX(session_id) AS s FROM stream_session').get() as { s: number | null }).s ??
    0;

  const limit = Math.min(Math.max(q.limit ?? VIEWER_PAGE_SIZE, 1), 20000);
  const offset = Math.max(q.offset ?? 0, 0);
  // own property のみ引く: 'constructor' 等の継承キーが `??` を素通りすると
  // 関数ソースが SQL に埋まって構文エラーになる。
  const sortKey = q.sort ?? 'lastSeen';
  const sortCol = Object.hasOwn(SORT_SQL, sortKey) ? SORT_SQL[sortKey]! : SORT_SQL.lastSeen!;
  const dir = q.desc === false ? 'ASC' : 'DESC';
  const filterKey = q.filter ?? 'all';
  const filter = Object.hasOwn(FILTER_SQL, filterKey) ? (FILTER_SQL[filterKey] ?? '') : '';

  const search = (q.search ?? '').trim();
  const searchSql = search
    ? ` AND (v.nickname LIKE :q ESCAPE '\\' OR v.display_id LIKE :q ESCAPE '\\' OR COALESCE(v.reading_kana,'') LIKE :q ESCAPE '\\')`
    : '';
  const params: Record<string, string | number> = { sid };
  if (search) params.q = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

  const countSql = `
    SELECT COUNT(*) AS c
      FROM viewer v
      JOIN viewer_lifetime vl ON vl.user_id = v.user_id
      LEFT JOIN viewer_session_stat cur ON cur.user_id = v.user_id AND cur.session_id = :sid
     WHERE v.is_blocked = 0${filter}${searchSql}`;
  const total = knownTotal ?? Number((db.prepare(countSql).get(params) as { c: number }).c);

  const vcol = Object.hasOwn(SESSION_SORT_COL, sortKey) ? SESSION_SORT_COL[sortKey]! : null;
  const lcol = Object.hasOwn(LIFETIME_SORT_COL, sortKey) ? LIFETIME_SORT_COL[sortKey]! : null;
  const rows =
    vcol !== null && !forceLegacy
      ? sessionDrivenRows(db, { vcol, dir, filter, searchSql, params, limit, offset })
      : lcol !== null && !forceLegacy
      ? lifetimeDrivenRows(db, { lcol, dir, filter, searchSql, params, limit, offset })
      : (db
          .prepare(
            `${VIEWER_SELECT}${filter}${searchSql}
    ORDER BY ${sortCol} ${dir}, v.user_id ASC
    LIMIT ${limit} OFFSET ${offset}`
          )
          .all(params) as Array<Record<string, unknown>>);

  return { rows: rows.map((r) => mapRow(r, halfLifeDays, now)), total, limit, offset };
}

export function getViewerRow(
  db: DatabaseSync,
  userId: UserId,
  sessionId: number | null,
  halfLifeDays: number,
  now = Date.now()
): ViewerTableRow | null {
  const sid =
    sessionId ??
    (db.prepare('SELECT MAX(session_id) AS s FROM stream_session').get() as { s: number | null }).s ??
    0;
  const r = db.prepare(`${VIEWER_SELECT} AND v.user_id = :uid LIMIT 1`).get({ sid, uid: userId }) as
    | Record<string, unknown>
    | undefined;
  return r ? mapRow(r, halfLifeDays, now) : null;
}

export function getViewerDetail(
  db: DatabaseSync,
  userId: UserId,
  sessionId: number | null,
  halfLifeDays: number,
  now = Date.now()
): ViewerDetail | null {
  const row = getViewerRow(db, userId, sessionId, halfLifeDays, now);
  if (!row) return null;

  const identityHistory = (
    db
      .prepare(
        `SELECT display_id, nickname, observed_ms FROM viewer_identity_history
          WHERE user_id = ? ORDER BY observed_ms ASC`
      )
      .all(userId) as Array<{ display_id: string; nickname: string; observed_ms: number }>
  ).map((h) => ({ displayId: h.display_id, nickname: h.nickname, observedMs: Number(h.observed_ms) }));

  const secUid = (db.prepare('SELECT sec_uid FROM viewer WHERE user_id = ?').get(userId) as { sec_uid: string | null })
    .sec_uid;

  const attendance = (
    db
      .prepare(
        `SELECT s.started_ms AS m FROM viewer_session_stat vss
           JOIN stream_session s ON s.session_id = vss.session_id
          WHERE vss.user_id = ? ORDER BY s.started_ms ASC`
      )
      .all(userId) as Array<{ m: number }>
  ).map((x) => Number(x.m));

  const giftTotals = (
    db
      .prepare(
        `SELECT ga.canonical AS canonical,
                COALESCE(gc.name, ge.gift_name, ge.gift_id) AS gift_name,
                gc.icon_url AS icon_url,
                SUM(ge.repeat_count) AS cnt,
                SUM(ge.diamonds) AS dia
           FROM gift_event ge
           LEFT JOIN gift_catalog gc ON gc.gift_id = ge.gift_id
           LEFT JOIN gift_alias   ga ON ga.gift_id = ge.gift_id
          WHERE ge.user_id = ?
          GROUP BY ge.gift_id
          ORDER BY dia DESC, cnt DESC`
      )
      .all(userId) as Array<Record<string, unknown>>
  ).map((g) => ({
    canonical: (g.canonical as string) ?? null,
    giftName: String(g.gift_name ?? ''),
    iconUrl: (g.icon_url as string) || null,
    count: Number(g.cnt ?? 0),
    diamonds: Number(g.dia ?? 0),
  }));

  return {
    row,
    identityHistory,
    secUid: secUid || null,
    sessionsAttended: attendance.length,
    medianIntervalDays: medianIntervalDays(attendance),
    giftTotals,
  };
}

/** Single-row, sub-millisecond — fired on every VIP/常連 join so the streamer can greet by name. */
export function getRecallCard(db: DatabaseSync, userId: UserId, sessionId: number | null): RecallCard | null {
  const sid =
    sessionId ??
    (db.prepare('SELECT MAX(session_id) AS s FROM stream_session').get() as { s: number | null }).s ??
    0;
  const r = db
    .prepare(
      `SELECT v.user_id, v.nickname, v.display_id, v.avatar_url, v.reading_kana, v.note, v.vip_tier,
              vl.visits, vl.diamonds, vl.heart_me, vl.likes,
              (SELECT MAX(p.first_seen_ms) FROM viewer_session_stat p
                WHERE p.user_id = v.user_id AND p.session_id < :sid) AS prev_visit_ms,
              COALESCE((SELECT cur.is_first_ever FROM viewer_session_stat cur
                         WHERE cur.user_id = v.user_id AND cur.session_id = :sid), 0) AS is_first_ever
         FROM viewer v JOIN viewer_lifetime vl ON vl.user_id = v.user_id
        WHERE v.user_id = :uid`
    )
    .get({ sid, uid: userId }) as Record<string, unknown> | undefined;
  if (!r) return null;

  const lastComments = (
    db
      .prepare(`SELECT content FROM comment WHERE user_id = ? ORDER BY ts_ms DESC LIMIT 3`)
      .all(userId) as Array<{ content: string }>
  ).map((c) => c.content);

  return {
    userId: String(r.user_id),
    nickname: String(r.nickname ?? ''),
    displayId: String(r.display_id ?? ''),
    avatarUrl: (r.avatar_url as string) || null,
    readingKana: (r.reading_kana as string) || null,
    note: (r.note as string) || null,
    vipTier: Number(r.vip_tier ?? 0),
    visits: Number(r.visits ?? 0),
    prevVisitMs: r.prev_visit_ms == null ? null : Number(r.prev_visit_ms),
    diamondsLifetime: Number(r.diamonds ?? 0),
    heartMeLifetime: Number(r.heart_me ?? 0),
    likesLifetime: Number(r.likes ?? 0),
    lastComments,
    isFirstEver: Number(r.is_first_ever ?? 0) === 1,
  };
}
