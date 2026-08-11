#!/usr/bin/env node
/**
 * AGPL-3.0 conveyance: produces the "Corresponding Source" archive that must be
 * available to anyone who receives a binary.
 *
 * Uses `git archive` so the archive is exactly the tracked tree at the commit the
 * binary was built from — no stray local files, nothing missing.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const version = pkg.version;
const outDir = join('release', version);
mkdirSync(outDir, { recursive: true });

let sha = 'unknown';
try {
  sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
} catch {
  console.error('警告: git リポジトリではありません。commit SHA を記録できません。');
}

let dirty = false;
try {
  dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0;
} catch {
  /* ignore */
}
if (dirty) {
  console.error('警告: 未コミットの変更があります。配布前にコミットしてください。');
  console.error('       （バイナリと公開ソースが一致しないと AGPL に違反します）');
}

const zipPath = join(outDir, `tiktok-live-stats-source-${version}.zip`);
try {
  execFileSync('git', ['archive', '--format=zip', `--prefix=tiktok-live-stats-${version}/`, '-o', zipPath, 'HEAD'], {
    stdio: 'inherit',
  });
  console.log(`ソースアーカイブ: ${zipPath}`);
} catch (e) {
  console.error('git archive に失敗しました:', e.message);
  process.exit(1);
}

// The exact commit must be identifiable FROM THE BINARY, so the offer travels
// with the installer as well as being shown on the ライセンス screen.
const offer = readFileSync('SOURCE-OFFER.txt', 'utf8').replace(/__COMMIT__/g, sha).replace(/__VERSION__/g, version);
writeFileSync(join(outDir, 'SOURCE-OFFER.txt'), offer, 'utf8');

if (!existsSync('THIRD-PARTY-NOTICES.md')) {
  console.error('警告: THIRD-PARTY-NOTICES.md がありません。npm run notices を実行してください。');
}
