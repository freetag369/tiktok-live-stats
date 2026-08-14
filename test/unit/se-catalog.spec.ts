import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CHALLENGE_SE_SLOTS, CHALLENGE_SE_SOUND_IDS, DEFAULT_SE_SOUNDS } from '@shared/challenge';

/**
 * 効果音カタログの結合検査。**renderer/lib/se.ts は import できない**
 * (vitest の node 環境には @renderer エイリアスも ogg/mp3 のローダも無い)ので、
 * fx-catalog.spec.ts と同じく「id ⇄ ファイル名」だけ実ファイルを読んで突き合わせる。
 * shared の id リストと実素材がズレていないことの唯一の機械的な担保。
 *
 * ここが落ちるときの原因はだいたい2つ: 素材を置かずに id を足した /
 * ファイル名を変えたのに id を直していない。どちらも実行時は
 * 「validateSeSounds が未知 id として既定へ倒す」or「無音」で静かに壊れる。
 */
const SE_DIR = join(__dirname, '../../src/renderer/assets/se');

/** サブフォルダ(band/ roulette/)は bgm.ts のカタログなのでここでは見ない。 */
function seFiles(): string[] {
  return readdirSync(SE_DIR, { withFileTypes: true })
    .filter((e) => e.isFile() && /\.(ogg|mp3)$/.test(e.name))
    .map((e) => e.name);
}

describe('効果音カタログ(shared/challenge.ts ⇄ assets/se/)', () => {
  it('id は ASCII スラッグ(ファイル名になるので非ASCIIは不可)', () => {
    for (const id of CHALLENGE_SE_SOUND_IDS) expect(id, id).toMatch(/^[a-z0-9-]+$/);
  });

  it('id は一意', () => {
    expect(new Set(CHALLENGE_SE_SOUND_IDS).size).toBe(CHALLENGE_SE_SOUND_IDS.length);
  });

  it('id ごとに <id>.ogg か <id>.mp3 がちょうど1つある', () => {
    const files = new Set(seFiles());
    for (const id of CHALLENGE_SE_SOUND_IDS) {
      const found = [`${id}.ogg`, `${id}.mp3`].filter((f) => files.has(f));
      expect(found, id).toHaveLength(1);
    }
  });

  it('assets/se/ 直下の素材はすべて id 登録されている(置いたのに選べない素材を作らない)', () => {
    const ids = new Set(CHALLENGE_SE_SOUND_IDS);
    for (const f of seFiles()) expect(ids.has(f.replace(/\.(ogg|mp3)$/, '')), f).toBe(true);
  });

  it('既定はすべてカタログ内の id(= どのスロットも起動直後から鳴る)', () => {
    for (const slot of CHALLENGE_SE_SLOTS) {
      expect(CHALLENGE_SE_SOUND_IDS, slot).toContain(DEFAULT_SE_SOUNDS[slot]);
    }
  });
});
