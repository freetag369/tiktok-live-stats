#!/usr/bin/env node
/**
 * Replay a captured stream through the real ingest path.
 *
 * Two modes:
 *   node scripts/replay.mjs                 -> run the committed fixture suite
 *   node scripts/replay.mjs <file.ndjson>   -> replay one capture and print a summary
 *
 * Captures come from `npm run dump:fields` or from the 「デバッグ記録」 toggle in
 * the app's settings, so every bug report can arrive with a reproducible fixture.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const file = process.argv[2];

if (!file) {
  const r = spawnSync('npx', ['vitest', 'run', 'test/integration/replay.spec.ts'], { stdio: 'inherit', shell: true });
  process.exit(r.status ?? 1);
}

if (!existsSync(file)) {
  console.error(`ファイルがありません: ${file}`);
  process.exit(1);
}

// One-off captures run through the same spec, parameterised by env.
const r = spawnSync('npx', ['vitest', 'run', 'test/integration/replay.spec.ts'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, REPLAY_FIXTURE: file },
});
process.exit(r.status ?? 1);
