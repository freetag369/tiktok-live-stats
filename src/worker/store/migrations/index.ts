import type { DatabaseSync } from 'node:sqlite';
import INIT_SQL from './001_init.sql?raw';
import FTS_SQL from './002_fts.sql?raw';
import LIKE_DEDUPE_SQL from './003_like_dedupe_and_room_counts.sql?raw';
import CLEAR_AVG_SQL from './004_clear_stale_avg_viewers.sql?raw';
import LIKE_SEEN_TS_SQL from './005_like_seen_ts.sql?raw';
import SCORING_IDEMPOTENT_SQL from './006_scoring_idempotent.sql?raw';

export interface Migration {
  version: number;
  name: string;
  /** Skipped (but still counted) when the runtime lacks a required capability. */
  requires?: 'fts5';
  sql: string;
}

/**
 * APPEND-ONLY. Never edit a shipped migration — users' databases have already
 * run it. Add a new one instead.
 */
export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'init', sql: INIT_SQL },
  { version: 2, name: 'fts', sql: FTS_SQL, requires: 'fts5' },
  { version: 3, name: 'like_dedupe_and_room_counts', sql: LIKE_DEDUPE_SQL },
  { version: 4, name: 'clear_stale_avg_viewers', sql: CLEAR_AVG_SQL },
  { version: 5, name: 'like_seen_ts', sql: LIKE_SEEN_TS_SQL },
  { version: 6, name: 'scoring_idempotent', sql: SCORING_IDEMPOTENT_SQL },
];

export interface MigrateResult {
  from: number;
  to: number;
  applied: string[];
  skipped: string[];
}

export function currentVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

export function hasTable(db: DatabaseSync, name: string): boolean {
  const row = db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE type IN ('table','view') AND name = ?").get(name) as {
    c: number;
  };
  return Number(row.c) > 0;
}

export function migrate(db: DatabaseSync, caps: { fts5: boolean }): MigrateResult {
  const from = currentVersion(db);
  if (from > MIGRATIONS.length) {
    throw new Error(
      `このデータベースは新しいバージョンのアプリで作成されています（DB: v${from} / アプリ: v${MIGRATIONS.length}）。` +
        `データを壊さないため、起動を中止しました。アプリを更新してください。`
    );
  }

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const m of MIGRATIONS) {
    if (m.version <= from) continue;
    const capable = !m.requires || (m.requires === 'fts5' && caps.fts5);
    db.exec('BEGIN IMMEDIATE');
    try {
      if (capable) {
        db.exec(m.sql);
        applied.push(`${m.version}_${m.name}`);
      } else {
        skipped.push(`${m.version}_${m.name}`);
      }
      // user_version cannot take a bound parameter.
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw new Error(`マイグレーション ${m.version}_${m.name} に失敗しました: ${(e as Error).message}`);
    }
  }

  // FTS5 なしランタイムで skip したまま user_version が進んだ DB の救済。
  // skip しても version は進める(進めないと後続 migration が止まる)ため、
  // ランタイムが FTS5 対応になった時点でここで遅延適用する。既存コメントの
  // バックフィルは 002 に無い(適用時点では comment が空の前提)ので併せて行う。
  if (caps.fts5 && !hasTable(db, 'comment_fts')) {
    const fts = MIGRATIONS.find((m) => m.requires === 'fts5');
    if (fts && fts.version <= currentVersion(db)) {
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec(fts.sql);
        db.exec('INSERT INTO comment_fts(rowid, content) SELECT rowid, content FROM comment');
        db.exec('COMMIT');
        applied.push(`${fts.version}_${fts.name} (retro)`);
      } catch (e) {
        db.exec('ROLLBACK');
        throw new Error(`マイグレーション ${fts.version}_${fts.name} (retro) に失敗しました: ${(e as Error).message}`);
      }
    }
  }

  return { from, to: currentVersion(db), applied, skipped };
}
