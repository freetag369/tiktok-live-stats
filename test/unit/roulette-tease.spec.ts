import { describe, expect, it } from 'vitest';
import {
  isJackPattern,
  rouletteTeaseInit,
  rouletteTeaseNext,
  rouletteTeaseStep,
  type RouletteTeaseState,
} from '@shared/roulette-tease';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_ROULETTE_TEASE,
  ROULETTE_JACK_PATTERNS,
  ROULETTE_TEASE_COUNTS,
  validateChallengeConfig,
} from '@shared/challenge';
import { ROULETTE_PATTERNS, ROULETTE_PATTERN_TIER } from '@shared/dto';
import type { RoulettePattern } from '@shared/dto';

const JACKS = ROULETTE_JACK_PATTERNS;
const ALLOWED = [...JACKS];

describe('isJackPattern / ROULETTE_JACK_PATTERNS', () => {
  it('jack 3種のみ真(doublefake は heavy だが jack ではない)', () => {
    expect(JACKS).toEqual(['jackstop', 'jackslip', 'jackback']);
    for (const p of ROULETTE_PATTERNS) {
      expect(isJackPattern(p)).toBe(JACKS.includes(p));
    }
    expect(isJackPattern('doublefake')).toBe(false);
  });

  it('jack 3種は全て heavy 段位(doublefake への降格で尺・走行距離が変わらない前提)', () => {
    for (const p of JACKS) expect(ROULETTE_PATTERN_TIER[p]).toBe('heavy');
    expect(ROULETTE_PATTERN_TIER.doublefake).toBe('heavy');
  });
});

describe('rouletteTeaseNext / rouletteTeaseInit — 5 or 7 の抽選', () => {
  it('rand の境界でも ROULETTE_TEASE_COUNTS の中しか返さない', () => {
    expect(rouletteTeaseNext(() => 0)).toBe(ROULETTE_TEASE_COUNTS[0]);
    // rand() は [0,1) の契約だが、万一 1 が来ても最後の候補へクランプする。
    expect(rouletteTeaseNext(() => 0.999999)).toBe(ROULETTE_TEASE_COUNTS[ROULETTE_TEASE_COUNTS.length - 1]);
    expect(rouletteTeaseNext(() => 1)).toBe(ROULETTE_TEASE_COUNTS[ROULETTE_TEASE_COUNTS.length - 1]);
    expect(rouletteTeaseNext(() => 0.49)).toBe(5);
    expect(rouletteTeaseNext(() => 0.5)).toBe(7);
  });

  it('init は remaining に 5 or 7 を積む', () => {
    expect(rouletteTeaseInit(() => 0)).toEqual({ remaining: 5 });
    expect(rouletteTeaseInit(() => 0.9)).toEqual({ remaining: 7 });
  });
});

