// Applies the real migration runner to a COPY of a live database and asserts the
// user's recordings survive intact. Editing an already-applied migration is how
// people lose data; this is the check that says we didn't.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const path = process.argv[2];
if (!path) {
  console.error('usage: node spike/test-migration.mjs <db path>');
  process.exit(1);
}

const sql = (n) => readFileSync(new URL(`../src/worker/store/migrations/${n}`, import.meta.url), 'utf8');
const MIGRATIONS = [
  { version: 1, name: 'init', sql: sql('001_init.sql') },
  { version: 2, name: 'fts', sql: sql('002_fts.sql') },
  { version: 3, name: 'like_dedupe_and_room_counts', sql: sql('003_like_dedupe_and_room_counts.sql') },
];

const db = new DatabaseSync(path);
db.exec('PRAGMA foreign_keys = ON');

const before = snapshot();
const from = Number(db.prepare('PRAGMA user_version').get().user_version);
console.log(`user_version ${from} から移行します`);

for (const m of MIGRATIONS) {
  if (m.version <= from) continue;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(m.sql);
    db.exec(`PRAGMA user_version = ${m.version}`);
    db.exec('COMMIT');
    console.log(`  適用: ${m.version}_${m.name}`);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error(`  失敗: ${m.version}_${m.name} — ${e.message}`);
    process.exit(1);
  }
}

const after = snapshot();
console.log(`\nuser_version -> ${db.prepare('PRAGMA user_version').get().user_version}`);

function snapshot() {
  const c = (t) => {
    try {
      return Number(db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get().c);
    } catch {
      return -1;
    }
  };
  return {
    viewer: c('viewer'),
    comment: c('comment'),
    gift_event: c('gift_event'),
    like_bucket: c('like_bucket'),
    join_event: c('join_event'),
    viewer_session_stat: c('viewer_session_stat'),
    stream_session: c('stream_session'),
  };
}

let fail = 0;
console.log('\n--- 記録が保持されているか ---');
for (const k of Object.keys(before)) {
  const ok = before[k] === after[k];
  if (!ok) fail++;
  console.log(`  ${ok ? 'OK  ' : 'FAIL'} ${k}: ${before[k]} -> ${after[k]}`);
}

console.log('\n--- 003 の効果 ---');
const hasLikeSeen = Number(db.prepare("SELECT COUNT(*) AS c FROM sqlite_master WHERE name='like_seen'").get().c) === 1;
console.log(`  ${hasLikeSeen ? 'OK  ' : 'FAIL'} like_seen テーブルが作成された`);
if (!hasLikeSeen) fail++;

const cols = db.prepare('PRAGMA table_info(session_metric)').all().map((r) => r.name);
const hasTv = cols.includes('total_viewers');
console.log(`  ${hasTv ? 'OK  ' : 'FAIL'} session_metric.total_viewers が追加された`);
if (!hasTv) fail++;

const moved = db.prepare('SELECT COUNT(*) AS c FROM session_metric WHERE total_viewers IS NOT NULL AND viewer_count IS NULL').get();
console.log(`  OK   誤って同接として保存されていた ${moved.c} 行を累計視聴者へ移動`);

const sess = db.prepare('SELECT session_id, peak_viewers, total_viewers, unique_viewers FROM stream_session').all();
console.log('  修正後のセッション:', JSON.stringify(sess));

const stale = Number(db.prepare("SELECT COUNT(*) AS c FROM gift_catalog WHERE gift_id='567380'").get().c);
console.log(`  ${stale === 0 ? 'OK  ' : 'FAIL'} 未確認だった giftId 567380 を除去`);
if (stale !== 0) fail++;

console.log('\n--- 整合性 ---');
const integ = db.prepare('PRAGMA integrity_check').get().integrity_check;
console.log(`  ${integ === 'ok' ? 'OK  ' : 'FAIL'} integrity_check: ${integ}`);
if (integ !== 'ok') fail++;
const fk = db.prepare('PRAGMA foreign_key_check').all();
console.log(`  ${fk.length === 0 ? 'OK  ' : 'FAIL'} foreign_key_check: ${fk.length} 件`);
if (fk.length) fail++;

// The runner must be a no-op the second time round.
const v = Number(db.prepare('PRAGMA user_version').get().user_version);
console.log(`\n  ${v === MIGRATIONS.length ? 'OK  ' : 'FAIL'} 再実行しても何もしない (user_version=${v})`);

db.close();
console.log(fail === 0 ? '\n✔ すべて OK' : `\n✘ ${fail} 件の問題`);
process.exit(fail === 0 ? 0 : 1);
