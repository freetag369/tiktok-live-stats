import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, rpc, type DiagEntry } from './helpers/rpc';

/**
 * フォロー妨害の通しシナリオ — 既存 e2e はすべて followStep: 0 で follow を
 * 無効化しており、「social イベント投入 → 値 +N → バナー → SE → 診断ログ」を
 * 実アプリで確認する層が丸ごと欠落していた(「フォロー妨害が発生しない」の
 * 懸念が実データ調査でしか解消できなかった直接の原因)。
 *
 * テスト1: カットイン凍結中のフォローが (a) 演出ストックに「フォロー」予告で
 * 出る (b) 凍結明けに followNames の合算バナー1枚になる (c) 値と統計に入る
 * (d) SE(follow スロット)が鳴る (e) [challenge/social] の診断が残る。
 * テスト2: 凍結なしの即時経路は従来どおり1人ずつの単発バナー(文言の不変)。
 */
const FOLLOW_SETTINGS = {
  challenge: {
    enabled: true,
    title: 'E2E フォロー',
    initialValue: 100,
    pressStep: 1,
    followStep: 10,
    likeEvery: 0,
    likeStep: 1,
    likeStockCount: 0,
    giftDefault: { mode: 'perDiamond', amount: 1 },
    giftRules: [],
    commentRules: [],
    // ── 凍結を張るのは band1 だけ(countdown-press-cutin.e2e.ts と同じ構図)。
    roulettes: [],
    joinRoulette: { enabled: false },
    giftBandFx: {
      enabled: true,
      bands: [{ id: 'band1', min: 1, max: 50, clip: 'gift-band1', durationSec: 6, enabled: true, bgm: 'off' }],
    },
    giftFullCut: { enabled: false, rules: [] },
    tapBoost: { enabled: false, rules: [] },
    fanStamp: { enabled: false },
    fxClipsEnabled: true,
    miniFxEnabled: false,
    // SE の再生経路を生かす(音自体は --mute-audio。プローブで play() を観測する)。
    seEnabled: true,
    monitorWindowed: true,
    monitorDisplayId: null,
    hotkey: '',
    wakeEnabled: false,
    lowThreshold: 10,
  },
};

const FIXTURE = resolve('fixtures/e2e-follow.ndjson').replaceAll('\\', '/');

