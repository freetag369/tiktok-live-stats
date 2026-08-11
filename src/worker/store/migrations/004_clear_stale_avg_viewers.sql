-- ============================================================================
-- 004 — follow-up to 003.
--
-- 003 moved the mis-recorded 同接 values out of session_metric.viewer_count, but
-- stream_session.avg_viewers had already been computed FROM those values at
-- session close and was left behind. The 配信履歴 screen therefore showed a
-- "平均同接" of ~11,600 for a room whose real concurrent count was two orders of
-- magnitude smaller.
--
-- A wrong number presented confidently is worse than no number, so sessions whose
-- metrics predate the fix have their average cleared rather than guessed at.
-- ============================================================================

UPDATE stream_session
   SET avg_viewers = NULL
 WHERE avg_viewers IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM session_metric m
      WHERE m.session_id = stream_session.session_id
        AND m.viewer_count IS NOT NULL
   );
