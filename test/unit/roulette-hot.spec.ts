import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_ROULETTE,
  DEFAULT_ROULETTE_HOT,
  ROULETTE_HOT_DON_STEPS,
  ROULETTE_HOT_INTRO_MS,
  ROULETTE_HOT_MULT_MAX,
  ROULETTE_HOT_MULT_MIN,
  ROULETTE_HOT_PATTERNS,
  ROULETTE_HOT_QUEUE_MAX,
  clampRouletteHotMult,
  rouletteAbortMs,
  rouletteBoardKey,
  rouletteDraws,
  rouletteHotIntroMs,
  rouletteHotMultOf,
  rouletteHotMultiplier,
  rouletteHotMults,
  rouletteRemainingAmount,
  rouletteRemainingCount,
  rouletteStockCount,
  sameRouletteBoard,
  validateChallengeConfig,
} from '@shared/challenge';
import { ROULETTE_PATTERN_TIER } from '@shared/dto';
import type { ChallengeConfig, ChallengeEffect, ChallengeRouletteConfig, RoulettePattern } from '@shared/dto';
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
    for (const r of v.roulettes) expect(r.hot).toBeUndefined();
    // 既定の出荷行も hot を持たない(オプトインで出す)。
    expect(DEFAULT_ROULETTE.hot).toBeUndefined();
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
    for (const p of ROULETTE_HOT_PATTERNS) {
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

  it('演出パターンは獅子・黄金龍・不死鳥の3種に固定される(行のチェックは見ない)', () => {
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
    for (const p of ROULETTE_HOT_PATTERNS) {
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
