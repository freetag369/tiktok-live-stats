import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { ReplayAdapter } from '../../src/worker/tiktok/replay-adapter';
import { ChallengeEngine } from '../../src/worker/challenge';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import type { NormalizedEvent } from '@shared/events';

/**
 * The replay harness.
 *
 * `ReplayAdapter` implements the same TikTokAdapter contract as the live one, so
 * these tests exercise the real normalize -> Store path against captured NDJSON.
 * Everything here is provable without going live; §9-2 of the plan lists what
 * genuinely needs a real room.
 */

let dir: string;
let store: Store;

const ALIASES = {
  idAliases: {},
  nameRules: [{ canonical: 'heart_me', match: ['heart me', 'ハートミー'] }],
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-replay-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, ALIASES);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

/** Runs a fixture through the adapter and applies every event to the store. */
async function replay(fixture: string, sessionId: number): Promise<NormalizedEvent[]> {
  const events: NormalizedEvent[] = [];
  const adapter = new ReplayAdapter(
    {
      event: (e) => events.push(e),
      status: () => undefined,
    },
    { file: join('fixtures', fixture), speed: 0 }
  );
  await adapter.connect({ uniqueId: 'replay', waitUntilLive: false, processInitialData: true });
  // speed 0 still yields to the event loop per line; wait for the stream to drain.
  await new Promise((r) => setTimeout(r, 250));
  store.applyBatch(sessionId, events);
  return events;
}

function newSession(startedMs = Date.UTC(2026, 6, 28, 12, 0, 0)): number {
  return store.openSession({ hostUserId: 'h', hostUniqueId: 'me', roomId: 'r1', startedMs }).sessionId;
}

function counts(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ['viewer', 'comment', 'gift_event', 'like_bucket', 'join_event', 'social_event', 'viewer_identity_history']) {
    out[t] = (store.rawAll(`SELECT COUNT(*) AS c FROM ${t}`) as Array<{ c: number }>)[0]!.c;
  }
  return out;
}

describe('replay — gift streaks', () => {
  it('collapses a 4-tick combo into exactly one gift', async () => {
    const sid = newSession();
    const events = await replay('synth-gift-streak.ndjson', sid);
    // The three mid-streak messages never leave the normalizer.
    expect(events.filter((e) => e.kind === 'gift')).toHaveLength(1);
    const t = store.getSessionTotals(sid)!;
    expect(t.gifts).toBe(1);
    expect(t.diamonds).toBe(4);
    expect(counts().gift_event).toBe(1);
  });
});

describe('replay — reconnect safety', () => {
  it('adds nothing on the second pass of the same backlog', async () => {
    const sid = newSession();
    // `durationMs` on a still-open session is derived from the wall clock, so it
    // legitimately moves between the two snapshots.
    const snapshot = () => {
      const { durationMs, ...rest } = store.getSessionTotals(sid)!;
      void durationMs;
      return { ...counts(), ...rest };
    };

    await replay('synth-reconnect-replay.ndjson', sid);
    const first = snapshot();

    // Replay the whole fixture again, exactly as a reconnect would.
    await replay('synth-reconnect-replay.ndjson', sid);

    expect(snapshot()).toEqual(first);
  });

  it('does not double-count likes, which accumulate rather than insert', async () => {
    const sid = newSession();
    await replay('synth-reconnect-replay.ndjson', sid);
    // The fixture contains the same like message twice.
    expect(store.getSessionTotals(sid)!.observedLikes).toBe(15);
  });
});

describe('replay — synthetic message keys', () => {
  it('is stable when TikTok sends no msgId', async () => {
    const sid = newSession();
    await replay('synth-missing-msgid.ndjson', sid);
    const after1 = counts();
    await replay('synth-missing-msgid.ndjson', sid);
    // A Date.now()-based synthetic key would grow this on every pass.
    expect(counts()).toEqual(after1);
    expect(after1.comment).toBe(2);
  });
});

describe('replay — identity changes', () => {
  it('keeps one viewer across a rename and logs both identities', async () => {
    const sid = newSession();
    await replay('synth-handle-change.ndjson', sid);
    const c = counts();
    expect(c.viewer).toBe(1);
    expect(c.viewer_identity_history).toBe(2);
    expect(store.getViewer('1', sid)!.row.displayId).toBe('new_handle');
  });
});

