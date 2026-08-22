import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUIZ,
  QUIZ_BGM_KEEP,
  QUIZ_OUTRO_MAX_SEC,
  QUIZ_PREP_MAX_SEC,
  validateQuiz,
} from '@shared/challenge';
import { quizBgmForPhase, quizOutroBgmFor, type QuizBgmPhase } from '@shared/quiz-bgm';
import type { QuizConfig } from '@shared/dto';

/**
 * お題ルーレットの区間別BGM(2026-08-22)の凍結。
 *
 * 主題は3つ:
 *  1. 区間 → スロットの対応(取り違えると「発表で投票の曲が鳴る」)
 *  2. `'keep'` の既定が**従来挙動(発動から清算まで1曲)と等価**であること
 *  3. 終了後の分岐 — 減算/増加で別の曲・**±0 は無音**(ユーザー決定)
 */

function cfg(over: Partial<QuizConfig> = {}): QuizConfig {
  return { ...structuredClone(DEFAULT_QUIZ), ...over };
}

const PHASES: QuizBgmPhase[] = ['spin', 'reveal', 'prep', 'window', 'vote'];

describe('quizBgmForPhase — 区間とスロットの対応', () => {
  it('各区間が自分のスロットを読む(取り違えていない)', () => {
    const c = cfg({
      bgm: 'bgm-roulette1',
      bgmVolume: 11,
      revealBgm: 'bgm-band1',
      revealBgmVolume: 22,
      prepBgm: 'bgm-band2',
      prepBgmVolume: 33,
      thinkBgm: 'bgm-band3',
      thinkBgmVolume: 44,
      voteBgm: 'bgm-band4',
      voteBgmVolume: 55,
    });
    expect(quizBgmForPhase(c, 'spin')).toEqual({ id: 'bgm-roulette1', volume: 11 });
    expect(quizBgmForPhase(c, 'reveal')).toEqual({ id: 'bgm-band1', volume: 22 });
    expect(quizBgmForPhase(c, 'prep')).toEqual({ id: 'bgm-band2', volume: 33 });
    expect(quizBgmForPhase(c, 'window')).toEqual({ id: 'bgm-band3', volume: 44 });
    expect(quizBgmForPhase(c, 'vote')).toEqual({ id: 'bgm-band4', volume: 55 });
  });

  it("'off' は「無音にする」として通す('keep' と区別される)", () => {
    const c = cfg({ voteBgm: 'off' });
    expect(quizBgmForPhase(c, 'vote')).toEqual({ id: 'off', volume: DEFAULT_QUIZ.voteBgmVolume });
  });

  it("★既定は先頭以外すべて 'keep' = 従来どおり1曲が通しで鳴る", () => {
    const c = cfg();
    // 先頭区間だけ実曲(発動の瞬間に BGM が変わるのが「お題モードの予告」)。
    expect(quizBgmForPhase(c, 'spin')).toEqual({ id: DEFAULT_QUIZ.bgm, volume: DEFAULT_QUIZ.bgmVolume });
    for (const p of PHASES.filter((x) => x !== 'spin')) {
      expect(quizBgmForPhase(c, p), `${p} の既定が keep でない`).toBe('keep');
    }
  });

  it("custom: の取込み音もそのまま通る(カタログ id と同じ扱い)", () => {
    const c = cfg({ thinkBgm: 'custom:my-song.mp3', thinkBgmVolume: 80 });
    expect(quizBgmForPhase(c, 'window')).toEqual({ id: 'custom:my-song.mp3', volume: 80 });
  });
});

describe('quizOutroBgmFor — 終了後(減算 / 増加 / ±0)', () => {
  const c = cfg({
    outroSec: 20,
    outroDownBgm: 'bgm-band1',
    outroDownBgmVolume: 60,
    outroUpBgm: 'bgm-band2',
    outroUpBgmVolume: 40,
  });

  it('減算(よかった多数)は down 側・増加(だめ多数)は up 側', () => {
    expect(quizOutroBgmFor(c, -5000)).toEqual({
      pick: { id: 'bgm-band1', volume: 60, holdMs: 20_000 },
      holdMs: 20_000,
    });
    expect(quizOutroBgmFor(c, 5000)).toEqual({
      pick: { id: 'bgm-band2', volume: 40, holdMs: 20_000 },
      holdMs: 20_000,
    });
  });

  it('★±0(引き分け・無投票)は無音 — どちらの曲も鳴らさない', () => {
    expect(quizOutroBgmFor(c, 0)).toBeNull();
  });

  it('outroSec 0 は機能ごと無効(出荷 v0.13.0 と同じ「投票締切で無音」)', () => {
    expect(quizOutroBgmFor(cfg({ ...c, outroSec: 0 }), -5000)).toBeNull();
    expect(quizOutroBgmFor(cfg({ ...c, outroSec: 0 }), 5000)).toBeNull();
  });

  it("'keep' は投票中の曲の延長(尺だけ返す)", () => {
    const k = cfg({ outroSec: 15, outroDownBgm: QUIZ_BGM_KEEP });
    expect(quizOutroBgmFor(k, -1)).toEqual({ pick: 'keep', holdMs: 15_000 });
  });

  it("既定は 'off' — 設定していないユーザーに勝手に 20 秒鳴らさない", () => {
    expect(DEFAULT_QUIZ.outroDownBgm).toBe('off');
    expect(DEFAULT_QUIZ.outroUpBgm).toBe('off');
    const d = quizOutroBgmFor(cfg(), -5000);
    expect(d).not.toBeNull();
    expect(d!.pick).toEqual({ id: 'off', volume: DEFAULT_QUIZ.outroDownBgmVolume, holdMs: 20_000 });
  });
});

