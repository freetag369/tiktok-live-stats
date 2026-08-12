import { describe, expect, it } from 'vitest';
import { CHALLENGE_EFFECTS_MAX, DEFAULT_CHALLENGE, DEFAULT_GIFT_BAND_FX, DEFAULT_GIFT_CLIPS, DEFAULT_MINI_FX, DEFAULT_ROULETTE, DEFAULT_SE_SOUNDS, DEFAULT_SE_VOLUMES, drawRouletteIndex, effectiveSeVolume, GIFT_FX_FREEZE_MARGIN_MS, GIFT_FX_FREEZE_MAX_MS, LIKE_FX_WINDOW_MS, matchGiftBand, matchGiftRule, matchRouletteTrigger, ROULETTE_SEGMENTS_MAX, tierForDiamonds, validateChallengeConfig } from '@shared/challenge';
import type { ChallengeConfig, ChallengeResult } from '@shared/dto';
import type { GiftEvent, LikeEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // バンド演出(カットイン)は既定で有効だが、一致するとカウンタ凍結(fxFreeze)が
  // 始まり、時間を進めない既存テストのイベントが保留キューへ乗ってしまう。
  // ここでは無効にし、凍結を検査するテストだけが bandCfg() で明示的に有効化する。
  base.giftBandFx.enabled = false;
  return { ...base, enabled: true, ...over };
}

/** バンド演出(カットイン+凍結)を既定バンドで有効にした設定。 */
function bandCfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  return cfg({ giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX), ...over });
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

  it('likeStockCount / likeStockStep 欠損は既定(無効)へ、負値・過大は clamp する(後方互換)', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.likeStockCount;
    delete legacy.likeStockStep;
    const v = validateChallengeConfig(legacy);
    expect(v.likeStockCount).toBe(0);
    expect(v.likeStockStep).toBe(25);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, likeStockCount: -3 }).likeStockCount).toBe(0);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, likeStockCount: 500 }).likeStockCount).toBe(99);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, likeStockStep: 1e12 }).likeStockStep).toBe(999_999);
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
    expect(rs.stats).toEqual({ presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, rouletteSpins: 0 });
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

  it('いいねストック: 満杯でボーナス加算 + effect + stats、点灯数はリセット', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 3, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(30)); // ゲージ満タン3回 = ストック満杯1回
    const s = e.get();
    expect(s.value).toBe(140); // +15(いいね) +25(ストック)
    expect(s.stats.likeUp).toBe(15);
    expect(s.stats.likeStockUp).toBe(25);
    expect(s.likeGauge?.stock).toMatchObject({ count: 3, filled: 0, step: 25, fills: 1 });
    const fx = s.recentEffects.filter((x) => x.kind === 'stock-full');
    expect(fx).toHaveLength(1);
    expect(fx[0]).toMatchObject({ amount: 25, valueAfter: 140 });
  });

  it('いいねストック: 満杯未満は点灯だけでボーナス無し', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 3, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(25)); // 満タン2回 + 端数5
    const s = e.get();
    expect(s.value).toBe(110); // いいね分のみ
    expect(s.stats.likeStockUp).toBe(0);
    expect(s.likeGauge?.stock).toMatchObject({ filled: 2, fills: 0 });
    expect(s.recentEffects.filter((x) => x.kind === 'stock-full')).toHaveLength(0);
  });

  it('いいねストック: 1バッチで複数満杯を一括処理し、端数ストックが残る', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 2, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(50)); // 満タン5回 = 満杯2回 + ストック1個
    const s = e.get();
    expect(s.value).toBe(175); // +25(いいね5回) +50(ストック2回)
    expect(s.stats.likeStockUp).toBe(50);
    expect(s.likeGauge?.stock).toMatchObject({ filled: 1, fills: 2 });
    const fx = s.recentEffects.filter((x) => x.kind === 'stock-full');
    expect(fx).toHaveLength(1); // 一括でも effect は1件(amount に合算)
    expect(fx[0]).toMatchObject({ amount: 50 });
  });

  it('いいねストック: likeStockCount=0 / likeStockStep=0 では stock は null で不動', () => {
    const e1 = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 0, likeStockStep: 25 }));
    e1.start();
    e1.handleEvent(like(100));
    expect(e1.get().value).toBe(150); // いいね分のみ
    expect(e1.get().likeGauge?.stock).toBeNull();
    const e2 = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 3, likeStockStep: 0 }));
    e2.start();
    e2.handleEvent(like(100));
    expect(e2.get().value).toBe(150);
    expect(e2.get().likeGauge?.stock).toBeNull();
  });

  it('いいねストック: ゲージ無効(likeEvery=0)ならストックも動かない', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 0, likeStep: 5, likeStockCount: 2, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(100));
    expect(e.get().value).toBe(100);
    expect(e.get().likeGauge).toBeNull();
  });

  it('いいねストック: reset で点灯数は 0 に戻るが fills(満杯累計)は巻き戻らない', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 2, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(30)); // 満タン3回 = 満杯1回 + ストック1個
    expect(e.get().likeGauge?.stock).toMatchObject({ filled: 1, fills: 1 });
    e.reset();
    expect(e.get().likeGauge?.stock).toMatchObject({ filled: 0, fills: 1 });
    e.start();
    e.handleEvent(like(20)); // 満タン2回 = 満杯1回(繰り越し無しで溜め直し)
    expect(e.get().likeGauge?.stock).toMatchObject({ filled: 0, fills: 2 });
  });

  it('いいねストック: stop は点灯数を保持する(一時停止→再開で継続)', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 3, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(10)); // ストック1個
    e.stop();
    expect(e.get().likeGauge?.stock).toMatchObject({ filled: 1, fills: 0 });
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