test.describe('フォロー妨害(カットイン凍結 → 予告 → 合算バナー)', () => {
  // reduced-motion のままだと fxAllowed() が false になり凍結も予告も起きない。
  test.use({ reducedMotion: false, settingsPatch: FOLLOW_SETTINGS });

  test('凍結中は演出ストックに予告、凍結明けに ×2人の合算バナーと SE と診断が出る', async ({ app, main }) => {
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(100);

    // fxCaps 握手の起動レースを決定的に閉じる。モニターはマウント時に同じ申告を
    // 送るが、worker への到達が gift 処理より後になると fxAllowed() が false のまま
    // 凍結されず、follow が即時適用されて予告(fxQueue)が出ない — effect への
    // fxBandClip 焼き込みは無条件なのでカットイン(data-held)だけは立ち、原因が
    // 見えにくい。setFxCaps は冪等・同値再送は凍結を乱さない(challenge.spec の
    // 許可ゲート describe が契約)。
    await rpc(main, 'challenge.fxCaps', { bandFx: true });

    // SE プローブ: HTMLMediaElement.play をラップして再生された src を記録する
    // (replay より先に仕込む — 最初の1鳴りを取りこぼさない)。
    await monitor.evaluate(() => {
      const w = window as unknown as { __sePlays: string[] };
      w.__sePlays = [];
      const orig = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        w.__sePlays.push(String(this.currentSrc || this.src || ''));
        return orig.call(this);
      };
    });

    // speed 1(実時間)で流す。speed 0 だとリプレイが即終了 → セッション停止で
    // 2Hz tick が止まり、「保留 follow の dirty」を運ぶ delta が凍結中に一度も
    // 出ない(予告はイベント/タイマーの合間の tick が運ぶ設計)。fixture 末尾の
    // キープアライブ(o=4000 の入室)がリプレイを4秒生かし、その間の tick が
    // fxQueue 入りの delta を必ず配る。
    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 1 });

    // band1(6秒)のカットインが始まり、モニターが数字を据え置く。
    const countdown = monitor.locator('.countdown');
    await expect(countdown).toHaveAttribute('data-held', '1', { timeout: 20_000 });
    // worker 側の凍結も張られている(monitor の据え置きだけでは凍結の証明にならない
    // — fxBandClip は無条件焼き込みのため)。凍結が無いと以降の予告検証が全部無意味。
    expect((await challengeGet(main)).fxFreezeUntilMs).not.toBeNull();

    // worker 側の予告(fxQueue)が積まれている — ここが空ならモニター以前の問題。
    await expect
      .poll(async () => ((await challengeGet(main)).fxQueue ?? []).map((w) => w.kind).join(','), {
        timeout: 10_000,
      })
      .toBe('follow,follow');

    // 【A2 の検証】凍結中のフォロー2件が演出ストックに「フォロー」行で出る。
    const followRows = monitor.locator('.fx-stock .fxs-follow');
    await expect(followRows).toHaveCount(2, { timeout: 10_000 });
    await expect(followRows.nth(0)).toContainText('フォロー太郎');
    // worker はまだ follow を適用していない(gift の +1 だけ = 101)。
    expect((await challengeGet(main)).value).toBe(101);

    // 【A3 の検証】凍結明け: 2人ぶんが名前列 + ×2人 の合算バナー1枚になる。
    const banner = monitor.locator('.float.banner-follow.multi');
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText('フォロー太郎');
    await expect(banner).toContainText('フォロー花子');
    await expect(banner).toContainText('×2人がフォロー');
    await expect(banner.locator('.f-amt')).toHaveText('+20');

    // 値と統計(100 + gift 1 + follow 10×2)。
    const s = await challengeGet(main);
    expect(s.value).toBe(121);
    expect(s.stats.follows).toBe(2);

    // 【SE の検証】follow スロット(既定 follow-jam)の play() が観測されている。
    const plays = await monitor.evaluate(() => (window as unknown as { __sePlays: string[] }).__sePlays);
    expect(plays.some((src) => src.includes('follow-jam'))).toBe(true);

    // 【A1 の検証】[challenge/social] の診断(保留 → 適用 → 合算)が残っている。
    const diag = await rpc<DiagEntry[]>(main, 'diag.recent', undefined);
    const social = diag.filter((e) => e.message.includes('[challenge/social]'));
    expect(social.some((e) => e.message.includes('保留'))).toBe(true);
    expect(social.some((e) => e.message.includes('適用 +10'))).toBe(true);
    expect(social.some((e) => e.message.includes('凍結明け合算 follow ×2'))).toBe(true);
  });
});

test.describe('フォロー妨害(即時経路 — 従来文言の不変)', () => {
  // 凍結源を全部落とすと follow は即時適用 = 1人ずつの単発バナーになる。
  test.use({
    settingsPatch: {
      challenge: {
        ...FOLLOW_SETTINGS.challenge,
        giftBandFx: { enabled: false, bands: [] },
        fxClipsEnabled: false,
        seEnabled: false,
      },
    },
  });

  test('単発バナーは multi なし・従来の「◯◯がフォロー!」のまま', async ({ app, main }) => {
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // 1人目の単発バナー(multi クラスは付かない)。
    const banner = monitor.locator('.float.banner-follow');
    await expect(banner).toBeVisible({ timeout: 20_000 });
    await expect(banner).toContainText('がフォロー!');
    await expect(banner).not.toContainText('人がフォロー');
    expect(await banner.evaluate((el) => el.classList.contains('multi'))).toBe(false);

    // 値は即時に入る(100 + gift 1 + follow 10×2)。
    await expect.poll(async () => (await challengeGet(main)).value, { timeout: 10_000 }).toBe(121);
    expect((await challengeGet(main)).stats.follows).toBe(2);
  });
});
