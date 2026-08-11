import type { DatabaseSync } from 'node:sqlite';
import { DAY_MS, JST_OFFSET_MS } from '@shared/constants';
import type {
  ChurnQuery,
  ChurnRow,
  LeaderboardQuery,
  LeaderboardRow,
  MatrixCell,
  MatrixQuery,
  MissionConfig,
  MissionInputs,
  Page,
  ScoringConfig,
} from '@shared/dto';
import { applyHysteresis, displayScore, epochFactor, medianIntervalDays, sessionPoints, tierOf } from '@shared/scoring';
import { jstDayStart, jstWeekStart } from '@shared/time';

// ── 貢献度スコア ──────────────────────────────────────────────────────────────

interface VssRow {
  user_id: string;
  diamonds: number;
  comments: number;
  likes: number;
  shares: number;
  heart_me: number;
  followed: number;
  subscribed: number;
}

/**
 * Incremental at session close, O(attendees). The stored value is
 * epoch-normalised (see shared/scoring.ts), so ordering by score_e DESC stays
 * correct forever without a nightly decay pass over every viewer.
 */
export function applySessionScores(db: DatabaseSync, sessionId: number, cfg: ScoringConfig, now = Date.now()): number {
  const s = db.prepare('SELECT started_ms FROM stream_session WHERE session_id = ?').get(sessionId) as
    | { started_ms: number }
    | undefined;
  if (!s) return 0;
  const factor = epochFactor(Number(s.started_ms), cfg.halfLifeDays);

  const rows = db
    .prepare(
      `SELECT user_id, diamonds, comments, likes, shares, heart_me, followed, subscribed
         FROM viewer_session_stat WHERE session_id = ?`
    )
    .all(sessionId) as unknown as VssRow[];

  const upd = db.prepare('UPDATE viewer_lifetime SET score_e = score_e + ?, score_raw = score_raw + ? WHERE user_id = ?');
  for (const r of rows) {
    const p = sessionPoints(
      {
        diamonds: Number(r.diamonds),
        comments: Number(r.comments),
        likes: Number(r.likes),
        shares: Number(r.shares),
        heartMe: Number(r.heart_me),
        followed: Number(r.followed) === 1,
        subscribed: Number(r.subscribed) === 1,
      },
      cfg
    );
    upd.run(p * factor, p, r.user_id);
  }

  updateStreaks(db, sessionId);
  updateIntervals(db, sessionId);
  retierAttendees(db, sessionId, cfg, now);
  return rows.length;
}

