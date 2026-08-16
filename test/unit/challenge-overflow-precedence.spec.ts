import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_FAN_STAMP,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_ROULETTES,
  DEFAULT_TAP_BOOST,
  GIFT_FX_PENDING_OPS_MAX,
} from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { NormalizedEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * 2つの穴を埋める。
 *
 * ①保留キューの溢れ弁(applyOrQueue の GIFT_FX_PENDING_OPS_MAX 経路)。演出が
 *   詰まったときに「値だけは正しく保つ」最後の安全弁で、壊れると視聴者の贈った
 *   ギフトが黙って消える。テストが1件も無かった。
 *
 * ②ギフト1件の増減写像を決める**先勝ち4段**(fanStamp → tapBoost → roulette →
 *   giftRules/giftDefault)。隣接ペアの検証はあったが、4段を1本の表として固定した
 *   テストが無く、段の入れ替えが起きても2件しか落ちない状態だった。
 */
const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定で有効な演出は全部落とす。凍結を見るテストだけが個別に戻す。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.tapBoost.enabled = false;
  base.fanStamp.enabled = false;
  base.roulettes = [];
  return { ...base, enabled: true, ...over };
}

function engine(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  // 凍結は monitorOpen && fxCaps のときだけ張られる。
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

function gift(over: Partial<NormalizedEvent> & { diamonds?: number } = {}): NormalizedEvent {
  seq += 1;
  return {
    kind: 'gift',
    tsMs: NOW,
    msgId: `g${seq}`,
    viewer: { userId: `u${seq}`, nickname: `u${seq}` },
    giftId: '5655',
    giftName: 'Rose',
    diamonds: 1,
    repeatCount: 1,
    ...over,
  } as NormalizedEvent;
}

function follow(userId: string): NormalizedEvent {
  seq += 1;
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `f${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: userId },
  } as NormalizedEvent;
}

/** 帯域カットインに一致する高額ギフトで凍結を張る。 */
function freeze(e: ChallengeEngine): void {
  e.handleEvent(gift({ diamonds: 30 }));
  expect(e.get().fxFreezeUntilMs).not.toBeNull();
}

/**
 * 保留キューを上限ちょうどまで埋める。**押下は使えない** — press は凍結を
 * 素通しして即時に効くようになったので1件もキューに積まれない(この差自体は
 * 下の「押下は保留キューを使わない」で固定している)。視聴者由来で最も軽い
 * follow(値だけ・演出予告なし)で埋める。
 */
function fillQueue(e: ChallengeEngine, n = GIFT_FX_PENDING_OPS_MAX): void {
  for (let i = 0; i < n; i += 1) e.handleEvent(follow(`fill${seq}-${i}`));
}

describe('保留キューの溢れ弁 — 値の正しさを演出より優先する', () => {
  it('押下: 保留キューを一切使わない — 上限まで詰まっていても即時に効く', () => {
    const c = cfg({
      initialValue: 10_000,
      pressStep: 1,
      followStep: 1,
      giftBandFx: { ...structuredClone(DEFAULT_GIFT_BAND_FX), enabled: true },
    });
    const e = engine(c);
    e.start();
    freeze(e);
    fillQueue(e); // 視聴者由来のイベントでキューを上限まで埋める
    const before = e.get().value;

    // 溢れていようがいまいが押下は素通し — 走行中のタップは必ず数字へ届く。
    e.press();
    expect(e.get().value).toBe(before - 1);
    e.press();
    expect(e.get().value).toBe(before - 2);
    expect(e.get().stats.presses).toBe(2);
  });

  it('フォロー: 凍結が明けると溜めていた上限ぶんが全部適用される(取りこぼしゼロ)', () => {
    let t = NOW;
    const c = cfg({
      initialValue: 10_000,
      followStep: 1,
      giftBandFx: { ...structuredClone(DEFAULT_GIFT_BAND_FX), enabled: true },
    });
    const e = engine(c, () => t);
    e.start();
    freeze(e);
    const afterGift = e.get().value;

    fillQueue(e);
    e.handleEvent(follow('overflow')); // 溢れた1件は即時
    expect(e.get().value).toBe(afterGift + 1);

    // 凍結明け。保留分が全部流れる。
    t = NOW + 600_000;
    e.drainIfChanged();
    expect(e.get().value).toBe(afterGift + GIFT_FX_PENDING_OPS_MAX + 1);
    expect(e.get().stats.follows).toBe(GIFT_FX_PENDING_OPS_MAX + 1);
  });

  it('ギフト: 溢れたら値だけ適用し、カットイン(再凍結)は捨てる', () => {
    const c = cfg({
      initialValue: 10_000,
      pressStep: 1,
      giftBandFx: { ...structuredClone(DEFAULT_GIFT_BAND_FX), enabled: true },
    });
    const e = engine(c);
    e.start();
    freeze(e);
    const frozenUntil = e.get().fxFreezeUntilMs;

    fillQueue(e);

    const before = e.get().value;
    // 帯域に一致する(=本来カットインが付く)ギフトを溢れた状態で受ける。
    e.handleEvent(gift({ diamonds: 30 }));

    // 値は即時に入る(既定 perDiamond +1 なので妨害方向へ 30)。
    expect(e.get().value).toBe(before + 30);
    // カットインを捨てたので凍結は伸びていない。
    expect(e.get().fxFreezeUntilMs).toBe(frozenUntil);
  });

  it('溢れ中でも msgId の二重適用防止は効く(再接続バックログ)', () => {
    const c = cfg({
      initialValue: 10_000,
      giftBandFx: { ...structuredClone(DEFAULT_GIFT_BAND_FX), enabled: true },
    });
    const e = engine(c);
    e.start();
    freeze(e);
    fillQueue(e);

    const dup = gift({ diamonds: 30 });
    const before = e.get().value;
    e.handleEvent(dup);
    const once = e.get().value;
    expect(once).toBe(before + 30);

    e.handleEvent(dup); // 同じ msgId
    expect(e.get().value).toBe(once);
  });
});

describe('ギフトの増減写像 — 先勝ち4段の表', () => {
  const TRIGGER = { giftId: '9999', giftName: 'E2E Trigger' };

  /**
   * 同じ1つのギフトを4段すべてに登録した設定。段を1つずつ外していくと、
   * 次の段へ落ちる。これで「どの段が勝つか」が1本の表で固定される。
   */
  function allFour(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
    return cfg({
      initialValue: 1000,
      fanStamp: {
        ...structuredClone(DEFAULT_FAN_STAMP),
        enabled: true,
        giftId: TRIGGER.giftId,
        giftName: TRIGGER.giftName,
        amountEach: -7,
      },
      tapBoost: {
        ...structuredClone(DEFAULT_TAP_BOOST),
        enabled: true,
        rules: [
          {
            ...structuredClone(DEFAULT_TAP_BOOST.rules[0]!),
            giftId: TRIGGER.giftId,
            giftName: TRIGGER.giftName,
          },
        ],
      },
      roulettes: [
        {
          ...structuredClone(DEFAULT_ROULETTES[0]!),
          id: 'rl-e2e',
          giftId: TRIGGER.giftId,
          giftName: TRIGGER.giftName,
          direction: 'sub',
          segments: [{ amount: 55, weight: 1 }],
        },
      ],
      giftRules: [
        { id: 'r1', giftId: TRIGGER.giftId, mode: 'fixed', amount: -3 },
      ],
      ...over,
    });
  }

  function trigger(): NormalizedEvent {
    return gift({ ...TRIGGER, diamonds: 1, repeatCount: 1 });
  }

  it('①お助け(fanStamp)が全部に勝つ', () => {
    const e = engine(allFour());
    e.start();
    e.handleEvent(trigger());
    // amountEach = -7 が適用される(応援方向)。
    expect(e.get().value).toBe(993);
    expect(e.get().stats.giftDown).toBeGreaterThan(0);
  });

  it('②お助けを外すとタップブーストが勝つ — トリガー自体は値を動かさない', () => {
    const c = allFour();
    c.fanStamp.enabled = false;
    const e = engine(c);
    e.start();
    e.handleEvent(trigger());
    // 発動だけが起きる。減るのは後で溜めたタップの一括反映。
    expect(e.get().value).toBe(1000);
    expect(e.get().boost).not.toBeNull();
  });

  it('③ブーストも外すとルーレットが勝つ', () => {
    const c = allFour();
    c.fanStamp.enabled = false;
    c.tapBoost.enabled = false;
    const e = engine(c);
    e.start();
    e.handleEvent(trigger());
    // 出目 55 を direction:'sub' で引く。
    expect(e.get().value).toBe(945);
    expect(e.get().stats.rouletteSpins).toBe(1);
  });

  it('④ルーレットも外すと giftRules が勝つ', () => {
    const c = allFour();
    c.fanStamp.enabled = false;
    c.tapBoost.enabled = false;
    c.roulettes = [];
    const e = engine(c);
    e.start();
    e.handleEvent(trigger());
    expect(e.get().value).toBe(997);
  });

  it('⑤規則も外すと giftDefault(既定 perDiamond +1)へ落ちる', () => {
    const c = allFour();
    c.fanStamp.enabled = false;
    c.tapBoost.enabled = false;
    c.roulettes = [];
    c.giftRules = [];
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ ...TRIGGER, diamonds: 12, repeatCount: 1 }));
    // 妨害方向へ diamonds ぶん増える。
    expect(e.get().value).toBe(1012);
  });

  it('段は互いに二重適用しない — 4段登録でも値の変化は1回ぶんだけ', () => {
    const e = engine(allFour());
    e.start();
    e.handleEvent(trigger());
    // お助けの -7 だけ。ルーレットの -55 も規則の -3 も既定の +1 も乗らない。
    expect(e.get().value).toBe(993);
    expect(e.get().stats.rouletteSpins).toBe(0);
    expect(e.get().boost ?? null).toBeNull();
  });
});
