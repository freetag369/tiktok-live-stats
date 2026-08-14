import { describe, expect, it } from 'vitest';
import { BoundedSet } from '@shared/bounded-set';

describe('BoundedSet', () => {
  it('add は新規のとき true、既存のとき false を返し、二重追加でサイズが増えない', () => {
    const s = new BoundedSet<string>(10);
    expect(s.add('a')).toBe(true);
    expect(s.add('a')).toBe(false);
    expect(s.size).toBe(1);
    expect(s.has('a')).toBe(true);
    expect(s.has('b')).toBe(false);
  });

  it('cap を超えたら最古の要素から追い出す(FIFO)', () => {
    const s = new BoundedSet<number>(3);
    s.add(1);
    s.add(2);
    s.add(3);
    s.add(4); // 1 が追い出される
    expect(s.size).toBe(3);
    expect(s.has(1)).toBe(false);
    expect(s.has(2)).toBe(true);
    expect(s.has(4)).toBe(true);
    s.add(5); // 2 が追い出される
    expect(s.has(2)).toBe(false);
    expect(s.has(3)).toBe(true);
  });

  it('追い出された要素の再追加は「新規」として数え直す(初回扱いに戻る仕様の文書化)', () => {
    const s = new BoundedSet<number>(2);
    s.add(1);
    s.add(2);
    s.add(3); // 1 追い出し
    expect(s.add(1)).toBe(true);
    expect(s.size).toBe(2);
  });

  it('clear で空になり、その後も正しく動く', () => {
    const s = new BoundedSet<number>(3);
    s.add(1);
    s.add(2);
    s.clear();
    expect(s.size).toBe(0);
    expect(s.has(1)).toBe(false);
    expect(s.add(1)).toBe(true);
    expect(s.size).toBe(1);
  });

  it('大量追加でもサイズが cap で頭打ちになり、生存集合は常に直近 cap 件', () => {
    const cap = 1000;
    const s = new BoundedSet<number>(cap);
    const n = 10_000;
    for (let i = 0; i < n; i += 1) s.add(i);
    expect(s.size).toBe(cap);
    // 直近 cap 件だけが生きている(詰め直し圧縮を跨いでも欠けない)。
    for (let i = n - cap; i < n; i += 1) expect(s.has(i)).toBe(true);
    expect(s.has(n - cap - 1)).toBe(false);
  });

  it('cap が 0 以下なら例外', () => {
    expect(() => new BoundedSet<number>(0)).toThrow();
    expect(() => new BoundedSet<number>(-1)).toThrow();
  });
});
