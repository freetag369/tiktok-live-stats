import { describe, expect, it } from 'vitest';
import { QUIZ_PROMPTS_MAX, QUIZ_SPIN_BEATS, QUIZ_SPIN_MS } from '@shared/challenge';
import { QUIZ_SPIN_STEPS, quizSpinTicks } from '@shared/quiz-spin';

/**
 * お題回転のコマ列の凍結。決定的(Math.random 不使用)・単調増加・最後は必ず
 * 当選 index、が契約 — StrictMode の二重レンダーでも同じ列が出る。
 */
describe('quizSpinTicks', () => {
  it('コマ数は QUIZ_SPIN_STEPS、atMs は狭義単調増加、最後は当選 index', () => {
    const ticks = quizSpinTicks(5, 3);
    expect(ticks.length).toBe(QUIZ_SPIN_STEPS);
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.atMs).toBeGreaterThan(ticks[i - 1]!.atMs);
    }
    expect(ticks[ticks.length - 1]!.show).toBe(3);
    expect(ticks[ticks.length - 1]!.atMs).toBeGreaterThanOrEqual(QUIZ_SPIN_MS);
  });

  it('表示列は当選から逆算した連番の巡回(途中経過から答えが読めない = 全件が流れる)', () => {
    const count = 4;
    const ticks = quizSpinTicks(count, 1, 6000);
    // 隣接コマは常に +1 の巡回。
    for (let i = 1; i < ticks.length; i++) {
      expect(ticks[i]!.show).toBe((ticks[i - 1]!.show + 1) % count);
    }
    // 全 index が最低1回は出る(count <= STEPS の範囲)。
    expect(new Set(ticks.map((t) => t.show)).size).toBe(count);
  });

  it('減速 — 序盤の間隔より終盤の間隔が長い(easeIn 写像でコマ間隔が伸びていく)', () => {
    const ticks = quizSpinTicks(10, 0, 6000);
    const first = ticks[1]!.atMs - ticks[0]!.atMs;
    const last = ticks[ticks.length - 1]!.atMs - ticks[ticks.length - 2]!.atMs;
    expect(last).toBeGreaterThan(first * 3);
  });

  it('お題1件は1コマで即確定。範囲外の winner はクランプ', () => {
    expect(quizSpinTicks(1, 0)).toEqual([{ atMs: QUIZ_SPIN_MS, show: 0 }]);
    const t = quizSpinTicks(3, 99, 1000);
    expect(t[t.length - 1]!.show).toBe(2);
    const t2 = quizSpinTicks(3, -5, 1000);
    expect(t2[t2.length - 1]!.show).toBe(0);
  });

  it('決定的 — 同じ入力は同じ列(StrictMode の二重レンダー安全)', () => {
    expect(quizSpinTicks(7, 2)).toEqual(quizSpinTicks(7, 2));
  });
});

/**
 * 焦らしの振り付け(2026-08-22)。尺の権威は QUIZ_SPIN_BEATS で、コマ列はその導出。
 * 拍表を触ったらここが落ちる = 意図した変更かどうかを一度考える、が狙い。
 */
describe('拍(QUIZ_SPIN_BEATS)の振り付け', () => {
  const B = QUIZ_SPIN_BEATS;
  const ticks = quizSpinTicks(12, 7);
  const gapAfter = (i: number): number => ticks[i + 1]!.atMs - ticks[i]!.atMs;
  const cueAt = (cue: string): number => ticks.findIndex((t) => t.cue === cue);

  it('総尺は拍の総和(openMs は run1Ms の内側なので足さない)', () => {
    expect(QUIZ_SPIN_MS).toBe(B.run1Ms + B.fake1Ms + B.run2Ms + B.nearMs + B.crawlMs + B.tailMs);
  });

  it('合図は fake → near → crawl の順に1つずつだけ出る', () => {
    const cues = ticks.filter((t) => t.cue).map((t) => t.cue);
    expect(cues).toEqual(['fake', 'near', 'crawl']);
    expect(cueAt('fake')).toBeLessThan(cueAt('near'));
    expect(cueAt('near')).toBeLessThan(cueAt('crawl'));
  });

  it('据え拍は拍表どおりの長さで止まる(フェイクストップとニアミスの本体)', () => {
    expect(ticks[cueAt('fake')]!.atMs).toBe(B.run1Ms);
    expect(gapAfter(cueAt('fake'))).toBe(B.fake1Ms);
    expect(ticks[cueAt('near')]!.atMs).toBe(B.run1Ms + B.fake1Ms + B.run2Ms);
    expect(gapAfter(cueAt('near'))).toBe(B.nearMs);
  });

  it('最後の溜めは tailMs ぶん、**ハズレ(当選の1つ手前)を掴んだまま**引っぱる', () => {
    const last = ticks.length - 1;
    expect(gapAfter(last - 1)).toBe(B.tailMs);
    // 当選は決定パンチで初出。回転の最終コマは描かれないので、視聴者が
    // 溜めのあいだ見ているのは1つ手前のお題(ultra の tailMs とは意味が逆)。
    expect(ticks[last]!.show).toBe(7);
    expect(ticks[last - 1]!.show).toBe(6);
  });

  it('走行拍のコマ間隔は runStepMs 近傍 — 下げすぎると OBS でコマ落ちする', () => {
    for (let i = 0; i < 5; i++) {
      expect(gapAfter(i)).toBeGreaterThanOrEqual(B.runStepMs - 2);
      expect(gapAfter(i)).toBeLessThanOrEqual(B.runStepMs + 2);
    }
    // 合図の無い走行拍が「回っている」に見える下限(30fps の2フレーム)。
    expect(B.runStepMs).toBeGreaterThanOrEqual(66);
  });

  it('よろよろ拍は間隔が単調に伸びて溜めへ橋を架ける', () => {
    const c = cueAt('crawl');
    const last = ticks.length - 1;
    for (let i = c; i < last - 2; i++) {
      expect(gapAfter(i + 1)).toBeGreaterThan(gapAfter(i));
    }
    expect(gapAfter(c)).toBe(B.crawlStepMs);
  });

  it('コマ数は盤面の上限より多い — お題は必ず全件が流れる', () => {
    expect(QUIZ_SPIN_STEPS).toBeGreaterThanOrEqual(QUIZ_PROMPTS_MAX);
    const t = quizSpinTicks(QUIZ_PROMPTS_MAX, 0);
    expect(new Set(t.map((x) => x.show)).size).toBe(QUIZ_PROMPTS_MAX);
  });

  it('totalMs を変えても拍の比率は保たれる(引数の意味を殺さない)', () => {
    const half = quizSpinTicks(12, 7, QUIZ_SPIN_MS / 2);
    expect(half.length).toBe(QUIZ_SPIN_STEPS);
    expect(half[half.length - 1]!.atMs).toBe(QUIZ_SPIN_MS / 2);
    expect(half[cueAt('fake')]!.atMs).toBe(B.run1Ms / 2);
  });

  it('cue の無いコマはキー自体を持たない(toEqual の凍結を壊さない)', () => {
    expect(Object.prototype.hasOwnProperty.call(ticks[0], 'cue')).toBe(false);
    expect(quizSpinTicks(1, 0)).toEqual([{ atMs: QUIZ_SPIN_MS, show: 0 }]);
  });
});
