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
    // (v0.8.0: ドレイン順序の一元化で scheduleDrain の order 引数は廃止 —
    //  期待値を 'roulette-first' 付きから引数なしへ更新した。)
    const fn = fnBody('expireRoulette');
    expect(fn).not.toContain('rouletteQueue.current = []');
    expect(fn).not.toContain('joinRouletteQueue.current = []');
    expect(fn).not.toContain('pendingAchieved.current = null');
    expect(fn).toContain('scheduleDrain()');
  });
});

describe('演出優先順位一元化 v0.8.0(§6b 連鎖の譲り合い・据え置き会計)', () => {
  it('finishRoulette: 確定バナー(pushFloat)は譲り判定・コンボ直呼びより前', () => {
    // 譲るときも「止まったリールの額」は先に見せる — バナーが譲り分岐の後ろに
    // 回ると、譲った演出が終わるまでどのリールの額か読めなくなる。
    const fn = fnBody('finishRoulette');
    const banner = fn.indexOf('pushFloat(');
    const yieldAt = fn.indexOf('shouldYieldSpinChain');
    const chainAt = fn.indexOf('startRoulette(e, true, at + 1)');
    expect(banner).toBeGreaterThanOrEqual(0);
    expect(yieldAt, '譲り判定(shouldYieldSpinChain)が無い').toBeGreaterThanOrEqual(0);
    expect(chainAt, 'コンボ直呼びが無い').toBeGreaterThanOrEqual(0);
    expect(banner).toBeLessThan(yieldAt);
    expect(banner).toBeLessThan(chainAt);
  });

  it('譲り分岐: unshift(残りリールの返却)が rouletteHold 解除より前', () => {
    // 逆順だと、hold が落ちた瞬間の pumpStage 再入が「キューに残りが無い」状態を
    // 観測し、据え置き(pendingStageAmount)から残りリールぶんが漏れる。
    const fn = fnBody('finishRoulette');
    const branch = fn.slice(fn.indexOf('shouldYieldSpinChain'), fn.indexOf('startRoulette(e, true, at + 1)'));
    const unshiftAt = branch.indexOf('.unshift(');
    const holdAt = branch.indexOf('rouletteHold.current = false');
    expect(unshiftAt, '譲り分岐に unshift が無い').toBeGreaterThanOrEqual(0);
    expect(holdAt, '譲り分岐に hold 解除が無い').toBeGreaterThanOrEqual(0);
    expect(unshiftAt).toBeLessThan(holdAt);
  });

  it('譲り分岐(more 判定〜コンボ直呼び)は据え置きを解かない', () => {
    // ここで null 収束させると、譲った瞬間に残りリールの出目が数字へ先漏れする。
    // 張り替えは pumpStage の applyStageHold(同一フラッシュ)が行う。
    const fn = fnBody('finishRoulette');
    const branch = fn.slice(fn.indexOf('if (more)'), fn.indexOf('startRoulette(e, true, at + 1)'));
    expect(branch).not.toContain('setHeldValue(null)');
  });

  it.each(['startRoulette', 'startBandFx', 'startBoostFx', 'startStrikeFromPending'])(
    '%s は据え置き会計を heldValueFor に一本化している',
    (fn) => {
      // 4つの開始点が同じ式を共有することが「先漏れ・巻き戻りが出ない」の担保。
      expect(fnBody(fn)).toContain('heldValueFor(');
    }
  );

  it('pendingStageAmount はルーレットを rouletteRemainingAmount(resumeAt 起点)で数える', () => {
    // 全リール直和のままだと §6b の連鎖再開で消化済みリールぶん数字が巻き戻る。
    expect(fnBody('pendingStageAmount')).toContain('rouletteRemainingAmount(');
  });
});
