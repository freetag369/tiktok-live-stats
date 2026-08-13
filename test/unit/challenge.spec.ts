import { describe, expect, it, vi } from 'vitest';
import { CHALLENGE_EFFECTS_MAX, CHALLENGE_MONITOR_TOP_N, COMMENT_RULES_MAX, DEFAULT_CHALLENGE, DEFAULT_FAN_STAMP, DEFAULT_GIFT_BAND_FX, DEFAULT_GIFT_CLIPS, DEFAULT_GIFT_FULL_CUT, DEFAULT_GIFT_REPEAT_FX, DEFAULT_MINI_FX, DEFAULT_ROULETTE, DEFAULT_ROULETTE_SOUND, DEFAULT_SE_SOUNDS, DEFAULT_SE_VOLUMES, drawRouletteIndex, effectiveSeVolume, GIFT_FX_FREEZE_MARGIN_MS, GIFT_FX_FREEZE_MAX_MS, GIFT_FX_FREEZE_MAX_TOTAL_MS, GIFT_FX_REPEAT_MAX, GIFT_FX_REPEAT_MIN_MS, LIKE_FX_WINDOW_MS, matchFanStamp, matchGiftBand, matchGiftFullCut, matchGiftRule, migrateChallengeSeSounds, matchGiftTrigger, matchRoulette, matchRouletteTrigger, ROULETTE_LABEL_MAX, ROULETTE_QUEUE_MAX, ROULETTE_SEGMENTS_MAX, rouletteHeadline, ROULETTES_MAX, tierForDiamonds, validateChallengeConfig } from '@shared/challenge';
import type { ChallengeConfig, ChallengeResult, ChallengeRouletteConfig } from '@shared/dto';
import type { CommentEvent, GiftEvent, LikeEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // バンド演出(カットイン)は既定で有効だが、一致するとカウンタ凍結(fxFreeze)が
  // 始まり、時間を進めない既存テストのイベントが保留キューへ乗ってしまう。
  // ここでは無効にし、凍結を検査するテストだけが bandCfg() で明示的に有効化する。
  base.giftBandFx.enabled = false;
  // 全面カット(giftFullCut)も同じ理由で無効にする — 既定行はギフト名「バラ」
  // 「ローザ」に一致した瞬間に 5 秒の凍結を張るので、時間を進めない既存テストの
  // イベントが保留キューへ乗ってしまう。検査するテストだけ fullCutCfg() で有効化する。
  base.giftFullCut.enabled = false;
  return { ...base, enabled: true, ...over };
}

/** バンド演出(カットイン+凍結)を既定バンドで有効にした設定。 */
function bandCfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  return cfg({ giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX), ...over });
}

/** 全面カット(最優先カットイン)を既定行で有効にした設定。バンドも既定で有効。 */
function fullCutCfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  return cfg({
    giftFullCut: structuredClone(DEFAULT_GIFT_FULL_CUT),
    giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX),
    ...over,
  });
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

function comment(userId = 'c1', over: Partial<CommentEvent> = {}): CommentEvent {
  return {
    kind: 'comment',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: `viewer-${userId}` },
    content: 'がんばれ',
    isQuestion: false,
    ...over,
  };
}

