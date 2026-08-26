import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, diagBaseline, diagErrorsSince, rpc } from './helpers/rpc';

/**
 * ライオン(Lion・29,999💎)。
 *
 * 判定・状態機械・段組の算術は L1(worker エンジンと純関数のユニット)が完全に
 * 覆っている。**ここでしか取れないのはプロセスを跨いだ事実** — 設定ファイルの
 * lion 行が worker まで届き、実イベント(NDJSON リプレイ)のギフト着弾で
 * **本当にカウントが +1,499,950 される**こと、そして**モニターの7セグが実際に
 * その値へ跳ねる**こと。
 *
 * ## モードの分け方(既存 E2E の流儀に合わせる)
 * worker の `fxAllowed()` は `monitorOpen && monitorBandFx` なので:
 *   - モニターを開かないテスト → プレーン(着弾と同時に加算。数秒で終わる)
 *   - モニターを開くテスト     → シネマ(43 秒の通しを7セグで見る)
 *
 * ## ★ この E2E は「清算が 2Hz tick に依存しない」の検出器でもある
 * `speed: 0` のリプレイは NDJSON を一瞬で流し切って `drainIfChanged` が止まる
 * (配信終了・切断と同じ状態)。清算を 2Hz tick に相乗りさせた実装だと、シネマ側の
 * 「7セグが跳ねる」で必ず落ちる。**観測点を `segValue(monitor)`(モニターの DOM)
 * にしてあるのが要点** — `challengeGet` の poll は RPC が worker のドレインを誘発
 * しうるので、「RPC を撃たなければ進まない」実装を偽陽性で通してしまう。
 *
 * ## ★ universe との構造差もここで見る
 *  1. **清算は演出の終端ではなく段⑥の頭**(43,005 ではなく 38,005)。
 *  2. **走行中のタップは効く**(妨害なので押す手を止めさせない)。
 *  3. バリアの溜め分は**破棄せず移送**(Rose の +7 が最後に効く)。
 */

/** fixtures/e2e-lion-trigger.ndjson の giftId(**実採取値**)。 */
const TRIGGER_GIFT_ID = '6369';

const INITIAL = 100;
/** 1発の額 × 発数(E2E は shared の定数を import しない — 独立した写しで固定する)。 */
const EACH = 29_999;
const STEPS = 50;
const TOTAL = EACH * STEPS; // 1,499,950
/** 清算(段⑥の頭)= 10,000 + 3,000 + 3,000 + 245×49 + 10,000。 */
const SETTLE_MS = 38_005;

/** ライオン1行だけを有効にした challenge 設定。ほかの演出・凍結は全部落としたまま。 */
function lionSettings(): Record<string, unknown> {
  return {
    challenge: {
      enabled: true,
      title: 'E2E ライオン',
      initialValue: INITIAL,
      pressStep: 1,
      followStep: 0,
      // いいねは混ぜない(この機能の検証に要らない)。
      likeEvery: 0,
      likeStep: 0,
      likeStockCount: 0,
      // 対照の Rose が値を動かすようにしておく — バリアと「移送」の検出器。
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
      universe: { enabled: false, rules: [] },
      quiz: { enabled: false, rules: [], thresholds: [] },
      lion: {
        // 既定は **true**(DEFAULT_LION)だが、settingsPatch は challenge を丸ごと
        // 差し替えるので明示が要る。
        enabled: true,
        rules: [
          {
            id: 'e2e-lion',
            label: 'ライオン',
            enabled: true,
            giftId: TRIGGER_GIFT_ID,
            giftName: '',
            canonical: '',
            exactName: false,
            amountEach: EACH,
            steps: STEPS,
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
      // 最終ゲートは**キー欠損が有効へ倒れる**(DEFAULT_FINAL_GATE)ので必ず書く。
      finalGate: { enabled: false, taps: 30 },
    },
  };
}

const FIXTURE = resolve('fixtures/e2e-lion-trigger.ndjson').replaceAll('\\', '/');

test.describe('ライオン(プレーン・着弾で即加算)', () => {
  test.use({ settingsPatch: lionSettings() });

  test('Lion の着弾でカウントが +1,499,950 される', async ({ main }) => {
    const baseline = await diagBaseline(main);
    await rpc(main, 'challenge.start', undefined);
    // **モニターは開かない** = fxAllowed() が false = プレーン即発動。

    // ① 対照: 発動前のタップは普通に1減る。
    await rpc(main, 'challenge.press', undefined);
    expect((await challengeGet(main)).value).toBe(INITIAL - 1);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ② 着弾で加算。プレーンなので演出の 43 秒は挟まらない。
    await expect
      .poll(async () => (await challengeGet(main)).value, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(INITIAL - 1 + TOTAL);
    const s = await challengeGet(main);
    // ③ トリガーギフト(29,999💎)は増減規則(giftDefault +7)を通らない — 先勝ち。
    //    Rose(+7)はプレーンなのでバリアに掛からず素直に効く。
    expect(s.value).toBe(INITIAL - 1 + TOTAL + 7);
    // ④ 履歴は lion-start → lion-end の順。
    const kinds = s.recentEffects.map((e) => e.kind);
    expect(kinds).toContain('lion-start');
    expect(kinds).toContain('lion-end');
    // ⑤ 演出が畳まれて lion キーが消えている(孤児窓が残らない)。
    expect(s.lion ?? null).toBeNull();

    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });
});

test.describe('ライオン(シネマ・43 秒の通し)', () => {
  test.use({ settingsPatch: lionSettings(), reducedMotion: false });

  test('7セグが段⑥で跳ね、走行中のタップも効いている', async ({ app, main }) => {
    // 43 秒の演出 + Electron 起動まで見るので既定(非CI 60 秒)では溢れる。
    test.setTimeout(150_000);
    const baseline = await diagBaseline(main);
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(INITIAL);

    const startedAt = Date.now();
    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ① アームされたのを待つ(バリアが立った印)。
    await expect
      .poll(async () => (await challengeGet(main)).lion != null, { timeout: 20_000 })
      .toBe(true);

    // ② ★走行中のタップは効く(universe との振る舞い差)。幕の裏で 3 減る。
    for (let i = 0; i < 3; i++) await rpc(main, 'challenge.press', undefined);
    await expect.poll(async () => segValue(monitor), { timeout: 10_000 }).toBe(INITIAL - 3);

    // ③ 7セグが加算後の値へ跳ねる。**観測点はモニターの DOM** — challengeGet の
    //    poll にすると RPC が worker のドレインを誘発して偽陽性になりうる。
    await expect
      .poll(async () => segValue(monitor), { timeout: 90_000 })
      .toBe(INITIAL - 3 + TOTAL);

    // ④ 一気に飛んでいない(導入10秒 + 札3秒 + ボイス3秒 + 連打12秒 + 全面10秒は
    //    必ず経っている)。ここが「段を実際に刻んだ」ことの唯一のプロセス跨ぎの証拠。
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(SETTLE_MS - 3_000);

    // ⑤ ★バリアの溜め分は**破棄せず移送**(universe との判断差)。凍結明けに Rose が効く。
    await expect
      .poll(async () => (await challengeGet(main)).value, { timeout: 30_000 })
      .toBe(INITIAL - 3 + TOTAL + 7);

    const s = await challengeGet(main);
    expect(s.lion ?? null).toBeNull();
    expect(s.status).toBe('running'); // 妨害なので CLEAR にはならない
    const kinds = s.recentEffects.map((e) => e.kind);
    expect(kinds).toContain('lion-start');
    expect(kinds).toContain('lion-end');

    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });
});
