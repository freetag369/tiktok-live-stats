import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, rpc } from './helpers/rpc';

/**
 * お邪魔(タップ封じ)。
 *
 * ゲートの位置・期限・解除経路は L1(tap-lock-press.spec.ts / tap-lock-lifecycle.spec.ts)が
 * 純関数と worker エンジンで完全に覆っている。**ここでしか取れないのはプロセスを跨いだ
 * 事実** — 「モニターのタップも main のダッシュボードの PUSH も実際に効かなくなり、
 * 期限が来たら**本当に戻る**」。この機能で最悪の壊れ方は演出のバグではなく
 * 「配信中にボタンが永久に死ぬ」なので、復帰までを1本の筋で見る価値がある。
 *
 * トリガーは e2e-boost-trigger.ndjson を流用する(giftId 5655 が1回だけ届く)。
 */
const TRIGGER_GIFT_ID = '5655';
/** 下限の 5 秒。E2E の待ち時間を最小にするため(尺の妥当性は L1 の clamp が持つ)。 */
const LOCK_SEC = 5;

const LOCK_SETTINGS = {
  challenge: {
    enabled: true,
    title: 'E2E お邪魔',
    initialValue: 100,
    pressStep: 1,
    followStep: 0,
    likeEvery: 0,
    likeStep: 1,
    likeStockCount: 0,
    // トリガーギフト自体が値を動かさないよう既定の増減を無効化する
    // (封印一致時は増減規則を通らないが、念のため素の状態にしておく)。
    giftDefault: null,
    giftRules: [],
    commentRules: [],
    roulettes: [],
    joinRoulette: { enabled: false },
    giftBandFx: { enabled: false, bands: [] },
    giftFullCut: { enabled: false, rules: [] },
    fanStamp: { enabled: false },
    tapBoost: { enabled: false, rules: [] },
    tapLock: {
      enabled: true,
      rules: [
        {
          id: 'e2e-lock',
          label: 'E2E お邪魔',
          enabled: true,
          giftId: TRIGGER_GIFT_ID,
          giftName: '',
          canonical: '',
          exactName: false,
          durationSec: LOCK_SEC,
          amountEach: 0,
          flash: false,
        },
      ],
    },
    fxClipsEnabled: false,
    miniFxEnabled: false,
    seEnabled: false,
    monitorWindowed: true,
    monitorDisplayId: null,
    hotkey: '',
    wakeEnabled: false,
    lowThreshold: 10,
  },
};

const FIXTURE = resolve('fixtures/e2e-boost-trigger.ndjson').replaceAll('\\', '/');

test.describe('お邪魔(タップ封じ)', () => {
  test.use({ settingsPatch: LOCK_SETTINGS });

  test('封じている間はモニターのタップも PUSH も効かず、期限で必ず戻る', async ({ app, main }) => {
    await rpc(main, 'challenge.start', undefined);
    // 起動直後は「接続」画面(uiStore の既定 route)。PUSH を見るので移動しておく。
    await main.getByRole('button', { name: 'ライブ', exact: true }).click();
    await expect(main.locator('button.challenge-btn')).toBeEnabled({ timeout: 20_000 });
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(100);

    // 封じる前は普通に押せる(この後の「押せない」が本物であることの対照)。
    await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
    await expect.poll(() => segValue(monitor)).toBe(99);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ① モニターに残り秒の帯が出る。
    await expect(monitor.locator('.tap-lock-overlay')).toHaveCount(1, { timeout: 20_000 });

    // ② ダッシュボードの PUSH が無効になる(モニターを閉じている配信者にとっては
    //    これが唯一の説明なので、無効化までを1本で見る)。
    await expect(main.locator('button.challenge-btn')).toBeDisabled();

    // ③ モニターのタップが効かない。worker が唯一の判定者なので、
    //    RPC は通る(= blocked が増える)が値は動かない。
    for (let i = 0; i < 3; i += 1) {
      await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
    }
    expect(await segValue(monitor)).toBe(99);
    const locked = await challengeGet(main);
    expect(locked.tapLock).toBeTruthy();
    expect(locked.value).toBe(99);
    expect(locked.stats.presses).toBe(1); // 封じる前の1回だけ

    // ④ 期限が来たら**本当に戻る**。ここが通らない = ボタンが死んだままの事故。
    await expect(monitor.locator('.tap-lock-overlay')).toHaveCount(0, {
      timeout: (LOCK_SEC + 10) * 1000,
    });
    await expect(main.locator('button.challenge-btn')).toBeEnabled();

    // ⑤ 封じ中のタップは**溜まっていない**(解除後にまとめて落ちない)。
    expect(await segValue(monitor)).toBe(99);
    await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
    await expect.poll(() => segValue(monitor)).toBe(98);
  });

  test('緊急解除ボタンでランを壊さずに即座に戻せる', async ({ app, main }) => {
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
    await expect.poll(() => segValue(monitor)).toBe(99);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });
    await expect(monitor.locator('.tap-lock-overlay')).toHaveCount(1, { timeout: 20_000 });

    // 停止/リセットと違い、値も統計も startedMs も残ったまま封じだけが解ける。
    const before = await challengeGet(main);
    await rpc(main, 'challenge.clearTapLock', undefined);
    const after = await challengeGet(main);
    expect(after.tapLock).toBeUndefined();
    expect(after.value).toBe(before.value);
    expect(after.stats.presses).toBe(before.stats.presses);
    expect(after.startedMs).toBe(before.startedMs);

    await expect(monitor.locator('.tap-lock-overlay')).toHaveCount(0, { timeout: 10_000 });
    await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
    await expect.poll(() => segValue(monitor)).toBe(98);
  });
});
