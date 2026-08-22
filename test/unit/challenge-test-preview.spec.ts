/**
 * ▶テスト実演(フル尺プレビュー)の契約。
 *
 * 2026-08-21 ユーザー報告「お題ルーレット・革命をテスト再生しても最後まで見れない」
 * への答え。従来は前置き(革命13秒 / お題8.5秒)だけを流して終わり、走行 HUD も
 * 結果カットシーンも**一度も確認できなかった** — testEffect が「値・統計・状態に
 * 触れない」契約から窓のラッチを作らず、本編の表示は ChallengeState.quiz /
 * .revolution の state 駆動だったため。
 *
 * 解は tapBoost の実演の型をそのまま横展開したもの:
 *   worker が「実演専用の窓」を持ち、get() が**実発動と同じ DTO キーへ合流**させる。
 *   だからモニターの表示コードは実発動と実演を区別しなくてよい。
 *
 * ★このファイルが凍結する最大の不変条件は **「2Hz tick 無しで完走する」**。
 * session.startTimers() は接続とリプレイでしか呼ばれないので、ライブ未接続の
 * 実演モードでは drainIfChanged() が一度も回らない。満了の唯一の出口は
 * armFreezeTimer で、そこを落とすと窓が永久に閉じず結果カットシーンも来ない
 * (フィーバーの結果カットシーンが出なかった過去のバグと同じ罠)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_QUIZ,
  DEFAULT_QUIZ_RULE,
  DEFAULT_REVOLUTION,
  DEFAULT_REVOLUTION_RULE,
  QUIZ_RESULT_MS,
  QUIZ_INTRO_MS,
  QUIZ_REVEAL_MS,
  QUIZ_SPIN_MS,
  REVOLUTION_COUNT_MS,
  REVOLUTION_INTRO_MS,
} from '@shared/challenge';
import { REVOLUTION_RESULT_MS } from '@shared/revolution-settle';
import type { ChallengeConfig } from '@shared/dto';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const REV_SEC = 60;
const QUIZ_SEC = 60;
const VOTE_SEC = 30;
/** お題発表準備(2026-08-22)。発表と制限時間の間に挟まる仕度時間。 */
const PREP_SEC = 5;
/** 革命の前置き(導入 + 5..1)。 */
const REV_PRE = REVOLUTION_INTRO_MS + REVOLUTION_COUNT_MS;
/**
 * お題の前置き(導入クリップ + 回転 + 決定 + **お題発表準備**)。
 * 既定の introClip は専用素材。準備区間ぶんを落とすと窓の頭が 5 秒ズレる。
 */
const QUIZ_PRE = QUIZ_INTRO_MS + QUIZ_SPIN_MS + QUIZ_REVEAL_MS + PREP_SEC * 1000;

afterEach(() => {
  vi.useRealTimers();
});

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 他機能の凍結・一致が混ざらないように落とす(他の spec と同じ決定性の作法)。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.roulettes = [];
  base.finalGate.enabled = false;
  base.revolution = {
    ...structuredClone(DEFAULT_REVOLUTION),
    enabled: true,
    rules: [{ ...structuredClone(DEFAULT_REVOLUTION_RULE), durationSec: REV_SEC, multiplier: 3 }],
  };
  base.quiz = {
    ...structuredClone(DEFAULT_QUIZ),
    enabled: true,
    rules: [{ ...structuredClone(DEFAULT_QUIZ_RULE), giftId: '777' }],
    prompts: ['ものまね', '歌う'],
    durationSec: QUIZ_SEC,
    voteSec: VOTE_SEC,
    prepSec: PREP_SEC,
  };
  return { ...base, enabled: true, initialValue: 1000, pressStep: 1, ...over };
}

/**
 * 注入時計 + **fake timers** のエンジン。`advance` は注入時計と setTimeout を
 * 同じ歩幅で進めるので、armFreezeTimer の発火が実時間を待たずに再現できる。
 * **drainIfChanged は一切呼ばない** — それがこのファイルの主題。
 */
function previewEngine(c: ChallengeConfig = cfg()): {
  e: ChallengeEngine;
  advance: (ms: number) => void;
  now: () => number;
} {
  vi.useFakeTimers();
  let t = NOW;
  const e = new ChallengeEngine(
    () => c,
    () => t,
    () => 0,
    () => 0
  );
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return {
    e,
    advance: (ms: number) => {
      // 250ms 刻みで進める — 途中で張り直されるタイマー(お題のダミー票)も拾う。
      for (let left = ms; left > 0; ) {
        const d = Math.min(250, left);
        t += d;
        vi.advanceTimersByTime(d);
        left -= d;
      }
    },
    now: () => t,
  };
}

