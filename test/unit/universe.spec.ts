/**
 * 一撃クリア(TIKTOK UNIVERSE)の尺と 30 分割の算術の凍結。
 *
 * ここが守るのは2つ:
 *  1. **ユーザー確定値**(導入8秒 + 減算9秒 + 締め8秒 = 25秒 / 30段 / 300ms間隔)が
 *     素材の差し替えやリファクタで静かに動かないこと。
 *  2. **段の合計が必ず起点 V に一致し、最終段が必ず 0 になる**こと。ここが崩れると
 *     「減算連打が終わったのに数字が残っている / 途中で 0 を割る」になる。
 *
 * 純関数なので renderer を import せずに検査できる(vitest の node 環境には
 * @renderer エイリアスも mp4/mp3 のローダも無い — この分離が全 shared 純関数の理由)。
 */
import { describe, expect, it } from 'vitest';
import {
  UNIVERSE_ARM_MAX_MS,
  UNIVERSE_DRAIN_MS,
  UNIVERSE_DRAIN_STEPS,
  UNIVERSE_FADE_MS,
  UNIVERSE_INTRO_MS,
  UNIVERSE_MAX_MS,
  UNIVERSE_OUTRO_MS,
  UNIVERSE_STEP_MS,
  UNIVERSE_TOTAL_MS,
  UNIVERSE_TOTAL_REVEAL_MS,
  planUniverseClear,
  planUniverseDrain,
} from '@shared/universe';

/** 実運用で起きうる幅を総当たりする(境界 + 桁違い)。 */
const VALUES = [1, 2, 7, 29, 30, 31, 59, 100, 999, 1000, 44_999, 1_000_000];

describe('一撃クリアの尺(ユーザー確定値 2026-08-26)', () => {
  it('25 秒の内訳は 8 + 9 + 8', () => {
    expect(UNIVERSE_INTRO_MS).toBe(8_000);
    expect(UNIVERSE_OUTRO_MS).toBe(8_000);
    expect(UNIVERSE_TOTAL_MS).toBe(25_000);
    // 総尺は導出であって直書きではない(段数か間隔を変えたら自動で追随する)。
    expect(UNIVERSE_TOTAL_MS).toBe(UNIVERSE_INTRO_MS + UNIVERSE_DRAIN_MS + UNIVERSE_OUTRO_MS);
  });

  it('減算フェーズは 30 段 × 300ms = 9 秒', () => {
    expect(UNIVERSE_DRAIN_STEPS).toBe(30);
    expect(UNIVERSE_STEP_MS).toBe(300);
    expect(UNIVERSE_DRAIN_MS).toBe(9_000);
    expect(UNIVERSE_DRAIN_MS).toBe(UNIVERSE_DRAIN_STEPS * UNIVERSE_STEP_MS);
  });

  it('フェードは monitor.css の transition と同じ 400ms', () => {
    // .universe-screen / .fx-clip-opaque の transition:400ms と対。ずらすと
    // 幕引きが JS タイマーと食い違う。
    expect(UNIVERSE_FADE_MS).toBe(400);
  });

  it('アーム期限は 120 秒・clamp 上限は総尺', () => {
    // バリアで溜まったカットインを全部流し切るのを待つので BOOST_ARM_MAX_MS(60秒)
    // では足りない(QUIZ_ARM_MAX_MS と同じ判断)。
    expect(UNIVERSE_ARM_MAX_MS).toBe(120_000);
    expect(UNIVERSE_MAX_MS).toBe(UNIVERSE_TOTAL_MS);
  });
});

describe('planUniverseDrain — 30 分割の算術', () => {
  it.each(VALUES)('V=%i: 段数は常に 30(V に依らず尺を縮めない)', (v) => {
    expect(planUniverseDrain(v)).toHaveLength(UNIVERSE_DRAIN_STEPS);
  });

  it.each(VALUES)('V=%i: 合計が厳密に V(望遠鏡和)', (v) => {
    const sum = planUniverseDrain(v).reduce((a, s) => a + s.amount, 0);
    expect(sum).toBe(v);
  });

  it.each(VALUES)('V=%i: 最終段の残量は必ず 0', (v) => {
    const steps = planUniverseDrain(v);
    expect(steps[steps.length - 1]!.remain).toBe(0);
  });

  it.each(VALUES)('V=%i: 残量は単調非増加・各段は 0 以上', (v) => {
    const steps = planUniverseDrain(v);
    let prev = v;
    for (const s of steps) {
      expect(s.amount).toBeGreaterThanOrEqual(0);
      expect(s.remain).toBeLessThanOrEqual(prev);
      prev = s.remain;
    }
  });

  it.each(VALUES)('V=%i: 段差は高々 1(floor(V/30) ≤ amount ≤ ceil(V/30))', (v) => {
    // これが「見た目が均一」の根拠。ceil を 29 回 + 残り、のような分配だと
    // 最終段だけが極端になる(この不等式で落ちる)。
    const lo = Math.floor(v / UNIVERSE_DRAIN_STEPS);
    const hi = Math.ceil(v / UNIVERSE_DRAIN_STEPS);
    for (const s of planUniverseDrain(v)) {
      expect(s.amount).toBeGreaterThanOrEqual(lo);
      expect(s.amount).toBeLessThanOrEqual(hi);
    }
  });

  it('V < 30 は 0 の段が混ざり、1 の段は等間隔に散る(先頭にも末尾にも固まらない)', () => {
    const steps = planUniverseDrain(7);
    expect(steps.filter((s) => s.amount === 1)).toHaveLength(7);
    expect(steps.filter((s) => s.amount === 0)).toHaveLength(23);
    // 最初の 7 段に固まっていない = Bresenham 的に散っている。
    expect(steps.slice(0, 7).filter((s) => s.amount === 1).length).toBeLessThan(7);
  });

  it('V = 0 は全段 0(degenerate)', () => {
    const steps = planUniverseDrain(0);
    expect(steps.every((s) => s.amount === 0 && s.remain === 0)).toBe(true);
  });

  it('決定的 — 同じ入力で必ず同じ段(Math.random 不使用)', () => {
    expect(planUniverseDrain(44_999)).toEqual(planUniverseDrain(44_999));
  });

  it('段のオフセットは i × 300ms', () => {
    for (const s of planUniverseDrain(100)) expect(s.atMs).toBe(s.index * UNIVERSE_STEP_MS);
  });
});

