import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  ROULETTE_REELS_MAX,
  challengeSnapshotMaxEffectId,
  isStaleChallengeSnapshot,
  mergeRoulette,
  rouletteReelPlan,
} from '@shared/challenge';
import type { ChallengeConfig, ChallengeEffect, ChallengeState } from '@shared/dto';

/**
 * スナップショットの世代判定(liveStore の後退ガード)と、モニターのキュー連結が
 * worker の finishDrain と同じ本数規約で clamp することの回帰テスト。
 *
 * どちらも「ルーレット/ギフトが贈られた個数を超えて再生される」の再発防止:
 * 前者は古いスナップショットの後着で recentEffects が巻き戻る経路、後者は
 * 「連打でもリールは1本」設定を無視してキュー連結が最大 20 本へ膨らむ経路。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function fx(id: number): ChallengeEffect {
  return { id, kind: 'press', amount: -1, valueAfter: 100, atMs: NOW };
}

function state(effects: ChallengeEffect[]): ChallengeState {
  return {
    status: 'running',
    value: 100,
    initialValue: 100,
    title: 'テスト',
    startedMs: NOW,
    achievedMs: null,
    stats: { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, likeDown: 0, likeStockDown: 0, commentUp: 0, joinDown: 0, joinUp: 0, rouletteSpins: 0, quizDown: 0, quizUp: 0 },
    recentEffects: effects,
    likeGauge: null,
    result: null,
  };
}

describe('isStaleChallengeSnapshot — effect ストリームの世代判定', () => {
  it('世代印が後退していたら古い(press RPC の返り値が delta より後に着弾した形)', () => {
    expect(isStaleChallengeSnapshot(105, state([fx(100), fx(99)]))).toBe(true);
  });

  it('同値・前進は古くない(2Hz で同じリングが再配信されるのが通常)', () => {
    expect(isStaleChallengeSnapshot(105, state([fx(105), fx(104)]))).toBe(false);
    expect(isStaleChallengeSnapshot(105, state([fx(106)]))).toBe(false);
  });

  it('seen=0(ラン境界・worker 再起動で呼び出し側が戻した直後)は何でも受け入れる', () => {
    expect(isStaleChallengeSnapshot(0, state([]))).toBe(false);
    expect(isStaleChallengeSnapshot(0, state([fx(3)]))).toBe(false);
  });

  it('戻していないのに空リングが来たら後退扱い(採用すると演出の入力が消える)', () => {
    expect(isStaleChallengeSnapshot(7, state([]))).toBe(true);
  });

  it('challengeSnapshotMaxEffectId は空リングで 0', () => {
    expect(challengeSnapshotMaxEffectId(state([]))).toBe(0);
    expect(challengeSnapshotMaxEffectId(state([fx(4), fx(9)]))).toBe(9);
  });
});

describe('mergeRoulette — キュー連結の本数は cfg で引き直す', () => {
  function rl(id: number, idxs: number[]): ChallengeEffect {
    return {
      id,
      kind: 'roulette',
      amount: idxs.length,
      valueAfter: 100,
      atMs: NOW,
      rouletteSegments: [1, 2, 3],
      rouletteIndex: idxs[0]!,
      rouletteIndexes: idxs,
      roulettePattern: 'slow',
      roulettePatterns: idxs.map(() => 'slow' as const),
      // worker が「連打でもリールは1本」設定で 1 本に絞った状態。
      rouletteReels: 1,
    };
  }
  function cfg(over: Partial<ChallengeConfig['giftRepeatFx']>): ChallengeConfig {
    const base = structuredClone(DEFAULT_CHALLENGE);
    return { ...base, giftRepeatFx: { ...base.giftRepeatFx, ...over } };
  }

  it('rouletteEnabled=false なら連結しても 1 本のまま', () => {
    const merged = mergeRoulette(rl(1, [0, 1, 2]), rl(2, [1, 2, 0]), cfg({ enabled: true, rouletteEnabled: false }));
    expect(merged.rouletteIndexes).toHaveLength(6);
    expect(merged.rouletteReels).toBe(1);
    expect(rouletteReelPlan(merged).reels).toHaveLength(1);
    // 回さないぶんは合算バナーで締める契約(値は worker が適用済み)。
    expect(rouletteReelPlan(merged).restCount).toBe(5);
  });

  it('rouletteEnabled=true なら連結後の出目数(上限まで)を回す', () => {
    const merged = mergeRoulette(rl(1, [0, 1, 2]), rl(2, [1, 2, 0]), cfg({ enabled: true, rouletteEnabled: true }));
    expect(merged.rouletteReels).toBe(6);
  });

  it('cfg 未指定は従来動作(上限 clamp のみ)', () => {
    const many = Array.from({ length: ROULETTE_REELS_MAX + 5 }, (_, i) => i % 3);
    const merged = mergeRoulette(rl(1, many), rl(2, [0]));
    expect(merged.rouletteReels).toBe(ROULETTE_REELS_MAX);
  });
});