function engine(c: ChallengeConfig = cfg(), now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now);
  // テスト既定は「モニター窓が開いていてカットインを再生できる」状態 —
  // 凍結はこの許可(monitorOpen && fxCaps)が立つときだけ張られる。
  // 許可なしの挙動は専用の describe(カットイン凍結の許可ゲート)で検証する。
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
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

  it('何時起き: 欠損は OFF/未設定、不正な HH:mm は null、正常値は素通し', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.wakeEnabled;
    delete legacy.wakeTime;
    const v = validateChallengeConfig(legacy);
    expect(v.wakeEnabled).toBe(false);
    expect(v.wakeTime).toBeNull();

    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, wakeEnabled: 'yes', wakeTime: 5 }).wakeTime).toBeNull();
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, wakeEnabled: 'yes' }).wakeEnabled).toBe(false);

    const ok = validateChallengeConfig({ ...DEFAULT_CHALLENGE, wakeEnabled: true, wakeTime: '05:30' });
    expect(ok.wakeEnabled).toBe(true);
    expect(ok.wakeTime).toBe('05:30');

    // 0 詰めなしと 24 時は手書きの settings.json でしか起きないが、null へ倒す。
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, wakeTime: '5:30' }).wakeTime).toBeNull();
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, wakeTime: '24:00' }).wakeTime).toBeNull();
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

  it('妨害スロットの既定は専用音で、validate がその id を落とさない', () => {
    // CHALLENGE_SE_SOUND_IDS への追加忘れの回帰テスト — 忘れると validateSeSounds が
    // 「未知の id」とみなして既定へ倒すので、既定自体が自分に戻り黙って一致してしまう。
    // 既定と無関係なスロット(press)へ入れて素通りするかを見るのが要点。
    expect(DEFAULT_SE_SOUNDS.like).toBe('like-jam');
    expect(DEFAULT_SE_SOUNDS.follow).toBe('follow-jam');
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      seSounds: { ...DEFAULT_SE_SOUNDS, press: 'like-jam', achieved: 'follow-jam' },
    });
    expect(v.seSounds.press).toBe('like-jam');
    expect(v.seSounds.achieved).toBe('follow-jam');
  });

  it('migrateChallengeSeSounds: 旧既定のときだけ寄せ、選択済み・移行済みは触らない', () => {
    const withSounds = (like: string, follow: string) => ({
      ...DEFAULT_CHALLENGE,
      seSounds: { ...DEFAULT_SE_SOUNDS, like, follow },
    });

    const migrated = migrateChallengeSeSounds(withSounds('pop', 'question'), 0);
    expect(migrated.seSounds.like).toBe('like-jam');
    expect(migrated.seSounds.follow).toBe('follow-jam');

    // ユーザーが自分で選んだ音は世代 0 でも不変。片方だけ旧既定なら片方だけ寄る。
    const partial = migrateChallengeSeSounds(withSounds('jingle-sax', 'question'), 0);
    expect(partial.seSounds.like).toBe('jingle-sax');
    expect(partial.seSounds.follow).toBe('follow-jam');

    const off = migrateChallengeSeSounds(withSounds('off', 'off'), 0);
    expect(off.seSounds.like).toBe('off');
    expect(off.seSounds.follow).toBe('off');

    // 移行済み(世代1)は旧既定を選び直していても書き換えない。
    const already = withSounds('pop', 'question');
    expect(migrateChallengeSeSounds(already, 1)).toBe(already); // 同一参照 = 無加工

    // 寄せ替え対象が無ければ新しいオブジェクトを作らない。
    const none = withSounds('jingle-sax', 'jingle-hit');
    expect(migrateChallengeSeSounds(none, 0)).toBe(none);

    // 入力を破壊しない(呼び出し側が元の設定を保持しているケースの担保)。
    const src = withSounds('pop', 'question');
    migrateChallengeSeSounds(src, 0);
    expect(src.seSounds.like).toBe('pop');
  });

  it('migrateChallengeSeSounds(v2): ルーレットの回転サウンドを旧既定のときだけ寄せる', () => {
    const old = {
      ...DEFAULT_CHALLENGE,
      seSounds: { ...DEFAULT_SE_SOUNDS, 'roulette-hit': 'jingle-hit' },
      rouletteSound: { ...DEFAULT_ROULETTE_SOUND, bgm: 'bgm-roulette1', spinSe: 'spin-reel1' },
    };
    const m = migrateChallengeSeSounds(old, 1);
    expect(m.seSounds['roulette-hit']).toBe('reel-confirm');
    expect(m.rouletteSound.bgm).toBe('off');
    expect(m.rouletteSound.spinSe).toBe('spin-reel2');
    // 音量は触らない(自分で下げている人の設定を戻さない)。
    expect(m.rouletteSound.bgmVolume).toBe(old.rouletteSound.bgmVolume);

    // 自分で選び直している設定は世代 1 でも不変。
    const picked = {
      ...DEFAULT_CHALLENGE,
      seSounds: { ...DEFAULT_SE_SOUNDS, 'roulette-hit': 'jingle-sax' },
      rouletteSound: { ...DEFAULT_ROULETTE_SOUND, bgm: 'bgm-band3', spinSe: 'off' },
    };
    expect(migrateChallengeSeSounds(picked, 1)).toBe(picked); // 同一参照 = 無加工

    // 移行済み(世代2)は旧既定を選び直していても書き換えない。
    expect(migrateChallengeSeSounds(old, 2)).toBe(old);
  });

  it('migrateChallengeSeSounds: 世代 0 は v1 と v2 の両方を通る(段が積まれている)', () => {
    const v0 = {
      ...DEFAULT_CHALLENGE,
      seSounds: { ...DEFAULT_SE_SOUNDS, like: 'pop', follow: 'question', 'roulette-hit': 'jingle-hit' },
      rouletteSound: { ...DEFAULT_ROULETTE_SOUND, bgm: 'bgm-roulette1', spinSe: 'spin-reel1' },
    };
    const m = migrateChallengeSeSounds(v0, 0);
    expect(m.seSounds.like).toBe('like-jam');
    expect(m.seSounds.follow).toBe('follow-jam');
    expect(m.seSounds['roulette-hit']).toBe('reel-confirm');
    expect(m.rouletteSound.bgm).toBe('off');
    expect(m.rouletteSound.spinSe).toBe('spin-reel2');
    // 入力は破壊しない。
    expect(v0.rouletteSound.bgm).toBe('bgm-roulette1');
  });

  it('rouletteSound の既定: BGM は鳴らさず、回転ループ音だけ鳴る', () => {
    expect(DEFAULT_ROULETTE_SOUND.bgm).toBe('off');
    expect(DEFAULT_ROULETTE_SOUND.spinSe).toBe('spin-reel2');
    // 停止まわりの3音は既定で全部鳴る(どれかが 'off' だと演出の合図が欠ける)。
    for (const slot of ['roulette', 'roulette-near', 'roulette-hit'] as const) {
      expect(DEFAULT_SE_SOUNDS[slot]).not.toBe('off');
    }
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

  it('miniFx: 既定を変えても既存 settings.json の割り当ては書き換えない', () => {
    // フォローの既定は 'hammer' → 'panic' へ変えたが、既に 'hammer' を持っている
    // 設定は「ユーザーが選んだ hammer」と区別できない。既定は新規設定と
    // 「簡易演出を既定に戻す」にだけ効く — ここを緩めると選択を黙って奪う。
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      miniFx: { ...DEFAULT_MINI_FX, follow: 'hammer' },
    });
    expect(v.miniFx.follow).toBe('hammer');
    expect(DEFAULT_MINI_FX.follow).toBe('panic');
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
    expect(rs.stats).toEqual({ presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, rouletteSpins: 0 });
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
    const t = NOW;
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

  it('いいねストック: 満杯は fxFreezeUntilMs を張らない(カットインは renderer 完結)', () => {
    // ストック着弾カットイン(stock-cutin.mp4、約5秒)はモニター側だけで据え置く設計。
    // worker まで凍結すると、モニター非表示・クリップ無効・動きの抑制の環境でも
    // press の手応えが数秒保留されてしまう。将来ここへ凍結を足すときは意図的に
    // このテストを壊すこと(MonitorView の STOCK_CUTIN_* と整合を取り直す)。
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 2, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(20)); // 満タン2回 = ストック満杯1回
    const s = e.get();
    expect(s.recentEffects.filter((x) => x.kind === 'stock-full')).toHaveLength(1);
    expect(s.fxFreezeUntilMs).toBeNull();
  });

  it('ストックスロット: 区間で最もいいねしたユーザーのアバターが載る(複数ユーザー合算)', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 3, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(6, { viewer: { userId: 'a', nickname: 'A', avatarUrl: 'https://cdn/a.jpg' } }));
    e.handleEvent(like(4, { viewer: { userId: 'b', nickname: 'B', avatarUrl: 'https://cdn/b.jpg' } }));
    const s = e.get().likeGauge?.stock;
    expect(s?.filled).toBe(1);
    expect(s?.slots).toEqual([{ avatarUrl: 'https://cdn/a.jpg', nickname: 'A' }]);
    expect(s?.lastFullSlots).toBeNull(); // まだ満杯していない
  });

  it('ストックスロット: 同数は区間内で先にいいねした方が勝つ(topRank と同じ規約)', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 3, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(5, { viewer: { userId: 'a', nickname: 'A', avatarUrl: 'https://cdn/a.jpg' } }));
    e.handleEvent(like(5, { viewer: { userId: 'b', nickname: 'B', avatarUrl: 'https://cdn/b.jpg' } }));
    expect(e.get().likeGauge?.stock?.slots).toEqual([{ avatarUrl: 'https://cdn/a.jpg', nickname: 'A' }]);
  });

  it('ストックスロット: 満杯で slots は消費され lastFullSlots に写る(FIFO)', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 2, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(10, { viewer: { userId: 'a', nickname: 'A', avatarUrl: 'https://cdn/a.jpg' } }));
    e.handleEvent(like(10, { viewer: { userId: 'b', nickname: 'B', avatarUrl: 'https://cdn/b.jpg' } }));
    const s = e.get().likeGauge?.stock;
    expect(s?.filled).toBe(0);
    expect(s?.slots).toEqual([]);
    expect(s?.lastFullSlots).toEqual([
      { avatarUrl: 'https://cdn/a.jpg', nickname: 'A' },
      { avatarUrl: 'https://cdn/b.jpg', nickname: 'B' },
    ]);
  });

  it('ストックスロット: 1バッチ複数満タンは全スロット同じ1位、アバター無しは null', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 3, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(20)); // 既定 viewer(avatarUrl 無し)で満タン2回
    const s = e.get().likeGauge?.stock;
    expect(s?.filled).toBe(2);
    expect(s?.slots).toEqual([
      { avatarUrl: null, nickname: 'liker' },
      { avatarUrl: null, nickname: 'liker' },
    ]);
  });

  it('ストックスロット: reset で slots は空、lastFullSlots は残す(演出参照の生存)', () => {
    const e = engine(cfg({ initialValue: 100, likeEvery: 10, likeStep: 5, likeStockCount: 2, likeStockStep: 25 }));
    e.start();
    e.handleEvent(like(20, { viewer: { userId: 'a', nickname: 'A', avatarUrl: 'https://cdn/a.jpg' } })); // 満杯1回
    e.handleEvent(like(10, { viewer: { userId: 'b', nickname: 'B', avatarUrl: 'https://cdn/b.jpg' } })); // +1点灯
    expect(e.get().likeGauge?.stock?.slots).toHaveLength(1);
    e.reset();
    const s = e.get().likeGauge?.stock;
    expect(s?.slots).toEqual([]);
    expect(s?.lastFullSlots).toEqual([
      { avatarUrl: 'https://cdn/a.jpg', nickname: 'A' },
      { avatarUrl: 'https://cdn/a.jpg', nickname: 'A' },
    ]);
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

describe('ChallengeEngine — モニターのライブランキング(runRank)', () => {
  /** リザルトと同じ「1回で 0 まで落とせる」押し方(達成させるためだけの道具)。 */
  const RANK_CFG = { initialValue: 100, pressStep: 1_000_000 };

  function ids(e: ChallengeEngine): string[] {
    return (e.get().runRank ?? []).map((r) => r.userId);
  }

  it('未開始・該当者なしではキーごと省く(delta を太らせない)', () => {
    const e = engine(cfg(RANK_CFG));
    expect(e.get().runRank).toBeUndefined();
    e.start();
    expect(e.get().runRank).toBeUndefined();
  });

  it('💎降順の TOP3 だけ載り、4位以下は載らない', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    for (const [id, d] of [['a', 10], ['b', 50], ['c', 30], ['d', 1]] as const) {
      e.handleEvent(gift({ viewer: { userId: id, nickname: id.toUpperCase() }, diamonds: d }));
    }
    expect(ids(e)).toEqual(['b', 'c', 'a']);
    expect(e.get().runRank).toHaveLength(CHALLENGE_MONITOR_TOP_N);
  });

  it('runRank は result.gifts の先頭3件と完全に一致する(同数のタイブレーク込み)', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    for (const [id, d] of [['a', 50], ['b', 30], ['c', 30], ['d', 20], ['e', 10]] as const) {
      e.handleEvent(gift({ viewer: { userId: id, nickname: id.toUpperCase() }, diamonds: d }));
    }
    const live = e.get().runRank!;
    const s = e.press();
    expect(s.status).toBe('achieved');
    // 同数の b/c は先に参加した b が上 — 両方が同じヘルパーを通る証拠。
    expect(live.map((r) => r.userId)).toEqual(['a', 'b', 'c']);
    expect(live).toEqual(s.result!.gifts.slice(0, CHALLENGE_MONITOR_TOP_N));
  });

  it('0💎 の送信者といいねだけの参加者は載らない', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'zero' }, diamondEach: 0, diamonds: 0 }));
    e.handleEvent(like(50, { viewer: { userId: 'liker' } }));
    expect(e.get().runRank).toBeUndefined();
  });

  it('reset で消える ← モニターに前ランの順位が残らないための本丸', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    expect(e.get().runRank).toHaveLength(1);
    expect(e.reset().runRank).toBeUndefined();
    expect(e.get().runRank).toBeUndefined();
  });

  it('start で前ランのぶんが消える', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    expect(e.start().runRank).toBeUndefined();
  });

  it('stop 後も残る(誤クリックで集計を失わない — 既存の runViewers の規約)', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    expect(e.stop().runRank).toHaveLength(1);
  });

  it('未開始 / 停止中に届いたギフトは数えない(ラン単位の集計)', () => {
    const e = engine(cfg(RANK_CFG));
    e.handleEvent(gift({ viewer: { userId: 'pre' }, diamonds: 10 }));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    e.stop();
    e.handleEvent(gift({ viewer: { userId: 'post' }, diamonds: 99_999 }));
    expect(ids(e)).toEqual(['a']);
  });

  it('達成後は動かない(リザルトの凍結と食い違わない)', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    const r = e.press().result!;
    e.handleEvent(gift({ viewer: { userId: 'late', nickname: 'LATE' }, diamonds: 99_999 }));
    expect(e.get().runRank).toEqual(r.gifts.slice(0, CHALLENGE_MONITOR_TOP_N));
  });

  it('増減規則に一致しないギフトでも順位は更新される(dirty を立てる)', () => {
    const e = engine(cfg({ ...RANK_CFG, giftRules: [], giftDefault: null, flashMinDiamonds: null }));
    e.start();
    e.drainIfChanged(); // start ぶんの dirty を落とす
    expect(e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 500 }))).toBe(false);
    const pushed = e.drainIfChanged();
    expect(pushed).not.toBeNull();
    expect(pushed!.value).toBe(100); // カウントは動かない
    expect(pushed!.runRank).toEqual([{ userId: 'a', nickname: 'A', avatarUrl: null, diamonds: 500, likes: 0 }]);
  });

  it('カットイン凍結中のギフトも順位には即反映される(値の適用だけ保留)', () => {
    const e = engine(bandCfg({ initialValue: 1000 }));
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 30 }));
    expect(e.get().fxFreezeUntilMs).not.toBeNull();
    e.handleEvent(gift({ viewer: { userId: 'b', nickname: 'B' }, diamonds: 5_000 }));
    expect(ids(e)).toEqual(['b', 'a']);
  });

  it('同一 msgId の再配信で二重に数えない(再接続バックログ)', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    const g = gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 });
    e.handleEvent(g);
    e.handleEvent(g);
    expect(e.get().runRank![0]!.diamonds).toBe(10);
  });

  it('メモリ間引きの直後に初参加した大口も1位に出る', () => {
    const e = engine(cfg(RANK_CFG));
    e.start();
    // 次の1人で間引きが発火する境界まで埋める(間引きは挿入の前に走る)。
    for (let i = 0; i < 4000; i++) e.handleEvent(like(1, { viewer: { userId: `mob${i}` } }));
    e.handleEvent(gift({ viewer: { userId: 'whale', nickname: 'WHALE' }, diamonds: 100_000 }));
    expect(e.get().runRank?.[0]).toMatchObject({ userId: 'whale', diamonds: 100_000 });
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

describe('validateChallengeConfig — rouletteSound', () => {
  it('キー欠損(旧 settings.json)は既定(鳴る)へ', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.rouletteSound;
    expect(validateChallengeConfig(legacy).rouletteSound).toEqual(DEFAULT_ROULETTE_SOUND);
  });

  it('型崩れは既定へ', () => {
    for (const bad of ['x', null, 42, []]) {
      const v = validateChallengeConfig({ ...DEFAULT_CHALLENGE, rouletteSound: bad } as unknown);
      expect(v.rouletteSound).toEqual(DEFAULT_ROULETTE_SOUND);
    }
  });

  it("未知の id は既定へ、'off' と既知 id は保持", () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteSound: { ...DEFAULT_ROULETTE_SOUND, bgm: 'no-such', spinSe: 'off' },
    });
    expect(v.rouletteSound.bgm).toBe(DEFAULT_ROULETTE_SOUND.bgm);
    expect(v.rouletteSound.spinSe).toBe('off');
  });

  it('band の曲は回転BGMとして選べる(選択肢の連結仕様)', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteSound: { ...DEFAULT_ROULETTE_SOUND, bgm: 'bgm-band3' },
    });
    expect(v.rouletteSound.bgm).toBe('bgm-band3');
  });

  it('回転音スロットに band の曲は入らない(id リストが別であることの回帰)', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteSound: { ...DEFAULT_ROULETTE_SOUND, spinSe: 'bgm-band1' },
    });
    expect(v.rouletteSound.spinSe).toBe(DEFAULT_ROULETTE_SOUND.spinSe);
  });

  it('音量は 0-100 に clamp、非数値は既定へ', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteSound: { ...DEFAULT_ROULETTE_SOUND, bgmVolume: 250, spinSeVolume: -5 },
    });
    expect(v.rouletteSound.bgmVolume).toBe(100);
    expect(v.rouletteSound.spinSeVolume).toBe(0);
    const nan = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteSound: { ...DEFAULT_ROULETTE_SOUND, bgmVolume: '70' },
    } as unknown);
    expect(nan.rouletteSound.bgmVolume).toBe(DEFAULT_ROULETTE_SOUND.bgmVolume);
  });
});

