import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@worker': resolve('src/worker'),
      '@main': resolve('src/main'),
      // src/main/paths.ts はモジュール評価時に app.getPath('userData') を呼ぶ
      // (ポータブル版が setPath する前の値を捕まえる意図的な設計)。素の Node では
      // electron が実行ファイルのパス文字列なので、import しただけで落ちる。
      // プロダクション側は動かせないので electron の方をスタブへ差し替える。
      electron: resolve('test/stubs/electron.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['test/**/*.spec.ts'],
    // node:sqlite is a release candidate and warns on every open.
    silent: false,
    pool: 'forks',
  },
});
