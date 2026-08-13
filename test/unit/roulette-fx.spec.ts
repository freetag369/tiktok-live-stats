import { describe, expect, it } from 'vitest';
import { ROULETTE_SEGMENTS_MAX } from '@shared/challenge';
import {
  ROULETTE_BLOCK_GAP,
  ROULETTE_BLOCK_W,
  ROULETTE_KICK_AT,
  ROULETTE_NEAR_STOP_AT,
  ROULETTE_PATTERNS,
  ROULETTE_SPIN_SE_END_AT,
  ROULETTE_STRIP_LEN,
  ROULETTE_TARGET_BLOCK,
  drawRoulettePattern,
  rouletteRun,
  rouletteStrip,
} from '@shared/roulette-fx';

/** 盤面の全サイズ × 全 index を総当たりするための組み合わせ。 */
const SIZES = Array.from({ length: ROULETTE_SEGMENTS_MAX }, (_, i) => i + 1);
const segsOf = (n: number): number[] => Array.from({ length: n }, (_, i) => (i + 1) * 10);

describe('rouletteStrip — 当選は必ず固定位置に来る', () => {
  it('どの盤面サイズ・どの index でも strip[TARGET] が当選の出目になる', () => {
    for (const n of SIZES) {
      const segs = segsOf(n);
      for (let index = 0; index < n; index++) {
        expect(rouletteStrip(segs, index)[ROULETTE_TARGET_BLOCK]).toBe(segs[index]);
      }
    }
  });

  it('並びは元の盤面の巡回のまま(見た目が普通のリールであること)', () => {
    const segs = segsOf(6);
    const strip = rouletteStrip(segs, 4);
    for (let i = 0; i + 1 < strip.length; i++) {
      const cur = segs.indexOf(strip[i]!);
      expect(strip[i + 1]).toBe(segs[(cur + 1) % segs.length]);
    }
  });

  it('長さは index に依存しない(DOM のノード数から結果を逆算させない)', () => {
    const segs = segsOf(6);
    for (let index = 0; index < 6; index++) {
      expect(rouletteStrip(segs, index)).toHaveLength(ROULETTE_STRIP_LEN);
    }
  });

  it('盤面 0 件は空配列(呼び出し側でクラッシュさせない)', () => {
    expect(rouletteStrip([], 0)).toEqual([]);
  });
});

describe('走行距離と幾何の不変条件', () => {
  it('開始位置の左隣まで描かれている(添字が負にならない)', () => {
    // 開始時は「当選の run 個手前」が窓の中央。その左隣も要るので TARGET - run >= 1。
    for (const n of SIZES) {
      for (let seed = 0; seed < n * 3; seed++) {
        for (const fast of [false, true]) {
          expect(ROULETTE_TARGET_BLOCK - rouletteRun(seed, n, fast)).toBeGreaterThanOrEqual(1);
        }
      }
    }
  });

  it('着地時に当選の右隣まで描かれている(キックの行き過ぎぶんも含む)', () => {
    expect(ROULETTE_STRIP_LEN).toBeGreaterThanOrEqual(ROULETTE_TARGET_BLOCK + 2);
  });

  it('ジッタは 0..n-1 で、負の seed でも範囲内に収まる', () => {
    const n = 6;
    const base = rouletteRun(0, n, false);
    for (let seed = -20; seed < 40; seed++) {
      const run = rouletteRun(seed, n, false);
      expect(run).toBeGreaterThanOrEqual(base);
      expect(run).toBeLessThan(base + n);
    }
  });

  it('連続する seed で「開始時に中央にある値から当選までの距離」が一様に散る', () => {
    // ジッタが無いと (index - run) mod n が固定され、盤面の並びを覚えた常連に
    // 1フレーム目で読まれる。n 連続の seed が n 通りすべてを踏むことを確認する。
    const n = 6;
    const phases = new Set<number>();
    for (let seed = 0; seed < n; seed++) phases.add(rouletteRun(seed, n, false) % n);
    expect(phases.size).toBe(n);
  });

  it('短縮スピンのほうが走行距離が短い(900ms に収まる)', () => {
    expect(rouletteRun(0, 6, true)).toBeLessThan(rouletteRun(0, 6, false));
  });

  it('ブロック幅は正で、左右マージンを引いても潰れない', () => {
    expect(ROULETTE_BLOCK_W - ROULETTE_BLOCK_GAP * 2).toBeGreaterThan(0);
  });
});

describe('drawRoulettePattern — 終盤パターンの抽選', () => {
  it('rand=0 は先頭、rand→1 は末尾', () => {
    expect(drawRoulettePattern(() => 0)).toBe('slow');
    expect(drawRoulettePattern(() => 0.999999)).toBe('kick');
  });

  it('3パターンすべてが出る', () => {
    const seen = new Set(ROULETTE_PATTERNS.map((_, i) => drawRoulettePattern(() => i / 3 + 0.01)));
    expect(seen).toEqual(new Set(['slow', 'pop', 'kick']));
  });

  it('rand が範囲外を返しても既知のパターンに収まる(クラッシュ源を作らない)', () => {
    expect(ROULETTE_PATTERNS).toContain(drawRoulettePattern(() => 1));
    expect(ROULETTE_PATTERNS).toContain(drawRoulettePattern(() => -1));
  });
});

describe('キックの時刻', () => {
  it('スピンの終盤にあり、着地より前(monitor.css の rl-run-kick 87.5% と揃える)', () => {
    expect(ROULETTE_KICK_AT).toBeGreaterThan(0.8);
    expect(ROULETTE_KICK_AT).toBeLessThan(1);
  });
});

describe('「止まりそう」の時刻', () => {
  it('段のある3パターンすべてで鳴り、fast だけ番兵 1(= 鳴らさない)', () => {
    for (const p of ROULETTE_PATTERNS) {
      expect(ROULETTE_NEAR_STOP_AT[p]).toBeGreaterThan(0.5);
      expect(ROULETTE_NEAR_STOP_AT[p]).toBeLessThan(1);
    }
    expect(ROULETTE_NEAR_STOP_AT.fast).toBe(1);
  });

  it('キックより前に来る(溜めの合図が一撃を追い越さない)', () => {
    expect(ROULETTE_NEAR_STOP_AT.kick).toBeLessThan(ROULETTE_KICK_AT);
  });

  it('回転ループ音が止まったあとに鳴る(カラカラに埋もれさせない)', () => {
    // slow は例外 — ループ音が 94% まで鳴り、その手前 80% で合図が入る。
    // 「止まりそう」の合図は着地の1個手前に着いた瞬間という幾何側の都合が優先。
    for (const p of ['pop', 'kick'] as const) {
      expect(ROULETTE_NEAR_STOP_AT[p]).toBeGreaterThan(ROULETTE_SPIN_SE_END_AT[p]);
    }
  });
});
