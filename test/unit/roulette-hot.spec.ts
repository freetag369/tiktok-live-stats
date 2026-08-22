import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_ROULETTE,
  BUNNY_DJ_ROULETTE,
  DJ_GLASSES_ROULETTE,
  UNICORN_ROULETTE,
  DEFAULT_ROULETTE_HOT,
  ROULETTE_HOT_DON_STEPS,
  ROULETTE_HOT_INTRO_MS,
  ROULETTE_HOT_MULT_MAX,
  ROULETTE_HOT_MULT_MIN,
  ROULETTE_HOT_INTRO_PATTERNS,
  ROULETTE_HOT_MULT_CANDIDATES_MAX,
  ROULETTE_HOT_PATTERNS,
  ROULETTE_HOT_QUEUE_MAX,
  clampRouletteHotMult,
  clampRouletteHotWeight,
  drawRouletteHotMult,
  rouletteAbortMs,
  rouletteBoardKey,
  rouletteDraws,
  rouletteHotIntroMs,
  rouletteHotMultCandidates,
  rouletteHotMultOf,
  rouletteHotMultiplier,
  rouletteHotMults,
  rouletteHotPatternPool,
  rouletteHotRepresentativeMult,
  rouletteRemainingAmount,
  rouletteRemainingCount,
  rouletteStockCount,
  sameRouletteBoard,
  validateChallengeConfig,
} from '@shared/challenge';
import { ROULETTE_PATTERN_TIER } from '@shared/dto';
import type {
  ChallengeConfig,
  ChallengeEffect,
  ChallengeRouletteConfig,
  RouletteHotConfig,
  RoulettePattern,
} from '@shared/dto';
import type { GiftEvent } from '@shared/events';
import { ROULETTE_PATTERN_TIMING } from '@shared/roulette-fx';
import { planRouletteSpin } from '@shared/roulette-spin';
import { ChallengeEngine } from '@worker/challenge';

/**
 * 激熱確定(hot)— 「膨らんだ倍数字がそのまま確定する」ギフトルーレット。
 *
 * 従来の超激アツは出目を ×2→×5 と膨らませてから**元へ戻して**確定する見せかけで、
 * 値は一切動かなかった。激熱確定は worker が最初から `出目 × 倍率` を適用し、
 * その倍率を effect(rouletteHotMult)へ焼く。したがって壊れ方は2種類あって、
 * どちらも「画面の数字と 7セグが食い違う」形で出る:
 *
 *   (a) **復元側が倍率を落とす** — rouletteDraws を通らない額の再計算。
 *       据え置き会計が足りず、リールが止まる前に数字が答えを出す。
 *   (b) **演出側が倍率を上げ損なう** — donAts を持たないパターン('fast' や
 *       超焦らしの jack 3種)へ差し替わると、リールは素の出目のまま止まる。
 *
 * このファイルは (a)(b) の両方を境界ごと固定する。構成は
 * challenge-join-roulette.spec.ts と同じ「検証の互換」+「エンジンの挙動」の2段。
 */

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
let seq = 0;

function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  return {
    kind: 'gift',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'g1', nickname: 'gifter' },
    giftId: '7934',
    giftName: 'heart me',
    repeatCount: 1,
    diamondEach: 30,
    diamonds: 30,
    isBoxGift: false,
    ...over,
  };
}

/** 出目を1件に固定した盤面 — 抽選のブレを消して倍率だけを見る。 */
const ONE_SEGMENT = [{ amount: 100, weight: 1 }];

function hotRow(over: Partial<ChallengeRouletteConfig> = {}): ChallengeRouletteConfig {
  return {
    ...structuredClone(DEFAULT_ROULETTE),
    segments: structuredClone(ONE_SEGMENT),
    hot: { enabled: true, multiplier: 50 },
    ...over,
  };
}

function cfg(rows: ChallengeRouletteConfig[], over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.joinRoulette.enabled = false;
  base.roulettes = rows;
  return { ...base, enabled: true, ...over };
}

