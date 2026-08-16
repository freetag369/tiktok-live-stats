import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, rpc } from './helpers/rpc';

/**
 * 「カットイン再生中でもタップが効き、モニターの7セグがその場で動く」。
 *
 * L1(challenge-press-freeze.spec.ts)は worker の値と effect までしか見られない。
 * 据え置き(heldValue)はモニター窓の中にしか無く、**worker が即時に減らしても
 * モニターが据え置いたままなら配信者からは何も変わらない** — 修正前とまったく
 * 同じ「ボタンが死んで見える」に戻る。それを検出できるのはここだけ。
 *
 * 併せて「未表示の演出ぶんは据え置いたまま」も固定する — カットイン中の表示は
 * ギフトの +1 を隠したまま押下ぶんだけ減り、演出明けに worker の真値へ収束する。
 */
const BAND_SETTINGS = {
  challenge: {
    enabled: true,
    title: 'E2E カットイン',
    initialValue: 100,
    pressStep: 1,
    followStep: 0,
    likeEvery: 0,
    likeStep: 1,
    likeStockCount: 0,
    // Rose 1💎 → +1(この +1 がカットイン中は据え置かれる = 先漏れ防止の証明)。
    giftDefault: { mode: 'perDiamond', amount: 1 },
    giftRules: [],
    commentRules: [],
    // ── 凍結を張るのは band1 だけにする。全面カットの既定行は「バラ」に
    //    一致してしまうので必ず落とすこと(落とさないと 5 秒の別の凍結が勝つ)。
    roulettes: [],
    joinRoulette: { enabled: false },
    giftBandFx: {
      enabled: true,
      bands: [{ id: 'band1', min: 1, max: 50, clip: 'gift-band1', durationSec: 6, enabled: true, bgm: 'off' }],
    },
    giftFullCut: { enabled: false, rules: [] },
    tapBoost: { enabled: false, rules: [] },
    fanStamp: { enabled: false },
    // カットインの映像を実際に再生させる(これが無いと据え置きの持ち主が生まれない)。
    fxClipsEnabled: true,
    miniFxEnabled: false,
    seEnabled: false,
    monitorWindowed: true,
    monitorDisplayId: null,
    hotkey: '',
    wakeEnabled: false,
    lowThreshold: 10,
  },
};

const FIXTURE = resolve('fixtures/e2e-band-cutin.ndjson').replaceAll('\\', '/');

test.describe('カットイン中の押下(モニター表示・reduced-motion なし)', () => {
  // reduced-motion のままだと fxAllowed() が false になり凍結も据え置きも起きない。
  test.use({ reducedMotion: false, settingsPatch: BAND_SETTINGS });

  test('カットイン再生中のタップが7セグに即座に出て、演出明けに真値へ収束する', async ({ app, main }) => {
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    const countdown = monitor.locator('.countdown');
    expect(await segValue(monitor)).toBe(100);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // band1(6秒)のカットインが始まり、モニターが数字を据え置く。
    await expect(countdown).toHaveAttribute('data-held', '1', { timeout: 20_000 });
    // ギフトの +1 は据え置かれている(結果の先漏れ防止)— worker は既に 101。
    expect(await segValue(monitor)).toBe(100);
    expect((await challengeGet(main)).value).toBe(101);

    // ここが本題。演出中の3タップ。
    for (let i = 0; i < 3; i += 1) await rpc(main, 'challenge.press', undefined);
    expect((await challengeGet(main)).value).toBe(98); // worker は即時に減る
    // 据え置きも同じ幅だけ下がる = 配信者から見て「押した手応え」がある。
    await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(97);
    // まだカットイン中(ギフトの +1 は伏せたまま)。
    await expect(countdown).toHaveAttribute('data-held', '1');

    // 演出が明けると据え置きが解け、worker の真値へ収束する(+1 がここで見える)。
    await expect.poll(() => segValue(monitor), { timeout: 30_000 }).toBe(98);
    await expect(countdown).not.toHaveAttribute('data-held', '1');
    expect((await challengeGet(main)).value).toBe(98);
  });
});
