import type { DatabaseSync } from 'node:sqlite';
import type { Page, Paged, SessionDetail, SessionListRow, SessionTotals, TimelinePoint } from '@shared/dto';
import { jstWeekday } from '@shared/time';

function mapSession(r: Record<string, unknown>): SessionListRow {
  const n = (k: string) => Number(r[k] ?? 0);
  return {
    sessionId: n('session_id'),
    startedMs: n('started_ms'),
    endedMs: r.ended_ms == null ? null : Number(r.ended_ms),
    durationMs: r.duration_ms == null ? Math.max(0, Date.now() - n('started_ms')) : Number(r.duration_ms),
    endReason: (r.end_reason as string) ?? null,
    peakViewers: n('peak_viewers'),
    avgViewers: r.avg_viewers == null ? null : Number(r.avg_viewers),
    totalViewers: n('total_viewers'),
    uniqueViewers: n('unique_viewers'),
    comments: n('comments'),
    diamonds: n('diamonds'),
    heartMe: n('heart_me'),
    newFollowers: n('new_followers'),
    roomTotalLikes: n('room_total_likes'),
  };
}

export function listSessions(db: DatabaseSync, q: Paged): Page<SessionListRow> {
  const limit = Math.min(Math.max(q.limit ?? 100, 1), 1000);
  const offset = Math.max(q.offset ?? 0, 0);
  const total = Number((db.prepare('SELECT COUNT(*) AS c FROM stream_session').get() as { c: number }).c);
  const rows = db
    .prepare(`SELECT * FROM stream_session ORDER BY started_ms DESC LIMIT ${limit} OFFSET ${offset}`)
    .all() as Array<Record<string, unknown>>;
  return { rows: rows.map(mapSession), total, limit, offset };
}

