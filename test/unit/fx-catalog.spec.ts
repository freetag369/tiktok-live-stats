import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_FX_CLIP_IDS,
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_FULL_CUT,
  matchGiftFullCut,
} from '@shared/challenge';
import { FULL_CUT_CLIPS, FULL_CUT_CLIPS_V1, FULL_CUT_CLIPS_V3, FULL_CUT_CLIP_IDS } from '@shared/fx-cut';
import type { ChallengeConfig } from '@shared/dto';

/**
 * 全面カットのカタログ検査。**renderer/lib/fx.ts は import できない**
 * (vitest の node 環境には @renderer エイリアスも mp4 のローダも無い)ので、
 * 「id ⇄ ファイル名」の結合だけは実ファイルを読んで突き合わせる。
 * これが shared と renderer の唯一の機械的な担保。
 */
const CUT_DIR = join(__dirname, '../../src/renderer/assets/fx/cut');

function fullCutCfg(): ChallengeConfig {
  return { ...structuredClone(DEFAULT_CHALLENGE), enabled: true };
}

describe('全面カットのカタログ(shared/fx-cut.ts)', () => {
  it('id は cut- + ASCII スラッグ(ファイル名になるので非ASCIIは不可)', () => {
    for (const c of FULL_CUT_CLIPS) {
      expect(c.id, c.id).toMatch(/^cut-[a-z0-9-]+$/);
    }
  });

  it('id は一意', () => {
    expect(new Set(FULL_CUT_CLIP_IDS).size).toBe(FULL_CUT_CLIP_IDS.length);
  });

  it('V3 は V1 の id を含まない(移行の二重適用防止の前提)', () => {
    const v1 = new Set(FULL_CUT_CLIPS_V1.map((c) => c.id));
    for (const c of FULL_CUT_CLIPS_V3) expect(v1.has(c.id), c.id).toBe(false);
  });

  it('giftName は小文字で保存されている(matchGiftTrigger の規約)', () => {
    for (const c of FULL_CUT_CLIPS) {
      expect(c.giftName, c.id).toBe(c.giftName.toLowerCase());
      expect(c.canonical, c.id).toBe(c.canonical.toLowerCase());
    }
  });

  it('トリガーが全部空の行は無い(どのギフトにも一致しない行は事故)', () => {
    for (const c of FULL_CUT_CLIPS) {
      expect(c.giftName !== '' || c.canonical !== '', c.id).toBe(true);
    }
  });

  it('**素材ファイルと id が一対一**(スラッグの打ち間違いと孤児ファイルの検出)', () => {
    const files = readdirSync(CUT_DIR)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => f.replace(/\.mp4$/, ''))
      .sort();
    expect(files).toEqual([...FULL_CUT_CLIP_IDS].sort());
  });
});

describe('全面カットの既定行(DEFAULT_GIFT_FULL_CUT)', () => {
  const rules = DEFAULT_GIFT_FULL_CUT.rules;

  it('カタログと同数・同順で、id は fullcut- 接頭辞', () => {
    expect(rules).toHaveLength(FULL_CUT_CLIPS.length);
    rules.forEach((r, i) => {
      expect(r.clip).toBe(FULL_CUT_CLIPS[i]!.id);
      expect(r.id).toBe(`fullcut-${FULL_CUT_CLIPS[i]!.id.slice('cut-'.length)}`);
    });
  });

  it('clip はすべて CHALLENGE_FX_CLIP_IDS に載っている(validate に弾かれない)', () => {
    for (const r of rules) expect(CHALLENGE_FX_CLIP_IDS, r.id).toContain(r.clip);
  });

  it('全行 enabled / durationSec 5(素材 5.09 秒 > 5 秒なのでループしない)', () => {
    for (const r of rules) {
      expect(r.enabled, r.id).toBe(true);
      expect(r.durationSec, r.id).toBe(5);
    }
  });

  it('id は一意', () => {
    expect(new Set(rules.map((r) => r.id)).size).toBe(rules.length);
  });

  /**
   * **上の行に食われていないこと**の検出。先勝ちなので、あるギフト名が
   * 別の行のトリガーを含んでいると、下の行は永久に発火しない。
   * 新しい素材を足したときにここが落ちたら、その行を exactName にするか
   * トリガー文字列を長くする。
   */
  it('各既定行は自分自身に一致する(先勝ちで上の行に食われない)', () => {
    const cfg = fullCutCfg();
    for (const c of FULL_CUT_CLIPS) {
      const expected = `fullcut-${c.id.slice('cut-'.length)}`;
      // ruleLabel は実際のギフト名そのもの。ライブ経路は canonical が乗らないので
      // giftName だけで引く(本番と同じ条件)。
      const hit = matchGiftFullCut(cfg, { giftId: 'x', giftName: c.ruleLabel });
      expect(hit?.id, `${c.id} は ${hit?.id ?? 'null'} に食われている`).toBe(expected);
    }
  });

  it('TikTok 行は上位ギフトを奪わない(exactName の実効性)', () => {
    const cfg = fullCutCfg();
    for (const name of ['TikTok Universe', 'TikTok Universe+', 'TikTok Stars']) {
      expect(matchGiftFullCut(cfg, { giftId: 'x', giftName: name }), name).toBeNull();
    }
    // 本体の「TikTok」だけは当たる
    expect(matchGiftFullCut(cfg, { giftId: 'x', giftName: 'TikTok' })?.clip).toBe('cut-tiktok');
  });
});
