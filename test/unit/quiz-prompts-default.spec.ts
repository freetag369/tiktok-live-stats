import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_QUIZ,
  QUIZ_PROMPTS_MAX,
  QUIZ_PROMPTS_V12,
  QUIZ_PROMPT_LEN_MAX,
  QUIZ_PROMPT_SHIPPED_V11,
  migrateChallengeConfig,
  migrateChallengeQuizPrompts,
  validateQuiz,
} from '@shared/challenge';
import { SETTINGS_VERSION } from '@shared/dto';
import type { ChallengeConfig } from '@shared/dto';

/**
 * お題ルーレットの出荷既定お題(QUIZ_PROMPTS_V12)と、それを既存ユーザーへ配る移行(v12)。
 *
 * 壊れ方は roulette-dj-glasses.spec.ts と同じ2つで、どちらも静かに効く:
 *
 *   (a) **既定を直しても既存ユーザーに届かない** — quiz.prompts キーは v0.13.0 以降の
 *       保存済み settings.json が必ず持っているので、validateQuiz の欠損フォールバック
 *       (sanitizeStringList の fb)を通らない。寄せ替え移行(この段)が唯一の経路。
 *   (b) **移行が配るリストが validate の不動点でない** — loadSettings / loadChallengeDefault は
 *       validate → migrate の順で、migrate の出力は再検証されない。前後に空白が付いた
 *       お題や 60 文字超のお題を混ぜると、次の保存で sanitizeStringList が黙って
 *       trim / slice して形が変わり、boot-settings の冪等検査が落ちる。
 *
 * 加えてこの機能特有の落とし穴が1つ: **prompts: [] は「消した人の意思」**であって
 * 未設定ではない(sanitizeStringList は明示的な空配列を空のまま通す)。移行がここへ
 * 配ってしまうと、お題を使わない運用にしている配信者のリストが勝手に生える。
 */

function quizCfg(prompts: string[]): ChallengeConfig {
  const c = structuredClone(DEFAULT_CHALLENGE);
  return { ...c, quiz: { ...c.quiz, prompts } };
}

describe('出荷既定のお題リスト(QUIZ_PROMPTS_V12)', () => {
  it('ユーザー提供の28件が、渡された順序のまま入っている', () => {
    expect(QUIZ_PROMPTS_V12).toHaveLength(28);
    expect(QUIZ_PROMPTS_V12[0]).toBe('底辺YouTubeのキャッチコピー挨拶');
    expect(QUIZ_PROMPTS_V12[2]).toBe('誰もやったことないモノマネ');
    expect(QUIZ_PROMPTS_V12[27]).toBe('宇宙一くだらない発明をプレゼンする');
  });

  it('重複が無い(回転盤に同じお題が二度出ない)', () => {
    expect(new Set(QUIZ_PROMPTS_V12).size).toBe(QUIZ_PROMPTS_V12.length);
  });

  it('sanitizeStringList の不動点 — 件数・長さ・前後空白のどれでも削られない', () => {
    // 壊れ方 (b)。ここが崩れると boot-settings.spec の冪等検査まで連鎖して落ちる。
    expect(QUIZ_PROMPTS_V12.length).toBeLessThanOrEqual(QUIZ_PROMPTS_MAX);
    for (const p of QUIZ_PROMPTS_V12) {
      expect(p).toBe(p.trim());
      expect(p).not.toBe('');
      expect(p.length).toBeLessThanOrEqual(QUIZ_PROMPT_LEN_MAX);
    }
  });

  it('DEFAULT_QUIZ.prompts が同じ中身で、しかも別の配列(共有参照でない)', () => {
    expect(DEFAULT_QUIZ.prompts).toEqual([...QUIZ_PROMPTS_V12]);
    // structuredClone を挟まない呼び元が既定配列を破壊しないこと。
    expect(DEFAULT_QUIZ.prompts).not.toBe(QUIZ_PROMPTS_V12);
  });

  it('validateQuiz の不動点 — お題が1件も落ちない', () => {
    expect(validateQuiz(DEFAULT_QUIZ)).toEqual(DEFAULT_QUIZ);
    expect(validateQuiz(validateQuiz(DEFAULT_QUIZ))).toEqual(DEFAULT_QUIZ);
  });

  it('旧既定の「例」1件は既定リストから外れている(カタカナ版が後継)', () => {
    expect(QUIZ_PROMPT_SHIPPED_V11).toBe('誰もやったことないものまね');
    expect(QUIZ_PROMPTS_V12).not.toContain(QUIZ_PROMPT_SHIPPED_V11);
  });
});