export function getSessionTotals(db: DatabaseSync, sessionId: number): SessionTotals | null {
  const r = db.prepare('SELECT * FROM stream_session WHERE session_id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  const base = mapSession(r);
  const lastMetric = db
    .prepare('SELECT viewer_count FROM session_metric WHERE session_id = ? ORDER BY ts_ms DESC LIMIT 1')
    .get(sessionId) as { viewer_count: number | null } | undefined;
  return {
    sessionId: base.sessionId,
    startedMs: base.startedMs,
    endedMs: base.endedMs,
    durationMs: base.durationMs,
    viewerCount: lastMetric?.viewer_count == null ? null : Number(lastMetric.viewer_count),
    peakViewers: base.peakViewers,
    avgViewers: base.avgViewers,
    totalViewers: base.totalViewers,
    roomTotalLikes: base.roomTotalLikes,
    uniqueViewers: base.uniqueViewers,
    comments: base.comments,
    gifts: Number(r.gifts ?? 0),
    diamonds: base.diamonds,
    heartMe: base.heartMe,
    newFollowers: base.newFollowers,
    shares: Number(r.shares ?? 0),
    observedLikes: Number(r.observed_likes ?? 0),
    firstTimers: Number(r.first_timers ?? 0),
  };
}

const TOP_N = 10;

export function getSessionDetail(db: DatabaseSync, sessionId: number): SessionDetail | null {
  const r = db.prepare('SELECT * FROM stream_session WHERE session_id = ?').get(sessionId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  const base = mapSession(r);

  // The engagement funnel TikTok never shows: 視聴者 → コメント者 → いいね者 → ギフター.
  const f = db
    .prepare(
      `SELECT COUNT(*) AS viewers,
              SUM(CASE WHEN comments > 0 THEN 1 ELSE 0 END) AS commenters,
              SUM(CASE WHEN likes    > 0 THEN 1 ELSE 0 END) AS likers,
              SUM(CASE WHEN gifts    > 0 THEN 1 ELSE 0 END) AS gifters,
              SUM(CASE WHEN is_first_ever = 1 THEN 1 ELSE 0 END) AS firsts
         FROM viewer_session_stat WHERE session_id = ?`
    )
    .get(sessionId) as Record<string, unknown>;

  const viewers = Number(f.viewers ?? 0);
  const firsts = Number(f.firsts ?? 0);

  const top = (col: 'diamonds' | 'comments' | 'likes') =>
    (
      db
        .prepare(
          `SELECT vss.user_id, v.nickname, v.display_id, vss.${col} AS val, vss.gifts AS gifts
             FROM viewer_session_stat vss JOIN viewer v ON v.user_id = vss.user_id
            WHERE vss.session_id = ? AND vss.${col} > 0
            ORDER BY vss.${col} DESC LIMIT ${TOP_N}`
        )
        .all(sessionId) as Array<Record<string, unknown>>
    ).map((x) => ({
      userId: String(x.user_id),
      nickname: String(x.nickname ?? ''),
      displayId: String(x.display_id ?? ''),
      value: Number(x.val ?? 0),
      gifts: Number(x.gifts ?? 0),
    }));

  const prevRow = db
    .prepare('SELECT * FROM stream_session WHERE started_ms < ? ORDER BY started_ms DESC LIMIT 1')
    .get(base.startedMs) as Record<string, unknown> | undefined;

  // Same-weekday baseline — "is tonight actually good?" needs a comparison the
  // 60-day LIVE Center window cannot give you.
  const wd = jstWeekday(base.startedMs);
  const sameWeekday = db
    .prepare(
      `SELECT AVG(peak_viewers) AS pv, AVG(diamonds) AS di, AVG(comments) AS co, AVG(new_followers) AS nf, COUNT(*) AS c
         FROM stream_session
        WHERE session_id <> ? AND ended_ms IS NOT NULL
          AND ((started_ms + 32400000) / 86400000 + 4) % 7 = ?`
    )
    .get(sessionId, wd) as Record<string, unknown>;

  return {
    ...base,
    hostUniqueId: String(r.host_unique_id ?? ''),
    roomId: (r.room_id as string) ?? null,
    funnel: {
      viewers,
      commenters: Number(f.commenters ?? 0),
      likers: Number(f.likers ?? 0),
      gifters: Number(f.gifters ?? 0),
    },
    newVsReturning: { first: firsts, returning: Math.max(0, viewers - firsts) },
    topGifters: top('diamonds'),
    topCommenters: top('comments'),
    topLikers: top('likes'),
    prev: prevRow ? mapSession(prevRow) : null,
    sameWeekdayAvg:
      Number(sameWeekday.c ?? 0) > 0
        ? {
            peakViewers: Math.round(Number(sameWeekday.pv ?? 0)),
            diamonds: Math.round(Number(sameWeekday.di ?? 0)),
            comments: Math.round(Number(sameWeekday.co ?? 0)),
            newFollowers: Math.round(Number(sameWeekday.nf ?? 0)),
          }
        : null,
  };
}

export function getSessionTimeline(db: DatabaseSync, sessionId: number, bucketMs: number): TimelinePoint[] {
  const b = Math.max(5000, Math.min(bucketMs || 60_000, 3_600_000));
  const s = db.prepare('SELECT started_ms FROM stream_session WHERE session_id = ?').get(sessionId) as
    | { started_ms: number }
    | undefined;
  if (!s) return [];
  const start = Number(s.started_ms);

  const rows = db
    .prepare(
      `WITH b AS (SELECT ((ts_ms - :start) / :b) AS k, AVG(viewer_count) AS vc, MAX(room_total_likes) AS rl
                    FROM session_metric WHERE session_id = :sid GROUP BY k),
            c AS (SELECT ((ts_ms - :start) / :b) AS k, COUNT(*) AS n FROM comment WHERE session_id = :sid GROUP BY k),
            g AS (SELECT ((ts_ms - :start) / :b) AS k, SUM(diamonds) AS d FROM gift_event WHERE session_id = :sid GROUP BY k),
            j AS (SELECT ((ts_ms - :start) / :b) AS k, COUNT(*) AS n FROM join_event WHERE session_id = :sid GROUP BY k),
            f AS (SELECT ((ts_ms - :start) / :b) AS k, COUNT(*) AS n FROM social_event
                   WHERE session_id = :sid AND kind = 'follow' GROUP BY k),
            ks AS (SELECT k FROM b UNION SELECT k FROM c UNION SELECT k FROM g UNION SELECT k FROM j UNION SELECT k FROM f)
       SELECT ks.k AS k, b.vc AS vc, b.rl AS rl, COALESCE(c.n,0) AS cn, COALESCE(g.d,0) AS gd,
              COALESCE(j.n,0) AS jn, COALESCE(f.n,0) AS fn
         FROM ks
         LEFT JOIN b ON b.k = ks.k LEFT JOIN c ON c.k = ks.k LEFT JOIN g ON g.k = ks.k
         LEFT JOIN j ON j.k = ks.k LEFT JOIN f ON f.k = ks.k
        ORDER BY ks.k`
    )
    .all({ sid: sessionId, start, b }) as Array<Record<string, unknown>>;

  return rows.map((x) => ({
    tsMs: start + Number(x.k ?? 0) * b,
    viewers: x.vc == null ? null : Math.round(Number(x.vc)),
    roomTotalLikes: x.rl == null ? null : Number(x.rl),
    comments: Number(x.cn ?? 0),
    diamonds: Number(x.gd ?? 0),
    joins: Number(x.jn ?? 0),
    follows: Number(x.fn ?? 0),
  }));
}
