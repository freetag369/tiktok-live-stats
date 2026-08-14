import { describe, expect, it } from 'vitest';
import { drainFxQueues, type FxDrainQueues } from '@shared/fx-drain';

/**
 * 演出終了時のドレイン順序の固定。
 *
 * この順序は MonitorView の4つの finish(+安全弁の expire)が従う契約で、
 * 過去に「譲ったのに誰も再生しない」系のバグを潰しながら固まったもの。
 * 1ビットも変えないための回帰テスト。
 */

function q(over: Partial<FxDrainQueues<string>> = {}): FxDrainQueues<string> {
  return { achieved: null, boosts: [], bands: [], roulettes: [], ...over };
}

describe('drainFxQueues: 順序の固定', () => {
  // テーブル: [キューの中身, roulette-first の期待, standard の期待]
  const cases: Array<{
    name: string;
    queues: () => FxDrainQueues<string>;
    rouletteFirst: string | null;
    standard: string | null;
  }> = [
    { name: '全部空', queues: () => q(), rouletteFirst: null, standard: null },
    { name: 'boost のみ', queues: () => q({ boosts: ['B'] }), rouletteFirst: 'boost:B', standard: 'boost:B' },
    { name: 'band のみ', queues: () => q({ bands: ['C'] }), rouletteFirst: 'band:C', standard: 'band:C' },
    { name: 'roulette のみ', queues: () => q({ roulettes: ['R'] }), rouletteFirst: 'roulette:R', standard: 'roulette:R' },
    {
      name: 'boost + band → ブースト優先(タップのゲーム性を待たせない)',
      queues: () => q({ boosts: ['B'], bands: ['C'] }),
      rouletteFirst: 'boost:B',
      standard: 'boost:B',
    },
    {
      name: 'roulette + boost → finishRoulette は自キュー(短縮スピン連鎖)優先',
      queues: () => q({ roulettes: ['R'], boosts: ['B'] }),
      rouletteFirst: 'roulette:R',
      standard: 'boost:B',
    },
    {
      name: 'roulette + band → 同上 / standard はカットイン優先',
      queues: () => q({ roulettes: ['R'], bands: ['C'] }),
      rouletteFirst: 'roulette:R',
      standard: 'band:C',
    },
    {
      name: '全キュー在庫あり',
      queues: () => q({ roulettes: ['R'], boosts: ['B'], bands: ['C'] }),
      rouletteFirst: 'roulette:R',
      standard: 'boost:B',
    },
  ];

  for (const c of cases) {
    it(`${c.name}`, () => {
      for (const [order, expected] of [
        ['roulette-first', c.rouletteFirst],
        ['standard', c.standard],
      ] as const) {
        const queues = c.queues();
        const r = drainFxQueues(queues, order);
        const got = r.next ? `${r.next.kind}:${r.next.effect}` : null;
        expect(got, `order=${order}`).toBe(expected);
        // drainStrike は「次演出を始めないパスの最後だけ」。
        expect(r.drainStrike, `order=${order}`).toBe(expected === null);
      }
    });
  }
});

describe('drainFxQueues: achieved と消費規約', () => {
  it('achieved は常に返るが開始スロットを消費しない(次演出と並走する)', () => {
    const queues = q({ achieved: 'A', boosts: ['B'] });
    const r = drainFxQueues(queues, 'standard');
    expect(r.achieved).toBe('A');
    expect(r.next).toEqual({ kind: 'boost', effect: 'B' });
    expect(r.drainStrike).toBe(false);
  });

  it('achieved のみ(他は空)→ 再生 + drainStrike', () => {
    const r = drainFxQueues(q({ achieved: 'A' }), 'roulette-first');
    expect(r.achieved).toBe('A');
    expect(r.next).toBeNull();
    expect(r.drainStrike).toBe(true);
  });

  it('選ばれた演出はキューから消え、他のキューは減らない', () => {
    const queues = q({ roulettes: ['R1', 'R2'], boosts: ['B1'], bands: ['C1'] });
    const r = drainFxQueues(queues, 'roulette-first');
    expect(r.next).toEqual({ kind: 'roulette', effect: 'R1' });
    expect(queues.roulettes).toEqual(['R2']);
    expect(queues.boosts).toEqual(['B1']);
    expect(queues.bands).toEqual(['C1']);
  });

  it('連続ドレインでキューが FIFO で空になっていく(standard)', () => {
    const queues = q({ boosts: ['B1', 'B2'], bands: ['C1'], roulettes: ['R1'] });
    const seq: string[] = [];
    for (;;) {
      const r = drainFxQueues(queues, 'standard');
      if (!r.next) break;
      seq.push(`${r.next.kind}:${r.next.effect}`);
    }
    expect(seq).toEqual(['boost:B1', 'boost:B2', 'band:C1', 'roulette:R1']);
  });
});

describe('drainFxQueues: 安全弁(expire)経路のバグ再現', () => {
  it('boost-end 消失 → expire 相当のドレインで、キュー済み band と達成演出が必ず再生される', () => {
    // 従来の abortBoostFx は何もドレインせず、pendingAchieved(CLEAR)が永久に
    // 出ない / pendingBands が数分後に因果不明で再生される、という配信事故だった。
    const queues = q({ achieved: 'CLEAR', bands: ['C'], roulettes: ['R'] });
    const r = drainFxQueues(queues, 'standard');
    expect(r.achieved).toBe('CLEAR');
    expect(r.next).toEqual({ kind: 'band', effect: 'C' });
    // 残ったスピンは次の finish が拾う(キューに残っている)。
    expect(queues.roulettes).toEqual(['R']);
  });
});
