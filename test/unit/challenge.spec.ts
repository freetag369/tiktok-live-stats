import { describe, expect, it } from 'vitest';
import { CHALLENGE_EFFECTS_MAX, DEFAULT_CHALLENGE, DEFAULT_GIFT_CLIPS, DEFAULT_MINI_FX, DEFAULT_SE_SOUNDS, DEFAULT_SE_VOLUMES, effectiveSeVolume, LIKE_FX_WINDOW_MS, matchGiftRule, tierForDiamonds, validateChallengeConfig } from '@shared/challenge';
import type { ChallengeConfig, ChallengeResult } from '@shared/dto';
import type { GiftEvent, LikeEvent, SocialEvent } from '@shared/events';
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

function like(count: number, over: Partial<LikeEvent> = {}): LikeEvent {
  return {
    kind: 'like',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'l1', nickname: 'liker' },
    count,
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

  it('seEnabled / seVolume: 欠損は既定(ON/70)、false は保持、範囲外は clamp', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.seEnabled;
    delete legacy.seVolume;
    const v = validateChallengeConfig(legacy);
    expect(v.seEnabled).toBe(true);
    expect(v.seVolume).toBe(70);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, seEnabled: false }).seEnabled).toBe(false);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, seVolume: 250 }).seVolume).toBe(100);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, seVolume: -5 }).seVolume).toBe(0);
  });

  it('seSounds: 欠損は既定割り当て、未知の id は既定に戻し、off と既知 id は保持', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.seSounds;
    expect(validateChallengeConfig(legacy).seSounds).toEqual(DEFAULT_SE_SOUNDS);
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      seSounds: { ...DEFAULT_SE_SOUNDS, press: 'off', like: 'jingle-sax', follow: 'no-such-sound' },
    });
    expect(v.seSounds.press).toBe('off');
    expect(v.seSounds.like).toBe('jingle-sax');
    expect(v.seSounds.follow).toBe(DEFAULT_SE_SOUNDS.follow); // 未知は既定へ
    expect(v.seSounds['gift-t4']).toBe(DEFAULT_SE_SOUNDS['gift-t4']);
  });

  it('seVolumes: 欠損は既定(全100)、範囲外は clamp、非数値は既定、正常値は保持', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.seVolumes;
    expect(validateChallengeConfig(legacy).seVolumes).toEqual(DEFAULT_SE_VOLUMES);
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      seVolumes: { ...DEFAULT_SE_VOLUMES, press: 250, like: -5, follow: 'x', achieved: 40 },
    } as unknown);
    expect(v.seVolumes.press).toBe(100); // 過大は clamp
    expect(v.seVolumes.like).toBe(0); // 負値は 0
    expect(v.seVolumes.follow).toBe(100); // 非数値は既定
    expect(v.seVolumes.achieved).toBe(40); // 正常値は保持
  });

  it('effectiveSeVolume: 全体×個別。個別欠損は全体そのまま(後方互換)', () => {
    expect(effectiveSeVolume(70, 100)).toBe(70);
    expect(effectiveSeVolume(70, 40)).toBe(28);
    expect(effectiveSeVolume(70, undefined)).toBe(70); // 個別音量を持たない古い設定
    expect(effectiveSeVolume(70, 0)).toBe(0);
    expect(effectiveSeVolume(0, 100)).toBe(0);
    expect(effectiveSeVolume(250, 250)).toBe(100); // 両方 clamp
    expect(effectiveSeVolume(-5, -5)).toBe(0);
  });

  it('likeEvery / likeStep 欠損は既定(無効)へ、負値・過大は clamp する(後方互換)', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.likeEvery;
    delete legacy.likeStep;
    const v = validateChallengeConfig(legacy);
    expect(v.likeEvery).toBe(0);
    expect(v.likeStep).toBe(1);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, likeEvery: -5 }).likeEvery).toBe(0);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, likeStep: 1e12 }).likeStep).toBe(999_999);
  });

  it('fxClipsEnabled: 欠損は既定(ON)、false は保持', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.fxClipsEnabled;
    expect(validateChallengeConfig(legacy).fxClipsEnabled).toBe(true);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, fxClipsEnabled: false }).fxClipsEnabled).toBe(false);
  });

  it('giftClips: 欠損は既定割り当て、明示的な空配列は空のまま保持する', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.giftClips;
    expect(validateChallengeConfig(legacy).giftClips).toEqual(DEFAULT_GIFT_CLIPS);
    // 「全部の割り当てを消した」ユーザーの意思を既定で踏み潰さない。
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, giftClips: [] }).giftClips).toEqual([]);
  });

  it('miniFxEnabled / miniFx: 欠損は既定、未知 id は既定に戻す', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.miniFxEnabled;
    delete legacy.miniFx;
    const v = validateChallengeConfig(legacy);
    expect(v.miniFxEnabled).toBe(true);
    expect(v.miniFx).toEqual(DEFAULT_MINI_FX);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, miniFxEnabled: false }).miniFxEnabled).toBe(false);
    const w = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      miniFx: { ...DEFAULT_MINI_FX, press: 'hammer', follow: 'off', like: 'no-such-mini' },
    });
    expect(w.miniFx.press).toBe('hammer');
    expect(w.miniFx.follow).toBe('off');
    expect(w.miniFx.like).toBe(DEFAULT_MINI_FX.like); // 未知は既定へ
  });

  it('giftClips: mini 欠損は off(既存 settings.json との後方互換)', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftClips: [{ id: 'a', canonical: 'dragon', clip: 'dragon' }],
    });
    expect(v.giftClips[0]).toEqual({ id: 'a', canonical: 'dragon', clip: 'dragon', mini: 'off' });
  });

  it('giftClips: 未知のクリップ id は off へ、canonical は小文字化、壊れた行は捨てる', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftClips: [
        { id: 'a', canonical: 'DRAGON', clip: 'dragon', mini: 'off' },
        { id: 'b', canonical: 'palace', clip: 'no-such-clip', mini: 'off' },
        { id: 'c', canonical: 'lion', clip: 'off', mini: 'off' },
        { id: 'd', canonical: '', clip: 'dragon', mini: 'off' }, // canonical 空 → 捨てる
        { canonical: 'pegasus', clip: 'pegasus' }, // id 無し → 捨てる
        null,
      ],
    });
    expect(v.giftClips).toEqual([
      { id: 'a', canonical: 'dragon', clip: 'dragon', mini: 'off' },
      { id: 'b', canonical: 'palace', clip: 'off', mini: 'off' },
      { id: 'c', canonical: 'lion', clip: 'off', mini: 'off' },
    ]);
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

  it('ギフト演出に canonical が載る(モニターの演出クリップ選択に使う)', () => {
    const e = engine(cfg({ initialValue: 100_000 }));
    e.start();
    e.handleEvent(gift({ diamonds: 26999, giftName: 'ドラゴン', canonical: 'dragon' }));
    expect(e.get().recentEffects[0]).toMatchObject({ kind: 'gift', canonical: 'dragon' });
  });

  it('canonical 未解決のギフトは canonical を持たない(tier クリップに落ちる)', () => {
    const e = engine(cfg({ initialValue: 100_000 }));
    e.start();
    e.handleEvent(gift({ diamonds: 500, giftName: '謎のギフト' }));
    expect(e.get().recentEffects[0]).not.toHaveProperty('canonical');
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
    expect(rs.stats).toEqual({ presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0 });
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

  it('いいね: likeEvery=1, likeStep=1 でバッチ件数ぶん増える(1いいねで1個)', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 1, likeStep: 1 }));
    e.start();
    expect(e.handleEvent(like(3))).toBe(true);
    const s = e.get();
    expect(s.value).toBe(103);
    expect(s.stats.likeUp).toBe(3);
    expect(s.recentEffects[0]).toMatchObject({ kind: 'like', amount: 3 });
  });

  it('いいね: 端数は繰り越し、しきい値到達で加算される', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5 }));
    e.start();
    expect(e.handleEvent(like(4))).toBe(false); // 端数のみ — 不変
    expect(e.get().value).toBe(100);
    expect(e.handleEvent(like(7))).toBe(true); // 累計11 → 1ユニット、余り1
    expect(e.get().value).toBe(105);
    expect(e.handleEvent(like(9))).toBe(true); // 余り1+9=10 → もう1ユニット
    expect(e.get().value).toBe(110);
  });

  it('いいね: 1バッチで複数ユニットまとめて加算される', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5 }));
    e.start();
    e.handleEvent(like(35));
    const s = e.get();
    expect(s.value).toBe(115); // 3ユニット、余り5
    expect(s.stats.likeUp).toBe(15);
  });

  it('いいね: likeEvery=0(無効)/ likeStep=0 では何もしない', () => {
    const e1 = engine(cfg({ initialValue: 100, likeEvery: 0, likeStep: 1 }));
    e1.start();
    expect(e1.handleEvent(like(100))).toBe(false);
    expect(e1.get().value).toBe(100);
    const e2 = engine(cfg({ initialValue: 100, likeEvery: 1, likeStep: 0 }));
    e2.start();
    expect(e2.handleEvent(like(100))).toBe(false);
    expect(e2.get().value).toBe(100);
  });

  it('いいね: 同一 msgId は二重適用しない(再接続バックログ)', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 1, likeStep: 1 }));
    e.start();
    const l = like(5);
    expect(e.handleEvent(l)).toBe(true);
    expect(e.handleEvent(l)).toBe(false);
    expect(e.get().value).toBe(105);
  });

  it('いいね: 演出は1秒窓で合算される(値は即時、effect は窓ごとに1件)', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 100, likeEvery: 1, likeStep: 1 }), () => t);
    e.start();
    expect(e.handleEvent(like(2))).toBe(true); // 窓明け → effect + 即時 delta
    t += 300;
    expect(e.handleEvent(like(3))).toBe(true); // 窓内 → 値は即時増、effect は保留
    expect(e.get().value).toBe(105);
    expect(e.get().recentEffects.filter((x) => x.kind === 'like')).toHaveLength(1);
    t += 1000; // 窓明け — 2Hz tick(drainIfChanged)が保留分をまとめて出す
    const drained = e.drainIfChanged();
    expect(drained).not.toBeNull();
    const likes = drained!.recentEffects.filter((x) => x.kind === 'like');
    expect(likes).toHaveLength(2);
    expect(likes[0]).toMatchObject({ amount: 3 }); // 合算された保留分
  });

  it('いいね: start / reset で端数と保留演出がクリアされる', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5 }), () => t);
    e.start();
    e.handleEvent(like(9)); // 端数9
    e.reset();
    e.start();
    expect(e.handleEvent(like(9))).toBe(false); // 繰り越されていれば加算されてしまう
    expect(e.get().value).toBe(100);
    expect(e.get().stats.likeUp).toBe(0);
  });

  it('いいね: running 以外では無視される', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 1, likeStep: 1 }));
    expect(e.handleEvent(like(10))).toBe(false); // idle
    e.start();
    e.stop();
    expect(e.handleEvent(like(10))).toBe(false);
    expect(e.get().value).toBe(100);
  });

  it('likeGauge: 無効時(likeEvery=0 / likeStep=0)は null', () => {
    expect(engine(cfg({ likeEvery: 0, likeStep: 1 })).get().likeGauge).toBeNull();
    expect(engine(cfg({ likeEvery: 1, likeStep: 0 })).get().likeGauge).toBeNull();
    expect(engine(cfg({ likeEvery: 10, likeStep: 5 })).get().likeGauge).not.toBeNull();
  });

  it('likeGauge: 端数のみの like でも dirty が立ち、次の drainIfChanged に counter が乗る', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5 }));
    e.start();
    e.drainIfChanged(); // start 分を排出
    expect(e.handleEvent(like(4))).toBe(false); // 端数のみ — 即時 push はしない
    const drained = e.drainIfChanged(); // 2Hz 定期 tick 相当
    expect(drained).not.toBeNull();
    expect(drained!.likeGauge).toMatchObject({ counter: 4, every: 10, step: 5, fills: 0 });
    expect(drained!.value).toBe(100);
    expect(e.drainIfChanged()).toBeNull();
  });

  it('likeGauge: count=0 の like は dirty を立てない', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5 }));
    e.start();
    e.drainIfChanged();
    expect(e.handleEvent(like(0))).toBe(false);
    expect(e.drainIfChanged()).toBeNull();
  });

  it('likeGauge: 複数ユニット一括で fills が回数ぶん進み、端数が残る', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5 }));
    e.start();
    e.handleEvent(like(35)); // 3ユニット + 端数5
    expect(e.get().likeGauge).toMatchObject({ counter: 5, every: 10, step: 5, fills: 3 });
  });

  it('likeGauge: reset で counter は 0 に戻るが fills は巻き戻らない', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5 }));
    e.start();
    e.handleEvent(like(35)); // fills=3
    e.reset();
    expect(e.get().likeGauge).toMatchObject({ counter: 0, fills: 3 });
    e.start();
    e.handleEvent(like(12)); // fills=4, 端数2
    expect(e.get().likeGauge).toMatchObject({ counter: 2, fills: 4 });
  });

  it('likeGauge: stop は端数を保持する(一時停止→再開で継続)', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5 }));
    e.start();
    e.handleEvent(like(4));
    e.stop();
    expect(e.get().likeGauge).toMatchObject({ counter: 4, fills: 0 });
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

