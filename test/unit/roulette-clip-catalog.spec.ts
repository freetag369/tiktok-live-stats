import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROULETTE_PATTERN_TIMING, rouletteUltraClipIds } from '@shared/roulette-fx';
import type { RoulettePattern } from '@shared/dto';
import { ROULETTE_PATTERN_TIER } from '@shared/dto';

/**
 * 超激アツ動画クリップの id ⇄ 実ファイルの結合検査(fx-catalog.spec.ts の cut/ と
 * 同じ流儀 — renderer/lib/fx.ts は node vitest から import できないので、実ディレクトリ
 * を読んで突き合わせる)。
 *
 * ディレクトリ対の検査は素材投入後にだけ走る(skipIf)— コードとタイミング表を
 * 素材生成より先に出荷するための意図的な緩み。ディレクトリが現れた瞬間から
 * 「孤児ファイル」「スラッグ打ち間違い」の両方を検出する厳格モードに自動で切り替わる。
 */
const RL_DIR = join(__dirname, '../../src/renderer/assets/fx/rl');

describe('超激アツクリップのカタログ(shared/roulette-fx.ts)', () => {
  it('id は <pattern>-<n> 形式で、パターンは ultra 段位・n はウィンドウ数まで', () => {
    const ids = rouletteUltraClipIds();
    for (const id of ids) {
      const m = /^([a-z]+)-([1-9])$/.exec(id);
      expect(m, id).not.toBeNull();
      const p = m![1]! as RoulettePattern;
      expect(ROULETTE_PATTERN_TIER[p], id).toBe('ultra');
      expect(Number(m![2]!), id).toBeLessThanOrEqual(ROULETTE_PATTERN_TIMING[p].clips!.length);
    }
  });

  it('id は一意', () => {
    const ids = rouletteUltraClipIds();
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe.skipIf(!existsSync(RL_DIR))('超激アツクリップの実ファイル(assets/fx/rl/)', () => {
  it('素材ファイルと id が一対一(孤児もスラッグ間違いも両方検出)', () => {
    const files = readdirSync(RL_DIR)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => f.replace(/\.mp4$/, ''))
      .sort();
    expect(files).toEqual([...rouletteUltraClipIds()].sort());
  });
});
