/**
 * お邪魔(タップ封じ)の寿命 — **必ず解ける**ことの回帰網。
 *
 * この機能の最悪の壊れ方は演出のバグではなく「配信中にボタンが永久に死ぬ」なので、
 * 解除経路(期限・タイマー・start/stop/reset・達成・機能OFF・手動解除)と、
 * 暴走止め(120 秒の天井・連打の丸め・再接続の二重発火・時計の巻き戻し)を全部ここで固定する。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_TAP_LOCK,
  DEFAULT_TAP_LOCK_RULE,
  TAP_LOCK_ACTIVATIONS_MAX,
  TAP_LOCK_MAX_MS,
} from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 18, 12, 0, 0);
const LOCK_GIFT = '5555';
const DUR = 30;

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}, durationSec = DUR): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.giftFullCut.enabled = false;
  base.roulettes = [];
  return {
    ...base,
    enabled: true,
    initialValue: 1000,
    pressStep: 1,
    tapLock: {
      ...structuredClone(DEFAULT_TAP_LOCK),
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_TAP_LOCK_RULE), id: 'lock-1', giftId: LOCK_GIFT, durationSec }],
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

function lockGift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `m${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `視聴者${seq}` },
    giftId: LOCK_GIFT,
    giftName: 'Jam Gift',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

describe('解除経路 — どの出口からも必ず解ける', () => {
  it('start / reset / stop のどれでも消える', () => {
    for (const act of ['start', 'reset', 'stop'] as const) {
      const e = engine(cfg());
      e.start();
      e.handleEvent(lockGift());
      expect(e.get().tapLock).toBeDefined();
      e[act]();
      expect(e.get().tapLock).toBeUndefined();
    }
  });

  it('達成(押下せず 0 到達)でも消える', () => {
    // ルーレットや負の増減で押さずに 0 に届くことがある。ここでは
    // トリガーギフト自身の amountEach で 0 まで落とす。
    const c = cfg({ initialValue: 5 });
    c.tapLock.rules[0]!.amountEach = -10;
    const e = engine(c);
    e.start();
    e.handleEvent(lockGift());
    expect(e.get().status).toBe('achieved');
    expect(e.get().tapLock).toBeUndefined();
  });

  it('チャレンジ機能そのものを OFF にすると消える(逃げ道の維持)', () => {
    const c = cfg();
    const e = engine(c);
    e.start();
    e.handleEvent(lockGift());
    expect(e.get().tapLock).toBeDefined();
    c.enabled = false;
    e.onConfigChanged();
    expect(e.get().tapLock).toBeUndefined();
  });

  it('行の enabled を落としても**既存の封印は消さない**(到着時点で確定の規約)', () => {
    const c = cfg();
    const e = engine(c);
    e.start();
    e.handleEvent(lockGift());
    c.tapLock.rules[0]!.enabled = false;
    e.onConfigChanged();
    expect(e.get().tapLock).toBeDefined();
  });

  it('緊急解除(clearTapLockNow)はランに触れずに解く', () => {
    const e = engine(cfg());
    e.start();
    e.press();
    e.handleEvent(lockGift());
    const before = e.get();
    expect(e.clearTapLockNow()).toBe(true);
    const after = e.get();
    expect(after.tapLock).toBeUndefined();
    expect(after.value).toBe(before.value);
    expect(after.stats.presses).toBe(before.stats.presses);
    expect(after.startedMs).toBe(before.startedMs);
    // 封印していないときは false(呼び出し側が無駄な delta を配らない)。
    expect(e.clearTapLockNow()).toBe(false);
  });
});

describe('ワンショットタイマー — 配信終了後(2Hz tick なし)でも解ける', () => {
  it('凍結もアームも無く封印だけでもタイマーが張られ、期限で解除して通知する', () => {
    // **この機能で最も重要なテスト**。ここが緑でないと「配信が切れた瞬間に
    // 封印されていた」ケースでボタンが死んだまま次の配信へ持ち越される。
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = engine(cfg(), () => t);
      let nudged = 0;
      e.setOnFreezeExpired(() => nudged++);
      e.start();
      e.handleEvent(lockGift());
      expect(e.get().fxFreezeUntilMs).toBeNull(); // 凍結は張っていない
      // drainIfChanged も press もイベントも呼ばずに実時間だけ進める。
      t = NOW + DUR * 1000 + 25;
      vi.advanceTimersByTime(DUR * 1000 + 25);
      expect(e.get().tapLock).toBeUndefined();
      expect(nudged).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('早発(注入時計がまだ期限前)でも張り直し、遅れて必ず解除する', () => {
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = engine(cfg(), () => t);
      let nudged = 0;
      e.setOnFreezeExpired(() => nudged++);
      e.start();
      e.handleEvent(lockGift());
      // タイマーだけ発火させ、注入時計は期限の 200ms 手前に置く。
      t = NOW + DUR * 1000 - 200;
      vi.advanceTimersByTime(DUR * 1000 + 25);
      expect(e.get().tapLock).toBeDefined(); // まだ解除しないのが正しい
      // 時計が追いつけば、張り直したタイマーが解除する。
      t = NOW + DUR * 1000 + 500;
      vi.advanceTimersByTime(1000);
      expect(e.get().tapLock).toBeUndefined();
      expect(nudged).toBeGreaterThanOrEqual(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('重ねがけ — 延長するが 120 秒で頭打ち(2026-08-18 ユーザー決定)', () => {
  it('封印中の再着弾は残り時間へ加算する', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(lockGift());
    t = NOW + 10_000;
    e.handleEvent(lockGift());
    // 残り 20 秒 + 30 秒 = 期限は着弾時刻 + 50 秒。
    expect(e.get().tapLock?.endsAtMs).toBe(t + 50_000);
  });

  it('切れたあとの再着弾は now から数え直す(絶対期限に += しない)', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(lockGift());
    t = NOW + 60_000; // とっくに期限切れ
    e.handleEvent(lockGift());
    expect(e.get().tapLock?.endsAtMs).toBe(t + DUR * 1000);
  });

  it('何度重ねても残りは TAP_LOCK_MAX_MS を超えない', () => {
    const e = engine(cfg());
    e.start();
    for (let i = 0; i < 20; i += 1) e.handleEvent(lockGift());
    expect(e.get().tapLock!.endsAtMs - NOW).toBe(TAP_LOCK_MAX_MS);
  });

  it('連打コンボ(repeatCount)は尺に掛かるが上限本数で丸める', () => {
    const e = engine(cfg({}, 10));
    e.start();
    e.handleEvent(lockGift({ repeatCount: 17 }));
    expect(e.get().tapLock!.endsAtMs - NOW).toBe(10_000 * TAP_LOCK_ACTIVATIONS_MAX);
  });
});

describe('暴走止め', () => {
  it('再接続バックログの再生(同じ msgId)で二重に封印しない', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    const g = lockGift();
    e.handleEvent(g);
    t = NOW + 5000;
    e.handleEvent(g); // 同じ msgId
    expect(e.get().tapLock?.endsAtMs).toBe(NOW + DUR * 1000); // 延長されていない
  });

  it('時計の巻き戻しで期限が未来に取り残されない', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(lockGift());
    // NTP 巻き戻し: 注入時計が 10 分前へ飛ぶ。
    t = NOW - 600_000;
    e.drainIfChanged();
    expect(e.get().tapLock!.endsAtMs - t).toBeLessThanOrEqual(TAP_LOCK_MAX_MS);
  });

  it('尺は到着時点で焼き込む(途中で設定を変えても伸縮しない)', () => {
    let t = NOW;
    const c = cfg();
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(lockGift());
    const endsAt = e.get().tapLock!.endsAtMs;
    c.tapLock.rules[0]!.durationSec = 5;
    e.onConfigChanged();
    t = NOW + 10_000;
    e.drainIfChanged();
    expect(e.get().tapLock?.endsAtMs).toBe(endsAt); // 5 秒設定に縮まない
  });
});

describe('封印は演出ではなくゲームのルール', () => {
  it('モニターを閉じていても(fxAllowed=false)効く', () => {
    // カットイン凍結とは非対称。ここを「演出だから」と揃えると、モニターなしで
    // 運用している配信者にとって機能が丸ごと無効になる。
    const c = cfg();
    const e = new ChallengeEngine(() => c, () => NOW, () => 0, () => 0, () => undefined);
    e.setMonitorOpen(false);
    e.setFxCaps(false);
    e.start();
    e.handleEvent(lockGift());
    expect(e.get().tapLock?.endsAtMs).toBe(NOW + DUR * 1000);
    e.press();
    expect(e.get().value).toBe(1000);
    expect(e.get().tapLock?.blocked).toBe(1);
  });

  it('配信フォーマットは絶対時刻のみ・非封印時はキーごと省く', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    expect(e.get().tapLock).toBeUndefined();
    e.handleEvent(lockGift({ viewer: { userId: 'v1', nickname: 'なまえ' } }));
    const s = e.get();
    expect(s.tapLock).toEqual({
      startsAtMs: NOW,
      endsAtMs: NOW + DUR * 1000,
      blocked: 0,
      nickname: 'なまえ',
    });
    t = NOW + DUR * 1000;
    expect(e.drainIfChanged()!.tapLock).toBeUndefined();
  });
});
