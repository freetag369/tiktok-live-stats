import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_JOIN_ROULETTE,
  DEFAULT_ROULETTE,
  DEFAULT_ROULETTE_SOUND,
  mergeRoulette,
  resolveRouletteSound,
  sameRouletteBoard,
  validateChallengeConfig,
} from '@shared/challenge';
import type {
  ChallengeConfig,
  ChallengeEffect,
  ChallengeRouletteConfig,
  RouletteSoundConfig,
} from '@shared/dto';
import type { GiftEvent, JoinEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

let seq = 0;

/** 共通と確実に違う上書き値。フィールドを足されても壊れないよう既定からの差分で作る。 */
const OVERRIDE: RouletteSoundConfig = { ...DEFAULT_ROULETTE_SOUND, bgm: 'bgm-band3', bgmVolume: 33 };

function row(over: Partial<ChallengeRouletteConfig> = {}): ChallengeRouletteConfig {
  return {
    ...structuredClone(DEFAULT_ROULETTE),
    id: 'rl-a',
    label: 'A',
    giftId: '111',
    giftName: '',
    canonical: '',
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
    giftId: '111',
    giftName: 'Test Gift',
    repeatCount: 1,
    diamondEach: 30,
    diamonds: 30,
    isBoxGift: false,
    ...over,
  };
}

function join(userId = 'j1'): JoinEvent {
  return {
    kind: 'join',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: `viewer-${userId}` },
    action: 1,
  };
}

/** ルーレット2行 + 入室ルーレット有効の設定。カットインは凍結を挟まないよう無効。 */
function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.roulettes = [row(), row({ id: 'rl-b', label: 'B', giftId: '222' })];
  base.joinRoulette = { ...structuredClone(DEFAULT_JOIN_ROULETTE), enabled: true };
  return { ...base, enabled: true, ...over };
}

function engine(c: ChallengeConfig = cfg()): ChallengeEngine {
  const e = new ChallengeEngine(
    () => c,
    () => NOW,
    () => 0,
    () => 0
  );
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  e.start();
  return e;
}

/** ルーレット effect のひな形(challenge.spec.ts の rlEffect と同じ形)。 */
function rlEffect(id: number, over: Partial<ChallengeEffect> = {}): ChallengeEffect {
  return {
    id,
    kind: 'roulette',
    amount: 5,
    valueAfter: 1000 + id,
    atMs: NOW,
    rouletteLabel: 'ハートミー',
    rouletteSegments: [5, 10],
    rouletteIndexes: [0],
    rouletteIndex: 0,
    roulettePatterns: ['slow'],
    roulettePattern: 'slow',
    rouletteReels: 1,
    nickname: `u${id}`,
    ...over,
  };
}

describe('validateChallengeConfig — 行ごとの回転サウンド上書き', () => {
  it('保存済み設定に sound キーが無くても共通に従う — 移行段なしで効く', () => {
    // **欠損が「共通に従う」へ倒れること自体が移行の代わり**で、settingsVersion が
    // 最新の保存済み設定(= 移行段を通らない)にも届くことを固定する。
    // 既定値の書き換えでは保存済み settings.json に届かない。
    const saved = structuredClone(DEFAULT_CHALLENGE);
    const v = validateChallengeConfig(saved);
    expect('sound' in v.roulettes[0]!).toBe(false);
    expect('sound' in v.joinRoulette).toBe(false);
  });

  it('上書きが無いときはキーごと出さない(既定と形が揃う)', () => {
    // ここが崩れると challenge.spec.ts / challenge-join-roulette.spec.ts の
    // `toEqual(DEFAULT_ROULETTE)` `toEqual(DEFAULT_JOIN_ROULETTE)` が落ちる。
    // 常に `sound: null` を出すと、toEqual は undefined と違って null を無視しない。
    expect('sound' in DEFAULT_ROULETTE).toBe(false);
    expect('sound' in DEFAULT_JOIN_ROULETTE).toBe(false);
    const v = validateChallengeConfig(structuredClone(DEFAULT_CHALLENGE));
    expect(v.roulettes).toEqual([DEFAULT_ROULETTE]);
    expect(v.joinRoulette).toEqual(DEFAULT_JOIN_ROULETTE);
  });

  it('型崩れ(null・文字列・数値・配列・true)は継承へ倒す', () => {
    // 配列を必ず入れる: typeof [] === 'object' なので Array.isArray のガードが
    // 無いと validateRouletteSound が [] を既定オブジェクトへ倒し、手編集の事故が
    // 「全項目が既定の明示的な上書き」に化ける。
    for (const bad of [null, 'x', 42, [], true]) {
      const v = validateChallengeConfig({
        ...structuredClone(DEFAULT_CHALLENGE),
        roulettes: [{ ...structuredClone(DEFAULT_ROULETTE), sound: bad }],
        joinRoulette: { ...structuredClone(DEFAULT_JOIN_ROULETTE), sound: bad },
      } as unknown);
      expect('sound' in v.roulettes[0]!, `roulettes: ${JSON.stringify(bad)}`).toBe(false);
      expect('sound' in v.joinRoulette, `joinRoulette: ${JSON.stringify(bad)}`).toBe(false);
    }
  });

  it('明示的な上書きは保持し、共通とまったく同じサニタイズを受ける', () => {
    const v = validateChallengeConfig({
      ...structuredClone(DEFAULT_CHALLENGE),
      roulettes: [
        {
          ...structuredClone(DEFAULT_ROULETTE),
          // 未知 id は既定 id へ / BGM の id は回転音スロットには入らない /
          // 音量は 0-100 に clamp、という共通側の規約がそのまま効く。
          sound: { bgm: 'bgm-band3', bgmVolume: 250, spinSe: 'bgm-band1', spinSeVolume: -5 },
        },
      ],
    } as unknown);
    const s = v.roulettes[0]!.sound!;
    expect(s.bgm).toBe('bgm-band3'); // 帯域カットインの曲も回転BGMとして選べる
    expect(s.bgmVolume).toBe(100);
    expect(s.spinSe).toBe(DEFAULT_ROULETTE_SOUND.spinSe);
    expect(s.spinSeVolume).toBe(0);
  });

  it('行の上書きは共通側の検証に影響しない(独立)', () => {
    const v = validateChallengeConfig({
      ...structuredClone(DEFAULT_CHALLENGE),
      rouletteSound: 'こわれた値',
      roulettes: [{ ...structuredClone(DEFAULT_ROULETTE), sound: { ...OVERRIDE } }],
    } as unknown);
    expect(v.rouletteSound).toEqual(DEFAULT_ROULETTE_SOUND);
    expect(v.roulettes[0]!.sound!.bgm).toBe(OVERRIDE.bgm);
  });

  it('入室ルーレットの上書きも同じ規約', () => {
    const v = validateChallengeConfig({
      ...structuredClone(DEFAULT_CHALLENGE),
      joinRoulette: { ...structuredClone(DEFAULT_JOIN_ROULETTE), sound: { ...OVERRIDE } },
    } as unknown);
    expect(v.joinRoulette.sound!.bgm).toBe(OVERRIDE.bgm);
    expect(v.joinRoulette.sound!.bgmVolume).toBe(OVERRIDE.bgmVolume);
  });
});