describe('▶テスト実演(革命)— 前置き → 窓 → 結果カットシーンまで通しで流れる', () => {
  it('実演窓が revolution キーへ合流する(モニターの走行 HUD がそのまま動く)', () => {
    const { e, now } = previewEngine();
    e.testEffect({ kind: 'revolution' });
    const s = e.get();
    expect(s.revolution).toBeDefined();
    // 窓は前置きぶん先に開く(startsAtMs が未来 = まだ導入中、と受け手が判別できる)。
    expect(s.revolution!.startsAtMs).toBe(now() + REV_PRE);
    expect(s.revolution!.endsAtMs).toBe(now() + REV_PRE + REV_SEC * 1000);
    expect(s.revolution!.multiplier).toBe(3);
    expect(s.revolution!.test).toBe(true);
  });

  it('窓中のタップは×倍率で数えるが、値と統計は動かさない(実演の契約)', () => {
    const { e, advance } = previewEngine();
    e.testEffect({ kind: 'revolution' });
    const before = e.get().value;
    // 前置き中の押下は素通し(まだ窓ではない)。
    advance(REV_PRE + 1000);
    e.press();
    e.press();
    advance(REV_SEC * 1000 - 1000 + REVOLUTION_RESULT_MS);
    const end = e.get().recentEffects.find((x) => x.kind === 'revolution-end');
    expect(end).toBeDefined();
    expect(end!.test).toBe(true);
    expect(end!.revolutionTapCount).toBe(2);
    expect(end!.revolutionDownTotal).toBe(2 * 3); // pressStep 1 × 倍率 3
    expect(end!.amount).toBe(0); // 窓中に即時反映済みという本番の規約と同じ
    expect(e.get().value).toBe(before);
    expect(e.get().stats.presses).toBe(0);
  });

  it('★2Hz tick を一度も回さずに結果カットシーンへ到達する(armFreezeTimer が唯一の出口)', () => {
    const { e, advance } = previewEngine();
    e.testEffect({ kind: 'revolution' });
    advance(REV_PRE + REV_SEC * 1000 + 1000);
    const end = e.get().recentEffects.find((x) => x.kind === 'revolution-end');
    expect(end).toBeDefined();
    // タップ 0 でも結果カットシーンは焼く(プレビューの目的は段を見ること)。
    expect(end!.revolutionResultMs).toBe(REVOLUTION_RESULT_MS);
    expect(end!.revolutionDownTotal).toBe(0);
    // 窓は畳まれてキーごと消える。
    expect(e.get().revolution).toBeUndefined();
  });

  it('stopTest で窓が即座に消える(モニターは revActive の false 遷移で片付ける)', () => {
    const { e, advance } = previewEngine();
    e.testEffect({ kind: 'revolution' });
    advance(REV_PRE + 5000);
    expect(e.get().revolution).toBeDefined();
    e.testEffect({ kind: 'stopTest' });
    expect(e.get().revolution).toBeUndefined();
    // 中断は締めくくりを出さない(見るのをやめた人に結果は要らない)。
    advance(REV_SEC * 1000);
    expect(e.get().recentEffects.some((x) => x.kind === 'revolution-end')).toBe(false);
  });
});

