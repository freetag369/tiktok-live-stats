-- Idempotent session scoring.
--
-- closeSession → (resume within the gap) → closeSession used to run the
-- accumulate-only scoring pass twice for the same session, permanently
-- inflating score_e / score_raw / consecutive_streak.  The fix stores what has
-- already been applied per (session, viewer) so a re-close only adds the delta,
-- and stamps the session itself so the streak increment runs exactly once.

ALTER TABLE stream_session ADD COLUMN scored_ms INTEGER;

ALTER TABLE viewer_session_stat ADD COLUMN scored_pts   REAL NOT NULL DEFAULT 0;
ALTER TABLE viewer_session_stat ADD COLUMN scored_pts_e REAL NOT NULL DEFAULT 0;
