import { expect, test } from './fixtures';
import { challengeGet, diagErrors, rpc } from './helpers/rpc';

/**
 * 配線全体の最短スモーク。
 *
 * ここが通る = Electron が起動し、worker が上がり、preload の contextBridge が
 * 張られ、RPC が main を経由して worker まで往復し、チャレンジのエンジンが
 * 動いている。**最も壊れやすい配線**を全 push で守るための1本。
 */
test('@smoke 起動 → 開始 → PUSH×3 で残数が3減り、診断にエラーが出ない', async ({ main }) => {
  // worker 起動待ち。RPC が通れば ready。
  await expect
    .poll(async () => (await rpc<{ status: unknown }>(main, 'conn.status', undefined)) != null, {
      timeout: 30_000,
    })
    .toBe(true);

  const start = await rpc<{ status: string; value: number }>(main, 'challenge.start', undefined);
  expect(start.status).toBe('running');
  expect(start.value).toBe(100); // seedSettings の initialValue

  for (let i = 0; i < 3; i += 1) await rpc(main, 'challenge.press', undefined);

  const after = await challengeGet(main);
  expect(after.value).toBe(97);
  expect(after.stats.presses).toBe(3);

  // main / worker / renderer のどのプロセスでもエラーが出ていないこと。
  // Playwright が直接観測できない worker と main まで拾えるのはこの経路だけ。
  const errors = await diagErrors(main);
  expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
});

test('@smoke ダッシュボードにチャレンジカードが描画され、PUSH で残数表示が動く', async ({ main }) => {
  await rpc(main, 'challenge.start', undefined);

  // 起動直後は「接続」画面(uiStore の既定 route)。ユーザーと同じ手順で移動する。
  await main.getByRole('button', { name: 'ライブ', exact: true }).click();

  const value = main.locator('.challenge-value');
  await expect(value).toBeVisible({ timeout: 20_000 });
  await expect(value).toHaveText('100');

  // 実際のボタンを押す(RPC 直撃ではなく UI 経由)。
  const push = main.getByRole('button', { name: 'PUSH' });
  await expect(push).toBeEnabled();
  await push.click();

  await expect(value).toHaveText('99');
});

test('設定が temp の dataDir へ隔離されている(実データを触っていない)', async ({ main, dataDir }) => {
  const cfg = await rpc<{ dbPath: string }>(main, 'cfg.get', undefined);
  expect(cfg.dbPath.startsWith(dataDir)).toBe(true);
});
