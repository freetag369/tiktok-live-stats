#!/usr/bin/env node
/**
 * Day-0 field dump. Plain Node, no Electron.
 *
 * The library's README documents v1 field names but emits the v3 protobuf
 * verbatim, so copying README snippets produces a database full of NULL with no
 * runtime error. This captures one real sample of every message type and reports
 * which field paths are actually populated.
 *
 * Also answers the open questions that only a live room can settle:
 *   - is common.createTime epoch seconds or milliseconds?
 *   - is the on-screen viewer count roomUser.totalUser or roomUser.total?
 *   - does MEMBER re-fire for the same user within one session?
 *   - what is the real giftId of "Heart Me"?
 *
 * Usage:
 *   node scripts/dump-fields.mjs <username> [--minutes 20] [--key <eulerApiKey>]
 */
import { mkdirSync, createWriteStream, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ControlEvent, SignConfig, TikTokLiveConnection } from 'tiktok-live-connector';

const args = process.argv.slice(2);
const username = args.find((a) => !a.startsWith('--'));
const minutes = Number(args[args.indexOf('--minutes') + 1]) || 20;
const key = args.includes('--key') ? args[args.indexOf('--key') + 1] : process.env.SIGN_API_KEY;

if (!username) {
  console.error('使い方: node scripts/dump-fields.mjs <ユーザー名> [--minutes 20] [--key <APIキー>]');
  process.exit(1);
}
if (key) SignConfig.apiKey = key;

const outDir = join(process.cwd(), 'captures');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const ndjson = createWriteStream(join(outDir, `fields-${stamp}.ndjson`), { encoding: 'utf8' });

const startMs = Date.now();
ndjson.write(`${JSON.stringify({ o: -1, meta: { username, capturedAt: new Date().toISOString() } })}\n`);

/** type -> { count, fields: Map<path, {types:Set, sample}> } */
const seen = new Map();
const memberFires = new Map();
const giftNames = new Map();
const roomCounts = [];

function walk(obj, prefix, out, depth = 0) {
  if (depth > 4 || obj == null) return;
  for (const [k, v] of Object.entries(obj)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (v == null || v === '' || (Array.isArray(v) && v.length === 0)) continue;
    if (typeof v === 'object' && !Array.isArray(v) && !(v instanceof Uint8Array)) {
      walk(v, path, out, depth + 1);
      continue;
    }
    let e = out.get(path);
    if (!e) {
      e = { types: new Set(), sample: undefined, n: 0 };
      out.set(path, e);
    }
    e.types.add(Array.isArray(v) ? 'array' : typeof v);
    e.n++;
    if (e.sample === undefined) {
      e.sample = Array.isArray(v) ? v.slice(0, 1) : v instanceof Uint8Array ? `<${v.length} bytes>` : v;
    }
  }
}

const conn = new TikTokLiveConnection(username, {
  processInitialData: true,
  fetchRoomInfoOnConnect: true,
  enableExtendedGiftInfo: false,
  ...(key ? { signApiKey: key } : {}),
});

// MUST be attached before connect(): the library drops errors when there is no
// listener, and never rethrows them.
conn.on(ControlEvent.ERROR, (e) => console.error('[error]', e?.info ?? '', e?.exception?.message ?? ''));

conn.on(ControlEvent.DECODED_DATA, (method, decoded) => {
  const type = decoded?.type ?? method;
  const data = decoded && 'data' in decoded ? decoded.data : decoded;
  if (!data || typeof data !== 'object') return;

  ndjson.write(`${JSON.stringify({ o: Date.now() - startMs, type, data })}\n`);

  let e = seen.get(type);
  if (!e) {
    e = { count: 0, fields: new Map() };
    seen.set(type, e);
  }
  e.count++;
  walk(data, '', e.fields);

  if (type === 'WebcastMemberMessage') {
    const uid = String(data.user?.idStr ?? data.user?.id ?? '');
    memberFires.set(uid, (memberFires.get(uid) ?? 0) + 1);
  }
  if (type === 'WebcastGiftMessage') {
    const id = String(data.gift?.id ?? data.giftId ?? '');
    const name = String(data.gift?.name ?? '');
    if (id) giftNames.set(id, { name, diamonds: data.gift?.diamondCount, type: data.gift?.type });
  }
  if (type === 'WebcastRoomUserSeqMessage') {
    roomCounts.push({
      at: new Date().toISOString().slice(11, 19),
      total: data.total,
      totalUser: data.totalUser,
      popularity: data.popularity,
      anonymous: data.anonymous,
    });
  }
});