// ── ギフトルーレット ─────────────────────────────────────────────────────────

/** ハートミー(既定トリガー)のギフトイベント。ライブ経路の再現で canonical は載せない。 */
function heartMe(over: Partial<GiftEvent> = {}): GiftEvent {
  return gift({ giftId: '7934', giftName: 'Heart Me', giftType: 4, ...over });
}

describe('drawRouletteIndex — 重み付き抽選', () => {
  const segs = DEFAULT_ROULETTE.segments; // weight 30/25/20/15/9/1(合計100)

  it('rand=0 は先頭、rand→1 は末尾(+1000 の 1%)に落ちる', () => {
    expect(drawRouletteIndex(segs, () => 0)).toBe(0);
    expect(drawRouletteIndex(segs, () => 0.999999)).toBe(5);
  });

  it('累積境界: 0.29999 は +5、ちょうど 0.3 は +10 側', () => {
    expect(drawRouletteIndex(segs, () => 0.29999)).toBe(0);
    expect(drawRouletteIndex(segs, () => 0.3)).toBe(1);
  });

  it('+1000(重み1)は 0.99 以上でだけ出る', () => {
    expect(drawRouletteIndex(segs, () => 0.989)).toBe(4);
    expect(drawRouletteIndex(segs, () => 0.99)).toBe(5);
  });

  it('weight 0 の行は選ばれない', () => {
    const s = [
      { amount: 5, weight: 0 },
      { amount: 10, weight: 1 },
    ];
    expect(drawRouletteIndex(s, () => 0)).toBe(1);
    expect(drawRouletteIndex(s, () => 0.9)).toBe(1);
  });

  it('全 weight 0 でもクラッシュせず末尾へ倒す(validate が既定へ戻すので通常来ない)', () => {
    const s = [
      { amount: 5, weight: 0 },
      { amount: 10, weight: 0 },
    ];
    expect(drawRouletteIndex(s, () => 0.5)).toBe(1);
  });
});