describe('validateChallengeConfig — roulettes', () => {
  it('roulettes/roulette どちらも無い(新規)は既定(ハートミー1件)へ', () => {
    const bare = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete bare.roulettes;
    expect(validateChallengeConfig(bare).roulettes).toEqual([DEFAULT_ROULETTE]);
  });

  it('旧 settings.json の単一 roulette は1件の配列へ移行し、盤面を保持する', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.roulettes;
    // 旧形式には id/label が無い。出目はユーザーが弄った値。
    legacy.roulette = { enabled: true, giftId: '7934', giftName: 'heart me', canonical: 'heart_me',
      segments: [{ amount: 7, weight: 3 }], direction: 'sub' };
    const v = validateChallengeConfig(legacy).roulettes;
    expect(v).toHaveLength(1);
    expect(v[0]!.segments).toEqual([{ amount: 7, weight: 3 }]);
    expect(v[0]!.direction).toBe('sub');
    // 移行分だけは既定の名前を継ぐ — でないと表示が実名 'Heart Me' に落ちる。
    expect(v[0]!.label).toBe('ハートミー');
    expect(v[0]!.id).toBe(DEFAULT_ROULETTE.id);
  });

  it('明示的な空配列は空のまま通す(既定を復活させない)', () => {
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, roulettes: [] }).roulettes).toEqual([]);
  });

  it('件数は ROULETTES_MAX で切る', () => {
    const many = Array.from({ length: ROULETTES_MAX + 5 }, (_, i) => ({ ...DEFAULT_ROULETTE, id: `x${i}` }));
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, roulettes: many }).roulettes).toHaveLength(ROULETTES_MAX);
  });

  it('id の欠損・重複は振り直す(UI の key と行ごとテスト再生の取り違え防止)', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      roulettes: [{ ...DEFAULT_ROULETTE }, { ...DEFAULT_ROULETTE }, { ...DEFAULT_ROULETTE, id: '' }],
    }).roulettes;
    expect(new Set(v.map((r) => r.id)).size).toBe(3);
    expect(v[0]!.id).toBe(DEFAULT_ROULETTE.id);
  });

  it('label は trim して上限長で切るが、空文字は空のまま残す', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      roulettes: [
        { ...DEFAULT_ROULETTE, id: 'a', label: '  バラ  ' },
        { ...DEFAULT_ROULETTE, id: 'b', label: '' },
        { ...DEFAULT_ROULETTE, id: 'c', label: 'あ'.repeat(ROULETTE_LABEL_MAX + 10) },
      ],
    }).roulettes;
    expect(v[0]!.label).toBe('バラ');
    // '' は「giftName へフォールバックせよ」というユーザーの意思。既定名で潰さない。
    expect(v[1]!.label).toBe('');
    expect(v[2]!.label).toHaveLength(ROULETTE_LABEL_MAX);
  });

  it('enabled: false は保持される', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      roulettes: [{ ...DEFAULT_ROULETTE, enabled: false }],
    });
    expect(v.roulettes[0]!.enabled).toBe(false);
  });

  it('segments 空・全 weight 0 は既定の盤面へ戻す(抽選不能を作らない)', () => {
    const empty = validateChallengeConfig({ ...DEFAULT_CHALLENGE, roulettes: [{ ...DEFAULT_ROULETTE, segments: [] }] });
    expect(empty.roulettes[0]!.segments).toEqual(DEFAULT_ROULETTE.segments);
    const zero = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      roulettes: [{ ...DEFAULT_ROULETTE, segments: [{ amount: 5, weight: 0 }] }],
    });
    expect(zero.roulettes[0]!.segments).toEqual(DEFAULT_ROULETTE.segments);
  });

  it('amount/weight を clamp し、出目の行数は上限で切る', () => {
    const many = Array.from({ length: 20 }, () => ({ amount: -3, weight: 1e9 }));
    const v = validateChallengeConfig({ ...DEFAULT_CHALLENGE, roulettes: [{ ...DEFAULT_ROULETTE, segments: many }] });
    expect(v.roulettes[0]!.segments).toHaveLength(ROULETTE_SEGMENTS_MAX);
    expect(v.roulettes[0]!.segments[0]).toEqual({ amount: 1, weight: 999_999 });
  });

  it("direction は 'sub' 以外を 'add' に倒し、giftName/canonical は小文字化する", () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      roulettes: [{ ...DEFAULT_ROULETTE, direction: 'wat', giftName: ' Heart Me ', canonical: ' HEART_ME ' }],
    } as unknown);
    expect(v.roulettes[0]!.direction).toBe('add');
    expect(v.roulettes[0]!.giftName).toBe('heart me');
    expect(v.roulettes[0]!.canonical).toBe('heart_me');
  });
});

describe('matchRoulette — 複数登録の先勝ち', () => {
  const mk = (rls: Partial<ChallengeRouletteConfig>[]): ChallengeConfig => ({
    ...DEFAULT_CHALLENGE,
    roulettes: rls.map((r, i) => ({ ...DEFAULT_ROULETTE, id: `r${i}`, ...r })),
  });

  it('上から順に評価し、最初に一致した1件を返す', () => {
    const cfg = mk([
      { id: 'rose', giftId: '5655', giftName: '', canonical: '', label: 'バラ' },
      { id: 'heart', giftId: '7934', giftName: '', canonical: '', label: 'ハートミー' },
    ]);
    expect(matchRoulette(cfg, { giftId: '7934' })?.id).toBe('heart');
    expect(matchRoulette(cfg, { giftId: '5655' })?.id).toBe('rose');
  });

  it('同じトリガーが複数あっても上の行が勝つ', () => {
    const cfg = mk([
      { id: 'first', giftId: '7934', giftName: '', canonical: '' },
      { id: 'second', giftId: '7934', giftName: '', canonical: '' },
    ]);
    expect(matchRoulette(cfg, { giftId: '7934' })?.id).toBe('first');
  });

  it('enabled: false の行は飛ばして次の行を見る', () => {
    const cfg = mk([
      { id: 'off', giftId: '7934', giftName: '', canonical: '', enabled: false },
      { id: 'on', giftId: '7934', giftName: '', canonical: '' },
    ]);
    expect(matchRoulette(cfg, { giftId: '7934' })?.id).toBe('on');
  });

  it('一致なし・0件は null(通常のギフト規則へ落ちる)', () => {
    expect(matchRoulette(mk([{ giftName: '', canonical: '' }]), { giftId: '5655' })).toBeNull();
    expect(matchRoulette({ ...DEFAULT_CHALLENGE, roulettes: [] }, { giftId: '7934' })).toBeNull();
  });
});

describe('rouletteHeadline — 見出しの文言', () => {
  it('label があればそれを前置きにする(実名が英語でも日本語表記を出せる)', () => {
    expect(rouletteHeadline({ rouletteLabel: 'ハートミー', giftName: 'Heart Me' })).toEqual({
      prefix: 'ハートミー ',
      suffix: 'がルーレット',
    });
  });

  it('label が無ければ実ギフト名へフォールバックする', () => {
    expect(rouletteHeadline({ giftName: 'Rose' }).prefix).toBe('Rose ');
  });

  it('どちらも無ければ前置きなし(従来の「○○がルーレット」)', () => {
    expect(rouletteHeadline({})).toEqual({ prefix: '', suffix: 'がルーレット' });
    expect(rouletteHeadline({ rouletteLabel: '  ', giftName: '' }).prefix).toBe('');
  });
});

