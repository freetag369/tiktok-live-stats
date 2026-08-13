import type { DatabaseSync } from 'node:sqlite';
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
const VIEWER_SELECT = `
  SELECT
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
      WHERE c.user_id = v.user_id ORDER BY c.ts_ms DESC LIMIT 1) AS last_comment
  FROM viewer v
  JOIN viewer_lifetime vl ON vl.user_id = v.user_id
  LEFT JOIN viewer_session_stat cur ON cur.user_id = v.user_id AND cur.session_id = :sid
  LEFT JOIN viewer_session_stat prv ON prv.user_id = v.user_id AND prv.session_id = (
    SELECT MAX(p.session_id) FROM viewer_session_stat p
     WHERE p.user_id = v.user_id AND p.session_id < :sid
  )
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

export function getSessionViewerTable(
  db: DatabaseSync,
  sessionId: number | null,
  q: ViewerTableQuery,
  halfLifeDays: number,
  now = Date.now()
): Page<ViewerTableRow> {
  // A null session means "browsing history" — 今回 is then the latest stream.
  const sid =
    sessionId ??
    (db.prepare('SELECT MAX(session_id) AS s FROM stream_session').get() as { s: number | null }).s ??
    0;

  const limit = Math.min(Math.max(q.limit ?? 5000, 1), 20000);
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
  const total = Number((db.prepare(countSql).get(params) as { c: number }).c);

  const sql = `${VIEWER_SELECT}${filter}${searchSql}
    ORDER BY ${sortCol} ${dir}, v.user_id ASC
    LIMIT ${limit} OFFSET ${offset}`;
  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>;

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