describe('matchRouletteTrigger — トリガーギフト判定', () => {
  it('ライブ経路の再現: canonical 未設定でも giftId 7934 で一致する(最重要)', () => {
    expect(matchRouletteTrigger(DEFAULT_ROULETTE, { giftId: '7934', giftName: 'Heart Me' })).toBe(true);
    expect(matchRouletteTrigger(DEFAULT_ROULETTE, { giftId: '7934' })).toBe(true);
  });

  it('giftId 不一致でもギフト名の小文字部分一致で拾う(ID変更の保険)', () => {
    expect(matchRouletteTrigger(DEFAULT_ROULETTE, { giftId: '9999', giftName: 'HEART ME!' })).toBe(true);
  });

  it('canonical 一致でも拾う(リプレイ/テスト経路)', () => {
    expect(matchRouletteTrigger(DEFAULT_ROULETTE, { giftId: '9999', canonical: 'heart_me' })).toBe(true);
  });

  it('どれにも一致しなければ false', () => {
    expect(matchRouletteTrigger(DEFAULT_ROULETTE, { giftId: '5655', giftName: 'Rose', canonical: 'rose' })).toBe(false);
  });

  it("'' のフィールドはマッチ条件として無効(空文字がなんにでも一致しない)", () => {
    const rl = { ...DEFAULT_ROULETTE, giftId: '', giftName: '', canonical: '' };
    expect(matchRouletteTrigger(rl, { giftId: '7934', giftName: 'Heart Me' })).toBe(false);
  });
});

describe('validateChallengeConfig — roulette', () => {
  it('roulette キー欠損(旧 settings.json)は既定(有効・ハートミー)へ', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.roulette;
    expect(validateChallengeConfig(legacy).roulette).toEqual(DEFAULT_ROULETTE);
  });

  it('enabled: false は保持される', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      roulette: { ...DEFAULT_ROULETTE, enabled: false },
    });
    expect(v.roulette.enabled).toBe(false);
  });

  it('segments 空・全 weight 0 は既定の盤面へ戻す(抽選不能を作らない)', () => {
    const empty = validateChallengeConfig({ ...DEFAULT_CHALLENGE, roulette: { ...DEFAULT_ROULETTE, segments: [] } });
    expect(empty.roulette.segments).toEqual(DEFAULT_ROULETTE.segments);
    const zero = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      roulette: { ...DEFAULT_ROULETTE, segments: [{ amount: 5, weight: 0 }] },
    });
    expect(zero.roulette.segments).toEqual(DEFAULT_ROULETTE.segments);
  });

  it('amount/weight を clamp し、行数は上限で切る', () => {
    const many = Array.from({ length: 20 }, () => ({ amount: -3, weight: 1e9 }));
    const v = validateChallengeConfig({ ...DEFAULT_CHALLENGE, roulette: { ...DEFAULT_ROULETTE, segments: many } });
    expect(v.roulette.segments).toHaveLength(ROULETTE_SEGMENTS_MAX);
    expect(v.roulette.segments[0]).toEqual({ amount: 1, weight: 999_999 });
  });

  it("direction は 'sub' 以外を 'add' に倒し、giftName/canonical は小文字化する", () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      roulette: { ...DEFAULT_ROULETTE, direction: 'wat', giftName: ' Heart Me ', canonical: ' HEART_ME ' },
    } as unknown);
    expect(v.roulette.direction).toBe('add');
    expect(v.roulette.giftName).toBe('heart me');
    expect(v.roulette.canonical).toBe('heart_me');
  });
});

