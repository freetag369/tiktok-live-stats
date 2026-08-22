import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { REVOLUTION_HUD_INTRO_MS } from '@shared/challenge';
import { TapLockHud } from '../../src/renderer/monitor/TapLockHud';
import { RevolutionHud } from '../../src/renderer/monitor/RevolutionHud';

/**
 * お邪魔/革命の常設 HUD(MonitorView からの切り出し・2026-08-22)の構造凍結。
 *
 * 切り出しの目的は再レンダーの局所化 — 以前は 250ms tick が MonitorView 全体
 * (約1000行の JSX)を 4Hz で回していた。この分割でクラス名・表示条件・時刻
 * ラッチ規約が変わっていないことを、実レンダー(renderToStaticMarkup —
 * gauntlet-ring.spec.ts と同じ流儀・jsdom 不要)で見張る。
 */

const NOW = Date.UTC(2026, 7, 22, 12, 0, 0);

afterEach(() => {
  vi.restoreAllMocks();
});

function freeze(nowMs: number): void {
  vi.spyOn(Date, 'now').mockReturnValue(nowMs);
}

describe('TapLockHud', () => {
  function render(endsAtMs: number, nickname: string | null): string {
    return renderToStaticMarkup(createElement(TapLockHud, { endsAtMs, nickname }));
  }

  it('残り秒は絶対期限から数える(worker が配るのは endsAtMs だけの規約)', () => {
    freeze(NOW);
    const html = render(NOW + 4200, 'たろう');
    expect(html).toContain('tap-lock-overlay');
    expect(html).toContain('タップ封じ');
    // ceil(4200/1000) = 5 秒。
    expect(html).toMatch(/tap-lock-count[^>]*>5</);
    expect(html).toContain('たろう さんのお邪魔');
  });

  it('ニックネーム無しは「お邪魔中」', () => {
    freeze(NOW);
    expect(render(NOW + 1000, null)).toContain('お邪魔中');
  });

  it('期限切れは何も出さない — 「解けていないのに封印中に見える」の防止', () => {
    freeze(NOW);
    expect(render(NOW, 'たろう')).toBe('');
    expect(render(NOW - 1, null)).toBe('');
  });
});

describe('RevolutionHud', () => {
  function render(over: Partial<Parameters<typeof RevolutionHud>[0]> = {}): string {
    return renderToStaticMarkup(
      createElement(RevolutionHud, {
        startsAtMs: null,
        endsAtMs: null,
        multiplier: 3,
        revCount: null,
        mirrorOn: false,
        mirrorLg: false,
        ...over,
      })
    );
  }

  it('導入カウント(revCount)は窓が無くても全画面数字を出す', () => {
    freeze(NOW);
    const html = render({ revCount: 4 });
    expect(html).toContain('revolution-count-overlay');
    expect(html).toMatch(/revolution-count[^>]*>4</);
    expect(html).not.toContain('revolution-overlay');
    expect(html).not.toContain('revolution-timer');
  });

  it('窓オープン直後(intro 期間)は中央の告知ボックス・ピルは出さない', () => {
    freeze(NOW);
    const html = render({ startsAtMs: NOW - 1000, endsAtMs: NOW + 50_000 });
    expect(html).toContain('revolution-overlay');
    expect(html).toContain('革命タイム');
    expect(html).toContain('×3');
    expect(html).not.toContain('revolution-timer');
  });

  it('intro 明けは7セグ脇のピルへ引き継ぐ(盤面を1分間ふさがない)', () => {
    freeze(NOW);
    const html = render({
      startsAtMs: NOW - REVOLUTION_HUD_INTRO_MS - 1000,
      endsAtMs: NOW + 30_000,
    });
    expect(html).not.toContain('revolution-overlay');
    expect(html).toContain('revolution-timer');
    expect(html).toContain('残り30秒');
  });

  it('ピルの位置クラスは小窓の有無に追従する', () => {
    freeze(NOW);
    const base = { startsAtMs: NOW - REVOLUTION_HUD_INTRO_MS - 1000, endsAtMs: NOW + 30_000 };
    expect(render({ ...base, mirrorOn: true })).toContain('revolution-timer at-mirror');
    expect(render({ ...base, mirrorOn: true, mirrorLg: true })).toContain(
      'revolution-timer at-mirror mirror-lg'
    );
  });

  it('終了5秒前は全画面カウントダウンだけ(告知・ピルは畳む)', () => {
    freeze(NOW);
    const html = render({ startsAtMs: NOW - 60_000, endsAtMs: NOW + 4_500 });
    expect(html).toContain('revolution-count-overlay');
    expect(html).toMatch(/revolution-count[^>]*>5</);
    expect(html).not.toContain('revolution-overlay');
    expect(html).not.toContain('revolution-timer');
  });

  it('窓の満了後は何も出さない(表示落ちは delta を待たない)', () => {
    freeze(NOW);
    expect(render({ startsAtMs: NOW - 60_000, endsAtMs: NOW - 1 })).toBe('');
  });
});

describe('MonitorView の配線(HUD を本体へ書き戻していないこと)', () => {
  const SRC = readFileSync('src/renderer/monitor/MonitorView.tsx', 'utf8').replace(/\r\n/g, '\n');

  it('HUD はコンポーネント経由(インライン markup の復活検出)', () => {
    expect(SRC).toContain('<TapLockHud');
    expect(SRC).toContain('<RevolutionHud');
    // 旧インライン実装のクラスが本体に残っていない(二重管理の防止)。
    expect(SRC).not.toContain('"tap-lock-overlay"');
    expect(SRC).not.toContain('"revolution-timer');
  });

  it('導入カットイン中は HUD を出さないゲートが本体に残る(tap-lock-cutin.spec の対)', () => {
    expect(SRC).toMatch(/tapLock != null && tapLockClip === null \? \(/);
  });

  it('250ms tick を本体へ戻していない(切り出しの目的そのもの)', () => {
    // quiz の tick は armed バリア監視の駆動源として本体に残る(仕様)。
    // tapLock / revolution の tick が本体に再増殖したらこの上限が破れる。
    const ticks = [...SRC.matchAll(/setInterval\([^)]*250\)/g)];
    expect(ticks.length).toBeLessThanOrEqual(1);
  });
});
