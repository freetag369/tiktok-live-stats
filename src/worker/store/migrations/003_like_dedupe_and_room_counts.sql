-- ============================================================================
-- 003 — two corrections found by running against a real TikTok LIVE room.
--
-- Written as a separate migration rather than an edit to 001 because 001 had
-- already been applied to a live database holding real recordings. Editing an
-- applied migration is how you lose someone's data.
-- ============================================================================

-- (1) Likes are the ONE event type with no natural row to key on: they are folded
-- into an accumulating bucket, so INSERT OR IGNORE cannot protect them the way it
-- protects every other table. Without this gate, the backlog TikTok replays on
-- every (re)connect silently doubles every viewer's like count.
-- Rows are dropped when the session closes; they only matter mid-stream.
CREATE TABLE IF NOT EXISTS like_seen (
  msg_id     TEXT PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES stream_session(session_id) ON DELETE CASCADE
) STRICT, WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS like_seen_session ON like_seen(session_id);

-- (2) 同接 came from the wrong field.
--
-- WebcastRoomUserSeqMessage carries several counters. `totalUser` (wire field 7)
-- climbed monotonically 11,635 -> 12,219 across a 15-minute capture, which is a
-- CUMULATIVE viewer total, not a concurrent count. `total` is wire field 3 —
-- the same field the v1 schema named `viewerCount` — and that is the concurrent
-- figure shown in the TikTok app.
--
-- Both are recorded from now on so the distinction stays checkable on real data.
ALTER TABLE session_metric ADD COLUMN total_viewers INTEGER;
ALTER TABLE stream_session ADD COLUMN total_viewers INTEGER NOT NULL DEFAULT 0;

-- Existing rows recorded `totalUser` under viewer_count; move it to the column it
-- actually belongs in rather than leaving a wrong number labelled 同接.
UPDATE session_metric SET total_viewers = viewer_count, viewer_count = NULL;
UPDATE stream_session
   SET total_viewers = peak_viewers, peak_viewers = 0
 WHERE peak_viewers > 0;

-- (3) '567380' was a guessed Heart Me id that never appeared in real traffic.
-- The confirmed id is 7934 (1 diamond). The name rule is what actually protects
-- this metric, so a stale guess only adds a null catalog row.
DELETE FROM gift_alias   WHERE gift_id = '567380';
DELETE FROM gift_catalog WHERE gift_id = '567380' AND name IS NULL;
