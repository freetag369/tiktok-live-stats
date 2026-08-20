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
 *
 * フィーバーとの時間的関係は**排他予約方式**(2026-08-20 ユーザー決定 — 旧「開いた窓は
 * 免除」を置き換え): フィーバー在航中(アーム〜清算完了)に届いたお邪魔は予約され、
 * 清算完了直後に満額の尺で発動する。封印とタップ窓は決して同時に生きない。
 */
import { describe, expect, it } from 'vitest';
import {
  BOOST_ARM_MAX_MS,
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  DEFAULT_TAP_LOCK,
  DEFAULT_TAP_LOCK_RULE,
  GIFT_FX_FREEZE_MARGIN_MS,
  TAP_LOCK_MAX_MS,
} from '@shared/challenge';
import { BOOST_SETTLE_BUDGET_MS, TAP_BOOST_RESULT_MS } from '@shared/boost-settle';
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

describe('フィーバーとの排他(2026-08-20 ユーザー決定: 予約して清算後に満額発動)', () => {
  function boostCfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
    return cfg({
      tapBoost: {
        ...DEFAULT_TAP_BOOST,
        rules: [{ ...DEFAULT_TAP_BOOST_RULE, giftId: BOOST_GIFT, introClip: 'off', countClip: 'off' }],
      },
      ...over,
    });
  }
  const WINDOW_MS = DEFAULT_TAP_BOOST_RULE.durationSec * 1000; // 既定 5 秒
  /** シネマティックの清算発表まで含めて凍結が明ける時刻(コミットが NOW 起点のとき)。 */
  const SETTLED =
    NOW + WINDOW_MS + TAP_BOOST_RESULT_MS + BOOST_SETTLE_BUDGET_MS + GIFT_FX_FREEZE_MARGIN_MS + 1;

  /** ブーストを発動し、モニターの合図で窓を NOW 起点で開く(前置き 'off' = preMs 0)。 */
  function startBoost(e: ChallengeEngine): void {
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' }));
    e.boostCue({
      action: 'start',
      effectId: e.get().recentEffects.find((x) => x.kind === 'boost-start')!.id,
      startedAtMs: NOW,
      preMs: 0,
    });
  }

  it('フィーバー在航中に届いたお邪魔は即時ラッチされない(窓のタップは通り倍率も乗る)', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    startBoost(e);
    t = NOW + 1000; // タップ窓の中
    e.handleEvent(lockGift());
    expect(e.get().tapLock).toBeUndefined(); // 予約 — 封印と窓は同時に生きない
    for (let i = 0; i < 3; i += 1) e.press();
    expect(e.get().boost?.tapCount).toBe(3);
  });

  it('清算完了直後に満額の尺で発動する(バナーは1枚・boost-end より後)', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    startBoost(e);
    t = NOW + 1000;
    e.handleEvent(lockGift());
    t = SETTLED;
    const s = e.drainIfChanged()!;
    // 満額 — 予約している間、封印の時計は 1ms も減らない。
    expect(s.tapLock?.startsAtMs).toBe(SETTLED);
    expect(s.tapLock!.endsAtMs - s.tapLock!.startsAtMs).toBe(30_000);
    // バナーは発動時に1枚だけ(着弾時の告知は出さない)。清算より後に並ぶ。
    const banners = s.recentEffects.filter((x) => x.kind === 'tap-lock');
    expect(banners).toHaveLength(1);
    expect(banners[0]!.tapLockMs).toBe(30_000);
    const boostEnd = s.recentEffects.find((x) => x.kind === 'boost-end');
    expect(boostEnd).toBeDefined();
    expect(banners[0]!.id).toBeGreaterThan(boostEnd!.id);
    // 発動後は普通の封印(押下は捨てる — このテストは窓中のタップ 0 なので値は初期のまま)。
    e.press();
    expect(e.get().tapLock?.blocked).toBe(1);
    expect(e.get().value).toBe(1000);
  });

  it('複数着弾は予約に合算され(連打は丸め)、天井は TAP_LOCK_MAX_MS', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    startBoost(e);
    t = NOW + 500;
    e.handleEvent(lockGift({ repeatCount: 17 })); // 丸めで2本 = 60秒
    t = NOW + 600;
    e.handleEvent(lockGift()); // +30 = 90秒
    t = NOW + 700;
    e.handleEvent(lockGift({ repeatCount: 17 })); // +60 = 150 → 天井 120秒
    expect(e.get().tapLock).toBeUndefined();
    t = SETTLED;
    const s = e.drainIfChanged()!;
    expect(s.tapLock!.endsAtMs - s.tapLock!.startsAtMs).toBe(TAP_LOCK_MAX_MS);
  });

  it('アーム中(モニターの合図待ち)の着弾も予約される', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' })); // アームのみ(cue なし)
    t = NOW + 1000;
    e.handleEvent(lockGift());
    expect(e.get().tapLock).toBeUndefined();
    // アーム期限切れの強制コミット → 窓 → 清算発表まで一気に進める。
    t =
      NOW +
      BOOST_ARM_MAX_MS +
      WINDOW_MS +
      TAP_BOOST_RESULT_MS +
      BOOST_SETTLE_BUDGET_MS +
      GIFT_FX_FREEZE_MARGIN_MS +
      1;
    const s = e.drainIfChanged()!;
    expect(s.tapLock?.startsAtMs).toBe(t); // 清算時点から満額
    expect(s.tapLock!.endsAtMs - s.tapLock!.startsAtMs).toBe(30_000);
  });

  it('プレーンモード(モニター非表示)でも排他 — 窓期限の清算で発動しバナーも即時', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.setMonitorOpen(false); // プレーンモード(凍結なし・即発動)
    e.start();
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' }));
    t = NOW + 1000;
    e.handleEvent(lockGift());
    expect(e.get().tapLock).toBeUndefined();
    e.press(); // プレーンの窓は即時×倍率
    expect(e.get().value).toBe(1000 - DEFAULT_TAP_BOOST_RULE.multiplier);
    t = NOW + WINDOW_MS + 1;
    const s = e.drainIfChanged()!;
    expect(s.tapLock?.startsAtMs).toBe(t);
    // 凍結が無いのでバナーも発動と同時に出る(1枚だけ)。
    expect(s.recentEffects.filter((x) => x.kind === 'tap-lock')).toHaveLength(1);
  });

  it('予約中の stop は発動もバナーも残さない(封印を跨がせない規約と同じ)', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    startBoost(e);
    t = NOW + 1000;
    e.handleEvent(lockGift());
    e.stop(); // 清算(settleBoost force)より前に予約が捨てられること
    expect(e.get().tapLock).toBeUndefined();
    expect(e.get().recentEffects.some((x) => x.kind === 'tap-lock')).toBe(false);
    t = SETTLED;
    e.drainIfChanged();
    expect(e.get().tapLock).toBeUndefined();
  });

  it('予約中の機能 OFF も同じ(OFF にしたのに封印が発動しない)', () => {
    let t = NOW;
    const c = boostCfg();
    const e = engine(c, () => t);
    e.start();
    startBoost(e);
    t = NOW + 1000;
    e.handleEvent(lockGift());
    c.enabled = false;
    e.onConfigChanged(); // 中で settleBoost(force) が走る — 予約はその前に消えること
    expect(e.get().tapLock).toBeUndefined();
    expect(e.get().recentEffects.some((x) => x.kind === 'tap-lock')).toBe(false);
  });

  it('清算で 0 到達(達成)なら予約は破棄される', () => {
    let t = NOW;
    const e = engine(boostCfg({ initialValue: DEFAULT_TAP_BOOST_RULE.multiplier }), () => t);
    e.setMonitorOpen(false); // プレーン — 押下が即時に効くので1押しで 0 に落とせる
    e.start();
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' }));
    t = NOW + 1000;
    e.handleEvent(lockGift());
    e.press(); // ×5 で 0 到達 → 達成
    expect(e.get().status).toBe('achieved');
    expect(e.get().tapLock).toBeUndefined();
    t = NOW + WINDOW_MS + 1;
    e.drainIfChanged();
    expect(e.get().tapLock).toBeUndefined();
    expect(e.get().recentEffects.some((x) => x.kind === 'tap-lock')).toBe(false);
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
