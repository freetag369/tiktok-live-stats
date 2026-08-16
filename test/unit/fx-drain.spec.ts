import { describe, expect, it } from 'vitest';
import {
  FX_DRAIN_MAX_STEPS,
  FX_DRAIN_SEQ,
  bestDrainRank,
  drainFxQueues,
  peekNextDrainKind,
  runFxDrain,
  type FxDrainNext,
  type FxDrainQueues,
} from '@shared/fx-drain';
import { fxRank } from '@shared/fx-priority';

/**
 * ドレイン順序の凍結。順序の権威は fx-priority.ts の FX_PRIORITY_ORDER
 * (ユーザー決定の8ランク)で、ここは「キュー走査がその序列を正しく写すこと」を
 * 固定する。**順序を変えたいときは fx-priority.ts(とその spec)を先に変える** —
 * このファイルの期待値だけ書き換えるのは二重権威の温床なので禁止。
 */

type Q = FxDrainQueues<string>;

function q(over: Partial<Q> = {}): Q {
  return {
    achieved: null,
    strike: null,
    boosts: [],
    bands: [],
    joinRoulettes: [],
    roulettes: [],
    ...over,
  };
}

describe('FX_DRAIN_SEQ — 走査順は優先度表から導出される', () => {
  it('strike → boost → join-roulette → band → roulette(序列②③④⑥⑦⑧の写像)', () => {
    expect(FX_DRAIN_SEQ).toEqual(['strike', 'boost', 'join-roulette', 'band', 'roulette']);
  });
});

describe('drainFxQueues — 序列どおりに1件だけ取り出す', () => {
  const full = (): Q =>
    q({
      strike: { like: 2, stock: 1 },
      boosts: ['B1'],
      bands: ['C1'],
      joinRoulettes: ['J1'],
      roulettes: ['R1'],
    });

  it.each([
    // [説明, キューの内容, 期待 kind]
    ['全在庫なら strike(いいね満タンが最優先のドレイン)', full(), 'strike'],
    ['strike が無ければ boost', q({ boosts: ['B'], bands: ['C'], joinRoulettes: ['J'], roulettes: ['R'] }), 'boost'],
    ['boost が無ければ join-roulette(初見はカットインより先)', q({ bands: ['C'], joinRoulettes: ['J'], roulettes: ['R'] }), 'join-roulette'],
    ['join が無ければ band(カットインはギフトルーレットより先)', q({ bands: ['C'], roulettes: ['R'] }), 'band'],
    ['最後に roulette(ギフトルーレットは「その他」)', q({ roulettes: ['R'] }), 'roulette'],
  ] as const)('%s', (_d, queues, kind) => {
    const r = drainFxQueues(queues);
    expect(r.next?.kind).toBe(kind);
  });

  it('選ばれたキューだけが減る(strike は null へ)', () => {
    const queues = full();
    const r = drainFxQueues(queues);
    expect(r.next?.kind).toBe('strike');
    expect(queues.strike).toBeNull(); // 返す前に取る(shift-before-return と同じ規律)
    expect(queues.boosts).toEqual(['B1']);
    expect(queues.bands).toEqual(['C1']);
    expect(queues.joinRoulettes).toEqual(['J1']);
    expect(queues.roulettes).toEqual(['R1']);
  });

  it('各キューは FIFO(先に積んだものから出る)', () => {
    const queues = q({ boosts: ['B1', 'B2'], bands: ['C1'], roulettes: ['R1'] });
    const taken: string[] = [];
    for (;;) {
      const r = drainFxQueues(queues);
      if (!r.next) break;
      taken.push(r.next.kind === 'strike' ? 'strike' : `${r.next.kind}:${r.next.effect}`);
    }
    expect(taken).toEqual(['boost:B1', 'boost:B2', 'band:C1', 'roulette:R1']);
  });

  it('achieved は常に返り、開始スロットを消費しない(next とは独立)', () => {
    const withNext = q({ achieved: 'CLEAR', roulettes: ['R'] });
    const r1 = drainFxQueues(withNext);
    expect(r1.achieved).toBe('CLEAR');
    expect(r1.next?.kind).toBe('roulette');
    const idle = q({ achieved: 'CLEAR' });
    const r2 = drainFxQueues(idle);
    expect(r2.achieved).toBe('CLEAR');
    expect(r2.next).toBeNull();
  });

  it('全部空なら next: null(idle — 保留バナー回収は呼び出し側の仕事)', () => {
    expect(drainFxQueues(q()).next).toBeNull();
  });
});