describe('resolveRouletteSound — 行ごとの音の解決', () => {
  it('行が sound を持たなければ共通へ倒れる', () => {
    const c = cfg();
    expect(resolveRouletteSound(c, rlEffect(1, { rouletteId: 'rl-a' }))).toBe(c.rouletteSound);
  });

  it('行が sound を持てば行が勝つ(共通は無視 — 部分継承しない)', () => {
    const c = cfg();
    c.roulettes[0]!.sound = { ...OVERRIDE };
    expect(resolveRouletteSound(c, rlEffect(1, { rouletteId: 'rl-a' }))).toEqual(OVERRIDE);
    // 別の行は巻き込まない。
    expect(resolveRouletteSound(c, rlEffect(2, { rouletteId: 'rl-b' }))).toBe(c.rouletteSound);
  });

  it('rouletteId が cfg に無い(行を削除・id を変えた)は共通へ倒れる — 既定へは倒さない', () => {
    // 共通こそがこの機能以前の全ルーレットの音。行が消えただけで無音や別の音に
    // なるのは劣化なので、DEFAULT_ROULETTE_SOUND へは倒さない。
    const c = cfg({ rouletteSound: { ...OVERRIDE } });
    expect(resolveRouletteSound(c, rlEffect(1, { rouletteId: 'なくなった行' }))).toEqual(OVERRIDE);
  });

  it('rouletteId 欠損(共通運用)・空文字は共通', () => {
    const c = cfg();
    expect(resolveRouletteSound(c, rlEffect(1))).toBe(c.rouletteSound);
    expect(resolveRouletteSound(c, rlEffect(2, { rouletteId: '' }))).toBe(c.rouletteSound);
  });

  it('rouletteJoin は入室ルーレットの上書きを見る / 無ければ共通', () => {
    const c = cfg();
    expect(resolveRouletteSound(c, rlEffect(1, { rouletteJoin: true }))).toBe(c.rouletteSound);
    c.joinRoulette.sound = { ...OVERRIDE };
    expect(resolveRouletteSound(c, rlEffect(2, { rouletteJoin: true }))).toEqual(OVERRIDE);
  });

  it('enabled:false の行でも id 一致なら解決する(▶ 試写は enabled を見ない)', () => {
    const c = cfg();
    c.roulettes[0]!.enabled = false;
    c.roulettes[0]!.sound = { ...OVERRIDE };
    expect(resolveRouletteSound(c, rlEffect(1, { rouletteId: 'rl-a' }))).toEqual(OVERRIDE);
  });

  it('cfg 未取得(null / undefined)は null = 無音 — 既定を鳴らし始めない', () => {
    // モニターは cfg.get が返る前にも演出を始めうる。既定を返すと、そこで
    // 回転音だけ先に鳴り出す(従来は cfg?.challenge.rouletteSound が undefined
    // → playBandBgm(undefined) → null で無音だった)。
    expect(resolveRouletteSound(null, rlEffect(1, { rouletteId: 'rl-a' }))).toBeNull();
    expect(resolveRouletteSound(undefined, rlEffect(1))).toBeNull();
  });
});

