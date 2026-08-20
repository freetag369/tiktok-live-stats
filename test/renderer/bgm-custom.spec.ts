import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { playBandBgm, ROULETTE_SPIN_SE } from '../../src/renderer/lib/bgm';

/**
 * カスタム回転音(custom:<ファイル名>)の再生分岐。
 *
 * renderer 側なので test/renderer/ に置く(test/unit だと DOM lib が無く
 * typecheck が落ちる)。jsdom は使わず Audio / window を stubGlobal で差す —
 * 見たいのは「どの URL を、どの音量で、いつ警告するか」だけで、実デコードは不要。
 */

/** bgm.ts が触る範囲だけを備えた Audio の身代わり。 */
class FakeAudio {
  static made: FakeAudio[] = [];
  loop = false;
  volume = 1;
  paused = false;
  src: string;
  removed = false;
  loaded = 0;
  private listeners: Record<string, Array<() => void>> = {};

  constructor(src: string) {
    this.src = src;
    FakeAudio.made.push(this);
  }
  addEventListener(type: string, fn: () => void): void {
    (this.listeners[type] ??= []).push(fn);
  }
  /** メディア要素の error イベントを起こす(欠損・デコード失敗・空 src の共通経路)。 */
  fireError(): void {
    for (const fn of this.listeners.error ?? []) fn();
  }
  play(): Promise<void> {
    this.paused = false;
    return Promise.resolve();
  }
  pause(): void {
    this.paused = true;
  }
  removeAttribute(name: string): void {
    if (name === 'src') {
      this.src = '';
      this.removed = true;
    }
  }
  load(): void {
    this.loaded++;
  }
}

let warns: string[];

beforeEach(() => {
  FakeAudio.made = [];
  warns = [];
  vi.stubGlobal('Audio', FakeAudio);
  vi.stubGlobal('window', {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as unknown as number,
    clearInterval: (h: number) => clearInterval(h as unknown as NodeJS.Timeout),
    clearTimeout: (h: number) => clearTimeout(h as unknown as NodeJS.Timeout),
  });
  vi.spyOn(console, 'warn').mockImplementation((m: unknown) => {
    warns.push(String(m));
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const last = (): FakeAudio => FakeAudio.made[FakeAudio.made.length - 1]!;

describe('playBandBgm — カスタム回転音の分岐', () => {
  it('custom id は app-sound:// の URL を組み、名前をエンコードする', () => {
    const h = playBandBgm('custom:回転音.ogg', 100);
    expect(h).not.toBeNull();
    expect(last().src).toBe('app-sound:///' + encodeURIComponent('回転音.ogg'));
    // ループしないと回転中に途切れる(カタログ音と同じ契約)。
    expect(last().loop).toBe(true);
  });

  it('カスタムは gain 1 — 音量スライダーの値がそのまま音量になる', () => {
    // 未知のユーザー素材に当てられるラウドネス基準が無いので、カタログ音のような
    // 補正は掛けない。ここが 1 でないと「70 にしたのに小さすぎる」が起きる。
    playBandBgm('custom:loop.mp3', 70);
    expect(last().volume).toBeCloseTo(0.7, 5);
  });

  it('カタログ音は従来どおり素材ごとの gain が乗る(既存挙動の据え置き)', () => {
    const reel2 = ROULETTE_SPIN_SE.find((s) => s.id === 'spin-reel2')!;
    playBandBgm('spin-reel2', 100);
    expect(last().volume).toBeCloseTo(reel2.gain, 5);
    expect(last().src).toBe(reel2.url);
  });

  it('音量 0・未知 id・空 id は再生しない(null)', () => {
    expect(playBandBgm('custom:loop.mp3', 0)).toBeNull();
    expect(playBandBgm('spin-nonexistent', 100)).toBeNull();
    expect(playBandBgm('', 100)).toBeNull();
    expect(playBandBgm(null, 100)).toBeNull();
    // 不正な custom(トラバーサル)はカタログ引きへ落ち、未知 id として null。
    expect(playBandBgm('custom:../evil.mp3', 100)).toBeNull();
    expect(FakeAudio.made).toHaveLength(0);
  });
});

describe('playBandBgm — 欠損の警告と、その偽陽性除け', () => {
  it('再生中の error は警告する(ファイルを消した・移動した の事後診断)', () => {
    playBandBgm('custom:消えた.ogg', 100);
    last().fireError();
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain('custom:消えた.ogg');
  });

  it('停止後の error は警告しない — 取り壊しは欠損ではない', () => {
    // 取り壊し後に届く error は定義上どのみち対処できない。実測(Electron 43)では
    // removeAttribute('src') + load() は abort/emptied どまりだが、`src = ''` にすると
    // error(code 4)が出るし、どちらになるかは書き方と Chromium 次第で変わる。
    // ここを素通しにすると**正常停止のたびに**「読込に失敗」が出て、diag.log の
    // 本物の欠損報告が埋もれる(fx-video-pool の play() 偽陽性と同型の罠)。
    const h = playBandBgm('custom:loop.ogg', 100)!;
    h.stop(0);
    expect(last().removed).toBe(true);
    last().fireError();
    expect(warns).toHaveLength(0);
  });

  it('カタログ音の停止でも警告は出ない(既存の全ループ音・BGM を巻き込まない)', () => {
    const h = playBandBgm('spin-reel1', 100)!;
    h.stop(0);
    last().fireError();
    expect(warns).toHaveLength(0);
  });
});