describe('ChallengeEngine — ギフトルーレット', () => {
  /** rand 固定のエンジン。既定盤面なら rand=0 で +5、rand=0.995 で +1000。 */
  function rlEngine(
    c: ChallengeConfig = cfg(),
    rand: () => number = () => 0,
    fxRand: () => number = () => 0
  ): ChallengeEngine {
    const e = new ChallengeEngine(() => c, () => NOW, rand, fxRand);
    e.setMonitorOpen(true);
    e.setFxCaps(true);
    return e;
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
    // 表示名は effect に載せて自己完結させる(モニターは cfg を引き直さない)。
    expect(fx.rouletteLabel).toBe('ハートミー');
  });

  it('複数登録では上から順に最初に一致した1件だけが回る', () => {
    const c = cfg({
      roulettes: [
        { ...structuredClone(DEFAULT_ROULETTE), id: 'rose', label: 'バラ', giftId: '5655', giftName: '', canonical: '' },
        { ...structuredClone(DEFAULT_ROULETTE), id: 'heart', label: 'ハートミー', giftName: '', canonical: '' },
      ],
    });
    const e = rlEngine(c);
    e.start();
    e.handleEvent(heartMe({ diamonds: 1 }));
    const s = e.get();
    expect(s.stats.rouletteSpins).toBe(1);
    expect(s.recentEffects[0]!.rouletteLabel).toBe('ハートミー');
  });

  it('終盤の演出パターンが effect に載る(モニターは自分で引き直さない)', () => {
    // fxRand=0.999… → 'kick'。抽選の rand とは別の乱数源から引く。
    const e = rlEngine(cfg(), () => 0, () => 0.999999);
    e.start();
    e.handleEvent(heartMe({ diamonds: 1 }));
    expect(e.get().recentEffects[0]!.roulettePattern).toBe('kick');
  });

  it('演出パターンは出目に影響しない(乱数源が分かれている)', () => {
    // 同じ抽選乱数なら、演出乱数が何であっても出目は同一でなければならない。
    const amounts = [0, 0.5, 0.999999].map((fx) => {
      const e = rlEngine(cfg(), () => 0.995, () => fx);
      e.start();
      e.handleEvent(heartMe({ diamonds: 1 }));
      return e.get().recentEffects[0]!.amount;
    });
    expect(new Set(amounts).size).toBe(1);
    expect(amounts[0]).toBe(1000);
  });

  it('label 空の行は rouletteLabel を載せない(モニターは giftName へ落ちる)', () => {
    const c = cfg({ roulettes: [{ ...structuredClone(DEFAULT_ROULETTE), label: '' }] });
    const e = rlEngine(c);
    e.start();
    e.handleEvent(heartMe({ diamonds: 1 }));
    expect(e.get().recentEffects[0]!.rouletteLabel).toBeUndefined();
  });

  it('roulettes が空でも壊れず、通常のギフト規則に落ちる', () => {
    const e = rlEngine(cfg({ roulettes: [] }));
    e.start();
    e.handleEvent(heartMe({ diamonds: 1 }));
    const s = e.get();
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 1); // perDiamond +1
    expect(s.stats.rouletteSpins).toBe(0);
    expect(s.recentEffects[0]!.kind).toBe('gift');
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
      roulettes: [{ ...structuredClone(DEFAULT_ROULETTE), direction: 'sub' as const }],
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
    const c = cfg({ roulettes: [{ ...structuredClone(DEFAULT_ROULETTE), enabled: false }] });
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
      roulettes: [{ ...structuredClone(DEFAULT_ROULETTE), direction: 'sub' as const }],
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
    const t = NOW;
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
    const t = NOW;
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
    const c = bandCfg({ roulettes: [] });
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

describe('ChallengeEngine — カットイン凍結の許可ゲート(モニターの再生能力)', () => {
  it('許可なし(既定)ではバンド一致でも凍結しない — effect の焼き込みは変わらない', () => {
    // engine() ヘルパーを使わず素で作る = monitorOpen/fxCaps とも false。
    const c = bandCfg({ initialValue: 1000 });
    const e = new ChallengeEngine(() => c, () => NOW);
    e.start();
    expect(e.handleEvent(gift({ diamonds: 30 }))).toBe(true);
    const s = e.get();
    expect(s.value).toBe(1030);
    expect(s.recentEffects[0]).toMatchObject({ kind: 'gift', fxBandClip: 'gift-band1' });
    expect(s.fxFreezeUntilMs).toBeNull();
  });

  it('片翼だけ(窓は開いたが reduced-motion 等で再生不可)でも凍結しない', () => {
    const c = bandCfg({ initialValue: 1000 });
    const e = new ChallengeEngine(() => c, () => NOW);
    e.setMonitorOpen(true); // fxCaps は false のまま
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    expect(e.get().fxFreezeUntilMs).toBeNull();
  });

  it('凍結中にモニターが閉じたら即時解除され、保留分が適用される', () => {
    const t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1 凍結
    e.handleEvent(follow('f1')); // 保留
    expect(e.get().value).toBe(1030);
    expect(e.setMonitorOpen(false)).toBe(true); // 状態が変わった → nudge の合図
    const s = e.get();
    expect(s.fxFreezeUntilMs).toBeNull();
    expect(s.value).toBe(1040);
    expect(s.stats.follows).toBe(1);
  });

  it('凍結中に fxCaps が落ちても同様に即時解除される。変化なしの再申告は false', () => {
    const e = engine(bandCfg({ initialValue: 1000 }), () => NOW);
    e.start();
    expect(e.setFxCaps(true)).toBe(false); // engine() で確立済み → 変化なし
    e.handleEvent(gift({ diamonds: 30 }));
    expect(e.get().fxFreezeUntilMs).not.toBeNull();
    expect(e.setFxCaps(false)).toBe(true);
    expect(e.get().fxFreezeUntilMs).toBeNull();
  });
});

describe('ChallengeEngine — 凍結ドレインの演出合算(coalesce)', () => {
  it('凍結中の press×20 は1件に畳まれ、履歴が押し流されない', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, pressStep: 1 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1 凍結
    for (let i = 0; i < 20; i++) e.press(); // 全部保留
    expect(e.get().value).toBe(1030);
    t = NOW + 30_000;
    e.drainIfChanged();
    const s = e.get();
    expect(s.value).toBe(1030 - 20);
    const presses = s.recentEffects.filter((x) => x.kind === 'press');
    expect(presses).toHaveLength(1);
    expect(presses[0]).toMatchObject({ amount: -20, coalesced: 20, valueAfter: 1010 });
    // ring(12件)から他の演出が押し流されていない
    expect(s.recentEffects.some((x) => x.kind === 'gift')).toBe(true);
  });

  it('同じギフトの連投は canonical 単位で1件に畳まれ、diamonds/giftCount が合算される', () => {
    let t = NOW;
    // roulettes: [] — 既定のハートミー・ルーレットに食われないように。
    // Heart Me は既定でバンド除外なので、ドレインを中断させず畳まれる側になる。
    const e = engine(bandCfg({ initialValue: 1000, roulettes: [] }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1 凍結
    for (let i = 0; i < 5; i++) {
      e.handleEvent(gift({ giftId: '7934', giftName: 'Heart Me', diamonds: 1, repeatCount: 2 }));
    }
    t = NOW + 30_000;
    e.drainIfChanged();
    const s = e.get();
    const hearts = s.recentEffects.filter((x) => x.kind === 'gift' && x.giftName === 'Heart Me');
    expect(hearts).toHaveLength(1);
    expect(hearts[0]).toMatchObject({ amount: 5, coalesced: 5, diamonds: 5, giftCount: 10 });
    expect(hearts[0]).not.toHaveProperty('fxBandClip');
    expect(s.value).toBe(1030 + 5);
  });

  it('コメントは keyword 単位で畳まれる', () => {
    let t = NOW;
    const e = engine(
      bandCfg({
        initialValue: 1000,
        commentRules: [
          { id: 'c1', keyword: 'おやすみ', amount: 5 },
          { id: 'c2', keyword: 'ねむい', amount: 3 },
        ],
      }),
      () => t
    );
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // 凍結
    e.handleEvent(comment('u1', { content: 'おやすみ〜' }));
    e.handleEvent(comment('u2', { content: 'もうねむい' }));
    e.handleEvent(comment('u3', { content: 'おやすみなさい' }));
    t = NOW + 30_000;
    e.drainIfChanged();
    const s = e.get();
    const comments = s.recentEffects.filter((x) => x.kind === 'comment');
    expect(comments).toHaveLength(2);
    const oyasumi = comments.find((x) => x.commentKeyword === 'おやすみ')!;
    expect(oyasumi).toMatchObject({ amount: 10, coalesced: 2 });
    const nemui = comments.find((x) => x.commentKeyword === 'ねむい')!;
    expect(nemui.amount).toBe(3);
    expect(nemui).not.toHaveProperty('coalesced'); // 1件グループは原型のまま
  });

  it('1件だけのグループには coalesced が付かない(既存挙動の互換)', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    e.handleEvent(follow('f1'));
    t = NOW + 30_000;
    e.drainIfChanged();
    const f = e.get().recentEffects.find((x) => x.kind === 'follow')!;
    expect(f.amount).toBe(10);
    expect(f).not.toHaveProperty('coalesced');
  });

  it('ドレインが再凍結で中断しても、そこまでの分は畳まれて出る', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, pressStep: 1 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1 凍結
    e.press();
    e.press();
    e.press();
    e.handleEvent(gift({ giftId: '8888', diamonds: 80 })); // band2 — ドレイン中断役
    e.press();
    e.press();
    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    e.drainIfChanged();
    let s = e.get();
    const press1 = s.recentEffects.find((x) => x.kind === 'press')!;
    expect(press1).toMatchObject({ amount: -3, coalesced: 3 });
    expect(s.recentEffects[0]).toMatchObject({ kind: 'gift', fxBandClip: 'gift-band2' });
    expect(s.fxFreezeUntilMs).not.toBeNull(); // 再凍結中
    t += 30_000;
    e.drainIfChanged();
    s = e.get();
    expect(s.recentEffects[0]).toMatchObject({ kind: 'press', amount: -2, coalesced: 2 });
    expect(s.value).toBe(1030 + 80 - 5);
  });

  it('凍結中は like 合算(flushLikeFx)も保留される', () => {
    let t = NOW;
    const e = engine(bandCfg({ initialValue: 1000, likeEvery: 1, likeStep: 2 }), () => t);
    e.start();
    const likeCount = (): number => e.get().recentEffects.filter((x) => x.kind === 'like').length;
    e.handleEvent(like(1)); // 窓の起点 — 即時 push
    expect(likeCount()).toBe(1);
    t += 100;
    e.handleEvent(like(1, { viewer: { userId: 'l2', nickname: 'liker2' } })); // 窓内 → pending
    e.handleEvent(gift({ diamonds: 30 })); // band1 凍結
    t = NOW + 2000; // 合算窓は明けたがまだ凍結中
    e.drainIfChanged();
    expect(likeCount()).toBe(1); // 凍結中は出ない
    t = NOW + 100 + 6000 + GIFT_FX_FREEZE_MARGIN_MS; // ギフト到着(NOW+100)基準の期限
    e.drainIfChanged(); // 解除 → flushLikeFx
    expect(likeCount()).toBe(2);
    expect(e.get().value).toBe(1000 + 2 + 2 + 30);
  });
});

describe('ChallengeEngine — stop は達成させない(一時停止の意味論)', () => {
  it('凍結中の保留分に 0 到達が含まれても、stop 後は idle・リザルト無し・achieved 演出無し', () => {
    const c = bandCfg({
      initialValue: 100,
      giftRules: [{ id: 'r', minDiamonds: 0, mode: 'perDiamond', amount: -1 }],
    });
    const e = engine(c, () => NOW);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // -30 → 70、band1 凍結
    e.handleEvent(gift({ giftId: '8888', diamonds: 200 })); // 保留(適用で 0 到達)
    const s = e.stop();
    expect(s.status).toBe('idle');
    expect(s.value).toBe(0); // 値は全量適用済み
    expect(s.achievedMs).toBeNull();
    expect(s.result).toBeNull();
    expect(s.recentEffects.some((x) => x.kind === 'achieved')).toBe(false);
    // 再開は普通にできる
    expect(e.start().status).toBe('running');
  });
});

describe('ChallengeEngine — 凍結期限のワンショットタイマー', () => {
  it('イベントも 2Hz tick も止まっていても、期限タイマーが解除して通知する', () => {
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
      let nudged = 0;
      e.setOnFreezeExpired(() => nudged++);
      e.start();
      e.handleEvent(gift({ diamonds: 30 })); // band1: 6.5 秒凍結
      e.handleEvent(follow('f1')); // 保留
      // drainIfChanged もイベントも呼ばずに実時間だけ進める(配信終了後の状況)。
      t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS + 25;
      vi.advanceTimersByTime(6000 + GIFT_FX_FREEZE_MARGIN_MS + 25);
      expect(e.get().fxFreezeUntilMs).toBeNull();
      expect(e.get().value).toBe(1040);
      expect(nudged).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reset で保留とタイマーごと片付く(発火しても何も起きない)', () => {
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = engine(bandCfg({ initialValue: 1000, followStep: 10 }), () => t);
      let nudged = 0;
      e.setOnFreezeExpired(() => nudged++);
      e.start();
      e.handleEvent(gift({ diamonds: 30 }));
      e.handleEvent(follow('f1'));
      e.reset();
      t = NOW + 60_000;
      vi.advanceTimersByTime(60_000);
      expect(nudged).toBe(0);
      expect(e.get().value).toBe(1000);
    } finally {
      vi.useRealTimers();
    }
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

// ── お助け機能(ファンスタンプ) ────────────────────────────────────────────────

/** ファンスタンプ想定のギフト(クリエイター専用カスタムギフト・1💎・streakable)。 */
function fanStamp(over: Partial<GiftEvent> = {}): GiftEvent {
  return gift({ giftId: '76637', giftName: 'おやすみトッポ', giftType: 1, ...over });
}

/** お助けを giftId '76637' に割り当てた設定。 */
function fsCfg(
  over: Partial<ChallengeConfig['fanStamp']> = {},
  c: Partial<ChallengeConfig> = {}
): ChallengeConfig {
  return cfg({ fanStamp: { ...structuredClone(DEFAULT_FAN_STAMP), giftId: '76637', ...over }, ...c });
}

describe('matchGiftTrigger / matchFanStamp — ファンスタンプの判定', () => {
  it('ライブ経路(canonical 未代入)でも giftId 一致で拾う', () => {
    // normalize.ts は名寄せ結果をイベントに載せない — giftId が本線であることの固定。
    expect(matchFanStamp(fsCfg(), { giftId: '76637', giftName: 'おやすみトッポ' })).not.toBeNull();
  });

  it('giftId が変わっても giftName の小文字部分一致で拾う', () => {
    const c = fsCfg({ giftId: '', giftName: 'トッポ' });
    expect(matchFanStamp(c, { giftId: '99999', giftName: 'おやすみトッポ' })).not.toBeNull();
  });

  it('canonical 一致で拾う(リプレイ/テスト経路)', () => {
    const c = fsCfg({ giftId: '', canonical: 'oyasumi_toppo' });
    expect(matchFanStamp(c, { giftId: '99999', canonical: 'OYASUMI_TOPPO' })).not.toBeNull();
  });

  it('トリガーが3つとも空ならどのギフトにも一致しない', () => {
    // 空文字の部分一致が全ギフトを拾う罠を塞ぐ最重要ガード。
    const c = cfg(); // 既定 = giftId/giftName/canonical すべて空
    expect(c.fanStamp.enabled).toBe(true);
    expect(matchFanStamp(c, { giftId: '5655', giftName: 'Rose' })).toBeNull();
    expect(matchFanStamp(c, { giftId: '', giftName: '' })).toBeNull();
    expect(matchGiftTrigger({ giftId: '', giftName: '', canonical: '' }, { giftId: 'x', giftName: 'y' })).toBe(false);
  });

  it('enabled: false なら一致しても null', () => {
    expect(matchFanStamp(fsCfg({ enabled: false }), { giftId: '76637' })).toBeNull();
  });

  it('一致した行そのものを返す(将来の配列化に備えた戻り値)', () => {
    const c = fsCfg({ amountEach: -7 });
    expect(matchFanStamp(c, { giftId: '76637' })!.amountEach).toBe(-7);
  });
});

describe('validateChallengeConfig — fanStamp', () => {
  it('fanStamp キーの無い settings.json は既定へ', () => {
    const noFs = structuredClone(DEFAULT_CHALLENGE) as Partial<ChallengeConfig>;
    delete noFs.fanStamp;
    expect(validateChallengeConfig(noFs).fanStamp).toEqual(DEFAULT_FAN_STAMP);
  });

  it('challenge キーごと無い(v0.2.0 世代)でも既定 fanStamp が入る', () => {
    expect(validateChallengeConfig(undefined).fanStamp).toEqual(DEFAULT_FAN_STAMP);
  });

  it('既定(giftId 空)は既存ユーザーの挙動を変えない', () => {
    // 既定のまま配られても、どのギフトにも一致しない = この機能はオフと同じ。
    const v = validateChallengeConfig(undefined);
    expect(matchFanStamp(v, { giftId: '5655', giftName: 'Rose' })).toBeNull();
    expect(matchFanStamp(v, { giftId: '7934', giftName: 'Heart Me' })).toBeNull();
  });

  it('amountEach: 非数値は既定、小数は丸め、範囲外は clamp(負数は保つ)', () => {
    const v = (a: unknown): number =>
      validateChallengeConfig({ ...DEFAULT_CHALLENGE, fanStamp: { ...DEFAULT_FAN_STAMP, amountEach: a } })
        .fanStamp.amountEach;
    expect(v('x')).toBe(-1);
    expect(v(Number.NaN)).toBe(-1);
    expect(v(-2.4)).toBe(-2);
    expect(v(-1e9)).toBe(-999_999);
    expect(v(1e9)).toBe(999_999);
  });

  it('giftId は trim、giftName/canonical は trim + 小文字化', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      fanStamp: { ...DEFAULT_FAN_STAMP, giftId: ' 76637 ', giftName: ' Toppo ', canonical: ' Oyasumi ' },
    }).fanStamp;
    expect(v.giftId).toBe('76637');
    expect(v.giftName).toBe('toppo');
    expect(v.canonical).toBe('oyasumi');
  });

  it('boolean 3つは欠損なら true、明示 false は保つ', () => {
    const miss = validateChallengeConfig({ ...DEFAULT_CHALLENGE, fanStamp: { giftId: '1' } }).fanStamp;
    expect([miss.enabled, miss.suppressBandFx, miss.flash]).toEqual([true, true, true]);
    const off = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      fanStamp: { ...DEFAULT_FAN_STAMP, enabled: false, suppressBandFx: false, flash: false },
    }).fanStamp;
    expect([off.enabled, off.suppressBandFx, off.flash]).toEqual([false, false, false]);
  });
});