describe('peekNextDrainKind / bestDrainRank — 取り出さない観測', () => {
  it('peek は取り出さずに次の種別を返す', () => {
    const queues = q({ boosts: ['B'], roulettes: ['R'] });
    expect(peekNextDrainKind(queues)).toBe('boost');
    expect(queues.boosts).toEqual(['B']); // 消費していない
    expect(peekNextDrainKind(q())).toBeNull();
  });

  it('bestDrainRank は strike の中身(like/stock)でランクが割れる', () => {
    expect(bestDrainRank(q({ strike: { like: 1, stock: 0 } }))).toBe(fxRank('strike-like'));
    expect(bestDrainRank(q({ strike: { like: 0, stock: 3 } }))).toBe(fxRank('strike-stock'));
    expect(bestDrainRank(q({ roulettes: ['R'] }))).toBe(fxRank('other'));
    expect(bestDrainRank(q({ joinRoulettes: ['J'], bands: ['C'] }))).toBe(fxRank('join-roulette'));
    expect(bestDrainRank(q())).toBeNull();
  });
});

describe('runFxDrain — 「何かが始まるまで」のドライバ', () => {
  it('断られたら次のキューへ落ち、skipped は序列順に並ぶ', () => {
    const queues = q({
      strike: { like: 0, stock: 2 },
      boosts: ['B1'],
      bands: ['C1'],
      joinRoulettes: ['J1'],
      roulettes: ['R1'],
    });
    const r = runFxDrain(queues, { start: () => false });
    expect(r.started).toBeNull();
    expect(r.skipped.map((s) => s.kind)).toEqual(['strike', 'boost', 'join-roulette', 'band', 'roulette']);
  });

  it('start が true を返した時点で止まり、残りは消費しない', () => {
    const queues = q({ boosts: ['B1'], bands: ['C1', 'C2'], roulettes: ['R1'] });
    const r = runFxDrain(queues, {
      start: (n) => n.kind === 'band', // boost は断る
    });
    expect(r.started?.kind).toBe('band');
    expect(queues.bands).toEqual(['C2']); // C1 は開始に消費
    expect(queues.roulettes).toEqual(['R1']); // 後続は無傷
  });

  it('achieved は最初の start より前に1回だけ再生される', () => {
    const queues = q({ achieved: 'CLEAR', boosts: ['B1', 'B2'] });
    const calls: string[] = [];
    const r = runFxDrain(queues, {
      playAchieved: (e) => calls.push(`play:${e}`),
      start: (n) => {
        calls.push(`start:${n.kind === 'strike' ? 'strike' : n.effect}`);
        return n.kind !== 'strike' && n.effect === 'B2'; // 1件目は断る
      },
    });
    expect(calls).toEqual(['play:CLEAR', 'start:B1', 'start:B2']);
    expect(r.achieved).toBe('CLEAR');
    expect(queues.achieved).toBeNull(); // 2周目で再度拾わない
  });

  it('満杯キューを全部断ると呼び出しは 37 回(= 1+4+4+4+24。上限の到達不能性の凍結)', () => {
    const queues = q({
      strike: { like: 1, stock: 1 },
      boosts: ['b1', 'b2', 'b3', 'b4'],
      bands: ['c1', 'c2', 'c3', 'c4'],
      joinRoulettes: ['j1', 'j2', 'j3', 'j4'],
      roulettes: Array.from({ length: 24 }, (_, i) => `r${i}`),
    });
    let calls = 0;
    const r = runFxDrain(queues, {
      start: () => {
        calls++;
        return false;
      },
    });
    expect(calls).toBe(37);
    expect(calls).toBeLessThan(FX_DRAIN_MAX_STEPS);
    expect(r.started).toBeNull();
  });

  it('maxSteps に達しても started: null へ安全に倒れる', () => {
    const queues = q({ boosts: ['B1', 'B2', 'B3'] });
    const r = runFxDrain(queues, { start: () => false }, 2);
    expect(r.started).toBeNull();
    expect(r.skipped.length).toBe(2);
  });

  it('ルーレットキューはラッパー型(R≠T)でも素通しできる(要素の中身は覗かない)', () => {
    type W = { e: string; resumeAt: number };
    const queues: FxDrainQueues<string, W> = {
      achieved: null,
      strike: null,
      boosts: [],
      bands: [],
      joinRoulettes: [],
      roulettes: [{ e: 'R1', resumeAt: 3 }],
    };
    const seen: FxDrainNext<string, W>[] = [];
    const r = runFxDrain(queues, {
      start: (n) => {
        seen.push(n);
        return true;
      },
    });
    expect(r.started?.kind).toBe('roulette');
    expect(seen[0]?.kind === 'roulette' && seen[0].effect.resumeAt).toBe(3);
  });
});
