import { describe, expect, it } from 'vitest';
import {
  JOIN_ROULETTE_MIN_GAP_MS,
  ROULETTE_SEGMENTS_MAX,
  ROULETTE_SPIN_FAST_MS,
  ROULETTE_SPIN_HEAVY_MS,
  ROULETTE_SPIN_MID_MS,
  ROULETTE_SPIN_MS,
  ROULETTE_SPIN_ULTRA_MS,
  rouletteAbortMs,
  rouletteRevealMs,
  rouletteSpinMs,
} from '@shared/challenge';
import type { RoulettePattern, RouletteSpinKey, RouletteTier } from '@shared/dto';
import { ROULETTE_PATTERN_TIER } from '@shared/dto';
import {
  RL_CLIP_FADE_MS,
  RL_CLIP_REMOVE_MS,
  ROULETTE_BLOCK_GAP,
  ROULETTE_BLOCK_W,
  ROULETTE_MAX_OVERSHOOT,
  ROULETTE_PATTERN_TIMING,
  ROULETTE_PATTERNS,
  ROULETTE_STRIP_LEN,
  ROULETTE_TARGET_BLOCK,
  ROULETTE_TIER_WEIGHTS,
  drawRoulettePattern,
  roulettePatternWeights,
  rouletteRarityBand,
  rouletteRun,
  rouletteStrip,
  rouletteUltraClipIds,
} from '@shared/roulette-fx';

/** rouletteRun / rouletteSpinMs の引数キー全種('fast' + 13パターン)。 */
const SPIN_KEYS: readonly RouletteSpinKey[] = ['fast', ...ROULETTE_PATTERNS];

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
    // heavy(最長走行)+ 最大盤面 + 最大ジッタでちょうど 1 になる設計。
    for (const n of SIZES) {
      for (let seed = 0; seed < n * 3; seed++) {
        for (const key of SPIN_KEYS) {
          expect(ROULETTE_TARGET_BLOCK - rouletteRun(seed, n, key)).toBeGreaterThanOrEqual(1);
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
    const base = rouletteRun(0, n, 'slow');
    for (let seed = -20; seed < 40; seed++) {
      const run = rouletteRun(seed, n, 'slow');
      expect(run).toBeGreaterThanOrEqual(base);
      expect(run).toBeLessThan(base + n);
    }
  });

  it('連続する seed で「開始時に中央にある値から当選までの距離」が一様に散る', () => {
    // ジッタが無いと (index - run) mod n が固定され、盤面の並びを覚えた常連に
    // 1フレーム目で読まれる。n 連続の seed が n 通りすべてを踏むことを確認する。
    const n = 6;
    const phases = new Set<number>();
    for (let seed = 0; seed < n; seed++) phases.add(rouletteRun(seed, n, 'slow') % n);
    expect(phases.size).toBe(n);
  });

  it('短縮スピンのほうが走行距離が短い(900ms に収まる)', () => {
    expect(rouletteRun(0, 6, 'fast')).toBeLessThan(rouletteRun(0, 6, 'slow'));
  });

  it('走行距離は段位に単調(尺に比例 = 序盤の流速が段位で変わらない)', () => {
    expect(rouletteRun(0, 6, 'slow')).toBeLessThan(rouletteRun(0, 6, 'kick'));
    expect(rouletteRun(0, 6, 'kick')).toBeLessThan(rouletteRun(0, 6, 'jackstop'));
    // 同段位内は同距離(距離はパターンではなく段位の関数)。
    expect(rouletteRun(0, 6, 'doublefake')).toBe(rouletteRun(0, 6, 'jackback'));
    // ultra は heavy と同距離 — 走り込みが尺の先頭に収まるので幾何を増やさない。
    expect(rouletteRun(0, 6, 'dragon')).toBe(rouletteRun(0, 6, 'jackstop'));
  });

  it('ブロック幅は正で、左右マージンを引いても潰れない', () => {
    expect(ROULETTE_BLOCK_W - ROULETTE_BLOCK_GAP * 2).toBeGreaterThan(0);
  });
});