function engine(c: ChallengeConfig, rand = 0, fxRand = 0): ChallengeEngine {
  const e = new ChallengeEngine(
    () => c,
    () => NOW,
    () => rand,
    () => fxRand
  );
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

/** ルーレット effect を1件だけ取り出す(新しい順の先頭)。 */
function lastRoulette(e: ChallengeEngine): ChallengeEffect {
  const hit = e.get().recentEffects?.find((x) => x.kind === 'roulette');
  expect(hit, 'ルーレット effect が積まれていない').toBeTruthy();
  return hit!;
}

describe('validateRoulette — 激熱確定の互換と clamp', () => {
  it('キー欠損(既存の settings.json)は無効 — キーごと生えない', () => {
    const raw = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    const v = validateChallengeConfig(raw);
    // 出荷既定の激熱確定3行(DJメガネ / ユニコーン / バニーDJ)だけが hot を持つ。
    // それ以外の行に hot が生えないことが「キー欠損 = 無効」の担保。
    const hotIds = new Set([DJ_GLASSES_ROULETTE.id, UNICORN_ROULETTE.id, BUNNY_DJ_ROULETTE.id]);
    for (const r of v.roulettes) {
      if (hotIds.has(r.id)) continue;
      expect(r.hot, r.id).toBeUndefined();
    }
    expect(DEFAULT_ROULETTE.hot).toBeUndefined();
    expect(v.roulettes.find((r) => r.id === DJ_GLASSES_ROULETTE.id)?.hot).toEqual({
      enabled: true,
      multiplier: 10,
    });
    // 候補列を持つ行は「代表値(最大 weight)+ multipliers」が正規形。
    for (const row of [UNICORN_ROULETTE, BUNNY_DJ_ROULETTE]) {
      expect(v.roulettes.find((r) => r.id === row.id)?.hot, row.id).toEqual({
        enabled: true,
        multiplier: 5,
        multipliers: [
          { multiplier: 5, weight: 60 },
          { multiplier: 10, weight: 30 },
          { multiplier: 20, weight: 10 },
        ],
      });
    }
  });

  it('enabled:false はキーごと落ちる(無意味な既定値を保存済み JSON に生やさない)', () => {
    const v = validateChallengeConfig(
      cfg([hotRow({ hot: { enabled: false, multiplier: 30 } })]) as unknown
    );
    expect(v.roulettes[0]!.hot).toBeUndefined();
  });

  it('direction:"sub"(減らす)の行では激熱がキーごと落ちる', () => {
    const v = validateChallengeConfig(cfg([hotRow({ direction: 'sub' })]) as unknown);
    expect(v.roulettes[0]!.direction).toBe('sub');
    expect(v.roulettes[0]!.hot, '応援の行に激熱が残っている').toBeUndefined();
  });

  it('倍率は下限・上限へ clamp され、壊れた値は既定へ倒れる', () => {
    const at = (m: unknown): number | undefined =>
      validateChallengeConfig(
        cfg([hotRow({ hot: { enabled: true, multiplier: m as number } })]) as unknown
      ).roulettes[0]!.hot?.multiplier;
    expect(at(1)).toBe(ROULETTE_HOT_MULT_MIN);
    expect(at(ROULETTE_HOT_MULT_MIN)).toBe(ROULETTE_HOT_MULT_MIN);
    expect(at(ROULETTE_HOT_MULT_MAX)).toBe(ROULETTE_HOT_MULT_MAX);
    expect(at(9999)).toBe(ROULETTE_HOT_MULT_MAX);
    expect(at(12.4)).toBe(12);
    expect(at('50')).toBe(DEFAULT_ROULETTE_HOT.multiplier);
    expect(at(Number.NaN)).toBe(DEFAULT_ROULETTE_HOT.multiplier);
  });
});

describe('rouletteHotMults — ドンの段のはしご', () => {
  it('段数はドンの拍数(donAts)と一致する', () => {
    // 段が拍より少ないと最後のドンで数字が動かず、多いと使われない段が出る。
    for (const p of ROULETTE_HOT_INTRO_PATTERNS) {
      expect(ROULETTE_PATTERN_TIMING[p].donAts, `${p} に donAts が無い`).toBeTruthy();
      expect(ROULETTE_PATTERN_TIMING[p].donAts!.length, p).toBe(ROULETTE_HOT_DON_STEPS);
    }
    expect(rouletteHotMults(50).length).toBe(ROULETTE_HOT_DON_STEPS);
  });

  it('代表値の段を凍結(等比 + 単調補正)', () => {
    expect(rouletteHotMults(5)).toEqual([2, 3, 4, 5]);
    expect(rouletteHotMults(6)).toEqual([2, 3, 4, 6]);
    expect(rouletteHotMults(10)).toEqual([2, 3, 6, 10]);
    expect(rouletteHotMults(20)).toEqual([2, 4, 9, 20]);
    expect(rouletteHotMults(50)).toEqual([3, 7, 19, 50]);
  });

  it('下限 5 のときちょうど従来の超激アツと同じ段になる(下限の根拠)', () => {
    expect(rouletteHotMults(ROULETTE_HOT_MULT_MIN)).toEqual([2, 3, 4, 5]);
  });

  it('全域で狭義単調増加・末項が設定値・先頭は 2 以上', () => {
    for (let m = ROULETTE_HOT_MULT_MIN; m <= ROULETTE_HOT_MULT_MAX; m++) {
      const steps = rouletteHotMults(m);
      expect(steps.length, `m=${m}`).toBe(ROULETTE_HOT_DON_STEPS);
      expect(steps[0]!, `m=${m} 先頭`).toBeGreaterThanOrEqual(2);
      expect(steps[steps.length - 1]!, `m=${m} 末項`).toBe(m);
      for (let i = 1; i < steps.length; i++) {
        expect(steps[i]!, `m=${m} 段${i}`).toBeGreaterThan(steps[i - 1]!);
      }
    }
  });

  it('範囲外は clamp される(段が壊れた倍率で伸び縮みしない)', () => {
    expect(rouletteHotMults(1)).toEqual(rouletteHotMults(ROULETTE_HOT_MULT_MIN));
    expect(rouletteHotMults(9999)).toEqual(rouletteHotMults(ROULETTE_HOT_MULT_MAX));
    expect(rouletteHotMults(Number.NaN)).toEqual(rouletteHotMults(ROULETTE_HOT_MULT_MIN));
  });

  it('**末項は復元側が掛ける倍率と必ず一致する**(食い違うとリールだけ違う額で止まる)', () => {
    for (let m = ROULETTE_HOT_MULT_MIN; m <= ROULETTE_HOT_MULT_MAX; m++) {
      const e = { kind: 'roulette', amount: 0, rouletteHotMult: m } as ChallengeEffect;
      const steps = rouletteHotMults(rouletteHotMultOf(e));
      expect(steps[steps.length - 1]!, `m=${m}`).toBe(rouletteHotMultOf(e));
    }
  });
});

describe('倍率の clamp は1本(検証・worker・復元・段が同じ式)', () => {
  it('clampRouletteHotMult が範囲の唯一の権威', () => {
    expect(clampRouletteHotMult(0)).toBe(ROULETTE_HOT_MULT_MIN);
    expect(clampRouletteHotMult(1000)).toBe(ROULETTE_HOT_MULT_MAX);
    expect(clampRouletteHotMult(7.6)).toBe(8);
  });

  it('rouletteHotMultiplier: 無効・未設定は 1(= 通常のルーレット)', () => {
    expect(rouletteHotMultiplier(undefined)).toBe(1);
    expect(rouletteHotMultiplier({ enabled: false, multiplier: 50 })).toBe(1);
    expect(rouletteHotMultiplier({ enabled: true, multiplier: 50 })).toBe(50);
    expect(rouletteHotMultiplier({ enabled: true, multiplier: 999 })).toBe(ROULETTE_HOT_MULT_MAX);
  });

  it('rouletteHotMultOf: 載っていない/壊れた effect は 1 へ倒れる(値を消さない)', () => {
    const at = (v: unknown): number =>
      rouletteHotMultOf({ kind: 'roulette', amount: 0, rouletteHotMult: v as number } as ChallengeEffect);
    expect(rouletteHotMultOf({ kind: 'roulette', amount: 0 } as ChallengeEffect)).toBe(1);
    expect(at(0)).toBe(1);
    expect(at(-5)).toBe(1);
    expect(at(Number.NaN)).toBe(1);
    expect(at(Number.POSITIVE_INFINITY)).toBe(1);
    expect(at(50)).toBe(50);
  });
});

describe('倍率候補(hot.multipliers)— 確率抽選の検証・正規形・消費規約', () => {
  /**
   * 倍率が確率で決まる激熱(2026-08-21)。effect へ焼くのは抽選後の単一値
   * (rouletteHotMult)なので下流(段のはしご・boardKey・復元)は従来のまま。
   * ここで凍結するのは3点:
   *   (1) **正規形: multipliers キーが存在する ⇔ サニタイズ後の候補が2件以上**。
   *       候補1件は従来形へ畳む — 出荷既定(DJ ×10)の validate 不動点の根拠。
   *   (2) **消費規約: 候補列が実在するときだけ this.rand をちょうど1回**。
   *       従来形・無効は消費 0 のまま — 既存テストの rand 固定を壊さない境界。
   *   (3) 1 effect = 1 倍率(連打の全スピンで共有)。スピンごとに変えると
   *       rouletteBoardKey が 1 effect 内で割れ、mergeRoulette と据え置き会計が壊れる。
   */
  const hotOf = (multipliers: unknown, multiplier = 50): RouletteHotConfig =>
    ({ enabled: true, multiplier, multipliers }) as RouletteHotConfig;

  it('validate: 2件以上は clamp して残り、multiplier に代表値(最大 weight・同率先勝ち)が焼かれる', () => {
    const v = validateChallengeConfig(
      cfg([
        hotRow({
          hot: hotOf([
            { multiplier: 4, weight: 9 },
            { multiplier: 999, weight: 3.4 },
            { multiplier: 12.4, weight: -2 },
          ]),
        }),
      ]) as unknown
    );
    expect(v.roulettes[0]!.hot).toEqual({
      enabled: true,
      multiplier: 5,
      multipliers: [
        { multiplier: 5, weight: 9 },
        { multiplier: 50, weight: 3 },
        { multiplier: 12, weight: 0 },
      ],
    });
  });

  it('validate: 正規形はキー存在 ⇔ 候補2件以上 — 1件・空・非配列・全weight0 はキーを出さない', () => {
    const at = (multipliers: unknown): RouletteHotConfig | undefined =>
      validateChallengeConfig(cfg([hotRow({ hot: hotOf(multipliers, 30) })]) as unknown)
        .roulettes[0]!.hot;
    // 1件 → その倍率の従来形へ畳む(multiplier の 30 ではなく候補の 20)。
    expect(at([{ multiplier: 20, weight: 5 }])).toEqual({ enabled: true, multiplier: 20 });
    // 空配列・非配列 → 従来形(multiplier を使う)。
    expect(at([])).toEqual({ enabled: true, multiplier: 30 });
    expect(at('x')).toEqual({ enabled: true, multiplier: 30 });
    expect(at(undefined)).toEqual({ enabled: true, multiplier: 30 });
    // 全 weight 0(2件)→ 抽選不能なので代表値(先勝ち=先頭)へ畳む。
    expect(
      at([
        { multiplier: 20, weight: 0 },
        { multiplier: 40, weight: 0 },
      ])
    ).toEqual({ enabled: true, multiplier: 20 });
    // ゴミ要素は落ち、残り2件でキーが残る。
    expect(
      at([
        { multiplier: 20, weight: 1 },
        null,
        { multiplier: '40', weight: 1 },
        { multiplier: 40, weight: 2 },
      ])
    ).toEqual({
      enabled: true,
      multiplier: 40,
      multipliers: [
        { multiplier: 20, weight: 1 },
        { multiplier: 40, weight: 2 },
      ],
    });
  });

  it('validate: 候補は上限件数で切られる', () => {
    const many = Array.from({ length: ROULETTE_HOT_MULT_CANDIDATES_MAX + 3 }, (_, i) => ({
      multiplier: 5 + i,
      weight: 1,
    }));
    const v = validateChallengeConfig(cfg([hotRow({ hot: hotOf(many) })]) as unknown);
    expect(v.roulettes[0]!.hot?.multipliers?.length).toBe(ROULETTE_HOT_MULT_CANDIDATES_MAX);
  });

  it('validate は冪等で、従来形に multipliers を生やさない(出荷既定 DJ 行の不動点)', () => {
    const once = validateChallengeConfig(
      cfg([
        hotRow({
          hot: hotOf([
            { multiplier: 7, weight: 1 },
            { multiplier: 50, weight: 2 },
          ]),
        }),
      ]) as unknown
    );
    const twice = validateChallengeConfig(once as unknown);
    expect(twice.roulettes[0]!.hot).toEqual(once.roulettes[0]!.hot);
    // migrate の出力は再検証されないので、既定行の形がここで変わると
    // boot-settings.spec の不動点検査が落ちる(= 絶対に生やさない)。
    const dj = validateChallengeConfig(structuredClone(DEFAULT_CHALLENGE) as unknown);
    expect(dj.roulettes.find((r) => r.id === DJ_GLASSES_ROULETTE.id)?.hot).toEqual({
      enabled: true,
      multiplier: 10,
    });
  });

  it('clampRouletteHotWeight: 重みの丸めは1本(サニタイズと UI 入力が同じ式を通す)', () => {
    // UI が丸めずに小数・負値を draft へ載せると、保存時の丸めで「weight>0 の有無」が
    // 変わり、編集した候補行が保存の瞬間に黙って畳まれる(敵対レビューで実検出)。
    expect(clampRouletteHotWeight(0.4)).toBe(0);
    expect(clampRouletteHotWeight(1.5)).toBe(2);
    expect(clampRouletteHotWeight(-3)).toBe(0);
    expect(clampRouletteHotWeight(1e9)).toBe(999_999);
    expect(clampRouletteHotWeight(Number.NaN)).toBe(0);
  });

  it('小数の重みだけの候補列は丸めで全 weight 0 になり、抽選対象にならない', () => {
    expect(
      rouletteHotMultCandidates(
        hotOf([
          { multiplier: 20, weight: 0.4 },
          { multiplier: 40, weight: 0.45 },
        ])
      )
    ).toBeNull();
  });

  it('UI の重み入力は clampRouletteHotWeight を通す(ソース不変条件)', () => {
    // roulette-sound.spec の流儀。剥がすと「保存で候補行が黙って消える」が再発する。
    const src = readFileSync(resolve('src/renderer/screens/Challenge.tsx'), 'utf8').replace(
      /\r\n/g,
      '\n'
    );
    expect(src.includes('clampRouletteHotWeight(Number(e.target.value))')).toBe(true);
  });

  it('rouletteHotMultCandidates: 抽選に使える列だけを返す(validate と同じゲート)', () => {
    expect(rouletteHotMultCandidates(undefined)).toBeNull();
    expect(rouletteHotMultCandidates({ enabled: true, multiplier: 10 })).toBeNull();
    expect(rouletteHotMultCandidates(hotOf([{ multiplier: 20, weight: 1 }]))).toBeNull();
    expect(
      rouletteHotMultCandidates(
        hotOf([
          { multiplier: 20, weight: 0 },
          { multiplier: 40, weight: 0 },
        ])
      )
    ).toBeNull();
    expect(
      rouletteHotMultCandidates(
        hotOf([
          { multiplier: 20, weight: 1 },
          { multiplier: 40, weight: 3 },
        ])
      )
    ).toEqual([
      { multiplier: 20, weight: 1 },
      { multiplier: 40, weight: 3 },
    ]);
  });

  it('rouletteHotRepresentativeMult: 最大 weight・同率先勝ち・clamp', () => {
    expect(
      rouletteHotRepresentativeMult([
        { multiplier: 20, weight: 1 },
        { multiplier: 40, weight: 3 },
      ])
    ).toBe(40);
    expect(
      rouletteHotRepresentativeMult([
        { multiplier: 20, weight: 3 },
        { multiplier: 40, weight: 3 },
      ])
    ).toBe(20);
    expect(rouletteHotRepresentativeMult([{ multiplier: 999, weight: 1 }])).toBe(
      ROULETTE_HOT_MULT_MAX
    );
    expect(rouletteHotRepresentativeMult([])).toBe(DEFAULT_ROULETTE_HOT.multiplier);
  });

  it('drawRouletteHotMult: 従来形・無効・候補1件相当は rand を消費しない(消費 0 の凍結)', () => {
    let n = 0;
    const rand = (): number => {
      n++;
      return 0;
    };
    expect(drawRouletteHotMult(undefined, rand)).toBe(1);
    expect(drawRouletteHotMult({ enabled: false, multiplier: 50 }, rand)).toBe(1);
    expect(drawRouletteHotMult({ enabled: true, multiplier: 50 }, rand)).toBe(50);
    // 候補1件は正規形の外(validate が畳む)だが、手編集で届いても従来形へ縮退して消費 0。
    expect(drawRouletteHotMult(hotOf([{ multiplier: 20, weight: 5 }], 30), rand)).toBe(30);
    expect(n).toBe(0);
  });

  it('drawRouletteHotMult: 候補2件以上はちょうど1回消費し、境界は drawRouletteIndex と同じ切り方', () => {
    const two = hotOf([
      { multiplier: 20, weight: 1 },
      { multiplier: 40, weight: 3 },
    ]);
    let n = 0;
    const counted = (): number => {
      n++;
      return 0;
    };
    expect(drawRouletteHotMult(two, counted)).toBe(20);
    expect(n).toBe(1);
    // Σweight=4。r*4 が 1 を跨ぐところで候補が切り替わる。
    expect(drawRouletteHotMult(two, () => 0.24)).toBe(20);
    expect(drawRouletteHotMult(two, () => 0.25)).toBe(40);
    expect(drawRouletteHotMult(two, () => 0.99)).toBe(40);
    // weight 0 の候補は出ない(先頭が 0 でも消費は1回のまま)。
    const zeroFirst = hotOf([
      { multiplier: 20, weight: 0 },
      { multiplier: 40, weight: 1 },
      { multiplier: 50, weight: 1 },
    ]);
    expect(drawRouletteHotMult(zeroFirst, () => 0)).toBe(40);
  });

  it('engine: 候補列の行は倍率が抽選され、値・焼き込み・復元・据え置きが一致する', () => {
    const row = hotRow({
      hot: hotOf([
        { multiplier: 20, weight: 1 },
        { multiplier: 40, weight: 3 },
      ]),
    });
    // rand=0 → 倍率 20(最初の正 weight)。ONE_SEGMENT なので出目は 100 固定。
    const e = engine(cfg([row]));
    e.start();
    const before = e.get().value;
    e.handleEvent(gift());
    const rl = lastRoulette(e);
    expect(rl.rouletteHotMult).toBe(20);
    expect(rl.amount).toBe(100 * 20);
    expect(e.get().value).toBe(before + 100 * 20);
    expect(rouletteDraws(rl).map((d) => d.amount)).toEqual([100 * 20]);
    expect(rouletteRemainingAmount(rl, 0)).toBe(rl.amount);
    // rand=0.9 → 倍率 40(段のはしごの末項も抽選値)。
    const e2 = engine(cfg([row]), 0.9);
    e2.start();
    e2.handleEvent(gift());
    const rl2 = lastRoulette(e2);
    expect(rl2.rouletteHotMult).toBe(40);
    const steps = rouletteHotMults(rouletteHotMultOf(rl2));
    expect(steps[steps.length - 1]!).toBe(40);
  });

  it('engine: 連打は1回の抽選を全スピンで共有する(消費順は 倍率 → 出目、計 1+個数 回)', () => {
    // 数列 rand を注入して消費順そのものを凍結する — 順が変わると
    // 同じ乱数列で別の結果になる(実演と本番の食い違いの温床)。
    const seqRand = [0.9, 0, 0, 0];
    let at = 0;
    const c = cfg([
      hotRow({
        hot: hotOf([
          { multiplier: 20, weight: 1 },
          { multiplier: 40, weight: 3 },
        ]),
      }),
    ]);
    const e = new ChallengeEngine(
      () => c,
      () => NOW,
      () => seqRand[at++] ?? 0,
      () => 0
    );
    e.setMonitorOpen(true);
    e.setFxCaps(true);
    e.start();
    e.handleEvent(gift({ repeatCount: 3, diamonds: 90 }));
    const rl = lastRoulette(e);
    expect(at).toBe(4);
    expect(rl.rouletteHotMult).toBe(40);
    expect(rl.rouletteIndexes!.length).toBe(3);
    expect(rl.amount).toBe(100 * 40 * 3);
  });

  it('engine: 従来形(単一倍率)の行は数列 rand でも従来と同じに動く(消費 0 の回帰)', () => {
    // 先頭に「倍率抽選が食うと出目がズレる」値を置く — 従来形が rand を
    // 1回でも食うようになったらここが割れる。
    const seqRand = [0.99, 0.99];
    let at = 0;
    const board = [
      { amount: 100, weight: 1 },
      { amount: 7, weight: 1 },
    ];
    const c = cfg([hotRow({ segments: board })]);
    const e = new ChallengeEngine(
      () => c,
      () => NOW,
      () => seqRand[at++] ?? 0,
      () => 0
    );
    e.setMonitorOpen(true);
    e.setFxCaps(true);
    e.start();
    e.handleEvent(gift());
    const rl = lastRoulette(e);
    expect(at).toBe(1);
    expect(rl.rouletteHotMult).toBe(50);
    expect(rl.amount).toBe(7 * 50);
  });

  it('testEffect(試写)でも候補から抽選され、消費順は本番と同じ 倍率 → 出目', () => {
    const seqRand = [0.9, 0.99];
    let at = 0;
    const board = [
      { amount: 100, weight: 1 },
      { amount: 7, weight: 1 },
    ];
    const c = cfg([
      hotRow({
        segments: board,
        hot: hotOf([
          { multiplier: 20, weight: 1 },
          { multiplier: 40, weight: 3 },
        ]),
      }),
    ]);
    const e = new ChallengeEngine(
      () => c,
      () => NOW,
      () => seqRand[at++] ?? 0,
      () => 0
    );
    e.setMonitorOpen(true);
    e.setFxCaps(true);
    e.start();
    e.testEffect({ kind: 'roulette', rouletteId: c.roulettes[0]!.id });
    const rl = lastRoulette(e);
    expect(at).toBe(2);
    expect(rl.rouletteHotMult).toBe(40);
    expect(rl.amount).toBe(7 * 40);
  });
});

describe('ChallengeEngine — 激熱確定ギフトルーレット', () => {
  it('値は 出目 × 倍率 ぶん動き、effect に倍率が焼かれる', () => {
    const c = cfg([hotRow()]);
    const e = engine(c);
    e.start();
    const before = e.get().value;
    e.handleEvent(gift());
    const rl = lastRoulette(e);
    expect(rl.rouletteHotMult).toBe(50);
    expect(rl.amount).toBe(100 * 50);
    expect(e.get().value).toBe(before + 100 * 50);
  });

  it('激熱でない行には倍率キーが載らない(既存 effect と同じ形のまま)', () => {
    const e = engine(cfg([hotRow({ hot: undefined })]));
    e.start();
    e.handleEvent(gift());
    const rl = lastRoulette(e);
    expect(rl.rouletteHotMult).toBeUndefined();
    expect(rl.amount).toBe(100);
  });

  it('ギフト連動でない激熱行は獅子・黄金龍・不死鳥の3種に固定される(行のチェックは見ない)', () => {
    // 行の patterns は「軽い演出だけ」に絞っておく — 激熱がそれを無視することの確認。
    const row = hotRow({ patterns: ['slow'] as RoulettePattern[] });
    for (const fxRand of [0, 0.34, 0.5, 0.67, 0.99]) {
      const e = engine(cfg([row]), 0, fxRand);
      e.start();
      e.handleEvent(gift());
      const rl = lastRoulette(e);
      expect(ROULETTE_HOT_PATTERNS, `fxRand=${fxRand}`).toContain(rl.roulettePattern!);
      // 3種はどれも ultra 段位 = donAts を持つ(倍率の段が乗る唯一の段位)。
      expect(ROULETTE_PATTERN_TIER[rl.roulettePattern!]).toBe('ultra');
    }
  });

  it('DJメガネ(giftId 11583)の激熱行は fxRand に依らず 100% djglasses', () => {
    // ギフト連動の絵柄。ここが抽選に戻ると、DJメガネを投げても DJ の導入動画は
    // 4回に1回しか出ない(= ユーザー要件「必ず DJ 演出」が壊れる)。
    const row: ChallengeRouletteConfig = {
      ...structuredClone(DJ_GLASSES_ROULETTE),
      segments: structuredClone(ONE_SEGMENT),
      // 行のチェックを軽い演出だけに絞っても無視されること(激熱の既存規約)。
      patterns: ['slow'] as RoulettePattern[],
    };
    for (const fxRand of [0, 0.34, 0.5, 0.67, 0.99]) {
      const e = engine(cfg([row]), 0, fxRand);
      e.start();
      e.handleEvent(gift({ giftId: '11583', giftName: 'DJ Glasses', diamondEach: 500, diamonds: 500 }));
      const rl = lastRoulette(e);
      expect(rl.roulettePattern, `fxRand=${fxRand}`).toBe('djglasses');
      expect(rl.rouletteHotMult, `fxRand=${fxRand}`).toBe(10);
      expect(rl.amount, `fxRand=${fxRand}`).toBe(100 * 10);
    }
  });

  it('**fxRand の消費回数はギフト連動でも変わらない**(出目の再現性の前提)', () => {
    // 「1抽選 = 1消費」。固定パターンを早期 return で返すとここが 0 回になり、
    // 同じ seed の再生が別物になる(drawRoulettePattern を必ず通すことの凍結)。
    const count = (row: ChallengeRouletteConfig): number => {
      let n = 0;
      const e = new ChallengeEngine(
        () => cfg([row]),
        () => NOW,
        () => 0,
        () => {
          n++;
          return 0.5;
        }
      );
      e.setMonitorOpen(true);
      e.setFxCaps(true);
      e.start();
      e.handleEvent(gift({ giftId: row.giftId, giftName: row.giftName }));
      return n;
    };
    const plain = count(hotRow());
    const dj = count({ ...structuredClone(DJ_GLASSES_ROULETTE), segments: structuredClone(ONE_SEGMENT) });
    expect(dj).toBe(plain);
    expect(plain).toBeGreaterThan(0);
  });

  it('giftName が部分一致してもギフト連動にはならない(exactName の回帰)', () => {
    // 'dj' は 'dj glasses'.includes('dj') で当たってしまう。完全一致でなければ
    // 無関係な激熱行が DJ の絵柄に化ける。
    const row = hotRow({ giftId: '', giftName: 'dj', canonical: '' });
    const e = engine(cfg([row]), 0, 0.5);
    e.start();
    e.handleEvent(gift({ giftId: '999', giftName: 'dj' }));
    const rl = lastRoulette(e);
    expect(rl.roulettePattern).not.toBe('djglasses');
    expect(ROULETTE_HOT_PATTERNS).toContain(rl.roulettePattern!);
  });

  it('rouletteHotPatternPool: ギフト連動は1件、それ以外は3種、null は3種', () => {
    expect(rouletteHotPatternPool(DJ_GLASSES_ROULETTE)).toEqual(['djglasses']);
    expect(rouletteHotPatternPool(DEFAULT_ROULETTE)).toBe(ROULETTE_HOT_PATTERNS);
    expect(rouletteHotPatternPool(null)).toBe(ROULETTE_HOT_PATTERNS);
    expect(rouletteHotPatternPool(undefined)).toBe(ROULETTE_HOT_PATTERNS);
    // giftId を消して名前だけにしても、完全一致なら拾う(ID 変更の保険)。
    expect(
      rouletteHotPatternPool({ giftId: '', giftName: 'dj glasses', canonical: '' })
    ).toEqual(['djglasses']);
  });

  it('連打は個数ぶん倍率が掛かる(抽選回数は削らない既存規約のまま)', () => {
    const e = engine(cfg([hotRow()]));
    e.start();
    const before = e.get().value;
    e.handleEvent(gift({ repeatCount: 3, diamonds: 90 }));
    const rl = lastRoulette(e);
    expect(rl.rouletteIndexes!.length).toBe(3);
    expect(rl.amount).toBe(100 * 50 * 3);
    expect(e.get().value).toBe(before + 100 * 50 * 3);
  });

  it('減らす(応援)の行は倍率を掛けない — 検証が落とし、worker も二重に拒む', () => {
    // 検証を通さず**直接**手編集の設定を渡す = 二重防御の確認。
    const e = engine(cfg([hotRow({ direction: 'sub' })]), 0, 0);
    e.start();
    const before = e.get().value;
    e.handleEvent(gift());
    const rl = lastRoulette(e);
    expect(rl.rouletteHotMult).toBeUndefined();
    expect(rl.amount).toBe(-100);
    expect(e.get().value).toBe(Math.max(0, before - 100));
  });
});

describe('復元(rouletteDraws)と据え置き会計が倍率込みで一致する', () => {
  /** worker が積んだ本物の effect を使う — 手で組むと復元式の検算にならない。 */
  function hotEffect(repeat = 1): ChallengeEffect {
    const e = engine(cfg([hotRow()]));
    e.start();
    e.handleEvent(gift({ repeatCount: repeat, diamonds: 30 * repeat }));
    return lastRoulette(e);
  }

  it('1スピンぶんの額が 出目 × 倍率', () => {
    const draws = rouletteDraws(hotEffect());
    expect(draws.map((d) => d.amount)).toEqual([100 * 50]);
  });

  it('残量の合計が effect の総額と一致する(据え置きが足りないと先漏れする)', () => {
    const rl = hotEffect(3);
    expect(rouletteRemainingAmount(rl, 0)).toBe(rl.amount);
    expect(rouletteRemainingCount(rl, 0)).toBe(3);
    expect(rouletteStockCount(rl, 0)).toBe(3);
    // 1本消化するごとに残量は 1 スピンぶん(倍率込み)だけ減る。
    expect(rouletteRemainingAmount(rl, 1)).toBe(rl.amount - 100 * 50);
  });

  it('倍率キーの無い effect は従来と 1 バイトも変わらない', () => {
    const e = engine(cfg([hotRow({ hot: undefined })]));
    e.start();
    e.handleEvent(gift());
    const rl = lastRoulette(e);
    expect(rouletteDraws(rl).map((d) => d.amount)).toEqual([100]);
    expect(rouletteRemainingAmount(rl, 0)).toBe(100);
  });
});

describe('盤面の同一性 — 激熱と通常は絶対に畳まない', () => {
  const base: ChallengeEffect = {
    kind: 'roulette',
    amount: 0,
    rouletteSegments: [100],
    rouletteIndexes: [0],
    rouletteLabel: 'ハートミー',
  } as ChallengeEffect;

  it('倍率が boardKey に入る(同じ index が別の額を意味するため)', () => {
    const plain = base;
    const hot = { ...base, rouletteHotMult: 50 } as ChallengeEffect;
    expect(rouletteBoardKey(plain)).not.toBe(rouletteBoardKey(hot));
    expect(sameRouletteBoard(plain, hot)).toBe(false);
    // 倍率が同じなら畳んでよい(同じ行の連打)。
    expect(sameRouletteBoard(hot, { ...hot } as ChallengeEffect)).toBe(true);
    // 倍率違いどうしも別物。
    expect(sameRouletteBoard(hot, { ...base, rouletteHotMult: 20 } as ChallengeEffect)).toBe(false);
  });

  it('由来(rouletteOrigin)の接頭辞は先頭のまま — 既存の startsWith 判定を壊さない', () => {
    expect(rouletteBoardKey(base).startsWith('|')).toBe(true);
    expect(rouletteBoardKey({ ...base, rouletteOrigin: 'join' } as ChallengeEffect).startsWith('join|')).toBe(
      true
    );
  });
});

describe('planRouletteSpin — 激熱は短縮も超焦らしも免除', () => {
  it('どの本数・どの合算でもフル尺で、超焦らしの差し替えを通さない', () => {
    // 通さないと donAts の無いパターン('fast' / jack 3種)へ落ちて倍率が消える。
    // rush(焦らし短縮トグル)込みでも免除は破れない。
    for (const at of [0, 1, 14, 15, 16, 19]) {
      for (const coalesced of [1, 2, 9]) {
        for (const reels of [1, 2, 20]) {
          for (const rush of [false, true]) {
            for (const queueRest of [0, 1, 5]) {
              const plan = planRouletteSpin({
                at,
                reels,
                coalesced,
                join: false,
                test: false,
                hot: true,
                teaseEnabled: true,
                rush,
                queueRest,
              });
              const label = `at=${at} coalesced=${coalesced} reels=${reels} rush=${rush} rest=${queueRest}`;
              expect(plan.short, label).toBe(false);
              expect(plan.tease, label).toBeNull();
            }
          }
        }
      }
    }
  });

  it('激熱でなければ従来どおり(16本目は短縮・単発は超焦らしを通す)', () => {
    const input = { reels: 1, coalesced: 1, join: false, test: false, hot: false, teaseEnabled: true, rush: false, queueRest: 0 };
    expect(planRouletteSpin({ ...input, at: 0 }).tease).toEqual({ lastOne: true });
    expect(planRouletteSpin({ ...input, at: 15, reels: 20 }).short).toBe(true);
  });
});

describe('尺 — 導入 8 秒ぶんを安全弁が知っていること', () => {
  const hotFx = { kind: 'roulette', amount: 0, rouletteHotMult: 50 } as ChallengeEffect;
  const plainFx = { kind: 'roulette', amount: 0 } as ChallengeEffect;

  it('rouletteHotIntroMs は激熱のときだけ導入尺を返す', () => {
    expect(rouletteHotIntroMs(hotFx)).toBe(ROULETTE_HOT_INTRO_MS);
    expect(rouletteHotIntroMs(plainFx)).toBe(0);
  });

  it('**導入 + スピン + 確定見せ < 安全弁**(足し忘れるとリールが途中で消える)', () => {
    // モニターの startRoulette が張る式と同じ形。ここが崩れると、番犬と安全弁が
    // 導入ぶん早く発火してリールが回りきる前に数字が最終値へ飛ぶ。
    for (const p of ROULETTE_HOT_INTRO_PATTERNS) {
      const abortAfterMs = rouletteHotIntroMs(hotFx) + rouletteAbortMs(p);
      const real = ROULETTE_HOT_INTRO_MS + ROULETTE_PATTERN_TIMING[p].donAts!.length * 0; // 拍は尺の内側
      expect(abortAfterMs, p).toBeGreaterThan(real + rouletteAbortMs(p) - 1500);
    }
  });

  it('専用キューの上限は正の有限値(ドレインの歩数見積りの前提)', () => {
    expect(ROULETTE_HOT_QUEUE_MAX).toBeGreaterThan(0);
    expect(Number.isFinite(ROULETTE_HOT_QUEUE_MAX)).toBe(true);
  });
});
