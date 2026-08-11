import { describe, expect, it } from 'vitest';
import { CHALLENGE_EFFECTS_MAX, DEFAULT_CHALLENGE, matchGiftRule, tierForDiamonds, validateChallengeConfig } from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  return { ...structuredClone(DEFAULT_CHALLENGE), enabled: true, ...over };
}

let seq = 0;

function follow(userId = 'u1', over: Partial<SocialEvent> = {}): SocialEvent {
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: `viewer-${userId}` },
    ...over,
  };
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

function engine(c: ChallengeConfig = cfg(), now: () => number = () => NOW): ChallengeEngine {
  return new ChallengeEngine(() => c, now);
}

describe('validateChallengeConfig — 壊れた settings.json でも落ちない', () => {
  it('既定値をそのまま受理する', () => {
    expect(validateChallengeConfig(DEFAULT_CHALLENGE)).toEqual(DEFAULT_CHALLENGE);
  });

  it('非オブジェクトは既定へ', () => {
    expect(validateChallengeConfig(null)).toEqual(DEFAULT_CHALLENGE);
    expect(validateChallengeConfig('x')).toEqual(DEFAULT_CHALLENGE);
  });

  it('initialValue を clamp する', () => {
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, initialValue: -5 }).initialValue).toBe(1);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, initialValue: 1e12 }).initialValue).toBe(9_999_999);
  });

  it('mode 不正・amount 非有限の規則は捨てる', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftRules: [
        { id: 'ok', mode: 'fixed', amount: -10 },
        { id: 'bad-mode', mode: 'wat', amount: 1 },
        { id: 'bad-amount', mode: 'fixed', amount: Number.NaN },
      ],
    });
    expect(v.giftRules.map((r) => r.id)).toEqual(['ok']);
  });

  it('giftDefault null(無視)を保持する', () => {
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, giftDefault: null }).giftDefault).toBeNull();
  });
});

describe('matchGiftRule — 先頭一致・diamonds は再計算しない', () => {
  it('canonical 一致の規則が giftDefault より優先される', () => {
    const c = cfg({ giftRules: [{ id: 'r', canonical: 'rose', mode: 'fixed', amount: -50 }] });
    expect(matchGiftRule(c, { canonical: 'rose', giftId: '5655', diamonds: 1 })).toEqual({ amount: -50, flash: false });
  });

  it('2規則が一致するとき先頭のみ適用する', () => {
    const c = cfg({
      giftRules: [
        { id: 'a', minDiamonds: 10, mode: 'fixed', amount: -1 },
        { id: 'b', minDiamonds: 10, mode: 'fixed', amount: -999 },
      ],
    });
    expect(matchGiftRule(c, { giftId: 'x', diamonds: 50 })?.amount).toBe(-1);
  });

  it('perDiamond は diamonds × amount(四捨五入)', () => {
    const c = cfg({ giftRules: [{ id: 'r', minDiamonds: 0, mode: 'perDiamond', amount: -2 }] });
    expect(matchGiftRule(c, { giftId: 'x', diamonds: 30 })?.amount).toBe(-60);
  });

  it('既定(perDiamond +1)は妨害方向に増える', () => {
    expect(matchGiftRule(cfg(), { giftId: 'x', diamonds: 25 })?.amount).toBe(25);
  });

  it('giftDefault null なら無視、ただし flashMinDiamonds 以上は照明だけ出す', () => {
    const c = cfg({ giftDefault: null, flashMinDiamonds: 100 });
    expect(matchGiftRule(c, { giftId: 'x', diamonds: 50 })).toBeNull();
    expect(matchGiftRule(c, { giftId: 'x', diamonds: 100 })).toEqual({ amount: 0, flash: true });
  });

  it('flashMinDiamonds 以上は規則経由でも flash が立つ', () => {
    const c = cfg({ giftRules: [{ id: 'r', minDiamonds: 0, mode: 'fixed', amount: -1 }], flashMinDiamonds: 100 });
    expect(matchGiftRule(c, { giftId: 'x', diamonds: 99 })?.flash).toBe(false);
    expect(matchGiftRule(c, { giftId: 'x', diamonds: 100 })?.flash).toBe(true);
  });
});

