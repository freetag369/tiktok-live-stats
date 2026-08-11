import { DAY_MS, SCORE_EPOCH_MS } from './constants';
import type { ScoringConfig } from './dto';

/**
 * 貢献度スコア — pure functions, unit-tested standalone.
 *
 * Design intent: money dominates, but simply showing up is never worth zero.
 * With the defaults, a silent every-stream regular scores ~5/session, a chatty
 * regular ~25, and a ¥500 gifter 350–1,000.
 */

export const DEFAULT_SCORING: ScoringConfig = {
  weights: {
    visit: 5,
    diamond: 1.0,
    // caps below keep a spammer from outranking a supporter
    comment: 1.0,
    like: 1.0, // per 100 likes
    share: 3,
    follow: 10,
    subscribe: 50,
    // Heart Me is already worth 1 diamond; default 0 avoids double counting.
    heartMe: 0,
  },
  caps: { comment: 30, like: 1000, share: 2 },
  halfLifeDays: 60,
  tiers: { regular: 60, vip: 300, topVip: 1200 },
  tierDiamonds: { vip: 500, topVip: 3000 },
  minVisitsForRegular: 3,
  demotionFactor: 0.85,
};

export interface SessionPointInput {
  diamonds: number;
  comments: number;
  likes: number;
  shares: number;
  heartMe: number;
  followed: boolean;
  subscribed: boolean;
}

/** Points earned by one viewer in one session, before recency decay. */
export function sessionPoints(v: SessionPointInput, cfg: ScoringConfig): number {
  const { weights: w, caps } = cfg;
  return (
    w.visit +
    w.diamond * nn(v.diamonds) +
    w.comment * Math.min(nn(v.comments), caps.comment) +
    (w.like * Math.min(nn(v.likes), caps.like)) / 100 +
    w.share * Math.min(nn(v.shares), caps.share) +
    w.follow * (v.followed ? 1 : 0) +
    w.subscribe * (v.subscribed ? 1 : 0) +
    w.heartMe * nn(v.heartMe)
  );
}