describe('ChallengeEngine — お助け機能(ファンスタンプ)', () => {
  const V0 = DEFAULT_CHALLENGE.initialValue;

  it('1個で amountEach ちょうど減る(giftDefault の +1 は併用されない)', () => {
    const e = engine(fsCfg());
    e.start();
    expect(e.handleEvent(fanStamp())).toBe(true);
    const s = e.get();
    expect(s.value).toBe(V0 - 1);
    expect(s.stats.giftDown).toBe(1);
    expect(s.stats.giftUp).toBe(0);
    const fx = s.recentEffects[0]!;
    expect(fx.kind).toBe('gift');
    expect(fx.amount).toBe(-1);
    expect(fx.valueAfter).toBe(s.value);
    expect(fx.giftName).toBe('おやすみトッポ');
  });

  it('モニター向けに fanStamp の印が載る(専用バナーの出所)', () => {
    // モニターは cfg を 30 秒ポーリングでしか見ないので、お助けかどうかは
    // effect の焼き込みだけで判定できないといけない(fxBandClip と同じ流儀)。
    const e = engine(fsCfg());
    e.start();
    e.handleEvent(fanStamp());
    expect(e.get().recentEffects[0]!.fanStamp).toBe(true);
  });

  it('お助けに一致しないギフトには fanStamp の印が載らない', () => {
    // 印が漏れると通常ギフトのカードが緑のお助けバナーに化ける。
    const e = engine(fsCfg({}, { giftDefault: { mode: 'fixed', amount: 5 } }));
    e.start();
    e.handleEvent(gift({ giftId: '999', giftName: 'バラ' }));
    expect(e.get().recentEffects[0]!.fanStamp).toBeUndefined();
  });

  it('testEffect(fanStamp) は値を動かさずに印付きの演出だけ流す', () => {
    const e = engine(fsCfg({ amountEach: -3, flash: true }));
    e.start();
    e.testEffect({ kind: 'fanStamp' });
    const s = e.get();
    expect(s.value).toBe(V0); // 実演は値・統計に触らない
    expect(s.stats.giftDown).toBe(0);
    const fx = s.recentEffects[0]!;
    expect(fx.kind).toBe('gift');
    expect(fx.fanStamp).toBe(true);
    expect(fx.test).toBe(true);
    expect(fx.amount).toBe(-3);
    expect(fx.flash).toBe(true);
    // ラッチ開始値 = 現在値になるよう valueAfter は value + amount(testEffect の規約)。
    expect(fx.valueAfter).toBe(V0 - 3);
  });
  it('連打は個数倍で効く(repeatCount 基準)', () => {
    const e = engine(fsCfg({ amountEach: -3 }));
    e.start();
    e.handleEvent(fanStamp({ repeatCount: 10, diamonds: 10 }));
    const s = e.get();
    expect(s.value).toBe(V0 - 30);
    const fx = s.recentEffects[0]!;
    expect(fx.amount).toBe(-30);
    expect(fx.giftCount).toBe(10);
    // 💎は normalize.ts の確定値をそのまま載せる(再計算しない)。
    expect(fx.diamonds).toBe(10);
  });

  it('ダイヤ単価が 1 でなくても個数倍(perDiamond ではない)', () => {
    // 5💎 × 3個 = 15💎 だが、減るのは 3個ぶんの -3。perDiamond 流用なら -15 になる。
    const e = engine(fsCfg());
    e.start();
    e.handleEvent(fanStamp({ diamondEach: 5, repeatCount: 3, diamonds: 15 }));
    expect(e.get().value).toBe(V0 - 3);
  });

  it('同じ giftId のギフト増減規則より優先される', () => {
    const c = fsCfg({}, { giftRules: [{ id: 'r1', giftId: '76637', mode: 'fixed', amount: 100 }] });
    const e = engine(c);
    e.start();
    e.handleEvent(fanStamp());
    const s = e.get();
    expect(s.value).toBe(V0 - 1); // 規則の +100 も giftDefault も通っていない
    expect(s.stats.giftUp).toBe(0);
  });

  it('同じ giftId のルーレットより優先され、スピンも消費しない', () => {
    const c = fsCfg(
      {},
      {
        roulettes: [
          {
            ...structuredClone(DEFAULT_ROULETTE),
            id: 'fs',
            label: 'トッポ',
            giftId: '76637',
            giftName: '',
            canonical: '',
          },
        ],
      }
    );
    const e = new ChallengeEngine(
      () => c,
      () => NOW,
      () => 0
    );
    e.setMonitorOpen(true);
    e.setFxCaps(true);
    e.start();
    e.handleEvent(fanStamp());
    const s = e.get();
    expect(s.value).toBe(V0 - 1);
    expect(s.stats.rouletteSpins).toBe(0);
    expect(s.recentEffects[0]!.kind).toBe('gift');
  });

  it('suppressBandFx: true ならカットインもカウンタ凍結も起きない', () => {
    // 既定バンド band1 は 1〜50💎 — 1💎のファンスタンプは素で当たってしまう。
    const e = engine(fsCfg({}, { giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX) }));
    e.start();
    e.handleEvent(fanStamp());
    const s = e.get();
    expect(s.recentEffects[0]!.fxBandClip).toBeUndefined();
    expect(s.fxFreezeUntilMs).toBeNull();
    expect(s.value).toBe(V0 - 1);
  });

  it('suppressBandFx: false なら従来どおりカットインと凍結が乗る', () => {
    const e = engine(fsCfg({ suppressBandFx: false }, { giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX) }));
    e.start();
    e.handleEvent(fanStamp());
    const s = e.get();
    expect(s.recentEffects[0]!.fxBandClip).toBe('gift-band1');
    expect(s.fxFreezeUntilMs).toBe(NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS);
  });

  it('0 でクランプし、到達すると達成する', () => {
    const e = engine(fsCfg({}, { initialValue: 2 }));
    e.start();
    e.handleEvent(fanStamp({ repeatCount: 5, diamonds: 5 }));
    const s = e.get();
    expect(s.value).toBe(0);
    expect(s.status).toBe('achieved');
    expect(s.recentEffects.map((x) => x.kind)).toEqual(['achieved', 'gift']);
  });

  it('flash は設定どおり載り、flashMinDiamonds 以上なら false でも載る', () => {
    const on = engine(fsCfg({ flash: true }));
    on.start();
    on.handleEvent(fanStamp());
    expect(on.get().recentEffects[0]!.flash).toBe(true);

    const off = engine(fsCfg({ flash: false }));
    off.start();
    off.handleEvent(fanStamp());
    expect(off.get().recentEffects[0]!.flash).toBeUndefined();

    // 高額ギフトの照明は規則を問わず出す(matchGiftRule の overFlash と同じ精神)。
    const big = engine(fsCfg({ flash: false }, { flashMinDiamonds: 100 }));
    big.start();
    big.handleEvent(fanStamp({ repeatCount: 200, diamonds: 200 }));
    expect(big.get().recentEffects[0]!.flash).toBe(true);
  });

  it('enabled: false なら従来どおり giftDefault(perDiamond +1)へ落ちる', () => {
    const e = engine(fsCfg({ enabled: false }));
    e.start();
    e.handleEvent(fanStamp());
    expect(e.get().value).toBe(V0 + 1);
  });

  it('対象外のギフトは従来どおり giftDefault へ落ちる', () => {
    const e = engine(fsCfg());
    e.start();
    e.handleEvent(gift({ diamonds: 3 })); // Rose(5655)
    expect(e.get().value).toBe(V0 + 3);
  });

  it('同じ msgId は二重適用しない(再接続バックログ)', () => {
    const e = engine(fsCfg());
    e.start();
    const g = fanStamp();
    expect(e.handleEvent(g)).toBe(true);
    expect(e.handleEvent(g)).toBe(false);
    expect(e.get().value).toBe(V0 - 1);
  });

  it('お助けギフトの💎もリザルトのギフトランキングに数える', () => {
    // touchParticipant はお助けの分岐より上にある — カウントに効く経路が変わっても
    // ランキングからは消えない(既存規約)。
    const e = engine(fsCfg({}, { initialValue: 100, pressStep: 1_000_000 }));
    e.start();
    e.handleEvent(fanStamp({ viewer: { userId: 'a', nickname: 'A' }, repeatCount: 4, diamonds: 4 }));
    const s = e.press();
    expect(s.status).toBe('achieved');
    const r = s.result!;
    expect(r.gifts[0]!.diamonds).toBe(4);
  });

  it('running でなければ何もしない', () => {
    const e = engine(fsCfg());
    expect(e.handleEvent(fanStamp())).toBe(false);
    expect(e.get().value).toBe(V0);
  });
});