describe('migrateChallengeQuizPrompts(v12)', () => {
  it('出荷既定の「例」1件のままの設定を28件へ寄せ替える', () => {
    // 壊れ方 (a)。これが無いと既存ユーザーのお題は永久に1件のまま。
    const out = migrateChallengeQuizPrompts(quizCfg([QUIZ_PROMPT_SHIPPED_V11]), 11);
    expect(out.quiz.prompts).toEqual([...QUIZ_PROMPTS_V12]);
  });

  it('世代0(settingsVersion 欠損)からでも届く', () => {
    const out = migrateChallengeQuizPrompts(quizCfg([QUIZ_PROMPT_SHIPPED_V11]), 0);
    expect(out.quiz.prompts).toHaveLength(28);
  });

  it('fromVersion 12 以降には配らない(二重適用しない)', () => {
    const base = quizCfg([QUIZ_PROMPT_SHIPPED_V11]);
    expect(migrateChallengeQuizPrompts(base, 12)).toBe(base);
    expect(migrateChallengeQuizPrompts(base, SETTINGS_VERSION)).toBe(base);
  });

  it('全部消した人(prompts: [])には配らない', () => {
    // 空配列は「未設定」ではなく「お題を使わない」という意思表示。
    const base = quizCfg([]);
    expect(migrateChallengeQuizPrompts(base, 11)).toBe(base);
  });

  it('自分でお題を書き換えた人・増やした人には触らない', () => {
    const one = quizCfg(['変顔をする']);
    expect(migrateChallengeQuizPrompts(one, 11)).toBe(one);

    const many = quizCfg([QUIZ_PROMPT_SHIPPED_V11, '変顔をする']);
    expect(migrateChallengeQuizPrompts(many, 11)).toBe(many);
  });

  it('quiz の他の設定(BGM・尺・トリガー)には一切触らない', () => {
    const base = quizCfg([QUIZ_PROMPT_SHIPPED_V11]);
    const out = migrateChallengeQuizPrompts(base, 11);
    expect({ ...out.quiz, prompts: [] }).toEqual({ ...base.quiz, prompts: [] });
    // quiz 以外のブロック(ルーレット・ブースト等)もそのまま。
    expect({ ...out, quiz: base.quiz }).toEqual(base);
  });

  it('冪等 — 2回通しても28件のまま増えない', () => {
    const once = migrateChallengeQuizPrompts(quizCfg([QUIZ_PROMPT_SHIPPED_V11]), 11);
    const twice = migrateChallengeQuizPrompts(once, 11);
    expect(twice.quiz.prompts).toEqual(once.quiz.prompts);
  });

  it('移行の出力が validateQuiz の不動点(migrate の出力は再検証されない)', () => {
    // 壊れ方 (b) を移行の出口側でも押さえる。
    const out = migrateChallengeQuizPrompts(quizCfg([QUIZ_PROMPT_SHIPPED_V11]), 11);
    expect(validateQuiz(out.quiz)).toEqual(out.quiz);
  });

  it('migrateChallengeConfig のチェーンに組み込まれている', () => {
    // 段の付け忘れは「テストは緑なのに実機に届かない」で表に出る。
    const out = migrateChallengeConfig(quizCfg([QUIZ_PROMPT_SHIPPED_V11]), 11);
    expect(out.quiz.prompts).toEqual([...QUIZ_PROMPTS_V12]);
  });
});
