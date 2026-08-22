import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * お題ルーレットのモニター配線の凍結(ソース文字列検査)。
 *
 * vitest は environment:'node' で MonitorView.tsx を実行できないため、
 * fx-video-pool.spec / fx-backdrop.spec と同じ「ソースを読んで不変条件を固定する」
 * 流儀で、壊れると黙って見え方だけが崩れる配線を検査する。
 *
 * 読み口は CRLF を正規化する — Windows CI は CRLF でチェックアウトするので、
 * 素の indexOf('\n…') 系は開発機で緑・タグビルドで赤になる(既知の罠)。
 */

const read = (p: string): string => readFileSync(join(__dirname, p), 'utf8').replaceAll('\r\n', '\n');
const view = read('../../src/renderer/monitor/MonitorView.tsx');
const css = read('../../src/renderer/styles/monitor.css');

describe('バリア方式の配線(armed 監視が唯一の開始入口)', () => {
  it('quiz-start はドレインキューに積まない — pendingQuizStart に預けるだけ', () => {
    // playEffect の case 'quiz-start' が pendingQuizzes.push を含むと、開始が
    // ドレイン順(優先度)で決まってしまい「キュー消化を待つ」ユーザー決定が壊れる。
    const at = view.indexOf("case 'quiz-start': {");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, view.indexOf("case 'quiz-end': {", at));
    expect(body).toContain('pendingQuizStart.current = e;');
    expect(body).not.toContain('pendingQuizzes.current.push');
  });

  it('armed 監視は「空になった」の全条件を見る(fxQueue / boost / revolution / ドレイン / 舞台)', () => {
    const at = view.indexOf('const quizArmed =');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, at + 1600);
    for (const cond of [
      'challenge?.boost != null',
      'challenge?.revolution != null',
      'challenge?.fxFreezeUntilMs != null',
      // バリアで溜めた予告(barrier)だけは数えない — 数えると待ちが永久化する。
      "(challenge?.fxQueue ?? []).some((q) => q.barrier !== true)",
      'peekNextDrainKind(drainQueuesView())',
      'anyCutinHold()',
      'stageBusy()',
    ]) {
      expect(body, `armed 監視のゲートに ${cond} が無い`).toContain(cond);
    }
  });

  it('startQuizFx は quizCue{start} を撃つ(実再生開始が窓の原点 — 革命と同じ設計)', () => {
    const at = view.indexOf('function startQuizFx');
    const body = view.slice(at, view.indexOf('function finishQuizIntro'));
    expect(body).toContain("rpc('challenge.quizCue'");
    expect(body).toContain("action: 'start'");
    // ▶実演では撃たない(実発動のアームを試写の時刻でコミットさせない)。
    expect(body).toContain('if (!e.test) {');
  });

  it('導入 URL は専用素材(QUIZ_INTRO_SELF)を fxClipUrl より先に分岐する', () => {
    // 専用素材は FX_CLIPS のカタログに載っていないので、順序を逆にすると
    // 番兵 'quiz' が未知 id 扱いで null になり、既定の導入が黙って消える。
    const at = view.indexOf('function startQuizFx');
    const body = view.slice(at, view.indexOf('function finishQuizIntro'));
    const self = body.indexOf('QUIZ_INTRO_CLIP_URL');
    const catalog = body.indexOf('fxClipUrl(e.quizIntroClip)');
    expect(self, '専用素材の URL を見ていない').toBeGreaterThanOrEqual(0);
    expect(catalog, 'カタログ側の解決が無い').toBeGreaterThanOrEqual(0);
    expect(self, '専用素材の分岐が fxClipUrl より後ろにある').toBeLessThan(catalog);
    expect(body).toContain('QUIZ_INTRO_SELF');
  });

  it('導入の素材欠損は段ごとスキップして回転から始める(preMs も実再生尺で申告)', () => {
    const at = view.indexOf('function startQuizFx');
    const body = view.slice(at, view.indexOf('function finishQuizIntro'));
    // realIntroMs が「URL が解けたときだけ introMs」になっていないと、素材が無い
    // ときに黒画面のまま preMs だけ進んで窓の開始が 8 秒ズレる。
    expect(body).toContain('const realIntroMs = introUrl !== null');
    // 前置きの総尺には**お題発表準備**(prepMs)も入る。落とすと準備表示の途中で
    // 制限時間が始まる(worker が同じ式で窓の頭を決めているため)。
    expect(body).toContain(
      'const totalMs = realIntroMs + QUIZ_SPIN_MS + QUIZ_REVEAL_MS + prepMs;'
    );
    // 尺は cfg 直読みではなく effect が権威(cfg は 120 秒ポーリングで古くなりうる)。
    expect(body).toContain('const prepMs = Math.max(0, e.quizPrepMs ?? 0);');
    expect(body).toContain('preMs: totalMs');
  });
});

