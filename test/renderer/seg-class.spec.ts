import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { countdownClass, segDigits } from '../../src/renderer/monitor/seg-class';

/**
 * 7セグの見た目を決める規則。
 *
 * 以前は MonitorView.tsx の中にインラインで書かれていて、monitor.css との
 * 整合はソース文字列検査(test/unit/seg-css.spec.ts)でしか担保できなかった。
 * 規則そのものはここで、配線は下の describe で見る。
 */
describe('countdownClass — 点滅と CLEAR の条件', () => {
  it('走行中は素の countdown', () => {
    expect(countdownClass({ status: 'running', shownValue: 500, lowThreshold: 10 })).toBe('countdown  ');
  });

  it('達成すると clear が付く', () => {
    const cls = countdownClass({ status: 'achieved', shownValue: 0, lowThreshold: 10 });
    expect(cls).toContain('clear');
    // achieved は running ではないので low は付かない(排他)。
    expect(cls).not.toContain('low');
  });

  it('残数がしきい値以下になると low(境界を含む)', () => {
    expect(countdownClass({ status: 'running', shownValue: 11, lowThreshold: 10 })).not.toContain('low');
    expect(countdownClass({ status: 'running', shownValue: 10, lowThreshold: 10 })).toContain('low');
    expect(countdownClass({ status: 'running', shownValue: 0, lowThreshold: 10 })).toContain('low');
  });

  it('点滅は走行中だけ — 一時停止(idle)で低い値を保持していても点滅しない', () => {
    // stop() は値を残して idle にする。ここで点滅し続けると、企画を止めた後も
    // 背面モニターがチカチカし続ける。
    expect(countdownClass({ status: 'idle', shownValue: 3, lowThreshold: 10 })).not.toContain('low');
  });

  it('達成後に低い値でも点滅しない(CLEAR と二重にならない)', () => {
    const cls = countdownClass({ status: 'achieved', shownValue: 0, lowThreshold: 10 });
    expect(cls).toContain('clear');
    expect(cls).not.toContain('low');
  });

  it('しきい値 0 なら 0 到達時だけ low', () => {
    expect(countdownClass({ status: 'running', shownValue: 1, lowThreshold: 0 })).not.toContain('low');
    expect(countdownClass({ status: 'running', shownValue: 0, lowThreshold: 0 })).toContain('low');
  });

  it('punch-* は含めない(classList リプレイとの二重管理を防ぐ)', () => {
    for (const status of ['idle', 'running', 'achieved'] as const) {
      expect(countdownClass({ status, shownValue: 1, lowThreshold: 10 })).not.toContain('punch');
    }
  });
});

describe('segDigits — 桁数', () => {
  it('最低4桁は確保する', () => {
    expect(segDigits(0)).toBe(4);
    expect(segDigits(7)).toBe(4);
    expect(segDigits(1000)).toBe(4);
  });

  it('初期値が4桁を超えたら桁を増やす', () => {
    expect(segDigits(12345)).toBe(5);
    expect(segDigits(123456)).toBe(6);
  });
});

describe('MonitorView の配線(規則を自前で書き直していないこと)', () => {
  const SRC = readFileSync('src/renderer/monitor/MonitorView.tsx', 'utf8');

  it('segCls は countdownClass から作る', () => {
    expect(SRC).toMatch(/const segCls = countdownClass\(/);
  });

  it('桁数は segDigits から作る', () => {
    expect(SRC).toMatch(/const digits = segDigits\(/);
  });

  it('条件のインライン再実装が残っていない', () => {
    // 抽出前の式がコピーで戻ってきたら落とす。
    expect(SRC).not.toMatch(/shownValue <= lowThreshold \? 'low'/);
    expect(SRC).not.toMatch(/Math\.max\(4, String\(challenge\.initialValue\)\.length\)/);
  });
});
