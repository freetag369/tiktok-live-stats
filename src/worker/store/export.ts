import { closeSync, openSync, writeSync } from 'node:fs';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { CSV_BOM, CsvText, csvRow } from '@shared/format';
import type { CsvExportSpec, PurgeResult, PurgeSpec } from '@shared/dto';
import { DAY_MS } from '@shared/constants';
import { formatDateJa } from '@shared/time';

const CHUNK = 2000;

interface ExportPlan {
  header: string[];
  sql: string;
  params: Record<string, SQLInputValue>;
  map: (r: Record<string, unknown>) => unknown[];
}

/**
 * node:sqlite rejects bind parameters the statement does not reference
 * (ERR_INVALID_STATE), so each plan declares exactly the set its SQL uses.
 */
function rangeParams(spec: CsvExportSpec): Record<string, SQLInputValue> {
  return { from: spec.fromMs ?? null, to: spec.toMs ?? null };
}

function filterParams(spec: CsvExportSpec): Record<string, SQLInputValue> {
  return { sid: spec.sessionId ?? null, uid: spec.userId ?? null, ...rangeParams(spec) };
}

function plan(spec: CsvExportSpec): ExportPlan {
  switch (spec.kind) {
    case 'viewers':
      return {
        header: [
          'ユーザーID',
          'ニックネーム',
          '@ハンドル',
          'よみがな',
          'VIP段階',
          '来店回数(観測)',
          '初回来店',
          '最終来店',
          '連続来店',
          'コメント数(累計)',
          'いいね(観測累計)',
          'ギフト数(累計)',
          'ダイヤ(累計)',
          'ハートミー(累計)',
          'メモ',
        ],
        sql: `SELECT v.user_id, v.nickname, v.display_id, v.reading_kana, v.vip_tier, v.note,
                     vl.visits, vl.first_seen_ms, vl.last_seen_ms, vl.consecutive_streak,
                     vl.comments, vl.likes, vl.gifts, vl.diamonds, vl.heart_me
                FROM viewer v JOIN viewer_lifetime vl ON vl.user_id = v.user_id
               WHERE v.is_blocked = 0
               ORDER BY vl.diamonds DESC, vl.visits DESC`,
        params: {},
        map: (r) => [
          // int64 の user_id は素で出すと Excel が 6.88E+18 に丸める(復元不能)。
          new CsvText(String(r.user_id)),
          r.nickname,
          r.display_id,
          r.reading_kana ?? '',
          r.vip_tier,
          r.visits,
          formatDateJa(r.first_seen_ms as number),
          formatDateJa(r.last_seen_ms as number),
          r.consecutive_streak,
          r.comments,
          r.likes,
          r.gifts,
          r.diamonds,
          r.heart_me,
          r.note ?? '',
        ],
      };

    case 'comments':
      return {
        header: ['日時', 'ユーザーID', 'ニックネーム', '@ハンドル', '配信ID', '質問', 'コメント'],
        sql: `SELECT c.ts_ms, c.user_id, v.nickname, v.display_id, c.session_id, c.is_question, c.content
                FROM comment c JOIN viewer v ON v.user_id = c.user_id
               WHERE (:sid IS NULL OR c.session_id = :sid)
                 AND (:uid IS NULL OR c.user_id = :uid)
                 AND (:from IS NULL OR c.ts_ms >= :from)
                 AND (:to IS NULL OR c.ts_ms <= :to)
               ORDER BY c.ts_ms ASC`,
        params: filterParams(spec),
        map: (r) => [
          formatDateJa(r.ts_ms as number),
          new CsvText(String(r.user_id)),
          r.nickname,
          r.display_id,
          r.session_id,
          Number(r.is_question) === 1 ? '○' : '',
          r.content,
        ],
      };

    case 'gifts':
      return {
        header: ['日時', 'ユーザーID', 'ニックネーム', '@ハンドル', 'ギフト', '種別', '個数', 'ダイヤ', '配信ID'],
        sql: `SELECT g.ts_ms, g.user_id, v.nickname, v.display_id,
                     COALESCE(gc.name, g.gift_name, g.gift_id) AS gname, ga.canonical,
                     g.repeat_count, g.diamonds, g.session_id
                FROM gift_event g
                JOIN viewer v ON v.user_id = g.user_id
                LEFT JOIN gift_catalog gc ON gc.gift_id = g.gift_id
                LEFT JOIN gift_alias   ga ON ga.gift_id = g.gift_id
               WHERE (:sid IS NULL OR g.session_id = :sid)
                 AND (:uid IS NULL OR g.user_id = :uid)
                 AND (:from IS NULL OR g.ts_ms >= :from)
                 AND (:to IS NULL OR g.ts_ms <= :to)
               ORDER BY g.ts_ms ASC`,
        params: filterParams(spec),
        map: (r) => [
          formatDateJa(r.ts_ms as number),
          new CsvText(String(r.user_id)),
          r.nickname,
          r.display_id,
          r.gname,
          r.canonical ?? '',
          r.repeat_count,
          r.diamonds,
          r.session_id,
        ],
      };

    case 'sessions':
      return {
        header: [
          '配信ID',
          '開始',
          '終了',
          '配信時間(分)',
          'ピーク同接',
          '平均同接',
          'ユニーク視聴者',
          '初見',
          'コメント',
          'ルーム総いいね',
          '観測いいね',
          'ギフト数',
          'ダイヤ',
          'ハートミー',
          '新規フォロワー',
          'シェア',
          '終了理由',
        ],
        sql: `SELECT * FROM stream_session
               WHERE (:from IS NULL OR started_ms >= :from) AND (:to IS NULL OR started_ms <= :to)
               ORDER BY started_ms ASC`,
        params: rangeParams(spec),
        map: (r) => [
          r.session_id,
          formatDateJa(r.started_ms as number),
          r.ended_ms == null ? '' : formatDateJa(r.ended_ms as number),
          Math.round(Number(r.duration_ms ?? 0) / 60000),
          r.peak_viewers,
          r.avg_viewers ?? '',
          r.unique_viewers,
          r.first_timers,
          r.comments,
          r.room_total_likes,
          r.observed_likes,
          r.gifts,
          r.diamonds,
          r.heart_me,
          r.new_followers,
          r.shares,
          r.end_reason ?? '',
        ],
      };

    case 'agencyMonthly':
      // 事務所報告用: 配信時間 / 有効配信日数 / ダイヤ / 同接 / 新規フォロワー.
      return {
        header: ['年月', '配信日数', '有効配信日数(25分以上)', '配信回数', '合計配信時間(分)', '平均同接', '最高同接', 'ダイヤ', '新規フォロワー', 'ユニーク視聴者延べ'],
        sql: `SELECT strftime('%Y-%m', (started_ms + 32400000) / 1000, 'unixepoch') AS ym,
                     COUNT(DISTINCT (started_ms + 32400000) / 86400000) AS days,
                     COUNT(DISTINCT CASE WHEN COALESCE(duration_ms,0) >= 1500000
                                         THEN (started_ms + 32400000) / 86400000 END) AS valid_days,
                     COUNT(*) AS sessions,
                     SUM(COALESCE(duration_ms,0)) / 60000 AS mins,
                     AVG(COALESCE(avg_viewers, peak_viewers)) AS avg_v,
                     MAX(peak_viewers) AS peak,
                     SUM(diamonds) AS dia,
                     SUM(new_followers) AS nf,
                     SUM(unique_viewers) AS uv
                FROM stream_session
               WHERE ended_ms IS NOT NULL
                 AND (:from IS NULL OR started_ms >= :from) AND (:to IS NULL OR started_ms <= :to)
               GROUP BY ym ORDER BY ym ASC`,
        params: rangeParams(spec),
        map: (r) => [
          r.ym,
          r.days,
          r.valid_days,
          r.sessions,
          r.mins,
          Math.round(Number(r.avg_v ?? 0)),
          r.peak,
          r.dia,
          r.nf,
          r.uv,
        ],
      };
  }
  // 未知の kind でファイルを作成・切り詰める前に止める。
  throw new Error(`unknown export kind: ${String((spec as { kind?: unknown }).kind)}`);
}

