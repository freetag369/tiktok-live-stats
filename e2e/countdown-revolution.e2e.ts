import { resolve } from 'node:path';
import { expect, openMonitor, segValue, test } from './fixtures';
import { challengeGet, diagBaseline, diagErrorsSince, rpc } from './helpers/rpc';

/**
 * 革命(白鳥 / Swan・699💎)。
 *
 * 窓の規則(倍率の焼き込み・延長と上限クランプ・分岐順序・アーム→コミット)は
 * L1(worker エンジンと純関数のユニット)が完全に覆っている。**ここでしか取れない
 * のはプロセスを跨いだ事実** — 設定ファイルの revolution 行が worker まで届き、
 * 実イベント(NDJSON リプレイ)のギフト着弾で窓が開き、**いいねの符号が本当に
 * 反転して7セグの数字が減り**、タップが×N で即時に効くこと。
 *
 * この機能で最悪の壊れ方は演出のバグではなく「1分間ゲーム経済が逆向きのまま
 * 戻らない」なので、開通(窓オープン)から復帰(期限切れ)までを筋で見る。
 *
 * ## モードの分け方(既存 E2E の流儀に合わせる)
 * worker の `fxAllowed()` は `monitorOpen && monitorBandFx` で、bandFx はモニターが
 * `challenge.fxCaps` で申告する。**`--force-prefers-reduced-motion`(ハーネス既定)は
 * レンダラの matchMedia には効かない**ので、モニターを開けば bandFx は true になり
 * シネマティック(アーム → 導入 → カウントダウン → 窓オープン)で走る。
 * countdown-boost.e2e.ts が「プレーンモード = モニターを開かない」で書いているのと
 * 同じ理由・同じ手口をここでも採る:
 *   - モニターを開くテスト  → シネマティック(11 秒の前置きを跨いで窓が開く筋を見る)
 *   - モニターを開かないテスト → プレーン(着弾と同時に窓オープン)
 * どちらも「窓が開いてから」の会計(いいね反転・タップ×N)は同じなので、
 * 反転の本体は待ちの短いプレーン側で、演出の筋はシネマ側で見る。
 */

/** fixtures/e2e-revolution-trigger.ndjson の白鳥(合成 giftId — 実 giftId は未採取)。 */
const TRIGGER_GIFT_ID = 'e2e-swan';

/** 窓中のタップ倍率。既定と同じ 3(ユーザー要件の値が生きて読まれることの検証を兼ねる)。 */
const REV_MULT = 3;

/**
 * 期限切れを見るテストの尺。REVOLUTION_DURATION_MIN_SEC(10)そのもの —
 * E2E の待ち時間を最小にする(clamp の妥当性は L1 の validate が持つ)。
 */
const REV_SHORT_SEC = 10;

