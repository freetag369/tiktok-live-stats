import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSIONS, MissionConfigError, evaluateMissions, parseMissionConfig } from '@shared/missions';
import { jstDayStart } from '@shared/time';
import type { MissionInputs } from '@shared/dto';

const NOW = Date.UTC(2026, 6, 28, 3, 0, 0); // 12:00 JST

function inputs(over: Partial<MissionInputs> = {}): MissionInputs {
  return {
    nowMs: NOW,
    session: { durationMin: 0, newFollowers: 0, diamonds: 0, uniqueViewers: 0, comments: 0 },
    day: { diamonds: 0, durationMin: 0, newFollowers: 0 },
    week: { validStreamDays: 0, activeFans: 0, diamonds: 0, durationMin: 0, newFollowers: 0 },
    ...over,
  };
}

describe('parseMissionConfig — strict, so a typo cannot silently disable a mission', () => {
  it('accepts the bundled default', () => {
    expect(() => parseMissionConfig(DEFAULT_MISSIONS)).not.toThrow();
  });

  it('rejects an unknown schemaVersion', () => {
    expect(() => parseMissionConfig({ ...DEFAULT_MISSIONS, schemaVersion: 2 })).toThrow(MissionConfigError);
  });

  it('rejects an unknown metric', () => {
    expect(() =>
      parseMissionConfig({
        schemaVersion: 1,
        missions: [{ id: 'x', labelJa: 'x', scope: 'session', metric: 'nonsense', target: 1 }],
      })
    ).toThrow(/metric/);
  });

  it('rejects a duplicate id', () => {
    expect(() =>
      parseMissionConfig({
        schemaVersion: 1,
        missions: [
          { id: 'a', labelJa: 'a', scope: 'day', metric: 'diamonds', target: 1 },
          { id: 'a', labelJa: 'b', scope: 'day', metric: 'diamonds', target: 2 },
        ],
      })
    ).toThrow(/重複/);
  });

  it('rejects a non-positive target', () => {
    expect(() =>
      parseMissionConfig({
        schemaVersion: 1,
        missions: [{ id: 'a', labelJa: 'a', scope: 'day', metric: 'diamonds', target: 0 }],
      })
    ).toThrow(/target/);
  });

  it('preserves a user-edited threshold', () => {
    const cfg = parseMissionConfig({
      ...DEFAULT_MISSIONS,
      missions: DEFAULT_MISSIONS.missions.map((m) => (m.id === 'stream_25min' ? { ...m, target: 30 } : m)),
    });
    expect(cfg.missions.find((m) => m.id === 'stream_25min')?.target).toBe(30);
  });
});

describe('evaluateMissions', () => {
  it('marks a mission done once the target is reached', () => {
    const r = evaluateMissions(DEFAULT_MISSIONS, inputs({ session: { durationMin: 30, newFollowers: 0, diamonds: 0, uniqueViewers: 0, comments: 0 } }));
    expect(r.find((m) => m.id === 'stream_25min')?.done).toBe(true);
    expect(r.find((m) => m.id === 'followers_5')?.done).toBe(false);
  });

  it('reads zero for session missions when no stream is running', () => {
    const r = evaluateMissions(DEFAULT_MISSIONS, inputs({ session: null }));
    expect(r.find((m) => m.id === 'stream_25min')?.current).toBe(0);
  });

  it('projects the day-end total for pacer missions', () => {
    // Half the JST day has elapsed at 12:00, so 2,500 now projects to ~5,000.
    const r = evaluateMissions(DEFAULT_MISSIONS, inputs({ day: { diamonds: 2500, durationMin: 60, newFollowers: 0 } }));
    const pacer = r.find((m) => m.id === 'daily_diamonds');
    expect(pacer?.windowElapsed).toBeCloseTo(0.5, 1);
    expect(pacer?.projected).toBeGreaterThan(4500);
    expect(pacer?.projected).toBeLessThan(5500);
  });

  it('measures the day window from JST midnight', () => {
    const start = jstDayStart(NOW);
    const r = evaluateMissions(DEFAULT_MISSIONS, inputs({ nowMs: start + 60_000, day: { diamonds: 10, durationMin: 1, newFollowers: 0 } }));
    expect(r.find((m) => m.id === 'daily_diamonds')?.windowElapsed).toBeLessThan(0.01);
  });
});
