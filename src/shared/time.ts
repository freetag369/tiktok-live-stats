import { DAY_MS, JST_OFFSET_MS } from './constants';

/**
 * Normalise a TikTok timestamp to epoch milliseconds.
 *
 * `common.createTime` arrives as a STRING and it is not documented whether it is
 * epoch seconds or milliseconds. The naive `Number(x) || Date.now()` is unsafe:
 * epoch seconds (~1.78e9) is a truthy finite number, so `||` never fires and
 * every row silently lands in 1970.
 *
 * Magnitude guard + sanity clamp, so the ingest path is correct either way.
 */
export function normaliseTs(raw: unknown, now = Date.now()): { ts: number; source: 'server' | 'local' } {
  const n = typeof raw === 'bigint' ? Number(raw) : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return { ts: now, source: 'local' };
  // < 1e12 means it cannot be epoch-ms (1e12 ms ≈ 2001-09), so it must be seconds.
  const ts = n < 1e12 ? n * 1000 : n;
  if (Math.abs(ts - now) > 7 * DAY_MS) return { ts: now, source: 'local' };
  return { ts, source: 'server' };
}

/** Start-of-day in JST, returned as epoch ms. JST has no DST, so integer maths is exact. */
export function jstDayStart(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS) * DAY_MS - JST_OFFSET_MS;
}

/** JST day number since epoch — the grouping key for 有効配信日数. */
export function jstDayNumber(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / DAY_MS);
}

/** 0 = Sunday … 6 = Saturday, in JST. 1970-01-01 was a Thursday, hence the +4. */
export function jstWeekday(ms: number): number {
  return (jstDayNumber(ms) + 4) % 7;
}

/** 0–23 in JST. */
export function jstHour(ms: number): number {
  return Math.floor((ms + JST_OFFSET_MS) / 3_600_000) % 24;
}

/** Start of the containing week in JST. weekStartsOn: 0 = Sunday, 1 = Monday. */
export function jstWeekStart(ms: number, weekStartsOn: 0 | 1 = 1): number {
  const wd = jstWeekday(ms);
  const back = (wd - weekStartsOn + 7) % 7;
  return jstDayStart(ms) - back * DAY_MS;
}

export const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

export function formatDurationJa(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return h > 0 ? `${h}時間${m}分` : `${m}分`;
}

/** 「3日前」「今日」 — used everywhere a 前回来店日 is shown. */
export function relativeDayJa(ms: number | null | undefined, now = Date.now()): string {
  if (ms == null) return '—';
  const days = jstDayNumber(now) - jstDayNumber(ms);
  if (days <= 0) return '今日';
  if (days === 1) return '昨日';
  if (days < 31) return `${days}日前`;
  const months = Math.floor(days / 30);
  return months < 12 ? `${months}ヶ月前` : `${Math.floor(days / 365)}年前`;
}

export function formatDateJa(ms: number | null | undefined): string {
  if (ms == null) return '—';
  const d = new Date(ms + JST_OFFSET_MS);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}/${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}
