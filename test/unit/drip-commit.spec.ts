import { describe, expect, it } from 'vitest';
import { dripCommitNeeded } from '@shared/challenge';

/**
 * いいねゲージ滴下の量子化スキップ判定。表示に影響するのは
 * 数字 = floor(値) とバー幅 = 値/分母 の2つだけ、という契約の固定。
 * 「最終ステップは呼び出し側が無条件 commit」は LikeGauge 側の責務なので
 * この関数は中間 tick の判定だけを担う。
 */
describe('dripCommitNeeded', () => {
  it('数字の floor が変わったら必ず commit', () => {
    expect(dripCommitNeeded(41.9, 42.1, 10_000)).toBe(true);
    // 減る向き(reset)でも同じ。
    expect(dripCommitNeeded(42.1, 41.9, 10_000)).toBe(true);
  });

  it('floor もバー刻みも動かない中間値はスキップ', () => {
    // every=10000 → 0.25% 刻みは 25。floor(42.1)=floor(42.4)=42、42.1 と 42.4 は同じ刻み(1)。
    expect(dripCommitNeeded(42.1, 42.4, 10_000)).toBe(false);
  });

  it('バー幅の 0.25% 刻みを跨いだら commit(数字が同じでも)', () => {
    // every=100 → 刻みは 0.25。50.1 → 50.3 は刻み 200 → 201 を跨ぐ。
    expect(Math.floor(50.1)).toBe(Math.floor(50.3));
    expect(dripCommitNeeded(50.1, 50.3, 100)).toBe(true);
  });

  it('every が小さいほど刻みが細かい(=よく commit する)', () => {
    // every=100_000 → 刻み 250。5000.5 → 5000.9 は同一整数・同一刻み。
    expect(dripCommitNeeded(5000.5, 5000.9, 100_000)).toBe(false);
    // 同じ差分でも every=1000(刻み 2.5)なら…floor 同一・刻みも 2000 → 2000 で同一。
    expect(dripCommitNeeded(5000.5, 5000.9, 1000)).toBe(false);
    // 刻み境界を跨げば true。
    expect(dripCommitNeeded(5001.9, 5002.6, 1000)).toBe(true);
  });

  it('分母が 0 以下でも落ちない(数字の floor 判定だけになる)', () => {
    expect(dripCommitNeeded(1.1, 1.2, 0)).toBe(false);
    expect(dripCommitNeeded(1.9, 2.0, 0)).toBe(true);
    expect(dripCommitNeeded(1.1, 1.2, -5)).toBe(false);
  });

  it('満タン直前(端数 → every 到達)の跨ぎは commit', () => {
    expect(dripCommitNeeded(99.9, 100, 100)).toBe(true);
  });
});