describe('ChallengeEngine — ギフトルーレット', () => {
  /** rand 固定のエンジン。既定盤面なら rand=0 で +5、rand=0.995 で +1000。 */
  function rlEngine(c: ChallengeConfig = cfg(), rand: () => number = () => 0): ChallengeEngine {
    return new ChallengeEngine(() => c, () => NOW, rand);
  }

  it('トリガーで出目ちょうどが即時加算される(giftDefault の perDiamond +1 は併用されない)', () => {
    const e = rlEngine();
    e.start();
    expect(e.handleEvent(heartMe({ diamonds: 1 }))).toBe(true);
    const s = e.get();
    // rand=0 → 出目 +5。giftDefault が併用されると +6 になるので「ちょうど」を検査する。
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 5);
    expect(s.stats.rouletteSpins).toBe(1);
    expect(s.stats.giftUp).toBe(5);
    const fx = s.recentEffects[0]!;
    expect(fx.kind).toBe('roulette');
    expect(fx.amount).toBe(5);
    expect(fx.rouletteIndex).toBe(0);
    expect(fx.rouletteSegments).toEqual(DEFAULT_ROULETTE.segments.map((x) => x.amount));
    expect(fx.rouletteSegments![fx.rouletteIndex!]).toBe(Math.abs(fx.amount));
    expect(fx.valueAfter).toBe(s.value);
    expect(fx.nickname).toBe('gifter');
    expect(fx.giftName).toBe('Heart Me');
  });

  it('+1000(1%)の出目も同じ経路で乗る', () => {
    const e = rlEngine(cfg(), () => 0.995);
    e.start();
    e.handleEvent(heartMe());
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 1000);
  });

  it('同じ msgId は二重適用しない(再接続バックログ)', () => {
    const e = rlEngine();
    e.start();
    const g = heartMe();
    e.handleEvent(g);
    expect(e.handleEvent(g)).toBe(false);
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 5);
    expect(e.get().stats.rouletteSpins).toBe(1);
  });

  it("direction 'sub' は応援方向に効き、0 到達で CLEAR する", () => {
    const c = cfg({
      initialValue: 3,
      roulette: { ...structuredClone(DEFAULT_ROULETTE), direction: 'sub' as const },
    });
    const e = rlEngine(c); // rand=0 → 出目 5 → -5
    e.start();
    e.handleEvent(heartMe());
    const s = e.get();
    expect(s.value).toBe(0); // クランプ
    expect(s.status).toBe('achieved');
    expect(s.stats.giftDown).toBe(5);
    expect(s.recentEffects.map((x) => x.kind)).toEqual(['achieved', 'roulette']);
  });

  it('無効時は通常のギフト規則(giftDefault)に落ちる', () => {
    const c = cfg({ roulette: { ...structuredClone(DEFAULT_ROULETTE), enabled: false } });
    const e = rlEngine(c);
    e.start();
    e.handleEvent(heartMe({ diamonds: 1 }));
    const s = e.get();
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 1); // perDiamond +1
    expect(s.stats.rouletteSpins).toBe(0);
    expect(s.recentEffects[0]!.kind).toBe('gift');
  });

  it('running 以外では何もしない', () => {
    const e = rlEngine();
    expect(e.handleEvent(heartMe())).toBe(false);
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue);
  });

  it('トリガーギフトの💎もリザルトのランキングに数える', () => {
    const c = cfg({
      initialValue: 1,
      roulette: { ...structuredClone(DEFAULT_ROULETTE), direction: 'sub' as const },
    });
    const e = rlEngine(c);
    e.start();
    e.handleEvent(heartMe({ diamonds: 1, viewer: { userId: 'hm', nickname: 'HM' } }));
    const s = e.get();
    expect(s.status).toBe('achieved');
    expect(s.result!.gifts[0]).toMatchObject({ userId: 'hm', diamonds: 1 });
  });
});

// ── ダイヤ帯域カットイン(バンド演出)+ カウンタ凍結 ─────────────────────────

