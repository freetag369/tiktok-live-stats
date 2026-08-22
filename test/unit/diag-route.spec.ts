import { describe, expect, it } from 'vitest';
import { routeConsoleLine } from '../../src/main/diag-log';

/**
 * console 行の行き先の真理値表(2026-08-22)。
 *
 * '[frame]'(モニターの毎分フレームタイム計測)は**ファイル専用** — リングへ
 * 積むと RING_CAP=300 が定期行で埋まり fxWarn・例外を押し流す(metrics.ts の
 * reportFileOnly と同じ理由)。ここが 'ring' に変わると設定画面の「状態」カードが
 * 1時間で計測行だけになる。
 */

describe('routeConsoleLine', () => {
  it('[frame] で始まる行はレベルを問わずファイル専用', () => {
    expect(routeConsoleLine('info', '[frame] n=3597 p50=17 p95=18')).toBe('file');
    expect(routeConsoleLine('error', '[frame] broken')).toBe('file');
  });

  it('本文中に [frame] の字面を含むだけの行は demote しない(行頭一致)', () => {
    // frame-meter のエスカレーション warn は本文に '[frame]' を含む —
    // includes 判定だとこの唯一の異常信号がファイルへ demote され、
    // 設定画面の「状態」カードに一切出なくなる(レビューで実際に踏んだ)。
    expect(
      routeConsoleLine('warn', '[diag] 長フレーム多発 — p95=60ms j100=7/分(詳細は diag.log の [frame] 行)')
    ).toBe('ring');
    expect(routeConsoleLine('warn', 'x [frame] y')).toBe('drop');
  });

  it('error はリング(従来どおり)', () => {
    expect(routeConsoleLine('error', 'なにかが壊れた')).toBe('ring');
  });

  it('診断プレフィックスはリング(従来どおり)', () => {
    expect(routeConsoleLine('warn', '[fx-skip] 旧ランのチャレンジ状態が後着')).toBe('ring');
    expect(routeConsoleLine('info', '[worker] mem rss=120MB')).toBe('ring');
    expect(routeConsoleLine('warn', '[diag] 長フレーム多発')).toBe('ring');
  });

  it('その他の info/warn は捨てる(React 開発警告等でリングを流さない)', () => {
    expect(routeConsoleLine('info', 'Download the React DevTools')).toBe('drop');
    expect(routeConsoleLine('warn', 'なんでもない警告')).toBe('drop');
  });
});
