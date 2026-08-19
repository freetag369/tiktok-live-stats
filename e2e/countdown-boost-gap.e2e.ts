import { resolve } from 'node:path';
import { expect, openMonitor, test } from './fixtures';
import { rpc } from './helpers/rpc';

/**
 * 「フィーバーの起動カットインが始まる前に音が数秒消える」の回帰テスト。
 *
 * 実配信で一番多い並びを再現する — band1 のカットイン(6秒)の**最中**にトリガー
 * ギフトが着弾する。このとき worker は既に凍結しているので activateBoost は
 * pendingOps へ落ち、boost-start がモニターへ届くのは
 * **カットイン終了 + GIFT_FX_FREEZE_MARGIN_MS(500ms)後**になる。
 *
 * その 500ms の隙に finishBandFx のギフトカード(⑩)が舞台を取ると bannerEndAt が
 * +2200ms 伸び、起動カットインが **実測 2724ms** 遅れていた。先行カットインの音が
 * 切れてから咆哮が鳴るまで、画は動くのに音だけが完全に抜ける = ユーザー報告の症状。
 *
 * 修正後の実測は **525ms**(= 凍結マージン + delta 配送。worker がこれより早く
 * ブーストを出せないので、これが構造的な下限)。閾値はその倍以上・旧値の半分未満に
 * 置いて、下限のゆらぎでは落ちず回帰は必ず捕まえる位置にする。
 *
 * L1(fx-stage.spec.ts / boost-arm-silence.spec.ts)は判定と結線を固定するが、
 * 「worker の凍結明けとモニターの舞台が実時間でどう噛み合うか」はここでしか出ない。
 */
const BOOST_GIFT = '9999';
const FIXTURE = resolve('fixtures/e2e-boost-after-band.ndjson').replaceAll('\\', '/');

/** 修正前 2724ms / 修正後 525ms。下限(≒500ms)の倍以上、旧値の半分未満。 */
const GAP_BUDGET_MS = 1200;

const SETTINGS = {
  challenge: {
    enabled: true,
    title: 'E2E ブーストの空白',
    initialValue: 500,
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
    // 先行カットインを作る側。BGM は落として映像だけ見る。
    giftBandFx: {
      enabled: true,
      bgmEnabled: false,
      bgmVolume: 70,
      overflow: 'top',
      excludeGiftIds: [],
      bands: [
        { id: 'band1', min: 1, max: 50, clip: 'gift-band1', durationSec: 6, enabled: true, bgm: 'off' },
      ],
    },
    giftFullCut: { enabled: false, rules: [] },
    fanStamp: { enabled: false },
    finalGate: { enabled: false, taps: 30 },
    tapBoost: {
      enabled: true,
      rules: [
        {
          id: 'e2e-boost',
          label: 'E2E',
          enabled: true,
          giftId: BOOST_GIFT,
          giftName: '',
          canonical: '',
          exactName: false,
          multiplier: 5,
          durationSec: 5,
          introClip: 'intro-panther',
          countClip: 'count-321',
          loopClip: 'loop-panther',
          resultClip: 'off',
          flash: true,
        },
      ],
    },
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

interface Sample {
  t: number;
  src: string | null;
  floats: number;
  floatCls: string;
}

test.describe('フィーバー着弾の空白(先行カットインからの引き継ぎ)', () => {
  test.use({ reducedMotion: false, settingsPatch: SETTINGS });

  test('先行カットインが終わってから起動カットインが出るまでが予算内', async ({ app, main }) => {
    test.setTimeout(120_000);
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);

    // 25ms のページ内サンプラー。**モニターへ evaluate を撃ち続けない** —
    // カットイン再生中の Runtime.evaluate は詰まりやすく、ポーリングで
    // アプリを飢えさせると計測対象のタイミングごと歪む(実測で踏んだ)。
    await monitor.evaluate(() => {
      const w = window as unknown as { __samples: Sample[]; __sid: number };
      w.__samples = [];
      w.__sid = window.setInterval(() => {
        const v = document.querySelector('video.fx-clip-opaque');
        const raw = v ? v.getAttribute('src') ?? '' : '';
        const f = document.querySelector('.floats > .float');
        w.__samples.push({
          t: Date.now(),
          src: raw ? raw.split('/').pop()!.split('?')[0]! : null,
          floats: document.querySelectorAll('.floats > .float').length,
          floatCls: f ? f.className : '',
        });
      }, 25);
    });

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 1 });

    // 起動カットインが頭から出ること(出ない = 別の回帰)。
    await expect(monitor.locator('video.fx-clip-opaque')).toHaveAttribute(
      'src',
      /intro-panther/,
      { timeout: 60_000 }
    );

    const samples: Sample[] = await monitor.evaluate(() => {
      const w = window as unknown as { __samples: Sample[]; __sid: number };
      window.clearInterval(w.__sid);
      return w.__samples;
    });

    const has = (s: Sample, n: string): boolean => (s.src ?? '').includes(n);
    const lastBand = [...samples].reverse().find((s) => has(s, 'gift-band1'));
    const firstIntro = samples.find((s) => has(s, 'intro-panther'));
    expect(lastBand, 'band1 のカットインが観測できていない').toBeTruthy();
    expect(firstIntro, 'intro-panther が観測できていない').toBeTruthy();

    const gapMs = firstIntro!.t - lastBand!.t;
    const between = samples.filter((s) => s.t > lastBand!.t && s.t < firstIntro!.t);
    const banner = between.find((s) => s.floats > 0);

    // ★ 本命。旧実装なら 2700ms 級になる。
    expect(
      gapMs,
      `先行カットイン終了 → 起動カットイン開始 が ${gapMs}ms(予算 ${GAP_BUDGET_MS}ms)。` +
        `空白中のバナー: ${banner ? banner.floatCls : 'なし'}`
    ).toBeLessThan(GAP_BUDGET_MS);

    // ★ 原因の直接固定 — 空白の間にギフトカードが舞台を取っていないこと。
    // (旧実装ではここに 'gift-card' が居て bannerEndAt を +2200ms 伸ばしていた。)
    expect(
      banner?.floatCls ?? '',
      '空白の間にバナーが舞台を取っている(予告の待避が効いていない)'
    ).not.toContain('gift-card');
  });
});