/** Full rebuild — used after the user changes weights in 設定. Chunked by session. */
export function recomputeAllScores(
  db: DatabaseSync,
  cfg: ScoringConfig,
  onProgress?: (done: number, total: number) => void,
  now = Date.now()
): number {
  const sessions = db.prepare('SELECT session_id, started_ms FROM stream_session ORDER BY started_ms ASC').all() as Array<{
    session_id: number;
    started_ms: number;
  }>;

  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('UPDATE viewer_lifetime SET score_e = 0, score_raw = 0');
    const upd = db.prepare('UPDATE viewer_lifetime SET score_e = score_e + ?, score_raw = score_raw + ? WHERE user_id = ?');
    const sel = db.prepare(
      `SELECT user_id, diamonds, comments, likes, shares, heart_me, followed, subscribed
         FROM viewer_session_stat WHERE session_id = ?`
    );
    let i = 0;
    for (const s of sessions) {
      const factor = epochFactor(Number(s.started_ms), cfg.halfLifeDays);
      for (const r of sel.all(s.session_id) as unknown as VssRow[]) {
        const p = sessionPoints(
          {
            diamonds: Number(r.diamonds),
            comments: Number(r.comments),
            likes: Number(r.likes),
            shares: Number(r.shares),
            heartMe: Number(r.heart_me),
            followed: Number(r.followed) === 1,
            subscribed: Number(r.subscribed) === 1,
          },
          cfg
        );
        upd.run(p * factor, p, r.user_id);
      }
      if (++i % 25 === 0) onProgress?.(i, sessions.length);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  onProgress?.(sessions.length, sessions.length);

  const last = sessions.at(-1);
  if (last) {
    updateStreaks(db, last.session_id);
    for (const s of sessions) updateIntervals(db, s.session_id);
  }
  return retierAll(db, cfg, now);
}

function updateStreaks(db: DatabaseSync, sessionId: number): void {
  const prev = (
    db.prepare('SELECT MAX(session_id) AS p FROM stream_session WHERE session_id < ?').get(sessionId) as { p: number | null }
  ).p;
  db.prepare(
    `UPDATE viewer_lifetime
        SET consecutive_streak = CASE
              WHEN :prev IS NOT NULL AND EXISTS (
                SELECT 1 FROM viewer_session_stat p
                 WHERE p.session_id = :prev AND p.user_id = viewer_lifetime.user_id)
              THEN consecutive_streak + 1 ELSE 1 END
      WHERE user_id IN (SELECT user_id FROM viewer_session_stat WHERE session_id = :sid)`
  ).run({ prev, sid: sessionId });

  db.prepare(
    `UPDATE viewer_lifetime SET consecutive_streak = 0
      WHERE consecutive_streak > 0
        AND user_id NOT IN (SELECT user_id FROM viewer_session_stat WHERE session_id = :sid)`
  ).run({ sid: sessionId });
}

/**
 * Median visit gap, precomputed here so the churn query is a plain indexed
 * predicate instead of a window function at read time.
 */
function updateIntervals(db: DatabaseSync, sessionId: number): void {
  const users = db.prepare('SELECT user_id FROM viewer_session_stat WHERE session_id = ?').all(sessionId) as Array<{
    user_id: string;
  }>;
  const sel = db.prepare(
    `SELECT s.started_ms AS m FROM viewer_session_stat vss
       JOIN stream_session s ON s.session_id = vss.session_id
      WHERE vss.user_id = ? ORDER BY s.started_ms ASC`
  );
  const upd = db.prepare('UPDATE viewer_lifetime SET expected_interval_days = ? WHERE user_id = ?');
  for (const u of users) {
    const times = (sel.all(u.user_id) as Array<{ m: number }>).map((x) => Number(x.m));
    upd.run(medianIntervalDays(times), u.user_id);
  }
}

interface TierRow {
  user_id: string;
  score_e: number;
  visits: number;
  diamonds: number;
  vip_tier: number;
  vip_source: string;
  vip_tier_since_ms: number | null;
  is_subscriber: number;
}

function retier(db: DatabaseSync, rows: TierRow[], cfg: ScoringConfig, now: number): number {
  const upd = db.prepare('UPDATE viewer SET vip_tier = ?, vip_tier_since_ms = ? WHERE user_id = ?');
  let n = 0;
  for (const r of rows) {
    // A manual tier is the streamer's judgement; the auto pass never overrides it.
    if (r.vip_source === 'manual') continue;
    const input = {
      score: displayScore(Number(r.score_e), cfg.halfLifeDays, now),
      visits: Number(r.visits),
      diamondsLifetime: Number(r.diamonds),
      isSubscriber: Number(r.is_subscriber) === 1,
    };
    const proposed = tierOf(input, cfg);
    const next = applyHysteresis(proposed, Number(r.vip_tier), r.vip_tier_since_ms, input, cfg, now);
    if (next !== Number(r.vip_tier)) {
      upd.run(next, now, r.user_id);
      n++;
    }
  }
  return n;
}

const TIER_SELECT = `
  SELECT v.user_id, vl.score_e, vl.visits, vl.diamonds, v.vip_tier, v.vip_source, v.vip_tier_since_ms, v.is_subscriber
    FROM viewer v JOIN viewer_lifetime vl ON vl.user_id = v.user_id`;

function retierAttendees(db: DatabaseSync, sessionId: number, cfg: ScoringConfig, now: number): number {
  const rows = db
    .prepare(`${TIER_SELECT} WHERE v.user_id IN (SELECT user_id FROM viewer_session_stat WHERE session_id = ?)`)
    .all(sessionId) as unknown as TierRow[];
  return retier(db, rows, cfg, now);
}

export function retierAll(db: DatabaseSync, cfg: ScoringConfig, now = Date.now()): number {
  return retier(db, db.prepare(TIER_SELECT).all() as unknown as TierRow[], cfg, now);
}

// ── ランキング ────────────────────────────────────────────────────────────────

const LB_METRIC: Record<string, string> = {
  score: 'vl.score_e',
  diamonds: 'vl.diamonds',
  visits: 'vl.visits',
  comments: 'vl.comments',
  likes: 'vl.likes',
  heartMe: 'vl.heart_me',
};

const LB_SCOPED_METRIC: Record<string, string> = {
  score: 'SUM(vss.diamonds)',
  diamonds: 'SUM(vss.diamonds)',
  visits: 'COUNT(DISTINCT vss.session_id)',
  comments: 'SUM(vss.comments)',
  likes: 'SUM(vss.likes)',
  heartMe: 'SUM(vss.heart_me)',
};

export function getLeaderboard(
  db: DatabaseSync,
  q: LeaderboardQuery,
  halfLifeDays: number,
  now = Date.now()
): Page<LeaderboardRow> {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);
  const offset = Math.max(q.offset ?? 0, 0);

  if (q.scope === 'lifetime') {
    const col = LB_METRIC[q.metric] ?? LB_METRIC.score!;
    const total = Number((db.prepare('SELECT COUNT(*) AS c FROM viewer WHERE is_blocked = 0').get() as { c: number }).c);
    const rows = db
      .prepare(
        `SELECT v.user_id, v.nickname, v.display_id, v.avatar_url, v.vip_tier,
                ${col} AS val, vl.visits, vl.last_seen_ms
           FROM viewer v JOIN viewer_lifetime vl ON vl.user_id = v.user_id
          WHERE v.is_blocked = 0 AND ${col} > 0
          ORDER BY ${col} DESC LIMIT ${limit} OFFSET ${offset}`
      )
      .all() as Array<Record<string, unknown>>;
    return {
      rows: rows.map((r, i) => ({
        rank: offset + i + 1,
        userId: String(r.user_id),
        nickname: String(r.nickname ?? ''),
        displayId: String(r.display_id ?? ''),
        avatarUrl: (r.avatar_url as string) || null,
        vipTier: Number(r.vip_tier ?? 0),
        value: q.metric === 'score' ? displayScore(Number(r.val ?? 0), halfLifeDays, now) : Number(r.val ?? 0),
        visits: Number(r.visits ?? 0),
        lastSeenMs: Number(r.last_seen_ms ?? 0),
      })),
      total,
      limit,
      offset,
    };
  }

  const since = q.scope === 'week' ? jstWeekStart(now) : jstDayStart(now) - 30 * DAY_MS;
  const agg = LB_SCOPED_METRIC[q.metric] ?? LB_SCOPED_METRIC.diamonds!;
  const rows = db
    .prepare(
      `SELECT v.user_id, v.nickname, v.display_id, v.avatar_url, v.vip_tier,
              ${agg} AS val, COUNT(DISTINCT vss.session_id) AS visits, MAX(vss.last_seen_ms) AS last_seen_ms
         FROM viewer_session_stat vss
         JOIN stream_session s ON s.session_id = vss.session_id
         JOIN viewer v ON v.user_id = vss.user_id
        WHERE s.started_ms >= :since AND v.is_blocked = 0
        GROUP BY v.user_id
       HAVING val > 0
        ORDER BY val DESC LIMIT ${limit} OFFSET ${offset}`
    )
    .all({ since }) as Array<Record<string, unknown>>;

  return {
    rows: rows.map((r, i) => ({
      rank: offset + i + 1,
      userId: String(r.user_id),
      nickname: String(r.nickname ?? ''),
      displayId: String(r.display_id ?? ''),
      avatarUrl: (r.avatar_url as string) || null,
      vipTier: Number(r.vip_tier ?? 0),
      value: Number(r.val ?? 0),
      visits: Number(r.visits ?? 0),
      lastSeenMs: Number(r.last_seen_ms ?? 0),
    })),
    total: rows.length + offset,
    limit,
    offset,
  };
}

