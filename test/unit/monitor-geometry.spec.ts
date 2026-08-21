import { describe, expect, it } from 'vitest';
import { boundsOnAnyDisplay } from '../../src/main/monitor-geometry';

/**
 * repositionMonitor の迷子判定(2026-08-21 のバグ修正)。
 *
 * display-added/removed は無関係なディスプレイの増減や仮想ディスプレイでも
 * 発火するため、ウィンドウ表示で現に見えている窓を既定位置へ戻すとユーザーの
 * 手動配置(OBS の構図)がイベントのたびに壊れていた。動かしてよいのは
 * 「どの画面にも掛かっていない = 消えたディスプレイに取り残された」ときだけ、
 * という判定をここで固定する。
 */

const PRIMARY = { x: 0, y: 0, width: 1920, height: 1080 };
const SIDE = { x: 1920, y: 0, width: 1280, height: 720 };

describe('boundsOnAnyDisplay — モニター窓の迷子判定', () => {
  it('画面内に収まっている窓は「見えている」', () => {
    expect(boundsOnAnyDisplay({ x: 50, y: 50, width: 506, height: 900 }, [PRIMARY])).toBe(true);
  });

  it('半分はみ出していても 1px でも掛かっていれば「見えている」(OBS 構図の意図的なはみ出し配置を迷子と誤認しない)', () => {
    // 右端から 1px だけ画面に残る
    expect(boundsOnAnyDisplay({ x: 1919, y: 100, width: 506, height: 900 }, [PRIMARY])).toBe(true);
    // 上へ大きくはみ出し(下端だけ画面内)
    expect(boundsOnAnyDisplay({ x: 100, y: -880, width: 506, height: 900 }, [PRIMARY])).toBe(true);
  });

  it('完全に画面外(消えたディスプレイの領域に取り残された)は迷子', () => {
    // かつてのセカンダリ位置に居るが、いまは PRIMARY しか無い
    expect(boundsOnAnyDisplay({ x: 2000, y: 100, width: 506, height: 900 }, [PRIMARY])).toBe(false);
  });

  it('辺が接しているだけ(交差ゼロ)は掛かっていない', () => {
    expect(boundsOnAnyDisplay({ x: 1920, y: 0, width: 506, height: 900 }, [PRIMARY])).toBe(false);
  });

  it('複数ディスプレイのどれか1枚に掛かっていればよい', () => {
    const win = { x: 2000, y: 100, width: 506, height: 600 };
    expect(boundsOnAnyDisplay(win, [PRIMARY, SIDE])).toBe(true);
    expect(boundsOnAnyDisplay(win, [PRIMARY])).toBe(false);
  });

  it('ディスプレイが空(理論上の防御)は迷子扱い', () => {
    expect(boundsOnAnyDisplay({ x: 0, y: 0, width: 100, height: 100 }, [])).toBe(false);
  });
});
