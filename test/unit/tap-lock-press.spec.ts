/**
 * お邪魔(タップ封じ)と押下ゲートの交差点。
 *
 * この機能は press() の「走行中のタップは必ず届く」契約(challenge-press-freeze.spec.ts)に
 * **初めて意図的に開けた例外**なので、ゲートの位置そのものが仕様になる。ここで固定するのは
 * press() の 9 分岐のうち封印がどこに座るか:
 *
 *   ▶実演 → enabled → status → flushFxFreeze → フィーバー窓 → **封印** → 3・2・1 → 凍結 → 既定
 *
 * 1つでもずれると「実演が死ぬ / 逃げ道が消える / 封印が自分を閉じ込める / フィーバーで
 * 無効化される / 封印ではなく遅延になる / カットイン中だけ効かない」のどれかに化ける。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  DEFAULT_TAP_LOCK,
  DEFAULT_TAP_LOCK_RULE,
  GIFT_FX_FREEZE_MARGIN_MS,
  TAP_BOOST_COUNT_MS,
  TAP_BOOST_INTRO_MS,
} from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const LOCK_GIFT = '5555';
const BOOST_GIFT = '9999';
/** band1(30💎)のカットイン尺 + margin = 凍結が明ける時刻。 */
const BAND_MS = 6000;
const RELEASE = NOW + BAND_MS + GIFT_FX_FREEZE_MARGIN_MS;

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定の全面カットは「バラ」に一致して別の凍結を張るので落とす。
  base.giftFullCut.enabled = false;
  base.giftBandFx = structuredClone(DEFAULT_GIFT_BAND_FX);
  base.roulettes = [];
  return {
    ...base,
    enabled: true,
    initialValue: 1000,
    pressStep: 1,
    tapLock: {
      ...structuredClone(DEFAULT_TAP_LOCK),
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_TAP_LOCK_RULE), id: 'lock-1', giftId: LOCK_GIFT }],
    },
    ...over,
  };
}