describe('drawRoulettePattern — 終盤パターンの抽選', () => {
  it('パターンは18種', () => {
    expect(ROULETTE_PATTERNS).toHaveLength(22);
  });

  it('rand=0 は先頭、rand→1 は末尾', () => {
    expect(drawRoulettePattern(() => 0)).toBe('slow');
    expect(drawRoulettePattern(() => 0.999999)).toBe('heartbloom');
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
      'heartbloom'
    );
  });
});

describe('段位(tier)と尺 — 信頼度方式の骨格', () => {
  it('全22パターンに段位があり、heavy/ultra の顔ぶれが固定されている', () => {
    for (const p of ROULETTE_PATTERNS) {
      expect(['light', 'mid', 'heavy', 'ultra']).toContain(ROULETTE_PATTERN_TIER[p]);
    }
    const heavy = ROULETTE_PATTERNS.filter((p) => ROULETTE_PATTERN_TIER[p] === 'heavy');
    expect(new Set(heavy)).toEqual(new Set(['doublefake', 'jackstop', 'jackslip', 'jackback']));
    const ultra = ROULETTE_PATTERNS.filter((p) => ROULETTE_PATTERN_TIER[p] === 'ultra');
    expect(new Set(ultra)).toEqual(
      new Set([
        'dragon', 'unicorn', 'whale', 'phoenix', 'lion',
        'heartme', 'hearttouch', 'heartbday', 'heartbloom',
      ])
    );
  });

  it('light の尺は従来の 6000ms のまま(要件: 軽いパターンは現行どおり)', () => {
    expect(ROULETTE_SPIN_MS).toBe(6000);
    for (const p of ROULETTE_PATTERNS) {
      if (ROULETTE_PATTERN_TIER[p] === 'light') expect(rouletteSpinMs(p)).toBe(ROULETTE_SPIN_MS);
    }
  });

  it('尺は fast < light < mid < heavy < ultra の単調', () => {
    expect(ROULETTE_SPIN_FAST_MS).toBeLessThan(ROULETTE_SPIN_MS);
    expect(ROULETTE_SPIN_MS).toBeLessThan(ROULETTE_SPIN_MID_MS);
    expect(ROULETTE_SPIN_MID_MS).toBeLessThan(ROULETTE_SPIN_HEAVY_MS);
    expect(ROULETTE_SPIN_HEAVY_MS).toBeLessThan(ROULETTE_SPIN_ULTRA_MS);
    expect(rouletteSpinMs('fast')).toBe(ROULETTE_SPIN_FAST_MS);
    expect(rouletteSpinMs('kick')).toBe(ROULETTE_SPIN_MID_MS);
    expect(rouletteSpinMs('jackstop')).toBe(ROULETTE_SPIN_HEAVY_MS);
    expect(rouletteSpinMs('dragon')).toBe(ROULETTE_SPIN_ULTRA_MS);
  });

  it('安全弁はどのキーでも実尺+確定見せより後', () => {
    for (const key of SPIN_KEYS) {
      expect(rouletteAbortMs(key)).toBeGreaterThan(rouletteSpinMs(key) + rouletteRevealMs(key));
    }
  });

  it('入室ルーレットの最短間隔は最長スピン+確定見せより長い(キュー食い潰し防止の根拠)', () => {
    expect(JOIN_ROULETTE_MIN_GAP_MS).toBeGreaterThan(ROULETTE_SPIN_ULTRA_MS + rouletteRevealMs('dragon'));
  });
});

