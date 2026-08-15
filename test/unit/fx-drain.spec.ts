import { describe, expect, it } from 'vitest';
import { drainFxQueues, runFxDrain, type FxDrainOrder, type FxDrainQueues } from '@shared/fx-drain';

/**
 * 演出終了時のドレイン順序の固定。
 *
 * この順序は MonitorView の4つの finish(+安全弁の expire)が従う契約で、
 * 過去に「譲ったのに誰も再生しない」系のバグを潰しながら固まったもの。
 * 意図せず変えないための回帰テスト。
 *
 * 'roulette-first' でもブーストは最優先 — worker のフィーバーは絶対時刻で走り
 * (ルーレットでは凍結しない)、スピン連鎖の後ろに並ばせると planBoostStart の
 * 期限切れで演出ごと消えていた。
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
      name: 'roulette + boost → どちらの順序でもブースト優先(絶対時刻の期限切れ防止)',
      queues: () => q({ roulettes: ['R'], boosts: ['B'] }),
      rouletteFirst: 'boost:B',
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
      rouletteFirst: 'boost:B',
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
    const queues = q({ roulettes: ['R1', 'R2'], boosts: [], bands: ['C1'] });
    const r = drainFxQueues(queues, 'roulette-first');
    expect(r.next).toEqual({ kind: 'roulette', effect: 'R1' });
    expect(queues.roulettes).toEqual(['R2']);
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

/**
 * runFxDrain: 「断られたら次の持ち越しへ落ちる」ドライバの契約。
 *
 * 旧実装は1件だけ試して return していたため、start* が断ると hold も張られず
 * onIdle/drainPendingStrike も走らず、pendingStrike が宙に浮いて以降のバナーが
 * 永久に保留された。出口は「started」か「drainStrike」の2つだけに閉じる。
 */
const ORDERS: FxDrainOrder[] = ['roulette-first', 'standard'];

/** start の呼ばれ方を記録するスパイ。accept で「どれを受けるか」を決める。 */
function spy(accept: (kind: string, effect: string) => boolean) {
  const calls: string[] = [];
  return {
    calls,
    start: (kind: 'roulette' | 'boost' | 'band', effect: string): boolean => {
      calls.push(`${kind}:${effect}`);
      return accept(kind, effect);
    },
  };
}

describe('runFxDrain: 断られたら次の持ち越しへ落ちる', () => {
  it('全部空 — start は1度も呼ばれず、着弾を流してよい', () => {
    for (const order of ORDERS) {
      const s = spy(() => true);
      const r = runFxDrain(q(), order, { start: s.start });
      expect(r.started, order).toBeNull();
      expect(r.drainStrike, order).toBe(true);
      expect(r.skipped, order).toEqual([]);
      expect(s.calls, order).toEqual([]);
    }
  });

  it('先頭が断ると次のキューが開始される(standard: boost → band)', () => {
    const s = spy((kind) => kind !== 'boost');
    const queues = q({ boosts: ['B'], bands: ['C'] });
    const r = runFxDrain(queues, 'standard', { start: s.start });
    expect(s.calls).toEqual(['boost:B', 'band:C']);
    expect(r.started).toEqual({ kind: 'band', effect: 'C' });
    expect(r.skipped).toEqual([{ kind: 'boost', effect: 'B' }]);
    expect(r.drainStrike).toBe(false);
  });

  it('全部断られたら drainStrike が立つ(B3 の本体 — pendingStrike が宙に浮かない)', () => {
    for (const order of ORDERS) {
      const s = spy(() => false);
      const queues = q({ boosts: ['B'], bands: ['C'], roulettes: ['R'] });
      const r = runFxDrain(queues, order, { start: s.start });
      expect(r.started, order).toBeNull();
      expect(r.drainStrike, order).toBe(true);
      expect(r.skipped.length, order).toBe(3);
      // 捨てた順は drainFxQueues の優先順と一致する。
      expect(r.skipped.map((x) => `${x.kind}:${x.effect}`), order).toEqual(
        order === 'roulette-first' ? ['boost:B', 'roulette:R', 'band:C'] : ['boost:B', 'band:C', 'roulette:R']
      );
      // 断られた要素はキューへ戻らない。
      expect([queues.boosts, queues.bands, queues.roulettes], order).toEqual([[], [], []]);
    }
  });

  it('最初に成功した時点で止まる — 後続キューは減らない', () => {
    const s = spy(() => true);
    const queues = q({ boosts: ['B'], bands: ['C'], roulettes: ['R1', 'R2'] });
    const r = runFxDrain(queues, 'standard', { start: s.start });
    expect(r.started).toEqual({ kind: 'boost', effect: 'B' });
    expect(s.calls).toEqual(['boost:B']);
    expect(queues.bands).toEqual(['C']);
    expect(queues.roulettes).toEqual(['R1', 'R2']);
  });

  it('achieved は最初の start より前に1回だけ再生され、開始スロットを消費しない', () => {
    const order: FxDrainOrder = 'standard';
    const log: string[] = [];
    const queues = q({ achieved: 'CLEAR', boosts: ['B'], bands: ['C'] });
    const r = runFxDrain(queues, order, {
      playAchieved: (e) => log.push(`achieved:${e}`),
      start: (kind, effect) => {
        log.push(`${kind}:${effect}`);
        return kind !== 'boost';
      },
    });
    expect(log).toEqual(['achieved:CLEAR', 'boost:B', 'band:C']);
    expect(r.achieved).toBe('CLEAR');
    expect(r.started).toEqual({ kind: 'band', effect: 'C' });
    expect(queues.achieved).toBeNull();
  });

  it('CLEAR + 全部断られても achieved は返り、drainStrike が立つ', () => {
    const r = runFxDrain(q({ achieved: 'CLEAR', bands: ['C'] }), 'standard', { start: () => false });
    expect(r.achieved).toBe('CLEAR');
    expect(r.started).toBeNull();
    expect(r.drainStrike).toBe(true);
  });

  it('満杯のキューを全部断っても呼び出し回数は有界(13回)で maxSteps に届かない', () => {
    const s = spy(() => false);
    const queues = q({
      boosts: ['B1', 'B2'],
      bands: ['C1', 'C2'],
      roulettes: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7', 'R8', 'R9'],
    });
    const r = runFxDrain(queues, 'standard', { start: s.start });
    expect(s.calls.length).toBe(13);
    expect(r.drainStrike).toBe(true);
  });

  it('maxSteps で打ち切られても安全側(drainStrike: true)へ倒れる', () => {
    const s = spy(() => false);
    const queues = q({ boosts: ['B1', 'B2'], bands: ['C1', 'C2'] });
    const r = runFxDrain(queues, 'standard', { start: s.start }, 2);
    expect(s.calls.length).toBe(2);
    expect(r.started).toBeNull();
    expect(r.drainStrike).toBe(true);
  });
});
