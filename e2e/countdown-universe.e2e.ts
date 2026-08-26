import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, diagBaseline, diagErrorsSince, rpc } from './helpers/rpc';

/**
 * 一撃クリア(TIKTOK UNIVERSE・44,999💎)。
 *
 * 判定・状態機械・30 分割の算術は L1(worker エンジンと純関数のユニット)が完全に
 * 覆っている。**ここでしか取れないのはプロセスを跨いだ事実** — 設定ファイルの
 * universe 行が worker まで届き、実イベント(NDJSON リプレイ)のギフト着弾で
 * **本当にカウントが 0 になり CLEAR まで到達する**こと、そして**モニターの7セグが
 * 実際に 0 へ着弾する**こと。
 *
 * ## モードの分け方(既存 E2E の流儀に合わせる)
 * worker の `fxAllowed()` は `monitorOpen && monitorBandFx` なので:
 *   - モニターを開かないテスト → プレーン(着弾と同時に 0 + CLEAR。数秒で終わる)
 *   - モニターを開くテスト     → シネマ(25 秒の通しを7セグで見る)
 *
 * ## ★ この E2E は「清算が 2Hz tick に依存しない」の検出器でもある
 * `speed: 0` のリプレイは NDJSON を一瞬で流し切って `drainIfChanged` が止まる
 * (配信終了・切断と同じ状態)。清算を 2Hz tick に相乗りさせた実装だと、シネマ側の
 * 「7セグが 0 に着く」で必ず落ちる。**観測点を `segValue(monitor)`(モニターの DOM)
 * にしてあるのが要点** — `challengeGet` の poll は RPC が worker のドレインを誘発
 * しうるので、「RPC を撃たなければ進まない」実装を偽陽性で通してしまう。
 */

/** fixtures/e2e-universe-trigger.ndjson の合成 giftId(実 giftId は未採取)。 */
const TRIGGER_GIFT_ID = 'e2e-universe';

/** 30 で割り切れない初期値 — 端数の分配がプロセスを跨いでも合うことを同時に見る。 */
const INITIAL = 100;

/** 演出の総尺(shared/universe.ts の UNIVERSE_TOTAL_MS と対。E2E は定数を import しない)。 */
const TOTAL_MS = 25_000;