describe('ホールドの3点セット(漏れると幕の上に粒子・CLEAR が生える既知事故)', () => {
  it('opaqueCutinActive / anyCutinHold に quizHold と quizResultHold が並ぶ', () => {
    for (const fn of ['function opaqueCutinActive', 'function anyCutinHold']) {
      const at = view.indexOf(fn);
      expect(at, `${fn} が無い`).toBeGreaterThanOrEqual(0);
      const body = view.slice(at, view.indexOf('}', view.indexOf('return', at)));
      expect(body, `${fn} に quizHold が無い`).toContain('quizHold.current');
      expect(body, `${fn} に quizResultHold が無い`).toContain('quizResultHold.current');
    }
  });

  it('fxHoldBusy に quiz の最前面 state 4種が並ぶ', () => {
    const at = view.indexOf('const fxHoldBusy =');
    const body = view.slice(at, at + 1600);
    for (const s of ['quizClip !== null', 'quizSpin !== null', 'quizReveal !== null', 'quizSettle !== null']) {
      expect(body, `fxHoldBusy に ${s} が無い`).toContain(s);
    }
  });

  it('番犬が quiz / quizResult を見て既存の締め関数で解除する', () => {
    expect(view).toContain('d.quiz !== 0 && now > d.quiz');
    expect(view).toContain('d.quizResult !== 0 && now > d.quizResult');
  });
});

describe('DOM 順と CSS(z-index 禁止の恒久ルール)', () => {
  it('quiz のオーバーレイは .fx-layer 内・.roulette-screen より後・.floats より前', () => {
    const layer = view.indexOf('className="fx-layer"');
    const roulette = view.indexOf('roulette-screen', layer);
    const spin = view.indexOf('quiz-screen quiz-spin', layer);
    const settle = view.indexOf('quiz-settle', layer);
    const floats = view.indexOf('className="floats"', layer);
    expect(roulette).toBeGreaterThan(layer);
    expect(spin).toBeGreaterThan(roulette);
    expect(settle).toBeGreaterThan(spin);
    expect(floats).toBeGreaterThan(settle);
  });

  it('quiz の CSS 節は z-index を宣言しない(重なり順は DOM 順が決める)', () => {
    const at = css.indexOf('お題ルーレット(quiz)');
    expect(at).toBeGreaterThanOrEqual(0);
    // コメント中の「z-index:50 の中」という説明文は許す — 検査は宣言行だけ。
    expect(css.slice(at)).not.toMatch(/^\s*z-index\s*:/m);
  });

  it('バナー色クラス .float.banner-quiz が定義されている', () => {
    expect(css).toContain('.float.banner-quiz {');
  });

  it('窓・投票のオーバーレイは reduced-motion でも消さない(状態の説明であって演出ではない)', () => {
    const at = css.indexOf('お題ルーレット(quiz)');
    const media = css.indexOf('@media (prefers-reduced-motion: reduce)', at);
    expect(media).toBeGreaterThan(at);
    const body = css.slice(media);
    // display:none で消すのは前置きと発表だけ。
    expect(body).toContain('.quiz-screen,');
    expect(body).toContain('.quiz-settle {');
    expect(body).not.toContain('.quiz-window-overlay {\n    display: none');
    expect(body).not.toContain('.quiz-vote-overlay {\n    display: none');
  });
});