describe('tierForDiamonds', () => {
  it('境界値', () => {
    expect(tierForDiamonds(0)).toBe(1);
    expect(tierForDiamonds(99)).toBe(1);
    expect(tierForDiamonds(100)).toBe(2);
    expect(tierForDiamonds(999)).toBe(2);
    expect(tierForDiamonds(1000)).toBe(3);
    expect(tierForDiamonds(4999)).toBe(3);
    expect(tierForDiamonds(5000)).toBe(4);
  });
});

describe('ChallengeEngine — 状態機械', () => {
  it('press で pressStep 減り、統計と演出が積まれる', () => {
    const e = engine(cfg({ initialValue: 100, pressStep: 3 }));
    e.start();
    const s = e.press();
    expect(s.value).toBe(97);
    expect(s.stats.presses).toBe(1);
    expect(s.recentEffects[0]).toMatchObject({ kind: 'press', amount: -3 });
  });

  it('idle / achieved 中の press は無視される(エラーにならない)', () => {
    const e = engine(cfg({ initialValue: 1 }));
    expect(e.press().stats.presses).toBe(0); // idle
    e.start();
    e.press(); // 1 -> 0 で達成
    const s = e.press(); // 達成後
    expect(s.status).toBe('achieved');
    expect(s.stats.presses).toBe(1);
  });

  it('0 でクランプされ、達成演出は1回だけ', () => {
    const e = engine(cfg({ initialValue: 3, pressStep: 5 }));
    e.start();
    const s = e.press();
    expect(s.value).toBe(0);
    expect(s.status).toBe('achieved');
    expect(s.recentEffects.filter((x) => x.kind === 'achieved')).toHaveLength(1);
  });

  it('フォローで followStep 増える(妨害)', () => {
    const e = engine(cfg({ initialValue: 100, followStep: 10 }));
    e.start();
    expect(e.handleEvent(follow('a'))).toBe(true);
    const s = e.get();
    expect(s.value).toBe(110);
    expect(s.stats.follows).toBe(1);
    expect(s.recentEffects[0]).toMatchObject({ kind: 'follow', amount: 10 });
  });

  it('同一ユーザーの2回目のフォローは無視する(付け外しスパム)', () => {
    const e = engine(cfg({ initialValue: 100, followStep: 10 }));
    e.start();
    e.handleEvent(follow('a'));
    expect(e.handleEvent(follow('a'))).toBe(false);
    expect(e.get().value).toBe(110);
  });

  it('share / other の social は無視する', () => {
    const e = engine(cfg({ initialValue: 100 }));
    e.start();
    expect(e.handleEvent(follow('a', { sub: 'share' }))).toBe(false);
    expect(e.handleEvent(follow('b', { sub: 'other' }))).toBe(false);
    expect(e.get().value).toBe(100);
  });

  it('running 以外ではイベントを無視する', () => {
    const e = engine(cfg({ initialValue: 100 }));
    expect(e.handleEvent(follow('a'))).toBe(false); // idle
    e.start();
    e.stop();
    expect(e.handleEvent(gift({ diamonds: 10 }))).toBe(false);
  });

  it('ギフトは e.diamonds をそのまま使う — diamondEach×repeatCount を再計算しない', () => {
    const e = engine(cfg({ initialValue: 1000 }));
    e.start();
    // 捏造イベント: diamondEach*repeatCount(=6) ≠ diamonds(=100)。
    // diamonds 側が使われることが再計算禁止の回帰テスト。
    e.handleEvent(gift({ diamondEach: 2, repeatCount: 3, diamonds: 100 }));
    expect(e.get().value).toBe(1100);
    expect(e.get().stats.giftUp).toBe(100);
  });

  it('減算ギフトで 0 到達すると達成する', () => {
    const c = cfg({ initialValue: 50, giftRules: [{ id: 'r', canonical: 'rose', mode: 'perDiamond', amount: -1 }] });
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ canonical: 'rose', diamonds: 60 }));
    const s = e.get();
    expect(s.value).toBe(0);
    expect(s.status).toBe('achieved');
    expect(s.stats.giftDown).toBe(60);
  });

  it('同一 msgId のギフトは二重適用しない(手動再接続のバックログ再配信)', () => {
    const e = engine(cfg({ initialValue: 1000 }));
    e.start();
    const g = gift({ diamonds: 50 });
    expect(e.handleEvent(g)).toBe(true);
    expect(e.handleEvent(g)).toBe(false);
    expect(e.get().value).toBe(1050);
    expect(e.get().stats.giftUp).toBe(50);
  });

  it('reset を跨いでも同一 msgId のギフトは数えない(古いバックログは新ランに入れない)', () => {
    const e = engine(cfg({ initialValue: 1000 }));
    e.start();
    const g = gift({ diamonds: 50 });
    e.handleEvent(g);
    e.reset();
    e.start();
    expect(e.handleEvent(g)).toBe(false);
    expect(e.get().value).toBe(1000);
  });

  it('達成後は follow / gift も無効(凍結)', () => {
    const e = engine(cfg({ initialValue: 1 }));
    e.start();
    e.press();
    expect(e.handleEvent(follow('x'))).toBe(false);
    expect(e.handleEvent(gift({ diamonds: 500 }))).toBe(false);
    expect(e.get().value).toBe(0);
  });

  it('flash 付きギフト演出が出る', () => {
    const e = engine(cfg({ initialValue: 1000, flashMinDiamonds: 100 }));
    e.start();
    e.handleEvent(gift({ diamonds: 150, giftName: 'Galaxy' }));
    expect(e.get().recentEffects[0]).toMatchObject({ kind: 'gift', amount: 150, flash: true, giftName: 'Galaxy' });
  });

  it('リングバッファは上限で最古を落とし、id は単調増加', () => {
    const e = engine(cfg({ initialValue: 10_000 }));
    e.start();
    for (let i = 0; i < CHALLENGE_EFFECTS_MAX + 5; i++) e.press();
    const s = e.get();
    expect(s.recentEffects).toHaveLength(CHALLENGE_EFFECTS_MAX);
    const ids = s.recentEffects.map((x) => x.id);
    expect(ids[0]).toBe(CHALLENGE_EFFECTS_MAX + 5); // 新しい順
    expect([...ids].sort((a, b) => b - a)).toEqual(ids);
  });

  it('reset しても effect id は巻き戻らない(モニターの冪等再生の前提)', () => {
    const e = engine(cfg({ initialValue: 100 }));
    e.start();
    e.press();
    const idBefore = e.get().recentEffects[0]!.id;
    e.reset();
    e.start();
    e.press();
    expect(e.get().recentEffects[0]!.id).toBeGreaterThan(idBefore);
  });

  it('drainIfChanged は変化時に1回だけ返し、get は dirty を落とさない', () => {
    const e = engine(cfg({ initialValue: 100 }));
    expect(e.drainIfChanged()).not.toBeNull(); // 生成直後は dirty(初期状態の配布)
    expect(e.drainIfChanged()).toBeNull();
    e.start();
    e.press();
    e.get(); // dirty を落とさない
    expect(e.drainIfChanged()).not.toBeNull();
    expect(e.drainIfChanged()).toBeNull();
  });

  it('start は初期化、stop は値を凍結、reset は初期値へ戻す', () => {
    const e = engine(cfg({ initialValue: 100 }));
    e.start();
    e.press();
    e.handleEvent(follow('a'));
    const stopped = e.stop();
    expect(stopped.value).toBe(109); // 凍結表示
    const rs = e.reset();
    expect(rs.value).toBe(100);
    expect(rs.stats).toEqual({ presses: 0, follows: 0, giftDown: 0, giftUp: 0 });
    // reset 後は同じユーザーのフォローがまた妨害になる
    e.start();
    expect(e.handleEvent(follow('a'))).toBe(true);
  });

  it('onConfigChanged は running 中でも dirty を立てる(タイトル変更の即時反映)', () => {
    const c = cfg({ initialValue: 100 });
    const e = engine(c);
    e.start();
    e.drainIfChanged();
    c.title = '新タイトル';
    e.onConfigChanged();
    const drained = e.drainIfChanged();
    expect(drained?.title).toBe('新タイトル');
    expect(drained?.value).toBe(100); // running 中は値は差し替えない
  });

  it('onConfigChanged は未開始のときだけ initialValue を差し替える', () => {
    const c = cfg({ initialValue: 100 });
    const e = engine(c);
    c.initialValue = 500;
    e.onConfigChanged();
    expect(e.get().value).toBe(500);
    e.start();
    e.press();
    c.initialValue = 900;
    e.onConfigChanged();
    expect(e.get().value).toBe(499); // running 中は不変
  });
});