describe('ChallengeEngine — 連打ギフトの演出反復(giftRepeatFx)', () => {
  /** 反復設定だけ差し替えた cfg(バンドは cfg() 側で無効のまま)。 */
  function repCfg(over: Partial<ChallengeConfig['giftRepeatFx']> = {}): ChallengeConfig {
    const base = cfg();
    return { ...base, giftRepeatFx: { ...base.giftRepeatFx, ...over } };
  }

  it('単発ギフト(repeatCount=1)には fxRepeat が載らない', () => {
    const e = engine(repCfg());
    e.start();
    e.handleEvent(gift({ repeatCount: 1, diamonds: 1 }));
    const fx = e.get().recentEffects[0]!;
    expect(fx.fxRepeat).toBeUndefined();
    expect(fx.fxRepeatIntervalMs).toBeUndefined();
  });

  it('enabled: false なら連打でも fxRepeat が載らない(従来どおり1回)', () => {
    const e = engine(repCfg({ enabled: false }));
    e.start();
    e.handleEvent(gift({ repeatCount: 10, diamonds: 10 }));
    expect(e.get().recentEffects[0]!.fxRepeat).toBeUndefined();
  });

  it('fxRepeat は min(repeatCount, max)。giftCount(事実)とは別物として共存する', () => {
    const e = engine(repCfg({ max: 5, intervalMs: 700 }));
    e.start();
    e.handleEvent(gift({ repeatCount: 50, diamonds: 50 }));
    const fx = e.get().recentEffects[0]!;
    expect(fx.fxRepeat).toBe(5); // 演出方針
    expect(fx.giftCount).toBe(50); // 何連打だったかの事実
    expect(fx.fxRepeatIntervalMs).toBe(700);
    // 演出は1件のまま — リングバッファを連打で食い潰さない。
    expect(e.get().recentEffects.filter((x) => x.kind === 'gift')).toHaveLength(1);
  });

  it('repeatCount が max 未満ならその回数ぶん', () => {
    const e = engine(repCfg({ max: 5 }));
    e.start();
    e.handleEvent(gift({ repeatCount: 3, diamonds: 3 }));
    expect(e.get().recentEffects[0]!.fxRepeat).toBe(3);
  });

  it('**値・統計・valueAfter は反復の有無で完全に一致する**(反復は見た目だけ)', () => {
    // これが「反復は演出だけ」の不変条件。将来「値も回数ぶんにする」回帰を止める。
    const g = () => gift({ repeatCount: 10, diamonds: 10 });
    const on = engine(repCfg({ enabled: true }));
    on.start();
    on.handleEvent(g());
    const off = engine(repCfg({ enabled: false }));
    off.start();
    off.handleEvent(g());

    expect(on.get().value).toBe(off.get().value);
    expect(on.get().stats).toEqual(off.get().stats);
    const a = on.get().recentEffects[0]!;
    const b = off.get().recentEffects[0]!;
    expect(a.amount).toBe(b.amount);
    expect(a.valueAfter).toBe(b.valueAfter);
    expect(a.diamonds).toBe(b.diamonds);
    expect(a.giftCount).toBe(b.giftCount);
  });

  it('カットイン反復: 凍結は総尺(fxDurationMs × rep)ぶんに伸びる', () => {
    const c = bandCfg();
    c.giftRepeatFx = { ...c.giftRepeatFx, max: 5, bandEnabled: true };
    const e = engine(c);
    e.start();
    // 10💎 → band1(1〜50、6秒)。
    e.handleEvent(gift({ repeatCount: 5, diamonds: 10 }));
    const s = e.get();
    const fx = s.recentEffects[0]!;
    expect(fx.fxRepeat).toBe(5);
    expect(fx.fxDurationMs).toBe(6000); // 1本の尺は不変(モニターとの契約)
    expect(s.fxFreezeUntilMs).toBe(NOW + 6000 * 5 + GIFT_FX_FREEZE_MARGIN_MS);
  });

  it('総凍結の上限を超えるときは fxDurationMs ではなく回数側を削る', () => {
    const c = bandCfg();
    // durationSec 30 → 1本は GIFT_FX_FREEZE_MAX_MS(15秒)で頭打ち。
    c.giftBandFx.bands = [
      { id: 'band1', min: 1, max: 100_000, clip: 'gift-band1', durationSec: 30, enabled: true, bgm: 'off' },
    ];
    c.giftRepeatFx = { ...c.giftRepeatFx, max: 5, bandEnabled: true };
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ repeatCount: 5, diamonds: 10 }));
    const s = e.get();
    const fx = s.recentEffects[0]!;
    expect(fx.fxDurationMs).toBe(GIFT_FX_FREEZE_MAX_MS); // 1本の尺は削らない
    expect(fx.fxRepeat).toBe(3); // 45_000 / 15_000
    const span = s.fxFreezeUntilMs! - NOW;
    expect(span).toBe(GIFT_FX_FREEZE_MAX_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS);
  });

  it('bandEnabled: false ならカットイン一致ギフトは反復しない(凍結も従来どおり1本ぶん)', () => {
    const c = bandCfg();
    c.giftRepeatFx = { ...c.giftRepeatFx, max: 5, bandEnabled: false };
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ repeatCount: 5, diamonds: 10 }));
    const s = e.get();
    expect(s.recentEffects[0]!.fxBandClip).toBeDefined();
    expect(s.recentEffects[0]!.fxRepeat).toBeUndefined();
    expect(s.fxFreezeUntilMs).toBe(NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS);
  });
});