describe('validateQuiz — 区間BGM の検証', () => {
  it("区間スロットは 'keep' を受け付ける(既定でもある)", () => {
    const v = validateQuiz({ ...DEFAULT_QUIZ, revealBgm: QUIZ_BGM_KEEP, voteBgm: QUIZ_BGM_KEEP });
    expect(v.revealBgm).toBe(QUIZ_BGM_KEEP);
    expect(v.voteBgm).toBe(QUIZ_BGM_KEEP);
  });

  it("★先頭区間の bgm だけは 'keep' を拒否して既定へ倒す(継続元が無い)", () => {
    const v = validateQuiz({ ...DEFAULT_QUIZ, bgm: QUIZ_BGM_KEEP });
    expect(v.bgm).toBe(DEFAULT_QUIZ.bgm);
  });

  it('未知の id は既定へ戻す(カタログ・custom: 以外は通さない)', () => {
    const v = validateQuiz({ ...DEFAULT_QUIZ, prepBgm: 'bgm-does-not-exist', thinkBgm: 42 });
    expect(v.prepBgm).toBe(DEFAULT_QUIZ.prepBgm);
    expect(v.thinkBgm).toBe(DEFAULT_QUIZ.thinkBgm);
  });

  it('音量と秒数は clamp される', () => {
    const v = validateQuiz({
      ...DEFAULT_QUIZ,
      revealBgmVolume: 999,
      voteBgmVolume: -5,
      prepSec: 9999,
      outroSec: -1,
    });
    expect(v.revealBgmVolume).toBe(100);
    expect(v.voteBgmVolume).toBe(0);
    expect(v.prepSec).toBe(QUIZ_PREP_MAX_SEC);
    expect(v.outroSec).toBe(0);
    // 上限側も対で押さえる(片側だけだと clamp の向き違いを見逃す)。
    expect(validateQuiz({ ...DEFAULT_QUIZ, outroSec: 9999 }).outroSec).toBe(QUIZ_OUTRO_MAX_SEC);
  });

  it('★キー欠損は全部既定へ倒れる — SETTINGS_VERSION を上げない根拠', () => {
    // 出荷 v0.13.0 の settings.json(区間キーがそもそも無い)を模す。
    const legacy: Record<string, unknown> = { ...DEFAULT_QUIZ };
    for (const k of [
      'revealBgm',
      'revealBgmVolume',
      'prepSec',
      'prepBgm',
      'prepBgmVolume',
      'thinkBgm',
      'thinkBgmVolume',
      'voteBgm',
      'voteBgmVolume',
      'outroSec',
      'outroDownBgm',
      'outroDownBgmVolume',
      'outroUpBgm',
      'outroUpBgmVolume',
    ]) {
      delete legacy[k];
    }
    const v = validateQuiz(legacy);
    expect(v).toEqual(DEFAULT_QUIZ);
    // 復元後の挙動が「1曲通し + 締切で無音」= 旧版と同じであることまで確認する。
    for (const p of PHASES.filter((x) => x !== 'spin')) {
      expect(quizBgmForPhase(v, p)).toBe('keep');
    }
    expect(quizOutroBgmFor(v, -5000)!.pick).toEqual({
      id: 'off',
      volume: DEFAULT_QUIZ.outroDownBgmVolume,
      holdMs: DEFAULT_QUIZ.outroSec * 1000,
    });
  });

  it('validate を2度通しても値が変わらない(不動点)', () => {
    const once = validateQuiz(DEFAULT_QUIZ);
    expect(validateQuiz(once)).toEqual(once);
  });
});
