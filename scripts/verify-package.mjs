#!/usr/bin/env node
/**
 * Asserts the packaged output is actually runnable.
 *
 * The single highest-risk unknown in this stack is the ESM worker: it is started
 * by utilityProcess.fork and must live OUTSIDE app.asar, because Node's ESM
 * loader resolving through Electron's asar fs patches is fragile. If asarUnpack
 * is ever dropped from electron-builder.yml the app builds fine and then fails at
 * runtime, on the user's machine, with no database.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const releaseDir = join('release', version);
const isMac = process.platform === 'darwin';

let failures = 0;
const ok = (m) => console.log(`  OK   ${m}`);
const bad = (m) => {
  console.error(`  FAIL ${m}`);
  failures++;
};

console.log(`パッケージ検証: ${releaseDir}`);

if (!existsSync(releaseDir)) {
  console.error(`${releaseDir} がありません。先に npm run build:${isMac ? 'mac' : 'win'} を実行してください。`);
  process.exit(1);
}

const files = readdirSync(releaseDir);

/** THE check this script exists for — shared between win-unpacked and the .app bundle. */
function checkResources(resourcesDir) {
  const workerPath = join(resourcesDir, 'app.asar.unpacked', 'out', 'worker', 'index.mjs');
  if (!existsSync(workerPath)) {
    bad('out/worker/index.mjs が app.asar.unpacked にありません（electron-builder.yml の asarUnpack を確認）');
  } else {
    const src = readFileSync(workerPath, 'utf8');
    ok(`worker: ${(statSync(workerPath).size / 1024 / 1024).toFixed(1)} MB`);
    /^import\s|\bexport\s/m.test(src) ? ok('worker は ESM 形式') : bad('worker が ESM ではありません');
    // Everything must be inlined: `files:` does not ship node_modules.
    const external = [...src.matchAll(/^import\s.*?from\s+["']([^"']+)["']/gm)]
      .map((m) => m[1])
      .filter((s) => !s.startsWith('node:') && !isBuiltin(s));
    external.length === 0
      ? ok('外部依存なし（すべてバンドル済み）')
      : bad(`バンドルされていない依存があります: ${[...new Set(external)].join(', ')}`);
    src.includes('tiktok-live-connector') || src.includes('TikTokLiveConnection')
      ? ok('TikTok 接続ライブラリが同梱されています')
      : bad('TikTok 接続ライブラリが見当たりません');
  }

  for (const doc of ['LICENSE', 'SOURCE-OFFER.txt']) {
    existsSync(join(resourcesDir, doc)) ? ok(`同梱: ${doc}`) : bad(`AGPL 対応物が同梱されていません: ${doc}`);
  }
  // 「ソースコードを保存」(file.saveSource)はこのパスを探す。無いと packaged で必ず失敗する。
  existsSync(join(resourcesDir, `tiktok-live-stats-source-${version}.zip`))
    ? ok('同梱: ソースアーカイブ zip')
    : bad('ソースアーカイブ zip が resources に同梱されていません（release:* は source:zip → build:* の順で）');
  existsSync(join(resourcesDir, 'app-resources', 'missions.default.json'))
    ? ok('同梱: missions.default.json')
    : bad('resources/ が同梱されていません');
}

if (isMac) {
  const dmg = files.find((f) => /-mac-universal\.dmg$/i.test(f));
  dmg ? ok(`dmg: ${dmg}`) : bad('universal dmg が見つかりません');

  const appDir = join(releaseDir, 'mac-universal', 'TikTokLiveStats.app');
  if (!existsSync(appDir)) {
    bad('mac-universal/TikTokLiveStats.app がありません');
  } else {
    const resourcesDir = join(appDir, 'Contents', 'Resources');
    checkResources(resourcesDir);
    // universal マージ確認: 両アーキの asar が 1 つに collapse されているはず。
    const asars = readdirSync(resourcesDir).filter((f) => /^app.*\.asar$/.test(f));
    asars.length === 1 && asars[0] === 'app.asar'
      ? ok('app.asar は 1 つ（universal マージ成功）')
      : bad(`app.asar が想定外です: ${asars.join(', ') || 'なし'}`);
  }
} else {
  const setup = files.find((f) => /Setup.*\.exe$/i.test(f));
  const portable = files.find((f) => /Portable.*\.exe$/i.test(f));
  setup ? ok(`インストーラ: ${setup}`) : bad('NSIS インストーラが見つかりません');
  portable ? ok(`ポータブル: ${portable}`) : bad('ポータブル exe が見つかりません');

  const unpackedDir = join(releaseDir, 'win-unpacked');
  if (!existsSync(unpackedDir)) {
    bad('win-unpacked がありません');
  } else {
    checkResources(join(unpackedDir, 'resources'));
  }
}

const sourceZip = files.find((f) => /source-.*\.zip$/i.test(f));
sourceZip ? ok(`ソースアーカイブ: ${sourceZip}`) : bad('ソースアーカイブがありません（npm run source:zip）');

function isBuiltin(s) {
  return [
    'fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'zlib', 'stream', 'util', 'events', 'url',
    'buffer', 'worker_threads', 'perf_hooks', 'child_process', 'dns', 'string_decoder', 'assert', 'querystring',
    'timers', 'tty', 'v8', 'async_hooks', 'diagnostics_channel', 'http2', 'readline', 'electron',
  ].includes(s);
}

console.log(failures === 0 ? '\n✔ すべて OK' : `\n✘ ${failures} 件の問題`);
process.exit(failures === 0 ? 0 : 1);