describe('▶テスト実演(お題)— 挑戦 → 投票(ダミー票)→ 結果発表まで通しで流れる', () => {
  it('実演窓が quiz キーへ合流する。**armed は立てない**(本物の cue を撃たせない)', () => {
    const { e, now } = previewEngine();
    e.testEffect({ kind: 'quiz' });
    const q = e.get().quiz;
    expect(q).toBeDefined();
    expect(q!.armed).toBeUndefined();
    expect(q!.test).toBe(true);
    expect(q!.startsAtMs).toBe(now() + QUIZ_PRE);
    expect(q!.windowEndsAtMs).toBe(now() + QUIZ_PRE + QUIZ_SEC * 1000);
    expect(q!.voteEndsAtMs).toBe(now() + QUIZ_PRE + (QUIZ_SEC + VOTE_SEC) * 1000);
  });

  it('窓・投票中のタップは破棄して blocked を増やす(本番と同じ手応え)', () => {
    const { e, advance } = previewEngine();
    e.testEffect({ kind: 'quiz' });
    const before = e.get().value;
    advance(QUIZ_PRE + 1000);
    e.press();
    e.press();
    e.press();
    expect(e.get().quiz!.blocked).toBe(3);
    expect(e.get().value).toBe(before);
  });

  it('ダミー票は投票タイムのあいだに増えていき、必ず決着する(引き分けを作らない)', () => {
    const { e, advance } = previewEngine();
    e.testEffect({ kind: 'quiz' });
    advance(QUIZ_PRE + QUIZ_SEC * 1000 + 100);
    // 投票タイムの入り口ではまだ 0 票。
    expect(e.get().quiz!.good + e.get().quiz!.bad).toBe(0);
    advance((VOTE_SEC * 1000) / 2);
    const mid = e.get().quiz!;
    expect(mid.good + mid.bad).toBeGreaterThan(0);
    advance(VOTE_SEC * 1000);
    const end = e.get().recentEffects.find((x) => x.kind === 'quiz-end');
    expect(end).toBeDefined();
    expect(end!.quizGood).not.toBe(end!.quizBad);
  });

  it('★2Hz tick 無しで結果発表まで到達し、±N は表示だけで値は動かさない', () => {
    const { e, advance } = previewEngine();
    const before = e.get().value;
    e.testEffect({ kind: 'quiz' });
    advance(QUIZ_PRE + (QUIZ_SEC + VOTE_SEC) * 1000 + 1000);
    const end = e.get().recentEffects.find((x) => x.kind === 'quiz-end')!;
    expect(end.test).toBe(true);
    expect(end.quizResultMs).toBe(QUIZ_RESULT_MS);
    // 判定は good/bad と一致し、額は設定値そのまま(実演はクランプを通さない)。
    const amount = DEFAULT_QUIZ.amount;
    expect(end.amount).toBe(end.quizGood! > end.quizBad! ? -amount : amount);
    expect(e.get().value).toBe(before);
    expect(e.get().stats.quizDown).toBe(0);
    expect(e.get().stats.quizUp).toBe(0);
    expect(e.get().quiz).toBeUndefined();
  });

  it('stopTest で窓が即座に消え、結果発表も出ない', () => {
    const { e, advance } = previewEngine();
    e.testEffect({ kind: 'quiz' });
    advance(QUIZ_PRE + 2000);
    e.testEffect({ kind: 'stopTest' });
    expect(e.get().quiz).toBeUndefined();
    advance((QUIZ_SEC + VOTE_SEC) * 1000);
    expect(e.get().recentEffects.some((x) => x.kind === 'quiz-end')).toBe(false);
  });
});

describe('実演どうし・実発動との排他', () => {
  it('実演が走っている間は別の実演を重ねない(get のキー合流が曖昧にならない)', () => {
    const { e, advance } = previewEngine();
    e.testEffect({ kind: 'revolution' });
    advance(REV_PRE + 1000);
    e.testEffect({ kind: 'quiz' });
    // 革命の窓が生きているので、お題は前置きの effect だけで窓は開かない。
    expect(e.get().revolution).toBeDefined();
    expect(e.get().quiz).toBeUndefined();
  });

  it('実発動(革命の窓)が生きている間は実演窓を作らない — 実タップを吸わない', () => {
    const c = cfg();
    const { e, advance } = previewEngine(c);
    e.start();
    e.handleEvent({
      kind: 'gift',
      msgId: 'g1',
      tsMs: NOW,
      tsSource: 'server',
      seq: 1,
      viewer: { userId: 'u1', nickname: 'n' },
      giftId: c.revolution.rules[0]!.giftId,
      giftName: c.revolution.rules[0]!.giftName,
      repeatCount: 1,
      diamondEach: 699,
      diamonds: 699,
      isBoxGift: false,
    });
    const armed = e.get().recentEffects[0]!;
    expect(armed.kind).toBe('revolution-start');
    e.revolutionCue({ action: 'start', effectId: armed.id, startedAtMs: NOW, preMs: REV_PRE });
    advance(REV_PRE + 1000);
    const realStarts = e.get().revolution!.startsAtMs;
    // 実発動中に実演を撃っても窓は乗っ取られない。
    e.testEffect({ kind: 'revolution' });
    expect(e.get().revolution!.startsAtMs).toBe(realStarts);
    expect(e.get().revolution!.test).toBeUndefined();
  });

  it('previewMs は「見終わるまで」の尺(結果カットシーン込み)を返す', () => {
    const { e } = previewEngine();
    const r = e.testEffect({ kind: 'revolution' });
    expect(r.cinematic).toBe(true);
    expect(r.previewMs).toBe(REV_PRE + REV_SEC * 1000 + REVOLUTION_RESULT_MS);
    e.testEffect({ kind: 'stopTest' });
    const q = e.testEffect({ kind: 'quiz' });
    expect(q.previewMs).toBe(QUIZ_PRE + (QUIZ_SEC + VOTE_SEC) * 1000 + QUIZ_RESULT_MS);
  });

  it('stopTest は effect を積まない(「止めました」の演出は要らない)', () => {
    const { e } = previewEngine();
    e.testEffect({ kind: 'revolution' });
    const n = e.get().recentEffects.length;
    e.testEffect({ kind: 'stopTest' });
    expect(e.get().recentEffects.length).toBe(n);
  });
});
