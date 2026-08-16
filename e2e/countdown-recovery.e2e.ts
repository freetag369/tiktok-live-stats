import { join, resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, diagBaseline, diagErrorsSince, rpc } from './helpers/rpc';

/**
 * プロセスが死んで戻ってくる経路。
 *
 * どれも**実プロセスを落とさないと再現できない**。モックすると復旧処理は常に
 * 成功するので、「復旧したつもりで配線が切れている」という一番わかりにくい
 * 壊れ方(実際に起きたやつ)が検出できない。
 */
const FIXTURE = resolve('fixtures/e2e-boost-trigger.ndjson').replaceAll('\\', '/');

/** worker を再起動させる。dbPath の変更が needsWorkerRestart の条件。 */
async function restartWorker(main: import('playwright').Page, dataDir: string): Promise<void> {
  const res = await rpc<{ workerRestarted: boolean }>(main, 'cfg.set', {
    dbPath: join(dataDir, 'db', 'restarted.db').replaceAll('\\', '/'),
  });
  expect(res.workerRestarted, 'dbPath の変更は worker 再起動を要求するはず').toBe(true);
}

test('モニター窓のレンダラをクラッシュさせても自動復旧し、復旧後も press が届く', async ({ app, main }) => {
  await rpc(main, 'challenge.start', undefined);
  const monitor = await openMonitor(app, main);
  expect(await segValue(monitor)).toBe(100);

  // 復旧窓は新しい Page として生まれる。**殺す前に**待ち受けを張る —
  // 死んだ Page は windows() に残りうるので、一覧から拾うと掴み損なう。
  const pendingRecovered = app.waitForEvent('window', { timeout: 45_000 });

  // render-process-gone は実レンダラを殺さないと発火しない。
  // main プロセス側の BrowserWindow ハンドル経由で殺す(CDP では届かない操作)。
  const bw = await app.browserWindow(monitor);
  await bw.evaluate((w: { webContents: { forcefullyCrashRenderer(): void } }) =>
    w.webContents.forcefullyCrashRenderer()
  );

  // watchMonitorWindow → tryAutoRecoverMonitor が窓を作り直す。
  const recovered = await pendingRecovered;
  await recovered.waitForLoadState('domcontentloaded');
  expect(recovered.url().endsWith('monitor.html'), '復旧したのはモニター窓であること').toBe(true);
  await expect(recovered.locator('.seg-row')).toBeVisible({ timeout: 20_000 });

  // 復旧後も押下が届き、両側の数字が動く(MessagePort の再ハンドシェイクが効いている)。
  await rpc(main, 'challenge.press', undefined);
  expect((await challengeGet(main)).value).toBe(99);
  await expect
    .poll(async () => Number(await recovered.locator('.seg-row').getAttribute('aria-label')), {
      timeout: 20_000,
    })
    .toBe(99);
});

test('worker を再起動しても PUSH ボタンが灰色固着せず、押せば数字が動く', async ({ main, dataDir }) => {
  await main.getByRole('button', { name: 'ライブ', exact: true }).click();
  await rpc(main, 'challenge.start', undefined);

  const push = main.getByRole('button', { name: 'PUSH' });
  await expect(push).toBeEnabled();

  await restartWorker(main, dataDir);

  // 再起動でチャレンジは idle に戻る(worker のメモリにしか無いため)。
  // ダッシュボードは workerState の ready 遷移で challenge.get を取り直すので、
  // 「running のまま固着」も「PUSH が灰色のまま」も起きない。
  await expect
    .poll(async () => (await challengeGet(main)).status, { timeout: 45_000 })
    .toBe('idle');

  // 開始し直せば普通に押せる。ここが固着していたのが v0.7.x の事故。
  await rpc(main, 'challenge.start', undefined);
  await expect(push).toBeEnabled({ timeout: 20_000 });
  await push.click();
  await expect
    .poll(async () => (await challengeGet(main)).value, { timeout: 20_000 })
    .toBe(99);
});

// このテストだけ reduced-motion を外す。既定(true)のままだとモニターは
// bandFx:false を申告するので、再起動の有無にかかわらず凍結は永久に張られず、
// 「再申告されたか」を観測できない。
test.describe('fxCaps の再申告', () => {
  test.use({ reducedMotion: false });

  test('モニターを開いたまま worker を再起動しても、凍結がまた張れる', async ({ app, main, dataDir }) => {
  // 帯域カットインを有効にして「凍結が張れるか」を観測手段にする。
  // fxClipsEnabled は演出クリップ全体のスイッチで、false だと matchGiftBand が
  // 問答無用で null を返す(challenge.ts:1054)— seedSettings は決定性のために
  // false にしているので、ここで戻す。
  const cfg = await rpc<{ challenge: Record<string, unknown> }>(main, 'cfg.get', undefined);
  await rpc(main, 'cfg.set', {
    challenge: {
      ...cfg.challenge,
      fxClipsEnabled: true,
      giftBandFx: {
        enabled: true,
        bands: [{ id: 'b1', min: 1, max: 10_000, clip: 'gift-band1', durationSec: 6, enabled: true, bgm: 'off' }],
      },
    },
  });

  const monitor = await openMonitor(app, main);
  expect(monitor).toBeTruthy();
  const baseline = await diagBaseline(main);

  await restartWorker(main, dataDir);

  // 世代交代の完了を待つ(チャレンジは worker のメモリにしか無いので idle へ戻る)。
  await expect.poll(async () => (await challengeGet(main)).status, { timeout: 45_000 }).toBe('idle');
  await rpc(main, 'challenge.start', undefined);

  // ここから先は **fxCaps を自分で撃たない**。撃つと「モニターが再申告したか」を
  // 検証したことにならない。代わりに観測可能な副作用を見る:
  // worker は fxAllowed() = monitorOpen && bandFx のときだけカットイン凍結を張るので、
  // 帯域に一致するギフトで fxFreezeUntilMs が立てば、申告が届いた証拠になる。
  // 届いていなければ worker は凍結を一切張らない(演出が出ないのに数字だけ進む縮退)。
  await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

  await expect
    .poll(async () => (await challengeGet(main)).fxFreezeUntilMs != null, { timeout: 30_000 })
    .toBe(true);

  expect(await diagErrorsSince(main, baseline)).toEqual([]);
});
});