// ── 常連チャーンアラート / 休眠ギフター ────────────────────────────────────────

export function getChurnCandidates(db: DatabaseSync, q: ChurnQuery, now = Date.now()): ChurnRow[] {
  const limit = Math.min(Math.max(q.limit ?? 50, 1), 500);

  const sql =
    q.kind === 'dormant'
      ? `SELECT v.user_id, v.nickname, v.display_id, v.avatar_url, v.vip_tier, v.note,
                vl.visits, vl.last_seen_ms, vl.expected_interval_days, vl.diamonds
           FROM viewer v JOIN viewer_lifetime vl ON vl.user_id = v.user_id
          WHERE v.is_blocked = 0
            AND vl.diamonds >= :minDia
            AND (:now - COALESCE(vl.last_seen_ms, 0)) >= :silentMs
          ORDER BY vl.diamonds DESC LIMIT ${limit}`
      : // 常連チャーン: overdue relative to the viewer's OWN median interval, not a
        // fixed window — a weekly regular and a daily regular churn on different clocks.
        `SELECT v.user_id, v.nickname, v.display_id, v.avatar_url, v.vip_tier, v.note,
                vl.visits, vl.last_seen_ms, vl.expected_interval_days, vl.diamonds
           FROM viewer v JOIN viewer_lifetime vl ON vl.user_id = v.user_id
          WHERE v.is_blocked = 0
            AND vl.visits >= :minVisits
            AND vl.expected_interval_days IS NOT NULL
            AND vl.expected_interval_days > 0
            AND (:now - COALESCE(vl.last_seen_ms, 0)) / 86400000.0
                > vl.expected_interval_days * :factor
          ORDER BY ((:now - COALESCE(vl.last_seen_ms, 0)) / 86400000.0) / vl.expected_interval_days DESC
          LIMIT ${limit}`;

  // node:sqlite rejects named parameters the statement does not reference, so
  // each branch gets exactly its own bindings.
  const params: Record<string, number> =
    q.kind === 'dormant'
      ? { now, minDia: q.dormantMinDiamonds ?? 100, silentMs: (q.dormantSilentDays ?? 21) * DAY_MS }
      : { now, minVisits: q.minVisits ?? 3, factor: q.overdueFactor ?? 2 };

  const rows = db.prepare(sql).all(params) as Array<Record<string, unknown>>;

  return rows.map((r) => {
    const last = Number(r.last_seen_ms ?? 0);
    const daysSince = (now - last) / DAY_MS;
    const exp = r.expected_interval_days == null ? null : Number(r.expected_interval_days);
    return {
      userId: String(r.user_id),
      nickname: String(r.nickname ?? ''),
      displayId: String(r.display_id ?? ''),
      avatarUrl: (r.avatar_url as string) || null,
      vipTier: Number(r.vip_tier ?? 0),
      visits: Number(r.visits ?? 0),
      lastSeenMs: last,
      daysSince: Math.round(daysSince * 10) / 10,
      expectedIntervalDays: exp,
      overdueRatio: exp && exp > 0 ? Math.round((daysSince / exp) * 100) / 100 : null,
      diamondsLifetime: Number(r.diamonds ?? 0),
      note: (r.note as string) || null,
    };
  });
}

