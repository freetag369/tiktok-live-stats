import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, diagBaseline, diagErrorsSince, rpc } from './helpers/rpc';

/**
 * 最終ゲート(ラスト◯◯モード)。
 *
 * ゲートの規則(蓄積・リセット・分岐順序)は L1(challenge-final-gate.spec.ts)が
 * エンジンで完全に覆っている。**ここでしか取れないのはプロセスを跨いだ事実** —
 * 設定ファイルの finalGate が worker まで届き、モニターの7セグが「削れない10」を
 * 表示し続け、進捗リング(data-gauntlet)が press RPC の往復で実際に育つこと。
 *
 * taps は 30 ではなく 3 — 設定値が生きて読まれることの検証を兼ねつつ、
 * テストの押下回数を最小にする(30 の既定値は L1 の validate が持つ)。
 */
const GATE_SETTINGS = {
  challenge: {
    enabled: true,
    title: 'E2E 最終ゲート',
    initialValue: 13,
    pressStep: 1,
    followStep: 0,
    likeEvery: 0,
    likeStep: 1,
    likeStockCount: 0,
    giftDefault: null,
    giftRules: [],
    commentRules: [],
    roulettes: [],
    joinRoulette: { enabled: false },
    giftBandFx: { enabled: false, bands: [] },
    giftFullCut: { enabled: false, rules: [] },
    fanStamp: { enabled: false },
    stampTriggers: { enabled: false, rules: [] },
    tapBoost: { enabled: false, rules: [] },
    fxClipsEnabled: false,
    miniFxEnabled: false,
    seEnabled: false,
    monitorWindowed: true,
    monitorDisplayId: null,
    hotkey: '',
    wakeEnabled: false,
    lowThreshold: 10,
    finalGate: { enabled: true, taps: 3 },
  },
};

test.describe('最終ゲート(ラスト10は3タップで1減算)', () => {
  test.use({ settingsPatch: GATE_SETTINGS });

  test('閾値までは1タップ1減、閾値からは3タップで1減り、リングが育つ', async ({ app, main }) => {
    const baseline = await diagBaseline(main);
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(13);

    // 閾値の外(13→10)は従来どおり 1 タップ 1 減。リングはまだ出ない。
    await expect(monitor.locator('.gauntlet-ring')).toHaveCount(0);
    for (let i = 0; i < 3; i += 1) await rpc(main, 'challenge.press', undefined);
    await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(10);
    // 閾値ちょうどでゲートが開く: low の明滅とリング(0/3)。
    await expect(monitor.locator('.countdown')).toHaveClass(/\blow\b/);
    await expect(monitor.locator('.gauntlet-ring')).toHaveAttribute('data-gauntlet', '0/3', {
      timeout: 10_000,
    });

    // 蓄積2発 — 数字は削れず、リングの目盛りだけが進む。
    for (let i = 0; i < 2; i += 1) await rpc(main, 'challenge.press', undefined);
    await expect(monitor.locator('.gauntlet-ring')).toHaveAttribute('data-gauntlet', '2/3', {
      timeout: 10_000,
    });
    expect(await segValue(monitor)).toBe(10);

    // 3発目でゲート完成 — 1 だけ減ってリングは巻き直し。
    await rpc(main, 'challenge.press', undefined);
    await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(9);
    await expect(monitor.locator('.gauntlet-ring')).toHaveAttribute('data-gauntlet', '0/3', {
      timeout: 10_000,
    });

    // worker の真値でも裏取り: 値 9・タップ実数 6(蓄積タップも presses に数える)。
    const s = await challengeGet(main);
    expect(s.value).toBe(9);
    expect(s.stats.presses).toBe(6);

    // main / worker / renderer のどれもエラーを出していない。
    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });
});
