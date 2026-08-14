import { describe, expect, it } from 'vitest';
import {
  clampFutureMs,
  jstDayNumber,
  jstHour,
  jstWeekStart,
  jstWeekday,
  normaliseTs,
  relativeDayJa,
  wakeAnchorMs,
  wakeElapsedMs,
} from '@shared/time';

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

/*
 * 何時起き。ここだけ Date.UTC ではなくローカルの new Date(y, m, d, h, mi) で
 * 基準を作る — 実装が壁時計時刻(setHours)で解決するので、UTC で組むと
 * テストが実行環境のタイムゾーン依存になる。
 */
const local = (y: number, mo: number, d: number, h: number, mi = 0): number =>
  new Date(y, mo, d, h, mi, 0, 0).getTime();

const HOUR = 3_600_000;

describe('wakeAnchorMs — 起床時刻がどの日か', () => {
  it('resolves to the same day when the time has already passed', () => {
    const ref = local(2026, 7, 1, 23, 0); // 8/1 23:00
    expect(wakeAnchorMs('05:30', ref)).toBe(local(2026, 7, 1, 5, 30));
  });

  it('falls back to YESTERDAY when the time is still ahead — 深夜配信で経過が負になる罠', () => {
    const ref = local(2026, 7, 2, 2, 0); // 8/2 02:00(0時をまたいだ配信)
    expect(wakeAnchorMs('05:30', ref)).toBe(local(2026, 7, 1, 5, 30));
  });

  it('accepts the boundaries and rejects anything else', () => {
    const ref = local(2026, 7, 1, 12, 0);
    expect(wakeAnchorMs('00:00', ref)).toBe(local(2026, 7, 1, 0, 0));
    expect(wakeAnchorMs('23:59', ref)).not.toBeNull();
    for (const bad of ['24:00', '7:30', '0730', '', '05:60', 'ab:cd']) {
      expect(wakeAnchorMs(bad, ref)).toBeNull();
    }
  });
});

describe('wakeElapsedMs — 錨は now ではなく企画の開始時刻', () => {
  it('counts from the wake instant', () => {
    const ref = local(2026, 7, 1, 23, 0);
    expect(wakeElapsedMs('05:30', ref, ref)).toBe(17 * HOUR + 30 * 60_000);
  });

  it('keeps growing past 24h instead of wrapping to 0 — 「0まで寝ない」が1日を超える', () => {
    const start = local(2026, 7, 1, 7, 0); // 7:00 起床・その時刻に開始
    const now = local(2026, 7, 2, 9, 0); // 翌日 9:00 = 26時間後
    expect(wakeElapsedMs('07:00', start, now)).toBe(26 * HOUR);
  });

  it('never goes negative when the clock jumps backwards', () => {
    const ref = local(2026, 7, 1, 12, 0);
    expect(wakeElapsedMs('11:00', ref, local(2026, 7, 1, 10, 0))).toBe(0);
  });

  it('returns null for an invalid time so the monitor draws nothing', () => {
    expect(wakeElapsedMs('25:00', Date.now(), Date.now())).toBeNull();
  });
});

describe('clampFutureMs — 時計の後方ステップで取り残された時刻の引き戻し', () => {
  it('時計が単調な限りは恒等(前進はさせない)', () => {
    expect(clampFutureMs(1000, 1000, 500)).toBe(1000);
    expect(clampFutureMs(1400, 1000, 500)).toBe(1400); // 正当な先行(上限内)
    expect(clampFutureMs(900, 1000, 500)).toBe(900); // 過去はそのまま
  });

  it('上限を超えた先行(後方ステップの痕跡)だけを上限まで引き戻す', () => {
    expect(clampFutureMs(1000 + 600_000, 1000, 500)).toBe(1500);
    expect(clampFutureMs(1000 + 600_000, 1000, 0)).toBe(1000); // 過去時刻の記録用(maxAhead 0)
  });
});
