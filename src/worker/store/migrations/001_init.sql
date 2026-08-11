-- ============================================================================
-- v1 schema.  MIGRATIONS ARE APPEND-ONLY — never edit this file after a release.
--
-- Field names come from the shipped v3 protobuf (tiktok-live-proto@0.2.4), not
-- from the library README, which is stale.  Verified against the .d.ts:
--   User has NO `uniqueId`; the @handle is `displayId` and is MUTABLE.
--   `user.id` / `idStr` is the stable identity  -> primary key everywhere.
--   int64 fields arrive as JS strings           -> stored as TEXT, never parsed.
-- ============================================================================

-- ── IDENTITY ────────────────────────────────────────────────────────────────

CREATE TABLE viewer (
  user_id            TEXT PRIMARY KEY,             -- User.id (int64 as string). STABLE.
  sec_uid            TEXT,                         -- stable, opaque; may be '' on some events
  display_id         TEXT NOT NULL DEFAULT '',     -- current @handle. MUTABLE (30-day change).
  nickname           TEXT NOT NULL DEFAULT '',     -- current display name. MUTABLE (~weekly).
  avatar_url         TEXT,
  reading_kana       TEXT,                         -- user-entered よみがな, for calling out names
  note               TEXT,                         -- free CRM memo (誕生日 / 好きな話題 / NG話題)
  vip_tier           INTEGER NOT NULL DEFAULT 0,   -- 0 一般 / 1 常連 / 2 VIP / 3 トップVIP
  vip_source         TEXT NOT NULL DEFAULT 'auto', -- 'auto' | 'manual'; manual is never overwritten
  vip_tier_since_ms  INTEGER,                      -- drives demotion hysteresis
  is_blocked         INTEGER NOT NULL DEFAULT 0,   -- 「今後記録しない」 (history is kept; purge deletes)
  is_moderator       INTEGER NOT NULL DEFAULT 0,
  is_subscriber      INTEGER NOT NULL DEFAULT 0,
  first_seen_ms      INTEGER NOT NULL,
  last_seen_ms       INTEGER NOT NULL,
  updated_ms         INTEGER NOT NULL
) STRICT;
CREATE INDEX viewer_display_id ON viewer(display_id);
CREATE INDEX viewer_nickname   ON viewer(nickname);
CREATE INDEX viewer_last_seen  ON viewer(last_seen_ms DESC);

-- A rename must not fork one person into two rows.  NOTE: SQLite implicitly
-- applies NOT NULL to every PK column of a WITHOUT ROWID table, so these
-- columns must be NOT NULL DEFAULT '' or inserts throw at runtime.
CREATE TABLE viewer_identity_history (
  user_id     TEXT NOT NULL REFERENCES viewer(user_id) ON DELETE CASCADE,
  display_id  TEXT NOT NULL DEFAULT '',
  nickname    TEXT NOT NULL DEFAULT '',
  observed_ms INTEGER NOT NULL,
  PRIMARY KEY (user_id, display_id, nickname)
) STRICT, WITHOUT ROWID;

-- The streamer's own handle is mutable too; keying history off the handle string
-- would silently split their history in half after a rename.
CREATE TABLE host (
  host_user_id TEXT PRIMARY KEY,
  display_id   TEXT NOT NULL DEFAULT '',
  nickname     TEXT NOT NULL DEFAULT '',
  added_ms     INTEGER NOT NULL
) STRICT;

-- ── STREAMS ─────────────────────────────────────────────────────────────────

