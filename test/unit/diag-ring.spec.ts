import { describe, expect, it } from 'vitest';
import { DIAG_MESSAGE_MAX, DiagRing } from '@shared/diag-ring';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function push(r: DiagRing, message: string, over: Partial<Parameters<DiagRing['push']>[0]> = {}) {
  return r.push({ atMs: NOW, scope: 'monitor', level: 'warn', message, ...over });
}

describe('DiagRing — 有界リングと重複の畳み込み', () => {
  it('新しい順で返す', () => {
    const r = new DiagRing(10);
    push(r, 'a');
    push(r, 'b');
    push(r, 'c');
    expect(r.recent().map((e) => e.message)).toEqual(['c', 'b', 'a']);
  });

  it('同一メッセージは行を増やさず count を上げる(rAF 内 throw の毎秒60件対策)', () => {
    const r = new DiagRing(10);
    expect(push(r, 'boom')).toBe(true);
    expect(push(r, 'boom', { atMs: NOW + 100 })).toBe(false);
    expect(push(r, 'boom', { atMs: NOW + 200 })).toBe(false);
    expect(r.size).toBe(1);
    const [e] = r.recent();
    expect(e).toMatchObject({ message: 'boom', count: 3 });
    // 初回時刻は動かさない(「いつ始まったか」が知りたい)。直近だけ更新する。
    expect(e!.atMs).toBe(NOW);
    expect(e!.lastMs).toBe(NOW + 200);
  });

  it('scope / level が違えば別行として扱う', () => {
    const r = new DiagRing(10);
    push(r, 'x');
    push(r, 'x', { scope: 'worker' });
    push(r, 'x', { level: 'error' });
    expect(r.size).toBe(3);
  });

  it('上限を超えたら古い方から落ちる', () => {
    const r = new DiagRing(3);
    for (const m of ['a', 'b', 'c', 'd', 'e']) push(r, m);
    expect(r.size).toBe(3);
    expect(r.recent().map((e) => e.message)).toEqual(['e', 'd', 'c']);
  });

  it('落ちた行と同じメッセージが再び来たら、新しい行として復活する(索引が漏れない)', () => {
    const r = new DiagRing(2);
    push(r, 'a');
    push(r, 'b');
    push(r, 'c'); // 'a' が落ちる
    expect(push(r, 'a', { atMs: NOW + 500 })).toBe(true);
    const a = r.recent().find((e) => e.message === 'a');
    expect(a).toMatchObject({ count: 1, atMs: NOW + 500 });
  });

  it('長すぎるメッセージは切り詰める(1件でリングを埋めない)', () => {
    const r = new DiagRing(10);
    push(r, 'x'.repeat(DIAG_MESSAGE_MAX + 500));
    const [e] = r.recent();
    expect(e!.message.length).toBe(DIAG_MESSAGE_MAX + 1); // 切り詰め + 省略記号
    expect(e!.message.endsWith('…')).toBe(true);
  });

  it('recent(limit) は新しい方から limit 件', () => {
    const r = new DiagRing(100);
    for (let i = 0; i < 20; i++) push(r, `m${i}`);
    expect(r.recent(5).map((e) => e.message)).toEqual(['m19', 'm18', 'm17', 'm16', 'm15']);
  });

  it('recent はコピーを返す(呼び出し側の書き換えでリングが壊れない)', () => {
    const r = new DiagRing(10);
    push(r, 'a');
    const snap = r.recent();
    snap[0]!.count = 999;
    expect(r.recent()[0]!.count).toBe(1);
  });

  it('clear で空になる', () => {
    const r = new DiagRing(10);
    push(r, 'a');
    r.clear();
    expect(r.size).toBe(0);
    expect(push(r, 'a')).toBe(true);
  });
});
