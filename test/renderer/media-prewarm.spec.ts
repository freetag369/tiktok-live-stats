import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { dedupeSeIds, normalizePrewarmTargets } from '../../src/renderer/lib/media-prewarm-core';

/**
 * メディア予熱(2026-08-22)。純関数(media-prewarm-core)は直接、
 * ブラウザ依存部(media-prewarm.ts)はソース不変条件で見る —
 * fx-video-pool.spec.ts と同じ機械的担保(予熱の解放漏れはメディアプレイヤ
 * 枠の枯渇 =「時間が経つと演出動画だけ出なくなる」の再発要因になるため)。
 */

describe('normalizePrewarmTargets', () => {
  it('null(未投入)を除き、URL で重複排除する(フォールバック連鎖対策)', () => {
    const out = normalizePrewarmTargets([
      { label: 'a', url: 'file:///x.mp4' },
      { label: 'b', url: null },
      { label: 'c', url: 'file:///x.mp4' }, // stock-full → gauge-full の代用と同型
      { label: 'd', url: 'file:///y.mp4' },
    ]);
    expect(out).toEqual([
      { label: 'a', url: 'file:///x.mp4' },
      { label: 'd', url: 'file:///y.mp4' },
    ]);
  });

  it('app-sound:// は予熱しない(main の Range ストリーム経路 — 対象外の明記)', () => {
    const out = normalizePrewarmTargets([{ label: 'spin', url: 'app-sound:///loop.ogg' }]);
    expect(out).toEqual([]);
  });
});

describe('dedupeSeIds', () => {
  it("'off' を除いて重複排除", () => {
    expect(dedupeSeIds(['pop', 'off', 'pop', 'tick'])).toEqual(['pop', 'tick']);
  });
});

describe('media-prewarm.ts のソース不変条件', () => {
  const SRC = readFileSync(resolve('src/renderer/lib/media-prewarm.ts'), 'utf8').replace(/\r\n/g, '\n');

  it('予熱要素は DOM に入れない(appendChild 禁止)', () => {
    expect(SRC).toContain("document.createElement('video')");
    expect(SRC).not.toContain('appendChild');
  });

  it('解放は armVideoPlay と同一の三点セット(pause → src 除去 → load の順)', () => {
    const pause = SRC.indexOf('v.pause();');
    const rmSrc = SRC.indexOf("v.removeAttribute('src');");
    const load = SRC.indexOf('v.load();');
    for (const at of [pause, rmSrc, load]) expect(at).toBeGreaterThanOrEqual(0);
    expect(pause).toBeLessThan(rmSrc);
    expect(rmSrc).toBeLessThan(load);
  });

  it('実演出中は待避する(DOM の <video> を見張る)', () => {
    expect(SRC).toContain("document.querySelector('video')");
  });

  it('必ずミュートで温める(音漏れ事故の防止)', () => {
    expect(SRC).toContain('v.muted = true;');
  });

  it('モニター窓のエントリに配線済み(計器とセット)', () => {
    const entry = readFileSync(resolve('src/renderer/monitor.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(entry).toContain('installFrameMeter();');
    expect(entry).toContain('schedulePrewarm();');
  });
});
