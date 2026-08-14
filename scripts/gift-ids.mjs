#!/usr/bin/env node
/**
 * Prints the giftId of every gift this installation has ever received.
 *
 * The UI shows gift *names* (COALESCE(gc.name, ge.gift_name, ge.gift_id)) — the
 * id only ever surfaces when the name is missing, so there is no in-app way to
 * read the giftId of a gift you can already name. Challenge triggers
 * (fanStamp / tapBoost / roulette / fx-cut) want the id, because names are
 * localised and change per region.
 *
 * gift_catalog is upserted on every gift event, so: receive the gift once
 * (10 coins to yourself is enough), close nothing, then run this and take the
 * top row — it sorts by last_seen_ms, newest first.
 *
 * The db is copied to a temp folder before opening: the app holds it in WAL mode
 * while running, and copying db+wal+shm together is the only way to see rows
 * that are still in the wal.
 *
 * Usage:
 *   node scripts/gift-ids.mjs                # both databases, newest first
 *   node scripts/gift-ids.mjs panther        # filter by name substring
 */
import { copyFileSync, existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** Where a build keeps config/ and (by default) db/. */
function dataDirs() {
  const out = [];
  const appData = process.env.APPDATA;
  // Installed AND `npm run dev` both land here: paths.ts only redirects userData
  // for the portable build.
  if (appData) out.push(['インストール版/dev', join(appData, 'tiktok-live-stats')]);
  // Portable: <exe folder>/TikTokLiveStats-data. Search upwards from the repo.
  for (const up of ['..', '../..', '.']) {
    out.push(['ポータブル版', join(process.cwd(), up, 'TikTokLiveStats-data')]);
  }
  return out;
}

/**
 * The db is NOT always under the data dir: settings.dbPath overrides it, and the
 * first-run "adopt an existing database" offer sets it to a folder that has
 * nothing to do with the running build. Reading only the default location shows
 * a stale db and reports a gift you just received as missing.
 */
function candidates() {
  const out = [];
  for (const [label, dir] of dataDirs()) {
    out.push([`${label} 既定`, join(dir, 'db', 'analytics.db')]);
    try {
      const cfg = JSON.parse(readFileSync(join(dir, 'config', 'settings.json'), 'utf8'));
      if (typeof cfg.dbPath === 'string' && cfg.dbPath) out.push([`${label} settings.dbPath`, cfg.dbPath]);
    } catch {
      // 設定が無い/壊れている場合は既定パスだけ見る
    }
  }
  return out.filter(([, p]) => existsSync(p));
}

function openCopy(src) {
  const dir = mkdtempSync(join(tmpdir(), 'giftids-'));
  const dst = join(dir, 'a.db');
  copyFileSync(src, dst);
  for (const ext of ['-wal', '-shm']) {
    if (existsSync(src + ext)) copyFileSync(src + ext, dst + ext);
  }
  return new DatabaseSync(dst, { readOnly: true });
}

const needle = (process.argv[2] ?? '').toLowerCase();
const seen = new Set();

for (const [label, path] of candidates()) {
  if (seen.has(path)) continue;
  seen.add(path);
  let db;
  try {
    db = openCopy(path);
  } catch (e) {
    console.log(`\n[${label}] ${path} — 開けませんでした: ${e.message}`);
    continue;
  }
  const rows = db
    .prepare(
      `SELECT gc.gift_id, gc.name, gc.diamond_count, gc.gift_type, gc.last_seen_ms,
              (SELECT COUNT(*) FROM gift_event ge WHERE ge.gift_id = gc.gift_id) AS hits
         FROM gift_catalog gc
        ORDER BY gc.last_seen_ms DESC`
    )
    .all()
    .filter((r) => !needle || String(r.name ?? '').toLowerCase().includes(needle) || String(r.gift_id).includes(needle));
  db.close();

  console.log(`\n[${label}] ${path}  (${rows.length}件)`);
  if (!rows.length) {
    console.log('  該当なし — そのギフトをまだ一度も受け取っていません。');
    continue;
  }
  console.log('  giftId      ダイヤ  種別  受信  最終受信            名前');
  for (const r of rows) {
    const when = r.last_seen_ms ? new Date(Number(r.last_seen_ms)).toLocaleString('ja-JP') : '-';
    console.log(
      `  ${String(r.gift_id).padEnd(11)} ${String(r.diamond_count ?? '-').padStart(5)}  ` +
        `${String(r.gift_type ?? '-').padStart(3)}  ${String(r.hits).padStart(4)}  ${when.padEnd(19)} ${r.name ?? '(名前未取得)'}`
    );
  }
}

if (!seen.size) console.log('analytics.db が見つかりませんでした。');
