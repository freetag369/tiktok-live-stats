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

const SRC = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8').replace(/\r\n/g, '\n');

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

describe('フィーバーのアーム→コミット(起動カットインを削らせない)', () => {
  // レンダラの DOM テスト環境がこのリポジトリに無いので、合図が消えて/移動して
  // いないことはソース文字列でしか担保できない。合図が落ちると worker は
  // アーム期限(BOOST_ARM_MAX_MS)まで待ってから自走し、症状が静かに再発する。
  it('startBoostFx は e.test 以外で必ず challenge.boostCue を撃つ', () => {
    const fn = fnBody('startBoostFx');
    expect(fn).toContain("'challenge.boostCue'");
    expect(fn).toContain('!e.test');
  });

  it('合図は前置き(preMs)が確定してから — 段の尺を送るので順序が意味を持つ', () => {
    const fn = fnBody('startBoostFx');
    expect(fn.indexOf('const preMs')).toBeGreaterThanOrEqual(0);
    expect(fn.indexOf('const preMs')).toBeLessThan(fn.indexOf("'challenge.boostCue'"));
  });

  it('再生を見送る経路は drop を撃つ(撃たないと worker が期限まで待つ)', () => {
    // 入口の満杯・直行/ドレインの skip・開始不可・マウント時の総解放。
    expect([...SRC.matchAll(/dropBoostCue\(/g)].length).toBeGreaterThanOrEqual(6);
  });

  it('worker 再起動では持ち越しを捨てる(誰も清算しない不透明シネマを防ぐ)', () => {
    const m = SRC.match(/useEffect\(\(\) => \{[\s\S]*?\}, \[workerEpoch\]\)/);
    expect(m, 'workerEpoch の effect が見つからない').toBeTruthy();
    expect(m![0]).toContain('pendingBoosts.current = []');
  });
});

describe('演出優先順位一元化 v0.8.0(§6b 連鎖の譲り合い・据え置き会計)', () => {
  /**
   * finishRoulette の「コンボ直呼び」と「連鎖分岐の入口」。**シグネチャや条件式を
   * 変えたらここも直す** — 下の it は slice の境界にこのリテラルを使っており、
   * ズレると indexOf が -1 を返して slice が黙って別の(多くは空の)範囲を検査する
   * = テストが緑のまま無意味になる。だから必ず存在ガードを先に置く。
   */
  const CHAIN_CALL = 'startRoulette(e, at + 1)';
  const MORE_BRANCH = 'if (more && !cutForAchieved)';

  it('目印のリテラルがソースに実在する(slice が空振りしていないことの担保)', () => {
    const fn = fnBody('finishRoulette');
    expect(fn.includes(CHAIN_CALL), `コンボ直呼び ${CHAIN_CALL} が無い`).toBe(true);
    expect(fn.includes(MORE_BRANCH), `連鎖分岐 ${MORE_BRANCH} が無い`).toBe(true);
  });

  it('finishRoulette: 確定バナー(pushFloat)は譲り判定・コンボ直呼びより前', () => {
    // 譲るときも「止まったリールの額」は先に見せる — バナーが譲り分岐の後ろに
    // 回ると、譲った演出が終わるまでどのリールの額か読めなくなる。
    const fn = fnBody('finishRoulette');
    const banner = fn.indexOf('pushFloat(');
    const yieldAt = fn.indexOf('shouldYieldSpinChain');
    const chainAt = fn.indexOf(CHAIN_CALL);
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
    const branch = fn.slice(fn.indexOf('shouldYieldSpinChain'), fn.indexOf(CHAIN_CALL));
    const unshiftAt = branch.indexOf('.unshift(');
    const holdAt = branch.indexOf('rouletteHold.current = false');
    expect(unshiftAt, '譲り分岐に unshift が無い').toBeGreaterThanOrEqual(0);
    expect(holdAt, '譲り分岐に hold 解除が無い').toBeGreaterThanOrEqual(0);
    expect(unshiftAt).toBeLessThan(holdAt);
  });

  it('譲り分岐(連鎖分岐〜コンボ直呼び)は据え置きを解かない', () => {
    // ここで null 収束させると、譲った瞬間に残りリールの出目が数字へ先漏れする。
    // 張り替えは pumpStage の applyStageHold(同一フラッシュ)が行う。
    const fn = fnBody('finishRoulette');
    const branch = fn.slice(fn.indexOf(MORE_BRANCH), fn.indexOf(CHAIN_CALL));
    expect(branch.length, '連鎖分岐の範囲が空 — 目印がズレている').toBeGreaterThan(0);
    expect(branch).not.toContain('setHeldValue(null)');
  });

  it('達成の打ち切り: 確定バナーより後・譲り判定より前に判断する', () => {
    // ゴール到達(pendingAchieved)が待っているなら連鎖は続けない — fxHoldBusy に
    // roulette が入るので、続けると CLEAR もリザルトも最後の1本まで出ない
    // (フル尺化で最悪2分)。譲り判定より前なのは「打ち切るなら譲るものが無い」から。
    const fn = fnBody('finishRoulette');
    const banner = fn.indexOf('pushFloat(');
    const cutAt = fn.indexOf('cutForAchieved');
    const yieldAt = fn.indexOf('shouldYieldSpinChain');
    expect(cutAt, '達成の打ち切り(cutForAchieved)が無い').toBeGreaterThanOrEqual(0);
    // 判定そのものは more の直後(バナーより前)、分岐の適用は譲り判定より前。
    expect(fn.indexOf(MORE_BRANCH)).toBeLessThan(yieldAt);
    expect(banner).toBeLessThan(yieldAt);
    expect(fn).toContain('pendingAchieved.current !== null');
  });

  it('達成の打ち切り: hold と据え置きを必ず解く(固着させない)', () => {
    // 打ち切りは連鎖の終端なので、!more と同じ後始末が要る。解かずに抜けると
    // rouletteHold が孤児化して pumpStage が毎回 return = 舞台の全死になる。
    const fn = fnBody('finishRoulette');
    expect(fn).toContain('if (!more || cutForAchieved) {');
    const tail = fn.slice(fn.indexOf('if (!more || cutForAchieved) {'));
    expect(tail.slice(0, 200)).toContain('rouletteHold.current = false');
    expect(tail.slice(0, 200)).toContain('setHeldValue(null)');
  });

  it('打ち切った残りリールは合算バナーで締める(値を黙って消さない)', () => {
    // 値は worker で全部適用済み。畳むのは見た目だけなので、残量は shared の
    // rouletteRemainingAmount(据え置き会計と同じ権威)から引く。
    const fn = fnBody('finishRoulette');
    expect(fn).toContain('rouletteRemainingAmount(e, restFrom)');
    expect(fn).toContain('rouletteRestBanner(');
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

describe('着弾の常時実行(2026-08-16 ユーザー決定 — shared/fx-strike-route.ts)', () => {
  it('strikeBeatNow は据え置きを所有しない(holdValue 禁止・setHeldValue は関数型 updater のみ)', () => {
    // ビートはカットイン中(持ち主が別に居る)に走る。数値を渡す setHeldValue や
    // holdValue を書くと持ち主が二重になり、数字の巻き戻り・出目の先漏れが復活する。
    const fn = fnBody('strikeBeatNow');
    expect(fn).not.toContain('holdValue(');
    const all = [...fn.matchAll(/setHeldValue\(/g)].length;
    const functional = [...fn.matchAll(/setHeldValue\(\(h\)/g)].length;
    expect(all).toBeGreaterThan(0);
    expect(functional).toBe(all);
  });

  it('stockImpactVisuals は据え置きに一切触らない(revealStock との分割の要)', () => {
    // ここに setHeldValue / activeStrike が入ると、ビート経路(カットイン中)から
    // 呼んだ瞬間に持ち主の据え置きを壊す。解除は revealStock 側の2行だけ。
    const fn = fnBody('stockImpactVisuals');
    expect(fn).not.toContain('setHeldValue');
    expect(fn).not.toContain('activeStrike');
  });

  it('queueStrike の呼び出しは3箇所だけ(coalesce / flushStrike 安全弁 / runDrain の戻し)', () => {
    // 増えたら「舞台待ちのキュー」が復活していないか疑うこと — 着弾は常時実行が規約。
    // 4 = 定義1 + 呼び出し3。
    expect([...SRC.matchAll(/queueStrike\(/g)].length).toBe(4);
  });

  it('値変化 effect は routeStrike(shared の真理値表)で分岐する — stageBusy を着弾に使わない', () => {
    expect(SRC).toContain('const route = routeStrike({');
    // routeStrike の入力に stageBusy 系を足したら fx-strike-route.spec の構造凍結も
    // 同時に落ちる設計だが、レンダラ側の配線もここで見張る。
    const call = SRC.slice(SRC.indexOf('const route = routeStrike({'), SRC.indexOf('});', SRC.indexOf('const route = routeStrike({')));
    expect(call).not.toContain('stageBusy');
  });

  it('flushStrike の handoff(横取り)はビートで撃ち切る — 後送りの queueStrike に戻さない', () => {
    const fn = fnBody('flushStrike');
    const handoffBranch = fn.slice(fn.indexOf('if (handoff)'), fn.indexOf('} else if'));
    expect(handoffBranch).toContain('strikeBeatNow(');
    expect(handoffBranch).not.toContain('queueStrike(');
  });

  it('finishStockCutin はチェーン終端として continueStrikeChain で直結する(舞台へ落とさない)', () => {
    // scheduleDrain 直呼びに戻すと、カットイン中に合算された満タンがバナーの
    // ドレイン待ちへ落ち、「着弾が出ない」が再発する。
    const fn = fnBody('finishStockCutin');
    expect(fn).toContain('continueStrikeChain()');
    expect(fn).not.toContain('scheduleDrain()');
  });
});

describe('確定バナー保護 — バナーは単枠置換なのでビートは触らない(2026-08-16)', () => {
  // showBannerNow は setFloats([1枚]) の置換。immediate flush は「表示中バナーを
  // 上書きで消す権利」でもあり、ビート化でルーレットの確定 ±N が1フレームで
  // 消える実害が出た。ここで固定するのは (1) ビートのバナー非接触、(2) 保留 flush の
  // ラッチ判定、(3) ルーレット確定バナー側の immediate 温存、の3点。
  it('strikeBeatNow はバナーに一切触らない(flush 系・pushFloat 不在)', () => {
    const fn = fnBody('strikeBeatNow');
    expect(fn).not.toContain('flushDeferredFloats(');
    expect(fn).not.toContain('flushPendingFloat(');
    expect(fn).not.toContain('pushFloat(');
    // visuals は flushFloats=false で呼ぶ — 無引数に戻すと確定バナー上書きが再発。
    expect(fn).toContain('impactStrikeVisuals(false)');
    expect(fn).toContain('stockImpactVisuals(stockDelta, false)');
  });

  it.each([
    ['impactStrikeVisuals', 'flushPendingFloat('],
    ['stockImpactVisuals', 'flushDeferredFloats('],
  ])('%s は flushFloats=true 既定+ガード付き flush を保つ', (name, flushCall) => {
    // 既定 true = チェーン着弾(impactStrike / impactStrikePartial / revealStock /
    // startStrikeFromPending 縮退)は従来どおり通知を出す。ガードを外すとビート
    // 経路の非接触が破れ、ガードごと消すと通知が永久に保留される。
    const fn = fnBody(name);
    expect(fn).toContain('flushFloats = true');
    expect(fn).toContain(`if (flushFloats) ${flushCall}`);
  });

  it('flushPendingFloat の immediate はラッチ判定付き(無条件 true に戻さない)', () => {
    // 無条件 immediate は表示中のルーレット確定バナーを置換で消す(実害の本体)。
    // 読み取りはクランプ規律(stageBusy と同型)。
    const fn = fnBody('flushPendingFloat');
    expect(fn).toContain('clampBannerEndAt(');
    expect(fn).toContain('stageWaitMs(');
    expect(fn).not.toContain('immediate: true');
  });

  it('finishRoulette の確定バナーは immediate を維持する(逆方向の退行防止)', () => {
    // 確定バナーはリールのビートに同期する唯一のバナー。ラッチ判定に落とすと
    // コンボ中(rouletteHold 中はキューが開かない)に1枚も出なくなる。
    const fn = fnBody('finishRoulette');
    expect(fn).toContain('immediate: true');
  });
});

describe('着弾の背面再生 — 遮蔽 occlusion(2026-08-17 ユーザー決定)', () => {
  // 要望:「満杯・ストック満杯はキュー作動中も**後ろで**演出が再生される。
  //        ルーレット中は後ろで少し見える、ギフト中・ブースト再生中は音だけ聞こえる」。
  // 真理値表は shared/fx-occlusion.ts(fx-occlusion.spec.ts が凍結)、見え方を作る
  // CSS と DOM 順は fx-backdrop.spec.ts。ここはレンダラ側の**配線**を見張る。

  it('fnBody(strikeBeatNow) が末尾まで取れている(切り出し縮みの偽陽性を潰す)', () => {
    // fnBody は `\n  }` までの最短一致。関数の途中に2スペースの `}` を作ると
    // 切り出しが縮み、下の not.toContain 群が短い文字列に対して評価されて
    // **落ちずに通ってしまう**。最後の1行の存在で範囲を証明しておく。
    expect(fnBody('strikeBeatNow')).toContain('if (plan.fullClip) playClip(');
  });

  it('ビートは背面フル演出の全画面クリップを持つ(要望の本体)', () => {
    const fn = fnBody('strikeBeatNow');
    // フルチェーン(launchStrike / launchStock)しか持っていなかった2本をビートにも。
    expect(fn).toContain('GAUGE_FULL_CLIP_URL');
    expect(fn).toContain('STOCK_FULL_CLIP_URL');
    // plan.fullClip は 'sheer' 限定 — 'none' で撃つと二重再生、'opaque' で撃つと
    // clipQueue に溜まってカットイン明けに遅れて漏れる。素の playClip に戻さない。
    expect(fn).toContain('if (plan.fullClip) playClip(');
    // mode は既定の 'queue' — 第2引数を足すと再生中のクリップを打ち切ることになり、
    // 「再生中の演出は中断しない」(fx-priority)の規約に反する。呼びが URL で
    // 閉じていることが「引数は1つだけ」の機械的な証拠。
    expect(fn).toContain('GAUGE_FULL_CLIP_URL);');
  });

  it('遮蔽の受け渡しは同期の try/finally(タイマーで開けっ放しにしない)', () => {
    const fn = fnBody('strikeBeatNow');
    expect(fn).toContain('const occ = maxOcclusion(imminent, currentOcclusion());');
    expect(fn).toContain('} finally {');
    expect(fn).toContain('beatOcclusion.current = prevOcc;');
    // setTimeout で閉じると、遮蔽が開いたまま次の着弾が来て黙る(固着の再来)。
    expect(fn).not.toContain('setTimeout');
  });

  it('visuals 2 本は plan 駆動 — 全画面クリップはビート側の責務のまま', () => {
    for (const name of ['impactStrikeVisuals', 'stockImpactVisuals']) {
      const fn = fnBody(name);
      expect(fn, `${name} が plan 駆動でない`).toContain('const plan = impactPlanNow();');
      // ここで全画面クリップを撃つと、チェーン経路(launchStrike / launchStock)と
      // 二重に鳴る。fullClip は strikeBeatNow だけが読む。
      expect(fn, `${name} は fullClip を読まない`).not.toContain('fullClip');
    }
  });

  it('SE は遮蔽で落とさない — 「音だけ聞こえる」が「何も起きない」に退化しない', () => {
    // useChallengeSe は gauge-full / stock-full を常に null にしている(二重再生の
    // 防止)ので、この2行がモニター唯一の発音点。plan.se は seEnabled と一致する。
    for (const name of ['impactStrikeVisuals', 'stockImpactVisuals']) {
      expect(fnBody(name), `${name} の SE が plan.se ゲートでない`).toContain('if (plan.se && cfg) {');
    }
  });

  it('パンチと据え置きは遮蔽の外(走行中のタップは演出より優先)', () => {
    // 7セグのパンチを plan で黙らせると、カットインの下で押しても手応えが消える。
    for (const name of ['impactStrikeVisuals', 'stockImpactVisuals']) {
      const fn = fnBody(name);
      const punch = fn.indexOf("setPunchDir('strike');");
      expect(punch, `${name} のパンチが無い`).toBeGreaterThanOrEqual(0);
      // 直前の行が plan ゲートになっていない(素の文として出ている)ことの確認。
      expect(fn).toContain("    setPunchDir('strike');\n    setPunchKey((k) => k + 1);");
    }
  });

  it('横取り 3 箇所は「これから立つ幕」を渡す(hold は後で立つので ref では足りない)', () => {
    const calls = SRC.split('flushStrike(true, ').length - 1;
    expect(calls, 'flushStrike(true) の引数なし呼び出しが残っている').toBe(3);
    for (const kind of ['roulette', 'band', 'boost']) {
      expect(SRC, `${kind} の横取りが遮蔽を渡していない`).toContain(
        `flushStrike(true, occlusionOfCutin('${kind}'));`
      );
    }
  });

  it('imminentOcc の畳み込みは maxOcclusion(先勝ちの .some に戻さない)', () => {
    const from = SRC.indexOf('const imminentOcc: FxOcclusion =');
    expect(from, 'imminentOcc が無い').toBeGreaterThanOrEqual(0);
    const to = SRC.indexOf("const cutinImminent = imminentOcc !== 'none';", from);
    expect(to, 'cutinImminent の導出が無い').toBeGreaterThan(from);
    const fold = SRC.slice(from, to);
    // .some() の先勝ちだと、ルーレットと帯域カットインが同一デルタに相乗りしたとき
    // 'sheer' に倒れて「ギフト中は音だけ」が破れる。
    expect(fold).toContain('maxOcclusion(');
    expect(fold).not.toContain('.some(');
    // 4 重ガードはどれ1つ落としてはいけない(:1120-1127 の実害コメント参照)—
    // 始まらない演出を数えると、beat に落とした数字の据え置きを誰も引き取らない。
    for (const guard of [
      'lastPlayed.current === null',
      'isChallengeEffectFresh(',
      'rouletteWillSpin(',
      'boostWillStart(',
      'bandWillStart(',
    ]) {
      expect(fold, `4重ガードの ${guard} が落ちている`).toContain(guard);
    }
  });

  it('currentOcclusion は opaqueCutinActive を土台にする(第2の真実を作らない)', () => {
    // playGiftVisual(連打ギフトの2発目以降)が同じ述語を使っている。別式に分けると
    // 「片方だけ幕を認識する」食い違いが出る。
    const fn = fnBody('currentOcclusion');
    expect(fn).toContain('opaqueCutinActive()');
    expect(fn).toContain('rouletteHold.current');
    // 4 ホールドを直接読み直す実装に戻していないこと。
    expect(fn).not.toContain('bandHold');
    expect(fn).not.toContain('boostHold');
  });
});
