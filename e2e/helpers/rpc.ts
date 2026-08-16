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
  atMs: number;
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

/**
 * 起動時点のエラーを基準線として控える。
 *
 * CI のコールドランナーでは初回起動が重く、アプリ自身の停止メーターが
 * 「main イベントループが 3000ms 停止」を正しく記録する(npm ci 直後・ディスク
 * キャッシュ無し・sqlite マイグレーション込み)。これは環境の話で製品のバグでは
 * ないが、**メーターごと無視すると本来の目的(固まりの検出)が死ぬ**。
 * そこで基準線を取り、テスト自身の操作で**新しく増えた**エラーだけを見る。
 */
export async function diagBaseline(page: Page): Promise<DiagEntry[]> {
  return diagErrors(page);
}

/** 基準線より後に増えたエラーだけを返す。 */
export async function diagErrorsSince(page: Page, baseline: DiagEntry[]): Promise<DiagEntry[]> {
  const seen = new Set(baseline.map((e) => `${e.atMs}|${e.scope}|${e.message}`));
  const all = await diagErrors(page);
  return all.filter((e) => !seen.has(`${e.atMs}|${e.scope}|${e.message}`));
}
