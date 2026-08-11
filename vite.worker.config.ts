import { resolve } from 'node:path';
import { defineConfig } from 'vite';

/**
 * The 4th build target electron-vite does not provide.
 *
 * The worker MUST be ESM: `tiktok-live-connector@2.4.3` is ESM-only (its exports
 * map has no `require` condition), as is its dep `got@15`. Bundling it to CJS
 * produces "Dynamic require of 'events' is not supported" at runtime.
 *
 * Everything is inlined into a single index.mjs so asar/node_modules resolution
 * never enters the picture. Every dep in the graph is pure JS.
 */
export default defineConfig({
  define: {
    // The worker is a Node process; some deps probe for a browser build.
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  resolve: {
    alias: {
      '@shared': resolve('src/shared'),
      '@worker': resolve('src/worker'),
    },
    // Force the Node condition so `got`/`ws` do not resolve to browser shims.
    conditions: ['node', 'import', 'module', 'default'],
  },
  // Vite's SSR build externalizes every dependency by default. That is exactly
  // wrong here: `files:` in electron-builder.yml does not ship node_modules, so
  // an externalized import resolves to nothing in the packaged app.
  ssr: {
    noExternal: true,
    external: ['electron', 'bufferutil', 'utf-8-validate'],
  },
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'out/worker',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    lib: {
      entry: resolve('src/worker/index.ts'),
      formats: ['es'],
      fileName: () => 'index.mjs',
    },
    rollupOptions: {
      // `electron` is provided by the host. Node builtins stay external.
      // `bufferutil`/`utf-8-validate` are OPTIONAL native deps of `ws` — never bundle them.
      external: [
        'electron',
        'bufferutil',
        'utf-8-validate',
        /^node:/,
        ...['fs', 'path', 'os', 'crypto', 'http', 'https', 'net', 'tls', 'zlib', 'stream', 'util', 'events', 'url', 'buffer', 'worker_threads', 'perf_hooks', 'child_process', 'dns', 'string_decoder', 'assert', 'querystring', 'timers', 'tty', 'v8', 'async_hooks', 'diagnostics_channel'],
      ],
      output: { inlineDynamicImports: true },
    },
  },
});
