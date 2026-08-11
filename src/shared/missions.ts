import { DAY_MS } from './constants';
import { jstDayStart, jstWeekStart } from './time';
import type { MissionConfig, MissionDef, MissionInputs, MissionMetric, MissionProgress, MissionScope } from './dto';

/**
 * 報酬ミッション HUD.
 *
 * TikTok revises reward conditions (last known change 2025-08-04), so thresholds
 * are NEVER hardcoded — they come from a JSON file the user can edit. A broken
 * file falls back to the bundled default and shows a non-fatal banner.
 */

export const DEFAULT_MISSIONS: MissionConfig = {
  schemaVersion: 1,
  sourceNote: 'TikTok は報酬条件を改定します（直近の既知の変更: 2025-08-04）。数値は必ずご自身でご確認ください。',
  timezone: 'Asia/Tokyo',
  dayResetHour: 0,
  weekStartsOn: 'monday',
  missions: [
    { id: 'stream_25min', labelJa: '配信25分以上', scope: 'session', metric: 'durationMin', target: 25 },
    { id: 'followers_5', labelJa: '新規フォロワー5人', scope: 'session', metric: 'newFollowers', target: 5 },
    {
      id: 'valid_days_2',
      labelJa: '週間有効配信日数',
      scope: 'week',
      metric: 'validStreamDays',
      target: 2,
      validDay: { minDurationMin: 25 },
    },
    {
      id: 'active_fans',
      labelJa: 'アクティブファン数',
      scope: 'week',
      metric: 'activeFans',
      target: 10,
      activeFan: { windowDays: 7, minComments: 1 },
    },
    { id: 'daily_diamonds', labelJa: '日間ダイヤ', scope: 'day', metric: 'diamonds', target: 5000, pacer: true },
  ],
};

const VALID_SCOPES: ReadonlySet<string> = new Set<MissionScope>(['session', 'day', 'week']);
const VALID_METRICS: ReadonlySet<string> = new Set<MissionMetric>([
  'durationMin',
  'newFollowers',
  'validStreamDays',
  'activeFans',
  'diamonds',
  'uniqueViewers',
  'comments',
]);

export class MissionConfigError extends Error {}

/** Strict — anything unrecognised is an error, so a typo does not silently disable a mission. */
export function parseMissionConfig(raw: unknown): MissionConfig {
  if (!raw || typeof raw !== 'object') throw new MissionConfigError('設定ファイルがオブジェクトではありません');
  const c = raw as Partial<MissionConfig>;
  if (c.schemaVersion !== 1) throw new MissionConfigError(`schemaVersion は 1 のみ対応です（実際: ${String(c.schemaVersion)}）`);
  if (!Array.isArray(c.missions)) throw new MissionConfigError('missions が配列ではありません');

  const seen = new Set<string>();
  const missions: MissionDef[] = c.missions.map((m, i) => {
    const at = `missions[${i}]`;
    if (!m || typeof m !== 'object') throw new MissionConfigError(`${at} がオブジェクトではありません`);
    const d = m as Partial<MissionDef>;
    if (typeof d.id !== 'string' || !d.id) throw new MissionConfigError(`${at}.id が不正です`);
    if (seen.has(d.id)) throw new MissionConfigError(`${at}.id が重複しています: ${d.id}`);
    seen.add(d.id);
    if (typeof d.labelJa !== 'string' || !d.labelJa) throw new MissionConfigError(`${at}.labelJa が不正です`);
    if (!VALID_SCOPES.has(d.scope as string)) throw new MissionConfigError(`${at}.scope が不正です: ${String(d.scope)}`);
    if (!VALID_METRICS.has(d.metric as string)) throw new MissionConfigError(`${at}.metric が不正です: ${String(d.metric)}`);
    if (typeof d.target !== 'number' || !Number.isFinite(d.target) || d.target <= 0)
      throw new MissionConfigError(`${at}.target は正の数値である必要があります`);
    const out: MissionDef = {
      id: d.id,
      labelJa: d.labelJa,
      scope: d.scope as MissionScope,
      metric: d.metric as MissionMetric,
      target: d.target,
    };
    if (d.pacer) out.pacer = true;
    if (d.validDay && typeof d.validDay.minDurationMin === 'number') out.validDay = { minDurationMin: d.validDay.minDurationMin };
    if (d.activeFan && typeof d.activeFan.windowDays === 'number' && typeof d.activeFan.minComments === 'number')
      out.activeFan = { windowDays: d.activeFan.windowDays, minComments: d.activeFan.minComments };
    return out;
  });

  return {
    schemaVersion: 1,
    sourceNote: typeof c.sourceNote === 'string' ? c.sourceNote : DEFAULT_MISSIONS.sourceNote,
    timezone: 'Asia/Tokyo',
    dayResetHour: 0,
    weekStartsOn: c.weekStartsOn === 'sunday' ? 'sunday' : 'monday',
    missions,
  };
}

function metricValue(m: MissionDef, inputs: MissionInputs): number {
  const s = inputs.session;
  switch (m.scope) {
    case 'session':
      if (!s) return 0;
      switch (m.metric) {
        case 'durationMin':
          return s.durationMin;
        case 'newFollowers':
          return s.newFollowers;
        case 'diamonds':
          return s.diamonds;
        case 'uniqueViewers':
          return s.uniqueViewers;
        case 'comments':
          return s.comments;
        default:
          return 0;
      }
    case 'day':
      switch (m.metric) {
        case 'diamonds':
          return inputs.day.diamonds;
        case 'durationMin':
          return inputs.day.durationMin;
        case 'newFollowers':
          return inputs.day.newFollowers;
        default:
          return 0;
      }
    case 'week':
      switch (m.metric) {
        case 'validStreamDays':
          return inputs.week.validStreamDays;
        case 'activeFans':
          return inputs.week.activeFans;
        case 'diamonds':
          return inputs.week.diamonds;
        case 'durationMin':
          return inputs.week.durationMin;
        case 'newFollowers':
          return inputs.week.newFollowers;
        default:
          return 0;
      }
    default:
      return 0;
  }
}

/** Fraction of the mission's window that has already elapsed — drives the pacer. */
function windowElapsed(m: MissionDef, inputs: MissionInputs, cfg: MissionConfig): number | undefined {
  const now = inputs.nowMs;
  if (m.scope === 'day') {
    const start = jstDayStart(now);
    return clamp01((now - start) / DAY_MS);
  }
  if (m.scope === 'week') {
    const start = jstWeekStart(now, cfg.weekStartsOn === 'sunday' ? 0 : 1);
    return clamp01((now - start) / (7 * DAY_MS));
  }
  return undefined;
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

export function evaluateMissions(cfg: MissionConfig, inputs: MissionInputs): MissionProgress[] {
  return cfg.missions.map((m) => {
    const current = metricValue(m, inputs);
    const elapsed = windowElapsed(m, inputs, cfg);
    const p: MissionProgress = {
      id: m.id,
      labelJa: m.labelJa,
      scope: m.scope,
      current,
      target: m.target,
      done: current >= m.target,
    };
    if (elapsed !== undefined) {
      p.windowElapsed = elapsed;
      if (m.pacer && elapsed > 0.02) p.projected = Math.round(current / elapsed);
    }
    return p;
  });
}