describe('前置きのタイマー予約(オフセットの基準を取り違えない)', () => {
  it('回転コマは**コールバック相対**で予約する — realIntroMs を足すと二重に遅延する', () => {
    // push(realIntroMs, () => { … push(?, …) }) の内側は既に realIntroMs 後に
    // 走っているので、そこで realIntroMs を足すと発火が realIntroMs*2 + t.atMs に
    // なり、同期予約の決定表示(realIntroMs + QUIZ_SPIN_MS)に追い越されて
    // 回転が最後まで見えない(導入クリップを設定したときだけ顕在化する)。
    const at = view.indexOf('function startQuizFx(');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, view.indexOf('function finishQuizIntro(', at));
    expect(body).toContain('for (const t of ticks) {\n        push(t.atMs, () => {');
    expect(body).not.toContain('push(realIntroMs + t.atMs');
  });

  it('決定表示と前置き終了は**同期スコープ**なので絶対オフセットのまま', () => {
    const at = view.indexOf('function startQuizFx(');
    const body = view.slice(at, view.indexOf('function finishQuizIntro(', at));
    expect(body).toContain('push(realIntroMs + QUIZ_SPIN_MS, () => {');
    expect(body).toContain('push(totalMs, () => finishQuizIntro());');
  });
});

describe('▶テスト実演(フル尺プレビュー)の配線', () => {
  it('前置きを再生できなかった実演は worker の窓も畳む(孤児 HUD を作らない)', () => {
    // 実演窓は worker 側で先に開いているので、モニターがスキップしたら
    // 「導入は出ていないのに走行 HUD だけ 60 秒出ている」状態が残る。
    const at = view.indexOf("case 'quiz-start': {");
    const body = view.slice(at, view.indexOf("case 'quiz-end': {", at));
    expect(body).toContain('stopTestPreview()');
    expect(view).toContain("rpc('challenge.testEffect', { kind: 'stopTest' })");
  });

  it('窓オープンの告知バナーは実演でも出す(実演でも本当に窓が開くため)', () => {
    for (const fn of ['function finishRevolutionIntro(', 'function finishQuizIntro(']) {
      const at = view.indexOf(fn);
      expect(at).toBeGreaterThanOrEqual(0);
      const body = view.slice(at, at + 1200);
      expect(body).not.toContain('e.test !== true');
    }
  });
});

/**
 * 区間別BGM(2026-08-22)の配線。ここが崩れると「曲が途中で死ぬ」「切り替わらない」
 * という、テストでは緑のまま本番でだけ分かる壊れ方をする。
 */
