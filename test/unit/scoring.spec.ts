import { describe, expect, it } from 'vitest';
import { DAY_MS, SCORE_EPOCH_MS } from '@shared/constants';
import {
  DEFAULT_SCORING,
  applyHysteresis,
  displayScore,
  epochFactor,
  medianIntervalDays,
  sessionPoints,
  tierOf,
  validateScoringConfig,
} from '@shared/scoring';

const cfg = DEFAULT_SCORING;
const NOW = SCORE_EPOCH_MS + 200 * DAY_MS;

const silent = { diamonds: 0, comments: 0, likes: 0, shares: 0, heartMe: 0, followed: false, subscribed: false };

describe('sessionPoints', () => {
  it('gives a silent attendee the visit weight and nothing else', () => {
    expect(sessionPoints(silent, cfg)).toBe(cfg.weights.visit);
  });

  it('ranks money above chatter, but never zeroes out simply showing up', () => {
    const chatty = sessionPoints({ ...silent, comments: 40, likes: 2000 }, cfg);
    const gifter = sessionPoints({ ...silent, diamonds: 500 }, cfg);
    expect(chatty).toBeGreaterThan(sessionPoints(silent, cfg));
    expect(gifter).toBeGreaterThan(chatty);
  });

  it('caps comments and likes so a spammer cannot outrank a supporter', () => {
    const capped = sessionPoints({ ...silent, comments: 10_000, likes: 10_000_000 }, cfg);
    const atCap = sessionPoints({ ...silent, comments: cfg.caps.comment, likes: cfg.caps.like }, cfg);
    expect(capped).toBe(atCap);
  });

  it('ignores negative or non-finite inputs', () => {
    expect(sessionPoints({ ...silent, diamonds: -100, comments: Number.NaN }, cfg)).toBe(cfg.weights.visit);
  });
});

describe('epoch-normalised decay', () => {
  it('round-trips: points scaled up at write time read back unchanged at that moment', () => {
    const at = SCORE_EPOCH_MS + 100 * DAY_MS;
    const p = 42;
    const stored = p * epochFactor(at, cfg.halfLifeDays);
    expect(displayScore(stored, cfg.halfLifeDays, at)).toBeCloseTo(p, 9);
  });

  it('halves after one half-life', () => {
    const at = SCORE_EPOCH_MS;
    const stored = 100 * epochFactor(at, cfg.halfLifeDays);
    const later = displayScore(stored, cfg.halfLifeDays, at + cfg.halfLifeDays * DAY_MS);
    expect(later).toBeCloseTo(50, 6);
  });

  it('preserves ordering without any recomputation — the whole point of the design', () => {
    const older = 100 * epochFactor(SCORE_EPOCH_MS + 10 * DAY_MS, cfg.halfLifeDays);
    const newer = 60 * epochFactor(SCORE_EPOCH_MS + 190 * DAY_MS, cfg.halfLifeDays);
    // score_e DESC must give the same answer as decaying both to any given `now`.
    const byStored = older > newer;
    const byDisplay =
      displayScore(older, cfg.halfLifeDays, NOW) > displayScore(newer, cfg.halfLifeDays, NOW);
    expect(byStored).toBe(byDisplay);
    for (const t of [NOW, NOW + 365 * DAY_MS, NOW + 5 * 365 * DAY_MS]) {
      expect(displayScore(older, cfg.halfLifeDays, t) > displayScore(newer, cfg.halfLifeDays, t)).toBe(byStored);
    }
  });

  it('stays inside double precision for a decade of accumulation', () => {
    const f = epochFactor(SCORE_EPOCH_MS + 10 * 365 * DAY_MS, cfg.halfLifeDays);
    expect(Number.isFinite(f)).toBe(true);
    expect(Number.isFinite(f * 1e6)).toBe(true);
  });
});

describe('tierOf', () => {
  const v = (over: Partial<Parameters<typeof tierOf>[0]>) => ({
    score: 0,
    visits: 0,
    diamondsLifetime: 0,
    isSubscriber: false,
    ...over,
  });

  it('requires both score and repeat visits for 常連', () => {
    expect(tierOf(v({ score: 100, visits: 2 }), cfg)).toBe(0);
    expect(tierOf(v({ score: 100, visits: 3 }), cfg)).toBe(1);
  });

  it('promotes on lifetime diamonds alone', () => {
    expect(tierOf(v({ diamondsLifetime: 500 }), cfg)).toBe(2);
    expect(tierOf(v({ diamondsLifetime: 3000 }), cfg)).toBe(3);
  });

  it('treats an active subscriber as VIP', () => {
    expect(tierOf(v({ isSubscriber: true }), cfg)).toBe(2);
  });
});

describe('hysteresis — tiers must not flicker week to week', () => {
  const input = { score: 290, visits: 50, diamondsLifetime: 0, isSubscriber: false };

  it('holds the tier when the drop is small', () => {
    expect(applyHysteresis(1, 2, NOW - 30 * DAY_MS, input, cfg, NOW)).toBe(2);
  });

  it('holds the tier when it was awarded recently, even on a big drop', () => {
    expect(applyHysteresis(0, 2, NOW - 2 * DAY_MS, { ...input, score: 10 }, cfg, NOW)).toBe(2);
  });

  it('demotes once the score is well below and the tier is old', () => {
    expect(applyHysteresis(0, 2, NOW - 60 * DAY_MS, { ...input, score: 10 }, cfg, NOW)).toBe(0);
  });

  it('promotes immediately — no hysteresis on the way up', () => {
    expect(applyHysteresis(3, 1, NOW, input, cfg, NOW)).toBe(3);
  });
});

describe('medianIntervalDays', () => {
  it('returns null with fewer than two visits', () => {
    expect(medianIntervalDays([])).toBeNull();
    expect(medianIntervalDays([NOW])).toBeNull();
  });

  it('computes the median gap for a weekly regular', () => {
    const t = [0, 7, 14, 21, 28].map((d) => NOW + d * DAY_MS);
    expect(medianIntervalDays(t)).toBe(7);
  });

  it('is robust to one long absence', () => {
    const t = [0, 7, 14, 100, 107].map((d) => NOW + d * DAY_MS);
    expect(medianIntervalDays(t)).toBe(7);
  });
});

describe('validateScoringConfig', () => {
  it('falls back to defaults for garbage input', () => {
    expect(validateScoringConfig(null)).toEqual(DEFAULT_SCORING);
    expect(validateScoringConfig({ weights: { visit: -5, diamond: 'x' } }).weights.visit).toBe(DEFAULT_SCORING.weights.visit);
  });

  it('keeps valid overrides', () => {
    expect(validateScoringConfig({ ...DEFAULT_SCORING, halfLifeDays: 90 }).halfLifeDays).toBe(90);
  });
});