describe('ChallengeEffect.valueAfter — ダッシュボードのログが「いくつになったか」を言える', () => {
  it('press / follow / gift のいずれも適用後の値を持つ', () => {
    const e = engine(cfg({ initialValue: 100, pressStep: 3, followStep: 10 }));
    e.start();
    e.press();
    expect(e.get().recentEffects[0]).toMatchObject({ kind: 'press', amount: -3, valueAfter: 97 });
    e.handleEvent(follow('u1'));
    expect(e.get().recentEffects[0]).toMatchObject({ kind: 'follow', amount: 10, valueAfter: 107 });
    e.handleEvent(gift({ diamonds: 5, diamondEach: 5 }));
    expect(e.get().recentEffects[0]).toMatchObject({ kind: 'gift', amount: 5, valueAfter: 112 });
  });

  it('0 クランプされた達成時は valueAfter も 0', () => {
    const e = engine(cfg({ initialValue: 2, pressStep: 5 }));
    e.start();
    e.press();
    const fx = e.get().recentEffects;
    expect(fx.find((x) => x.kind === 'press')).toMatchObject({ amount: -5, valueAfter: 0 });
    expect(fx.find((x) => x.kind === 'achieved')).toMatchObject({ valueAfter: 0 });
  });

  it('いいねの合算演出は「演出が出た時点の値」を持つ', () => {
    let now = NOW;
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 1 }), () => now);
    e.start();
    e.handleEvent(like(10)); // 即時 effect: 101
    expect(e.get().recentEffects[0]).toMatchObject({ kind: 'like', amount: 1, valueAfter: 101 });
    // 合算窓の中の分は effect にならず、値だけ先に動く。
    e.handleEvent(like(10));
    expect(e.get().value).toBe(102);
    // 窓明けで合算ぶんが1件になる。値は既に 102 なのでそれを載せる。
    now += LIKE_FX_WINDOW_MS;
    const drained = e.drainIfChanged();
    expect(drained!.recentEffects[0]).toMatchObject({ kind: 'like', amount: 1, valueAfter: 102 });
  });
});