describe('sameRouletteBoard / mergeRoulette — 行の同一性と音の持ち主', () => {
  it('rouletteId は盤面キーに入らない(音だけ違う同一盤面は今までどおり連結できる)', () => {
    // 盤面キーは「出目 index の意味が同じか」= 正しさの判定。行 id を混ぜると
    // 表示名も出目も向きも同じ別行が畳めなくなり、モニターのキュー満杯時に
    // 「バナーのみでリールが出ない」経路へ落ちる頻度が上がる。
    expect(
      sameRouletteBoard(rlEffect(1, { rouletteId: 'rl-a' }), rlEffect(2, { rouletteId: 'rl-b' }))
    ).toBe(true);
    // 盤面そのものが違えば従来どおり false。
    expect(sameRouletteBoard(rlEffect(1), rlEffect(2, { rouletteSegments: [5, 11] }))).toBe(false);
  });

  it('連結後の rouletteId は先頭 a のもの(見出し nickname と同じ規約)', () => {
    // 連結後に実際に鳴るのは1本目の音なので、effect が持つ行と鳴る音を一致させる。
    const m = mergeRoulette(rlEffect(1, { rouletteId: 'rl-a' }), rlEffect(2, { rouletteId: 'rl-b' }));
    expect(m.rouletteId).toBe('rl-a');
    expect(m.nickname).toBe('u1');
  });

  it('先頭 a が rouletteId を持たなければキーごと落ちる(undefined 値を残さない)', () => {
    const m = mergeRoulette(rlEffect(1), rlEffect(2, { rouletteId: 'rl-b' }));
    expect('rouletteId' in m).toBe(false);
  });
});

describe('ChallengeEngine — 行の同一性の焼き込み', () => {
  it('ギフト経路の effect に一致した行の rouletteId が載る', () => {
    const e = engine();
    e.handleEvent(gift({ giftId: '222' }));
    const fx = e.get().recentEffects[0]!;
    expect(fx.kind).toBe('roulette');
    expect(fx.rouletteId).toBe('rl-b');
  });

  it('行に sound を設定しても effect には音が載らない(cfg 直読みの契約)', () => {
    // 音は effect に焼き込まない設計。焼き込むとキューに積まれたスピンに
    // 設定変更が届かなくなる(「変えたのに反映されない」)。
    const c = cfg();
    c.roulettes[0]!.sound = { ...OVERRIDE };
    const e = engine(c);
    e.handleEvent(gift({ giftId: '111' }));
    const fx = e.get().recentEffects[0]!;
    expect(fx.rouletteId).toBe('rl-a');
    expect(fx).not.toHaveProperty('rouletteSound');
    expect(resolveRouletteSound(c, fx)).toEqual(OVERRIDE);
  });

  it('入室経路には rouletteJoin だけが載り rouletteId は載らない', () => {
    // 入室ルーレットは id を持たない単一設定なので、'join' 等を発明すると
    // ユーザーの行 id と衝突しうる。印は rouletteJoin 一本に保つ。
    const e = engine();
    e.handleEvent(join('j1'), true);
    const fx = e.get().recentEffects[0]!;
    expect(fx.rouletteJoin).toBe(true);
    expect('rouletteId' in fx).toBe(false);
  });

  it('testEffect(行指定)はその行の id を焼く — 行ごと ▶ で行の音が鳴る', () => {
    const e = engine();
    e.testEffect({ kind: 'roulette', rouletteId: 'rl-b' });
    expect(e.get().recentEffects[0]!.rouletteId).toBe('rl-b');
  });

  it('testEffect(パターン別 ▶)でも行の id が載る', () => {
    const e = engine();
    e.testEffect({ kind: 'roulette', rouletteId: 'rl-a', pattern: 'kick' });
    const fx = e.get().recentEffects[0]!;
    expect(fx.roulettePattern).toBe('kick');
    expect(fx.rouletteId).toBe('rl-a');
  });

  it('testEffect の対象行が消えていたら、実際に回った行(最初の有効行)の id を焼く', () => {
    // spec.rouletteId を鵜呑みにすると、フォールバックで回った盤面と鳴る音がズレる。
    const c = cfg();
    c.roulettes[0]!.enabled = false;
    const e = engine(c);
    e.testEffect({ kind: 'roulette', rouletteId: 'なくなった行' });
    expect(e.get().recentEffects[0]!.rouletteId).toBe('rl-b');
  });

  it('testEffect(join:true)は rouletteJoin のみで rouletteId は載らない', () => {
    const e = engine();
    e.testEffect({ kind: 'roulette', join: true });
    const fx = e.get().recentEffects[0]!;
    expect(fx.rouletteJoin).toBe(true);
    expect('rouletteId' in fx).toBe(false);
  });
});