describe('replay — ハートミー', () => {
  it('counts a Heart Me gift whose id we have never seen, via the name rule', async () => {
    const sid = newSession();
    await replay('synth-heart-me.ndjson', sid);
    // The seeded ids are guesses; the name rule is what actually guarantees the
    // product's headline metric is not silently zero.
    expect(store.getSessionTotals(sid)!.heartMe).toBe(3);
    expect(store.getViewer('4', sid)!.row.heartMeLifetime).toBe(3);
  });

  it('spins the gift roulette on the live path (canonical is absent by design)', async () => {
    // The fixture's gift id (888888) is unknown, so the trigger must fall back to
    // the gift-name match — exactly what a TikTok-side id change would look like.
    const sid = newSession();
    const events = await replay('synth-heart-me.ndjson', sid);

    const engine = new ChallengeEngine(
      () => ({ ...structuredClone(DEFAULT_CHALLENGE), enabled: true }),
      () => Date.UTC(2026, 6, 28, 12, 0, 0),
      () => 0, // 既定盤面の先頭 = 出目 +5
      Math.random,
      () => undefined
    );
    engine.start();
    for (const e of events) engine.handleEvent(e);

    const s = engine.get();
    // The fixture is 2 gift messages carrying 3 taps (repeatCount 2 then 1) ->
    // one DRAW per tap = 3 draws of +5 each, but only 2 effects (one per message:
    // the first carries 2 draws, the second 1). The default perDiamond rule must
    // still NOT stack on top.
    expect(s.stats.rouletteSpins).toBe(3);
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 15);
    const spins = s.recentEffects.filter((e) => e.kind === 'roulette');
    expect(spins).toHaveLength(2);
    expect(spins.flatMap((e) => e.rouletteIndexes!)).toHaveLength(3);
    expect(spins[0]!.rouletteSegments![spins[0]!.rouletteIndex!]).toBe(5);
    // The monitor headline reads "ハートミー ○○がルーレット". The label rides on the
    // effect (self-contained) — the live path never carries canonical, so a
    // cfg-side lookup in the monitor would be the wrong place to resolve it.
    expect(spins[0]!.rouletteLabel).toBe('ハートミー');
  });

  it('draws once per gift in a 17-rose combo, and applies every one to the value', async () => {
    // 実運用DBで観測された最大コンボ(バラ17連打)の回帰テスト。v0.5.4 では
    // 演出用の giftRepeatFx.max(既定 5)が抽選回数まで削っており、17個ぶん
    // 贈られたのに5回ぶんしか値が動かなかった(12個ぶんが消える)。
    const sid = newSession();
    const events = await replay('synth-rose-combo.ndjson', sid);
    // normalize が中間ティックを畳むので、届くギフトは repeatCount=17 の1通だけ。
    expect(events.filter((e) => e.kind === 'gift')).toHaveLength(1);

    const base = structuredClone(DEFAULT_CHALLENGE);
    const engine = new ChallengeEngine(
      () => ({
        ...base,
        enabled: true,
        // 既定はハートミー行だけなので、バラ用の行を足す(実出荷の既定と同じ構成)。
        roulettes: [
          ...base.roulettes,
          { ...base.roulettes[0]!, id: 'rl-rose', label: 'バラ', giftId: '5655', giftName: 'rose', canonical: '' },
        ],
      }),
      () => Date.UTC(2026, 6, 28, 12, 0, 0),
      () => 0, // 盤面の先頭 = +5
      Math.random,
      () => undefined
    );
    engine.start();
    for (const e of events) engine.handleEvent(e);

    const s = engine.get();
    expect(s.stats.rouletteSpins).toBe(17);
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 85); // +5 ×17
    // 1ギフトメッセージ = 1 effect。リングバッファを17件で食い潰さない。
    const rl = s.recentEffects.filter((e) => e.kind === 'roulette');
    expect(rl).toHaveLength(1);
    expect(rl[0]!.rouletteIndexes).toHaveLength(17);
    expect(rl[0]!.rouletteReels).toBe(17); // 17本とも回る(ROULETTE_REELS_MAX=20 以内)
    expect(rl[0]!.giftCount).toBe(17);
  });

  it('still draws once per gift when giftRepeatFx.rouletteEnabled is off', async () => {
    // rouletteEnabled を切っても**抽選回数と値は個数ぶんのまま**。減るのはモニターが
    // 回すリールの本数だけ(rouletteReels)。演出設定で視聴者のギフトぶんの値が
    // 消えていた v0.5.4 の不具合の回帰テスト。
    const sid = newSession();
    const events = await replay('synth-heart-me.ndjson', sid);

    const base = structuredClone(DEFAULT_CHALLENGE);
    const engine = new ChallengeEngine(
      () => ({
        ...base,
        enabled: true,
        giftRepeatFx: { ...base.giftRepeatFx, rouletteEnabled: false },
      }),
      () => Date.UTC(2026, 6, 28, 12, 0, 0),
      () => 0,
      Math.random,
      () => undefined
    );
    engine.start();
    for (const e of events) engine.handleEvent(e);

    const s = engine.get();
    expect(s.stats.rouletteSpins).toBe(3);
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 15);
    // 2連打のメッセージは 2 抽選ぶんの値が入っているが、リールは1本だけ回す。
    const first = s.recentEffects.filter((e) => e.kind === 'roulette').at(-1)!;
    expect(first.rouletteIndexes).toHaveLength(2);
    expect(first.rouletteReels).toBe(1);
  });
});

describe('replay — rollup consistency', () => {
  it('keeps lifetime totals equal to the sum of per-session rollups', async () => {
    const sid = newSession();
    await replay('synth-small-room.ndjson', sid);
    store.closeSession(sid, { endedMs: Date.UTC(2026, 6, 28, 13, 0, 0), reason: 'streamEnd' });

    const mismatches = store.rawAll(`
      SELECT vl.user_id
        FROM viewer_lifetime vl
       WHERE vl.comments <> COALESCE((SELECT SUM(comments) FROM viewer_session_stat WHERE user_id = vl.user_id), 0)
          OR vl.likes    <> COALESCE((SELECT SUM(likes)    FROM viewer_session_stat WHERE user_id = vl.user_id), 0)
          OR vl.diamonds <> COALESCE((SELECT SUM(diamonds) FROM viewer_session_stat WHERE user_id = vl.user_id), 0)
          OR vl.visits   <> COALESCE((SELECT COUNT(*)      FROM viewer_session_stat WHERE user_id = vl.user_id), 0)
    `);
    expect(mismatches).toEqual([]);

    const t = store.getSessionTotals(sid)!;
    const rawComments = (store.rawAll('SELECT COUNT(*) AS c FROM comment') as Array<{ c: number }>)[0]!.c;
    expect(t.comments).toBe(rawComments);
    expect(t.uniqueViewers).toBe(counts().viewer);
  });

  it('leaves the database internally consistent', async () => {
    const sid = newSession();
    await replay('synth-small-room.ndjson', sid);
    expect(store.rawAll('PRAGMA integrity_check')).toEqual([{ integrity_check: 'ok' }]);
    expect(store.rawAll('PRAGMA foreign_key_check')).toEqual([]);
  });
});
