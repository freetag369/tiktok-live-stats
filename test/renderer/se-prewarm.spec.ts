import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playSe, prewarmSe } from '../../src/renderer/lib/se';

/**
 * 効果音の予熱(2026-08-22)。bgm-custom.spec.ts と同じ流儀 — jsdom は使わず
 * Audio を stubGlobal で差す。見たいのは「作る本数・load/play の呼び分け・
 * 予熱要素が初回再生で引き取られること」だけで、実デコードは不要。
 *
 * 注意: lib/se.ts のプールと予熱置き場はモジュール状態なので、テストごとに
 * **別の id** を使う(live-store-stale-snapshot.spec.ts と同じ配慮)。
 */

class FakeAudio {
  static made: FakeAudio[] = [];
  volume = 1;
  preload = '';
  src: string;
  loads = 0;
  plays = 0;
  currentTime = 0;

  constructor(src: string) {
    this.src = src;
    FakeAudio.made.push(this);
  }
  load(): void {
    this.loads++;
  }
  play(): Promise<void> {
    this.plays++;
    return Promise.resolve();
  }
}

beforeEach(() => {
  FakeAudio.made = [];
  vi.stubGlobal('Audio', FakeAudio);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prewarmSe', () => {
  it('1 id につき1本だけ作り、load はするが play はしない', () => {
    prewarmSe(['pop', 'pop', 'tick', 'off', 'unknown-se-id']);
    // 'off' と未知 id は無視、'pop' の重複は1本。
    expect(FakeAudio.made.length).toBe(2);
    for (const a of FakeAudio.made) {
      expect(a.preload).toBe('auto');
      expect(a.loads).toBe(1);
      expect(a.plays).toBe(0);
    }
  });

  it('再呼び出しで二重に作らない', () => {
    prewarmSe(['pluck']);
    const n = FakeAudio.made.length;
    prewarmSe(['pluck']);
    expect(FakeAudio.made.length).toBe(n);
  });

  it('予熱済みの要素は初回 playSe が引き取る(ロードのやり直しをしない)', () => {
    prewarmSe(['bong']);
    const warmedEl = FakeAudio.made[FakeAudio.made.length - 1]!;
    const before = FakeAudio.made.length;
    playSe('bong', 100);
    // 新しい Audio を作らず、予熱済みの1本がそのまま鳴る。
    expect(FakeAudio.made.length).toBe(before);
    expect(warmedEl.plays).toBe(1);
    expect(warmedEl.volume).toBeGreaterThan(0);
  });

  it('予熱なしの従来経路は変わらない(初回 playSe が作る)', () => {
    const before = FakeAudio.made.length;
    playSe('question', 100);
    expect(FakeAudio.made.length).toBe(before + 1);
    expect(FakeAudio.made[FakeAudio.made.length - 1]!.plays).toBe(1);
  });
});
