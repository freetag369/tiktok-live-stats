import { describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE, DEFAULT_GIFT_BAND_FX, GIFT_FX_FREEZE_MARGIN_MS } from '@shared/challenge';
import type { ChallengeConfig, ChallengeEffect } from '@shared/dto';
import type { GiftEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * 凍結明けドレインの follow 合算(finishDrain の merge)。
 *
 * 従来は amount 合算 + coalesced だけで、nickname は `{...last}` = 最後の1人しか
 * 残らなかった — 「+30 3人目の名前 がフォロー!」という不正確なバナーになる。
 * followNames(到着順・同名は畳む)と nickname の先頭揃えを固定する。
 *
 * 人数は coalesced が兼ねる(follow は seenFollowers の userId dedup で
 * 1 effect = 1人 が保証される)— fanStampPeople 相当は持たない、が契約。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.giftBandFx = structuredClone(DEFAULT_GIFT_BAND_FX);
  base.giftFullCut.enabled = false;
  return { ...base, enabled: true, ...over };
}

function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  return {
    kind: 'gift',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'g1', nickname: 'gifter' },
    giftId: '5655',
    giftName: 'Rose',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

function follow(userId: string, nickname: string): SocialEvent {
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname },
  };
}

function engine(c: ChallengeConfig, now: () => number): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, Math.random, Math.random, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

function followEffect(e: ChallengeEngine): ChallengeEffect | undefined {
  return e.get().recentEffects.find((x) => x.kind === 'follow');
}

describe('finishDrain の follow 合算(followNames)', () => {
  it('凍結中の follow ×3 は1件に畳まれ、名前は到着順・見出しは先頭', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1 → 6 秒凍結(値 +30)
    t += 1000;
    e.handleEvent(follow('a', '名前f1'));
    e.handleEvent(follow('b', '名前f2'));
    e.handleEvent(follow('c', '名前f3'));
    expect(followEffect(e)).toBeUndefined(); // 凍結中は effect にならない

    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    e.drainIfChanged();
    const fx = followEffect(e);
    expect(fx).toMatchObject({
      kind: 'follow',
      amount: 30,
      coalesced: 3,
      followNames: ['名前f1', '名前f2', '名前f3'],
      nickname: '名前f1',
    });
    // 値の会計: 1000 + 30(gift) + 30(follow×3)。valueAfter は最後の適用値。
    expect(e.get().value).toBe(1060);
    expect(fx!.valueAfter).toBe(1060);
    expect(e.get().stats.follows).toBe(3);
  });

  it('1件だけのドレインは原型のまま(coalesced も followNames も付かない)', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    t += 1000;
    e.handleEvent(follow('a', 'ひとり'));

    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    e.drainIfChanged();
    const fx = followEffect(e);
    expect(fx).toMatchObject({ kind: 'follow', amount: 10, nickname: 'ひとり' });
    expect(fx!.coalesced).toBeUndefined();
    expect(fx!.followNames).toBeUndefined();
  });

  it('同名の別人 ×2 は names 1件に畳まれるが人数(coalesced)は 2', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    t += 1000;
    e.handleEvent(follow('a', '同じ名前'));
    e.handleEvent(follow('b', '同じ名前'));

    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    e.drainIfChanged();
    const fx = followEffect(e);
    expect(fx).toMatchObject({
      kind: 'follow',
      amount: 20,
      coalesced: 2,
      followNames: ['同じ名前'],
    });
  });

  it('即時経路(凍結なし)は従来どおり1件ずつで followNames なし', () => {
    const e = engine(cfg({ initialValue: 1000, followStep: 10 }), () => NOW);
    e.start();
    e.handleEvent(follow('a', 'そのまま1'));
    e.handleEvent(follow('b', 'そのまま2'));
    const effects = e.get().recentEffects.filter((x) => x.kind === 'follow');
    expect(effects).toHaveLength(2);
    for (const fx of effects) {
      expect(fx.coalesced).toBeUndefined();
      expect(fx.followNames).toBeUndefined();
    }
  });
});