CREATE TABLE stream_session (
  session_id       INTEGER PRIMARY KEY,
  host_user_id     TEXT REFERENCES host(host_user_id),
  host_unique_id   TEXT NOT NULL,                  -- denormalised label only
  room_id          TEXT,
  started_ms       INTEGER NOT NULL,
  ended_ms         INTEGER,
  end_reason       TEXT,                           -- streamEnd|suspended|userStopped|crash|lostConnection|quotaGuard
  duration_ms      INTEGER,
  peak_viewers     INTEGER NOT NULL DEFAULT 0,
  avg_viewers      INTEGER,
  room_total_likes INTEGER NOT NULL DEFAULT 0,     -- last observed LIKE.total: TikTok's own ground truth
  observed_likes   INTEGER NOT NULL DEFAULT 0,     -- what we actually saw; always <= room_total_likes
  unique_viewers   INTEGER NOT NULL DEFAULT 0,
  first_timers     INTEGER NOT NULL DEFAULT 0,
  comments         INTEGER NOT NULL DEFAULT 0,
  gifts            INTEGER NOT NULL DEFAULT 0,
  diamonds         INTEGER NOT NULL DEFAULT 0,
  heart_me         INTEGER NOT NULL DEFAULT 0,
  new_followers    INTEGER NOT NULL DEFAULT 0,
  shares           INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX stream_session_started ON stream_session(started_ms DESC);
CREATE INDEX stream_session_host    ON stream_session(host_user_id, started_ms DESC);
CREATE INDEX stream_session_open    ON stream_session(ended_ms) WHERE ended_ms IS NULL;

CREATE TABLE session_metric (
  session_id       INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  ts_ms            INTEGER NOT NULL,
  viewer_count     INTEGER,
  room_total_likes INTEGER,
  PRIMARY KEY (session_id, ts_ms)
) STRICT, WITHOUT ROWID;

-- ── RAW EVENTS ──────────────────────────────────────────────────────────────
-- Every table is keyed on msg_id and written with INSERT OR IGNORE, so the
-- backlog TikTok replays on every (re)connect cannot inflate any count.

CREATE TABLE join_event (
  msg_id       TEXT PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL REFERENCES viewer(user_id) ON DELETE CASCADE,
  ts_ms        INTEGER NOT NULL,
  action       INTEGER NOT NULL,                   -- MemberMessageAction: 1 JOINED, 3 SUBSCRIBED
  enter_source TEXT
) STRICT;
CREATE INDEX join_event_session ON join_event(session_id, ts_ms);
CREATE INDEX join_event_user    ON join_event(user_id, ts_ms DESC);

CREATE TABLE comment (
  msg_id        TEXT PRIMARY KEY,
  session_id    INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  user_id       TEXT    NOT NULL REFERENCES viewer(user_id) ON DELETE CASCADE,
  ts_ms         INTEGER NOT NULL,
  content       TEXT    NOT NULL,
  lang          TEXT,                              -- WebcastChatMessage.contentLanguage
  is_moderator  INTEGER NOT NULL DEFAULT 0,
  is_subscriber INTEGER NOT NULL DEFAULT 0,
  is_question   INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX comment_user    ON comment(user_id, ts_ms DESC);
CREATE INDEX comment_session ON comment(session_id, ts_ms);

-- Likes are the firehose.  Bucketed per (session, user, 10s) at ingest, or this
-- table dwarfs everything else in the database.
-- (The replay-dedupe table that guards this accumulator is added in 003 — 001 had
--  already been applied to a real database by the time that bug was found, and
--  migrations are append-only.)
CREATE TABLE like_bucket (
  session_id INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES viewer(user_id) ON DELETE CASCADE,
  bucket_ms  INTEGER NOT NULL,
  likes      INTEGER NOT NULL,
  PRIMARY KEY (session_id, user_id, bucket_ms)
) STRICT, WITHOUT ROWID;
CREATE INDEX like_bucket_user ON like_bucket(user_id, bucket_ms DESC);

CREATE TABLE gift_event (
  msg_id       TEXT PRIMARY KEY,
  session_id   INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  user_id      TEXT    NOT NULL REFERENCES viewer(user_id) ON DELETE CASCADE,
  ts_ms        INTEGER NOT NULL,
  gift_id      TEXT    NOT NULL,
  gift_name    TEXT,
  gift_type    INTEGER,                            -- 1 == streakable
  repeat_count INTEGER NOT NULL DEFAULT 1,
  diamond_each INTEGER NOT NULL DEFAULT 0,
  diamonds     INTEGER NOT NULL DEFAULT 0,         -- diamond_each * repeat_count
  group_id     TEXT,
  to_user_id   TEXT,                               -- multi-guest rooms
  is_box_gift  INTEGER NOT NULL DEFAULT 0          -- diamond value is unreliable when 1
) STRICT;
CREATE INDEX gift_user    ON gift_event(user_id, ts_ms DESC);
CREATE INDEX gift_session ON gift_event(session_id, ts_ms);
-- Belt and braces: even if the streak dedupe in normalize.ts misses, one streak
-- group can only ever produce one row.
CREATE UNIQUE INDEX gift_group_uq ON gift_event(session_id, user_id, group_id)
  WHERE group_id IS NOT NULL AND group_id <> '' AND group_id <> '0';

-- Self-populating gift dimension.  A giftId->diamond table must NEVER be
-- hardcoded: names are localized and non-unique (two distinct "Finger Heart"
-- gifts exist at 5 and 10 diamonds).
CREATE TABLE gift_catalog (
  gift_id       TEXT PRIMARY KEY,
  name          TEXT,
  diamond_count INTEGER,
  gift_type     INTEGER,
  icon_url      TEXT,
  first_seen_ms INTEGER,
  last_seen_ms  INTEGER
) STRICT;

CREATE TABLE gift_alias (
  gift_id   TEXT PRIMARY KEY,
  canonical TEXT NOT NULL                          -- 'heart_me', 'rose', …
) STRICT;
CREATE INDEX gift_alias_canonical ON gift_alias(canonical);

CREATE TABLE social_event (
  msg_id     TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES viewer(user_id) ON DELETE CASCADE,
  ts_ms      INTEGER NOT NULL,
  kind       TEXT    NOT NULL CHECK (kind IN ('follow','share','other')),
  raw_key    TEXT                                  -- for i18n-key drift detection
) STRICT;
CREATE INDEX social_user    ON social_event(user_id, ts_ms DESC);
CREATE INDEX social_session ON social_event(session_id, kind, ts_ms);

CREATE TABLE sub_event (
  msg_id     TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  user_id    TEXT    NOT NULL REFERENCES viewer(user_id) ON DELETE CASCADE,
  ts_ms      INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  sub_month  INTEGER
) STRICT;
CREATE INDEX sub_user    ON sub_event(user_id, ts_ms DESC);
CREATE INDEX sub_session ON sub_event(session_id, ts_ms);

-- SuperFanBox emits both `superFanBox` and `envelope` for one gift; dedupe here.
CREATE TABLE envelope_event (
  envelope_id INTEGER PRIMARY KEY AUTOINCREMENT,
  envelope_key TEXT NOT NULL UNIQUE,
  session_id  INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  user_id     TEXT REFERENCES viewer(user_id) ON DELETE CASCADE,
  ts_ms       INTEGER NOT NULL,
  diamonds    INTEGER NOT NULL DEFAULT 0,
  people      INTEGER
) STRICT;
CREATE INDEX envelope_session ON envelope_event(session_id, ts_ms);

-- ── DERIVED ROLLUPS (written in the SAME transaction as the raw rows) ───────

CREATE TABLE viewer_session_stat (
  session_id    INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE,
  user_id       TEXT    NOT NULL REFERENCES viewer(user_id) ON DELETE CASCADE,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL,
  joins         INTEGER NOT NULL DEFAULT 0,        -- raw MEMBER(action=1) count, incl. re-entries
  comments      INTEGER NOT NULL DEFAULT 0,
  likes         INTEGER NOT NULL DEFAULT 0,        -- OBSERVED likes: a lower bound, always
  gifts         INTEGER NOT NULL DEFAULT 0,
  diamonds      INTEGER NOT NULL DEFAULT 0,
  heart_me      INTEGER NOT NULL DEFAULT 0,
  shares        INTEGER NOT NULL DEFAULT 0,
  followed      INTEGER NOT NULL DEFAULT 0,
  subscribed    INTEGER NOT NULL DEFAULT 0,
  -- Latched on first insert only.  Recomputing it later would retroactively
  -- mark every historical session as 初見.
  is_first_ever INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, user_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX vss_user     ON viewer_session_stat(user_id, session_id DESC);
CREATE INDEX vss_diamonds ON viewer_session_stat(session_id, diamonds DESC);
CREATE INDEX vss_likes    ON viewer_session_stat(session_id, likes DESC);

CREATE TABLE viewer_lifetime (
  user_id                TEXT PRIMARY KEY REFERENCES viewer(user_id) ON DELETE CASCADE,
  visits                 INTEGER NOT NULL DEFAULT 0,  -- 来店回数 = distinct sessions attended
  comments               INTEGER NOT NULL DEFAULT 0,
  likes                  INTEGER NOT NULL DEFAULT 0,
  gifts                  INTEGER NOT NULL DEFAULT 0,
  diamonds               INTEGER NOT NULL DEFAULT 0,
  heart_me               INTEGER NOT NULL DEFAULT 0,
  shares                 INTEGER NOT NULL DEFAULT 0,
  first_session_id       INTEGER,
  last_session_id        INTEGER,
  first_seen_ms          INTEGER,
  last_seen_ms           INTEGER,
  consecutive_streak     INTEGER NOT NULL DEFAULT 0,
  -- Epoch-normalised accumulator: ordering by score_e DESC is correct at every
  -- instant with no nightly recomputation.  See shared/scoring.ts.
  score_e                REAL NOT NULL DEFAULT 0,
  score_raw              REAL NOT NULL DEFAULT 0,     -- undecayed 生涯貢献ポイント
  expected_interval_days REAL                          -- median visit gap, for churn detection
) STRICT;
CREATE INDEX vl_score_e  ON viewer_lifetime(score_e DESC);
CREATE INDEX vl_lastseen ON viewer_lifetime(last_seen_ms DESC);
CREATE INDEX vl_visits   ON viewer_lifetime(visits DESC);
CREATE INDEX vl_diamonds ON viewer_lifetime(diamonds DESC);

-- ── APP ─────────────────────────────────────────────────────────────────────

CREATE TABLE app_setting (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
) STRICT;

CREATE TABLE connect_log (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  ts_ms  INTEGER NOT NULL,
  kind   TEXT NOT NULL,
  detail TEXT
) STRICT;
CREATE INDEX connect_log_ts ON connect_log(ts_ms DESC);

-- A rising count here is how TikTok protocol drift becomes visible instead of
-- turning into silent data loss.
CREATE TABLE unknown_event (
  lib_type     TEXT PRIMARY KEY,
  count        INTEGER NOT NULL DEFAULT 0,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL
) STRICT;