describe('planUniverseClear — 段組', () => {
  const plan = planUniverseClear({ from: 1000, introMs: UNIVERSE_INTRO_MS, outroMs: UNIVERSE_OUTRO_MS });

  it('素材ありの通しは 25 秒ちょうど', () => {
    expect(plan.totalMs).toBe(UNIVERSE_TOTAL_MS);
    expect(plan.drainAtMs).toBe(UNIVERSE_INTRO_MS);
    expect(plan.outroAtMs).toBe(UNIVERSE_INTRO_MS + UNIVERSE_DRAIN_MS);
    expect(plan.drainMs).toBe(UNIVERSE_DRAIN_MS);
  });

  it('フェードは各段の終端から 400ms 手前', () => {
    expect(plan.introFadeAtMs).toBe(UNIVERSE_INTRO_MS - UNIVERSE_FADE_MS);
    expect(plan.fadeAtMs).toBe(UNIVERSE_TOTAL_MS - UNIVERSE_FADE_MS);
    // 予算の不等式: 幕引きは必ず終端より前(逆転すると .out が付かないまま消える)。
    expect(plan.fadeAtMs).toBeLessThan(plan.totalMs);
    expect(plan.introFadeAtMs).toBeLessThan(plan.drainAtMs);
  });

  it('段の絶対オフセットは導入ぶんだけ後ろへ寄る', () => {
    expect(plan.steps[0]!.atMs).toBe(UNIVERSE_INTRO_MS);
    expect(plan.steps[UNIVERSE_DRAIN_STEPS - 1]!.atMs).toBe(
      UNIVERSE_INTRO_MS + (UNIVERSE_DRAIN_STEPS - 1) * UNIVERSE_STEP_MS
    );
    // 最終段は締めの開始より必ず前(= 減算が締めの動画に食われない)。
    expect(plan.steps[UNIVERSE_DRAIN_STEPS - 1]!.atMs).toBeLessThan(plan.outroAtMs);
  });

  it('素材が無い(尺 0)と段が前へ詰まり総尺も縮む', () => {
    const bare = planUniverseClear({ from: 1000, introMs: 0, outroMs: 0 });
    expect(bare.totalMs).toBe(UNIVERSE_DRAIN_MS);
    expect(bare.drainAtMs).toBe(0);
    expect(bare.introFadeAtMs).toBe(0);
    expect(bare.steps[0]!.atMs).toBe(0);
  });

  it('減算合計の発表は締めの開始と同時に出て、演出の終端を超えない', () => {
    // 30 段を削り切った瞬間の「ドン」。締めのカットインの頭に重なる。
    expect(plan.totalAtMs).toBe(plan.outroAtMs);
    // カウントアップは桁数で伸びる(boost / revolution と共有のスケール)。
    expect(plan.totalCountupMs).toBeGreaterThan(0);
    // 発表のフェードは必ず演出の終端より前(はみ出すと幕と一緒に消える)。
    expect(plan.totalFadeAtMs).toBeGreaterThanOrEqual(plan.totalAtMs);
    expect(plan.totalFadeAtMs).toBeLessThan(plan.totalMs);
    // カウントアップが終わってからフェードが始まる(数字が確定する前に消えない)。
    expect(plan.totalFadeAtMs).toBeGreaterThan(plan.totalAtMs + plan.totalCountupMs);
    // 発表の尺は締めのカットインより短い(explosion の余韻は数字なしで見せ切る)。
    expect(UNIVERSE_TOTAL_REVEAL_MS).toBeLessThan(UNIVERSE_OUTRO_MS);
  });

  it('素材なし(尺 0)でも発表が演出の終端を超えない', () => {
    const bare = planUniverseClear({ from: 1000, introMs: 0, outroMs: 0 });
    expect(bare.totalFadeAtMs).toBeLessThanOrEqual(bare.totalMs);
  });

  it('from <= 0 は演出ごとスキップ(totalMs 0 = 呼び出し側はバナー1枚へ縮退)', () => {
    expect(planUniverseClear({ from: 0, introMs: 8_000, outroMs: 8_000 }).totalMs).toBe(0);
    expect(planUniverseClear({ from: -5, introMs: 8_000, outroMs: 8_000 }).steps).toHaveLength(0);
  });

  it('小数の起点は切り捨てて整数で扱う(7セグは整数しか出せない)', () => {
    const p = planUniverseClear({ from: 100.9, introMs: 0, outroMs: 0 });
    expect(p.from).toBe(100);
    expect(p.steps.reduce((a, s) => a + s.amount, 0)).toBe(100);
  });
});
