import { describe, expect, it } from 'vitest';
import {
  QUIZ_THRESHOLD_SUFFIX,
  QUIZ_THRESHOLD_SOUND_SLOT,
  initialQuizThresholdArmed,
  quizThresholdNum,
  quizThresholdText,
  stepQuizThresholds,
} from '@shared/challenge';
import type { QuizThresholdRule } from '@shared/dto';

/**
 * お題ルーレットの**数値到達トリガー**の判定(2026-08-22 ユーザー決定)。
 *
 * 仕様:
 *  - カウントがしきい値を**下から上へ跨いだ瞬間**に発動(「達した時」なので `>=`)
 *  - **一度発動したら、しきい値を下回るまで再発動しない**(ヒステリシス)
 *  - 下回ってから再び超えれば何度でも
 *  - 開始時点で既に値以下のしきい値は armed に入れない(開始した瞬間に鳴らない)
 *  - 同じ判定で複数行が跨いだら**上から1行だけ**発動し、残りも再武装待ちへ落とす
 */

function rule(over: Partial<QuizThresholdRule> = {}): QuizThresholdRule {
  return {
    id: 't1',
    label: '',
    enabled: true,
    value: 1000,
    flash: true,
    sound: QUIZ_THRESHOLD_SOUND_SLOT,
    soundVolume: 100,
    ...over,
  };
}

describe('quizThresholdText — 告知の固定文(数字は自動で桁区切り)', () => {
  it('数字を桁区切りにして固定文へ埋める', () => {
    expect(quizThresholdNum(10000)).toBe('10,000');
    expect(quizThresholdText(10000)).toBe(`10,000 ${QUIZ_THRESHOLD_SUFFIX}`);
    expect(quizThresholdText(10000)).toBe('10,000 を超えました!');
  });

  it('小数・負値は丸めてから整形する(設定の壊れた値で NaN を画面に出さない)', () => {
    expect(quizThresholdNum(1234.6)).toBe('1,235');
    expect(quizThresholdNum(-5)).toBe('0');
  });

  it('4桁未満は区切りが入らない', () => {
    expect(quizThresholdText(999)).toBe('999 を超えました!');
  });
});

describe('initialQuizThresholdArmed — 開始時の再武装', () => {
  it('**現在値より上**のしきい値だけ armed に入る(開始した瞬間に鳴らせない)', () => {
    const rules = [rule({ id: 'lo', value: 500 }), rule({ id: 'hi', value: 5000 })];
    const armed = initialQuizThresholdArmed(rules, 1000);
    expect(armed.has('hi')).toBe(true);
    // 1000 は既に 500 を超えている = 「跨いだ瞬間」は過ぎているので武装しない。
    expect(armed.has('lo')).toBe(false);
  });

  it('無効行と範囲外(0以下)の行は入らない', () => {
    const rules = [
      rule({ id: 'off', value: 5000, enabled: false }),
      rule({ id: 'zero', value: 0 }),
      rule({ id: 'ok', value: 5000 }),
    ];
    expect([...initialQuizThresholdArmed(rules, 1000)]).toEqual(['ok']);
  });
});

describe('stepQuizThresholds — 跨ぎの判定とヒステリシス', () => {
  it('下から上へ跨いだ瞬間に1回だけ発動する', () => {
    const rules = [rule({ value: 1000 })];
    let armed = initialQuizThresholdArmed(rules, 900);
    // まだ下 — 発動しない。
    let s = stepQuizThresholds(rules, armed, 999);
    expect(s.fired).toBeNull();
    armed = s.armed;
    // 跨いだ。
    s = stepQuizThresholds(rules, armed, 1000);
    expect(s.fired?.id).toBe('t1');
    armed = s.armed;
    // **上に居続けても二度は鳴らない**(これがヒステリシスの本体)。
    for (const v of [1001, 5000, 1000]) {
      s = stepQuizThresholds(rules, armed, v);
      expect(s.fired).toBeNull();
      armed = s.armed;
    }
  });

  it('下回ってから再び超えれば何度でも鳴る', () => {
    const rules = [rule({ value: 1000 })];
    let armed = initialQuizThresholdArmed(rules, 900);
    let s = stepQuizThresholds(rules, armed, 1200);
    expect(s.fired?.id).toBe('t1');
    armed = s.armed;
    // 下回る = 再武装。
    s = stepQuizThresholds(rules, armed, 999);
    expect(s.fired).toBeNull();
    armed = s.armed;
    expect(armed.has('t1')).toBe(true);
    // もう一度超える。
    s = stepQuizThresholds(rules, armed, 1000);
    expect(s.fired?.id).toBe('t1');
  });

  it('「達した時」なので `>=`(ちょうど同じ数でも鳴る)', () => {
    const rules = [rule({ value: 1000 })];
    const armed = initialQuizThresholdArmed(rules, 999);
    expect(stepQuizThresholds(rules, armed, 1000).fired?.id).toBe('t1');
  });

  it('同時に複数跨いだら**上の1行だけ**発動し、残りも再武装待ちへ落とす', () => {
    const rules = [
      rule({ id: 'a', value: 1100 }),
      rule({ id: 'b', value: 1200 }),
      rule({ id: 'c', value: 1300 }),
    ];
    let armed = initialQuizThresholdArmed(rules, 1000);
    expect(armed.size).toBe(3);
    const s = stepQuizThresholds(rules, armed, 5000);
    expect(s.fired?.id).toBe('a');
    // 飛ばした2行は診断に出せるよう返る。
    expect(s.skipped.map((r) => r.id)).toEqual(['b', 'c']);
    armed = s.armed;
    // **3行とも disarm 済み** — 5000 に居る限り b も c も鳴らない
    // (1つの大口ギフトで発動が3本 FIFO に積まれるのを構造で防ぐ)。
    expect(armed.size).toBe(0);
    expect(stepQuizThresholds(rules, armed, 5000).fired).toBeNull();
  });

  it('無効行は armed の出入りごと無視する(有効化は現在値からやり直す前提)', () => {
    const rules = [rule({ id: 'off', value: 1000, enabled: false })];
    const armed = initialQuizThresholdArmed(rules, 500);
    expect(armed.size).toBe(0);
    const s = stepQuizThresholds(rules, armed, 2000);
    expect(s.fired).toBeNull();
    expect(s.armed.size).toBe(0);
  });

  it('入力の armed 集合は破壊しない(呼び出し側が戻り値で置き換える契約)', () => {
    const rules = [rule({ value: 1000 })];
    const armed = new Set(['t1']);
    const s = stepQuizThresholds(rules, armed, 1000);
    expect(s.fired?.id).toBe('t1');
    expect([...armed]).toEqual(['t1']); // 元の集合は無傷
    expect(s.armed.size).toBe(0);
  });

  it('行ゼロ・値が NaN の行では何も起きない', () => {
    expect(stepQuizThresholds([], new Set(), 9999).fired).toBeNull();
    const rules = [rule({ value: Number.NaN })];
    expect(stepQuizThresholds(rules, new Set(['t1']), 9999).fired).toBeNull();
  });
});
