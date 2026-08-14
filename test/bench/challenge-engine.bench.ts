import { bench, describe } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import type { NormalizedEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * ChallengeEngine のホットパス(handleEvent / get)のベンチ。
 *
 * worker は単一スレッドで、handleEvent は onEvent(全イベント)から毎回呼ばれる —
 * ここが遅くなると press RPC / 2Hz delta(モニター演出)が直に引っかかる。
 * npm run bench で実行し、剪定・上限系の変更の前後で回帰を見る。
 */

let t = 0;
let seq = 0;
function base(id: string) {
  t += 50;
  seq += 1;
  return { msgId: `${id}-${t}`, tsMs: 1_700_000_000_000 + t, tsSource: 'server' as const, seq };
}

function likeEvent(i: number): NormalizedEvent {
  return {
    ...base(`like-${i}`),
    kind: 'like',
    viewer: { userId: `u${i % 5000}`, nickname: `視聴者${i % 5000}` },
    count: 5,
  } as NormalizedEvent;
}

function follow(i: number): NormalizedEvent {
  return {
    ...base(`f-${i}`),
    kind: 'social',
    sub: 'follow',
    viewer: { userId: `u${i}`, nickname: `視聴者${i}` },
  } as NormalizedEvent;
}

// cfg は本番同様「同じ参照を返す」— コールバック内で clone すると
// handleEvent ごとの clone コストを測ってしまい、エンジン自体の回帰が埋もれる。
const CFG = { ...structuredClone(DEFAULT_CHALLENGE), enabled: true };

describe('ChallengeEngine ホットパス', () => {
  bench('handleEvent: like ×10,000(5,000 ユニーク)', () => {
    const en = new ChallengeEngine(() => CFG);
    en.start();
    for (let i = 0; i < 10_000; i += 1) en.handleEvent(likeEvent(i));
  });

  bench('handleEvent: follow ×10,000 ユニーク(seenFollowers の成長込み)', () => {
    const en = new ChallengeEngine(() => CFG);
    en.start();
    for (let i = 0; i < 10_000; i += 1) en.handleEvent(follow(i));
  });

  bench('get(): 満載状態のスナップショット ×1,000', () => {
    const en = new ChallengeEngine(() => CFG);
    en.start();
    for (let i = 0; i < 5_000; i += 1) en.handleEvent(likeEvent(i));
    for (let i = 0; i < 1_000; i += 1) en.get();
  });
});
