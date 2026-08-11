import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@worker': resolve('src/worker'),
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
