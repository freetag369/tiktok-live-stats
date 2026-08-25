import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_COMMENT_HELPER,
  DEFAULT_FAN_STAMP,
  DEFAULT_QUIZ,
  DEFAULT_QUIZ_RULE,
  QUIZ_INTRO_MS,
  QUIZ_RESULT_MS,
  QUIZ_REVEAL_MS,
  QUIZ_SPIN_MS,
  validateChallengeConfig,
} from '@shared/challenge';
import { FAN_STAMP_FX_WINDOW_MS } from '@shared/fan-stamp';
import type { ChallengeConfig, ChallengeEffect } from '@shared/dto';
import type { CommentEvent, EmoteEvent, GiftEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * コメントお助けのテスト。旧チャットスタンプ(サブスクエモート)トリガー
 * (challenge-stamp-trigger.spec.ts)の置き換え(2026-08-25)。
 *
 * 固定する契約:
 *  - **すべての chat コメント**(スタンプのみの content=' ' も)が対象で、
 *    1コメント=1回だけ amountEach 動く(スタンプの個数は見ない)
 *  - 先勝ち: クイズ投票として成立したコメント・妨害キーワード一致のコメントは対象外
 *  - 連投対策なし(毎回)・二重適用防止は msgId dedup のみ・質問(isQuestion)は対象外
 *  - 演出はお助け(fanStamp)のバナー・合算窓を丸ごと流用
 *  - 旧 stampTriggers キーは validateChallengeConfig が黙って落とす(残留キーの無害性)
 * ヘルパーの形は challenge-fan-stamp-merge.spec.ts に合わせてある。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const V0 = DEFAULT_CHALLENGE.initialValue;

let seq = 0;

function comment(over: Partial<CommentEvent> = {}): CommentEvent {
  seq += 1;
  return {
    kind: 'comment',
    msgId: `c${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'u1', nickname: 'こめんたー' },
    content: 'がんばれ!',
    isQuestion: false,
    ...over,
  };
}

function emote(over: Partial<EmoteEvent> = {}): EmoteEvent {
  seq += 1;
  return {
    kind: 'emote',
    msgId: `e${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'u1', nickname: 'こめんたー' },
    emoteId: '7671092908083137301',
    emoteIds: ['7671092908083137301'],
    ...over,
  };
}

/** ファンスタンプ想定のギフト(混在合算テスト用 — fan-stamp-merge.spec と同じ形)。 */
function fanStampGift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `g${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'g1', nickname: 'gifter' },
    giftId: '76637',
    giftName: 'おやすみトッポ',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

function chCfg(
  ch: Partial<ChallengeConfig['commentHelper']> = {},
  c: Partial<ChallengeConfig> = {}
): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定のカットイン系がバラ等に一致して凍結を張るのを避ける(fan-stamp-merge と同じ)。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  return {
    ...base,
    enabled: true,
    commentHelper: { ...DEFAULT_COMMENT_HELPER, ...ch },
    ...c,
  };
}

function engineAt(c: ChallengeConfig, clock: { t: number }): ChallengeEngine {
  const e = new ChallengeEngine(
    () => c,
    () => clock.t,
    Math.random,
    Math.random,
    () => undefined
  );
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

/** gift 種(コメントお助けは fanStamp バナー = kind 'gift')だけを古い順に。 */
function gifts(e: ChallengeEngine): ChallengeEffect[] {
  return e
    .get()
    .recentEffects.filter((x) => x.kind === 'gift')
    .reverse();
}

describe('validateCommentHelper(validateChallengeConfig 経由)', () => {
  it('キー欠損は既定(オン・-1・flash)へ — 旧 settings.json にはこの欠損フォールバックが移行を兼ねる', () => {
    const c = validateChallengeConfig({});
    expect(c.commentHelper).toEqual(DEFAULT_COMMENT_HELPER);
    // 両辺が一緒に動くトートロジーにしないため、実数でも留める(出荷挙動の固定)。
    expect(c.commentHelper.enabled).toBe(true);
    expect(c.commentHelper.amountEach).toBe(-1);
    expect(c.commentHelper.flash).toBe(true);
  });

  it('明示的な false は尊重し、量は丸めて clamp・型崩れは既定へ', () => {
    const c = validateChallengeConfig({
      commentHelper: { enabled: false, amountEach: -1.6, flash: false },
    });
    expect(c.commentHelper).toEqual({ enabled: false, amountEach: -2, flash: false });
    expect(
      validateChallengeConfig({ commentHelper: { amountEach: 9_999_999 } }).commentHelper.amountEach
    ).toBe(999_999);
    expect(
      validateChallengeConfig({ commentHelper: { amountEach: 'x' } }).commentHelper.amountEach
    ).toBe(-1);
    expect(validateChallengeConfig({ commentHelper: 'x' }).commentHelper).toEqual(
      DEFAULT_COMMENT_HELPER
    );
  });

  it('旧 stampTriggers キーは黙って落とす(保存済み settings.json の残留キーの無害性)', () => {
    const v = validateChallengeConfig({
      stampTriggers: { enabled: true, flash: true, rules: [{ id: 'a', emoteId: '1', amountEach: -1 }] },
    }) as unknown as Record<string, unknown>;
    expect('stampTriggers' in v).toBe(false);
  });
});

describe('コメントお助け — エンジン適用', () => {
  it('文字コメントでお助けバナー(fanStamp effect)が出て 1回ぶん動く', () => {
    const clock = { t: NOW };
    const e = engineAt(chCfg({ amountEach: -3 }), clock);
    e.start();
    e.handleEvent(comment());
    expect(e.get().value).toBe(V0 - 3);
    expect(e.get().stats.giftDown).toBe(3); // 統計はお助けと同じ枠(giftDown)
    const fx = gifts(e);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.fanStamp).toBe(true);
    expect(fx[0]!.amount).toBe(-3);
    expect(fx[0]!.nickname).toBe('こめんたー');
    // ×N は載せない(1コメント=1回なので個数の概念が無い)。
    expect(fx[0]!.giftCount).toBeUndefined();
  });

  it('スタンプだけのコメント(emoteIds 3件)でも 1回 — 個数は見ない', () => {
    const clock = { t: NOW };
    const e = engineAt(chCfg(), clock);
    e.start();
    e.handleEvent(
      comment({
        content: ' ',
        emoteIds: ['7671092908083137301', '7671092908083137301', '7671092908083170069'],
      })
    );
    expect(e.get().value).toBe(V0 - 1);
    expect(gifts(e)[0]!.giftCount).toBeUndefined();
  });

  it('同じ人の連投は毎回数える(連投対策なし)。同じ msgId の再配信は1回だけ', () => {
    const clock = { t: NOW };
    const e = engineAt(chCfg(), clock);
    e.start();
    e.handleEvent(comment());
    e.handleEvent(comment());
    e.handleEvent(comment());
    expect(e.get().value).toBe(V0 - 3);
    const c1 = comment();
    e.handleEvent(c1);
    e.handleEvent(c1); // 再接続バックログの再配信
    expect(e.get().value).toBe(V0 - 4);
  });

  it('質問(isQuestion・questionNew 由来)は対象外', () => {
    const clock = { t: NOW };
    const e = engineAt(chCfg(), clock);
    e.start();
    expect(e.handleEvent(comment({ isQuestion: true }))).toBe(false);
    expect(e.get().value).toBe(V0);
    expect(gifts(e)).toHaveLength(0);
  });

  it('emote 単独メッセージ(WebcastEmoteChatMessage)も1行=1回。emoteIds 2件でも1回', () => {
    const clock = { t: NOW };
    const e = engineAt(chCfg({ amountEach: -2 }), clock);
    e.start();
    e.handleEvent(emote({ emoteIds: ['7671092908083137301', '7671092908083170069'] }));
    expect(e.get().value).toBe(V0 - 2);
    expect(gifts(e)[0]!.fanStamp).toBe(true);
    // msgId 再配信は1回だけ(comment と同じ dedup)。
    const e1 = emote();
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS + 1;
    e.handleEvent(e1);
    e.handleEvent(e1);
    expect(e.get().value).toBe(V0 - 4);
  });

  it('妨害キーワード一致は妨害だけ(+N)— お助けは併発しない。不一致は 1回動く', () => {
    const clock = { t: NOW };
    const cfg = chCfg({}, { commentRules: [{ id: 'k1', keyword: 'あ', amount: 100 }] });
    const e = engineAt(cfg, clock);
    e.start();
    e.handleEvent(comment({ content: 'あいうえお' }));
    expect(e.get().value).toBe(V0 + 100); // -1 は乗らない
    expect(e.get().stats.giftDown).toBe(0);
    e.handleEvent(comment({ content: 'いえーい' }));
    expect(e.get().value).toBe(V0 + 100 - 1);
  });

  it('機能オフなら素通り(値不変・妨害の評価には従来どおり進む)', () => {
    const clock = { t: NOW };
    const cfg = chCfg({ enabled: false }, { commentRules: [{ id: 'k1', keyword: 'あ', amount: 100 }] });
    const e = engineAt(cfg, clock);
    e.start();
    expect(e.handleEvent(comment({ content: 'いえーい' }))).toBe(false);
    expect(e.get().value).toBe(V0);
    e.handleEvent(comment({ content: 'あ' }));
    expect(e.get().value).toBe(V0 + 100);
  });

  it('量 0 は演出だけ出して値を動かさない', () => {
    const clock = { t: NOW };
    const e = engineAt(chCfg({ amountEach: 0 }), clock);
    e.start();
    e.handleEvent(comment());
    expect(e.get().value).toBe(V0);
    expect(gifts(e)).toHaveLength(1);
    expect(gifts(e)[0]!.amount).toBe(0);
  });

  it('残量クランプ+0到達 — バナーが CLEAR(achieved)より先(effect id 順)', () => {
    const clock = { t: NOW };
    const e = engineAt(chCfg({ amountEach: -5 }, { initialValue: 3 }), clock);
    e.start();
    e.handleEvent(comment());
    const s = e.get();
    expect(s.value).toBe(0);
    expect(s.stats.giftDown).toBe(3); // 実減少量規約(名目 -5 ではない)
    const byId = [...s.recentEffects].sort((a, b) => a.id - b.id);
    const banner = byId.find((x) => x.kind === 'gift')!;
    const achieved = byId.find((x) => x.kind === 'achieved');
    expect(banner.amount).toBe(-3);
    expect(achieved).toBeDefined();
    expect(banner.id).toBeLessThan(achieved!.id);
  });

  it('お助けの合算窓を共有する — 窓内の2通目はバナーにならず値だけ動く', () => {
    const clock = { t: NOW };
    const e = engineAt(chCfg(), clock);
    e.start();
    e.handleEvent(comment({ viewer: { userId: 'a', nickname: 'A' } }));
    clock.t = NOW + 200;
    e.handleEvent(comment({ viewer: { userId: 'b', nickname: 'B' } }));
    expect(e.get().value).toBe(V0 - 2);
    expect(gifts(e)).toHaveLength(1); // 先頭の1枚だけ
    // 窓が明けたら尻が1枚(合算)。
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS;
    e.drainIfChanged();
    const fx = gifts(e);
    expect(fx).toHaveLength(2);
    expect(fx[1]!.amount).toBe(-1);
  });

  it('ギフト型お助け(fanStamp)と同じ窓で混在合算される', () => {
    const clock = { t: NOW };
    const cfg = chCfg({}, { fanStamp: { ...structuredClone(DEFAULT_FAN_STAMP), giftId: '76637' } });
    const e = engineAt(cfg, clock);
    e.start();
    e.handleEvent(comment()); // 先頭 = コメント(即時バナー)
    clock.t = NOW + 300;
    e.handleEvent(fanStampGift()); // 窓内のギフト型 → 合算へ
    expect(e.get().value).toBe(V0 - 2);
    expect(gifts(e)).toHaveLength(1);
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS + 300;
    e.drainIfChanged();
    const fx = gifts(e);
    expect(fx).toHaveLength(2);
    expect(fx[1]!.fanStamp).toBe(true);
    expect(fx[1]!.amount).toBe(-1); // 窓内に畳んだのはギフト型の1件ぶん
  });

  it('素の既定(enabled にしただけ)でコメントが -1 動く — 出荷挙動の固定', () => {
    const clock = { t: NOW };
    const base = structuredClone(DEFAULT_CHALLENGE);
    const e = engineAt({ ...base, enabled: true }, clock);
    e.start();
    e.handleEvent(comment());
    expect(e.get().value).toBe(V0 - 1);
  });
});

describe('コメントお助け — クイズ投票との先勝ち', () => {
  /** quiz を有効化した設定(challenge-quiz.spec.ts の cfg() と同じ形)。 */
  function quizCfg(): ChallengeConfig {
    const base = chCfg();
    base.roulettes = [];
    base.finalGate.enabled = false;
    base.quiz = {
      ...structuredClone(DEFAULT_QUIZ),
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_QUIZ_RULE), giftId: '777' }],
      prompts: ['ものまね'],
    };
    return base;
  }

  function quizEngine(): { e: ChallengeEngine; tick: (ms: number) => void; now: () => number } {
    let t = NOW;
    const e = new ChallengeEngine(
      () => quizCfg(),
      () => t,
      () => 0,
      () => 0
    );
    e.setMonitorOpen(true);
    e.setFxCaps(true);
    return { e, tick: (ms) => { t += ms; }, now: () => t };
  }

  const PRE_MS = QUIZ_INTRO_MS + QUIZ_SPIN_MS + QUIZ_REVEAL_MS + DEFAULT_QUIZ.prepSec * 1000;

  function armAndCommit(e: ChallengeEngine, now: () => number): void {
    e.handleEvent(fanStampGift({ giftId: '777', giftName: 'Quiz Gift', diamonds: 30, diamondEach: 30 }));
    const s = e.get();
    expect(s.quiz?.armed).toBe(true);
    const startId = s.recentEffects[0]!.id;
    expect(e.quizCue({ action: 'start', effectId: startId, startedAtMs: now(), preMs: PRE_MS })).toBe(true);
  }

  it('投票として成立したコメントは減算しない(票としてだけ数える)', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    armAndCommit(e, now);
    tick(PRE_MS + DEFAULT_QUIZ.durationSec * 1000 + 1000); // 投票タイム
    e.handleEvent(comment({ content: 'よかった' }));
    expect(e.get().quiz!.good).toBe(1);
    // 清算まで進めても、お助けの統計(giftDown)は 1 も増えていない —
    // 値の変化はクイズの ±amount だけ(クランプ済み)。
    tick((DEFAULT_QUIZ.voteSec + 30) * 1000);
    e.drainIfChanged();
    tick(QUIZ_RESULT_MS + 1000);
    e.drainIfChanged();
    expect(e.get().stats.giftDown).toBe(0);
    expect(e.get().stats.quizDown).toBeGreaterThan(0);
  });

  it('無効票(good+bad 両方一致)は通常経路へ落ち、清算後に 1回ぶん適用される', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    armAndCommit(e, now);
    tick(PRE_MS + DEFAULT_QUIZ.durationSec * 1000 + 1000);
    e.handleEvent(comment({ content: 'よかったけどだめ' })); // 無効票 → お助けへ(バリアで後回し)
    expect(e.get().quiz!.good).toBe(0);
    expect(e.get().quiz!.bad).toBe(0);
    tick((DEFAULT_QUIZ.voteSec + 30) * 1000);
    e.drainIfChanged(); // settle(無投票 ±0)+ deferred を pendingOps へ移送
    tick(QUIZ_RESULT_MS + 1000);
    e.drainIfChanged(); // 結果カットシーンの凍結明けにドレイン
    expect(e.get().value).toBe(V0 - 1);
    expect(e.get().stats.giftDown).toBe(1);
  });
});
