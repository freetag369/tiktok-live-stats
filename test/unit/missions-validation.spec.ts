import { describe, expect, it } from 'vitest';
import { DEFAULT_MISSIONS, parseMissionConfig } from '@shared/missions';

/**
 * 回帰テスト: scope×metric の組み合わせ検証。
 *
 * かつて scope と metric は独立に検証されており、{ scope:'day', metric:'uniqueViewers' }
 * のような算出不能な組がパースを通過して「常に 0 の永久未達ミッション」になっていた
 * (設計方針「typo を無言で無効化しない」に反する)。
 */

function cfgWith(mission: Record<string, unknown>): unknown {
  return { schemaVersion: 1, missions: [mission] };
}

const BASE = { id: 'm1', labelJa: 'テスト', target: 5 };

describe('parseMissionConfig — scope×metric', () => {
  it('既定設定はそのまま通る', () => {
    expect(() => parseMissionConfig(structuredClone(DEFAULT_MISSIONS))).not.toThrow();
  });

  it.each([
    ['session', 'validStreamDays'],
    ['session', 'activeFans'],
    ['day', 'uniqueViewers'],
    ['day', 'comments'],
    ['day', 'validStreamDays'],
    ['week', 'uniqueViewers'],
    ['week', 'comments'],
  ])('scope %s × metric %s は算出できないのでエラー', (scope, metric) => {
    expect(() => parseMissionConfig(cfgWith({ ...BASE, scope, metric }))).toThrow(/算出できません/);
  });

  it.each([
    ['session', 'durationMin'],
    ['session', 'diamonds'],
    ['day', 'diamonds'],
    ['week', 'validStreamDays'],
    ['week', 'activeFans'],
  ])('scope %s × metric %s は有効', (scope, metric) => {
    expect(() => parseMissionConfig(cfgWith({ ...BASE, scope, metric }))).not.toThrow();
  });
});

describe('parseMissionConfig — 無言で捨てない', () => {
  it('未対応の timezone は明示エラー', () => {
    expect(() =>
      parseMissionConfig({ schemaVersion: 1, timezone: 'America/New_York', missions: [] })
    ).toThrow(/timezone/);
  });

  it('未対応の dayResetHour は明示エラー', () => {
    expect(() => parseMissionConfig({ schemaVersion: 1, dayResetHour: 4, missions: [] })).toThrow(/dayResetHour/);
  });

  it('validDay / activeFan の NaN・負値は弾く', () => {
    expect(() =>
      parseMissionConfig(cfgWith({ ...BASE, scope: 'week', metric: 'validStreamDays', validDay: { minDurationMin: -1 } }))
    ).toThrow(/minDurationMin/);
    expect(() =>
      parseMissionConfig(
        cfgWith({ ...BASE, scope: 'week', metric: 'activeFans', activeFan: { windowDays: Number.NaN, minComments: 1 } })
      )
    ).toThrow(/windowDays/);
  });
});
