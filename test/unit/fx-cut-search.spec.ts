/**
 * 全面カット設定の絞り込み(設定画面の検索欄)。
 *
 * 見ているのは **表示だけ** の関数で、配信イベントとの一致判定(matchGiftTrigger)
 * とは別物。あちらは表記ゆれを吸わない — ここで正規化を足したからといって
 * 実際に発火するギフトが増えるわけではない。
 */
import { describe, it, expect } from 'vitest';
import { FULL_CUT_CLIPS, fullCutRuleMatches, normalizeSearchText } from '../../src/shared/fx-cut';

/** カタログ1件を設定行の形(label/giftName/giftId)に均す。 */
function ruleOf(clipId: string): { label: string; giftName: string; giftId: string } {
  const c = FULL_CUT_CLIPS.find((x) => x.id === clipId);
  if (!c) throw new Error(`unknown clip: ${clipId}`);
  return { label: c.ruleLabel, giftName: c.giftName, giftId: c.giftId };
}

const rose = ruleOf('cut-rose'); // 表示名「バラ」/ rose / 5655
const rosa = ruleOf('cut-rosa'); // 表示名「ローザ」/ rosa / 8913
const tiktok = ruleOf('cut-tiktok'); // 表示名「TikTok」/ tiktok / 5269

describe('normalizeSearchText', () => {
  it('全角英数を半角に倒す', () => {
    expect(normalizeSearchText('ＲＯＳＥ')).toBe('rose');
  });
  it('カタカナをひらがなに倒す', () => {
    expect(normalizeSearchText('バラ')).toBe('ばら');
  });
  it('半角カナも NFKC 経由でひらがなに揃う', () => {
    expect(normalizeSearchText('ﾊﾞﾗ')).toBe('ばら');
  });
  it('漢字と数字はそのまま', () => {
    expect(normalizeSearchText('素晴らしい123')).toBe('素晴らしい123');
  });
});

describe('fullCutRuleMatches', () => {
  it('空クエリは常に一致(絞り込み無し)', () => {
    expect(fullCutRuleMatches(rose, 'バラ', '')).toBe(true);
    expect(fullCutRuleMatches(rose, 'バラ', '   ')).toBe(true);
  });

  it('表示名の部分一致', () => {
    expect(fullCutRuleMatches(rosa, 'ローザ', 'ロー')).toBe(true);
    expect(fullCutRuleMatches(rose, 'バラ', 'ロー')).toBe(false);
  });

  it('ギフト名(英語)で当たる', () => {
    expect(fullCutRuleMatches(rose, 'バラ', 'rose')).toBe(true);
  });

  it('大文字・全角・ひらがなのどれでも当たる', () => {
    for (const q of ['ROSE', 'ＲＯＳＥ', 'Rose']) {
      expect(fullCutRuleMatches(rose, 'バラ', q), q).toBe(true);
    }
    // 表示名はカタカナ「バラ」だが、ひらがなで打っても届く。
    expect(fullCutRuleMatches(rose, 'バラ', 'ばら')).toBe(true);
  });

  it('giftId で当たる', () => {
    expect(fullCutRuleMatches(rosa, 'ローザ', '8913')).toBe(true);
    expect(fullCutRuleMatches(rose, 'バラ', '8913')).toBe(false);
  });

  it('クリップのラベルで当たる(行のどの欄にも無い語)', () => {
    const blank = { label: '', giftName: '', giftId: '' };
    expect(fullCutRuleMatches(blank, 'ミニ花火', '花火')).toBe(true);
    expect(fullCutRuleMatches(blank, '', '花火')).toBe(false);
  });

  it('空白区切りは AND — 片方しか当たらない行は落ちる', () => {
    expect(fullCutRuleMatches(rose, 'バラ', 'rose 5655')).toBe(true);
    expect(fullCutRuleMatches(rose, 'バラ', 'rose 8913')).toBe(false);
    // 連続空白や全角空白でも語が空にならない。
    expect(fullCutRuleMatches(rose, 'バラ', ' rose　バラ ')).toBe(true);
  });

  it('欄をまたいだ語の連結では誤爆しない', () => {
    // label「バラ」+ giftName「rose」を素で連結すると 'ばらrose' に当たってしまう。
    expect(fullCutRuleMatches(rose, 'バラ', 'ばらrose')).toBe(false);
  });

  describe('既定42行を通した件数', () => {
    const rules = FULL_CUT_CLIPS.map((c) => ({ rule: ruleOf(c.id), clipLabel: c.label }));
    const count = (q: string): number =>
      rules.filter(({ rule, clipLabel }) => fullCutRuleMatches(rule, clipLabel, q)).length;

    it('空クエリなら全42行', () => {
      expect(rules).toHaveLength(42);
      expect(count('')).toBe(42);
    });

    it('「rosa」はローザ1行だけ', () => {
      expect(count('rosa')).toBe(1);
    });

    it('「tiktok」は TikTok の行だけ(既定行どうしでは1件)', () => {
      expect(count('tiktok')).toBe(1);
      expect(fullCutRuleMatches(tiktok, 'TikTok', 'tiktok')).toBe(true);
    });

    it('どの行にも無い語は0件', () => {
      expect(count('存在しないギフト')).toBe(0);
    });
  });
});
