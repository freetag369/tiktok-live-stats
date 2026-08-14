import { describe, expect, it } from 'vitest';
import { shouldDeferFloat, shouldFlushDeferredFloats, type FloatHoldState } from '@shared/fx-floats';

/**
 * 保留バナー(いいね妨害 / いいねストック満杯)の保留・flush 判定の固定。
 *
 * 「ストック満杯バナーが出ないことがある」の再発防止テスト。原因は保留判定が
 * chainActive(strikeTimers)しか見ておらず、
 *   - 横取りで pendingStrike へ戻された持ち越し(strikePending)
 *   - yieldToCutin でタイマーを張らないカットイン中(cutinActive)
 * の2状態でバナーが単独に出て消えていたこと。3状態のどれか1つでも生きていれば
 * 「後で必ず出す持ち主が居る」ので保留する — この契約を1ビットも変えないための
 * 回帰テスト。
 */

function s(over: Partial<FloatHoldState> = {}): FloatHoldState {
  return { chainActive: false, strikePending: false, cutinActive: false, ...over };
}

describe('shouldDeferFloat: 保留するかの固定', () => {
  const cases: Array<{ name: string; state: FloatHoldState; defer: boolean }> = [
    { name: '全部 false → 出す先が居ないので即時', state: s(), defer: false },
    {
      name: 'chainActive のみ → 着弾が出す(従来挙動の保存)',
      state: s({ chainActive: true }),
      defer: true,
    },
    {
      name: 'strikePending のみ → 演出明けの drainPendingStrike が出す(横取り経路の回帰)',
      state: s({ strikePending: true }),
      defer: true,
    },
    {
      name: 'cutinActive のみ → 全カットイン終了時のウォッチドッグが出す(yieldToCutin 経路の回帰)',
      state: s({ cutinActive: true }),
      defer: true,
    },
    {
      name: 'chain + pending',
      state: s({ chainActive: true, strikePending: true }),
      defer: true,
    },
    {
      name: 'chain + cutin',
      state: s({ chainActive: true, cutinActive: true }),
      defer: true,
    },
    {
      name: 'pending + cutin',
      state: s({ strikePending: true, cutinActive: true }),
      defer: true,
    },
    {
      name: '全部 true',
      state: s({ chainActive: true, strikePending: true, cutinActive: true }),
      defer: true,
    },
  ];

  for (const c of cases) {
    it(c.name, () => {
      expect(shouldDeferFloat(c.state)).toBe(c.defer);
      expect(shouldFlushDeferredFloats(c.state)).toBe(!c.defer);
    });
  }
});

describe('shouldFlushDeferredFloats: shouldDeferFloat と常に排他', () => {
  it('8通りすべてで排他', () => {
    for (const chainActive of [false, true]) {
      for (const strikePending of [false, true]) {
        for (const cutinActive of [false, true]) {
          const state = { chainActive, strikePending, cutinActive };
          expect(shouldFlushDeferredFloats(state)).toBe(!shouldDeferFloat(state));
        }
      }
    }
  });

  it('flush してよいのは3状態すべて false のときだけ', () => {
    expect(shouldFlushDeferredFloats(s())).toBe(true);
    expect(shouldFlushDeferredFloats(s({ chainActive: true }))).toBe(false);
    expect(shouldFlushDeferredFloats(s({ strikePending: true }))).toBe(false);
    expect(shouldFlushDeferredFloats(s({ cutinActive: true }))).toBe(false);
  });
});
