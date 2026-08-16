import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, rpc } from './helpers/rpc';

/**
 * タップブースト(フィーバー)の 3・2・1 段。
 *
 * 段の**尺と順序**は L1(boost-start.spec.ts / challenge.spec.ts)で純関数として
 * 完全に覆われている。ここでしか取れないのは **適用側** —
 * 「映像が実際に intro → count → loop の順で差し替わり、タップウィンドウが
 * 3・2・1 の直後に開く」こと。3・2・1 は映像に焼き込みなので、段の切り替えが
 * ズレると視聴者には「1 と表示されているのにまだ押せない」に見える(v0.7.2 の回帰)。
 *
 * トリガーは実配信ではなく `conn.startReplay` で NDJSON を流す(worker 側は
 * 本番の conn.start と同じ onEvent 入口に入る)。
 */
const TRIGGER_GIFT_ID = '5655'; // fixtures/e2e-boost-trigger.ndjson の Rose

/** ブースト1行だけを有効にした challenge 設定。ほかの演出は全部落としたまま。 */
const BOOST_SETTINGS = {
  challenge: {
    enabled: true,
    title: 'E2E ブースト',
    initialValue: 100,
    pressStep: 1,
    followStep: 0,
    likeEvery: 0,
    likeStep: 1,
    likeStockCount: 0,
    // トリガーギフト自体が値を動かさないよう既定の増減を無効化する
    // (ブースト一致時は増減規則を通らないが、念のため素の状態にしておく)。
    giftDefault: null,
    giftRules: [],
    commentRules: [],
    roulettes: [],
    joinRoulette: { enabled: false },
    giftBandFx: { enabled: false, bands: [] },
    giftFullCut: { enabled: false, rules: [] },
    fanStamp: { enabled: false },
    tapBoost: {
      enabled: true,
      rules: [
        {
          id: 'e2e-boost',
          label: 'E2E',
          enabled: true,
          giftId: TRIGGER_GIFT_ID,
          giftName: '',
          canonical: '',
          exactName: false,
          multiplier: 5,
          durationSec: 5, // 下限。前置き8秒 + 窓5秒 + 清算 で 20秒弱
          introClip: 'intro-panther',
          countClip: 'count-321',
          loopClip: 'loop-panther',
          resultClip: 'off',
          flash: true,
        },
      ],
    },
    // 演出を見るテストなのでクリップは有効。
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

const FIXTURE = resolve('fixtures/e2e-boost-trigger.ndjson').replaceAll('\\', '/');

test.describe('シネマティック(モニター表示・reduced-motion なし)', () => {
  // 演出そのものを見るので reduced-motion を外す。
  // これが無いと fxAllowed() が false になり、プレーンモード(段なし)になる。
  test.use({ reducedMotion: false, settingsPatch: BOOST_SETTINGS });

  test('intro → 3・2・1 → タップウィンドウ の順に映像が差し替わり、窓が開いてから押せる', async ({
    app,
    main,
  }) => {
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(100);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    const clip = monitor.locator('video.fx-clip-opaque');

    // ① 起動カットイン(5秒)。
    await expect(clip).toHaveAttribute('src', /intro-panther/, { timeout: 20_000 });

    // ② カウントダウン 3・2・1(3秒・映像に焼き込み)。
    await expect(clip).toHaveAttribute('src', /count-321/, { timeout: 20_000 });
    // この段ではまだタップウィンドウは開いていない。
    await expect(monitor.locator('.boost-overlay')).toHaveCount(0);

    // ③ 「1」の直後にタップウィンドウが開く。ここが本命の同期。
    await expect(monitor.locator('.boost-overlay')).toHaveCount(1, { timeout: 20_000 });
    await expect(clip).toHaveAttribute('src', /loop-panther/);

    // ウィンドウ中のタップは「数えるだけ」— 値は動かず、カウンタだけ増える。
    const before = await segValue(monitor);
    await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
    await monitor.locator('.stage-viewport').click({ position: { x: 10, y: 10 } });
    await expect(monitor.locator('.boost-count')).toHaveText('2', { timeout: 10_000 });
    expect(await segValue(monitor)).toBe(before);

    // ④ 期限で一括反映。タップ2回 × pressStep 1 × 倍率 5 = 10 減る。
    await expect.poll(() => segValue(monitor), { timeout: 40_000 }).toBe(before - 10);

    const state = await challengeGet(main);
    expect(state.value).toBe(before - 10);
  });

  test('演出が渋滞していても起動カットインは頭から満尺で再生される', async ({ app, main }) => {
    // 実配信での症状そのもの: ±N バナーが詰まっている最中にトリガーギフトが来ると、
    // worker の絶対時刻とモニターの実再生開始がズレて起動カットイン(咆哮 5 秒)が
    // 削られていた。worker が発動を**予約**し、モニターが再生を始めた合図
    // (challenge.boostCue)でタップ窓を開くようにしたので、待たされても頭から出る。
    //
    // 旧実装ならここは count-321(途中参加)か loop-panther(ウィンドウ直行)に
    // なるので、このテストは修正の有無を直接判別する。
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);

    // 舞台を塞ぐ。バナーが出ている間 stageBusy() が真で boost-start は持ち越される。
    for (let i = 0; i < 4; i += 1) {
      await rpc(main, 'challenge.testEffect', { kind: 'follow' });
    }
    await expect(monitor.locator('.floats > .float').first()).toBeVisible({ timeout: 10_000 });

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    const clip = monitor.locator('video.fx-clip-opaque');
    // ★ 渋滞を抜けた後、**起動カットインから**始まること。
    await expect(clip).toHaveAttribute('src', /intro-panther/, { timeout: 30_000 });
    await expect(clip).toHaveAttribute('src', /count-321/, { timeout: 30_000 });
    // 3・2・1 の間はまだ押せない(映像焼き込みの「1」とタップ開始の同期契約)。
    await expect(monitor.locator('.boost-overlay')).toHaveCount(0);
    await expect(monitor.locator('.boost-overlay')).toHaveCount(1, { timeout: 30_000 });
    await expect(clip).toHaveAttribute('src', /loop-panther/);
  });
});

test.describe('プレーンモード(モニターを開かない)', () => {
  test.use({ reducedMotion: false, settingsPatch: BOOST_SETTINGS });

  test('モニターが無ければ暗幕もカットインも出ず、タップは即時×倍率で効く', async ({ app, main }) => {
    await rpc(main, 'challenge.start', undefined);
    // モニターは開かない。fxAllowed() = monitorOpen && bandFx なので false。
    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ブーストは発動する(worker 側の状態としては載る)。
    await expect
      .poll(async () => (await challengeGet(main)).boost != null, { timeout: 20_000 })
      .toBe(true);

    // 窓が1つのまま = モニターは生まれていない(暗幕を出す先が無い)。
    expect(app.windows()).toHaveLength(1);

    // プレーンモードのタップは即時 × 倍率。前置きを待たずに効く。
    const before = (await challengeGet(main)).value;
    await rpc(main, 'challenge.press', undefined);
    const after = (await challengeGet(main)).value;
    expect(after).toBe(before - 5); // pressStep 1 × multiplier 5
  });
});
