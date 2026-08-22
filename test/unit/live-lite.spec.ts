import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LiveDelta, LiveMessage, LiveTotals } from '@shared/ipc';
import type { ChallengeState } from '@shared/dto';
import { liteLiveMessage } from '@shared/live-lite';

/**
 * lite ポート(モニター窓)向け間引きの契約(2026-08-22)。
 *
 * 破ってはいけない線は2本:
 *  (1) challenge / totals / sessionId は**無加工**で通す — 演出 watermark と
 *      押下の即時反映(7セグ)の入力なので、ここを触ると表示が壊れる。
 *  (2) feed は null(送らない)、delta の viewers/alerts は空 — モニターの
 *      liveStore(lite)は読まずに捨てるだけなので、送ること自体が無駄。
 */

const TOTALS: LiveTotals = {
  viewers: 12,
  peakViewers: 20,
  totalViewers: 100,
  roomTotalLikes: 5000,
  observedLikes: 4000,
  diamonds: 321,
  heartMe: 7,
  comments: 90,
  newFollowers: 3,
  shares: 1,
  uniqueViewers: 80,
  firstTimers: 5,
  elapsedMs: 123_456,
};

const CHALLENGE = { status: 'running', value: 42 } as unknown as ChallengeState;

function delta(over: Partial<LiveDelta> = {}): LiveDelta {
  return {
    t: 'delta',
    tick: 7,
    atMs: 1_000,
    sessionId: 3,
    totals: TOTALS,
    viewers: [{ u: 'u1' } as never],
    alerts: [{ kind: 'join' } as never],
    missions: [{ id: 'm' } as never],
    challenge: CHALLENGE,
    deferred: 5,
    ...over,
  };
}

describe('liteLiveMessage', () => {
  it('feed は送らない(null)', () => {
    const m: LiveMessage = { t: 'feed', tick: 1, items: [], dropped: 0 } as unknown as LiveMessage;
    expect(liteLiveMessage(m)).toBeNull();
  });

  it('delta は viewers/alerts を空にし、missions/deferred を落とす', () => {
    const out = liteLiveMessage(delta()) as LiveDelta;
    expect(out.t).toBe('delta');
    expect(out.viewers).toEqual([]);
    expect(out.alerts).toEqual([]);
    expect('missions' in out).toBe(false);
    expect(out.deferred).toBe(0);
  });

  it('challenge / totals / sessionId は**参照ごと**素通し(watermark と即時性の入力)', () => {
    const d = delta();
    const out = liteLiveMessage(d) as LiveDelta;
    expect(out.challenge).toBe(CHALLENGE);
    expect(out.totals).toBe(TOTALS);
    expect(out.sessionId).toBe(3);
    expect(out.tick).toBe(7);
    expect(out.atMs).toBe(1_000);
  });

  it('challenge 相乗りなしの tick ではキーごと載せない(delta の相乗り規約)', () => {
    const d = delta();
    delete d.challenge;
    const out = liteLiveMessage(d) as LiveDelta;
    expect('challenge' in out).toBe(false);
  });

  it('status / job は同一参照で素通し', () => {
    const status = { t: 'status', status: { state: 'live' }, sessionId: 1 } as unknown as LiveMessage;
    expect(liteLiveMessage(status)).toBe(status);
    const job = { t: 'job', jobId: 'j', phase: 'run', done: 0 } as unknown as LiveMessage;
    expect(liteLiveMessage(job)).toBe(job);
  });
});

describe('配線(ソース不変条件 — fx-video-pool.spec.ts と同型)', () => {
  const read = (rel: string): string =>
    readFileSync(resolve(rel), 'utf8').replace(/\r\n/g, '\n');

  it('worker の pushLive が lite ポートへ liteLiveMessage を通す', () => {
    const src = read('src/worker/index.ts');
    expect(src).toContain('liteLiveMessage');
    // feed の意図的破棄は delivered 扱い(main 経由フォールバックへ倒さない)。
    expect(src).toMatch(/out === null[\s\S]{0,200}delivered = true/);
  });

  it('モニター窓の attachRenderer は lite: true(メイン窓には付けない)', () => {
    const src = read('src/main/index.ts');
    expect([...src.matchAll(/attachRenderer\([^)]*\{ lite: true \}\)/g)].length).toBe(2);
  });

  it('worker-host は再配線(ready)でも lite フラグを引き継ぐ', () => {
    const src = read('src/main/worker-host.ts');
    expect(src).toMatch(/for \(const \[wc, o\] of this\.wcs\) this\.wireFeedPort\(wc, o\.lite\);/);
    expect(src).toContain("postMessage({ t: 'feedPort', lite }, [port1])");
  });

  it('受け側 liveStore の lite ガードは残っている(main 経由フォールバックの防御)', () => {
    const src = read('src/renderer/state/liveStore.ts');
    expect(src).toContain('if (lite) return;');
  });
});
