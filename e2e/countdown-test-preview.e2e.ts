import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, diagBaseline, diagErrorsSince, rpc } from './helpers/rpc';

/**
 * ▶テスト実演(フル尺プレビュー)— **ライブ未接続**で最後まで流れることの検証。
 *
 * 2026-08-21 ユーザー報告「お題ルーレット・革命をテスト再生しても最後まで見れない」。
 * 従来は前置きだけで終わっていた(worker が窓のラッチを作らず、本編の表示は
 * ChallengeState の state 駆動だったため)。
 *
 * **ここでしか取れない事実**は「接続していない = worker の 2Hz tick が一度も
 * 回らない状態で、窓が開き、時間が進み、結果カットシーンまで届くこと」。
 * session.startTimers() は conn.start / conn.startReplay でしか呼ばれないので、
 * このファイルは**リプレイを一度も流さない** — それが tick 非依存の証明になる。
 * 実装が tick に相乗りしているだけなら、ここで必ず固まる(フィーバーの清算
 * タイマー欠落と同型の罠)。
 *
 * 尺は各機能の最小値まで落とす(clamp の妥当性は L1 の validate が持つ):
 *   革命 = 導入8s + カウント5s + 窓10s + 結果6s ≒ 29 秒
 *   お題 = 回転18s + 決定4s + 準備5s + 窓10s + 投票5s + 結果6s ≒ 48 秒
 *
 * お題は 2026-08-22 に回転が 6→18 秒(ユーザー指定「今の3倍」)・決定が 2.5→4 秒に
 * なり、**既定の 60 秒予算(playwright.config.ts)に収まらなくなった**ので、
 * その describe だけ test.setTimeout で伸ばしている(尺を戻すのではなく待つ側を
 * 伸ばすのは、この E2E の主題が「tick 非依存で最後まで流れる」ことだから)。
 */

/** REVOLUTION_DURATION_MIN_SEC / QUIZ_DURATION_MIN_SEC / QUIZ_VOTE_MIN_SEC そのもの。 */
const REV_SHORT_SEC = 10;
const QUIZ_SHORT_SEC = 10;
const VOTE_SHORT_SEC = 5;
const REV_MULT = 3;

/**
 * 実演だけを見る設定。トリガー(giftId)は**空のまま**でよい — ▶実演は一致判定を
 * 評価しない(「チェックする前に見てみたい」の道具という既存の試写規約)。
 */
function previewSettings(): Record<string, unknown> {
  return {
    challenge: {
      enabled: true,
      title: 'E2E 実演',
      initialValue: 100,
      pressStep: 1,
      followStep: 0,
      likeEvery: 0,
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
      tapLock: { enabled: false, rules: [] },
      revolution: {
        enabled: true,
        rules: [
          {
            id: 'e2e-rev',
            label: '白鳥',
            enabled: true,
            giftId: '',
            giftName: '',
            canonical: '',
            exactName: false,
            multiplier: REV_MULT,
            durationSec: REV_SHORT_SEC,
            flash: false,
          },
        ],
      },
      quiz: {
        enabled: true,
        prompts: ['ものまね', '歌う'],
        durationSec: QUIZ_SHORT_SEC,
        voteSec: VOTE_SHORT_SEC,
        amount: 5000,
        // 導入クリップは既定どおり 'off'(素材未設定は自動スキップ)。
        introClip: 'off',
        bgm: 'off',
        rules: [
          {
            id: 'e2e-quiz',
            label: 'お題',
            enabled: true,
            giftId: '',
            giftName: '',
            canonical: '',
            exactName: false,
            flash: false,
          },
        ],
      },
      // 動画素材の再生は実演の主題ではない(カットインの再生自体は band/boost の
      // E2E が持つ)。ここは **窓と時間の進行**が主題なので落として待ちを短くする。
      fxClipsEnabled: false,
      miniFxEnabled: false,
      seEnabled: false,
      monitorWindowed: true,
      monitorDisplayId: null,
      hotkey: '',
      wakeEnabled: false,
      lowThreshold: 10,
      // challenge を丸ごと差し替えるのでキー欠損が有効へ倒れる finalGate は必ず書く。
      finalGate: { enabled: false, taps: 30 },
    },
  };
}

