/**
 * ライオン(Lion 29,999💎)の尺と段組の凍結。
 *
 * ここが守るのは3つ:
 *  1. **ユーザー確定値**(導入10秒 + 1枚3秒 + ボイス3秒 + 245ms×49 + 全面10秒 +
 *     合計5秒 / 29,999 × 50 = 1,499,950)が素材の差し替えやリファクタで静かに
 *     動かないこと。
 *  2. **清算(worker が値を積む時刻)が段⑥の頭**であること — ここが末尾へずれると
 *     「合計を読ませてから数字が動く」順序になり、演出の意味が壊れる。
 *  3. **連打の間隔 × playSe のプール本数 ≥ 爆発音の素材長** — この不等式が破れると
 *     5発目がプールの最古を巻き戻して尻尾を切り、49 連打が痩せる。
 *
 * 純関数なので renderer を import せずに検査できる(universe.spec.ts と同じ理由)。
 */
import { describe, expect, it } from 'vitest';
import {
  LION_AMOUNT_EACH_DEFAULT,
  LION_AMOUNT_EACH_MAX,
  LION_AMOUNT_EACH_MIN,
  LION_ARM_MAX_MS,
  LION_BLAST_MS,
  LION_BLAST_SE_MS,
  LION_BLAST_VIDEO_MS,
  LION_BURST_STEP_MS,
  LION_FADE_MS,
  LION_FIRST_MS,
  LION_INTRO_MS,
  LION_INTRO_VIDEO_MS,
  LION_KAKUGO_MS,
  LION_MAX_MS,
  LION_SE_POOL_SIZE,
  LION_STEPS_DEFAULT,
  LION_STEPS_MAX,
  LION_STEPS_MIN,
  LION_TOTAL_DISPLAY_MS,
  lionBurstCount,
  lionCutsceneMs,
  lionSettleAtMs,
  planLionCut,
} from '@shared/lion-settle';

/** 実運用で起きうる幅を総当たりする(境界 + 既定 + 桁違い)。 */
const STEPS = [LION_STEPS_MIN, 3, 10, LION_STEPS_DEFAULT, 51, LION_STEPS_MAX];

describe('ライオンの尺(ユーザー確定値 2026-08-26)', () => {
  it('既定(29,999 × 50)の通しは 43,005ms', () => {
    expect(LION_AMOUNT_EACH_DEFAULT).toBe(29_999);
    expect(LION_STEPS_DEFAULT).toBe(50);
    expect(LION_AMOUNT_EACH_DEFAULT * LION_STEPS_DEFAULT).toBe(1_499_950);
    expect(lionCutsceneMs(LION_STEPS_DEFAULT)).toBe(43_005);
  });

  it('段の内訳は 10 + 3 + 3 + 245×49 + 10 + 5', () => {
    expect(LION_INTRO_MS).toBe(10_000);
    expect(LION_FIRST_MS).toBe(3_000);
    expect(LION_KAKUGO_MS).toBe(3_000);
    expect(LION_BURST_STEP_MS).toBe(245);
    expect(LION_BLAST_MS).toBe(10_000);
    expect(LION_TOTAL_DISPLAY_MS).toBe(5_000);
    // 総尺は導出であって直書きではない(発数か間隔を変えたら自動で追随する)。
    expect(lionCutsceneMs(LION_STEPS_DEFAULT)).toBe(
      LION_INTRO_MS +
        LION_FIRST_MS +
        LION_KAKUGO_MS +
        lionBurstCount(LION_STEPS_DEFAULT) * LION_BURST_STEP_MS +
        LION_BLAST_MS +
        LION_TOTAL_DISPLAY_MS
    );
  });

  it('連打は「発数 − 1」発(1枚目は段②で出る)', () => {
    expect(lionBurstCount(LION_STEPS_DEFAULT)).toBe(49);
    for (const n of STEPS) expect(lionBurstCount(n)).toBe(n - 1);
  });

  it('素材の実尺は段の尺と対(片方だけ動かさない)', () => {
    // assets/fx/lion/intro.mp4 / blast.mp4 は 240 フレーム @24fps = 10.000 秒。
    // **導入は段②〜④(18 秒)を最終フレーム静止で持たせる契約**なので、
    // 素材が短いこと自体は正常 — ずらしてよいのは定数と素材を一緒に動かすときだけ。
    expect(LION_INTRO_VIDEO_MS).toBe(LION_INTRO_MS);
    expect(LION_BLAST_VIDEO_MS).toBe(LION_BLAST_MS);
  });

  it('フェードは monitor.css の transition と同じ 400ms', () => {
    // .lion-screen / .fx-clip-opaque の transition:400ms と対。
    expect(LION_FADE_MS).toBe(400);
  });

  it('アーム期限は 120 秒・clamp 上限は最長の清算時刻', () => {
    // バリアで溜まったカットインを全部流し切るのを待つので BOOST_ARM_MAX_MS(60秒)
    // では足りない(UNIVERSE_ARM_MAX_MS と同じ判断)。
    expect(LION_ARM_MAX_MS).toBe(120_000);
    expect(LION_MAX_MS).toBe(lionSettleAtMs(LION_STEPS_MAX));
  });

  it('★連打の間隔 × プール本数 ≥ 爆発音の素材長(尻尾が切られない条件)', () => {
    // renderer/lib/se.ts の POOL_SIZE を上げ下げしたらここも合わせること。
    // 破れると 5 発目が最古の要素を currentTime=0 で巻き戻し、49 連打が痩せる。
    expect(LION_SE_POOL_SIZE).toBe(4);
    expect(LION_BURST_STEP_MS * LION_SE_POOL_SIZE).toBeGreaterThanOrEqual(LION_BLAST_SE_MS);
  });
});