function report() {
  const lines = [];
  lines.push(`# フィールドダンプ結果  @${username}`);
  lines.push(`取得: ${new Date().toISOString()}  /  ${Math.round((Date.now() - startMs) / 60000)}分`);
  lines.push('');

  // OQ-1: seconds or milliseconds?
  const chat = seen.get('WebcastChatMessage');
  const ct = chat?.fields.get('common.createTime');
  if (ct) {
    const n = Number(ct.sample);
    lines.push(`## OQ-1 タイムスタンプ`);
    lines.push(`common.createTime = ${ct.sample} (${[...ct.types].join('|')})`);
    lines.push(`  -> ${n < 1e12 ? '**秒**（1000倍が必要）' : '**ミリ秒**'}  現在時刻=${Date.now()}`);
    lines.push('');
  }

  // OQ-2: which field is the on-screen viewer count?
  if (roomCounts.length) {
    lines.push('## OQ-2 同接カウント（TikTokアプリの表示と見比べてください）');
    lines.push('時刻      total     totalUser popularity anonymous');
    for (const r of roomCounts.slice(-15)) {
      lines.push(
        `${r.at}  ${String(r.total).padEnd(9)} ${String(r.totalUser).padEnd(9)} ${String(r.popularity).padEnd(10)} ${r.anonymous}`
      );
    }
    lines.push('');
  }

  // OQ-5: does MEMBER re-fire for the same viewer?
  const dupes = [...memberFires.values()].filter((n) => n > 1).length;
  lines.push('## OQ-5 入室イベントの重複');
  lines.push(`ユニークユーザー ${memberFires.size} / 2回以上発火 ${dupes}`);
  lines.push(dupes > 0 ? '-> 来店回数のデバウンスが必要です。' : '-> 重複なし。');
  lines.push('');

  // Heart Me — the headline metric silently reports zero if this id is wrong.
  lines.push('## ギフト一覧（ハートミーの giftId 確認用）');
  for (const [id, g] of giftNames) {
    const mark = /heart\s*me/i.test(g.name) ? '  <<<< ハートミー' : '';
    lines.push(`${id}\t${g.name}\t${g.diamonds}💎\ttype=${g.type}${mark}`);
  }
  lines.push('');

  lines.push('## メッセージ種別ごとの実フィールド');
  for (const [type, e] of [...seen.entries()].sort((a, b) => b[1].count - a[1].count)) {
    lines.push(`\n### ${type}  (${e.count}件)`);
    for (const [path, f] of [...e.fields.entries()].sort()) {
      lines.push(`  ${path}: ${[...f.types].join('|')} = ${JSON.stringify(f.sample)?.slice(0, 90)}`);
    }
  }

  const p = join(outDir, `fields-${stamp}.md`);
  writeFileSync(p, lines.join('\n'), 'utf8');
  console.log(`\nレポート: ${p}`);
  console.log(`キャプチャ: ${join(outDir, `fields-${stamp}.ndjson`)}`);
}

async function main() {
  console.log(`@${username} に接続します… (${minutes}分)`);
  if (!key) console.log('※ APIキー未設定: 1日100回までの制限で動作します。');
  const state = await conn.connect();
  console.log(`接続しました roomId=${state.roomId}`);

  const stop = async () => {
    try {
      await conn.disconnect();
    } catch {
      /* ignore */
    }
    ndjson.end();
    report();
    process.exit(0);
  };

  process.on('SIGINT', stop);
  setTimeout(stop, minutes * 60_000);
}

main().catch((e) => {
  console.error('接続に失敗しました:', e?.message ?? e);
  process.exit(1);
});
