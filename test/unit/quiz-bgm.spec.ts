import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_ROULETTE_BGM_IDS,
  DEFAULT_CHALLENGE,
  DEFAULT_QUIZ,
  QUIZ_BGM_CHASE,
  QUIZ_BGM_KEEP,
  QUIZ_BGM_THINK,
  QUIZ_OUTRO_MAX_SEC,
  QUIZ_PREP_MAX_SEC,
  migrateChallengeConfig,
  migrateChallengeQuizBgm,
  migrateChallengeQuizThinkBgm,
  validateQuiz,
} from '@shared/challenge';
import { quizBgmForPhase, quizOutroBgmFor, type QuizBgmPhase } from '@shared/quiz-bgm';
import { SETTINGS_VERSION, type ChallengeConfig, type QuizConfig } from '@shared/dto';

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

  it('★既定は「①追いかけっこ → ②③ keep → ④無音 → ⑤考え中」(2026-08-22 ユーザー指定)', () => {
    const c = cfg();
    // 先頭区間は実曲(発動の瞬間に BGM が変わるのが「お題モードの予告」)。
    // 導入の全面カットもこの区間に含まれる('spin' が catch-all)。
    expect(quizBgmForPhase(c, 'spin')).toEqual({ id: QUIZ_BGM_CHASE, volume: 70 });
    // お題発表・準備までは①の曲が続く。
    for (const p of ['reveal', 'prep'] as QuizBgmPhase[]) {
      expect(quizBgmForPhase(c, p), `${p} の既定が keep でない`).toBe('keep');
    }
    // ★お題に挑戦している間は**無音**。曲が止まること自体が「回転が終わって
    // 挑戦の時間になった」の合図(2026-08-22 ユーザー決定)。
    expect(quizBgmForPhase(c, 'window')).toEqual({ id: 'off', volume: 70 });
    // コメント受付で専用曲へ切り替わる。
    expect(quizBgmForPhase(c, 'vote')).toEqual({ id: QUIZ_BGM_THINK, volume: 70 });
  });

  it('★既定の2曲はカタログに登録されている(未知 id だと validate が既定へ倒す)', () => {
    // 登録漏れは「設定画面の select が空表示・再生も無音」で表に出る。
    expect(CHALLENGE_ROULETTE_BGM_IDS).toContain(QUIZ_BGM_CHASE);
    expect(CHALLENGE_ROULETTE_BGM_IDS).toContain(QUIZ_BGM_THINK);
    const v = validateQuiz(DEFAULT_QUIZ);
    expect(v.bgm).toBe(QUIZ_BGM_CHASE);
    expect(v.voteBgm).toBe(QUIZ_BGM_THINK);
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
    // 復元後の挙動が現行の既定(①の曲が準備まで続き、④で止まり⑤で切替)に
    // なることまで確認する。曲の割り当てそのものは migrateChallengeQuizBgm(v14)/
    // migrateChallengeQuizThinkBgm(v15)が配るので、ここで見るのは
    // 「キーが無い設定でも既定の形に戻る」ことだけ。
    for (const p of ['reveal', 'prep'] as QuizBgmPhase[]) {
      expect(quizBgmForPhase(v, p)).toBe('keep');
    }
    expect(quizBgmForPhase(v, 'window')).toEqual({ id: 'off', volume: 70 });
    expect(quizBgmForPhase(v, 'vote')).toEqual({ id: QUIZ_BGM_THINK, volume: 70 });
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

/**
 * 設定移行 — 区間BGM の実素材化(SETTINGS_VERSION 14)。
 *
 * この段だけ「旧既定ちょうどのとき」条件を持たない(値を見ずに曲を上書きする)。
 * 実運用の settings.json が bgm:'off' / bgmVolume:0 に倒してあり、旧既定一致の
 * 条件では**指示された既定が一生届かない**ため(2026-08-22 ユーザー決定)。
 * 代わりに触る範囲を4キーへ絞ってあるので、そこを凍結する。
 */
describe('設定移行 — 区間BGMの実素材化(SETTINGS_VERSION 14)', () => {
  function quizCfg(over: Partial<QuizConfig> = {}): ChallengeConfig {
    const c = structuredClone(DEFAULT_CHALLENGE);
    return { ...c, quiz: { ...c.quiz, ...over } };
  }

  it('★無音に倒してある実運用の設定へ届く(off / 音量0 でも配る)', () => {
    const base = quizCfg({ bgm: 'off', bgmVolume: 0, voteBgm: QUIZ_BGM_KEEP, voteBgmVolume: 70 });
    const out = migrateChallengeQuizBgm(base, 13);
    expect(out.quiz.bgm).toBe(QUIZ_BGM_CHASE);
    expect(out.quiz.bgmVolume).toBe(70); // 0 は「鳴らない」ので既定へ戻す
    expect(out.quiz.voteBgm).toBe(QUIZ_BGM_THINK);
    expect(out.quiz.voteBgmVolume).toBe(70);
  });

  it('自分で絞っている音量は残す(0 のときだけ既定へ戻す)', () => {
    const out = migrateChallengeQuizBgm(quizCfg({ bgmVolume: 40, voteBgmVolume: 25 }), 13);
    expect(out.quiz.bgmVolume).toBe(40);
    expect(out.quiz.voteBgmVolume).toBe(25);
  });

  it('世代0(settingsVersion 欠損)からでも届く', () => {
    expect(migrateChallengeQuizBgm(quizCfg({ bgm: 'off' }), 0).quiz.bgm).toBe(QUIZ_BGM_CHASE);
  });

  it('fromVersion 14 以降には配らない(選び直した曲を二度と戻さない)', () => {
    const base = quizCfg({ bgm: 'off', bgmVolume: 0 });
    expect(migrateChallengeQuizBgm(base, 14)).toBe(base);
    expect(migrateChallengeQuizBgm(base, SETTINGS_VERSION)).toBe(base);
  });

  it('★触るのは4キーだけ(②③区間・挑戦中・終了後・他機能には手を出さない)', () => {
    const base = quizCfg({ bgm: 'off', bgmVolume: 0 });
    const out = migrateChallengeQuizBgm(base, 13);
    const touched = { bgm: 0, bgmVolume: 0, voteBgm: 0, voteBgmVolume: 0 };
    expect({ ...out.quiz, ...touched }).toEqual({ ...base.quiz, ...touched });
    expect(out.quiz.revealBgm).toBe(QUIZ_BGM_KEEP);
    expect(out.quiz.prepBgm).toBe(QUIZ_BGM_KEEP);
    // 挑戦中は v15 の既定(off)のまま — この段は触らない。
    expect(out.quiz.thinkBgm).toBe(base.quiz.thinkBgm);
    expect(out.quiz.outroDownBgm).toBe('off');
    expect(out.quiz.outroUpBgm).toBe('off');
    // quiz 以外のブロック(ルーレット・ブースト等)もそのまま。
    expect({ ...out, quiz: base.quiz }).toEqual(base);
  });

  it('冪等 — 2回通しても同じ値', () => {
    const once = migrateChallengeQuizBgm(quizCfg({ bgm: 'off', bgmVolume: 0 }), 13);
    expect(migrateChallengeQuizBgm(once, 13)).toEqual(once);
  });

  it('移行の出力が validateQuiz の不動点(migrate の出力は再検証されない)', () => {
    const out = migrateChallengeQuizBgm(quizCfg({ bgm: 'off', bgmVolume: 0 }), 13);
    expect(validateQuiz(out.quiz)).toEqual(out.quiz);
  });

  it('migrateChallengeConfig のチェーンに組み込まれている', () => {
    // 段の付け忘れは「テストは緑なのに実機に届かない」で表に出る。
    const out = migrateChallengeConfig(quizCfg({ bgm: 'off', bgmVolume: 0 }), 13);
    expect(out.quiz.bgm).toBe(QUIZ_BGM_CHASE);
    expect(out.quiz.voteBgm).toBe(QUIZ_BGM_THINK);
  });
});

/**
 * 設定移行 — 挑戦中BGMの既定オフ(SETTINGS_VERSION 15)。
 *
 * v14 で区間①に実曲を入れた結果、②③④の 'keep' 連鎖で**導入の全面カットから
 * 挑戦中までBGMが鳴りっぱなし**になり、「回転が終わって挑戦の時間になった」区切りが
 * 音で分からなくなった(実機フィードバック)。v14 と違い**'keep' ちょうどのときだけ**
 * 触るので、自分で曲を選んだ人の設定は残る。
 */
describe('設定移行 — 挑戦中BGMの既定オフ(SETTINGS_VERSION 15)', () => {
  function quizCfg(over: Partial<QuizConfig> = {}): ChallengeConfig {
    const c = structuredClone(DEFAULT_CHALLENGE);
    return { ...c, quiz: { ...c.quiz, ...over } };
  }

  it("★v14 が配った 'keep' を 'off' へ寄せ替える", () => {
    const out = migrateChallengeQuizThinkBgm(quizCfg({ thinkBgm: QUIZ_BGM_KEEP }), 14);
    expect(out.quiz.thinkBgm).toBe('off');
  });

  it('★自分で曲を選んでいる人には配らない(keep ちょうどのときだけ)', () => {
    const picked = quizCfg({ thinkBgm: QUIZ_BGM_CHASE });
    expect(migrateChallengeQuizThinkBgm(picked, 14)).toBe(picked);
    const off = quizCfg({ thinkBgm: 'off' });
    expect(migrateChallengeQuizThinkBgm(off, 14)).toBe(off);
  });

  it('fromVersion 15 以降には配らない(選び直した曲を二度と消さない)', () => {
    const base = quizCfg({ thinkBgm: QUIZ_BGM_KEEP });
    expect(migrateChallengeQuizThinkBgm(base, 15)).toBe(base);
    expect(migrateChallengeQuizThinkBgm(base, SETTINGS_VERSION)).toBe(base);
  });

  it('触るのは thinkBgm だけ(音量・他の区間・他機能はそのまま)', () => {
    const base = quizCfg({ thinkBgm: QUIZ_BGM_KEEP });
    const out = migrateChallengeQuizThinkBgm(base, 14);
    expect({ ...out.quiz, thinkBgm: '' }).toEqual({ ...base.quiz, thinkBgm: '' });
    expect(out.quiz.thinkBgmVolume).toBe(base.quiz.thinkBgmVolume);
    expect({ ...out, quiz: base.quiz }).toEqual(base);
  });

  it('移行の出力が validateQuiz の不動点(migrate の出力は再検証されない)', () => {
    const out = migrateChallengeQuizThinkBgm(quizCfg({ thinkBgm: QUIZ_BGM_KEEP }), 14);
    expect(validateQuiz(out.quiz)).toEqual(out.quiz);
  });

  it('migrateChallengeConfig のチェーンに組み込まれている', () => {
    // 段の付け忘れは「テストは緑なのに実機に届かない」で表に出る。
    const out = migrateChallengeConfig(quizCfg({ thinkBgm: QUIZ_BGM_KEEP }), 14);
    expect(out.quiz.thinkBgm).toBe('off');
    // v14 の段(曲の割り当て)も一緒に通っている。
    expect(out.quiz.bgm).toBe(QUIZ_BGM_CHASE);
  });
});
