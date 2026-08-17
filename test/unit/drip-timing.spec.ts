import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DELTA_MS } from '@shared/constants';

/**
 * いいねゲージ滴下の尺の不等式契約(float-abort.spec.ts と同型のソース照合)。
 *
 *   DELTA_MS < DRIP_MS <= FILL_MS + HOLD_MS
 *
 * 左側: DRIP_MS が DELTA_MS 以下だと、定常流入でも各バッチの補間が次の delta の
 * 前に完走してしまい、毎サイクル終端に完全停止が入る — バーが 2Hz で脈打つ
 * (v0.7.x 以前の実挙動。DRIP_MS=450 < 500 が原因だった)。DELTA_MS より長ければ
 * 次バッチが必ず補間の途中に届き、司令塔の張り直しで速度が繋がる。
 * 右側: 満タン演出(fill+hold)の間に滴下の持ち越しを残さない従来規約。
 * 実保証は phase!=idle の adoptDrip だが、規約としても守る。
 *
 * DRIP_MS は LikeGauge.tsx の module-private 定数で、test/unit からの import は
 * DOM lib なしの typecheck で落ちるため、ソース文字列から拾う。
 */

const SRC = readFileSync(resolve('src/renderer/monitor/LikeGauge.tsx'), 'utf8').replace(/\r\n/g, '\n');

function intConst(name: string): number {
  const m = SRC.match(new RegExp(`^const ${name} = (\\d+);$`, 'm'));
  expect(m, `LikeGauge.tsx に const ${name} が見つからない`).not.toBeNull();
  return Number(m![1]);
}

describe('いいねゲージ滴下の尺(DELTA_MS < DRIP_MS <= FILL_MS + HOLD_MS)', () => {
  it('DRIP_MS は DELTA_MS より長い — 短いと定常流入で毎サイクル停止し脈打つ', () => {
    expect(intConst('DRIP_MS')).toBeGreaterThan(DELTA_MS);
  });

  it('DRIP_MS は満タン演出(FILL_MS + HOLD_MS)以下 — 演出中の持ち越し禁止規約', () => {
    expect(intConst('DRIP_MS')).toBeLessThanOrEqual(intConst('FILL_MS') + intConst('HOLD_MS'));
  });
});