describe('matchGiftBand — ダイヤ帯域の写像', () => {
  const g = (diamonds: number, giftId = '5655', canonical?: string) => ({ giftId, canonical, diamonds });

  it('既定バンドの境界値(1〜50 / 51〜100 / 101〜600 / 601〜1000)', () => {
    const c = bandCfg();
    expect(matchGiftBand(c, g(1))?.id).toBe('band1');
    expect(matchGiftBand(c, g(50))?.id).toBe('band1');
    expect(matchGiftBand(c, g(51))?.id).toBe('band2');
    expect(matchGiftBand(c, g(100))?.id).toBe('band2');
    expect(matchGiftBand(c, g(101))?.id).toBe('band3');
    expect(matchGiftBand(c, g(600))?.id).toBe('band3');
    expect(matchGiftBand(c, g(601))?.id).toBe('band4');
    expect(matchGiftBand(c, g(1000))?.id).toBe('band4');
  });

  it("overflow 'top': 1000 超は最上位バンドを適用(ユニバース 44999💎 が無演出にならない)", () => {
    expect(matchGiftBand(bandCfg(), g(44_999))?.id).toBe('band4');
  });

  it("overflow 'off': 1000 超はバンド演出なし", () => {
    const c = bandCfg();
    c.giftBandFx.overflow = 'off';
    expect(matchGiftBand(c, g(1001))).toBeNull();
    expect(matchGiftBand(c, g(1000))?.id).toBe('band4'); // 帯域内は従来どおり
  });

  it('ハートミーは除外: giftId 7934(本線)と canonical heart_me(保険)の両方', () => {
    const c = bandCfg();
    expect(matchGiftBand(c, g(1, '7934'))).toBeNull();
    expect(matchGiftBand(c, g(1, '9999', 'heart_me'))).toBeNull();
    expect(matchGiftBand(c, g(1, '9999', 'HEART_ME'))).toBeNull(); // 大文字でも
  });

  it('無効化: giftBandFx.enabled=false / fxClipsEnabled=false / diamonds=0', () => {
    expect(matchGiftBand(cfg(), g(30))).toBeNull(); // cfg() は band 無効
    const c = bandCfg({ fxClipsEnabled: false });
    expect(matchGiftBand(c, g(30))).toBeNull();
    expect(matchGiftBand(bandCfg(), g(0))).toBeNull();
  });

  it("行の enabled=false / clip:'off' は一致から外れる(overflow の最上位からも)", () => {
    const c = bandCfg();
    c.giftBandFx.bands[0]!.enabled = false;
    expect(matchGiftBand(c, g(30))).toBeNull();
    c.giftBandFx.bands[3]!.clip = 'off';
    // band4 が無効なので最上位は band3 — 1000 超は band3 に落ちる
    expect(matchGiftBand(c, g(44_999))?.id).toBe('band3');
  });
});

describe('validateChallengeConfig — giftBandFx', () => {
  it('キー欠損(旧 settings.json)は既定(有効・4バンド)へ', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.giftBandFx;
    expect(validateChallengeConfig(legacy).giftBandFx).toEqual(DEFAULT_GIFT_BAND_FX);
  });

  it('enabled: false は保持される', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftBandFx: { ...structuredClone(DEFAULT_GIFT_BAND_FX), enabled: false },
    });
    expect(v.giftBandFx.enabled).toBe(false);
  });

  it('min>max の行は捨て、min/max/durationSec は clamp する', () => {
    const bf = structuredClone(DEFAULT_GIFT_BAND_FX);
    bf.bands = [
      { id: 'band1', min: 50, max: 1, clip: 'gift-band1', durationSec: 6, enabled: true, bgm: 'off' }, // min>max → 捨てる
      { id: 'band2', min: -5, max: 100, clip: 'gift-band2', durationSec: 0, enabled: true, bgm: 'off' },
      { id: 'band3', min: 101, max: 1e12, clip: 'gift-band3', durationSec: 100, enabled: true, bgm: 'off' },
    ];
    const v = validateChallengeConfig({ ...DEFAULT_CHALLENGE, giftBandFx: bf }).giftBandFx;
    expect(v.bands.map((b) => b.id)).toEqual(['band2', 'band3']);
    expect(v.bands[0]).toMatchObject({ min: 1, max: 100, durationSec: 1 });
    expect(v.bands[1]).toMatchObject({ min: 101, max: 9_999_999, durationSec: 30 });
  });

  it('未知のクリップ id は同じ id の既定バンドのクリップへ倒す', () => {
    const bf = structuredClone(DEFAULT_GIFT_BAND_FX);
    bf.bands[0]!.clip = 'no-such-clip';
    const v = validateChallengeConfig({ ...DEFAULT_CHALLENGE, giftBandFx: bf }).giftBandFx;
    expect(v.bands[0]!.clip).toBe('gift-band1');
  });

  it("overflow は 'off' 以外を 'top' に倒し、excludeGiftIds は文字列だけ通す", () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftBandFx: {
        ...structuredClone(DEFAULT_GIFT_BAND_FX),
        overflow: 'wat',
        excludeGiftIds: ['7934', '', 42, ' 5655 '],
      },
    } as unknown).giftBandFx;
    expect(v.overflow).toBe('top');
    expect(v.excludeGiftIds).toEqual(['7934', '5655']);
  });

  it('gift-band1〜4 は CHALLENGE_FX_CLIP_IDS に登録済み(validate に弾かれない)', () => {
    const v = validateChallengeConfig(DEFAULT_CHALLENGE).giftBandFx;
    expect(v.bands.map((b) => b.clip)).toEqual(['gift-band1', 'gift-band2', 'gift-band3', 'gift-band4']);
  });
});