describe('rouletteRarityBand — レア度の帯分け', () => {
  it('境界: 0.15 以上は common、0.05 以上 0.15 未満は uncommon、0.05 未満は rare', () => {
    expect(rouletteRarityBand(0.15)).toBe('common');
    expect(rouletteRarityBand(0.1499)).toBe('uncommon');
    expect(rouletteRarityBand(0.05)).toBe('uncommon');
    expect(rouletteRarityBand(0.0499)).toBe('rare');
    expect(rouletteRarityBand(0.01)).toBe('rare');
    expect(rouletteRarityBand(1)).toBe('common');
  });

  it('未指定・非有限は null(旧来の一様抽選へ倒す)', () => {
    expect(rouletteRarityBand(undefined)).toBeNull();
    expect(rouletteRarityBand(Number.NaN)).toBeNull();
    expect(rouletteRarityBand(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe('roulettePatternWeights — 信頼度マトリクスの不変条件', () => {
  const TIERS: readonly RouletteTier[] = ['light', 'mid', 'heavy', 'ultra'];

  it('全帯・全パターンの重みが正(ガセあり = 演出は結果を確定も除外もしない)', () => {
    for (const band of ['common', 'uncommon', 'rare'] as const) {
      const w = roulettePatternWeights(ROULETTE_PATTERNS, band);
      expect(w).toHaveLength(ROULETTE_PATTERNS.length);
      for (const x of w) expect(x).toBeGreaterThan(0);
    }
  });

  it('段位の取り分は pool 内の同段位パターン数に依らない(頭割り)', () => {
    for (const band of ['common', 'uncommon', 'rare'] as const) {
      // 全許可でも一部許可でも、pool にいる段位の合計重みは帯テーブルの値のまま。
      for (const pool of [
        ROULETTE_PATTERNS,
        ['slow', 'kick', 'jackstop'] as const,
        ['slow', 'pop', 'kick', 'doublefake', 'jackback'] as const,
      ]) {
        const w = roulettePatternWeights(pool, band);
        for (const tier of TIERS) {
          const sum = pool.reduce((s, p, i) => (ROULETTE_PATTERN_TIER[p] === tier ? s + w[i]! : s), 0);
          if (pool.some((p) => ROULETTE_PATTERN_TIER[p] === tier)) {
            expect(sum).toBeCloseTo(ROULETTE_TIER_WEIGHTS[band][tier], 10);
          } else {
            expect(sum).toBe(0);
          }
        }
      }
    }
  });

  it('band が null なら全て 1(旧来の一様抽選)', () => {
    expect(roulettePatternWeights(ROULETTE_PATTERNS, null)).toEqual(ROULETTE_PATTERNS.map(() => 1));
  });

  it('段位が丸ごと不許可でも残りだけで正の総重量(スピンを止めない)', () => {
    const lightOnly: RoulettePattern[] = ['slow', 'pop'];
    const w = roulettePatternWeights(lightOnly, 'rare');
    expect(w.reduce((s, x) => s + x, 0)).toBeGreaterThan(0);
  });
});

describe('drawRoulettePattern — レア度の条件付け', () => {
  it('同じ rand でも rarity が違えば別のパターンになる(条件付けの実効)', () => {
    // rare 帯(p=0.005)は heavy の取り分 60 で光り物寄り、common 帯(p=0.3)は
    // light 70 で通常変動寄り。累積走査の同じ位置(rand=0.05)が別の山に落ちる。
    expect(drawRoulettePattern(() => 0.05, undefined, 0.005)).toBe('kick');
    expect(drawRoulettePattern(() => 0.05, undefined, 0.3)).toBe('slow');
  });

  it('境界の規約は帯に依らず不変: rand=0 は先頭、rand→1 は末尾の正重み', () => {
    for (const rarity of [undefined, 0.005, 0.08, 0.3]) {
      expect(drawRoulettePattern(() => 0, undefined, rarity)).toBe('slow');
      expect(drawRoulettePattern(() => 0.999999, undefined, rarity)).toBe('heartbloom');
    }
  });

  it('レア出目でも軽いパターンが出得る(逆演出)/ 通常出目でも超激アツが出得る(ガセ)', () => {
    expect(drawRoulettePattern(() => 0, undefined, 0.005)).toBe('slow'); // 大当たりの静かな変動
    expect(drawRoulettePattern(() => 0.999999, undefined, 0.3)).toBe('heartbloom'); // ガセ超激アツ
  });

  it('許可リストとの合成でも rarity は効く(pool 内の段位だけで再正規化)', () => {
    const allowed: RoulettePattern[] = ['pop', 'teeter', 'jackstop'];
    for (const rarity of [undefined, 0.005, 0.3]) {
      for (let i = 0; i < 30; i++) {
        expect(allowed).toContain(drawRoulettePattern(() => i / 30, allowed, rarity));
      }
    }
    // rare 帯では jackstop(heavy 60)が pool の過半を占める。
    expect(drawRoulettePattern(() => 0.5, allowed, 0.005)).toBe('jackstop');
  });

  it('rand() の消費はどの引数の組み合わせでもちょうど1回(fxRand の再現性の前提)', () => {
    const combos: Array<[readonly RoulettePattern[] | undefined, number | undefined]> = [
      [undefined, undefined],
      [undefined, 0.005],
      [undefined, 0.3],
      [[], 0.005],
      [['pop', 'jackstop'], 0.005],
      [['slow'], 0.3],
      [['bogus'] as unknown as RoulettePattern[], 0.08],
    ];
    for (const [allowed, rarity] of combos) {
      let calls = 0;
      const rand = (): number => {
        calls += 1;
        return 0.5;
      };
      drawRoulettePattern(rand, allowed, rarity);
      expect(calls).toBe(1);
    }
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
      if (ROULETTE_PATTERN_TIER[p] === 'ultra') {
        // ultra は最初の動画が画面を覆う瞬間にループ音を閉じる — quiet は
        // clips[0].at と同時刻(veil 規約 46% は「高速域で音だけ消える」対策で、
        // 全画面動画という物理の目隠しには当たらない)。
        expect(t.quietAt, `${p}: quietAt == clips[0].at`).toBeCloseTo(t.clips![0]!.at, 10);
      } else {
        // veil が閉じ切る(46%)前にループ音を落とすパターンは無い —
        // 高速域でカチカチが消えると「もう終わり?」と誤読される。
        expect(t.quietAt).toBeGreaterThanOrEqual(0.46);
      }
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
    // lion のキックは全ステップにあるが、最後の飛び掛かりは near の後。
    for (const p of [
      'kick', 'overrun', 'doublefake', 'jackstop', 'jackback',
      'dragon', 'whale', 'phoenix', 'lion',
      // hearttouch は借り元の unicorn が kickAts 空なので対象外。
      'heartme', 'heartbday', 'heartbloom',
    ] as const) {
      const t = ROULETTE_PATTERN_TIMING[p];
      expect(t.kickAts.at(-1)!).toBeGreaterThan(t.nearAt);
    }
  });
});

describe('ROULETTE_PATTERN_TIMING.clips — 超激アツの動画ウィンドウの不変条件', () => {
  const ULTRA = ROULETTE_PATTERNS.filter((p) => ROULETTE_PATTERN_TIER[p] === 'ultra');
  /**
   * 割合 → 実行時とまったく同じ整数 ms。RouletteFx は Math.round(spinMs * x) で
   * タイマーを積むので、比較もそこへ寄せる。**割合のまま引き算してはいけない** —
   * (0.815-0.795)*24000 = 479.99999999999778 と (0.495-0.475)*24000 = 480.00000000000045 が
   * 同じ設計意図で符号違いに出るため、ちょうど等しい不等式が浮動小数の運任せになる。
   */
  const ms = (ratio: number): number => Math.round(ROULETTE_SPIN_ULTRA_MS * ratio);
  /** 撤去が終わってから次のウィンドウまでに、素のリールが見えている下限(ms)。 */
  const CLIP_CLEAR_MS = 180;

  it('ultra だけが clips を持ち、本数は 2〜4(fast にも無い)', () => {
    for (const p of ROULETTE_PATTERNS) {
      const clips = ROULETTE_PATTERN_TIMING[p].clips;
      if (ROULETTE_PATTERN_TIER[p] === 'ultra') {
        expect(clips, p).toBeDefined();
        expect(clips!.length, p).toBeGreaterThanOrEqual(2);
        expect(clips!.length, p).toBeLessThanOrEqual(4);
      } else {
        expect(clips, p).toBeUndefined();
      }
    }
    expect(ROULETTE_PATTERN_TIMING.fast.clips).toBeUndefined();
  });

  it('ウィンドウは昇順・非重複で、溶暗+撤去+可視の隙間を挟む(マス移動が見える)', () => {
    for (const p of ULTRA) {
      const clips = ROULETTE_PATTERN_TIMING[p].clips!;
      for (const [i, w] of clips.entries()) {
        expect(w.at, `${p}[${i}]`).toBeGreaterThan(0);
        expect(w.out, `${p}[${i}]`).toBeGreaterThan(w.at);
        // 短すぎるウィンドウは一撃の振り付けが入らない(実尺 2 秒強が下限)。
        expect(ms(w.out) - ms(w.at), `${p}[${i}] 実尺`).toBeGreaterThanOrEqual(2160);
        // 最終ウィンドウの後にもフィナーレ(止まりそう → 締めの一撃 → 着地 → 溜め)の
        // 余地を残す。**尺に対する割合で見る** — 定数で焼くと尺が動いた瞬間に
        // 「設計は変わっていないのに落ちる」テストになる(24秒 → 30.9秒で踏んだ)。
        expect(ms(w.out), `${p}[${i}]`).toBeLessThanOrEqual(Math.round(0.93 * ROULETTE_SPIN_ULTRA_MS));
        if (i + 1 < clips.length) {
          // 溶暗 → 撤去(RL_CLIP_REMOVE_MS)→ 素のリールが見える時間、が隙間に収まる。
          expect(ms(clips[i + 1]!.at) - ms(w.out), `${p}[${i}]→[${i + 1}]`).toBeGreaterThanOrEqual(
            RL_CLIP_REMOVE_MS + CLIP_CLEAR_MS
          );
        }
      }
    }
  });

  it('各ウィンドウの一撃(out)のあとに step / kick / near が続く(動画がリールを押す因果)', () => {
    for (const p of ULTRA) {
      const t = ROULETTE_PATTERN_TIMING[p];
      const beats = [...t.stepAts, ...t.kickAts, t.nearAt];
      for (const [i, w] of t.clips!.entries()) {
        const next = beats.filter((b) => b > w.out).sort((a, b) => a - b)[0];
        expect(next, `${p}[${i}] out=${w.out} のあとの拍`).toBeDefined();
        // 間延びさせない(一撃と無関係な動きに見える)。
        expect(ms(next!) - ms(w.out), `${p}[${i}] 一撃→マス移動の間`).toBeLessThanOrEqual(960);
        // **溶暗が終わり切ってから拍が来る** — 動画がマス移動に被ると
        // 「一撃がリールを押した」因果が読めなくなる。今回の設計の要。
        expect(ms(next!) - ms(w.out), `${p}[${i}] 溶暗完了→拍`).toBeGreaterThanOrEqual(
          RL_CLIP_FADE_MS
        );
      }
    }
  });

  it('撤去は溶暗の完了より後、ただし過剰に遅らせない', () => {
    // 0 だとコミット遅延でフェードの尻尾が切られ、「プツッ」が再発する。
    expect(RL_CLIP_REMOVE_MS).toBeGreaterThan(RL_CLIP_FADE_MS);
    expect(RL_CLIP_REMOVE_MS - RL_CLIP_FADE_MS).toBeLessThanOrEqual(200);
  });

  it('quietAt は最初のウィンドウの at(動画が来たら回転音を閉じる)', () => {
    for (const p of ULTRA) {
      const t = ROULETTE_PATTERN_TIMING[p];
      expect(t.quietAt, p).toBeCloseTo(t.clips![0]!.at, 10);
    }
  });

  it('クリップ id はパターン×ウィンドウ数と一致し、形式・一意性が正しい', () => {
    const ids = rouletteUltraClipIds();
    const wantCount = ULTRA.reduce((s, p) => s + ROULETTE_PATTERN_TIMING[p].clips!.length, 0);
    expect(ids).toHaveLength(wantCount);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+-[1-4]$/);
  });
});
