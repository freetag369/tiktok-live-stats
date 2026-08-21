import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ROULETTE_PATTERN_TIMING, rouletteUltraClipIds } from '@shared/roulette-fx';
import type { RoulettePattern } from '@shared/dto';
import { ROULETTE_PATTERN_TIER } from '@shared/dto';
import { ROULETTE_HOT_INTRO_PATTERNS, ROULETTE_HOT_PATTERNS } from '@shared/challenge';
import { ROULETTE_HOT_ONLY_PATTERNS, ROULETTE_PATTERNS, ROULETTE_SELECTABLE_PATTERNS } from '@shared/dto';

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
/**
 * 激熱確定の導入動画。**サブディレクトリに分けてある** — rl/ 直下に置くと
 * 下の「id ⇄ ファイルが 1:1」が孤児として弾く(あちらは非再帰・*.mp4 のみ)。
 * renderer/lib/fx.ts の glob も別に持たせてある(rouletteHotIntroUrl)。
 */
const RL_HOT_DIR = join(RL_DIR, 'hot');

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

describe.skipIf(!existsSync(RL_HOT_DIR))('激熱確定の導入動画(assets/fx/rl/hot/)', () => {
  it('素材ファイルと ROULETTE_HOT_INTRO_PATTERNS が一対一', () => {
    const files = readdirSync(RL_HOT_DIR)
      .filter((f) => f.endsWith('.mp4'))
      .map((f) => f.replace(/\.mp4$/, ''))
      .sort();
    // 抽選の3種だけでなく**ギフト連動の絵柄も導入動画が要る** — 比較先は合併の1本。
    expect(files).toEqual([...ROULETTE_HOT_INTRO_PATTERNS].sort());
  });
});

describe('激熱確定の絵柄は超激アツ(ultra)であること', () => {
  it('導入動画が要る絵柄は全部 ultra 段位 = donAts を持つ(倍率の段が乗る唯一の段位)', () => {
    expect(ROULETTE_HOT_INTRO_PATTERNS.length).toBeGreaterThanOrEqual(ROULETTE_HOT_PATTERNS.length);
    for (const p of ROULETTE_HOT_INTRO_PATTERNS) {
      expect(ROULETTE_PATTERN_TIER[p], p).toBe('ultra');
      expect(ROULETTE_PATTERN_TIMING[p].donAts, p).toBeTruthy();
    }
  });
});

describe('激熱確定専用の絵柄は通常の抽選・設定一覧から締め出されている', () => {
  it('ROULETTE_PATTERNS には居るが ROULETTE_SELECTABLE_PATTERNS には居ない', () => {
    // 一覧に居ないと drawRoulettePattern の pool が空になり、1要素で指名したつもりが
    // 全パターンへフォールバックして激熱が 'slow' を引く(いちばん怖い壊れ方)。
    for (const p of ROULETTE_HOT_ONLY_PATTERNS) {
      expect(ROULETTE_PATTERNS, p).toContain(p);
      expect(ROULETTE_SELECTABLE_PATTERNS, p).not.toContain(p);
    }
  });

  it('激熱専用の絵柄は導入動画が要る側に載っている(素材の孤児を作らない)', () => {
    for (const p of ROULETTE_HOT_ONLY_PATTERNS) {
      expect(ROULETTE_HOT_INTRO_PATTERNS, p).toContain(p);
    }
  });
});