describe('ChallengeEngine — 連打ギフトの反復スピン(rouletteEnabled)', () => {
  function rlRepEngine(over: Partial<ChallengeConfig['giftRepeatFx']> = {}, rand: () => number = () => 0) {
    const base = cfg();
    const c: ChallengeConfig = { ...base, giftRepeatFx: { ...base.giftRepeatFx, ...over } };
    const e = new ChallengeEngine(() => c, () => NOW, rand);
    e.setMonitorOpen(true);
    e.setFxCaps(true);
    return e;
  }

  it('連打ぶん回り、**値の増減も回数ぶんになる**(ルーレットだけの例外)', () => {
    const e = rlRepEngine({ max: 5, rouletteEnabled: true });
    e.start();
    e.handleEvent(heartMe({ repeatCount: 3, diamonds: 3 }));
    const s = e.get();
    expect(s.stats.rouletteSpins).toBe(3);
    expect(s.recentEffects.filter((x) => x.kind === 'roulette')).toHaveLength(3);
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 15); // rand=0 → +5 ×3
  });

  it('出目は毎回引き直す(同じ出目の水増しではない)', () => {
    // 1回目 +5(index0)、2回目 +1000(index5)。
    const seqRand = [0, 0.999999];
    let i = 0;
    const e = rlRepEngine({ max: 5, rouletteEnabled: true }, () => seqRand[i++] ?? 0);
    e.start();
    e.handleEvent(heartMe({ repeatCount: 2, diamonds: 2 }));
    const spins = e.get().recentEffects.filter((x) => x.kind === 'roulette');
    expect(spins.map((x) => x.amount).sort((a, b) => a - b)).toEqual([5, 1000]);
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 1005);
  });

  it('rouletteEnabled: false なら連打でも1イベント=1スピン(従来の不変条件)', () => {
    const e = rlRepEngine({ max: 5, rouletteEnabled: false });
    e.start();
    e.handleEvent(heartMe({ repeatCount: 3, diamonds: 3 }));
    expect(e.get().stats.rouletteSpins).toBe(1);
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 5);
  });

  it('スピン数はモニターのキュー容量を超えない(溢れると値だけ動いてリールが出ない)', () => {
    const e = rlRepEngine({ max: GIFT_FX_REPEAT_MAX, rouletteEnabled: true });
    e.start();
    e.handleEvent(heartMe({ repeatCount: 999, diamonds: 999 }));
    expect(e.get().stats.rouletteSpins).toBeLessThanOrEqual(ROULETTE_QUEUE_MAX + 1);
  });
});

describe('validateChallengeConfig — giftRepeatFx(新フィールドが黙って消えないこと)', () => {
  it('既定が往復する', () => {
    expect(validateChallengeConfig(DEFAULT_CHALLENGE).giftRepeatFx).toEqual(DEFAULT_GIFT_REPEAT_FX);
  });

  it('旧 settings.json(キー欠損)は既定へ倒れる', () => {
    const legacy = structuredClone(DEFAULT_CHALLENGE) as Partial<ChallengeConfig>;
    delete legacy.giftRepeatFx;
    expect(validateChallengeConfig(legacy).giftRepeatFx).toEqual(DEFAULT_GIFT_REPEAT_FX);
  });

  it('範囲外は clamp、非数は既定', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftRepeatFx: { enabled: true, max: 999, intervalMs: 10, bandEnabled: true, rouletteEnabled: true },
    }).giftRepeatFx;
    expect(v.max).toBe(GIFT_FX_REPEAT_MAX);
    expect(v.intervalMs).toBe(GIFT_FX_REPEAT_MIN_MS);
    const w = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftRepeatFx: { max: 'x', intervalMs: null },
    }).giftRepeatFx;
    expect(w.max).toBe(DEFAULT_GIFT_REPEAT_FX.max);
    expect(w.intervalMs).toBe(DEFAULT_GIFT_REPEAT_FX.intervalMs);
  });

  it('真偽値の向き: 3つとも既定 true なので、明示 false のときだけ false になる', () => {
    const off = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      giftRepeatFx: { enabled: false, bandEnabled: false, rouletteEnabled: false },
    }).giftRepeatFx;
    expect(off.enabled).toBe(false);
    expect(off.bandEnabled).toBe(false);
    expect(off.rouletteEnabled).toBe(false);
    // 欠損は「既定どおり true」— === true で書くと既定が反転する(この関数群の罠)。
    const missing = validateChallengeConfig({ ...DEFAULT_CHALLENGE, giftRepeatFx: {} }).giftRepeatFx;
    expect(missing.enabled).toBe(true);
    expect(missing.bandEnabled).toBe(true);
    expect(missing.rouletteEnabled).toBe(true);
  });
});
describe('指定コメント妨害(commentRules — キーワード部分一致で加算)', () => {
  const rules = [
    { id: 'r1', keyword: 'おやすみ', amount: 5 },
    { id: 'r2', keyword: 'sleep', amount: 3 },
  ];
  const ccfg = (over: Partial<ChallengeConfig> = {}): ChallengeConfig =>
    cfg({ commentRules: rules.map((r) => ({ ...r })), ...over });

  it('キーワードを含むコメントで規則の量だけ増え、stats と effect(名前・キーワード付き)が残る', () => {
    const e = engine(ccfg());
    e.start();
    expect(e.handleEvent(comment('c1', { content: 'おやすみ〜🌙' }))).toBe(true);
    const s = e.get();
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 5);
    expect(s.stats.commentUp).toBe(5);
    const fx = s.recentEffects[0]!;
    expect(fx.kind).toBe('comment');
    expect(fx.amount).toBe(5);
    expect(fx.nickname).toBe('viewer-c1');
    expect(fx.commentKeyword).toBe('おやすみ');
    expect(fx.valueAfter).toBe(s.value);
  });

  it('どの規則にも一致しないコメント・既定(規則なし)では何も起きない', () => {
    const e = engine(ccfg());
    e.start();
    expect(e.handleEvent(comment('c1', { content: 'こんばんは' }))).toBe(false);
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue);

    const none = engine(cfg());
    none.start();
    expect(none.handleEvent(comment('c2', { content: 'おやすみ' }))).toBe(false);
    expect(none.get().stats.commentUp).toBe(0);
  });

  it('複数規則は上から先勝ち(両方に一致しても最初の1件だけ)', () => {
    const e = engine(
      ccfg({
        commentRules: [
          { id: 'a', keyword: 'おやすみ', amount: 5 },
          { id: 'b', keyword: 'やすみ', amount: 100 },
        ],
      })
    );
    e.start();
    e.handleEvent(comment('c1', { content: 'おやすみなさい' }));
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 5);
  });

  it('空キーワードの規則はどのコメントにも一致しない(includes("") 罠)', () => {
    const e = engine(ccfg({ commentRules: [{ id: 'a', keyword: '', amount: 50 }] }));
    e.start();
    expect(e.handleEvent(comment('c1', { content: 'なんでもコメント' }))).toBe(false);
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue);
  });

  it('英字キーワードは大文字小文字を区別しない', () => {
    const e = engine(ccfg());
    e.start();
    expect(e.handleEvent(comment('c1', { content: 'GO TO SLEEP!!' }))).toBe(true);
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 3);
    expect(e.get().recentEffects[0]!.commentKeyword).toBe('sleep');
  });

  it('同じ視聴者の連投は毎回反応する(1人1回制限なし)', () => {
    const e = engine(ccfg());
    e.start();
    e.handleEvent(comment('c1', { content: 'おやすみ' }));
    e.handleEvent(comment('c1', { content: 'おやすみ!!' }));
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 10);
    expect(e.get().stats.commentUp).toBe(10);
  });

  it('同じ msgId の再配信(再接続バックログ)は二重適用しない', () => {
    const e = engine(ccfg());
    e.start();
    const c = comment('c1', { content: 'おやすみ' });
    expect(e.handleEvent(c)).toBe(true);
    expect(e.handleEvent(c)).toBe(false);
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 5);
  });

  it('カットイン凍結中は保留され、解除後に適用される', () => {
    let t = NOW;
    const e = engine(bandCfg({ commentRules: rules.map((r) => ({ ...r })) }), () => t);
    e.start();
    // band1(1〜50💎・6秒)に一致するギフトで凍結を張る
    e.handleEvent(gift({ diamonds: 10 }));
    const frozen = e.get().value;
    expect(e.get().fxFreezeUntilMs).not.toBeNull();
    // 凍結中のコメントは値に効かない(キューへ)
    expect(e.handleEvent(comment('c1', { content: 'おやすみ' }))).toBe(false);
    expect(e.get().value).toBe(frozen);
    // 凍結明けに適用される
    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS + 1;
    e.drainIfChanged();
    expect(e.get().value).toBe(frozen + 5);
    expect(e.get().stats.commentUp).toBe(5);
  });

  it('validateChallengeConfig: 欠損・非配列は空、不正行は捨て、keyword は trim、上限で切る', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.commentRules;
    expect(validateChallengeConfig(legacy).commentRules).toEqual([]);
    expect(validateChallengeConfig({ ...DEFAULT_CHALLENGE, commentRules: 'x' }).commentRules).toEqual([]);

    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      commentRules: [
        { id: 'ok', keyword: '  おやすみ ', amount: 5.4 },
        { id: 'zero', keyword: 'ゼロ', amount: 0 },      // 一致しても何も起きない行は捨てる
        { id: 'bad-amount', keyword: 'x', amount: Number.NaN },
        { keyword: 'no-id', amount: 1 },
        { id: 'empty-kw', keyword: '', amount: 3 },       // 空キーワードは保存は許す(編集途中の行)
      ],
    }).commentRules;
    expect(v).toEqual([
      { id: 'ok', keyword: 'おやすみ', amount: 5 },
      { id: 'empty-kw', keyword: '', amount: 3 },
    ]);

    const many = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      commentRules: Array.from({ length: 30 }, (_, i) => ({ id: `r${i}`, keyword: 'k', amount: 1 })),
    }).commentRules;
    expect(many).toHaveLength(COMMENT_RULES_MAX);
  });
});

