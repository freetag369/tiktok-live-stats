/**
 * ▶テスト実演(testBoost)・フィーバー・機能 OFF の交差点。
 *
 * press() は実演ブロックを最優先で見る(status も enabled も見ずに計数して
 * return)ため、実演の窓が誤って生き残ると本物のタップがテストカウンタへ吸われて
 * 実値が 1 も減らない。また onConfigChanged の OFF はアーム済みフィーバーと凍結を
 * 畳まないと、無効化した機能のフィーバーが 60 秒後に強制発動する。ここでは
 *   - start() が実演の窓を破棄すること(実演→そのまま「開始」の導線)
 *   - アーム中は実演を登録しないこと(実フィーバーのタップを乗っ取らない)
 *   - 機能 OFF がアーム/進行中フィーバー/凍結/保留 op を stop() と同じ規約で畳むこと
 *   - いいね妨害が無効でも順位の変化が 2Hz tick に乗ること
 * を固定する。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  TAP_BOOST_COUNT_MS,
  TAP_BOOST_INTRO_MS,
} from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent, LikeEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const PRE = TAP_BOOST_INTRO_MS + TAP_BOOST_COUNT_MS;
const BOOST_GIFT = '9999';
const MULT = DEFAULT_TAP_BOOST_RULE.multiplier;
const DURATION_MS = DEFAULT_TAP_BOOST_RULE.durationSec * 1000;

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 全面カットは既定行が「バラ」に一致して別の凍結を張るので落とす。帯域カットインは
  // 「凍結中の保留」を作るテストで使うため既定のまま有効(press-freeze と同じ構成)。
  base.giftFullCut.enabled = false;
  base.giftBandFx = structuredClone(DEFAULT_GIFT_BAND_FX);
  base.roulettes = [];
  return {
    ...base,
    enabled: true,
    initialValue: 1000,
    pressStep: 1,
    tapBoost: { ...DEFAULT_TAP_BOOST, enabled: true, rules: [{ ...DEFAULT_TAP_BOOST_RULE, giftId: BOOST_GIFT }] },
    ...over,
  };
}

function engine(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

function boostGift(): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `m${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `u${seq}` },
    giftId: BOOST_GIFT,
    giftName: 'Boost Gift',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
  };
}

/** band1 に一致する 30💎 のギフト(= 凍結を張る)。 */
function bandGift(): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `m${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `u${seq}` },
    giftId: '999999',
    giftName: 'NoMatch',
    repeatCount: 1,
    diamondEach: 30,
    diamonds: 30,
    isBoxGift: false,
  };
}

function follow(userId: string): SocialEvent {
  seq += 1;
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `f${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: userId },
  };
}

