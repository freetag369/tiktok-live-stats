import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * 一撃クリア(TIKTOK UNIVERSE)のモニター配線の凍結(ソース文字列検査)。
 *
 * vitest は environment:'node' で MonitorView.tsx を実行できないため、
 * quiz-fx.spec / fx-video-pool.spec と同じ「ソースを読んで不変条件を固定する」流儀。
 * ここで守るのは、**壊れても typecheck もランタイムも黙っている**種類の配線:
 * バリア方式の開始入口、-N を舞台バナー経路へ戻さないこと、登録漏れの4箇所。
 *
 * 読み口は CRLF を正規化する — Windows CI は CRLF でチェックアウトするので、
 * 素の indexOf('\n…') 系は開発機で緑・タグビルドで赤になる(既知の罠)。
 */

const read = (p: string): string => readFileSync(join(__dirname, p), 'utf8').replaceAll('\r\n', '\n');
const view = read('../../src/renderer/monitor/MonitorView.tsx');
const css = read('../../src/renderer/styles/monitor.css');

/** 名前付き関数の本体を粗く切り出す(次の `\n  function ` まで)。 */
function fnBody(name: string): string {
  const at = view.indexOf(`function ${name}(`);
  expect(at, `${name} が無い`).toBeGreaterThanOrEqual(0);
  const end = view.indexOf('\n  function ', at + 1);
  return view.slice(at, end === -1 ? view.length : end);
}

describe('バリア方式の配線(armed 監視が唯一の開始入口)', () => {
  it('universe-start はドレインキューに積まない — pendingUniverseStart に預けるだけ', () => {
    const at = view.indexOf("case 'universe-start': {");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, view.indexOf("case 'universe-end':", at));
    expect(body).toContain('pendingUniverseStart.current = e;');
    // 専用ドレインキューは持たない(quiz-start と同じ非対称)。
    expect(body).not.toContain('pendingUniverses');
  });

  it('armed 監視は「空になった」の全条件を見る(お題の窓も待つ)', () => {
    const at = view.indexOf('const universeArmed =');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, at + 1800);
    for (const cond of [
      // バリア待ちの最中に別要因で達成したら始めない(CLEAR のあとから 25 秒が
      // 始まる事故の予防)。
      "challenge?.status !== 'running'",
      'challenge?.boost != null',
      'challenge?.revolution != null',
      // quiz 自身は自分を待てないのであちらの条件式には無い項目。
      'challenge?.quiz != null',
      'challenge?.fxFreezeUntilMs != null',
      '(challenge?.fxQueue ?? []).some((q) => q.barrier !== true)',
      'pendingAchieved.current !== null',
      'peekNextDrainKind(drainQueuesView())',
      'anyCutinHold()',
      'chainActive()',
      'stageBusy()',
    ]) {
      expect(body, `armed 監視のゲートに ${cond} が無い`).toContain(cond);
    }
  });

  it('worker 側で畳まれたら待ちも演出も片付ける(state 駆動の出口)', () => {
    const at = view.indexOf('if (universeActive) return;');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(view.slice(at, at + 500)).toContain('abortUniverseFx();');
  });
});

describe('startUniverseFx の規律', () => {
  const start = fnBody('startUniverseFx');

  it('cue は実発動のときだけ撃つ(実演で worker をコミットさせない)', () => {
    expect(start).toContain("void rpc('challenge.universeCue'");
    expect(start).toContain('if (!e.test) {');
  });

  it('flushStrike は**幕を立てる前**に遮蔽を引数で渡す', () => {
    const flush = start.indexOf("flushStrike(true, occlusionOfCutin('universe'));");
    const hold = start.indexOf('universeHold.current = true;');
    expect(flush).toBeGreaterThanOrEqual(0);
    expect(hold).toBeGreaterThan(flush);
  });

  it('ホールドを立てた直後に番犬の期限を書く', () => {
    const hold = start.indexOf('universeHold.current = true;');
    expect(start.indexOf('fxHoldDeadlines.current.universe =')).toBeGreaterThan(hold);
  });

  it('二重安全弁(totalMs と totalMs + 2000 の2本)がある', () => {
    expect(start).toContain('push(plan.totalMs, () => finishUniverseFx());');
    expect(start).toContain('push(plan.totalMs + 2000, () => finishUniverseFx());');
  });

  it('刻み音をここで予熱する(どのスロットの既定でもないので起動予熱に乗らない)', () => {
    expect(start).toContain("prewarmSe(['gauge-recover']);");
  });

  it('起点は worker の fromValue を優先する(自前の表示値から割らない)', () => {
    expect(start).toContain('uv.fromValue');
  });
});