function nn(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Epoch-normalised accumulator.
 *
 * Naively decaying every viewer nightly is O(all viewers)/day and makes the
 * ordering drift. Instead each session's points are scaled UP by the session's
 * age factor at write time; ordering by score_e DESC is then correct at every
 * instant with zero recomputation, because all viewers share one monotone factor.
 */
export function epochFactor(sessionStartMs: number, halfLifeDays: number): number {
  return Math.pow(2, (sessionStartMs - SCORE_EPOCH_MS) / (halfLifeDays * DAY_MS));
}

/** Convert a stored score_e back to a human-comparable score at `now`. */
export function displayScore(scoreE: number, halfLifeDays: number, now = Date.now()): number {
  if (!Number.isFinite(scoreE) || scoreE <= 0) return 0;
  return scoreE * Math.pow(2, -(now - SCORE_EPOCH_MS) / (halfLifeDays * DAY_MS));
}

/** The inverse — used by SQL that can only order by score_e. */
export function scoreEOf(displayed: number, halfLifeDays: number, now = Date.now()): number {
  return displayed * Math.pow(2, (now - SCORE_EPOCH_MS) / (halfLifeDays * DAY_MS));
}

export const TIER_LABEL_JA = ['一般', '常連', 'VIP', 'トップVIP'] as const;

export interface TierInput {
  score: number;
  visits: number;
  diamondsLifetime: number;
  isSubscriber: boolean;
}

/** 0 = 一般, 1 = 常連, 2 = VIP, 3 = トップVIP. */
export function tierOf(v: TierInput, cfg: ScoringConfig): number {
  if (v.score >= cfg.tiers.topVip || v.diamondsLifetime >= cfg.tierDiamonds.topVip) return 3;
  if (v.score >= cfg.tiers.vip || v.diamondsLifetime >= cfg.tierDiamonds.vip || v.isSubscriber) return 2;
  if (v.score >= cfg.tiers.regular && v.visits >= cfg.minVisitsForRegular) return 1;
  return 0;
}

/**
 * Tiers flicker week to week without hysteresis: demotion requires falling
 * meaningfully below the threshold AND having held the tier for a while.
 */
export function applyHysteresis(
  proposed: number,
  current: number,
  tierSinceMs: number | null,
  v: TierInput,
  cfg: ScoringConfig,
  now = Date.now()
): number {
  if (proposed >= current) return proposed;
  const heldLongEnough = tierSinceMs != null && now - tierSinceMs >= 14 * DAY_MS;
  if (!heldLongEnough) return current;
  const floor = thresholdFor(current, cfg) * cfg.demotionFactor;
  const diamondFloor = diamondThresholdFor(current, cfg);
  if (v.score >= floor || (diamondFloor > 0 && v.diamondsLifetime >= diamondFloor)) return current;
  return proposed;
}

function thresholdFor(tier: number, cfg: ScoringConfig): number {
  if (tier >= 3) return cfg.tiers.topVip;
  if (tier === 2) return cfg.tiers.vip;
  if (tier === 1) return cfg.tiers.regular;
  return 0;
}

function diamondThresholdFor(tier: number, cfg: ScoringConfig): number {
  if (tier >= 3) return cfg.tierDiamonds.topVip;
  if (tier === 2) return cfg.tierDiamonds.vip;
  return 0;
}

/** Median gap between visits, in days — the churn baseline. */
export function medianIntervalDays(sortedStartMs: readonly number[]): number | null {
  if (sortedStartMs.length < 2) return null;
  const gaps: number[] = [];
  for (let i = 1; i < sortedStartMs.length; i++) {
    const a = sortedStartMs[i - 1]!;
    const b = sortedStartMs[i]!;
    gaps.push((b - a) / DAY_MS);
  }
  gaps.sort((x, y) => x - y);
  const mid = gaps.length >> 1;
  return gaps.length % 2 ? gaps[mid]! : (gaps[mid - 1]! + gaps[mid]!) / 2;
}

export function validateScoringConfig(raw: unknown): ScoringConfig {
  const c = raw as Partial<ScoringConfig> | null | undefined;
  if (!c || typeof c !== 'object') return { ...DEFAULT_SCORING };
  const d = DEFAULT_SCORING;
  const num = (v: unknown, fb: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : fb);
  return {
    weights: {
      visit: num(c.weights?.visit, d.weights.visit),
      diamond: num(c.weights?.diamond, d.weights.diamond),
      comment: num(c.weights?.comment, d.weights.comment),
      like: num(c.weights?.like, d.weights.like),
      share: num(c.weights?.share, d.weights.share),
      follow: num(c.weights?.follow, d.weights.follow),
      subscribe: num(c.weights?.subscribe, d.weights.subscribe),
      heartMe: num(c.weights?.heartMe, d.weights.heartMe),
    },
    caps: {
      comment: num(c.caps?.comment, d.caps.comment),
      like: num(c.caps?.like, d.caps.like),
      share: num(c.caps?.share, d.caps.share),
    },
    halfLifeDays: Math.max(1, num(c.halfLifeDays, d.halfLifeDays)),
    tiers: {
      regular: num(c.tiers?.regular, d.tiers.regular),
      vip: num(c.tiers?.vip, d.tiers.vip),
      topVip: num(c.tiers?.topVip, d.tiers.topVip),
    },
    tierDiamonds: {
      vip: num(c.tierDiamonds?.vip, d.tierDiamonds.vip),
      topVip: num(c.tierDiamonds?.topVip, d.tierDiamonds.topVip),
    },
    minVisitsForRegular: Math.max(1, num(c.minVisitsForRegular, d.minVisitsForRegular)),
    demotionFactor: Math.min(1, Math.max(0.1, num(c.demotionFactor, d.demotionFactor))),
  };
}
