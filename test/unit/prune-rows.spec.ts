import { describe, expect, it } from 'vitest';
import type { UserId } from '@shared/events';
import { pruneLiveRows } from '@shared/live-rows';

/**
 * liveStore の rows Map は上限が無く、破棄は配信開始の瞬間だけだった。
 * 耐久配信ではユニーク視聴者数に比例して単調増加する。
 */
type Row = { lastSeenMs: number };
const mk = (spec: Array<[string, number]>): Map<UserId, Row> =>
  new Map(spec.map(([id, ts]) => [id as UserId, { lastSeenMs: ts }]));

// TTL(30分)より十分大きい基準時刻にしないと cutoff が負になり、境界の検査にならない。
const NOW = 10_000_000;
const TTL = 30 * 60_000;

describe('pruneLiveRows', () => {
  it('TTL より古い行だけを消す(境界はちょうど TTL 前を残す)', () => {
    const rows = mk([
      ['keep-now', NOW],
      ['keep-edge', NOW - TTL], // ちょうど境界 = 残す
      ['drop', NOW - TTL - 1],
      ['drop-old', 0],
    ]);
    expect(pruneLiveRows(rows, NOW, TTL, 1000)).toBe(2);
    expect([...rows.keys()].sort()).toEqual(['keep-edge', 'keep-now']);
  });

  it('全員が新しければ何も消さない', () => {
    const rows = mk([['a', NOW], ['b', NOW - 1], ['c', NOW - 2]]);
    expect(pruneLiveRows(rows, NOW, TTL, 1000)).toBe(0);
    expect(rows.size).toBe(3);
  });

  it('空の Map でも落ちない', () => {
    const rows = mk([]);
    expect(pruneLiveRows(rows, NOW, TTL, 10)).toBe(0);
    expect(rows.size).toBe(0);
  });

  it('TTL 内でも上限を超えたら古い順に落として上限ちょうどにする', () => {
    // 全員 TTL 内(レイドで短時間に大量のユニークが来た想定)
    const rows = mk(Array.from({ length: 50 }, (_, i) => [`u${i}`, NOW - i] as [string, number]));
    expect(pruneLiveRows(rows, NOW, TTL, 10)).toBe(40);
    expect(rows.size).toBe(10);
    // 残るのは lastSeenMs が新しい 10 人 = u0..u9
    expect([...rows.keys()].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))).toEqual(
      Array.from({ length: 10 }, (_, i) => `u${i}`)
    );
  });

  it('TTL 削除と上限削除の合計を返す', () => {
    const rows = mk([
      ...Array.from({ length: 5 }, (_, i) => [`old${i}`, NOW - TTL - 1] as [string, number]),
      ...Array.from({ length: 20 }, (_, i) => [`new${i}`, NOW - i] as [string, number]),
    ]);
    // 古い5件 + 上限超過15件
    expect(pruneLiveRows(rows, NOW, TTL, 5)).toBe(20);
    expect(rows.size).toBe(5);
  });

  it('長時間の配信を模しても件数が上限で頭打ちになる', () => {
    const rows = new Map<UserId, Row>();
    const CAP = 1000;
    let t = NOW;
    // 6時間ぶん、1分あたり50人の新規が来る
    for (let minute = 0; minute < 360; minute += 1) {
      t += 60_000;
      for (let i = 0; i < 50; i += 1) rows.set(`m${minute}_${i}` as UserId, { lastSeenMs: t });
      pruneLiveRows(rows, t, TTL, CAP);
    }
    expect(rows.size).toBeLessThanOrEqual(CAP);
    // 剪定が無ければ 18,000 件になっていた
    expect(360 * 50).toBe(18_000);
  });
});