/** Streaming write — a 100k-comment export must not materialise in memory or freeze the app. */
export function exportCsv(
  db: DatabaseSync,
  spec: CsvExportSpec,
  outPath: string,
  onProgress?: (rows: number) => void
): number {
  const p = plan(spec);
  const params = p.params;

  const fd = openSync(outPath, 'w');
  let rows = 0;
  try {
    // BOM + CRLF or Excel on Japanese Windows renders UTF-8 as mojibake.
    writeSync(fd, Buffer.from(CSV_BOM + csvRow(p.header), 'utf8'));
    let buf = '';
    for (const r of db.prepare(p.sql).iterate(params) as Iterable<Record<string, unknown>>) {
      buf += csvRow(p.map(r));
      rows++;
      if (rows % CHUNK === 0) {
        writeSync(fd, Buffer.from(buf, 'utf8'));
        buf = '';
        onProgress?.(rows);
      }
    }
    if (buf) writeSync(fd, Buffer.from(buf, 'utf8'));
  } finally {
    closeSync(fd);
  }
  onProgress?.(rows);
  return rows;
}

/**
 * VACUUM INTO produces one defragmented file with no -wal/-shm sidecars.
 * fs.copyFile on a WAL database silently copies a partial state.
 */
export function backupTo(db: DatabaseSync, outPath: string): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.prepare('VACUUM INTO ?').run(outPath);
}

