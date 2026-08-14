#!/usr/bin/env node
/**
 * Prints the emoteId of every subscriber stamp seen in a debug capture.
 *
 * Stamps cannot come from analytics.db the way giftIds do (see gift-ids.mjs):
 * apply.ts treats `emote` as an engagement signal only and stores no row, so the
 * id exists solely in the NDJSON written by the 「デバッグ記録」 toggle
 * (capture.ts -> <dataDir>/captures/capture-*.ndjson).
 *
 * Procedure: Settings -> 「デバッグ記録」 ON -> reconnect -> have the stamp
 * posted in chat once -> run this. Gifts in the same capture are listed too,
 * which is the offline answer when a gift name is localised and you only have
 * the icon to go on.
 *
 * Usage:
 *   node scripts/emote-ids.mjs                     # newest capture in every known folder
 *   node scripts/emote-ids.mjs --all               # every capture, not just the newest
 *   node scripts/emote-ids.mjs path/to/x.ndjson    # one specific file
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join } from 'node:path';

const args = process.argv.slice(2);
const all = args.includes('--all');
const explicit = args.filter((a) => !a.startsWith('--'));

/** Same two data dirs paths.ts picks between, plus the dev-run folder. */
function captureDirs() {
  const dirs = [];
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'tiktok-live-stats', 'captures'));
  for (const up of ['..', '../..', '.']) {
    dirs.push(join(process.cwd(), up, 'TikTokLiveStats-data', 'captures'));
  }
  dirs.push(join(process.cwd(), 'captures'));
  return dirs.filter((d) => existsSync(d));
}

function filesToScan() {
  if (explicit.length) return explicit;
  const out = [];
  for (const dir of captureDirs()) {
    const found = readdirSync(dir)
      .filter((f) => f.endsWith('.ndjson'))
      .map((f) => join(dir, f))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    out.push(...(all ? found : found.slice(0, 1)));
  }
  return out;
}

/** ImageModel -> first usable URL (ids.ts pickUrl, duplicated to keep this script dependency-free). */
function pickUrl(img) {
  const list = img?.urlList;
  if (Array.isArray(list)) for (const u of list) if (typeof u === 'string' && u) return u;
  return '';
}

const emotes = new Map(); // emoteId -> { n, url, senders:Set }
const gifts = new Map(); // giftId  -> { n, name, diamonds, url }
let lines = 0;

async function scan(path) {
  const rl = createInterface({ input: createReadStream(path, 'utf8'), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    lines++;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue; // 途中で電源が落ちた capture は最終行が壊れている
    }
    const d = rec?.data;
    if (!d) continue;

    if (rec.type === 'WebcastEmoteChatMessage') {
      for (const item of Array.isArray(d.emoteList) ? d.emoteList : []) {
        const em = item?.emote ?? item;
        const id = String(em?.emoteId ?? item?.emoteId ?? '');
        if (!id) continue;
        let e = emotes.get(id);
        if (!e) emotes.set(id, (e = { n: 0, url: '', senders: new Set() }));
        e.n++;
        e.url ||= pickUrl(em?.image);
        const who = d.user?.nickname ?? d.user?.displayId;
        if (who) e.senders.add(String(who));
      }
    }

    if (rec.type === 'WebcastGiftMessage') {
      const id = String(d.gift?.id ?? d.giftId ?? '');
      if (!id) continue;
      let g = gifts.get(id);
      if (!g) gifts.set(id, (g = { n: 0, name: '', diamonds: null, url: '' }));
      g.n++;
      g.name ||= String(d.gift?.name ?? '');
      g.diamonds ??= d.gift?.diamondCount ?? null;
      g.url ||= pickUrl(d.gift?.icon) || pickUrl(d.gift?.image);
    }
  }
}

const files = filesToScan();
if (!files.length) {
  console.log('capture-*.ndjson が見つかりませんでした。');
  console.log('設定 →「デバッグ記録（不具合の再現用にイベントを保存）」をONにして接続し直してください。');
  process.exit(0);
}

for (const f of files) {
  console.log(`読み込み: ${f}`);
  await scan(f);
}
console.log(`${lines} 行を走査しました。\n`);

console.log(`## スタンプ (emoteId) — ${emotes.size}件`);
if (!emotes.size) {
  console.log('  該当なし — この記録の間にスタンプが1つも流れていません。');
} else {
  for (const [id, e] of [...emotes].sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${id}  ${String(e.n).padStart(4)}回  ${[...e.senders].slice(0, 3).join(', ')}`);
    if (e.url) console.log(`      ${e.url}`);
  }
}

console.log(`\n## ギフト (giftId) — ${gifts.size}件`);
for (const [id, g] of [...gifts].sort((a, b) => b[1].n - a[1].n)) {
  console.log(`  ${id.padEnd(11)} ${String(g.diamonds ?? '-').padStart(5)}💎 ${String(g.n).padStart(4)}回  ${g.name}`);
}
