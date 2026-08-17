import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_JOIN_ROULETTE,
  DEFAULT_ROULETTE,
  DEFAULT_ROULETTE_SOUND,
  ROULETTE_SUB_SPIN_SE,
  defaultRouletteSoundSub,
  resolveRouletteSound,
  rouletteCommonSound,
  rouletteHeadline,
  rouletteSoundOverrideToggle,
  validateChallengeConfig,
} from '@shared/challenge';
import type {
  ChallengeConfig,
  ChallengeEffect,
  ChallengeRouletteConfig,
  RouletteSoundConfig,
} from '@shared/dto';

/**
 * 「減らす(応援)のルーレットは音でも見分けが付く」の規則。
 *
 * 共通サウンドを**方向ごとの2組**にし、行の sound 上書きはこれまでどおり最優先。
 * 別ファイルにしてあるのは roulette-sound.spec.ts が別作業で編集中のため —
 * 検査している対象は独立しているので分けても抜けは出ない。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

/** 共通・応援共通のどちらとも確実に違う上書き値。 */
const OVERRIDE: RouletteSoundConfig = { ...DEFAULT_ROULETTE_SOUND, bgm: 'bgm-band3', bgmVolume: 33 };

function row(over: Partial<ChallengeRouletteConfig> = {}): ChallengeRouletteConfig {
  return { ...structuredClone(DEFAULT_ROULETTE), id: 'rl-a', label: 'A', giftId: '111', ...over };
}

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.roulettes = [row()];
  base.joinRoulette = { ...structuredClone(DEFAULT_JOIN_ROULETTE), enabled: true };
  // 共通と応援共通を機械的に区別できるようにしておく(既定の差は spinSe 1項目だけなので)。
  base.rouletteSound = { ...DEFAULT_ROULETTE_SOUND, bgmVolume: 11 };
  base.rouletteSoundSub = { ...DEFAULT_ROULETTE_SOUND, bgmVolume: 22 };
  return { ...base, enabled: true, ...over };
}

function rlEffect(over: Partial<ChallengeEffect> = {}): ChallengeEffect {
  return {
    id: 1,
    kind: 'roulette',
    amount: 5,
    valueAfter: 1000,
    atMs: NOW,
    rouletteLabel: 'ハートミー',
    rouletteSegments: [5, 10],
    rouletteIndexes: [0],
    rouletteIndex: 0,
    roulettePatterns: ['slow'],
    roulettePattern: 'slow',
    rouletteReels: 1,
    rouletteId: 'rl-a',
    nickname: 'u1',
    ...over,
  };
}

describe('rouletteCommonSound — 方向で共通が切り替わる', () => {
  it("'add' は rouletteSound、'sub' は rouletteSoundSub(参照そのもの)", () => {
    const c = cfg();
    expect(rouletteCommonSound(c, 'add')).toBe(c.rouletteSound);
    expect(rouletteCommonSound(c, 'sub')).toBe(c.rouletteSoundSub);
  });
});