// ── ダイヤの全面カット(最優先カットイン)─────────────────────────────────

describe('matchGiftFullCut — ギフト名/ID による最優先カットインの写像', () => {
  const g = (giftName: string, giftId = '5655', canonical?: string) => ({ giftId, giftName, canonical });

  it('既定行はギフト名の部分一致で当たる(バラ / ローザ)', () => {
    const c = fullCutCfg();
    expect(matchGiftFullCut(c, g('バラ'))?.clip).toBe('cut-rose');
    expect(matchGiftFullCut(c, g('ローザ'))?.clip).toBe('cut-rosa');
    // 部分一致なので前後に文字があっても当たる
    expect(matchGiftFullCut(c, g('赤いバラの花束'))?.clip).toBe('cut-rose');
  });

  it('canonical でも当たる(リプレイ/テスト経路の保険)', () => {
    const c = fullCutCfg();
    expect(matchGiftFullCut(c, g('Rose', '5655', 'rose'))?.clip).toBe('cut-rose');
    expect(matchGiftFullCut(c, g('Rose', '5655', 'ROSE'))?.clip).toBe('cut-rose'); // 大文字でも
  });

  it('giftId 完全一致が使える', () => {
    const c = fullCutCfg();
    c.giftFullCut.rules[0]!.giftId = '9001';
    c.giftFullCut.rules[0]!.giftName = '';
    c.giftFullCut.rules[0]!.canonical = '';
    expect(matchGiftFullCut(c, g('なにか', '9001'))?.clip).toBe('cut-rose');
    expect(matchGiftFullCut(c, g('なにか', '9002'))).toBeNull();
  });

  it('無関係なギフトには当たらない', () => {
    const c = fullCutCfg();
    expect(matchGiftFullCut(c, g('ドラゴン', '1234'))).toBeNull();
  });

  it('上から先勝ち(最初に一致した1行だけ)', () => {
    const c = fullCutCfg();
    c.giftFullCut.rules[0]!.giftName = 'ば';
    c.giftFullCut.rules[1]!.giftName = 'ば';
    expect(matchGiftFullCut(c, g('ばら'))?.id).toBe('fullcut-rose');
  });

  it('無効行・clip=off の行は飛ばす', () => {
    const c = fullCutCfg();
    c.giftFullCut.rules[0]!.enabled = false;
    expect(matchGiftFullCut(c, g('バラ'))).toBeNull();
    const c2 = fullCutCfg();
    c2.giftFullCut.rules[0]!.clip = 'off';
    expect(matchGiftFullCut(c2, g('バラ'))).toBeNull();
  });

  it('トリガーが3つとも空の行はどのギフトにも一致しない(空文字 includes 罠)', () => {
    const c = fullCutCfg();
    c.giftFullCut.rules[0]!.giftId = '';
    c.giftFullCut.rules[0]!.giftName = '';
    c.giftFullCut.rules[0]!.canonical = '';
    c.giftFullCut.rules[1]!.enabled = false;
    expect(matchGiftFullCut(c, g('なんでも'))).toBeNull();
  });

  it('giftFullCut.enabled / fxClipsEnabled のどちらかが false なら出さない', () => {
    expect(matchGiftFullCut(cfg(), g('バラ'))).toBeNull(); // cfg() は全面カット無効
    const c = fullCutCfg();
    c.giftFullCut.enabled = false;
    expect(matchGiftFullCut(c, g('バラ'))).toBeNull();
    const c2 = fullCutCfg({ fxClipsEnabled: false });
    expect(matchGiftFullCut(c2, g('バラ'))).toBeNull();
  });
});

describe('ChallengeEngine — 全面カットはダイヤ数帯より優先される', () => {
  it('1💎のバラは band1 ではなく cut-rose を再生し、fxFullCut の印が載る', () => {
    const e = engine(fullCutCfg({ initialValue: 1000 }), () => NOW);
    e.start();
    expect(e.handleEvent(gift({ diamonds: 1, giftName: 'バラ' }))).toBe(true);
    const s = e.get();
    expect(s.recentEffects[0]).toMatchObject({
      kind: 'gift',
      fxBandClip: 'cut-rose',
      fxDurationMs: 5000,
      fxFullCut: true,
    });
    // 帯域の BGM は載らない(音声は素材に焼き込み済み — 二重に鳴らさない)
    expect(s.recentEffects[0]!.fxBandBgm).toBeUndefined();
    // 凍結は全面カットの尺で張る
    expect(s.fxFreezeUntilMs).toBe(NOW + 5000 + GIFT_FX_FREEZE_MARGIN_MS);
  });

  it('高額ギフトでもギフト名が一致すれば帯域(band4)より全面カットが勝つ', () => {
    const e = engine(fullCutCfg({ initialValue: 100_000 }), () => NOW);
    e.start();
    e.handleEvent(gift({ diamonds: 700, giftName: 'ローザ' }));
    expect(e.get().recentEffects[0]).toMatchObject({ fxBandClip: 'cut-rosa', fxFullCut: true });
  });

  it('一致しないギフトは従来どおり帯域カットインへ落ちる(fxFullCut は載らない)', () => {
    const e = engine(fullCutCfg({ initialValue: 1000 }), () => NOW);
    e.start();
    e.handleEvent(gift({ diamonds: 30, giftName: 'ドラゴン' }));
    const first = e.get().recentEffects[0]!;
    expect(first).toMatchObject({ fxBandClip: 'gift-band1', fxDurationMs: 6000 });
    expect(first.fxFullCut).toBeUndefined();
    expect(first.fxBandBgm).toBe('bgm-band1'); // 帯域は従来どおり別BGM
  });

  it('お助け(suppressBandFx)は全面カットも止める', () => {
    const c = fullCutCfg({ initialValue: 1000 });
    c.fanStamp = { ...structuredClone(DEFAULT_FAN_STAMP), giftName: 'バラ', suppressBandFx: true };
    const e = engine(c, () => NOW);
    e.start();
    e.handleEvent(gift({ diamonds: 1, giftName: 'バラ' }));
    const s = e.get();
    expect(s.recentEffects[0]!.fxBandClip).toBeUndefined();
    expect(s.recentEffects[0]!.fxFullCut).toBeUndefined();
    expect(s.fxFreezeUntilMs).toBeNull(); // 凍結も張られない
  });

  it('増減規則に一致しないギフトでも全面カットだけは出る', () => {
    const c = fullCutCfg({ initialValue: 1000, giftRules: [], giftDefault: null });
    const e = engine(c, () => NOW);
    e.start();
    expect(e.handleEvent(gift({ diamonds: 1, giftName: 'バラ' }))).toBe(true);
    const s = e.get();
    expect(s.value).toBe(1000); // 値は動かない
    expect(s.recentEffects[0]).toMatchObject({ amount: 0, fxBandClip: 'cut-rose', fxFullCut: true });
  });
});

describe('validateChallengeConfig — giftFullCut(新フィールドが黙って消えないこと)', () => {
  it('キーが無い旧 settings.json は既定(有効・バラ/ローザ)へ倒れる', () => {
    const c = validateChallengeConfig({ enabled: true });
    expect(c.giftFullCut).toEqual(DEFAULT_GIFT_FULL_CUT);
  });

  it('giftName / canonical は小文字化して保存する(label は原文のまま)', () => {
    const c = validateChallengeConfig({
      giftFullCut: {
        enabled: true,
        volume: 70,
        rules: [
          {
            id: 'fullcut-rose',
            label: 'バラ ',
            giftId: ' 5655 ',
            giftName: ' ROSE ',
            canonical: ' ROSE ',
            clip: 'cut-rose',
            durationSec: 5,
            enabled: true,
          },
        ],
      },
    });
    expect(c.giftFullCut.rules[0]).toMatchObject({
      label: 'バラ',
      giftId: '5655',
      giftName: 'rose',
      canonical: 'rose',
    });
  });

  it('未知のクリップ id は同じ id の既定行のクリップへ倒れる', () => {
    const c = validateChallengeConfig({
      giftFullCut: {
        rules: [{ id: 'fullcut-rose', clip: 'no-such-clip', durationSec: 5, enabled: true }],
      },
    });
    expect(c.giftFullCut.rules[0]!.clip).toBe('cut-rose');
  });

  it('id が既定に無い行の未知クリップは off、durationSec は 1〜30 に丸める', () => {
    const c = validateChallengeConfig({
      giftFullCut: {
        rules: [
          { id: 'custom', clip: 'zzz', durationSec: 999, enabled: true },
          { id: 'custom2', clip: 'cut-rosa', durationSec: 0, enabled: true },
        ],
      },
    });
    expect(c.giftFullCut.rules[0]).toMatchObject({ clip: 'off', durationSec: 30 });
    expect(c.giftFullCut.rules[1]).toMatchObject({ clip: 'cut-rosa', durationSec: 1 });
  });

  it('volume は 0〜100 に丸め、壊れた値は既定へ', () => {
    expect(validateChallengeConfig({ giftFullCut: { volume: 999 } }).giftFullCut.volume).toBe(100);
    expect(validateChallengeConfig({ giftFullCut: { volume: -5 } }).giftFullCut.volume).toBe(0);
    expect(validateChallengeConfig({ giftFullCut: { volume: 'x' } }).giftFullCut.volume).toBe(
      DEFAULT_GIFT_FULL_CUT.volume
    );
  });

  it('rules が配列でなければ既定の行へ倒れる(行が黙って消えない)', () => {
    const c = validateChallengeConfig({ giftFullCut: { enabled: true, rules: 'broken' } });
    expect(c.giftFullCut.rules).toEqual(DEFAULT_GIFT_FULL_CUT.rules);
  });
});
