import { describe, expect, it } from 'vitest';
import { ROULETTE_SEGMENTS_MAX } from '@shared/challenge';
import type { RoulettePattern } from '@shared/dto';
import {
  ROULETTE_BLOCK_GAP,
  ROULETTE_BLOCK_W,
  ROULETTE_MAX_OVERSHOOT,
  ROULETTE_PATTERN_TIMING,
  ROULETTE_PATTERNS,
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

  it('最大の行き過ぎ(overrun のフェイク着地)でも右端に空白が出ない', () => {
    // 右端ブロックの右縁は当選中心から (STRIP_LEN - 1 - TARGET) + 0.5 ブロック右。
    // 行き過ぎ x のとき窓の右縁は当選中心から x + 1.5 ブロック右まで要る。
    // キーフレームの行き過ぎ量を増やすときは ROULETTE_MAX_OVERSHOOT とセットで。
    const coverage = ROULETTE_STRIP_LEN - 1 - ROULETTE_TARGET_BLOCK + 0.5;
    expect(coverage).toBeGreaterThanOrEqual(1.5 + ROULETTE_MAX_OVERSHOOT);
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
  it('パターンは13種', () => {
    expect(ROULETTE_PATTERNS).toHaveLength(13);
  });

  it('rand=0 は先頭、rand→1 は末尾', () => {
    expect(drawRoulettePattern(() => 0)).toBe('slow');
    expect(drawRoulettePattern(() => 0.999999)).toBe('jackback');
  });

  it('全パターンが出る', () => {
    const n = ROULETTE_PATTERNS.length;
    const seen = new Set(ROULETTE_PATTERNS.map((_, i) => drawRoulettePattern(() => i / n + 0.001)));
    expect(seen).toEqual(new Set(ROULETTE_PATTERNS));
  });

  it('rand が範囲外を返しても既知のパターンに収まる(クラッシュ源を作らない)', () => {
    expect(ROULETTE_PATTERNS).toContain(drawRoulettePattern(() => 1));
    expect(ROULETTE_PATTERNS).toContain(drawRoulettePattern(() => -1));
  });

  it('許可リストを渡すとその中からだけ出る', () => {
    const allowed: RoulettePattern[] = ['pop', 'teeter', 'jackstop'];
    for (let i = 0; i < 30; i++) {
      expect(allowed).toContain(drawRoulettePattern(() => i / 30, allowed));
    }
  });

  it('許可リストは正順に正規化される(rand=0 で並び順に依らず同じ先頭)', () => {
    // ROULETTE_PATTERNS 側の順でプールを組むので、逆順で渡しても先頭は 'pop'。
    expect(drawRoulettePattern(() => 0, ['kick', 'pop'])).toBe('pop');
  });

  it('許可リストの未知値は無視される', () => {
    const allowed = ['pop', 'no-such-pattern'] as RoulettePattern[];
    for (let i = 0; i < 10; i++) {
      expect(drawRoulettePattern(() => i / 10, allowed)).toBe('pop');
    }
  });

  it('許可リストが空・未指定・全滅なら全パターンへ倒す(スピンを止めない)', () => {
    expect(drawRoulettePattern(() => 0, [])).toBe('slow');
    expect(drawRoulettePattern(() => 0, undefined)).toBe('slow');
    expect(drawRoulettePattern(() => 0.999999, ['bogus'] as unknown as RoulettePattern[])).toBe(
      'jackback'
    );
  });
});

describe('ROULETTE_PATTERN_TIMING — SE タイミングの不変条件', () => {
  it('fast は全て番兵(段が無いので何も鳴らさない)', () => {
    const t = ROULETTE_PATTERN_TIMING.fast;
    expect(t.nearAt).toBe(1);
    expect(t.quietAt).toBe(1);
    expect(t.kickAts).toEqual([]);
    expect(t.stepAts).toEqual([]);
  });

  it('全パターンにテーブルの行があり、時刻はスピンの後半〜着地前に収まる', () => {
    for (const p of ROULETTE_PATTERNS) {
      const t = ROULETTE_PATTERN_TIMING[p];
      expect(t.nearAt).toBeGreaterThan(0.5);
      expect(t.nearAt).toBeLessThan(1);
      // veil が閉じ切る(46%)前にループ音を落とすパターンは無い —
      // 高速域でカチカチが消えると「もう終わり?」と誤読される。
      expect(t.quietAt).toBeGreaterThanOrEqual(0.46);
      expect(t.quietAt).toBeLessThan(1);
      for (const at of [...t.kickAts, ...t.stepAts]) {
        expect(at).toBeGreaterThan(0);
        expect(at).toBeLessThan(1);
      }
    }
  });

  it('キックと段の音は昇順(同時刻の連打を作らない)', () => {
    for (const p of ROULETTE_PATTERNS) {
      const t = ROULETTE_PATTERN_TIMING[p];
      for (const ats of [t.kickAts, t.stepAts]) {
        for (let i = 0; i + 1 < ats.length; i++) expect(ats[i]!).toBeLessThan(ats[i + 1]!);
      }
    }
  });

  it('衝撃と段の音は回転ループ音が止まったあとに鳴る(カラカラに埋もれさせない)', () => {
    // blackout は暗転の瞬間に quiet と kick を同時に置くので >= で見る。
    for (const p of ROULETTE_PATTERNS) {
      const t = ROULETTE_PATTERN_TIMING[p];
      for (const at of [...t.kickAts, ...t.stepAts]) {
        expect(at).toBeGreaterThanOrEqual(t.quietAt);
      }
    }
  });

  it('「止まりそう」もループ音停止のあとに鳴る(slow と blackout は幾何都合の例外)', () => {
    // slow: ループ音は 94% まで鳴り、k=1 到達(80%)が先に来る。
    // blackout: 暗転(72%)でループ音を落とすが、k=1 到達は 64%。
    // どちらも「合図は k=1 帯に入った瞬間」という幾何側の規則が優先。
    for (const p of ROULETTE_PATTERNS) {
      if (p === 'slow' || p === 'blackout') continue;
      const t = ROULETTE_PATTERN_TIMING[p];
      expect(t.nearAt).toBeGreaterThan(t.quietAt);
    }
  });

  it('締めの一撃を持つパターンでは、最後のキックが「止まりそう」より後', () => {
    // restart(再点火)と blackout(暗転)のキックは中盤の衝撃なので対象外。
    for (const p of ['kick', 'overrun', 'doublefake', 'jackstop', 'jackback'] as const) {
      const t = ROULETTE_PATTERN_TIMING[p];
      expect(t.kickAts.at(-1)!).toBeGreaterThan(t.nearAt);
    }
  });
});