/** 革命1行だけを有効にした challenge 設定。ほかの演出・凍結は全部落としたまま。 */
function revSettings(durationSec: number): Record<string, unknown> {
  return {
    challenge: {
      enabled: true,
      title: 'E2E 革命',
      initialValue: 100,
      pressStep: 1,
      followStep: 0,
      // ── いいね妨害を**有効**にする。革命の本体は「妨害がお助けに反転する」ことで、
      //    無効(likeEvery: 0)だと likeOp ごと早期 return して反転が観測できない。
      //    every 1 = いいね1件でゲージ満タン(窓の内外で1件ずつ落とせる最小構成)。
      //    step 5 は pressStep(1)とも倍率(3)とも被らない値 — 失敗時に
      //    「どちらの経路が壊れたか」が値だけで判る。
      likeEvery: 1,
      likeStep: 5,
      // ストックはゲージ満タンの従属機能。反転の検証はゲージ側だけで足りるので落とす
      // (likeStockDown の反転は L1 の担当)。
      likeStockCount: 0,
      // トリガーギフト自体が値を動かさないよう既定の増減を無効化する
      // (革命一致時は増減規則を通らないが、念のため素の状態にしておく)。
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
        // 既定は false(DEFAULT_REVOLUTION)。**設定で明示的に入れた ON が
        // worker まで届くこと**自体がこのテストの前提条件のひとつ。
        enabled: true,
        rules: [
          {
            id: 'e2e-rev',
            label: '白鳥',
            enabled: true,
            // 同梱既定の行は giftId 空 + giftName 'swan' の完全一致(実 giftId 未採取)。
            // E2E は取り違えの余地を残さないよう giftId 一本で当てる(taplock / boost の
            // E2E と同じ流儀)。名前一致そのものは L1 の matchGiftTrigger が持つ。
            giftId: TRIGGER_GIFT_ID,
            giftName: '',
            canonical: '',
            exactName: false,
            multiplier: REV_MULT,
            durationSec,
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
      // challenge を丸ごと差し替えるので、seedSettings が持っていた明示 OFF は
      // 引き継がれない。最終ゲートは**キー欠損が有効へ倒れる**(DEFAULT_FINAL_GATE)
      // ので必ず書く — 窓中はゲート免除なのでどちらでも通るが、対照の「窓の外の
      // 1タップ 1減」がゲートに食われると原因が判らなくなる。
      finalGate: { enabled: false, taps: 30 },
    },
  };
}

const FIXTURE = resolve('fixtures/e2e-revolution-trigger.ndjson').replaceAll('\\', '/');

/**
 * fixture が流し終わったときの累計。窓の外の1件(+5)と窓の中の2件(-5 / -10)。
 * likeDown は「反転が全部落ちた」ことの終端条件としても使う — speed: 0 の
 * リプレイは非同期にドレインされるので、件数で待たないと途中を観測しうる。
 */
const LIKE_UP_TOTAL = 5; // 窓の外: count=1 → 1満タン × step 5
const LIKE_DOWN_TOTAL = 15; // 窓の中: count=1(5) + count=2(10)
const LIKE_DOWN_FILLS = 3; // 反転側の満タン回数(1 + 2)

test.describe('革命(プレーン・いいね反転 + タップ×3)', () => {
  test.use({ settingsPatch: revSettings(60) });

  test('白鳥の着弾で窓が開き、いいねが減算になり、タップが×3で即時に効く', async ({ main }) => {
    const baseline = await diagBaseline(main);
    await rpc(main, 'challenge.start', undefined);
    // **モニターは開かない** = fxAllowed() が false = プレーン即発動。
    // 着弾から窓が開くまでが決定的になる(countdown-boost.e2e.ts の
    // 「プレーンモード(モニターを開かない)」と同じ手口)。

    // ① 対照: 窓が開く前のタップは等倍(1減)。この後の「3減」が本物であることの担保。
    await rpc(main, 'challenge.press', undefined);
    expect((await challengeGet(main)).value).toBe(99);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ② 白鳥の着弾で窓が開く。プレーンなので前置き(導入6秒 + カウント5秒)は 0 で、
    //    着弾と同時に ChallengeState.revolution が載る。
    await expect
      .poll(async () => (await challengeGet(main)).revolution?.multiplier ?? null, { timeout: 20_000 })
      .toBe(REV_MULT);

    // ③ いいねが**反転**する。窓の外の1件は加算のまま、窓の中の2件は減算。
    //    likeDown が終端値になるまで待つ(リプレイのドレインは非同期)。
    await expect
      .poll(async () => (await challengeGet(main)).stats.likeDown, { timeout: 20_000 })
      .toBe(LIKE_DOWN_TOTAL);
    const s1 = await challengeGet(main);
    expect(s1.stats.likeUp).toBe(LIKE_UP_TOTAL);
    expect(s1.likeGauge?.downFills).toBe(LIKE_DOWN_FILLS);
    // 99(対照タップ後) + 5(窓の外) - 5 - 10(窓の中)= 89。
    expect(s1.value).toBe(89);
    // トリガーギフト(699💎)自体は値を動かさない — 革命一致で先勝ちし、
    // 増減規則(giftDefault / giftRules)は評価すらされない。
    expect(s1.stats.giftDown).toBe(0);
    expect(s1.stats.giftUp).toBe(0);

    // ④ 窓中のタップは pressStep 1 × 倍率 3 = 3 減る。**即時**(フィーバーのように
    //    溜めて清算しない)なので、押した直後に効く。
    await rpc(main, 'challenge.press', undefined);
    const s2 = await challengeGet(main);
    expect(s2.value).toBe(86);
    expect(s2.stats.presses).toBe(2); // 対照の1回 + 窓中の1回

    // main / worker / renderer のどれもエラーを出していない。
    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });
});

test.describe('革命(シネマ・導入 → カウントダウン → 窓オープン)', () => {
  // モニターを開くと bandFx が true で申告され、worker は**アーム**する
  // (窓は「モニターが導入を再生し始めた時刻 + 前置き」から開く)。
  // ここでしか取れないのは、その 11 秒の筋がプロセスを跨いで本当に成立すること。
  test.use({ reducedMotion: false, settingsPatch: revSettings(60) });

  test('導入カットインと画面一杯のカウントダウンを経て窓が開き、HUD が出る', async ({ app, main }) => {
    const baseline = await diagBaseline(main);
    await rpc(main, 'challenge.start', undefined);
    const monitor = await openMonitor(app, main);
    expect(await segValue(monitor)).toBe(100);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // ① 導入の全面カット(不透明フルフレーム・音声焼き込み)。素材は
    //    assets/fx/revolution/intro.mp4(白鳥の戦闘モード突入・8秒)。
    //    尺の権威は素材ではなく JS タイマー(REVOLUTION_INTRO_MS)。
    await expect(monitor.locator('video.fx-clip-opaque')).toHaveCount(1, { timeout: 20_000 });

    // ② 導入(8秒)明けの画面一杯カウントダウン。**動画より手前**に出ること自体が
    //    「fx-layer 内・DOM 順で後ろ」の配置が効いている証拠(z-index は付けていない)。
    await expect(monitor.locator('.revolution-count')).toHaveCount(1, { timeout: 20_000 });

    // ③ 前置き(導入8秒 + カウント5秒 = 13秒)が明けると窓が開く。worker 側の
    //    ChallengeState.revolution は revolutionCue(モニターの実再生開始)を原点に張る。
    await expect
      .poll(async () => (await challengeGet(main)).revolution?.multiplier ?? null, { timeout: 30_000 })
      .toBe(REV_MULT);

    // ④ 窓中の走行 HUD。カウントダウンと排他(終了5秒前は HUD を畳む)なので、
    //    ここで両方が同時に出ていないことも見ておく。
    await expect(monitor.locator('.revolution-overlay')).toHaveCount(1, { timeout: 20_000 });
    await expect(monitor.locator('.revolution-mult')).toHaveText(`×${REV_MULT}`);
    await expect(monitor.locator('.revolution-count')).toHaveCount(0);

    // ⑤ 告知ボックスは REVOLUTION_HUD_INTRO_MS(5秒)だけ。以後は7セグ脇のピルが
    //    残り時間を引き継ぐ(2026-08-20 ユーザー決定 — 盤面を1分間ふさぎ続けない)。
    //    引き継ぎは 250ms の tick + 描画時 Date.now() 駆動なので、リプレイが
    //    終わって worker の 2Hz tick が死んでいても必ず進む(ここが取れる唯一の場所)。
    await expect(monitor.locator('.revolution-overlay')).toHaveCount(0, { timeout: 20_000 });
    await expect(monitor.locator('.revolution-timer')).toHaveCount(1);
    await expect(monitor.locator('.rt-mult')).toHaveText(`×${REV_MULT}`);

    // ⑥ 窓オープンで、導入中に凍結キューへ積まれていたいいねが一括ドレインされる。
    //    **press の前に終端値まで待つ** — ドレインは 2Hz tick か次の RPC が引き金なので、
    //    HUD が出た時点ではまだ流れ切っていないことがある(待たないと press の減算と
    //    ドレインの減算が同じ窓に入り、期待値がズレる)。
    await expect
      .poll(async () => (await challengeGet(main)).stats.likeDown, { timeout: 20_000 })
      .toBe(LIKE_DOWN_TOTAL);

    //    窓が開いた後のタップは ×3 で即時。
    const before = (await challengeGet(main)).value;
    await rpc(main, 'challenge.press', undefined);
    await expect.poll(async () => (await challengeGet(main)).value, { timeout: 10_000 }).toBe(before - 3);
    await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(before - 3);

    const errors = await diagErrorsSince(main, baseline);
    expect(errors.map((e) => `[${e.scope}] ${e.message}`)).toEqual([]);
  });
});

test.describe('革命の期限切れ(窓が閉じて通常挙動へ戻る)', () => {
  test.use({ settingsPatch: revSettings(REV_SHORT_SEC) });

  /**
   * 「窓が閉じない」= 配信1本ぶんゲーム経済が逆向きのまま、が最悪の事故なので
   * 復帰までを1本で見る。期限の唯一の出口は worker の armFreezeTimer —
   * E2E は speed: 0 のリプレイが即座に終わって 2Hz tick が死ぬので、
   * 「tick に相乗りしているだけ」の実装ならここで必ず落ちる(ブーストの
   * 清算タイマー欠落と同型の罠)。
   *
   * ⚠️ いいね側の復帰(窓明けに再び**加算**へ戻ること)はここでは見ない。
   * 期限後のいいねを作るには窓が閉じた後に届く2本目のいいねが要るが、
   * speed: 0 のリプレイは NDJSON を一気に流し切るので同一ファイルでは作れず、
   * 同じ fixture を撃ち直しても msgId 重複ガード(seenLikeMsgIds)で捨てられる。
   * speed: 1 + 大きなオフセットで作ることは可能だが、着弾時刻と窓の期限の差が
   * イベントループの停止(CI の windows ランナーで実績あり)で容易に逆転して
   * 偽陽性になるため採らない。**符号の復帰は L1(worker ユニット)の担当**で、
   * ここは「窓が本当に閉じる」+「タップが等倍へ戻る」までを見る。
   */
  test('尺が切れると revolution が消え、タップが等倍へ戻る', async ({ app, main }) => {
    await rpc(main, 'challenge.start', undefined);
    // モニターは**開く**(終了5秒前カウントダウンの表示まで見たいため)。ただし
    // 開くとシネマになり前置き 13 秒が乗るので、窓は着弾の 13 秒後から 10 秒間。
    // 下の待ちのタイムアウトはそれを織り込んである。
    const monitor = await openMonitor(app, main);

    await rpc(main, 'conn.startReplay', { file: FIXTURE, speed: 0 });

    // 反転が全部落ちるまで待つ(= 窓が開いていることの実質的な証明)。
    // **期限に関わる待ちより先**に済ませる — 尺が 10 秒しかないので、
    // 終了5秒前カウントダウンを待ってからこれをやると窓を跨ぎうる。
    await expect
      .poll(async () => (await challengeGet(main)).stats.likeDown, { timeout: 20_000 })
      .toBe(LIKE_DOWN_TOTAL);
    const open = await challengeGet(main);
    expect(open.revolution?.multiplier).toBe(REV_MULT);
    // 対照タップ無しなので 100 + 5 - 5 - 10 = 90。
    expect(open.value).toBe(90);

    // 終了5秒前の大型カウントダウン(5..1)。開始側の 5..1 は既に終わって窓が
    // 開いている(上で反転を確認済み)ので、ここで再び出るのは**終了側**
    // = 期限が ChallengeState.revolution.endsAtMs から正しく数えられている証拠。
    await expect(monitor.locator('.revolution-count')).toHaveCount(1, { timeout: 20_000 });

    // 期限で**本当に閉じる**。ここが通らない = 経済が逆向きのまま戻らない事故。
    await expect
      .poll(async () => (await challengeGet(main)).revolution ?? null, {
        timeout: (REV_SHORT_SEC + 15) * 1000,
      })
      .toBe(null);
    await expect(monitor.locator('.revolution-overlay')).toHaveCount(0);
    await expect(monitor.locator('.revolution-count')).toHaveCount(0, { timeout: 10_000 });

    // ── 結果カットシーン(窓の締めくくり)──────────────────────────────
    // 窓が閉じた瞬間に「6秒の全面動画 + 戦果の発表」が出る。ここが出ない =
    // 1分かけた窓の結末が無言で消える(バナー1枚だけだった v0.11.0 の状態)。
    // この fixture は反転いいねだけで 15 減らし、タップは窓の中で1度も押していない。
    const end = (await challengeGet(main)).recentEffects.find((x) => x.kind === 'revolution-end');
    expect(end, 'revolution-end が積まれていない').toBeDefined();
    expect(end!.revolutionDownTotal).toBe(LIKE_DOWN_TOTAL);
    expect(end!.revolutionTapCount).toBe(0);
    expect(end!.revolutionLikeDown).toBe(LIKE_DOWN_TOTAL);

    const settle = monitor.locator('.revolution-settle');
    await expect(settle).toHaveCount(1, { timeout: 10_000 });
    // ロールアップが確定したら実数が出る(回転中は別の桁が出ているので poll する)。
    await expect(settle.locator('.rs-amt')).toHaveText(`-${LIKE_DOWN_TOTAL}`, { timeout: 10_000 });
    // ②タップ回数 →③いいね反転 の順に出そろう。
    await expect(settle.locator('.rs-tile:not(.hidden)')).toHaveCount(2, { timeout: 10_000 });
    // 尺は REVOLUTION_RESULT_MS(6秒)— タイマーが権威なので必ず自分で畳む。
    await expect(settle).toHaveCount(0, { timeout: 15_000 });

    // タップが等倍へ戻る(×3 のままなら 87 になる)。
    await rpc(main, 'challenge.press', undefined);
    await expect.poll(() => segValue(monitor), { timeout: 10_000 }).toBe(89);
    expect((await challengeGet(main)).value).toBe(89);
  });
});
