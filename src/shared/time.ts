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

/** 起床時刻の書式 'HH:mm'(24時間・ローカル時刻)。設定の検証と表示で共有する。 */
export const WAKE_TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * 'HH:mm' を「refMs 以前で最も近いその時刻」の epoch ms に解決する。
 * refMs より未来になるなら前日の同時刻 — 深夜配信(0時をまたぐ)で「今日の 5:30」を
 * 掴んで経過が負になるのを防ぐ。
 *
 * ここだけ jstDayStart 系のオフセット演算ではなくローカル時刻の setHours を使う。
 * モニターに出すのは配信者の壁時計時刻(LiveDashboard の hms() と同じ)であり、
 * 日本に DST は無いのでこれで厳密。
 */
export function wakeAnchorMs(hhmm: string, refMs: number): number | null {
  if (!WAKE_TIME_RE.test(hhmm)) return null;
  const d = new Date(refMs);
  d.setHours(Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5)), 0, 0);
  const t = d.getTime();
  return t > refMs ? t - DAY_MS : t;
}

/**
 * 起床からの経過 ms。refMs は「起床時刻がどの日か」を決める錨 —
 * 企画の開始時刻(未開始なら now)を渡す。now を錨にすると 24 時間を超えて
 * 起きている配信で 25時間3分 が 1時間3分 へ巻き戻る。
 */
export function wakeElapsedMs(hhmm: string, refMs: number, nowMs: number): number | null {
  const a = wakeAnchorMs(hhmm, refMs);
  return a === null ? null : Math.max(0, nowMs - a);
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