test.describe('▶テスト実演(革命)— 未接続でも窓と結果カットシーンまで流れる', () => {
  test.use({ settingsPatch: previewSettings() });

  test('導入 → カウントダウン → 走行HUD → 結果カットシーン。値は動かない', async ({ app, main }) => {
    const baseline = await diagBaseline(main);
    const monitor = await openMonitor(app, main);
    // **conn.start も startReplay も呼ばない** — 2Hz tick が無い状態が主題。
    expect(await segValue(monitor)).toBe(100);

    await rpc(main, 'challenge.testEffect', { kind: 'revolution' });

    // ① 前置き: 画面一杯のカウントダウン(導入クリップは fxClipsEnabled:false で
    //    暗幕になるが、尺は JS タイマーが権威なので必ず 5..1 まで来る)。
    await expect(monitor.locator('.revolution-count')).toHaveCount(1, { timeout: 30_000 });

    // ② 前置き明けで**窓が本当に開く**(従来はここで終わっていた)。実演の窓は
    //    worker の get() が実発動と同じ revolution キーへ合流させる。
    await expect
      .poll(async () => (await challengeGet(main)).revolution?.test ?? null, { timeout: 30_000 })
      .toBe(true);
    await expect(monitor.locator('.revolution-overlay')).toHaveCount(1, { timeout: 20_000 });
    await expect(monitor.locator('.revolution-mult')).toHaveText(`×${REV_MULT}`);

    // ③ 窓中のタップは実演として数えるが、**7セグは動かない**(実演の契約)。
    await rpc(main, 'challenge.press', undefined);
    await rpc(main, 'challenge.press', undefined);
    expect((await challengeGet(main)).value).toBe(100);
    expect(await segValue(monitor)).toBe(100);

    // ④ 窓が閉じて結果カットシーンへ。**armFreezeTimer が唯一の出口**なので、
    //    tick に相乗りしているだけの実装ならここで固まる。
    await expect
      .poll(
        async () =>
          (await challengeGet(main)).recentEffects.find((e) => e.kind === 'revolution-end') ?? null,
        { timeout: 40_000 }
      )
      .not.toBeNull();
    const end = (await challengeGet(main)).recentEffects.find((e) => e.kind === 'revolution-end')!;
    expect(end.test).toBe(true);
    expect(end.revolutionTapCount).toBe(2);
    expect(end.revolutionDownTotal).toBe(2 * REV_MULT);

    // ⑤ 戦果の発表(動画の上に重なる DOM)。
    await expect(monitor.locator('.revolution-settle')).toHaveCount(1, { timeout: 20_000 });

    // 窓は畳まれ、値は最後まで 100 のまま。
    await expect
      .poll(async () => (await challengeGet(main)).revolution ?? null, { timeout: 20_000 })
      .toBeNull();
    expect((await challengeGet(main)).value).toBe(100);

    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });

  test('「■ 停止」(stopTest)で窓が即座に畳まれ、結果も出ない', async ({ app, main }) => {
    const monitor = await openMonitor(app, main);
    await rpc(main, 'challenge.testEffect', { kind: 'revolution' });
    await expect
      .poll(async () => (await challengeGet(main)).revolution?.test ?? null, { timeout: 30_000 })
      .toBe(true);

    await rpc(main, 'challenge.testEffect', { kind: 'stopTest' });
    await expect
      .poll(async () => (await challengeGet(main)).revolution ?? null, { timeout: 10_000 })
      .toBeNull();
    // モニター側も state 駆動 abort で片付く。
    await expect(monitor.locator('.revolution-overlay')).toHaveCount(0, { timeout: 10_000 });
    await expect(monitor.locator('.revolution-timer')).toHaveCount(0);

    // 中断は締めくくりを出さない。
    await new Promise((r) => setTimeout(r, (REV_SHORT_SEC + 2) * 1000));
    expect(
      (await challengeGet(main)).recentEffects.some((e) => e.kind === 'revolution-end')
    ).toBe(false);
  });
});

test.describe('▶テスト実演(お題)— 未接続でも投票と結果発表まで流れる', () => {
  test.use({ settingsPatch: previewSettings() });
  // 本編だけで約 48 秒 + Electron 起動 + openMonitor。既定 60 秒では足りない。
  test.setTimeout(150_000);

  test('回転 → 挑戦ウィンドウ → 投票(ダミー票が伸びる)→ 結果発表', async ({ app, main }) => {
    const baseline = await diagBaseline(main);
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(100);

    await rpc(main, 'challenge.testEffect', { kind: 'quiz' });

    // ① 実演の窓は armed を立てない — 立てるとモニターの armed 監視が本物の
    //    quizCue を撃ってしまう。ここが崩れると本番の発動が実演に乗っ取られる。
    await expect
      .poll(async () => (await challengeGet(main)).quiz?.test ?? null, { timeout: 30_000 })
      .toBe(true);
    expect((await challengeGet(main)).quiz?.armed).toBeUndefined();

    // ② 前置き明けで挑戦ウィンドウの常設オーバーレイ(ホールドを取らない表示)。
    await expect(monitor.locator('.quiz-window-overlay')).toHaveCount(1, { timeout: 30_000 });

    // ③ 窓中のタップは破棄され blocked が伸びる(本番と同じ手応え)。値は不変。
    await rpc(main, 'challenge.press', undefined);
    await expect
      .poll(async () => (await challengeGet(main)).quiz?.blocked ?? 0, { timeout: 10_000 })
      .toBeGreaterThan(0);
    expect((await challengeGet(main)).value).toBe(100);

    // ④ 投票タイム。ダミー票が**実際に増えていく**(worker が armFreezeTimer で
    //    自分を起こしている証拠 — 未接続では他に delta を押し出す者が居ない)。
    await expect(monitor.locator('.quiz-vote-overlay')).toHaveCount(1, { timeout: 30_000 });
    await expect
      .poll(
        async () => {
          const q = (await challengeGet(main)).quiz;
          return (q?.good ?? 0) + (q?.bad ?? 0);
        },
        { timeout: 20_000 }
      )
      .toBeGreaterThan(0);

    // ⑤ 結果発表。ダミー票は必ず決着するので ±N の段まで出る。
    await expect
      .poll(
        async () => (await challengeGet(main)).recentEffects.find((e) => e.kind === 'quiz-end') ?? null,
        { timeout: 40_000 }
      )
      .not.toBeNull();
    const end = (await challengeGet(main)).recentEffects.find((e) => e.kind === 'quiz-end')!;
    expect(end.test).toBe(true);
    expect(end.quizGood).not.toBe(end.quizBad);
    expect(Math.abs(end.amount)).toBe(5000);
    await expect(monitor.locator('.quiz-settle')).toHaveCount(1, { timeout: 20_000 });

    // ⑥ 値も統計も最後まで動かない(実演の契約 — 表示だけ ±5000 が流れる)。
    expect((await challengeGet(main)).value).toBe(100);
    expect((await challengeGet(main)).stats.quizDown).toBe(0);
    expect((await challengeGet(main)).stats.quizUp).toBe(0);

    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });
});
