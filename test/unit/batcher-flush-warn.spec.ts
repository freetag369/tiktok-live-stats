import { afterEach, describe, expect, it, vi } from 'vitest';
import { Batcher } from '@worker/batcher';
import type { NormalizedEvent } from '@shared/events';
import type { Store } from '@worker/store/index';

/**
 * 遅い DB フラッシュの警告(ディスク停止の検出)。
 *
 * worker は単一スレッド+同期 sqlite なので、flush の所要時間はそのまま
 * 「ボタンが効かない時間」になる。実配信で観測した21秒のイベントループ停止の
 * 犯人が DB フラッシュ(AVスキャン・低速ディスク)かどうかを次の発生時に
 * diag.log だけで確定させるための計器 — 閾値(1000ms)と30秒スロットルを固定する。
 */

const fakeStore = {
  applyBatch: () => ({ applied: 1, ignoredDuplicates: 0, droppedBlocked: 0 }),
} as unknown as Store;

function make(): Batcher {
  const b = new Batcher(fakeStore, () => undefined);
  b.setSession(1);
  return b;
}

const ev = (): NormalizedEvent => ({}) as unknown as NormalizedEvent;

describe('Batcher — 遅い flush の警告', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('1000ms 以上の flush は1行警告し、30秒間は繰り返さず、時間が経てばまた吼える', () => {
    const con = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // performance.now は flush ごとに 2 回呼ばれる(開始 t0 と終了)。奇数回目は 0、
    // 偶数回目は durations の先頭 = その flush の所要時間、を返す。
    const durations: number[] = [];
    let calls = 0;
    let current = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => {
      calls += 1;
      if (calls % 2 === 1) {
        current = durations.shift() ?? 0;
        return 0;
      }
      return current;
    });
    let now = 1_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const b = make();

    // 速い flush(500ms)は警告しない。
    durations.push(500);
    b.push(ev());
    b.flush();
    expect(con).not.toHaveBeenCalled();

    // 遅い flush(1500ms)は警告する。
    durations.push(1500);
    b.push(ev());
    b.flush();
    expect(con).toHaveBeenCalledTimes(1);
    expect(String(con.mock.calls[0]?.[0])).toContain('DBフラッシュが 1500ms');

    // 30秒以内の再発はスロットル(記録 maxFlushMs は更新される)。
    durations.push(2000);
    b.push(ev());
    b.flush();
    expect(con).toHaveBeenCalledTimes(1);
    expect(b.stats.maxFlushMs).toBe(2000);

    // 30秒経過後はまた警告する。
    now += 30_000;
    durations.push(1200);
    b.push(ev());
    b.flush();
    expect(con).toHaveBeenCalledTimes(2);
    expect(String(con.mock.calls[1]?.[0])).toContain('1200ms');
  });
});
