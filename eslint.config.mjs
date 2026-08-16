// Flat config。型情報つきルールは使わない(typecheck は tsc -b が担う)。
// 目的は「実行時バグに直結する見落とし」の検出で、スタイル警察ではない。
import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  {
    ignores: ['node_modules/**', 'out/**', 'release/**', 'build/**', 'coverage/**', '**/*.sql', '.claude/**', 'spike/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    // Node で動く生 JS(ビルドスクリプト・検証スクリプト・実験場)。
    files: ['scripts/**/*.mjs', 'spike/**/*.mjs', '*.mjs'],
    languageOptions: { globals: globals.node },
  },
  {
    // renderer は DOM、main/worker は Node。混在プロジェクトなので両方許す。
    // e2e は Playwright(Node)で走りつつ page.evaluate の中身は DOM。同じ理由でここへ。
    files: ['src/**/*.{ts,tsx}', 'test/**/*.ts', 'e2e/**/*.ts'],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      ...reactHooks.configs.recommended.rules,
      // v6 で追加された実験的ルール群は既存の設計(effect 内での派生 state 同期、
      // rAF コアレス等)と大量に衝突する。古典の2本だけを残す。
      'react-hooks/set-state-in-effect': 'off',
      'react-hooks/refs': 'off',
      'react-hooks/immutability': 'off',
      'react-hooks/preserve-manual-memoization': 'off',
      'react-hooks/static-components': 'off',
      'react-hooks/purity': 'off',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },
  {
    rules: {
      // tsc(strict) と重複・過剰なものを緩める。
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // `cond ? ok(...) : bad(...)` は検証スクリプトの意図的なイディオム。
      '@typescript-eslint/no-unused-expressions': ['error', { allowTernary: true, allowShortCircuit: true }],
      '@typescript-eslint/no-empty-object-type': 'off',
      // `void promise` は本プロジェクトの明示的 fire-and-forget 規約。
      'no-void': 'off',
      // エラー再ラップ時の cause 添付は任意(メッセージに原文を埋めている)。
      'preserve-caught-error': 'off',
      'no-useless-assignment': 'off',
    },
  }
);