describe('resolveRouletteSound — 方向対応後の解決順序', () => {
  it('上書き無しの行: sub は応援共通へ', () => {
    const c = cfg();
    expect(resolveRouletteSound(c, rlEffect({ rouletteDirection: 'sub' }))).toBe(c.rouletteSoundSub);
  });

  it("rouletteDirection 欠損(= 'add')は従来の共通へ", () => {
    const c = cfg();
    expect(resolveRouletteSound(c, rlEffect())).toBe(c.rouletteSound);
  });

  it('**行の sound 上書きは方向より強い** — 死んだコントロールを作らない', () => {
    const c = cfg({ roulettes: [row({ sound: { ...OVERRIDE } })] });
    expect(resolveRouletteSound(c, rlEffect({ rouletteDirection: 'sub' }))).toEqual(OVERRIDE);
  });

  it('行が見つからない(削除 / id 変更)+ sub でも応援共通へ倒れる', () => {
    const c = cfg();
    const got = resolveRouletteSound(c, rlEffect({ rouletteId: 'gone', rouletteDirection: 'sub' }));
    expect(got).toBe(c.rouletteSoundSub);
    // 既定へも「増やす側の共通」へも倒さない。
    expect(got).not.toBe(c.rouletteSound);
  });

  it('入室ルーレット: 上書き無しの sub は応援共通、上書きありは上書き', () => {
    const c = cfg();
    const e = rlEffect({ rouletteId: undefined, rouletteJoin: true, rouletteDirection: 'sub' });
    expect(resolveRouletteSound(c, e)).toBe(c.rouletteSoundSub);

    const c2 = cfg({
      joinRoulette: { ...structuredClone(DEFAULT_JOIN_ROULETTE), enabled: true, sound: { ...OVERRIDE } },
    });
    expect(resolveRouletteSound(c2, e)).toEqual(OVERRIDE);
  });

  it('**方向の権威は effect の焼き込み** — cfg の行の direction は見ない', () => {
    // 行は 'add' のままでも、effect が 'sub' を持っていれば応援共通で鳴る。
    // cfg の行から direction を読む実装だとここが落ちる(行削除やモニターの
    // 120 秒ポーリングで「過去のスピンの音が後から変わる」事故の入口)。
    const c = cfg({ roulettes: [row({ direction: 'add' })] });
    expect(resolveRouletteSound(c, rlEffect({ rouletteDirection: 'sub' }))).toBe(c.rouletteSoundSub);
  });

  it('cfg 未取得は sub でも null(無音) — 既定へ倒さない既存規約は不変', () => {
    expect(resolveRouletteSound(null, rlEffect({ rouletteDirection: 'sub' }))).toBeNull();
    expect(resolveRouletteSound(undefined, rlEffect({ rouletteDirection: 'sub' }))).toBeNull();
  });
});

describe('rouletteSoundOverrideToggle — 種は「その行の方向の共通」', () => {
  it('sub の行でチェックをオンにしても鳴る音が変わらない', () => {
    const c = cfg();
    const seed = rouletteSoundOverrideToggle(true, rouletteCommonSound(c, 'sub'));
    expect(seed).toEqual(c.rouletteSoundSub);
    expect(seed).not.toEqual(c.rouletteSound);
  });

  it('オフは undefined(キーごと落ちて共通へ復帰)', () => {
    expect(rouletteSoundOverrideToggle(false, cfg().rouletteSoundSub)).toBeUndefined();
  });
});