describe('★ -N は舞台バナー経路(pushFloat)へ戻さない', () => {
  // .float は 1 枚で約 1,950ms 舞台を占有する(BANNER_MS 1600 + STAGE_GAP 350)ので、
  // 30 枚流すと演出のあとに約 58 秒のバナー渋滞ができる。immediate:true も
  // 「不透明カットインの上に ±N を出さない」規約(floatHoldState.cutinActive)に反する。
  it('startUniverseFx / runUniverseSteps / pushUniverseTick に pushFloat が無い', () => {
    for (const name of ['startUniverseFx', 'runUniverseSteps', 'pushUniverseTick']) {
      expect(fnBody(name), `${name} が pushFloat を呼んでいる`).not.toContain('pushFloat(');
    }
  });

  it('締めのバナーは finishUniverseFx で1枚だけ(演出 → 通知の順)', () => {
    const fin = fnBody('finishUniverseFx');
    expect(fin).toContain("pushFloat(universeNode(e), 'good banner-universe', 'universe');");
    // 最後に必ず次のキューへ渡す。
    expect(fin).toContain('scheduleDrain();');
  });

  it('7セグは holdValue で進める(setHeldValue の直呼びをしない)', () => {
    const run = fnBody('runUniverseSteps');
    expect(run).toContain('holdValue(step.remain);');
    expect(run).not.toContain('setHeldValue(');
  });

  it('段は rAF 1本で進める(setTimeout 30 本にしない — 遮蔽で一斉発火する)', () => {
    const run = fnBody('runUniverseSteps');
    expect(run).toContain('requestAnimationFrame(tick)');
    // ホールドが落ちたら即停止。
    expect(run).toContain('if (!universeHold.current) return;');
    // 飛んだ段はまとめて1発に畳む(SE の轟音とバナーの洪水の予防)。
    expect(run).toContain('for (let i = universeStepAt.current + 1; i <= idx; i++)');
  });
});

describe('★ -N は3倍サイズ・減算合計の発表(2026-08-26 ユーザー要望)', () => {
  it('.ud-tick は 192px / 横ステージ 144px(初版 64 / 48 の3倍)', () => {
    const at = css.indexOf('.universe-drain .ud-tick {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(css.slice(at, css.indexOf('}', at))).toContain('font-size: 192px');
    const land = css.indexOf('.stage-scale.landscape .universe-drain .ud-tick {');
    expect(css.slice(land, css.indexOf('}', land))).toContain('font-size: 144px');
  });

  it('-N のサイズは shared が桁数から決める(インライン style が権威)', () => {
    // 3倍(192px)を上限に、桁が増えたぶんだけ縮める。CSS の 192px は据わり値。
    // 5 文字「-1500」が縦ステージ(540px)で実測 505px = ぎりぎり収まる線。
    const at = view.indexOf('className={`ud-tick s${t.slot}`}');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, at + 500);
    expect(body).toContain('universeTickFontPx(t.amount, landscape)');
    // 桁区切りは入れない — 合計の発表(countupDisplayAt)と表記を揃える。
    expect(body).toContain('-{t.amount}');
    expect(body).not.toContain('num(t.amount)');
  });

  it('同時枚数(UNIVERSE_TICK_SLOTS)とアンカー数は一致する', () => {
    // 増やすとクラスの無い要素が左上(0,0)へ固まる。
    const m = view.match(/const UNIVERSE_TICK_SLOTS = (\d+);/);
    expect(m, 'UNIVERSE_TICK_SLOTS が無い').not.toBeNull();
    const slots = Number(m![1]);
    const anchors = [...css.matchAll(/\.universe-drain \.ud-tick\.s(\d+) \{/g)].length;
    expect(anchors).toBe(slots);
  });

  it('合計は締めの段で出し、rAF が textContent 直書きで駆け上がる', () => {
    const start = fnBody('startUniverseFx');
    expect(start).toContain('setUniverseTotal({');
    expect(start).toContain('runUniverseTotal(plan.from, plan.totalCountupMs);');
    expect(start).toContain('push(plan.totalFadeAtMs,');
    const run = fnBody('runUniverseTotal');
    expect(run).toContain('countupDisplayAt(');
    expect(run).toContain('requestAnimationFrame(tick)');
    // ホールドが落ちたら即停止(段の rAF と同じ規律)。
    expect(run).toContain('if (!universeHold.current) return;');
    // 数字は毎フレーム setState しない。
    expect(run).toContain('node.textContent =');
  });

  it('合計も舞台バナー経路(pushFloat)を通さない', () => {
    expect(fnBody('runUniverseTotal')).not.toContain('pushFloat(');
  });

  it('合計は暗いパネル(.ut-box)の上に置く — 締めの素材は白青の爆発で数字が飛ぶ', () => {
    const at = css.indexOf('.universe-total .ut-box {');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(css.slice(at, css.indexOf('}', at))).toContain('background:');
  });

  it('.universe-total は z-index を持たず、フェードは UNIVERSE_FADE_MS と一致', () => {
    const at = css.indexOf('.universe-total {');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = css.slice(at, css.indexOf('}', at));
    expect(body).not.toContain('z-index');
    expect(body).toContain('400ms');
  });

  it('fxHoldBusy と後始末に universeTotal がある(CLEAR リザルトが上に生えない)', () => {
    const at = view.indexOf('const fxHoldBusy =');
    expect(view.slice(at, view.indexOf(';', at))).toContain('universeTotal !== null');
    expect(fnBody('finishUniverseFx')).toContain('setUniverseTotal(null);');
    expect(fnBody('abortUniverseFx')).toContain('setUniverseTotal(null);');
  });
});

