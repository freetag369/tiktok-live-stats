import type { DatabaseSync, StatementSync } from 'node:sqlite';

/**
 * Long-lived prepared statements. Re-preparing inside the 250 ms flush loop is
 * the difference between ~1,000 rows/s and >100,000 rows/s.
 */
export class Statements {
  private readonly cache = new Map<string, StatementSync>();

  constructor(private readonly db: DatabaseSync) {}

  get(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.db.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  clear(): void {
    this.cache.clear();
  }
}

export const SQL = {
  // ── viewer identity ───────────────────────────────────────────────────────
  upsertViewer: `
    INSERT INTO viewer (user_id, sec_uid, display_id, nickname, avatar_url,
                        is_moderator, is_subscriber, first_seen_ms, last_seen_ms, updated_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      -- never overwrite a stored secUid with the empty string some events carry
      sec_uid       = COALESCE(NULLIF(excluded.sec_uid, ''), viewer.sec_uid),
      display_id    = CASE WHEN excluded.display_id <> '' THEN excluded.display_id ELSE viewer.display_id END,
      nickname      = CASE WHEN excluded.nickname   <> '' THEN excluded.nickname   ELSE viewer.nickname   END,
      avatar_url    = COALESCE(NULLIF(excluded.avatar_url, ''), viewer.avatar_url),
      is_moderator  = MAX(viewer.is_moderator, excluded.is_moderator),
      is_subscriber = MAX(viewer.is_subscriber, excluded.is_subscriber),
      last_seen_ms  = MAX(viewer.last_seen_ms, excluded.last_seen_ms),
      updated_ms    = excluded.updated_ms`,

  selectViewerIdentity: `SELECT display_id, nickname FROM viewer WHERE user_id = ?`,

  insertIdentityHistory: `
    INSERT OR IGNORE INTO viewer_identity_history (user_id, display_id, nickname, observed_ms)
    VALUES (?, ?, ?, ?)`,

  ensureLifetime: `INSERT OR IGNORE INTO viewer_lifetime (user_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?)`,

  selectLifetimeVisits: `SELECT visits FROM viewer_lifetime WHERE user_id = ?`,

  touchLifetimeSeen: `UPDATE viewer_lifetime SET last_seen_ms = MAX(COALESCE(last_seen_ms, 0), ?) WHERE user_id = ?`,

  // ── per-session viewer rollup ─────────────────────────────────────────────
  insertVss: `
    INSERT OR IGNORE INTO viewer_session_stat (session_id, user_id, first_seen_ms, last_seen_ms, is_first_ever)
    VALUES (?, ?, ?, ?, ?)`,

  touchVssSeen: `
    UPDATE viewer_session_stat SET last_seen_ms = MAX(last_seen_ms, ?) WHERE session_id = ? AND user_id = ?`,

  bumpVss: (col: string) =>
    `UPDATE viewer_session_stat SET ${col} = ${col} + ? WHERE session_id = ? AND user_id = ?`,

  setVssFlag: (col: string) =>
    `UPDATE viewer_session_stat SET ${col} = 1 WHERE session_id = ? AND user_id = ?`,

  bumpLifetime: (col: string) => `UPDATE viewer_lifetime SET ${col} = ${col} + ? WHERE user_id = ?`,

  bumpSession: (col: string) => `UPDATE stream_session SET ${col} = ${col} + ? WHERE session_id = ?`,

  markLifetimeVisit: `
    UPDATE viewer_lifetime
       SET visits = visits + 1,
           first_session_id = COALESCE(first_session_id, ?),
           last_session_id = ?,
           first_seen_ms = COALESCE(first_seen_ms, ?),
           last_seen_ms = MAX(COALESCE(last_seen_ms, 0), ?)
     WHERE user_id = ?`,

  // ── raw events ────────────────────────────────────────────────────────────
  insertJoin: `
    INSERT OR IGNORE INTO join_event (msg_id, session_id, user_id, ts_ms, action, enter_source)
    VALUES (?, ?, ?, ?, ?, ?)`,

  insertComment: `
    INSERT OR IGNORE INTO comment (msg_id, session_id, user_id, ts_ms, content, lang, is_moderator, is_subscriber, is_question)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  // Likes accumulate, so they need an explicit dedupe gate; every other table
  // gets it for free from INSERT OR IGNORE on msg_id.
  markLikeSeen: `INSERT OR IGNORE INTO like_seen (msg_id, session_id, ts_ms) VALUES (?, ?, ?)`,
  clearLikeSeen: `DELETE FROM like_seen WHERE session_id = ?`,
  // dedupe が守るのは再接続バックログ(数分)+ resume 猶予(10分)だけ。
  // それより古い行は長時間配信で積もるだけなので定期的に捨てる。
  pruneLikeSeen: `DELETE FROM like_seen WHERE ts_ms < ?`,

  upsertLikeBucket: `
    INSERT INTO like_bucket (session_id, user_id, bucket_ms, likes)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(session_id, user_id, bucket_ms) DO UPDATE SET likes = likes + excluded.likes`,

  insertGift: `
    INSERT OR IGNORE INTO gift_event
      (msg_id, session_id, user_id, ts_ms, gift_id, gift_name, gift_type, repeat_count,
       diamond_each, diamonds, group_id, to_user_id, is_box_gift)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  upsertGiftCatalog: `
    INSERT INTO gift_catalog (gift_id, name, diamond_count, gift_type, icon_url, first_seen_ms, last_seen_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(gift_id) DO UPDATE SET
      name          = COALESCE(NULLIF(excluded.name, ''), gift_catalog.name),
      diamond_count = COALESCE(excluded.diamond_count, gift_catalog.diamond_count),
      gift_type     = COALESCE(excluded.gift_type, gift_catalog.gift_type),
      icon_url      = COALESCE(NULLIF(excluded.icon_url, ''), gift_catalog.icon_url),
      last_seen_ms  = excluded.last_seen_ms`,

  // gift_catalog must exist first when foreign_keys = ON.
  upsertGiftAlias: `INSERT OR IGNORE INTO gift_alias (gift_id, canonical) VALUES (?, ?)`,

  selectGiftAlias: `SELECT canonical FROM gift_alias WHERE gift_id = ?`,

  insertSocial: `
    INSERT OR IGNORE INTO social_event (msg_id, session_id, user_id, ts_ms, kind, raw_key)
    VALUES (?, ?, ?, ?, ?, ?)`,

  insertSub: `
    INSERT OR IGNORE INTO sub_event (msg_id, session_id, user_id, ts_ms, kind, sub_month)
    VALUES (?, ?, ?, ?, ?, ?)`,

  insertEnvelope: `
    INSERT OR IGNORE INTO envelope_event (envelope_key, session_id, user_id, ts_ms, diamonds, people)
    VALUES (?, ?, ?, ?, ?, ?)`,

  insertMetric: `
    INSERT OR IGNORE INTO session_metric (session_id, ts_ms, viewer_count, room_total_likes, total_viewers)
    VALUES (?, ?, ?, ?, ?)`,

  bumpUnknown: `
    INSERT INTO unknown_event (lib_type, count, first_seen_ms, last_seen_ms)
    VALUES (?, 1, ?, ?)
    ON CONFLICT(lib_type) DO UPDATE SET count = count + 1, last_seen_ms = excluded.last_seen_ms`,

  // ── session ───────────────────────────────────────────────────────────────
  setSessionPeak: `UPDATE stream_session SET peak_viewers = MAX(peak_viewers, ?) WHERE session_id = ?`,
  setSessionTotalViewers: `UPDATE stream_session SET total_viewers = MAX(total_viewers, ?) WHERE session_id = ?`,
  setSessionRoomLikes: `UPDATE stream_session SET room_total_likes = MAX(room_total_likes, ?) WHERE session_id = ?`,

  insertConnectLog: `INSERT INTO connect_log (ts_ms, kind, detail) VALUES (?, ?, ?)`,
} as const;
