import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, rpc } from './helpers/rpc';

/**
 * ダイヤ増減の浮上演出(「N 浮上 → 数字が合計値まで駆け上がる → ドンとカウントに着弾」)。
 *
 * 写像と尺は L1(challenge-gift-scale.spec.ts / gift-scale-fx.spec.ts)が純関数として
 * 完全に覆っている。ここでしか取れないのは **適用側** — 「worker が値を即時適用しても
 * 7セグは据え置かれ、カウントアップが終わって着弾した瞬間に初めて数字が動く」こと。
 * 据え置きが漏れると視聴者には「浮上が出る前に答えが出て、あとから演出だけ流れる」に
 * 見える(pendingStageAmount / anyCutinHold の登録漏れで実際に起きる壊れ方)。
 */

const TRIGGER_GIFT_ID = '7237'; // fixtures/e2e-gift-scale.ndjson の Unicorn Fantasy(2000💎)
const DIAMONDS = 2000;
const PER_DIAMOND = -50; // 応援(減る)方向
const INITIAL = 500_000;
const EXPECTED = INITIAL + DIAMONDS * PER_DIAMOND; // 400,000

const SCALE_SETTINGS = {
  challenge: {
    enabled: true,
    title: 'E2E ダイヤ増減',
    initialValue: INITIAL,
    pressStep: 1,
    followStep: 0,
    likeEvery: 0,
    likeStep: 1,
    likeStockCount: 0,
    // 手動規則と既定は空にして、判定がダイヤ増減層だけを通ることを保証する。
    giftDefault: null,
    giftRules: [],
    commentRules: [],
    roulettes: [],
    joinRoulette: { enabled: false },
    giftBandFx: { enabled: false, bands: [] },
    giftFullCut: { enabled: false, rules: [] },
    fanStamp: { enabled: false },
    commentHelper: { enabled: false },
    tapBoost: { enabled: false, rules: [] },
    revolution: { enabled: false, rules: [] },
    universe: { enabled: false, rules: [] },
    giftScale: {
      enabled: true,
      rows: [
        {
          id: 'e2e-gs',
          giftId: TRIGGER_GIFT_ID,
          giftName: '',
          canonical: '',
          label: 'E2E 減算',
          perDiamond: PER_DIAMOND,
        },
      ],
      threshold: 9699,
      highPerDiamond: 50,
      lowPerDiamond: 30,
      fxEnabled: true,
      fxMinDiamonds: 1000,
    },
    fxClipsEnabled: false,
    miniFxEnabled: false,
    seEnabled: false,
    monitorWindowed: true,
    monitorDisplayId: null,
    hotkey: '',
    wakeEnabled: false,
    lowThreshold: 10,
    finalGate: { enabled: false },
  },
};

const FIXTURE = resolve('fixtures/e2e-gift-scale.ndjson').replaceAll('\\', '/');

test.describe('ダイヤ増減の浮上演出', () => {
  // 演出そのものを見るので reduced-motion を外す(付けると浮上が出ない)。
  test.use({ reducedMotion: false, settingsPatch: SCALE_SETTINGS });

  test('worker は即時適用するが、7セグは着弾まで据え置かれる', async ({ app, main }) => {
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(INITIAL);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ① 浮上バナーが出る。
    const banner = monitor.locator('.float.banner-gift-scale');
    await expect(banner).toHaveCount(1, { timeout: 20_000 });
    // 応援(減る)方向なので good が付く。
    await expect(banner).toHaveClass(/good/);

    // ② ★本命: worker はもう値を適用しているのに、7セグはまだ動いていない。
    //    ここが漏れると「浮上が出る前に答えが出る」= 演出が嘘になる。
    const state = await challengeGet(main);
    expect(state.value, 'worker 側は即時適用されている').toBe(EXPECTED);
    expect(await segValue(monitor), '7セグは据え置かれている').toBe(INITIAL);

    // ③ 数字が 0 から合計値へ駆け上がる(単調非減少)。
    const amt = banner.locator('.f-amt');
    const readAmt = async (): Promise<number> => {
      const t = (await amt.textContent()) ?? '';
      return Number(t.replace(/[^0-9]/g, ''));
    };
    await expect.poll(readAmt, { timeout: 10_000 }).toBeGreaterThan(0);
    const mid = await readAmt();
    await expect.poll(readAmt, { timeout: 10_000 }).toBe(DIAMONDS * -PER_DIAMOND);
    expect(mid, 'カウントアップの途中で既に合計値へ達していない').toBeLessThanOrEqual(
      DIAMONDS * -PER_DIAMOND
    );

    // ④ 着弾で初めて 7セグが動く。
    await expect.poll(() => segValue(monitor), { timeout: 20_000 }).toBe(EXPECTED);

    // ⑤ 据え置きが解けている = 以降の押下が普通に効く(ホールドの固着が無い)。
    await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
    await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(EXPECTED - 1);
  });

  test('モニターを開いていなくても値は正しく動く(演出はモニター側だけの話)', async ({ main }) => {
    // worker は凍結を張らない設計なので、モニターの有無に関係なく即時に適用される。
    await rpc(main, 'challenge.start', undefined);
    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });
    await expect.poll(async () => (await challengeGet(main)).value, { timeout: 20_000 }).toBe(
      EXPECTED
    );
  });
});