function engine(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `m${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `視聴者${seq}` },
    giftId: '999999',
    giftName: 'NoMatch',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

/** 封印だけを張る(値も凍結も動かさない 1💎 のトリガーギフト)。 */
function lockGift(over: Partial<GiftEvent> = {}): GiftEvent {
  return gift({ giftId: LOCK_GIFT, giftName: 'Jam Gift', ...over });
}

/** band1 に一致する 30💎 = 6 秒の凍結を張るギフト。 */
function bandGift(over: Partial<GiftEvent> = {}): GiftEvent {
  return gift({ diamondEach: 30, diamonds: 30, ...over });
}

describe('封印中の押下は捨てる(溜めない)', () => {
  it('値・統計・pressDownTotal のどれも動かず、blocked だけ増える', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(lockGift());
    expect(e.get().tapLock?.endsAtMs).toBe(NOW + 30_000);

    for (let i = 0; i < 5; i += 1) e.press();
    const s = e.get();
    expect(s.value).toBe(1000);
    expect(s.stats.presses).toBe(0);
    expect(s.pressDownTotal).toBeUndefined();
    expect(s.tapLock?.blocked).toBe(5);
    // press effect も積まれない(履歴もモニターも「押した」ことにしない)。
    expect(s.recentEffects.some((x) => x.kind === 'press')).toBe(false);
  });

  it('**遅延ではなく封印** — 解除後に溜まったぶんがまとめて落ちない', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(lockGift());
    for (let i = 0; i < 10; i += 1) e.press();
    t = NOW + 30_001;
    const s = e.drainIfChanged()!;
    expect(s.tapLock).toBeUndefined();
    expect(s.value).toBe(1000); // 10 回ぶんは戻ってこない
    // 解除後の押下は普通に効く。
    e.press();
    expect(e.get().value).toBe(999);
  });

  it('境界 — 期限の 1ms 手前は弾き、期限ちょうどは通す', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(lockGift());
    t = NOW + 30_000 - 1;
    e.press();
    expect(e.get().value).toBe(1000);
    t = NOW + 30_000;
    e.press();
    expect(e.get().value).toBe(999);
  });
});

describe('press() のゲート位置', () => {
  it('封印中でも凍結ドレインは進む(flushFxFreeze より下に居る証明)', () => {
    // ここが逆だと、連打している配信者が唯一の呼び出し元なのに解除処理へ到達せず
    // **封印が自分自身を閉じ込める**。
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(bandGift()); // 6.5 秒の凍結 + 保留キュー
    e.handleEvent(lockGift());
    expect(e.get().fxFreezeUntilMs).toBe(RELEASE);
    t = RELEASE;
    e.press(); // 封印中なので値は動かないが、凍結は解除されるべき
    expect(e.get().fxFreezeUntilMs).toBeNull();
  });

  it('カットイン凍結より封印が勝つ(「タップは凍結を素通し」を上書きする)', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(bandGift());
    e.handleEvent(lockGift());
    expect(e.get().fxFreezeUntilMs).toBe(RELEASE);
    const before = e.get().value;
    e.press();
    expect(e.get().value).toBe(before); // 凍結中の即時適用も起きない
    expect(e.get().pressDownTotal).toBeUndefined();
  });

  it('機能 OFF と status!==running が封印より先に効く(逃げ道の維持)', () => {
    const c = cfg();
    const e = engine(c);
    e.start();
    e.handleEvent(lockGift());
    // 停止 = 一時停止。封印は跨がせない(再開したら見えないボタンが死んでいる)。
    e.stop();
    expect(e.get().tapLock).toBeUndefined();
  });
});

describe('カットイン凍結中に届いた封印は即時にラッチする', () => {
  it('期限は**着弾時刻**から数える(凍結明けからではない)', () => {
    // applyOrQueue に載せると最長 45 秒後ろ倒しになり、しかもその間タップは
    // 凍結素通しで普通に通る = 投げた視聴者から見て何も起きない。
    const e = engine(cfg());
    e.start();
    e.handleEvent(bandGift()); // 凍結を張る
    e.handleEvent(lockGift());
    expect(e.get().tapLock?.endsAtMs).toBe(NOW + 30_000);
    expect(e.get().tapLock?.endsAtMs).not.toBe(RELEASE + 30_000);
  });

  it('告知バナー(effect)だけは凍結明けに出る', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(bandGift());
    e.handleEvent(lockGift());
    expect(e.get().recentEffects.some((x) => x.kind === 'tap-lock')).toBe(false);
    t = RELEASE;
    const s = e.drainIfChanged()!;
    const fx = s.recentEffects.find((x) => x.kind === 'tap-lock');
    expect(fx).toBeDefined();
    expect(fx!.tapLockMs).toBe(30_000);
  });
});

describe('フィーバーとの関係(2026-08-18 ユーザー決定: 開いた窓は免除)', () => {
  function boostCfg(): ChallengeConfig {
    return cfg({
      tapBoost: {
        ...DEFAULT_TAP_BOOST,
        rules: [{ ...DEFAULT_TAP_BOOST_RULE, giftId: BOOST_GIFT, introClip: 'off', countClip: 'off' }],
      },
    });
  }

  it('開いているタップ窓の中では封印中でもタップが数えられる', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' }));
    e.boostCue({
      action: 'start',
      effectId: e.get().recentEffects.find((x) => x.kind === 'boost-start')!.id,
      startedAtMs: NOW,
      preMs: 0,
    });
    t = NOW + 1000; // タップ窓の中
    e.handleEvent(lockGift());
    expect(e.get().tapLock).toBeDefined();
    for (let i = 0; i < 3; i += 1) e.press();
    expect(e.get().boost?.tapCount).toBe(3); // 免除 — 窓のタップは通る
    expect(e.get().tapLock?.blocked ?? 0).toBe(0);
  });

  it('窓が閉じたあとは封印が効く(封印の時計は窓の間も止まらない)', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' }));
    e.boostCue({
      action: 'start',
      effectId: e.get().recentEffects.find((x) => x.kind === 'boost-start')!.id,
      startedAtMs: NOW,
      preMs: 0,
    });
    t = NOW + 1000;
    e.handleEvent(lockGift());
    // 窓(既定 10 秒)が閉じたあと。封印は着弾から 30 秒なので、まだ残っている。
    t = NOW + DEFAULT_TAP_BOOST_RULE.durationSec * 1000 + 1;
    const before = e.get().value;
    e.press();
    expect(e.get().value).toBe(before);
    expect(e.get().tapLock?.blocked).toBe(1);
  });

  it('3・2・1(起動カットイン)中のタップは保留キューに積まれない', () => {
    // ここが逆だと解除後にドレインで一気に落ちて「封印」ではなく「遅延」になる。
    let t = NOW;
    const c = cfg({
      tapBoost: { ...DEFAULT_TAP_BOOST, rules: [{ ...DEFAULT_TAP_BOOST_RULE, giftId: BOOST_GIFT }] },
    });
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' }));
    e.boostCue({
      action: 'start',
      effectId: e.get().recentEffects.find((x) => x.kind === 'boost-start')!.id,
      startedAtMs: NOW,
      preMs: TAP_BOOST_INTRO_MS + TAP_BOOST_COUNT_MS,
    });
    e.handleEvent(lockGift());
    t = NOW + 1000; // 咆哮の途中(窓はまだ開いていない)
    for (let i = 0; i < 4; i += 1) e.press();
    expect(e.get().tapLock?.blocked).toBe(4);
    // 封印もフィーバーも明けたあと、溜まったぶんが落ちてこないこと。
    t = NOW + 120_000;
    const s = e.drainIfChanged()!;
    expect(s.value).toBe(1000);
  });
});

describe('▶テスト実演は封印の抜け道にならない', () => {
  it('封印のラッチが実演ウィンドウを畳む', () => {
    // press() の実演ブロックは enabled/status ガードより**前**にあるので、
    // 実演窓が開いたままだと封印中でもそこで return されてしまう。
    const e = engine(cfg());
    e.start();
    e.testEffect({ kind: 'tapBoost' });
    expect(e.get().boost).toBeDefined(); // 実演の窓が開いている
    e.handleEvent(lockGift());
    expect(e.get().boost).toBeUndefined(); // 畳まれた
    e.press();
    expect(e.get().tapLock?.blocked).toBe(1);
  });

  it('▶ お邪魔の実演は effect を積むだけで、実際には封印しない', () => {
    // 設定画面は配信中にも開ける — ここで本当にラッチすると本番のボタンが死ぬ。
    const e = engine(cfg());
    e.start();
    e.testEffect({ kind: 'tapLock' });
    expect(e.get().tapLock).toBeUndefined();
    const fx = e.get().recentEffects.find((x) => x.kind === 'tap-lock');
    expect(fx?.test).toBe(true);
    e.press();
    expect(e.get().value).toBe(999);
  });
});
