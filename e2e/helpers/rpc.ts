import type { Page } from 'playwright';
import type { ChallengeState } from '../../src/shared/dto';

/**
 * preload が contextBridge で出している window.api.rpc をページ側から撃つ。
 *
 * 型は src/shared/ipc.ts / dto.ts から **import type の相対パス**で借りる。
 * Playwright のランナーは自前の esbuild で回すので `@shared/*` エイリアスは
 * 実行時に解決できないが、`import type` は消えるので安全。
 * e2e からは値(関数・定数)を import しないこと。
 */
export async function rpc<T = unknown>(page: Page, method: string, params?: unknown): Promise<T> {
  return page.evaluate(
    ([m, p]) => (window as unknown as { api: { rpc(m: string, p: unknown): Promise<unknown> } }).api.rpc(m, p),
    [method, params] as [string, unknown]
  ) as Promise<T>;
}

export function challengeGet(page: Page): Promise<ChallengeState> {
  return rpc<ChallengeState>(page, 'challenge.get', undefined);
}

/** 診断リング。main / worker / dashboard / monitor の**全スコープ**が入る。 */
export interface DiagEntry {
  level: string;
  scope: string;
  message: string;
}

/**
 * Playwright/CDP が sandbox: true のレンダラへアタッチするときだけ出るノイズ。
 *
 * アプリのバグではないことは実測で確認済み — 実運用の
 * %APPDATA%/tiktok-live-stats/logs/diag.log(2,261 行)には**1件も出ていない**。
 * E2E ハーネス固有なので、ここだけを名指しで除く(ほかのエラーは素通しのまま)。
 */
const HARNESS_NOISE = [
  /Cannot destructure property 'preloadScripts' of 'binding\.startupData'/,
  /sandboxed_renderer\.bundle\.js script failed to run/,
];

export async function diagErrors(page: Page): Promise<DiagEntry[]> {
  const all = await rpc<DiagEntry[]>(page, 'diag.recent', undefined);
  return all.filter((e) => e.level === 'error' && !HARNESS_NOISE.some((re) => re.test(e.message)));
}
