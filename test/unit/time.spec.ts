import { describe, expect, it } from 'vitest';
import { jstDayNumber, jstHour, jstWeekStart, jstWeekday, normaliseTs, relativeDayJa } from '@shared/time';

const NOW = Date.UTC(2026, 6, 28, 3, 0, 0); // 2026-07-28 12:00 JST (Tuesday)

describe('normaliseTs — the seconds/milliseconds trap', () => {
  it('multiplies epoch SECONDS up to milliseconds', () => {
    const secs = Math.floor(NOW / 1000);
    // The naive `Number(x) || Date.now()` passes 1.78e9 through as truthy and
    // every row lands in 1970.
    expect(normaliseTs(String(secs), NOW)).toEqual({ ts: NOW, source: 'server' });
  });

  it('passes epoch milliseconds through unchanged', () => {
    expect(normaliseTs(String(NOW), NOW)).toEqual({ ts: NOW, source: 'server' });
  });

  it('falls back to now for empty, zero, or garbage values', () => {
    for (const v of ['', '0', 'abc', null, undefined, -5]) {
      expect(normaliseTs(v, NOW)).toEqual({ ts: NOW, source: 'local' });
    }
  });

  it('clamps implausible timestamps rather than storing them', () => {
    const wayOff = NOW + 400 * 86_400_000;
    expect(normaliseTs(String(wayOff), NOW)).toEqual({ ts: NOW, source: 'local' });
  });

  it('accepts a timestamp a few minutes in the past', () => {
    const recent = NOW - 120_000;
    expect(normaliseTs(String(recent), NOW).ts).toBe(recent);
  });
});

describe('JST bucketing — integer maths, no timezone library', () => {
  it('puts 2026-07-28 12:00 JST on a Tuesday', () => {
    expect(jstWeekday(NOW)).toBe(2);
    expect(jstHour(NOW)).toBe(12);
  });

  it('attributes 23:50 JST and 00:40 JST to different days', () => {
    const late = Date.UTC(2026, 6, 28, 14, 50, 0); // 23:50 JST on the 28th
    const past = Date.UTC(2026, 6, 28, 15, 40, 0); // 00:40 JST on the 29th
    expect(jstDayNumber(late)).toBe(jstDayNumber(NOW));
    expect(jstDayNumber(past)).toBe(jstDayNumber(NOW) + 1);
  });

  it('starts the week on Monday', () => {
    const start = jstWeekStart(NOW, 1);
    expect(jstWeekday(start)).toBe(1);
    expect(NOW - start).toBeLessThan(7 * 86_400_000);
  });
});

describe('relativeDayJa', () => {
  it('formats in the units a streamer actually reads', () => {
    expect(relativeDayJa(NOW, NOW)).toBe('今日');
    expect(relativeDayJa(NOW - 86_400_000, NOW)).toBe('昨日');
    expect(relativeDayJa(NOW - 14 * 86_400_000, NOW)).toBe('14日前');
    expect(relativeDayJa(NOW - 90 * 86_400_000, NOW)).toBe('3ヶ月前');
    expect(relativeDayJa(null, NOW)).toBe('—');
  });
});