describe('ChallengeEngine — カットイン凍結(fxFreeze)', () => {
  it('バンド一致で effect に fxBandClip/fxDurationMs が載り、凍結が始まる', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000 }), () => t);
    e.start();
    expect(e.handleEvent(gift({ diamonds: 30 }))).toBe(true);
    const s = e.get();
    expect(s.value).toBe(1030); // トリガー自身の値は即時適用(valueAfter 規約)
    expect(s.recentEffects[0]).toMatchObject({
      kind: 'gift',
      amount: 30,
      fxBandClip: 'gift-band1',
      fxDurationMs: 6000,
      valueAfter: 1030,
    });
    expect(s.fxFreezeUntilMs).toBe(NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS);
  });

  it('601〜1000 は band4(10秒)、1000 超も band4 が出る', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 100_000 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 700 }));
    expect(e.get().recentEffects[0]).toMatchObject({ fxBandClip: 'gift-band4', fxDurationMs: 10_000 });
    t += 20_000;
    e.drainIfChanged(); // 凍結解除
    e.handleEvent(gift({ diamonds: 44_999 }));
    expect(e.get().recentEffects[0]).toMatchObject({ fxBandClip: 'gift-band4', fxDurationMs: 10_000 });
  });

  it('durationSec は GIFT_FX_FREEZE_MAX_MS で頭打ちになる', () => {
    const c = bandCfg({ initialValue: 1000 });
    c.giftBandFx.bands[0]!.durationSec = 30;
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ diamonds: 10 }));
    expect(e.get().recentEffects[0]!.fxDurationMs).toBe(GIFT_FX_FREEZE_MAX_MS);
  });

  it('凍結中の follow / press は値に効かず、期限後に順序どおり適用される', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10, pressStep: 1 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1: 6 秒凍結
    t += 1000;
    expect(e.handleEvent(follow('f1'))).toBe(false); // 保留
    e.press(); // 保留
    expect(e.get().value).toBe(1030); // 凍結中は不変
    expect(e.get().stats.follows).toBe(0);
    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS; // 期限到達
    const drained = e.drainIfChanged(); // 2Hz tick が安全弁として解除
    expect(drained).not.toBeNull();
    expect(drained!.value).toBe(1030 + 10 - 1);
    expect(drained!.stats.follows).toBe(1);
    expect(drained!.stats.presses).toBe(1);
    expect(drained!.fxFreezeUntilMs).toBeNull();
  });

  it('凍結中も dedup(同一 msgId)とフォローの1回制限は効く', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    const dup = gift({ giftId: '8888', diamonds: 5 });
    expect(e.handleEvent(dup)).toBe(false); // 保留
    expect(e.handleEvent(dup)).toBe(false); // dedup(キューに積まれない)
    e.handleEvent(follow('f1'));
    expect(e.handleEvent(follow('f1'))).toBe(false); // 1回制限
    t = NOW + 30_000;
    e.drainIfChanged();
    // 5💎 は band1 一致で再凍結するが値は適用済み。follow は再凍結中も保留のまま
    // → さらに時間を進めて全部出す。
    t += 30_000;
    e.drainIfChanged();
    expect(e.get().value).toBe(1030 + 5 + 10);
    expect(e.get().stats.follows).toBe(1);
  });

  it('連続バンドギフトは直列 — 解除時のドレインで次のバンドが再凍結する', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1(6秒)
    t += 1000;
    e.handleEvent(gift({ giftId: '8888', diamonds: 80 })); // 保留(band2)
    t += 1000;
    e.handleEvent(follow('f1')); // 保留(band2 の後ろ)
    const freezeEnd1 = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    t = freezeEnd1;
    e.drainIfChanged();
    const s = e.get();
    expect(s.value).toBe(1030 + 80); // band2 の値は適用済み
    expect(s.stats.follows).toBe(0); // 再凍結でドレイン中断 — follow はまだ保留
    expect(s.recentEffects[0]).toMatchObject({ fxBandClip: 'gift-band2', fxDurationMs: 6000 });
    expect(s.fxFreezeUntilMs).toBe(freezeEnd1 + 6000 + GIFT_FX_FREEZE_MARGIN_MS);
    t = freezeEnd1 + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    e.drainIfChanged();
    expect(e.get().value).toBe(1110 + 10);
    expect(e.get().stats.follows).toBe(1);
  });

  it('凍結解除後の effect の atMs は解除時点の now(モニターの5秒ゲートで死なない)', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 700 })); // band4(10秒)
    t += 1000;
    e.handleEvent(follow('f1')); // 保留
    t = NOW + 10_000 + GIFT_FX_FREEZE_MARGIN_MS;
    e.drainIfChanged();
    const fx = e.get().recentEffects.find((x) => x.kind === 'follow')!;
    expect(fx.atMs).toBe(t); // 到着時刻(NOW+1000)ではなく解除時点
  });

  it('凍結中に stop すると保留分が強制適用され、値が残る', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    e.handleEvent(follow('f1'));
    e.handleEvent(gift({ giftId: '8888', diamonds: 80 })); // 再凍結候補も強制適用
    const s = e.stop();
    expect(s.value).toBe(1030 + 10 + 80);
    expect(s.fxFreezeUntilMs).toBeNull();
    expect(s.stats.follows).toBe(1);
  });

  it('凍結中に reset すると保留分は捨てられ、初期値へ戻る', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    e.handleEvent(follow('f1')); // 保留
    const s = e.reset();
    expect(s.value).toBe(1000);
    expect(s.fxFreezeUntilMs).toBeNull();
    // 再開後、保留分が漏れ出さない
    e.start();
    t = NOW + 60_000;
    e.drainIfChanged();
    expect(e.get().value).toBe(1000);
  });

  it('ドレイン中に 0 到達(achieved)したら残りの保留分は捨てる', () => {
    let t = NOW;
    const c = bandCfg({
      initialValue: 100,
      followStep: 10,
      giftRules: [{ id: 'r', minDiamonds: 0, mode: 'perDiamond', amount: -1 }],
    });
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // -30 → 70、band1 凍結
    expect(e.get().value).toBe(70);
    e.handleEvent(gift({ giftId: '8888', diamonds: 200 })); // 保留(-200 → 0 到達見込み)
    e.handleEvent(follow('f1')); // 保留 — 達成後なので適用されないはず
    t = NOW + 30_000;
    e.drainIfChanged();
    let s = e.get();
    // 200💎 は band3 一致で再凍結しつつ 0 到達 → achieved
    expect(s.value).toBe(0);
    expect(s.status).toBe('achieved');
    t += 30_000;
    e.drainIfChanged();
    s = e.get();
    expect(s.value).toBe(0); // follow の +10 は適用されない
    expect(s.stats.follows).toBe(0);
  });

  it('ハートミー(既定除外)はカットインも凍結も発生しない', () => {
    const c = bandCfg({ roulette: { ...structuredClone(DEFAULT_ROULETTE), enabled: false } });
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ giftId: '7934', giftName: 'Heart Me', diamonds: 1 }));
    const s = e.get();
    expect(s.recentEffects[0]!.kind).toBe('gift');
    expect(s.recentEffects[0]).not.toHaveProperty('fxBandClip');
    expect(s.fxFreezeUntilMs).toBeNull();
  });

  it('増減規則に一致しないギフト(giftDefault: null)でもバンド演出は出る', () => {
    const c = bandCfg({ initialValue: 1000, giftDefault: null, giftRules: [], flashMinDiamonds: null });
    const e = engine(c);
    e.start();
    expect(e.handleEvent(gift({ diamonds: 30 }))).toBe(true);
    const s = e.get();
    expect(s.value).toBe(1000); // 値は動かない
    expect(s.recentEffects[0]).toMatchObject({ kind: 'gift', amount: 0, fxBandClip: 'gift-band1' });
  });

  it('凍結はイベント入口でも解除される(2Hz tick を待たない)', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    // drainIfChanged を経ずに次のイベントが来た場合も、入口の flush で保留は空く。
    expect(e.handleEvent(follow('f1'))).toBe(true);
    expect(e.get().value).toBe(1040);
  });
});

