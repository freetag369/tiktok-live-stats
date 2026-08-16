import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TAP_BOOST_COUNT_CLIPS,
  TAP_BOOST_INTRO_CLIPS,
  TAP_BOOST_LOOP_CLIPS,
  TAP_BOOST_RESULT_CLIPS,
} from '@shared/challenge';

/**
 * タップブースト素材の id ⇄ 実ファイルの結合検査(roulette-clip-catalog.spec.ts /
 * fx-catalog.spec.ts の cut/ と同じ流儀 — renderer/lib/fx.ts は node vitest から
 * import できないので、実ディレクトリを読んで突き合わせる)。
 *
 * boost には従来この検査が無く、素材の欠落は boostClipUrl の null → 暗幕へ
 * **無言縮退**するだけだった(網羅監査 2026-08-16 で検出)。
 */
const BOOST_DIR = join(__dirname, '../../src/renderer/assets/fx/boost');

const LISTS = [
  { list: TAP_BOOST_INTRO_CLIPS, prefix: 'intro-' },
  { list: TAP_BOOST_COUNT_CLIPS, prefix: 'count-' },
  { list: TAP_BOOST_LOOP_CLIPS, prefix: 'loop-' },
  { list: TAP_BOOST_RESULT_CLIPS, prefix: 'result-' },
] as const;

const ALL = LISTS.flatMap((l) => l.list);

/**
 * 既知の未同梱(素材が生成され次第ここから外す)。行ラベルに「素材未同梱」を
 * 明記している id だけを許す — コードとこのリストの二重管理を防ぐ検査が下にある。
 */
const KNOWN_MISSING = ['result-panther'];

describe('タップブースト素材のカタログ(shared/challenge.ts)', () => {
  it('id は一意で、各リストの接頭辞つき ASCII スラッグ', () => {
    expect(new Set(ALL.map((c) => c.id)).size).toBe(ALL.length);
    for (const { list, prefix } of LISTS) {
      for (const c of list) {
        expect(c.id, c.id).toMatch(/^[a-z0-9-]+$/);
        expect(c.id.startsWith(prefix), `${c.id} は ${prefix} で始まるべき`).toBe(true);
      }
    }
  });

  it('KNOWN_MISSING の行はラベルに「素材未同梱」を明記している', () => {
    for (const id of KNOWN_MISSING) {
      const def = ALL.find((c) => c.id === id);
      expect(def, `${id} がカタログに無い — KNOWN_MISSING から外す`).toBeDefined();
      expect(def!.label, id).toContain('素材未同梱');
    }
  });
});

describe.skipIf(!existsSync(BOOST_DIR))('タップブースト素材の実ファイル(assets/fx/boost/)', () => {
  const files = readdirSync(BOOST_DIR)
    .filter((f) => f.endsWith('.mp4'))
    .map((f) => f.replace(/\.mp4$/, ''))
    .sort();

  it('実ファイルはすべてカタログに載っている(孤児の検出)', () => {
    const ids = new Set(ALL.map((c) => c.id));
    for (const f of files) expect(ids.has(f), `孤児ファイル: ${f}.mp4`).toBe(true);
  });

  it('カタログの id は実ファイルか KNOWN_MISSING のどちらかに居る(欠落の検出)', () => {
    const have = new Set(files);
    for (const c of ALL) {
      expect(
        have.has(c.id) || KNOWN_MISSING.includes(c.id),
        `素材が無いのに KNOWN_MISSING にも無い: ${c.id}`
      ).toBe(true);
    }
  });

  it('KNOWN_MISSING の素材が届いたらリストから外す(鮮度の検査)', () => {
    for (const id of KNOWN_MISSING) {
      expect(files.includes(id), `${id}.mp4 が実在する — KNOWN_MISSING から外す`).toBe(false);
    }
  });
});