function like(count: number): LikeEvent {
  seq += 1;
  return {
    kind: 'like',
    msgId: `l${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `u${seq}` },
    count,
  };
}

/** 実発動(アーム済み)の boost-start effect の id — 実演の effect(test)は除く。 */
function realBoostStartId(e: ChallengeEngine): number {
  const fx = e.get().recentEffects.find((x) => x.kind === 'boost-start' && x.test !== true);
  expect(fx).toBeDefined();
  return fx!.id;
}

describe('▶実演の窓と実ランの交差点', () => {
  it('実演の窓を跨いで start() しても、開幕の press が実値を減らす', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.testEffect({ kind: 'tapBoost' });
    // 実演のタップ窓が開いた時刻まで進めてから「開始」— 窓の残りは 15 秒以上ある。
    t = NOW + PRE + 500;
    e.start();
    e.press();
    const s = e.get();
    expect(s.value).toBe(999);
    expect(s.stats.presses).toBe(1);
    // 実演の幽霊フィーバーがモニターに出ない(boost キーが載らない)。
    expect(s.boost).toBeUndefined();
  });

  it('アーム中の実演は登録されない — 実フィーバーのタップは実カウンタに入り清算される', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(boostGift()); // アーム(boostUntilMs はまだ null)
    // アームの直後(最大 60 秒の猶予中)に設定画面で ▶ 実演 — 登録されてはいけない。
    e.testEffect({ kind: 'tapBoost' });
    e.boostCue({
      action: 'start',
      effectId: realBoostStartId(e),
      startedAtMs: NOW,
      preMs: PRE,
    });
    t = NOW + PRE + 1000; // タップウィンドウ中
    e.press();
    e.press();
    expect(e.get().boost?.tapCount).toBe(2); // 実演ではなく実カウンタへ

    t = NOW + PRE + DURATION_MS + 1;
    const s = e.drainIfChanged()!;
    expect(s.value).toBe(1000 - 2 * MULT); // 清算がタップを1つも落とさない
  });
});

describe('enabled=false — フィーバー/凍結の後始末', () => {
  it('アーム中に OFF → 期限切れの強制発動(幽霊フィーバー)が起きない', () => {
    let t = NOW;
    const c = cfg();
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(boostGift());
    expect(e.get().fxFreezeUntilMs).not.toBeNull(); // アームは暫定凍結を張る

    c.enabled = false;
    e.onConfigChanged();
    expect(e.get().fxFreezeUntilMs).toBeNull();
    expect(e.get().boost).toBeUndefined();

    // アーム期限(60秒)を跨いでも発動しない — OFF 前は commitArmedBoostIfExpired が
    // ここで無効化済み機能のフィーバーを強制発動していた。
    t = NOW + 61_000;
    e.drainIfChanged();
    const s = e.get();
    expect(s.boost).toBeUndefined();
    expect(s.recentEffects.some((x) => x.kind === 'boost-end')).toBe(false);
  });

  it('進行中のフィーバー窓中に OFF → 清算され、溜めたタップは値に入る', () => {
    let t = NOW;
    const c = cfg();
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(boostGift());
    e.boostCue({
      action: 'start',
      effectId: realBoostStartId(e),
      startedAtMs: NOW,
      preMs: PRE,
    });
    t = NOW + PRE + 1000; // タップウィンドウ中
    e.press();
    e.press();
    e.press();

    c.enabled = false;
    e.onConfigChanged();
    const s = e.get();
    expect(s.boost).toBeUndefined();
    expect(s.fxFreezeUntilMs).toBeNull();
    // 溜めたタップは闇に落とさない(stop と同じ規約)。
    expect(s.value).toBe(1000 - 3 * MULT);
    expect(s.recentEffects.some((x) => x.kind === 'boost-end')).toBe(true);
  });

  it('凍結中の保留イベントは OFF で値だけ強制適用される', () => {
    const c = cfg({ followStep: 10 });
    const e = engine(c, () => NOW);
    e.start();
    e.handleEvent(bandGift()); // +30、カットイン凍結を張る
    e.handleEvent(follow('f1')); // 凍結中 → 保留
    expect(e.get().value).toBe(1030); // フォローはまだ効いていない

    c.enabled = false;
    e.onConfigChanged();
    const s = e.get();
    expect(s.value).toBe(1040); // 受け取り済みのフォローを闇に落とさない
    expect(s.fxFreezeUntilMs).toBeNull();
  });
});

describe('いいね — 妨害が無効でも順位の変化は delta に乗る', () => {
  it('likeEvery=0 でも handleEvent 後の drainIfChanged が null にならない', () => {
    const e = engine(cfg({ likeEvery: 0 }));
    e.start();
    e.drainIfChanged(); // start の dirty を消化
    expect(e.drainIfChanged()).toBeNull(); // 静止状態の裏取り

    expect(e.handleEvent(like(5))).toBe(false); // 値は動かない(妨害は無効)
    // だがイイネランキング(TOP3)は動いたので 2Hz tick に相乗りする。
    expect(e.drainIfChanged()).not.toBeNull();
  });
});
