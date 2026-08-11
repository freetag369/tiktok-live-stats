import type { DatabaseSync } from 'node:sqlite';
import INIT_SQL from './001_init.sql?raw';
import FTS_SQL from './002_fts.sql?raw';
import LIKE_DEDUPE_SQL from './003_like_dedupe_and_room_counts.sql?raw';
import CLEAR_AVG_SQL from './004_clear_stale_avg_viewers.sql?raw';

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

  return { from, to: currentVersion(db), applied, skipped };
}