describe('defaultRouletteSoundSub / validateChallengeConfig — 欠損フォールバックが移行の代わり', () => {
  it('キー欠損: 回転ループ音だけカチカチ、他は共通と同じ', () => {
    const saved = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    delete saved.rouletteSoundSub;
    const v = validateChallengeConfig(saved);
    expect(v.rouletteSoundSub.spinSe).toBe(ROULETTE_SUB_SPIN_SE);
    expect(v.rouletteSoundSub).toEqual({ ...v.rouletteSound, spinSe: ROULETTE_SUB_SPIN_SE });
  });

  it('**共通の回転音を自分で選び直している人は寄せない** — その選択を引き継ぐ', () => {
    const saved = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    delete saved.rouletteSoundSub;
    (saved.rouletteSound as RouletteSoundConfig).spinSe = 'spin-slot';
    const v = validateChallengeConfig(saved);
    expect(v.rouletteSoundSub).toEqual(v.rouletteSound);
    expect(v.rouletteSoundSub.spinSe).toBe('spin-slot');
  });

  it('共通のBGM設定は応援側にも引き継がれる(差分は回転ループ音1項目だけ)', () => {
    const saved = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    delete saved.rouletteSoundSub;
    Object.assign(saved.rouletteSound as RouletteSoundConfig, { bgm: 'bgm-roulette1', bgmVolume: 44 });
    const v = validateChallengeConfig(saved);
    expect(v.rouletteSoundSub.bgm).toBe('bgm-roulette1');
    expect(v.rouletteSoundSub.bgmVolume).toBe(44);
  });

  it('型崩れ(null / 文字列 / 数値 / 配列 / 真偽)は欠損と同じ既定へ', () => {
    for (const bad of [null, 'x', 42, [], true]) {
      const saved = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
      saved.rouletteSoundSub = bad;
      expect(validateChallengeConfig(saved).rouletteSoundSub, String(bad)).toEqual(
        defaultRouletteSoundSub(DEFAULT_ROULETTE_SOUND)
      );
    }
  });

  it('明示値は保持しつつ共通と同一のサニタイズ(未知 id → 既定 / 音量 clamp)', () => {
    const saved = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    saved.rouletteSoundSub = { bgm: 'nope', bgmVolume: 999, spinSe: 'nope', spinSeVolume: -5, clipVolume: 50 };
    const v = validateChallengeConfig(saved).rouletteSoundSub;
    expect(v.bgm).toBe(DEFAULT_ROULETTE_SOUND.bgm);
    expect(v.spinSe).toBe(DEFAULT_ROULETTE_SOUND.spinSe);
    expect(v.bgmVolume).toBe(100);
    expect(v.spinSeVolume).toBe(0);
    expect(v.clipVolume).toBe(50);
  });

  it('二度通しても値が動かない(実体化後は冪等)', () => {
    const once = validateChallengeConfig(structuredClone(DEFAULT_CHALLENGE));
    expect(validateChallengeConfig(once)).toEqual(once);
  });

  it('既定の設定はそのまま通る(DEFAULT_CHALLENGE の自己一致)', () => {
    expect(validateChallengeConfig(DEFAULT_CHALLENGE)).toEqual(DEFAULT_CHALLENGE);
  });
});

describe('rouletteHeadline — 応援は「お助け」を名乗る', () => {
  it("'sub' で後置きが変わる", () => {
    expect(rouletteHeadline({ rouletteLabel: 'ハートミー', rouletteDirection: 'sub' })).toEqual({
      prefix: 'ハートミー ',
      suffix: 'がルーレットでお助け!',
    });
  });

  it("'add' / 欠損は従来のまま", () => {
    expect(rouletteHeadline({ rouletteLabel: 'ハートミー' }).suffix).toBe('がルーレット');
    expect(rouletteHeadline({ rouletteLabel: 'ハートミー', rouletteDirection: 'add' }).suffix).toBe(
      'がルーレット'
    );
  });

  it('前置きの規約(label → giftName → 無し)は向きに影響されない', () => {
    expect(rouletteHeadline({ giftName: 'Heart Me', rouletteDirection: 'sub' }).prefix).toBe('Heart Me ');
    expect(rouletteHeadline({ rouletteDirection: 'sub' }).prefix).toBe('');
  });
});

/** 配線のソース検査 — 剥がれると設定が恒久的に効かなくなる種類の事故を止める。 */
describe('配線 — 設定UIが共有ヘルパを使っている', () => {
  const ui = readFileSync(resolve(__dirname, '../../src/renderer/screens/Challenge.tsx'), 'utf8').replace(/\r\n/g, '\n');

  it('行エディタと入室ルーレットの両方が方向対応の種を渡す', () => {
    expect(ui.split('rouletteCommonSound(').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('共通サウンドのフォームが3つ(共通add / 共通sub / 行の上書き)', () => {
    expect(ui.split('<RouletteSoundFields').length - 1).toBeGreaterThanOrEqual(3);
  });

  it('応援共通を素通しで直読みしていない(必ずヘルパ経由)', () => {
    expect(ui).not.toContain('cfg.challenge.rouletteSoundSub');
  });

  it('プレビュー文言を直書きに戻していない(rouletteHeadline から作る)', () => {
    expect(ui).toContain('rouletteHeadline({ rouletteDirection: rl.direction }).suffix');
    expect(ui).toContain('rouletteHeadline({ rouletteDirection: jr.direction }).suffix');
  });
});
