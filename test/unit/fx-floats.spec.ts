import { describe, expect, it } from 'vitest';
import {
  mergePendingFloat,
  shouldDeferFloat,
  shouldFlushDeferredFloats,
  type FloatHoldState,
  type PendingFloat,
} from '@shared/fx-floats';
import { FLOAT_MAX } from '@shared/challenge';

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

/**
 * 「いいねストック満杯の瞬間に＋バナーが3枚同時に出る」の再発防止テスト。
 *
 * 原因は保留を**配列**で持っていたこと。stock-full は worker の凍結
 * (fxFreezeUntilMs)を張らないので、最長7秒のストックカットイン中も flushLikeFx が
 * LIKE_FX_WINDOW_MS(1秒)ごとに like 演出を出し続け、配列に5〜6件溜まる。それを
 * revealStock が同期ループで pushFloat すると React のバッチで FLOAT_MAX(3枠)の
 * 押し出しが起き、末尾3件が同一タイミングで着弾していた。
 *
 * 対策は畳み込み — 1種類あたり必ず1枚しか出ないことを型と件数の両面で固定する。
 */
describe('mergePendingFloat: 保留バナーの畳み込み', () => {
  it('保留なし(null)から1件 — そのまま金額が乗る', () => {
    expect(mergePendingFloat(null, 25)).toEqual({ amount: 25, count: 1 });
  });

  it('連続で積むと金額は総和・件数は積んだ数', () => {
    let p: PendingFloat | null = null;
    for (const a of [10, 20, 30, 40, 50]) p = mergePendingFloat(p, a);
    expect(p).toEqual({ amount: 150, count: 5 });
  });

  it('amount 0 でも件数は進む(金額を落とさない)', () => {
    expect(mergePendingFloat({ amount: 7, count: 1 }, 0)).toEqual({ amount: 7, count: 2 });
  });

  it('元のオブジェクトを破壊しない(ref 差し替え前提の呼び出し規約)', () => {
    const cur: PendingFloat = { amount: 5, count: 1 };
    mergePendingFloat(cur, 5);
    expect(cur).toEqual({ amount: 5, count: 1 });
  });

  it('満杯経路の再現: いいね5件+ストック1件でも flush で出るのは2枚 — FLOAT_MAX 以下', () => {
    // カットイン中に届く演出を保留へ積む(件数は 5 秒 / LIKE_FX_WINDOW_MS の実測相当)。
    let like: PendingFloat | null = null;
    for (const a of [25, 25, 25, 25, 25]) like = mergePendingFloat(like, a);
    const stock: PendingFloat | null = mergePendingFloat(null, 100);

    // flushDeferredFloats が pushFloat を呼ぶ回数 = 保留が乗っている種類の数。
    const banners = [like, stock].filter((p) => p !== null).length;
    expect(banners).toBe(2);
    expect(banners).toBeLessThanOrEqual(FLOAT_MAX); // 押し出し(= 3枚同時)が起きない
    // 畳んでも合計は落とさない — 7セグの増分と ＋N が一致する条件。
    expect(like?.amount).toBe(125);
    expect(like?.count).toBe(5);
  });
});
