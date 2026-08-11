import { resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

/**
 * The commit SHA is embedded in the binary and shown on the ライセンス screen.
 * AGPL §6 requires the conveyed source to be identifiable from the binary.
 */
function gitSha(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf8' }).trim();
  } catch {
    return 'unknown';
  }
}

const define = {
  __GIT_SHA__: JSON.stringify(gitSha()),
  __BUILD_TIME__: JSON.stringify(new Date().toISOString()),
};

const alias = {
  '@shared': resolve('src/shared'),
  '@main': resolve('src/main'),
  '@renderer': resolve('src/renderer'),
};

export default defineConfig({
  main: {
    // NOTE: `dependencies` is intentionally empty in package.json, so nothing is
    // externalized. electron-updater etc. must be BUNDLED — `files:` in
    // electron-builder.yml does not ship node_modules.
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    define,
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('src/main/index.ts') } },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: [] })],
    define,
    resolve: { alias },
    build: {
      rollupOptions: { input: { index: resolve('src/preload/index.ts') } },
    },
  },
  renderer: {
    root: resolve('src/renderer'),
    define,
    resolve: { alias },
    plugins: [react()],
    build: {
      // monitor.html はチャレンジモニター窓(第2ウィンドウ)。ここに追加を忘れる
      // と dev では動くのに packaged ビルドだけ真っ白になる。
      rollupOptions: {
        input: {
          index: resolve('src/renderer/index.html'),
          monitor: resolve('src/renderer/monitor.html'),
        },
      },
    },
  },
});