/** 一撃クリア1行だけを有効にした challenge 設定。ほかの演出・凍結は全部落としたまま。 */
function universeSettings(): Record<string, unknown> {
  return {
    challenge: {
      enabled: true,
      title: 'E2E 一撃クリア',
      initialValue: INITIAL,
      pressStep: 1,
      followStep: 0,
      // いいねは混ぜない(この機能の検証に要らない)。
      likeEvery: 0,
      likeStep: 0,
      likeStockCount: 0,
      // 対照の Rose が値を動かすようにしておく — バリアと「達成後は無視」の検出器。
      giftDefault: { mode: 'fixed', amount: 7 },
      giftRules: [],
      // ダイヤ増減は既定オン(欠損はオンへ倒れる)なので明示的に落とす — settingsPatch は
      // トップレベルの浅いマージで challenge を丸ごと差し替えるため、fixtures.ts の
      // 既定は届かない(finalGate / commentHelper と同じ規約)。
      giftScale: { enabled: false },
      commentRules: [],
      roulettes: [],
      joinRoulette: { enabled: false },
      giftBandFx: { enabled: false, bands: [] },
      giftFullCut: { enabled: false, rules: [] },
      fanStamp: { enabled: false },
      commentHelper: { enabled: false },
      tapBoost: { enabled: false, rules: [] },
      tapLock: { enabled: false, rules: [] },
      revolution: { enabled: false, rules: [] },
      quiz: { enabled: false, rules: [], thresholds: [] },
      universe: {
        // 既定は false(DEFAULT_UNIVERSE)。**設定で明示的に入れた ON が worker まで
        // 届くこと**自体がこのテストの前提条件のひとつ。
        enabled: true,
        rules: [
          {
            id: 'e2e-uni',
            label: '一撃クリア',
            // 同梱既定の行は giftId 空 + giftName 完全一致(実 giftId 未採取)。
            // E2E は取り違えの余地を残さないよう giftId 一本で当てる(revolution /
            // taplock の E2E と同じ流儀)。名前一致そのものは L1 が持つ。
            enabled: true,
            giftId: TRIGGER_GIFT_ID,
            giftName: '',
            canonical: '',
            exactName: false,
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
      // challenge を丸ごと差し替えるので seedSettings の明示 OFF は引き継がれない。
      // 最終ゲートは**キー欠損が有効へ倒れる**(DEFAULT_FINAL_GATE)ので必ず書く —
      // 対照タップがゲートに食われると原因が判らなくなる。
      finalGate: { enabled: false, taps: 30 },
    },
  };
}

const FIXTURE = resolve('fixtures/e2e-universe-trigger.ndjson').replaceAll('\\', '/');

test.describe('一撃クリア(プレーン・着弾で即 0 + CLEAR)', () => {
  test.use({ settingsPatch: universeSettings() });

  test('TIKTOK UNIVERSE の着弾でカウントが 0 になり達成する', async ({ main }) => {
    const baseline = await diagBaseline(main);
    await rpc(main, 'challenge.start', undefined);
    // **モニターは開かない** = fxAllowed() が false = プレーン即クリア。

    // ① 対照: 発動前のタップは普通に1減る。
    await rpc(main, 'challenge.press', undefined);
    expect((await challengeGet(main)).value).toBe(INITIAL - 1);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ② 着弾で 0 + CLEAR。プレーンなので演出の 25 秒は挟まらない。
    await expect
      .poll(async () => (await challengeGet(main)).status, { timeout: 20_000 })
      .toBe('achieved');
    const s = await challengeGet(main);
    expect(s.value).toBe(0);
    // ③ 減算量は「発動時点の残量」— stats.universeDown が独立枠で数えている。
    expect(s.stats.universeDown).toBe(INITIAL - 1);
    // ④ トリガーギフト(44,999💎)自体は値を動かさない — 一撃クリア一致で先勝ちし、
    //    増減規則(giftDefault)は評価すらされない。同じ理由で、達成後に届いた
    //    Rose(+7)も無視される(status ガード)。
    expect(s.stats.giftUp).toBe(0);
    expect(s.stats.giftDown).toBe(0);
    // ⑤ 履歴は universe-start → universe-end → achieved の順。
    const kinds = s.recentEffects.map((e) => e.kind);
    expect(kinds).toContain('universe-start');
    expect(kinds).toContain('universe-end');
    expect(kinds).toContain('achieved');

    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });
});

test.describe('一撃クリア(シネマ・25 秒の通し)', () => {
  test.use({ settingsPatch: universeSettings(), reducedMotion: false });

  test('7セグが 0 へ着弾し、そのあとで CLEAR になる', async ({ app, main }) => {
    // 25 秒の演出 + Electron 起動 + CLEAR まで見るので既定(非CI 60 秒)では溢れる。
    test.setTimeout(120_000);
    const baseline = await diagBaseline(main);
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(INITIAL);

    const startedAt = Date.now();
    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ① 7セグが 0 に着く。**観測点はモニターの DOM** — challengeGet の poll に
    //    すると RPC が worker のドレインを誘発して偽陽性になりうる。
    await expect.poll(async () => segValue(monitor), { timeout: 60_000 }).toBe(0);

    // ② 一気に飛んでいない(導入 8 秒 + 減算 9 秒ぶんは必ず経っている)。
    //    ここが「30 段を実際に刻んだ」ことの唯一のプロセス跨ぎの証拠。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(16_000);

    // ③ 締めのカットインが終わってから CLEAR。0 到達より必ず後になる。
    await expect
      .poll(async () => (await challengeGet(main)).status, { timeout: 30_000 })
      .toBe('achieved');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(TOTAL_MS - 2_000);

    // ④ 演出中に届いた Rose(+7)はバリアで止まり、達成で破棄されている。
    const s = await challengeGet(main);
    expect(s.value).toBe(0);
    expect(s.stats.giftUp).toBe(0);
    // ⑤ 演出が畳まれて universe キーが消えている(孤児窓が残らない)。
    expect(s.universe ?? null).toBeNull();

    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });
});
