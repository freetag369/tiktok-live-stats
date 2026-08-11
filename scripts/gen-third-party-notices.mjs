#!/usr/bin/env node
/**
 * Generates THIRD-PARTY-NOTICES.md from the installed dependency tree.
 *
 * Everything in `dependencies`/`devDependencies` that ends up inside the shipped
 * bundles must be attributed. The two AGPL packages are called out separately —
 * they are the reason this whole app is AGPL.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = 'node_modules';
const LICENSE_FILES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING', 'license'];

/** Packages actually reachable from the shipped bundles. */
const SHIPPED = new Set([
  'tiktok-live-connector',
  'tiktok-live-proto',
  'tiktok-live-api-sdk',
  '@bufbuild/protobuf',
  'got',
  'ws',
  'typed-emitter',
  'react',
  'react-dom',
  'zustand',
  '@tanstack/react-virtual',
  'electron',
]);

function pkgDirs(dir, depth = 0) {
  const out = [];
  if (!existsSync(dir) || depth > 1) return out;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (!statSync(p).isDirectory()) continue;
    if (name.startsWith('@')) {
      out.push(...pkgDirs(p, depth + 1).map((x) => x));
      continue;
    }
    if (existsSync(join(p, 'package.json'))) out.push(p);
  }
  return out;
}

const entries = [];
for (const dir of pkgDirs(ROOT)) {
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  } catch {
    continue;
  }
  if (!pkg.name) continue;
  const licFile = LICENSE_FILES.map((f) => join(dir, f)).find((f) => existsSync(f));
  entries.push({
    name: pkg.name,
    version: pkg.version ?? '',
    license: pkg.license ?? (pkg.licenses?.[0]?.type ?? 'UNKNOWN'),
    repo: typeof pkg.repository === 'string' ? pkg.repository : (pkg.repository?.url ?? ''),
    text: licFile ? readFileSync(licFile, 'utf8') : '',
    shipped: SHIPPED.has(pkg.name),
  });
}
entries.sort((a, b) => a.name.localeCompare(b.name));

const agpl = entries.filter((e) => /AGPL/i.test(e.license));
const lines = [];
lines.push('# 使用しているソフトウェア / Third-Party Notices');
lines.push('');
lines.push('このアプリは以下のオープンソースソフトウェアを利用しています。');
lines.push('');
lines.push('## このアプリが AGPL-3.0 である理由');
lines.push('');
if (agpl.length) {
  for (const e of agpl) {
    lines.push(`- **${e.name}@${e.version}** — ${e.license}`);
  }
  lines.push('');
  lines.push('これらは TikTok LIVE への接続に必須で、実行ファイル内にバンドルされています。');
  lines.push('そのため本アプリ全体が AGPL-3.0 で配布されます（SOURCE-OFFER.txt 参照）。');
} else {
  lines.push('（AGPL のパッケージは検出されませんでした）');
}
lines.push('');
lines.push('## 一覧');
lines.push('');
lines.push('| パッケージ | バージョン | ライセンス | 同梱 |');
lines.push('|---|---|---|---|');
for (const e of entries) {
  lines.push(`| ${e.name} | ${e.version} | ${e.license} | ${e.shipped ? '✔' : ''} |`);
}
lines.push('');
lines.push('## ライセンス全文（同梱パッケージ）');
lines.push('');
for (const e of entries.filter((x) => x.shipped && x.text)) {
  lines.push(`### ${e.name}@${e.version} (${e.license})`);
  if (e.repo) lines.push(`${e.repo}`);
  lines.push('');
  lines.push('```');
  lines.push(e.text.trim());
  lines.push('```');
  lines.push('');
}

writeFileSync('THIRD-PARTY-NOTICES.md', lines.join('\n'), 'utf8');
console.log(`THIRD-PARTY-NOTICES.md: ${entries.length} パッケージ (AGPL: ${agpl.length})`);
