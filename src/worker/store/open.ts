import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoreCapabilities } from '@shared/dto';
import { migrate } from './migrations/index';

/**
 * WAL does not work over a network filesystem, and OneDrive's sync filter breaks
 * it in ways that surface as intermittent corruption rather than a clean error.
 */
function isUnsafeForWal(dbPath: string): boolean {
  const p = dbPath.replace(/\//g, '\\');
  if (p.startsWith('\\\\')) return true; // UNC
  const od = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean) as string[];
  return od.some((root) => p.toLowerCase().startsWith(root.replace(/\//g, '\\').toLowerCase()));
}

function probeFts5(db: DatabaseSync): boolean {
  try {
    const row = db
      .prepare("SELECT COUNT(*) AS c FROM pragma_compile_options WHERE compile_options LIKE '%ENABLE_FTS5%'")
      .get() as { c: number };
    return Number(row.c) > 0;
  } catch {
    return false;
  }
}

export interface OpenedDb {
  db: DatabaseSync;
  caps: StoreCapabilities;
  /**
   * Sessions that were left open by a crash and closed just now. Their scores,
   * streaks and visit intervals were never computed, so the caller must run the
   * analytics pass for them — otherwise a crashed stream silently loses its VIP
   * tiers and churn baselines forever.
   */
  orphanSessionIds: number[];
}

export function openDatabase(dbPath: string): OpenedDb {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);

  const networkPathFallback = isUnsafeForWal(dbPath);

  // Order matters: journal_mode before the rest, foreign_keys outside any tx.
  db.exec(`PRAGMA journal_mode = ${networkPathFallback ? 'TRUNCATE' : 'WAL'}`);
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA cache_size = -65536'); // 64 MiB
  db.exec('PRAGMA mmap_size = 268435456'); // 256 MiB
  db.exec('PRAGMA wal_autocheckpoint = 2000');

  const fts5 = probeFts5(db);
  migrate(db, { fts5 });

  const journalMode = (db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode;
  const sqliteVersion = (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;

  const orphanSessionIds = closeOrphanSessions(db);
  const measuring = db.prepare('SELECT MIN(started_ms) AS m FROM stream_session').get() as { m: number | null };
  const uv = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;

  return {
    db,
    orphanSessionIds,
    caps: {
      dbPath,
      sqliteVersion,
      journalMode,
      fts5,
      networkPathFallback,
      measuringSinceMs: measuring.m ?? null,
      orphanSessionsClosed: orphanSessionIds.length,
      schemaVersion: Number(uv),
    },
  };
}

/**
 * A crash or power loss leaves `ended_ms IS NULL` rows behind. Left alone they
 * accumulate and poison every "previous stream" comparison, so they are closed
 * at the last event we actually recorded.
 */
export function closeOrphanSessions(db: DatabaseSync): number[] {
  const orphans = db.prepare('SELECT session_id, started_ms FROM stream_session WHERE ended_ms IS NULL').all() as Array<{
    session_id: number;
    started_ms: number;
  }>;
  if (orphans.length === 0) return [];

  const lastTs = db.prepare(`
    SELECT MAX(t) AS t FROM (
      SELECT MAX(ts_ms) AS t FROM comment    WHERE session_id = ?
      UNION ALL SELECT MAX(ts_ms) FROM join_event   WHERE session_id = ?
      UNION ALL SELECT MAX(ts_ms) FROM gift_event   WHERE session_id = ?
      UNION ALL SELECT MAX(ts_ms) FROM social_event WHERE session_id = ?
      UNION ALL SELECT MAX(ts_ms) FROM session_metric WHERE session_id = ?
    )
  `);
  const avg = db.prepare('SELECT AVG(viewer_count) AS a FROM session_metric WHERE session_id = ?');
  const upd = db.prepare(
    `UPDATE stream_session
        SET ended_ms = ?, duration_ms = ?, end_reason = 'crash', avg_viewers = ?
      WHERE session_id = ?`
  );

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const o of orphans) {
      const id = o.session_id;
      const t = (lastTs.get(id, id, id, id, id) as { t: number | null }).t ?? o.started_ms;
      const a = (avg.get(id) as { a: number | null }).a;
      upd.run(t, Math.max(0, t - o.started_ms), a == null ? null : Math.round(a), id);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return orphans.map((o) => o.session_id);
}