describe('lionSettleAtMs — worker が値を積む時刻', () => {
  it.each(STEPS)('steps=%i: 清算は段⑥の頭(通し − 合計表示)', (n) => {
    expect(lionSettleAtMs(n)).toBe(lionCutsceneMs(n) - LION_TOTAL_DISPLAY_MS);
  });

  it.each(STEPS)('steps=%i: 清算のあとに 5 秒の発表が残る(universe との構造差)', (n) => {
    // universe は「演出の終端 == 清算」。ライオンは数字が動く瞬間を見せるために
    // 清算を前へ出しているので、必ず totalMs より前でなければならない。
    expect(lionSettleAtMs(n)).toBeLessThan(lionCutsceneMs(n));
    expect(lionCutsceneMs(n) - lionSettleAtMs(n)).toBe(LION_TOTAL_DISPLAY_MS);
  });
});

describe('planLionCut — 段組み', () => {
  it('cutMs 0(プレーン / モニター不在 / 動きの抑制)は全段 0', () => {
    const p = planLionCut({ amountEach: 29_999, steps: 50, cutMs: 0 });
    expect(p.totalMs).toBe(0);
    expect(p.total).toBe(0);
    expect(p.burstCount).toBe(0);
  });

  it.each(STEPS)('steps=%i: 段は狭義単調増加で totalMs に収まる', (n) => {
    const p = planLionCut({ amountEach: 29_999, steps: n, cutMs: lionCutsceneMs(n) });
    expect(p.firstAtMs).toBeGreaterThan(0);
    expect(p.kakugoAtMs).toBeGreaterThan(p.firstAtMs);
    expect(p.burstAtMs).toBeGreaterThan(p.kakugoAtMs);
    expect(p.blastAtMs).toBeGreaterThanOrEqual(p.burstAtMs);
    expect(p.totalAtMs).toBeGreaterThan(p.blastAtMs);
    expect(p.fadeAtMs).toBeGreaterThan(p.totalAtMs);
    expect(p.fadeAtMs).toBeLessThan(p.totalMs);
    expect(p.totalMs).toBe(lionCutsceneMs(n));
  });

  it.each(STEPS)('steps=%i: 解放点(totalAtMs)は worker の清算時刻と一致する', (n) => {
    // ここがズレると「7セグが跳ねる瞬間」と「合計の発表」が食い違う。
    const p = planLionCut({ amountEach: 29_999, steps: n, cutMs: lionCutsceneMs(n) });
    expect(p.totalAtMs).toBe(lionSettleAtMs(n));
  });

  it.each(STEPS)('steps=%i: 連打の最終発は全面カットインの開始より前', (n) => {
    const p = planLionCut({ amountEach: 29_999, steps: n, cutMs: lionCutsceneMs(n) });
    const lastShotAt = p.burstAtMs + Math.max(0, p.burstCount - 1) * p.burstStepMs;
    expect(lastShotAt).toBeLessThan(p.blastAtMs + 1);
  });

  it('合計は 1発の額 × 発数', () => {
    const p = planLionCut({ amountEach: 29_999, steps: 50, cutMs: lionCutsceneMs(50) });
    expect(p.total).toBe(1_499_950);
    expect(p.amountEach).toBe(29_999);
    expect(p.steps).toBe(50);
  });

  it('壊れた入力(NaN・範囲外)は clamp して既定へ倒す', () => {
    const p = planLionCut({ amountEach: Number.NaN, steps: 9_999, cutMs: 43_005 });
    expect(p.amountEach).toBe(LION_AMOUNT_EACH_DEFAULT);
    expect(p.steps).toBe(LION_STEPS_MAX);
    const q = planLionCut({ amountEach: -5, steps: 0, cutMs: 43_005 });
    expect(q.amountEach).toBe(LION_AMOUNT_EACH_MIN);
    expect(q.steps).toBe(LION_STEPS_MIN);
    const r = planLionCut({ amountEach: 10 ** 9, steps: 50, cutMs: 43_005 });
    expect(r.amountEach).toBe(LION_AMOUNT_EACH_MAX);
  });

  it('カウントアップは合計表示の中で読み切れる(フェードに食い込まない)', () => {
    const p = planLionCut({ amountEach: 29_999, steps: 50, cutMs: lionCutsceneMs(50) });
    expect(p.countupMs).toBeGreaterThan(0);
    expect(p.totalAtMs + p.countupMs).toBeLessThanOrEqual(p.fadeAtMs);
  });
});
