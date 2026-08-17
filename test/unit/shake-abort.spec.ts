import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SHAKE_ABORT_MS } from '@shared/challenge';

/**
 * shake 安全弁と monitor.css の尺の同期契約。
 *
 * pushShake は animationend で解除するのが正だが、遮蔽ウィンドウでは
 * animationend が届かずクラスが固着する。固着すると「同名クラスの連続 shake は
 * CSS アニメが再スタートしない」制限と合わさって以後の揺れが全部消えるため、
 * SHAKE_ABORT_MS のタイマーで必ず外す。安全弁が CSS の尺より短いと、正常系でも
 * 揺れを途中で切ってしまう — CSS の尺を伸ばしたらこのテストが落ちて気づく。
 */
describe('SHAKE_ABORT_MS と monitor.css の同期', () => {
  it('安全弁は shake 系 animation-duration の最大値より長い', () => {
    const css = readFileSync(resolve('src/renderer/styles/monitor.css'), 'utf8').replace(/\r\n/g, '\n');
    // `.monitor-root.shake { animation: shake 450ms ... }` 系の尺を拾う。
    const durations = [...css.matchAll(/\.monitor-root\.shake[\w-]*\s*\{\s*animation:\s*[\w-]+\s+(\d+)ms/g)].map(
      (m) => Number(m[1])
    );
    // shake / shake-strong の2本が居るはず(消えたらセレクタ変更を疑う)。
    expect(durations.length).toBeGreaterThanOrEqual(2);
    expect(SHAKE_ABORT_MS).toBeGreaterThan(Math.max(...durations));
  });
});