describe('ChallengeEffect.giftCount — 連打ギフトを1行で説明できる', () => {
  it('repeatCount が 2 以上のときだけ載る', () => {
    const e = engine(cfg({ initialValue: 100 }));
    e.start();
    e.handleEvent(gift({ repeatCount: 1, diamondEach: 1, diamonds: 1 }));
    expect(e.get().recentEffects[0]).not.toHaveProperty('giftCount');
    e.handleEvent(gift({ repeatCount: 7, diamondEach: 1, diamonds: 7 }));
    expect(e.get().recentEffects[0]).toMatchObject({ kind: 'gift', giftCount: 7, diamonds: 7 });
  });
});

describe('ChallengeEngine — CLEAR リザルト(ラン中の参加者 TOP5)', () => {
  /** 妨害でいくら増えていても1回で 0 まで落とせる押し方(達成させるためだけの道具)。 */
  const CLEAR_CFG = { initialValue: 100, pressStep: 1_000_000 };

  function clear(e: ChallengeEngine): ChallengeResult {
    const s = e.press();
    expect(s.status).toBe('achieved');
    expect(s.result).not.toBeNull();
    return s.result!;
  }

  it('result は idle / running 中は null、達成した瞬間に載る', () => {
    const e = engine(cfg(CLEAR_CFG));
    expect(e.get().result).toBeNull();
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    expect(e.get().result).toBeNull();
    expect(clear(e).gifts).toHaveLength(1);
  });

  it('ギフトはユーザーごとに 💎 を合算し、降順 TOP5 で切られる', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    const senders: Array<[string, number]> = [
      ['a', 10],
      ['b', 300],
      ['c', 50],
      ['d', 5],
      ['e', 1],
      ['f', 2],
    ];
    for (const [id, dia] of senders) {
      e.handleEvent(gift({ viewer: { userId: id, nickname: id.toUpperCase() }, diamonds: dia }));
    }
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 90 })); // a = 100
    const r = clear(e);
    expect(r.gifts.map((g) => [g.userId, g.diamonds])).toEqual([
      ['b', 300],
      ['a', 100],
      ['c', 50],
      ['d', 5],
      ['f', 2],
    ]);
    expect(r.participants).toBe(6); // e(1💎)は TOP5 圏外だが参加者には数える
  });

  it('カウント規則に一致しないギフトもランキングには載る', () => {
    const e = engine(cfg({ ...CLEAR_CFG, giftRules: [], giftDefault: null, flashMinDiamonds: null }));
    e.start();
    expect(e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 500 }))).toBe(false);
    expect(e.get().value).toBe(100); // カウントは動かない
    expect(clear(e).gifts).toEqual([{ userId: 'a', nickname: 'A', avatarUrl: null, diamonds: 500, likes: 0 }]);
  });

  it('0💎 のギフトはギフトランキングの行を作らない', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamondEach: 0, diamonds: 0 }));
    const r = clear(e);
    expect(r.gifts).toEqual([]);
    expect(r.participants).toBe(0);
  });

  it('いいねはユーザーごとに件数を合算し、降順 TOP5 で切られる', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    const likers: Array<[string, number]> = [
      ['a', 3],
      ['b', 30],
      ['c', 12],
      ['d', 7],
      ['e', 1],
      ['f', 2],
    ];
    for (const [id, n] of likers) {
      e.handleEvent(like(n, { viewer: { userId: id, nickname: id.toUpperCase() } }));
    }
    e.handleEvent(like(20, { viewer: { userId: 'a', nickname: 'A' } })); // a = 23
    expect(clear(e).likes.map((l) => [l.userId, l.likes])).toEqual([
      ['b', 30],
      ['a', 23],
      ['c', 12],
      ['d', 7],
      ['f', 2],
    ]);
  });

  it('いいね妨害が無効(likeEvery=0)でもイイネランキングは集計する', () => {
    const e = engine(cfg({ ...CLEAR_CFG, likeEvery: 0 }));
    e.start();
    expect(e.handleEvent(like(9, { viewer: { userId: 'a', nickname: 'A' } }))).toBe(false);
    const s = e.get();
    expect(s.value).toBe(100);
    expect(s.stats.likeUp).toBe(0);
    expect(s.likeGauge).toBeNull();
    expect(clear(e).likes).toEqual([{ userId: 'a', nickname: 'A', avatarUrl: null, diamonds: 0, likes: 9 }]);
  });

  it('同じ msgId の再配信(再接続バックログ)は1回だけ数える', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    const g = gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 20 });
    const l = like(5, { viewer: { userId: 'a', nickname: 'A' } });
    e.handleEvent(g);
    e.handleEvent(g);
    e.handleEvent(l);
    e.handleEvent(l);
    const r = clear(e);
    expect(r.gifts[0]).toMatchObject({ diamonds: 20 });
    expect(r.likes[0]).toMatchObject({ likes: 5 });
    expect(r.participants).toBe(1);
  });

  it('達成後は凍結される(以後のイベントで変わらない)', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    const first = clear(e);
    e.handleEvent(gift({ viewer: { userId: 'b', nickname: 'B' }, diamonds: 999 }));
    e.handleEvent(like(50, { viewer: { userId: 'b', nickname: 'B' } }));
    expect(e.get().result).toEqual(first);
  });

  it('start で前のランの参加者は消える', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'old', nickname: 'OLD' }, diamonds: 500 }));
    clear(e);
    e.start();
    expect(e.get().result).toBeNull();
    e.handleEvent(gift({ viewer: { userId: 'new', nickname: 'NEW' }, diamonds: 1 }));
    expect(clear(e).gifts.map((g) => g.userId)).toEqual(['new']);
  });

  it('reset で result は null に戻る / stop 中も載らない', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    clear(e);
    expect(e.stop().result).toBeNull();
    expect(e.reset().result).toBeNull();
  });

  it('同数は先に参加した方が上位(挿入順のタイブレーク)', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'first', nickname: 'F' }, diamonds: 50 }));
    e.handleEvent(gift({ viewer: { userId: 'second', nickname: 'S' }, diamonds: 50 }));
    expect(clear(e).gifts.map((g) => g.userId)).toEqual(['first', 'second']);
  });

  it('表示名: 後から来た値で更新し、未指定では潰さない。無ければ displayId → 空文字', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a' }, diamonds: 10 })); // 名前なし
    e.handleEvent(
      gift({ viewer: { userId: 'a', nickname: 'あとから', avatarUrl: 'http://x/a.png' }, diamonds: 1 })
    );
    e.handleEvent(gift({ viewer: { userId: 'a' }, diamonds: 1 })); // undefined で潰さない
    e.handleEvent(gift({ viewer: { userId: 'b', displayId: '@bee' }, diamonds: 5 }));
    e.handleEvent(gift({ viewer: { userId: 'c' }, diamonds: 3 }));
    const byId = new Map(clear(e).gifts.map((g) => [g.userId, g]));
    expect(byId.get('a')).toMatchObject({ nickname: 'あとから', avatarUrl: 'http://x/a.png' });
    expect(byId.get('b')).toMatchObject({ nickname: '@bee', avatarUrl: null });
    expect(byId.get('c')).toMatchObject({ nickname: '', avatarUrl: null });
  });

  it('参加者ゼロ(ボタンだけで達成)でも空のリザルトを返す', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    const r = clear(e);
    expect(r).toMatchObject({ participants: 0, gifts: [], likes: [], startedMs: NOW, atMs: NOW });
  });

  it('participants はギフトといいね両方出した人を1人として数える', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    e.handleEvent(like(4, { viewer: { userId: 'a', nickname: 'A' } }));
    const r = clear(e);
    expect(r.participants).toBe(1);
    expect(r.gifts[0]).toMatchObject({ diamonds: 10, likes: 4 });
    expect(r.likes[0]).toMatchObject({ diamonds: 10, likes: 4 });
  });

  it('ユニーク参加者が上限を超えても上位は残る(メモリ間引きの安全性)', () => {
    const e = engine(cfg(CLEAR_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'whale', nickname: 'WHALE' }, diamonds: 100_000 }));
    e.handleEvent(like(9_999, { viewer: { userId: 'fan', nickname: 'FAN' } }));
    for (let i = 0; i < 5000; i++) {
      e.handleEvent(like(1, { viewer: { userId: `mob${i}` } }));
    }
    const r = clear(e);
    expect(r.gifts[0]).toMatchObject({ userId: 'whale', diamonds: 100_000 });
    expect(r.likes[0]).toMatchObject({ userId: 'fan', likes: 9_999 });
  });
});
