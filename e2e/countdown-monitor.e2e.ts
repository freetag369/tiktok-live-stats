import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, diagErrors, rpc } from './helpers/rpc';

/**
 * モニター窓(OBS 用の背面表示)。
 *
 * ここは **2つの BrowserWindow + preload + MessagePort + worker** を跨ぐので、
 * 他のどの層でも検証できない。MonitorView は 4350 行で rpc() を直接呼ぶため
 * 単体で切り出すこともできず、「両窓の数字が一致する」は delta 配送を実際に
 * 走らせないと言えない。
 */
test('モニターを開くと7セグに現在値が出て、ダッシュボードと一致する', async ({ app, main }) => {
  await rpc(main, 'challenge.start', undefined);
  const monitor = await openMonitor(app, main);

  expect(await segValue(monitor)).toBe(100);

  await rpc(main, 'challenge.press', undefined);
  // delta は 2Hz + 間引き nudge なので poll で待つ(sleep は書かない)。
  await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(99);

  const state = await challengeGet(main);
  expect(state.value).toBe(99);
});

test('モニターのクリックで残数が減る(配信者が画面を叩く経路)', async ({ app, main }) => {
  await rpc(main, 'challenge.start', undefined);
  const monitor = await openMonitor(app, main);

  // stage-viewport 全面が onPointerDown → challenge.press。
  await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
  await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(99);
});

test('モニターの Space / Enter で残数が減る(物理ボタンの代替経路)', async ({ app, main }) => {
  await rpc(main, 'challenge.start', undefined);
  const monitor = await openMonitor(app, main);

  await monitor.keyboard.press('Space');
  await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(99);

  await monitor.keyboard.press('Enter');
  await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(98);
});

test('チャレンジ OFF ではモニターを叩いても数字が動かない(v0.7.3 の修正)', async ({ app, main, dataDir }) => {
  void dataDir;
  // 配信中に設定を OFF へ。以前はここでエンジンが素通しになっていて、
  // モニターのクリック / Space とギフト妨害が数字を動かし続けていた。
  await rpc(main, 'challenge.start', undefined);
  const monitor = await openMonitor(app, main);
  expect(await segValue(monitor)).toBe(100);

  const cfg = await rpc<{ challenge: Record<string, unknown> }>(main, 'cfg.get', undefined);
  await rpc(main, 'cfg.set', { challenge: { ...cfg.challenge, enabled: false } });

  await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
  await monitor.keyboard.press('Space');
  await rpc(main, 'challenge.press', undefined);

  // どの経路でも動かない。
  const state = await challengeGet(main);
  expect(state.value).toBe(100);
  expect(state.stats.presses).toBe(0);
});

test('モニターを閉じると窓が減り、ダッシュボードは生き続ける', async ({ app, main }) => {
  await rpc(main, 'challenge.start', undefined);
  const monitor = await openMonitor(app, main);
  expect(app.windows().length).toBeGreaterThanOrEqual(2);

  await rpc(main, 'monitor.close', undefined);
  await expect.poll(() => app.windows().length, { timeout: 15_000 }).toBe(1);
  void monitor;

  // 閉じたあともダッシュボード側の操作は通る。
  await rpc(main, 'challenge.press', undefined);
  expect((await challengeGet(main)).value).toBe(99);
  expect(await diagErrors(main)).toEqual([]);
});
