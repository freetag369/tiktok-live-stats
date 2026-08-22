import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, diagBaseline, diagErrorsSince, rpc } from './helpers/rpc';

/**
 * お題ルーレットの**数値到達トリガー**(2026-08-22 ユーザー要件
 * 「指定した数字に達した時 → ○○を超えました!と大きく告知 → 全面カット動画」)。
 *
 * 判定そのもの(ヒステリシス・同時跨ぎ・再武装)は L1 が完全に覆っている
 * (test/unit/quiz-threshold.spec.ts と challenge-quiz.spec.ts)。
 * **ここでしか取れないのはプロセスを跨いだ事実**:
 *   settings.json の thresholds 行が worker まで届き、実イベント(NDJSON リプレイ)の
 *   妨害でカウントが押し上がり、跨いだ瞬間に **モニターへ告知が本当に描かれ**、
 *   その告知が明けてから前置き(回転)へ繋がること。
 *
 * 告知は**ホールドを取らない常設オーバーレイ**なので、演出キューの消化を待たない —
 * ここではキューが空なので「跨ぐ → すぐ告知 → 4秒後に回転」が一直線に出る。
 *
 * 尺を最小にするため導入カットは落とす(fxClipsEnabled:false)。全面カット動画の
 * 再生そのものは band / tap-lock の E2E が持っており、この経路は「告知の直後に
 * 導入の段が来る」という**順序**が主題。
 */

/** e2e-follow.ndjson は 2 人ぶんのフォローを含む(1件目で既に跨ぐ)。 */
const FIXTURE = resolve('fixtures/e2e-follow.ndjson').replaceAll('\\', '/');

const INITIAL = 100;
/** フォロー1件の妨害量。1件で必ず THRESHOLD を跨ぐ値にする(2件目を待たない)。 */
const FOLLOW_STEP = 25;
/** しきい値。INITIAL より上・INITIAL + FOLLOW_STEP 以下。 */
const THRESHOLD = 120;

function thresholdSettings(): Record<string, unknown> {
  return {
    challenge: {
      enabled: true,
      title: 'E2E 数値到達',
      initialValue: INITIAL,
      pressStep: 1,
      // フォローだけがカウントを押し上げる経路。ほかの妨害は全部落として、
      // 「120 を跨いだ」原因が1つしかない状態にする。
      followStep: FOLLOW_STEP,
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
      revolution: { enabled: false, rules: [] },
      quiz: {
        enabled: true,
        prompts: ['ものまね'],
        // clamp の下限そのもの(QUIZ_DURATION_MIN_SEC / QUIZ_VOTE_MIN_SEC)。
        durationSec: 10,
        voteSec: 5,
        // 発表準備は 0 で段ごとスキップ — この E2E の主題は告知 → 回転の繋がり。
        prepSec: 0,
        outroSec: 0,
        amount: 5000,
        introClip: 'off',
        bgm: 'off',
        // **ギフトでは絶対に発動しない行**にしておく — フィクスチャの Rose(5655)で
        // 発動してしまうと「数値で鳴った」ことの証明にならない。
        rules: [
          {
            id: 'e2e-quiz-gift',
            label: 'ギフト',
            enabled: true,
            giftId: 'e2e-never',
            giftName: '',
            canonical: '',
            exactName: false,
            flash: false,
          },
        ],
        thresholds: [
          {
            id: 'e2e-th',
            label: '大台',
            enabled: true,
            value: THRESHOLD,
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
      // challenge を丸ごと差し替えるのでキー欠損が有効へ倒れる finalGate は必ず書く。
      finalGate: { enabled: false, taps: 30 },
    },
  };
}

test.describe('数値到達でお題ルーレット(告知 → 前置き)', () => {
  test.use({ settingsPatch: thresholdSettings() });
  // 告知4秒 + 回転18秒に Electron 起動と openMonitor が乗る。
  test.setTimeout(120_000);

  test('カウントがしきい値を跨ぐと全画面の告知が出て、明けてから回転へ繋がる', async ({
    app,
    main,
  }) => {
    const baseline = await diagBaseline(main);
    const monitor = await openMonitor(app, main);
    await rpc(main, 'challenge.start', undefined);
    expect(await segValue(monitor)).toBe(INITIAL);

    // ① 開始した瞬間には鳴らない。しきい値(120)は初期値(100)より上なので
    //    「跨いでいない」状態から始まる — ここが鳴ると誤爆の回帰。
    expect((await challengeGet(main)).quiz).toBeUndefined();

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ② フォロー妨害でカウントが押し上がり、120 を跨いだ瞬間にアーム+告知ラッチ。
    //    **設定した数字がそのまま DTO に載る**(worker まで届いた証明)。
    await expect
      .poll(async () => (await challengeGet(main)).quiz?.announceThreshold ?? null, {
        timeout: 30_000,
      })
      .toBe(THRESHOLD);
    expect((await challengeGet(main)).quiz?.armed).toBe(true);
    expect((await challengeGet(main)).value).toBeGreaterThanOrEqual(THRESHOLD);

    // ③ **モニターに告知が本当に描かれる**。数字は桁区切り済みの文字列で、
    //    設定値と1文字も違ってはいけない(quizThresholdNum が唯一の出所)。
    await expect(monitor.locator('.quiz-screen.quiz-threshold')).toHaveCount(1, {
      timeout: 15_000,
    });
    await expect(monitor.locator('.quiz-screen.quiz-threshold .qz-th-num')).toHaveText(
      String(THRESHOLD)
    );
    await expect(monitor.locator('.quiz-screen.quiz-threshold .qz-th-suffix')).toHaveText(
      'を超えました!'
    );

    // ④ 告知が明けたら消えて、前置き(回転)へ繋がる。**同時に2枚出ない**のが要点 —
    //    告知の上に回転や導入カットが被さると、何を告知したのか読めなくなる。
    await expect(monitor.locator('.quiz-screen.quiz-spin')).toHaveCount(1, { timeout: 20_000 });
    await expect(monitor.locator('.quiz-screen.quiz-threshold')).toHaveCount(0);

    expect(await diagErrorsSince(main, baseline)).toEqual([]);
  });
});