// ── 時間帯 × 曜日 ────────────────────────────────────────────────────────────

const MATRIX_AGG: Record<string, string> = {
  avgViewers: 'AVG(COALESCE(avg_viewers, peak_viewers))',
  peakViewers: 'AVG(peak_viewers)',
  newFollowers: 'AVG(new_followers)',
  diamonds: 'AVG(diamonds)',
  uniqueViewers: 'AVG(unique_viewers)',
  sessions: 'COUNT(*)',
  durationMin: 'AVG(COALESCE(duration_ms, 0)) / 60000.0',
};

/**
 * Pure integer arithmetic on the JST offset — no strftime, no timezone library.
 * JST has no DST, so this is exact. A stream that crosses midnight is attributed
 * to the slot it STARTED in.
 */
export function getHourWeekdayMatrix(db: DatabaseSync, q: MatrixQuery): MatrixCell[] {
  const agg = MATRIX_AGG[q.metric] ?? MATRIX_AGG.avgViewers!;
  const rows = db
    .prepare(
      `SELECT ((started_ms + ${JST_OFFSET_MS}) / ${DAY_MS} + 4) % 7 AS wd,
              ((started_ms + ${JST_OFFSET_MS}) / 3600000) % 24     AS hr,
              ${agg} AS val,
              COUNT(*) AS n
         FROM stream_session
        WHERE ended_ms IS NOT NULL AND started_ms >= :since
        GROUP BY wd, hr`
    )
    .all({ since: q.sinceMs ?? 0 }) as Array<Record<string, unknown>>;

  return rows.map((r) => ({
    weekday: Number(r.wd ?? 0),
    hour: Number(r.hr ?? 0),
    value: Math.round(Number(r.val ?? 0) * 10) / 10,
    sessions: Number(r.n ?? 0),
  }));
}

