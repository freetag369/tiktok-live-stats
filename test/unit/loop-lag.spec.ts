import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { drainLoopLagMaxMs, startLoopLagMeter } from '@worker/loop-lag';

/**
 * loop-lag(worker のイベントループ停止計測)のモジュール分離後の挙動固定。
 *
 * Date まで偽物にすると tick と時刻が同期して進み lag が常に 0 になるため、
 * interval だけ偽物にして Date.now は spy で操る — 「callback の配送が遅れた」
 * 状況を時刻の側からねつ造する。
 *
 * メーターはモジュール状態(止める口が無いのは本番と同じ)なので、ここでは
 * 1回だけ起動し、各テストが読み出しリセットで区間を区切る前提の順序で書く。
 */
let nowMs = 1_000_000;

describe('loop-lag — 最大値保持と読み出しリセット', () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    vi.spyOn(Date, 'now').mockImplementation(() => nowMs);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    startLoopLagMeter(); // expected = 1_001_000
  });

  afterAll(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('遅延の無い tick では 0 のまま', () => {
    nowMs = 1_001_000; // 期待時刻ちょうどに tick が届いた
    vi.advanceTimersByTime(1000);
    expect(drainLoopLagMaxMs()).toBe(0);
    // ここまでで expected = 1_002_000
  });

  it('区間内の最大値を保持し、読み出しでリセットされる', () => {
    nowMs = 1_002_250; // 250ms 遅れ
    vi.advanceTimersByTime(1000); // expected → 1_003_250
    nowMs = 1_003_350; // 100ms 遅れ(最大は 250 のまま)
    vi.advanceTimersByTime(1000); // expected → 1_004_350
    expect(drainLoopLagMaxMs()).toBe(250);
    expect(drainLoopLagMaxMs()).toBe(0); // 読み出した瞬間に区間が切り替わる
  });

  it('リセット後の区間は改めて最大を取り、500ms 以上なら stdout へ警告する', () => {
    nowMs = 1_005_000; // 前回 expected=1_004_350 → 650ms 遅れ
    vi.advanceTimersByTime(1000);
    expect(drainLoopLagMaxMs()).toBe(650);
    expect(vi.mocked(console.warn)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(console.warn).mock.calls[0]?.[0])).toContain('650ms');
  });
});