describe('カットインBGM — effect への添付と validate', () => {
  it('バンド一致で effect に fxBandBgm が載る(既定は帯域対応の bgm-bandN)', () => {
    const e = engine(bandCfg({ initialValue: 1000 }));
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    expect(e.get().recentEffects[0]).toMatchObject({ fxBandClip: 'gift-band1', fxBandBgm: 'bgm-band1' });
  });

  it("帯域の bgm が 'off' なら fxBandBgm は載らない(カットイン自体は出る)", () => {
    const c = bandCfg({ initialValue: 1000 });
    c.giftBandFx.bands[0]!.bgm = 'off';
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    const fx = e.get().recentEffects[0]!;
    expect(fx.fxBandClip).toBe('gift-band1');
    expect(fx).not.toHaveProperty('fxBandBgm');
  });

  it('bgmEnabled=false なら全帯域で fxBandBgm は載らない(カットインは出る)', () => {
    const c = bandCfg({ initialValue: 1000 });
    c.giftBandFx.bgmEnabled = false;
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ diamonds: 700 }));
    const fx = e.get().recentEffects[0]!;
    expect(fx.fxBandClip).toBe('gift-band4');
    expect(fx).not.toHaveProperty('fxBandBgm');
  });

  it('validate: bgm キー欠損(前バージョンの settings.json)は同 id の既定 bgm へ', () => {
    const bf = structuredClone(DEFAULT_GIFT_BAND_FX);
    for (const b of bf.bands) delete (b as Partial<typeof b>).bgm;
    const v = validateChallengeConfig({ ...DEFAULT_CHALLENGE, giftBandFx: bf }).giftBandFx;
    expect(v.bands.map((b) => b.bgm)).toEqual(['bgm-band1', 'bgm-band2', 'bgm-band3', 'bgm-band4']);
  });

  it("validate: 未知の bgm id は既定へ、'off' と既知 id は保持", () => {
    const bf = structuredClone(DEFAULT_GIFT_BAND_FX);
    bf.bands[0]!.bgm = 'no-such-bgm';
    bf.bands[1]!.bgm = 'off';
    bf.bands[2]!.bgm = 'bgm-band4';
    const v = validateChallengeConfig({ ...DEFAULT_CHALLENGE, giftBandFx: bf }).giftBandFx;
    expect(v.bands[0]!.bgm).toBe('bgm-band1'); // 未知 → 既定
    expect(v.bands[1]!.bgm).toBe('off');
    expect(v.bands[2]!.bgm).toBe('bgm-band4'); // 既知の別バンド曲も保持
  });

  it('validate: bgmEnabled/bgmVolume — 欠損は既定(ON/70)、false は保持、範囲外は clamp', () => {
    const legacy = structuredClone(DEFAULT_GIFT_BAND_FX) as unknown as Record<string, unknown>;
    delete legacy.bgmEnabled;
    delete legacy.bgmVolume;
    const v = validateChallengeConfig({ ...DEFAULT_CHALLENGE, giftBandFx: legacy }).giftBandFx;
    expect(v.bgmEnabled).toBe(true);
    expect(v.bgmVolume).toBe(70);
    const w = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftBandFx: { ...structuredClone(DEFAULT_GIFT_BAND_FX), bgmEnabled: false, bgmVolume: 250 },
    }).giftBandFx;
    expect(w.bgmEnabled).toBe(false);
    expect(w.bgmVolume).toBe(100);
    const x = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftBandFx: { ...structuredClone(DEFAULT_GIFT_BAND_FX), bgmVolume: -5 },
    }).giftBandFx;
    expect(x.bgmVolume).toBe(0);
  });
});
