/**
 * 最終ゲート(ラスト◯◯モード)— 残数が lowThreshold 以下のとき、タップ経路の
 * 1減算ごとに finalGate.taps 回のタップが必要になる。
 *
 * ゲートは press() の**通常経路の頭**に座る(tap-lock-press.spec.ts の分岐図の「既定」の直前):
 *
 *   ▶実演 → enabled → status → flushFxFreeze → フィーバー窓 → 封印 → 3・2・1 → **最終ゲート** → 既定
 *
 * この位置が仕様(2026-08-19 ユーザー決定): フィーバー窓のタップは免除、封印中は
 * 蓄積されず捨てられ、3・2・1 中は従来どおり凍結キュー行き。フォロー・いいね・
 * ギフト由来の増減はゲートを一切通らない(タップ経路だけの難所)。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_FINAL_GATE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  DEFAULT_TAP_LOCK,
  DEFAULT_TAP_LOCK_RULE,
  FINAL_GATE_TAPS_MAX,
  FINAL_GATE_TAPS_MIN,
  GIFT_FX_FREEZE_MARGIN_MS,
  validateChallengeConfig,
} from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
const LOCK_GIFT = '5555';
const BOOST_GIFT = '9999';
/** band1(30💎)のカットイン尺 + margin = 凍結が明ける時刻。 */
const BAND_MS = 6000;
const RELEASE = NOW + BAND_MS + GIFT_FX_FREEZE_MARGIN_MS;

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定で有効な演出は落とす(challenge.spec.ts の cfg と同じ理由 — 凍結や
  // ルーレットが本題のゲート挙動に割り込まないように)。検査するテストだけ戻す。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.roulettes = [];
  return {
    ...base,
    enabled: true,
    // 12 → press 2回で閾値(10)へ届く小さな盤面。taps は 3(30 だとテストが長い —
    // 値が設定から生きて読まれることは validate 側と E2E が固定する)。
    initialValue: 12,
    pressStep: 1,
    lowThreshold: 10,
    finalGate: { enabled: true, taps: 3 },
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

function follow(userId = 'f1'): SocialEvent {
  seq += 1;
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `m${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: `viewer-${userId}` },
  };
}

describe('最終ゲート — 蓄積と減算', () => {
  it('閾値より上は通常減算、閾値に入ると taps 回で 1 減る', () => {
    const e = engine(cfg());
    e.start();
    e.press();
    e.press();
    // 12 → 10。閾値ちょうどでゲートが開く(gauntlet キーが載る)。
    let s = e.get();
    expect(s.value).toBe(10);
    expect(s.gauntlet).toEqual({ taps: 0, needed: 3 });

    e.press();
    e.press();
    s = e.get();
    // 蓄積中は値が動かない。進捗は gauntlet が運ぶ。
    expect(s.value).toBe(10);
    expect(s.gauntlet).toEqual({ taps: 2, needed: 3 });
    // 蓄積タップは effect を積まない(リングを押し流さない)。
    expect(s.recentEffects.filter((x) => x.kind === 'press')).toHaveLength(2); // 12→11, 11→10 のぶんだけ

    e.press();
    s = e.get();
    expect(s.value).toBe(9);
    expect(s.gauntlet).toEqual({ taps: 0, needed: 3 });
    // recentEffects は新しい順 — 先頭がゲート完成の press。
    const fx = s.recentEffects.filter((x) => x.kind === 'press');
    expect(fx).toHaveLength(3);
    // ゲート完成の press effect には finalGate の印が焼かれる(リング破裂のトリガー)。
    expect(fx[0]).toMatchObject({ amount: -1, valueAfter: 9, finalGate: true });
    // 通常経路の press には印が無い。
    expect(fx[2]?.finalGate).toBeUndefined();
  });

  it('閾値+1(11)ではゲートは開かない', () => {
    const e = engine(cfg({ initialValue: 11 }));
    e.start();
    expect(e.get().gauntlet).toBeUndefined();
    e.press();
    expect(e.get().value).toBe(10);
    expect(e.get().gauntlet).toEqual({ taps: 0, needed: 3 });
  });

  it('pressStep > 1 でもゲート中は常に 1 だけ減る(数字飛びさせない)', () => {
    const e = engine(cfg({ initialValue: 20, pressStep: 5 }));
    e.start();
    e.press(); // 20 → 15
    e.press(); // 15 → 10(ゲート開始)
    expect(e.get().value).toBe(10);
    for (let i = 0; i < 3; i += 1) e.press();
    expect(e.get().value).toBe(9); // -5 ではなく -1
  });

  it('presses 統計は蓄積タップも実タップとして数える', () => {
    const e = engine(cfg({ initialValue: 10 }));
    e.start();
    for (let i = 0; i < 5; i += 1) e.press(); // 3発で 9、残り2発は次ゲートの蓄積
    const s = e.get();
    expect(s.value).toBe(9);
    expect(s.stats.presses).toBe(5);
    expect(s.gauntlet).toEqual({ taps: 2, needed: 3 });
    // pressDownTotal は実減少量だけ(蓄積タップは載らない)。
    expect(s.pressDownTotal).toBe(1);
  });

  it('最後の 1 をゲートで削り切ると達成する', () => {
    const e = engine(cfg({ initialValue: 1 }));
    e.start();
    e.press();
    e.press();
    expect(e.get().value).toBe(1);
    expect(e.get().status).toBe('running');
    e.press();
    const s = e.get();
    expect(s.value).toBe(0);
    expect(s.status).toBe('achieved');
    expect(s.recentEffects.some((x) => x.kind === 'achieved')).toBe(true);
    // 達成後(value 0)はゲート圏外 — gauntlet キーは載らない。
    expect(s.gauntlet).toBeUndefined();
  });

  it('enabled: false なら従来挙動のまま(閾値以下も pressStep で即減算)', () => {
    const e = engine(cfg({ initialValue: 10, finalGate: { enabled: false, taps: 3 } }));
    e.start();
    e.press();
    const s = e.get();
    expect(s.value).toBe(9);
    expect(s.gauntlet).toBeUndefined();
  });
});

describe('最終ゲート — 蓄積のリセット', () => {
  it('妨害(+N)で閾値を上抜けると蓄積は捨てられ、通常減算に戻る', () => {
    const e = engine(cfg({ initialValue: 10, followStep: 10 }));
    e.start();
    e.press();
    e.press();
    expect(e.get().gauntlet).toEqual({ taps: 2, needed: 3 });
    e.handleEvent(follow()); // 10 → 20(圏外へ)
    expect(e.get().value).toBe(20);
    expect(e.get().gauntlet).toBeUndefined();
    // 圏外の press は通常減算(蓄積が完成扱いで2つ減ったりしない)。
    e.press();
    expect(e.get().value).toBe(19);
    // 再突入したら 0 から蓄積し直す(旧蓄積 2 が残っていれば 1 発目で減ってしまう)。
    for (let i = 0; i < 9; i += 1) e.press(); // 19 → 10
    expect(e.get().value).toBe(10);
    e.press();
    e.press();
    expect(e.get().value).toBe(10);
    expect(e.get().gauntlet).toEqual({ taps: 2, needed: 3 });
  });

  it('stop → start で蓄積は持ち越されない', () => {
    const e = engine(cfg({ initialValue: 10 }));
    e.start();
    e.press();
    e.press();
    e.stop();
    e.start();
    // 新ランは素の状態 — 2発では減らず、3発目で減る。
    e.press();
    e.press();
    expect(e.get().value).toBe(10);
    e.press();
    expect(e.get().value).toBe(9);
  });

  it('reset でも蓄積は消える', () => {
    const e = engine(cfg({ initialValue: 10 }));
    e.start();
    e.press();
    e.press();
    e.reset();
    e.start();
    e.press();
    e.press();
    expect(e.get().value).toBe(10);
  });

  it('idle / stop 中は gauntlet キー自体が載らない', () => {
    const e = engine(cfg({ initialValue: 10 }));
    expect(e.get().gauntlet).toBeUndefined();
    e.start();
    expect(e.get().gauntlet).toEqual({ taps: 0, needed: 3 });
    e.stop();
    expect(e.get().gauntlet).toBeUndefined();
  });
});

describe('最終ゲート — 他機能との交差点(分岐順序が仕様)', () => {
  function boostCfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
    return cfg({
      initialValue: 10,
      tapBoost: {
        ...structuredClone(DEFAULT_TAP_BOOST),
        rules: [{ ...structuredClone(DEFAULT_TAP_BOOST_RULE), giftId: BOOST_GIFT, introClip: 'off', countClip: 'off' }],
      },
      ...over,
    });
  }

  it('フィーバー窓の中のタップはゲート免除(窓のカウンタに乗り、清算も素通り)', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    expect(e.get().gauntlet).toBeDefined();
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' }));
    e.boostCue({
      action: 'start',
      effectId: e.get().recentEffects.find((x) => x.kind === 'boost-start')!.id,
      startedAtMs: NOW,
      preMs: 0,
    });
    t = NOW + 1000; // タップ窓の中
    for (let i = 0; i < 3; i += 1) e.press();
    const s = e.get();
    expect(s.boost?.tapCount).toBe(3);
    expect(s.value).toBe(10); // シネマティックは清算まで値を動かさない
    // ブーストウィンドウ中は gauntlet キーごと省く(リングはフィーバー演出に譲る)。
    expect(s.gauntlet).toBeUndefined();
    // 窓明けの清算はゲートを素通りして一括で落ちる(3タップ × step1 × 倍率)。
    t = NOW + 120_000;
    const after = e.drainIfChanged()!;
    expect(after.value).toBe(Math.max(0, 10 - 3 * 1 * DEFAULT_TAP_BOOST_RULE.multiplier));
  });

  it('ブーストを跨いでも蓄積は没収されない(フィーバーはボーナスであって罰ではない)', () => {
    let t = NOW;
    const e = engine(boostCfg(), () => t);
    e.start();
    e.press();
    e.press();
    expect(e.get().gauntlet).toEqual({ taps: 2, needed: 3 });
    e.handleEvent(gift({ giftId: BOOST_GIFT, giftName: 'Boost Gift' }));
    e.boostCue({
      action: 'start',
      effectId: e.get().recentEffects.find((x) => x.kind === 'boost-start')!.id,
      startedAtMs: NOW,
      preMs: 0,
    });
    // 窓の間は一度も押さない。清算 0 で値は 10 のまま。
    t = NOW + 120_000;
    const s = e.drainIfChanged()!;
    expect(s.value).toBe(10);
    expect(s.gauntlet).toEqual({ taps: 2, needed: 3 });
  });

  it('封印(タップ封じ)中のタップはゲートに蓄積されず捨てられる', () => {
    const e = engine(
      cfg({
        initialValue: 10,
        tapLock: {
          ...structuredClone(DEFAULT_TAP_LOCK),
          enabled: true,
          rules: [{ ...structuredClone(DEFAULT_TAP_LOCK_RULE), id: 'lock-1', giftId: LOCK_GIFT }],
        },
      }),
    );
    e.start();
    e.press(); // 蓄積 1
    e.handleEvent(gift({ giftId: LOCK_GIFT, giftName: 'Jam Gift' }));
    for (let i = 0; i < 5; i += 1) e.press();
    const s = e.get();
    expect(s.tapLock?.blocked).toBe(5);
    expect(s.value).toBe(10);
    // 蓄積は封印前の 1 のまま(封印中に育つと「封印」ではなく「充填時間」になる)。
    expect(s.gauntlet).toEqual({ taps: 1, needed: 3 });
  });

  it('凍結(カットイン)中も蓄積は動き、完成の減算は演出だけ畳まれる', () => {
    let t = NOW;
    const e = engine(
      cfg({
        initialValue: 10,
        giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX),
        // band ギフト(30💎)が値を +30 して圏外に飛ばさないよう、既定増減は切る。
        giftDefault: null,
      }),
      () => t,
    );
    e.start();
    // band1(30💎)= 6 秒の凍結。
    e.handleEvent(gift({ diamondEach: 30, diamonds: 30 }));
    expect(e.get().fxFreezeUntilMs).not.toBeNull();
    e.press();
    e.press();
    expect(e.get().gauntlet).toEqual({ taps: 2, needed: 3 });
    e.press(); // 完成 — 値は即時に減る(押下は凍結を素通しする契約)
    let s = e.get();
    expect(s.value).toBe(9);
    // ただし press effect は凍結中は出ない(pendingPressFx に畳まれる)。
    expect(s.recentEffects.some((x) => x.kind === 'press')).toBe(false);
    // 凍結明けに畳んだ 1 件が出る。
    t = RELEASE + 1;
    s = e.drainIfChanged()!;
    const fx = s.recentEffects.filter((x) => x.kind === 'press');
    expect(fx).toHaveLength(1);
    expect(fx[0]?.amount).toBe(-1);
  });
});

describe('validateChallengeConfig — finalGate のサニタイズ', () => {
  it('キー欠損は既定(有効・30)へ倒れる — 保存済み settings.json の移行を兼ねる', () => {
    const saved = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    delete saved.finalGate;
    const v = validateChallengeConfig(saved);
    expect(v.finalGate).toEqual(DEFAULT_FINAL_GATE);
    expect(v.finalGate.enabled).toBe(true);
    expect(v.finalGate.taps).toBe(30);
  });

  it('明示 false は尊重される(既定 true なので !== false の向き)', () => {
    const c = structuredClone(DEFAULT_CHALLENGE);
    c.finalGate = { enabled: false, taps: 10 };
    expect(validateChallengeConfig(c).finalGate).toEqual({ enabled: false, taps: 10 });
  });

  it('taps は範囲へクランプ、型崩れは既定へ', () => {
    const c = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    c.finalGate = { enabled: true, taps: 1 }; // 1 は通常挙動と同じで無意味 → 下限 2
    expect(validateChallengeConfig(c).finalGate.taps).toBe(FINAL_GATE_TAPS_MIN);
    c.finalGate = { enabled: true, taps: 100_000 };
    expect(validateChallengeConfig(c).finalGate.taps).toBe(FINAL_GATE_TAPS_MAX);
    c.finalGate = { enabled: true, taps: 'x' };
    expect(validateChallengeConfig(c).finalGate.taps).toBe(30);
    c.finalGate = 'broken';
    expect(validateChallengeConfig(c).finalGate).toEqual(DEFAULT_FINAL_GATE);
  });
});
