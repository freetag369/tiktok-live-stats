// Spike: node:sqlite capability probe.
// Answers OQ-3 (FTS5?) and measures insert throughput against the ~170 rows/sec we need.
import { DatabaseSync } from 'node:sqlite';

const db = new DatabaseSync(':memory:');

const compile = db.prepare('SELECT compile_options AS o FROM pragma_compile_options').all().map((r) => r.o);
const has = (needle) => compile.some((o) => o.includes(needle));

const caps = {
  node: process.version,
  sqlite: db.prepare('SELECT sqlite_version() AS v').get().v,
  fts5: has('ENABLE_FTS5'),
  json1: !has('OMIT_JSON'),
  mathFns: has('ENABLE_MATH_FUNCTIONS'),
  windowFns: !has('OMIT_WINDOWFUNC'),
};

// STRICT + WITHOUT ROWID + partial unique index — everything the real schema leans on.
db.exec(`
  CREATE TABLE bench (id TEXT PRIMARY KEY, uid TEXT NOT NULL, n INTEGER NOT NULL, s TEXT) STRICT;
  CREATE TABLE bucket (sid INTEGER NOT NULL, uid TEXT NOT NULL, b INTEGER NOT NULL, likes INTEGER NOT NULL,
    PRIMARY KEY (sid, uid, b)) STRICT, WITHOUT ROWID;
  CREATE UNIQUE INDEX bench_grp ON bench(uid, n) WHERE s IS NOT NULL AND s <> '';
`);

const ins = db.prepare('INSERT OR IGNORE INTO bench(id, uid, n, s) VALUES (?, ?, ?, ?)');
const N = 100_000;
const t0 = performance.now();
db.exec('BEGIN IMMEDIATE');
for (let i = 0; i < N; i++) ins.run(`m${i}`, `${7000000000000000000n + BigInt(i % 5000)}`, i, `コメント${i}`);
db.exec('COMMIT');
const t1 = performance.now();

// Idempotency: the exact dedupe strategy the ingest path depends on.
db.exec('BEGIN IMMEDIATE');
for (let i = 0; i < 1000; i++) ins.run(`m${i}`, 'x', i, 's');
db.exec('COMMIT');

const upsert = db.prepare(
  'INSERT INTO bucket(sid, uid, b, likes) VALUES (?,?,?,?) ON CONFLICT(sid,uid,b) DO UPDATE SET likes = likes + excluded.likes'
);
db.exec('BEGIN IMMEDIATE');
for (let i = 0; i < 20_000; i++) upsert.run(1, `u${i % 500}`, (i % 60) * 10_000, 3);
db.exec('COMMIT');

const result = {
  caps,
  insertRows: N,
  insertMs: Math.round(t1 - t0),
  rowsPerSec: Math.round(N / ((t1 - t0) / 1000)),
  rowsAfterDuplicateReplay: db.prepare('SELECT COUNT(*) AS c FROM bench').get().c,
  bucketRows: db.prepare('SELECT COUNT(*) AS c FROM bucket').get().c,
  bucketLikeSum: db.prepare('SELECT SUM(likes) AS s FROM bucket').get().s,
  int64RoundTrip: db.prepare('SELECT uid FROM bench WHERE n = 0').get().uid,
};

if (process.send) process.send(result);
else console.log(JSON.stringify(result, null, 2));
