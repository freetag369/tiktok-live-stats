import { bench, describe } from 'vitest';
import { pruneLiveRows } from '@shared/live-rows';
import { BoundedSet } from '@shared/bounded-set';

/**
 * 剪定・上限系の純ロジックのベンチ。
 *
 * pruneLiveRows は worker(session.meta の10分償却)とレンダラ(liveStore.rows)の
 * 両方で回る。ハードキャップ経路はソートを含むので、10万行級での所要を見ておく。
 */

function rows(n: number): Map<string, { lastSeenMs: number }> {
  const m = new Map<string, { lastSeenMs: number }>();
  for (let i = 0; i < n; i += 1) m.set(`u${i}`, { lastSeenMs: i });
  return m;
}

describe('pruneLiveRows', () => {
  bench('TTL のみ(10万行・半分が期限切れ)', () => {
    const m = rows(100_000);
    pruneLiveRows(m, 100_000, 50_000, 200_000);
  });

  bench('ハードキャップ経路(10万行 → 2万行、ソートあり)', () => {
    const m = rows(100_000);
    pruneLiveRows(m, 100_000, 200_000, 20_000);
  });
});

describe('BoundedSet', () => {
  bench('add ×100,000(cap 20,000、追い出し・詰め直し込み)', () => {
    const s = new BoundedSet<string>(20_000);
    for (let i = 0; i < 100_000; i += 1) s.add(`u${i}`);
  });
});