describe('登録漏れの4箇所(落とすと症状だけが黙って壊れる)', () => {
  it('opaqueCutinActive と anyCutinHold に universeHold がある', () => {
    for (const name of ['opaqueCutinActive', 'anyCutinHold']) {
      expect(fnBody(name), `${name} に universeHold が無い`).toContain('universeHold.current');
    }
  });

  it('fxHoldBusy に universeClip / universeDrain がある(CLEAR リザルトが幕の上に生えない)', () => {
    const at = view.indexOf('const fxHoldBusy =');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, view.indexOf(';', view.indexOf('quizSettle !== null', at)));
    expect(body).toContain('universeClip !== null');
    expect(body).toContain('universeDrain !== null');
  });

  it('followHoldWithPresses は演出中は素通りする(数字が上へ巻き戻らない)', () => {
    const fn = fnBody('followHoldWithPresses');
    expect(fn.indexOf('if (universeHold.current) return;')).toBeGreaterThanOrEqual(0);
    // ガードは先頭(drop の計算より前)。
    expect(fn.indexOf('if (universeHold.current) return;')).toBeLessThan(fn.indexOf('pressDropSinceHold'));
  });

  it('番犬の出口は finishUniverseFx(バナーと scheduleDrain を落とさない)', () => {
    const at = view.indexOf('universeHold.current && d.universe !== 0');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(view.slice(at, at + 260)).toContain('finishUniverseFx();');
  });
});

describe('動画ホルダーは1本(導入と締めで使い回す)', () => {
  it("armVideoPlay(v, 'universe-cutin' はちょうど1回", () => {
    const hits = [...view.matchAll(/armVideoPlay\(v, 'universe-cutin'/g)];
    expect(hits).toHaveLength(1);
  });

  it('再生失敗の縮退先は url:null(暗幕)— setUniverseClip(null) にしない', () => {
    const at = view.indexOf("armVideoPlay(v, 'universe-cutin'");
    const body = view.slice(at - 900, at + 900);
    expect(body).toContain('{ ...c, url: null }');
    expect(body).toContain('universe-screen');
  });
});

describe('CSS の規約', () => {
  it('.universe-drain / .universe-screen に z-index を付けない(DOM 順が全て)', () => {
    for (const sel of ['.universe-drain {', '.universe-screen {']) {
      const at = css.indexOf(sel);
      expect(at, `${sel} が無い`).toBeGreaterThanOrEqual(0);
      expect(css.slice(at, css.indexOf('}', at))).not.toContain('z-index');
    }
  });

  it('.universe-screen の transition は UNIVERSE_FADE_MS(400ms)と一致', () => {
    const at = css.indexOf('.universe-screen {');
    expect(css.slice(at, css.indexOf('}', at))).toContain('400ms');
  });

  it('reduced-motion で減算レイヤと暗幕を消す(JS 側のガードと対)', () => {
    const at = css.indexOf('@media (prefers-reduced-motion: reduce)');
    const body = css.slice(at);
    expect(body).toContain('.universe-drain');
  });

  it('DOM 順は .floats より前(「数字が最前」の .count-mirror を追い越さない)', () => {
    const drain = view.indexOf('className="universe-drain"');
    const floats = view.indexOf('<div className="floats">');
    expect(drain).toBeGreaterThanOrEqual(0);
    expect(drain).toBeLessThan(floats);
  });
});
