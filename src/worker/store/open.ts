import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { StoreCapabilities } from '@shared/dto';
import { hasTable, migrate } from './migrations/index';

/**
 * WAL does not work over a network filesystem, and OneDrive's sync filter breaks
 * it in ways that surface as intermittent corruption rather than a clean error.
 */
function isUnsafeForWal(dbPath: string): boolean {
  const p = dbPath.replace(/\//g, '\\');
  if (p.startsWith('\\\\')) return true; // UNC
  const od = [process.env.OneDrive, process.env.OneDriveConsumer, process.env.OneDriveCommercial].filter(Boolean) as string[];
  // 区切りまで比較しないと C:\OneDriveBackup のような無関係パスに誤マッチする。
  return od.some((root) => {
    const r = root.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const q = p.toLowerCase();
    return q === r || q.startsWith(`${r}\\`);
  });
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
  try {
    return openInner(db, dbPath);
  } catch (e) {
    // migrate 失敗等でハンドルと WAL/SHM を開いたまま参照を失わないように。
    try {
      db.close();
    } catch {
      /* already closed */
    }
    throw e;
  }
}

function openInner(db: DatabaseSync, dbPath: string): OpenedDb {
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

  const probedFts5 = probeFts5(db);
  migrate(db, { fts5: probedFts5 });
  // 検索SQLは comment_fts の実在に依存する。ランタイム能力だけを見ると、
  // 過去に skip されたままの DB で "no such table" になる(migrate 内の retro
  // 適用で通常は揃うが、能力とテーブルの両方を確認しておく)。
  const fts5 = probedFts5 && hasTable(db, 'comment_fts');

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

/** Last recorded activity for a session across every event table, or null. */
export function lastEventTs(db: DatabaseSync, sessionId: number): number | null {
  const row = db
    .prepare(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(ts_ms) AS t FROM comment    WHERE session_id = ?
         UNION ALL SELECT MAX(ts_ms) FROM join_event   WHERE session_id = ?
         UNION ALL SELECT MAX(ts_ms) FROM gift_event   WHERE session_id = ?
         UNION ALL SELECT MAX(ts_ms) FROM social_event WHERE session_id = ?
         UNION ALL SELECT MAX(ts_ms) FROM session_metric WHERE session_id = ?
       )`
    )
    .get(sessionId, sessionId, sessionId, sessionId, sessionId) as { t: number | null };
  return row.t == null ? null : Number(row.t);
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
      const t = lastEventTs(db, id) ?? o.started_ms;
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
