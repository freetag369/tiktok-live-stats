import { defineConfig } from '@playwright/test';

/**
 * 実アプリ(Electron)起動の E2E。vitest(test/**\/*.spec.ts)とは完全に別物。
 *
 * 衝突回避は**二重**にしてある:
 *   1. ディレクトリ  e2e/ は test/ の外なので vitest の include に構造的に当たらない
 *   2. 拡張子        *.e2e.ts なので、将来 include が広がっても拾われない
 */
const CI = !!process.env.CI;

export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',

  // Electron 起動(3〜5秒) + worker boot + sqlite マイグレーション + リプレイの
  // ドレインが1テストに収まる幅。GitHub の windows ランナーは素のマシンの約4倍
  // 遅い実測がある(session-soak が 10秒 → 41秒)ので CI は倍に取る。
  timeout: CI ? 120_000 : 60_000,
  expect: { timeout: CI ? 20_000 : 10_000 },
  globalTimeout: CI ? 20 * 60_000 : 0,

  // 1プロセス = 1 Electron。並列化しない理由:
  //  (1) globalShortcut は OS グローバルで、2個目の register が必ず失敗する
  //  (2) 各インスタンスが sqlite + Chromium + worker で数百MB 食う
  //  (3) 失敗時のログ(diag)が交錯すると原因追跡が破綻する
  workers: 1,
  fullyParallel: false,
  forbidOnly: CI,
  retries: CI ? 2 : 0,

  reporter: CI ? [['list'], ['html', { open: 'never' }], ['github']] : [['list'], ['html', { open: 'never' }]],

  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // 演出は動画だらけで録画が巨大化するうえ、Electron page の録画は不安定。
    video: 'off',
  },

  outputDir: 'test-results',
});
