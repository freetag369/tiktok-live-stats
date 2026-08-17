import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOAT_ABORT_MS } from '@shared/challenge';

/**
 * フロートバナーの安全弁と monitor.css の尺の同期契約(shake-abort.spec.ts と同型)。
 *
 * バナーは自分の floatup が終わった animationend で消えるのが正だが、遮蔽ウィンドウ
 * では animationend が届かない。届かないと出たまま固着し、FLOAT_MAX=3 の枠を食って
 * 以後のバナーが出なくなるため、FLOAT_ABORT_MS のタイマーで必ず畳む。
 * 安全弁が CSS の尺より短いと正常系のバナーを途中で消してしまう —
 * CSS の尺を伸ばしたらこのテストが落ちて気づく。
 */

const CSS = readFileSync(resolve('src/renderer/styles/monitor.css'), 'utf8').replace(/\r\n/g, '\n');

/** 秒/ミリ秒どちらの表記でも ms に正規化する。 */
function toMs(value: string, unit: string): number {
  return unit === 's' ? Math.round(Number(value) * 1000) : Number(value);
}

describe('FLOAT_ABORT_MS と monitor.css の同期', () => {
  it('安全弁は .float 系の animation 尺の最大値より長い', () => {
    // 基本尺: `.float { animation: floatup 1.6s ... }`
    const base = [...CSS.matchAll(/\.float\s*\{[^}]*animation:\s*floatup\s+([\d.]+)(m?s)/g)].map((m) =>
      toMs(m[1]!, m[2]!)
    );
    // 派生尺: `.float.gift-card { ... animation-duration: 2.2s }`
    const overrides = [...CSS.matchAll(/\.float\.[\w-]+\s*\{[^}]*animation-duration:\s*([\d.]+)(m?s)/g)].map((m) =>
      toMs(m[1]!, m[2]!)
    );
    const all = [...base, ...overrides];
    // 基本尺と、少なくとも gift-card の上書きが居るはず(消えたらセレクタ変更を疑う)。
    expect(base.length, '.float の基本 animation が見つからない').toBeGreaterThanOrEqual(1);
    expect(overrides.length, '.float.<variant> の animation-duration 上書きが見つからない').toBeGreaterThanOrEqual(1);
    expect(FLOAT_ABORT_MS).toBeGreaterThan(Math.max(...all));
  });

  it('::after のシャインは .float 本体より短いか同じ — 長いと安全弁の前提が崩れる', () => {
    // `.float::after { ... animation: float-shine 1.6s ... }`
    const shine = [...CSS.matchAll(/\.float::after\s*\{[^}]*animation:\s*float-shine\s+([\d.]+)(m?s)/g)].map((m) =>
      toMs(m[1]!, m[2]!)
    );
    expect(shine.length, '.float::after の float-shine が見つからない').toBe(1);
    expect(FLOAT_ABORT_MS).toBeGreaterThan(shine[0]!);
  });

  it('擬似要素ガードが MonitorView に残っている(R1 の回帰止め)', () => {
    /*
     * ::after(float-shine 1.6s)の animationend は target === currentTarget のまま
     * .float へ届くので、target 比較だけでは弾けない。実測(Electron 43.2.0 /
     * Chrome 150)では pseudoElement が '::after' になる。このガードを外すと
     * .float.gift-card(2.2s)が 1.6s で消える。
     *
     * ソース文字列マッチなので壊れやすい面はあるが、レンダラのテスト環境が
     * このリポジトリに無い以上、この契約を機械的に守る手段はここしかない。
     */
    const src = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8').replace(/\r\n/g, '\n');
    expect(src).toContain('ev.pseudoElement');
  });
});