describe('rouletteTeaseStep — カウント進行と発動', () => {
  it('lastOne を remaining 回踏むと最後の1回だけ発動し、state が引き直される', () => {
    let state: RouletteTeaseState = { remaining: 5 };
    const fired: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      // 毎回 light の 'slow' を引いた体。発動回だけ jack に化けるはず。
      const r = rouletteTeaseStep(state, 'slow', { lastOne: true, allowed: ALLOWED }, () => 0);
      fired.push(isJackPattern(r.pattern));
      state = r.state;
    }
    expect(fired).toEqual([false, false, false, false, true]);
    // 発動後は 5 or 7 で引き直し(rand=0 → 5)。
    expect(state).toEqual({ remaining: 5 });
  });

  it('lastOne=false(キュー途中)はカウントを進めず、jack を doublefake へ降格する', () => {
    const state: RouletteTeaseState = { remaining: 3 };
    for (const p of JACKS) {
      const r = rouletteTeaseStep(state, p, { lastOne: false, allowed: ALLOWED }, () => 0);
      expect(r.pattern).toBe('doublefake');
      expect(r.state).toEqual({ remaining: 3 });
    }
    // jack 以外は素通し(light/mid/heavy(doublefake)/ultra とも触らない)。
    for (const p of ['slow', 'kick', 'doublefake', 'dragon'] as RoulettePattern[]) {
      const r = rouletteTeaseStep(state, p, { lastOne: false, allowed: ALLOWED }, () => 0);
      expect(r.pattern).toBe(p);
      expect(r.state).toEqual({ remaining: 3 });
    }
  });

  it('非発動の lastOne も jack は doublefake へ降格、他は素通し', () => {
    const state: RouletteTeaseState = { remaining: 2 }; // 消費後 1 が残る = 非発動
    const jack = rouletteTeaseStep(state, 'jackslip', { lastOne: true, allowed: ALLOWED }, () => 0);
    expect(jack.pattern).toBe('doublefake');
    expect(jack.state).toEqual({ remaining: 1 });
    const ultra = rouletteTeaseStep(state, 'lion', { lastOne: true, allowed: ALLOWED }, () => 0);
    expect(ultra.pattern).toBe('lion');
    expect(ultra.state).toEqual({ remaining: 1 });
  });

  it('発動回: 引いた jack はそのまま採用、非 jack は allowed から等重みで差し替え', () => {
    const state: RouletteTeaseState = { remaining: 1 };
    // 引きが jack → その jack を尊重(rand は引き直し用にだけ使われる)。
    const kept = rouletteTeaseStep(state, 'jackback', { lastOne: true, allowed: ALLOWED }, () => 0);
    expect(kept.pattern).toBe('jackback');
    // 非 jack → allowed の添字を rand で選ぶ。
    for (const [rand, want] of [
      [0, ALLOWED[0]],
      [0.34, ALLOWED[1]],
      [0.99, ALLOWED[2]],
    ] as const) {
      const r = rouletteTeaseStep(state, 'slow', { lastOne: true, allowed: ALLOWED }, () => rand);
      expect(r.pattern).toBe(want);
      expect(ROULETTE_TEASE_COUNTS).toContain(r.state.remaining);
    }
    // allowed を絞れば必ずその中から出る(設定の patterns チェックリストの契約)。
    const only = rouletteTeaseStep(state, 'slow', { lastOne: true, allowed: ['jackslip'] }, () => 0.9);
    expect(only.pattern).toBe('jackslip');
  });

  it('allowed が空(保険)の発動回: 非 jack は差し替えられず素通し、引いた jack はそのまま', () => {
    // allowed は「非 jack を何に差し替えるか」の抽選候補にだけ使う。発動回に
    // 引いた jack は allowed に関係なく採用する(信頼度抽選の顔を立てる)。
    const state: RouletteTeaseState = { remaining: 1 };
    expect(rouletteTeaseStep(state, 'slow', { lastOne: true, allowed: [] }, () => 0).pattern).toBe('slow');
    expect(rouletteTeaseStep(state, 'jackstop', { lastOne: true, allowed: [] }, () => 0).pattern).toBe(
      'jackstop'
    );
  });
});

describe('validateRouletteTease — 旧 settings.json との互換', () => {
  it('キー欠損(旧 settings.json)は既定(enabled:true・jack 3種)へ倒れる', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.rouletteTease;
    const v = validateChallengeConfig(legacy);
    expect(v.rouletteTease).toEqual(DEFAULT_ROULETTE_TEASE);
    expect(v.rouletteTease.enabled).toBe(true);
  });

  it('既定 true の向き: enabled は false のときだけ false(!== false)', () => {
    const off = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteTease: { enabled: false, patterns: [...JACKS] },
    });
    expect(off.rouletteTease.enabled).toBe(false);
    const junk = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteTease: { enabled: 'no', patterns: [...JACKS] },
    });
    expect(junk.rouletteTease.enabled).toBe(true);
  });

  it('patterns は jack 3種との積集合、空・未知のみは既定(3種全部)へ', () => {
    const mixed = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteTease: { enabled: true, patterns: ['jackslip', 'slow', 'nope'] },
    });
    expect(mixed.rouletteTease.patterns).toEqual(['jackslip']);
    const empty = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      rouletteTease: { enabled: true, patterns: ['nope'] },
    });
    expect(empty.rouletteTease.patterns).toEqual([...JACKS]);
    const junk = validateChallengeConfig({ ...DEFAULT_CHALLENGE, rouletteTease: 'x' });
    expect(junk.rouletteTease).toEqual(DEFAULT_ROULETTE_TEASE);
  });
});