describe('区間別BGM と終了後BGM の配線', () => {
  it('★BGM の effect は2本に割れている(切替 effect に cleanup を書かない)', () => {
    // 1本にまとめて deps を quizBgmPhase にすると、区間が変わるたびに cleanup が
    // 走って曲が殺される(= 発表の瞬間に無音になる)。
    const at = view.indexOf('const quizBgmPhase: QuizBgmPhase | null');
    expect(at, 'フェーズ導出が無い').toBeGreaterThanOrEqual(0);
    const swap = view.slice(at, view.indexOf('}, [quizBgmPhase]);', at));
    expect(swap).toContain('switchQuizBgm(pick.id, pick.volume);');
    // 切替 effect は cleanup を返さない。
    expect(swap).not.toContain('return () =>');
    // 後片付けは quizActive の effect が持つ。
    const tear = view.indexOf('}, [quizActive]);', view.indexOf('quizBgm.current?.stop(600);'));
    expect(tear).toBeGreaterThanOrEqual(0);
  });

  it("フェーズ導出の catch-all は 'spin'(無音の穴を作らない)", () => {
    const at = view.indexOf('const quizBgmPhase: QuizBgmPhase | null');
    const body = view.slice(at, view.indexOf('useEffect', at));
    // 前置きの段が最優先・窓/投票は絶対時刻・残り全部は先頭区間。
    expect(body).toContain("? 'prep'");
    expect(body).toContain("? 'reveal'");
    expect(body).toContain("? 'vote'");
    expect(body).toContain("? 'window'");
    // 'spin' は**最後の枝**(: の側)= どの条件にも当たらなかったときの受け皿。
    const spinAt = body.indexOf(": 'spin';");
    expect(spinAt, "catch-all が 'spin' でない").toBeGreaterThanOrEqual(0);
    for (const p of ["? 'prep'", "? 'reveal'", "? 'vote'", "? 'window'"]) {
      expect(body.indexOf(p), p + ' が catch-all より後ろにある').toBeLessThan(spinAt);
    }
  });

  it('同じ曲が続く区間は鳴らし直さず音量だけ寄せる(頭出しに戻さない)', () => {
    const at = view.indexOf('function switchQuizBgm(');
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, view.indexOf('function stopQuizOutroBgm(', at));
    expect(body).toContain('quizBgm.current.setVolume(volume);');
    expect(body).toContain('QUIZ_BGM_XFADE_MS');
  });

  it("★終了後BGM の起点は quiz-end の**先頭**(投票締切の瞬間)", () => {
    const at = view.indexOf("case 'quiz-end': {");
    expect(at).toBeGreaterThanOrEqual(0);
    const body = view.slice(at, at + 900);
    expect(body).toContain('startQuizOutroBgm(e.amount);');
    // 早期 return(プレーン・持ち越し)より前に置く — どの経路でも必ず鳴らす。
    expect(body.indexOf('startQuizOutroBgm(e.amount);')).toBeLessThan(body.indexOf('return;'));
  });

  it('終了後BGM は quizActive の後片付けの管轄外(締切をまたいで生きる)', () => {
    const at = view.indexOf('function startQuizOutroBgm(');
    const body = view.slice(at, view.indexOf('function clearQuizTimers(', at));
    // 'keep' は鳴らし直さず所有権を移す — これが無いと cleanup に巻き込まれて死ぬ。
    expect(body).toContain('quizOutroBgm.current = quizBgm.current;');
    expect(body).toContain('quizBgm.current = null;');
    // 停止経路が全部そろっているか(reset/停止・worker 再起動・アンマウント)。
    expect(view).toContain('stopQuizOutroBgm(0);');
    const abort = view.indexOf('function abortQuizResultFx(');
    expect(view.slice(abort, abort + 500)).toContain('stopQuizOutroBgm(0);');
  });

  it('お題発表準備の段は前置きの中(絶対オフセット・尺 0 なら出さない)', () => {
    const at = view.indexOf('function startQuizFx(');
    const body = view.slice(at, view.indexOf('function finishQuizIntro(', at));
    // 回転コマだけがコールバック相対。準備段は同期スコープなので絶対オフセット。
    expect(body).toContain('push(realIntroMs + QUIZ_SPIN_MS + QUIZ_REVEAL_MS, () => {');
    expect(body).toContain('if (prepMs > 0) {');
    // 前置きの後片付けで必ず畳む(孤児の準備画面を残さない)。
    for (const fn of ['function finishQuizIntro(', 'function abortQuizFx(']) {
      const f = view.indexOf(fn);
      expect(view.slice(f, f + 900)).toContain('setQuizPrep(null);');
    }
  });

  it('準備画面は quiz-screen の一員(z-index を持たない)', () => {
    expect(view).toContain('className="quiz-screen quiz-prep"');
    const at = css.indexOf('.quiz-screen.quiz-prep');
    expect(at, '.quiz-prep の CSS が無い').toBeGreaterThanOrEqual(0);
    // 恒久ルール: 重なりは DOM 順が権威。z-index を書くと fx-backdrop.spec も落ちる。
    expect(css.slice(at, at + 800)).not.toContain('z-index');
  });
});