// ── 報酬ミッション HUD ────────────────────────────────────────────────────────

export function getMissionInputs(
  db: DatabaseSync,
  cfg: MissionConfig,
  sessionId: number | null,
  now = Date.now()
): MissionInputs {
  const dayStart = jstDayStart(now);
  const weekStart = jstWeekStart(now, cfg.weekStartsOn === 'sunday' ? 0 : 1);

  let session: MissionInputs['session'] = null;
  if (sessionId != null) {
    const s = db.prepare('SELECT * FROM stream_session WHERE session_id = ?').get(sessionId) as
      | Record<string, unknown>
      | undefined;
    if (s) {
      const started = Number(s.started_ms ?? 0);
      const ended = s.ended_ms == null ? now : Number(s.ended_ms);
      session = {
        durationMin: Math.max(0, (ended - started) / 60000),
        newFollowers: Number(s.new_followers ?? 0),
        diamonds: Number(s.diamonds ?? 0),
        uniqueViewers: Number(s.unique_viewers ?? 0),
        comments: Number(s.comments ?? 0),
      };
    }
  }

  const win = (since: number) =>
    db
      .prepare(
        `SELECT COALESCE(SUM(diamonds),0) AS dia,
                COALESCE(SUM(COALESCE(duration_ms, MAX(0, :now - started_ms))),0) / 60000.0 AS mins,
                COALESCE(SUM(new_followers),0) AS nf
           FROM stream_session WHERE started_ms >= :since`
      )
      .get({ since, now }) as Record<string, unknown>;

  const d = win(dayStart);
  const w = win(weekStart);

  const minValid = cfg.missions.find((m) => m.metric === 'validStreamDays')?.validDay?.minDurationMin ?? 25;
  const validStreamDays = Number(
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT (started_ms + ${JST_OFFSET_MS}) / ${DAY_MS}) AS c
             FROM stream_session
            WHERE started_ms >= :since
              AND COALESCE(duration_ms, MAX(0, :now - started_ms)) >= :minMs`
        )
        .get({ since: weekStart, now, minMs: minValid * 60000 }) as { c: number }
    ).c
  );

  const fanCfg = cfg.missions.find((m) => m.metric === 'activeFans')?.activeFan ?? { windowDays: 7, minComments: 1 };
  const fanSince = now - fanCfg.windowDays * DAY_MS;
  const activeFans = Number(
    (
      db
        .prepare(
          `SELECT COUNT(DISTINCT vss.user_id) AS c
             FROM viewer_session_stat vss
             JOIN stream_session s ON s.session_id = vss.session_id
            WHERE s.started_ms >= :since AND vss.comments >= :minC`
        )
        .get({ since: fanSince, minC: fanCfg.minComments }) as { c: number }
    ).c
  );

  return {
    nowMs: now,
    session,
    day: { diamonds: Number(d.dia ?? 0), durationMin: Number(d.mins ?? 0), newFollowers: Number(d.nf ?? 0) },
    week: {
      validStreamDays,
      activeFans,
      diamonds: Number(w.dia ?? 0),
      durationMin: Number(w.mins ?? 0),
      newFollowers: Number(w.nf ?? 0),
    },
  };
}
