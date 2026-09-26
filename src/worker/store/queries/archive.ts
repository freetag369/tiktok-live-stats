import type { DatabaseSync } from 'node:sqlite';
import type { ArchiveItem, ArchiveQuery, Page, SessionGiftSummary } from '@shared/dto';

type Params = Record<string, string | number>;

const COMMENT_COLS = `'c' AS kind, c.msg_id, c.user_id, c.ts_ms, c.content, c.is_question,
       NULL AS gift_id, NULL AS gift_name, NULL AS canonical, NULL AS icon_url,
       0 AS repeat_count, 0 AS diamonds, 0 AS is_box_gift`;
const GIFT_COLS = `'g' AS kind, g.msg_id, g.user_id, g.ts_ms, NULL AS content, 0 AS is_question,
       g.gift_id, COALESCE(gc.name, g.gift_name, g.gift_id) AS gift_name, ga.canonical, gc.icon_url,
       g.repeat_count, g.diamonds, g.is_box_gift`;

function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * Body of the UNION ALL (no ORDER / LIMIT) so the paged query, the COUNT and the
 * CSV export all agree on exactly which rows are "the archive".
 *
 * A parameter key is added only together with the clause that uses it —
 * `node:sqlite` rejects named parameters the statement does not mention.
 *
 * Text search is LIKE, not FTS5, on purpose: the FTS tokenizer treats a run of
 * Japanese as one token, so 「ありがと」 misses 「ありがとうございます」 (measured
 * 4 vs 107 hits on a real archive). The scan is bounded by the session index:
 * a real 3-hour stream is ~25k rows, which LIKE covers in tens of ms.
 */
export function archiveUnionSql(q: ArchiveQuery): { sql: string; params: Params } {
  const params: Params = { sid: q.sessionId };
  const text = (q.text ?? '').trim();
  const kind = q.questionsOnly ? 'comments' : (q.kind ?? 'all');
  const branches: string[] = [];

  if (kind !== 'gifts') {
    const where = ['c.session_id = :sid'];
    if (q.questionsOnly) where.push('c.is_question = 1');
    if (text) {
      params.like = likePattern(text);
      where.push(`c.content LIKE :like ESCAPE '\\'`);
    }
    branches.push(`SELECT ${COMMENT_COLS} FROM comment c WHERE ${where.join(' AND ')}`);
  }

  if (kind !== 'comments') {
    const where = ['g.session_id = :sid'];
    if (q.minDiamonds != null && q.minDiamonds > 0) {
      params.minDia = Math.floor(q.minDiamonds);
      where.push('g.diamonds >= :minDia');
    }
    if (text) {
      params.like ??= likePattern(text);
      where.push(`COALESCE(gc.name, g.gift_name, '') LIKE :like ESCAPE '\\'`);
    }
    branches.push(
      `SELECT ${GIFT_COLS} FROM gift_event g
         LEFT JOIN gift_catalog gc ON gc.gift_id = g.gift_id
         LEFT JOIN gift_alias   ga ON ga.gift_id = g.gift_id
        WHERE ${where.join(' AND ')}`
    );
  }

  return { sql: branches.join('\nUNION ALL\n'), params };
}

function mapItem(r: Record<string, unknown>): ArchiveItem {
  const base = {
    msgId: String(r.msg_id),
    userId: String(r.user_id),
    nickname: String(r.nickname ?? ''),
    displayId: String(r.display_id ?? ''),
    avatarUrl: (r.avatar_url as string) || null,
    vipTier: Number(r.vip_tier ?? 0),
    tsMs: Number(r.ts_ms ?? 0),
  };
  if (r.kind === 'c') {
    return { ...base, kind: 'comment', content: String(r.content ?? ''), isQuestion: Number(r.is_question ?? 0) === 1 };
  }
  return {
    ...base,
    kind: 'gift',
    giftId: String(r.gift_id ?? ''),
    giftName: String(r.gift_name ?? ''),
    canonical: (r.canonical as string) ?? null,
    iconUrl: (r.icon_url as string) || null,
    repeatCount: Number(r.repeat_count ?? 1),
    diamonds: Number(r.diamonds ?? 0),
    isBoxGift: Number(r.is_box_gift ?? 0) === 1,
  };
}

/** One stream's comments and gifts in the order they happened. */
export function getArchive(db: DatabaseSync, q: ArchiveQuery): Page<ArchiveItem> {
  const limit = Math.min(Math.max(q.limit ?? 300, 1), 2000);
  const offset = Math.max(q.offset ?? 0, 0);
  const { sql, params } = archiveUnionSql(q);

  const total = Number((db.prepare(`SELECT COUNT(*) AS c FROM (${sql})`).get(params) as { c: number }).c);

  // kind + msg_id make the order total, so OFFSET stays stable when a gift
  // streak lands many rows on the same millisecond. The viewer JOIN runs after
  // the LIMIT — one page, not the whole stream — because this shares the worker
  // thread with live ingest (a real 3-hour stream is ~25k rows).
  const dir = q.newestFirst ? 'DESC' : 'ASC';
  const order = `ts_ms ${dir}, kind ${dir}, msg_id ${dir}`;
  const rows = db
    .prepare(
      `SELECT i.*, v.nickname, v.display_id, v.avatar_url, v.vip_tier
         FROM (SELECT * FROM (${sql}) ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}) i
         JOIN viewer v ON v.user_id = i.user_id
        ORDER BY i.${order.replace(/, /g, ', i.')}`
    )
    .all(params) as Array<Record<string, unknown>>;

  return { rows: rows.map(mapItem), total, limit, offset };
}

/** Per-gift breakdown for one stream — the session-scoped twin of ViewerDetail.giftTotals. */
export function getSessionGiftSummary(db: DatabaseSync, sessionId: number): SessionGiftSummary | null {
  const s = db.prepare('SELECT gifts, diamonds FROM stream_session WHERE session_id = ?').get(sessionId) as
    | { gifts: number; diamonds: number }
    | undefined;
  if (!s) return null;

  const byGift = (
    db
      .prepare(
        `SELECT ge.gift_id, ga.canonical,
                COALESCE(gc.name, ge.gift_name, ge.gift_id) AS gift_name,
                gc.icon_url,
                SUM(ge.repeat_count) AS cnt,
                SUM(ge.diamonds) AS dia
           FROM gift_event ge
           LEFT JOIN gift_catalog gc ON gc.gift_id = ge.gift_id
           LEFT JOIN gift_alias   ga ON ga.gift_id = ge.gift_id
          WHERE ge.session_id = ?
          GROUP BY ge.gift_id
          ORDER BY dia DESC, cnt DESC`
      )
      .all(sessionId) as Array<Record<string, unknown>>
  ).map((g) => ({
    giftId: String(g.gift_id ?? ''),
    giftName: String(g.gift_name ?? ''),
    canonical: (g.canonical as string) ?? null,
    iconUrl: (g.icon_url as string) || null,
    count: Number(g.cnt ?? 0),
    diamonds: Number(g.dia ?? 0),
  }));

  return { sessionId, gifts: Number(s.gifts ?? 0), diamonds: Number(s.diamonds ?? 0), byGift };
}
