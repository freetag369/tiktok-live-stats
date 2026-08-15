import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * ホールド(rouletteHold / bandHold / stockCutinHold / boostHold)の孤児化防止。
 *
 * boolean ホールドが1つでも固着すると anyCutinHold() が立ちっぱなしになり、
 * pumpStage が毎回 return して数字も演出も永久に止まる(実配信で「ブースト明けに
 * 突然固まる」として観測された壊れ方)。ここでは fx-stage.spec.ts と同型の
 * 「ソース不変条件」で、(1) finishBoostFx の安全弁再アーム、(2) 各 start* の
 * 番犬期限の書き込み、(3) 番犬の存在と出口、をレンダラを起動せずに固定する。
 */

const SRC = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8');

/** コンポーネント直下(2スペースインデント)の関数本文を切り出す。 */
function fnBody(name: string): string {
  const m = SRC.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n {2}\\}`));
  expect(m, `${name} が見つからない`).toBeTruthy();
  return m![0];
}

describe('boostHold の安全弁(finishBoostFx の再アーム)', () => {
  it('finishBoostFx は clearBoostTimers の後に expire 安全弁を張り直す', () => {
    // 冒頭の clearBoostTimers は startBoostFx が張った expire も消す。再アームが
    // 無いと、以降の setTimeout 連鎖のビート1つの消失で boostHold が孤児化する。
    const fn = fnBody('finishBoostFx');
    const clearAt = fn.indexOf('clearBoostTimers()');
    const rearmAt = fn.indexOf('window.setTimeout(expireBoostFx');
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(rearmAt, 'expire 安全弁の再アームが無い').toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeLessThan(rearmAt);
  });

  it('expire の余白は startBoostFx / finishBoostFx が同じ定数を使う(二重管理の防止)', () => {
    expect(fnBody('startBoostFx')).toContain('BOOST_EXPIRE_MARGIN_MS');
    expect(fnBody('finishBoostFx')).toContain('BOOST_EXPIRE_MARGIN_MS');
    // 生の数値に戻すと片方だけ調整して守備範囲が割れる。
    expect(SRC).not.toMatch(/totalMs \+ 3000/);
  });

  it('startBandFx の二重安全弁(totalMs と totalMs+2000)は退行させない', () => {
    const fn = fnBody('startBandFx');
    expect([...fn.matchAll(/window\.setTimeout\(finishBandFx/g)].length).toBe(2);
  });
});

describe('ホールド番犬(時間ベースの最後の脱出口)', () => {
  it.each([
    ['startRoulette', 'roulette'],
    ['startBandFx', 'band'],
    ['startStockCutin', 'stock'],
    ['startBoostFx', 'boost'],
  ])('%s は hold を立てたら番犬の期限も書く', (fn, key) => {
    // 番犬は hold が真の間しか期限を読まない — hold を立てる側の書き込みが唯一の契約。
    expect(fnBody(fn)).toContain(`fxHoldDeadlines.current.${key} =`);
  });

  it('hold を true にする箇所は4つの start* だけ(新しい持ち主は期限の書き込みも必要)', () => {
    // このカウントが増えたら、その箇所にも fxHoldDeadlines の書き込みを足すこと。
    const holds = [...SRC.matchAll(/(?:roulette|band|stockCutin|boost)Hold\.current = true/g)];
    expect(holds.length).toBe(4);
  });

  it('番犬 interval が存在し、4ホールドすべてを既存の締め関数で解除する', () => {
    const at = SRC.indexOf('FX_HOLD_WATCHDOG_MS);');
    expect(at, '番犬の setInterval が見つからない').toBeGreaterThanOrEqual(0);
    const effect = SRC.slice(SRC.lastIndexOf('useEffect', at), at);
    // 出口は必ず既存の expire/finish/abort — 新規のクリーンアップを番犬に書かない。
    expect(effect).toContain('expireBoostFx()');
    expect(effect).toContain('finishBandFx()');
    expect(effect).toContain('abortStrike()');
    expect(effect).toContain('expireRoulette()');
  });

  it('expireRoulette は持ち越しを捨てない(abortRoulette との役割の違い)', () => {
    // rouletteQueue / pendingAchieved を捨てると、番犬発火のたびにキュー済みスピンと
    // CLEAR 演出が黙って消える。捨ててよいのは reset/stop の abortRoulette だけ。
    const fn = fnBody('expireRoulette');
    expect(fn).not.toContain('rouletteQueue.current = []');
    expect(fn).not.toContain('pendingAchieved.current = null');
    expect(fn).toContain("scheduleDrain('roulette-first')");
  });
});