export function purge(db: DatabaseSync, spec: PurgeSpec): PurgeResult {
  const res: PurgeResult = { sessionsDeleted: 0, viewersDeleted: 0, rowsDeleted: 0 };
  db.exec('BEGIN IMMEDIATE');
  try {
    if (spec.scope === 'all') {
      // FK の向きに注意: gift_alias -> gift_catalog、各イベント -> viewer/stream_session。
      for (const t of [
        'comment',
        'gift_event',
        'like_bucket',
        'like_seen',
        'join_event',
        'social_event',
        'sub_event',
        'envelope_event',
        'session_metric',
        'viewer_session_stat',
        'viewer_lifetime',
        'viewer_identity_history',
        'stream_session',
        'viewer',
        'unknown_event',
        'connect_log',
        'gift_alias',
        'gift_catalog',
        'host',
      ]) {
        const changes = Number(db.prepare(`DELETE FROM ${t}`).run().changes);
        res.rowsDeleted += changes;
        if (t === 'stream_session') res.sessionsDeleted = changes;
        if (t === 'viewer') res.viewersDeleted = changes;
      }
    } else if (spec.scope === 'session') {
      res.rowsDeleted += Number(db.prepare('DELETE FROM stream_session WHERE session_id = ?').run(spec.sessionId).changes);
      res.sessionsDeleted = 1;
      rebuildLifetime(db);
    } else if (spec.scope === 'viewer') {
      res.rowsDeleted += Number(db.prepare('DELETE FROM viewer WHERE user_id = ?').run(spec.userId).changes);
      res.viewersDeleted = 1;
      // CASCADE で消えた行のぶん、過去配信の集計が水増しのまま残るのを修復する。
      rebuildSessionCounters(db);
    } else {
      const cutoff = Date.now() - spec.days * DAY_MS;
      const ids = db.prepare('SELECT session_id FROM stream_session WHERE started_ms < ?').all(cutoff) as Array<{
        session_id: number;
      }>;
      res.rowsDeleted += Number(db.prepare('DELETE FROM stream_session WHERE started_ms < ?').run(cutoff).changes);
      res.sessionsDeleted = ids.length;
      rebuildLifetime(db);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return res;
}

/**
 * Viewer deletion cascades the raw rows but stream_session keeps its incremental
 * counters, so per-session totals are rebuilt from what actually remains.
 * Room-wide numbers (peak/avg viewers, room_total_likes) are observations, not
 * per-viewer sums — they stay.
 */
export function rebuildSessionCounters(db: DatabaseSync): void {
  db.exec(`
    UPDATE stream_session AS s SET
      comments       = COALESCE((SELECT COUNT(*)      FROM comment        x WHERE x.session_id = s.session_id), 0),
      gifts          = COALESCE((SELECT COUNT(*)      FROM gift_event     x WHERE x.session_id = s.session_id), 0),
      diamonds       = COALESCE((SELECT SUM(diamonds) FROM gift_event     x WHERE x.session_id = s.session_id), 0)
                     + COALESCE((SELECT SUM(diamonds) FROM envelope_event x WHERE x.session_id = s.session_id), 0),
      observed_likes = COALESCE((SELECT SUM(likes)    FROM viewer_session_stat x WHERE x.session_id = s.session_id), 0),
      heart_me       = COALESCE((SELECT SUM(heart_me) FROM viewer_session_stat x WHERE x.session_id = s.session_id), 0),
      shares         = COALESCE((SELECT SUM(shares)   FROM viewer_session_stat x WHERE x.session_id = s.session_id), 0),
      unique_viewers = COALESCE((SELECT COUNT(*)      FROM viewer_session_stat x WHERE x.session_id = s.session_id), 0),
      first_timers   = COALESCE((SELECT COUNT(*)      FROM viewer_session_stat x
                                  WHERE x.session_id = s.session_id AND x.is_first_ever = 1), 0),
      new_followers  = COALESCE((SELECT COUNT(*)      FROM viewer_session_stat x
                                  WHERE x.session_id = s.session_id AND x.followed = 1), 0)
  `);
}

/**
 * Deleting a session cascades the raw rows but leaves viewer_lifetime stale, so
 * every lifetime total is rebuilt from what actually remains.
 */
export function rebuildLifetime(db: DatabaseSync): void {
  db.exec(`
    UPDATE viewer_lifetime AS vl SET
      visits    = COALESCE((SELECT COUNT(*)        FROM viewer_session_stat x WHERE x.user_id = vl.user_id), 0),
      comments  = COALESCE((SELECT SUM(x.comments) FROM viewer_session_stat x WHERE x.user_id = vl.user_id), 0),
      likes     = COALESCE((SELECT SUM(x.likes)    FROM viewer_session_stat x WHERE x.user_id = vl.user_id), 0),
      gifts     = COALESCE((SELECT SUM(x.gifts)    FROM viewer_session_stat x WHERE x.user_id = vl.user_id), 0),
      diamonds  = COALESCE((SELECT SUM(x.diamonds) FROM viewer_session_stat x WHERE x.user_id = vl.user_id), 0),
      heart_me  = COALESCE((SELECT SUM(x.heart_me) FROM viewer_session_stat x WHERE x.user_id = vl.user_id), 0),
      shares    = COALESCE((SELECT SUM(x.shares)   FROM viewer_session_stat x WHERE x.user_id = vl.user_id), 0),
      first_session_id = (SELECT MIN(x.session_id) FROM viewer_session_stat x WHERE x.user_id = vl.user_id),
      last_session_id  = (SELECT MAX(x.session_id) FROM viewer_session_stat x WHERE x.user_id = vl.user_id),
      first_seen_ms    = (SELECT MIN(x.first_seen_ms) FROM viewer_session_stat x WHERE x.user_id = vl.user_id),
      last_seen_ms     = (SELECT MAX(x.last_seen_ms)  FROM viewer_session_stat x WHERE x.user_id = vl.user_id)
  `);
}
