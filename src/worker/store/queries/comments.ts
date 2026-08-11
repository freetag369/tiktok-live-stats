import type { DatabaseSync } from 'node:sqlite';
import type { CommentHit, CommentSearchQuery, GiftRow, LikeSeriesPoint, Page, Paged } from '@shared/dto';
import type { UserId } from '@shared/events';

/**
 * FTS5 when the runtime has it, LIKE otherwise. The fallback is not instant on a
 * multi-million-row archive, so the UI debounces and shows a spinner either way.
 */
export function searchComments(db: DatabaseSync, q: CommentSearchQuery, fts5: boolean): Page<CommentHit> {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000);
  const offset = Math.max(q.offset ?? 0, 0);

  const where: string[] = [];
  const params: Record<string, string | number> = {};
  if (q.userId) {
    where.push('c.user_id = :uid');
    params.uid = q.userId;
  }
  if (q.sessionId != null) {
    where.push('c.session_id = :sid');
    params.sid = q.sessionId;
  }
  if (q.questionsOnly) where.push('c.is_question = 1');

  const text = (q.text ?? '').trim();
  let from = 'comment c';
  if (text) {
    if (fts5) {
      // Quote the whole term so user input cannot become FTS5 operator syntax.
      params.ftsq = `"${text.replace(/"/g, '""')}"`;
      from = 'comment_fts f JOIN comment c ON c.rowid = f.rowid';
      where.push('comment_fts MATCH :ftsq');
    } else {
      params.like = `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
      where.push(`c.content LIKE :like ESCAPE '\\'`);
    }
  }

  const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
  const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM ${from}${w}`).get(params) as { c: number }).c);

  const rows = db
    .prepare(
      `SELECT c.msg_id, c.session_id, c.user_id, c.ts_ms, c.content, c.is_question,
              v.nickname, v.display_id, v.avatar_url
         FROM ${from}
         JOIN viewer v ON v.user_id = c.user_id${w}
        ORDER BY c.ts_ms DESC
        LIMIT ${limit} OFFSET ${offset}`
    )
    .all(params) as Array<Record<string, unknown>>;

  return {
    rows: rows.map((r) => ({
      msgId: String(r.msg_id),
      sessionId: Number(r.session_id ?? 0),
      userId: String(r.user_id),
      nickname: String(r.nickname ?? ''),
      displayId: String(r.display_id ?? ''),
      avatarUrl: (r.avatar_url as string) || null,
      tsMs: Number(r.ts_ms ?? 0),
      content: String(r.content ?? ''),
      isQuestion: Number(r.is_question ?? 0) === 1,
    })),
    total,
    limit,
    offset,
  };
}

export function listViewerGifts(db: DatabaseSync, userId: UserId, q: Paged): Page<GiftRow> {
  const limit = Math.min(Math.max(q.limit ?? 200, 1), 2000);
  const offset = Math.max(q.offset ?? 0, 0);
  const total = Number(
    (db.prepare('SELECT COUNT(*) AS c FROM gift_event WHERE user_id = ?').get(userId) as { c: number }).c
  );
  const rows = db
    .prepare(
      `SELECT ge.msg_id, ge.session_id, ge.ts_ms, ge.gift_id, ge.repeat_count, ge.diamonds, ge.is_box_gift,
              COALESCE(gc.name, ge.gift_name) AS gift_name, gc.icon_url, ga.canonical
         FROM gift_event ge
         LEFT JOIN gift_catalog gc ON gc.gift_id = ge.gift_id
         LEFT JOIN gift_alias   ga ON ga.gift_id = ge.gift_id
        WHERE ge.user_id = ?
        ORDER BY ge.ts_ms DESC
        LIMIT ${limit} OFFSET ${offset}`
    )
    .all(userId) as Array<Record<string, unknown>>;

  return {
    rows: rows.map((r) => ({
      msgId: String(r.msg_id),
      sessionId: Number(r.session_id ?? 0),
      tsMs: Number(r.ts_ms ?? 0),
      giftId: String(r.gift_id),
      giftName: (r.gift_name as string) ?? null,
      canonical: (r.canonical as string) ?? null,
      iconUrl: (r.icon_url as string) || null,
      repeatCount: Number(r.repeat_count ?? 1),
      diamonds: Number(r.diamonds ?? 0),
      isBoxGift: Number(r.is_box_gift ?? 0) === 1,
    })),
    total,
    limit,
    offset,
  };
}

/** Per-session bar chart on the viewer detail screen. */
export function getViewerLikeSeries(db: DatabaseSync, userId: UserId, limitSessions: number): LikeSeriesPoint[] {
  const n = Math.min(Math.max(limitSessions || 20, 1), 200);
  const rows = db
    .prepare(
      `SELECT vss.session_id, s.started_ms, vss.likes, vss.diamonds, vss.comments
         FROM viewer_session_stat vss
         JOIN stream_session s ON s.session_id = vss.session_id
        WHERE vss.user_id = ?
        ORDER BY s.started_ms DESC
        LIMIT ${n}`
    )
    .all(userId) as Array<Record<string, unknown>>;
  return rows
    .map((r) => ({
      sessionId: Number(r.session_id ?? 0),
      startedMs: Number(r.started_ms ?? 0),
      likes: Number(r.likes ?? 0),
      diamonds: Number(r.diamonds ?? 0),
      comments: Number(r.comments ?? 0),
    }))
    .reverse();
}
