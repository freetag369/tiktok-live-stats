import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_QUIZ,
  DEFAULT_QUIZ_RULE,
  QUIZ_ARM_MAX_MS,
  QUIZ_INTRO_MS,
  QUIZ_INTRO_SELF,
  QUIZ_REVEAL_MS,
  QUIZ_RESULT_MS,
  QUIZ_SPIN_MS,
  judgeQuizVote,
  matchQuiz,
  migrateChallengeQuizIntro,
  validateChallengeConfig,
  validateQuiz,
} from '@shared/challenge';
import type { ChallengeConfig, QuizConfig } from '@shared/dto';
import type { CommentEvent, GiftEvent, LikeEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * お題ルーレット(quiz)のエンジン仕様の凍結。
 *
 * 骨格(2026-08-21 ユーザー決定):
 *  - バリア方式: 発動(アーム)〜清算に届いたイベントは優先度に関係なく後回し
 *  - 発動中はタップ破棄(tapLock 型)・いいね完全破棄・ギフト等は清算後にまとめて適用
 *  - 投票はカウントダウン終了後の投票タイムだけ・1人1票・最後の投票が有効
 *  - よかった多数 → 減算 / だめ多数 → 増加 / 引き分け・無投票 → ±0
 *  - フィーバー/革命と排他(終了を待って予約)・連続発動は FIFO(上限なし)
 */

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);

let seq = 0;

function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  return {
    kind: 'gift',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'g1', nickname: 'gifter' },
    giftId: '9999',
    giftName: 'Test Gift',
    repeatCount: 1,
    diamondEach: 30,
    diamonds: 30,
    isBoxGift: false,
    ...over,
  };
}

function comment(content: string, userId = 'c1', over: Partial<CommentEvent> = {}): CommentEvent {
  return {
    kind: 'comment',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: `viewer-${userId}` },
    content,
    isQuestion: false,
    ...over,
  };
}

function like(count = 10, userId = 'l1'): LikeEvent {
  return {
    kind: 'like',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: `viewer-${userId}` },
    count,
  };
}

/** quiz を有効化した設定。凍結を張る他機能は落とす(challenge.spec.ts と同じ決定性の作法)。 */
function cfg(qz: Partial<QuizConfig> = {}, over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.roulettes = [];
  base.finalGate.enabled = false;
  base.quiz = {
    ...structuredClone(DEFAULT_QUIZ),
    enabled: true,
    rules: [{ ...structuredClone(DEFAULT_QUIZ_RULE), giftId: '777' }],
    prompts: ['ものまね', '歌う'],
    ...qz,
  };
  return { ...base, enabled: true, ...over };
}

/** 注入時計つきエンジン。rand=0 で promptIndex は常に 0(「ものまね」)。 */
function quizEngine(c: ChallengeConfig = cfg()): { e: ChallengeEngine; tick: (ms: number) => void; now: () => number } {
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
    tick: (ms: number) => {
      t += ms;
    },
    now: () => t,
  };
}

/**
 * 既定設定でモニターが申告する前置きの総尺。
 * 導入(専用素材)+ 回転 + 決定 + **お題発表準備**(2026-08-22・既定 5 秒)。
 */
const DEFAULT_PRE_MS =
  QUIZ_INTRO_MS + QUIZ_SPIN_MS + QUIZ_REVEAL_MS + DEFAULT_QUIZ.prepSec * 1000;

/**
 * アーム → cue → コミットまで進める(シネマティック経路の共通前半)。
 * preMs は**既定の設定(導入 = 専用素材)でモニターが申告する前置き**。
 */
function armAndCommit(e: ChallengeEngine, now: () => number): { preMs: number; startId: number } {
  e.handleEvent(gift({ giftId: '777' }));
  const s = e.get();
  expect(s.quiz?.armed).toBe(true);
  const startId = s.recentEffects[0]!.id;
  const preMs = DEFAULT_PRE_MS;
  expect(e.quizCue({ action: 'start', effectId: startId, startedAtMs: now(), preMs })).toBe(true);
  return { preMs, startId };
}

describe('validateQuiz — 旧 settings.json との互換(欠損フォールバック = 移行の代わり)', () => {
  it('キー欠損は既定(enabled:false・実 giftId なし)へ倒れる — SETTINGS_VERSION を上げない根拠', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.quiz;
    const v = validateChallengeConfig(legacy);
    expect(v.quiz).toEqual(DEFAULT_QUIZ);
    expect(v.quiz.enabled).toBe(false);
    expect(v.quiz.rules[0]!.giftId).toBe('');
  });

  it('enabled は === true で読む(truthy の壊れた値で勝手に有効化しない)', () => {
    expect(validateQuiz({ ...DEFAULT_QUIZ, enabled: 'yes' }).enabled).toBe(false);
    expect(validateQuiz('x')).toEqual(DEFAULT_QUIZ);
  });

  it('お題は trim・空行除去・件数上限。明示的な空配列は空のまま(ユーザーの意思)', () => {
    const v = validateQuiz({ ...DEFAULT_QUIZ, prompts: ['  ものまね  ', '', 42, '歌'] });
    expect(v.prompts).toEqual(['ものまね', '歌']);
    expect(validateQuiz({ ...DEFAULT_QUIZ, prompts: [] }).prompts).toEqual([]);
  });

  it('秒数・増減幅は clamp、判定ワードの空文字は除去(""..includes 罠のガード)', () => {
    const v = validateQuiz({
      ...DEFAULT_QUIZ,
      durationSec: 1,
      voteSec: 9999,
      amount: 0,
      goodWords: ['', 'よき'],
      badWords: 7,
    });
    expect(v.durationSec).toBeGreaterThanOrEqual(10);
    expect(v.voteSec).toBeLessThanOrEqual(120);
    expect(v.amount).toBeGreaterThanOrEqual(1);
    expect(v.goodWords).toEqual(['よき']);
    expect(v.badWords).toEqual(DEFAULT_QUIZ.badWords);
  });

  it('bgm / introClip は未知 id を既定へ戻す', () => {
    const v = validateQuiz({ ...DEFAULT_QUIZ, bgm: 'nope', introClip: 'nope' });
    expect(v.bgm).toBe(DEFAULT_QUIZ.bgm);
    expect(v.introClip).toBe(DEFAULT_QUIZ.introClip);
    expect(DEFAULT_QUIZ.introClip).toBe(QUIZ_INTRO_SELF); // 既定は専用素材(2026-08-22)
  });

  it("introClip は 'off' / 専用素材 / 全面カットのカタログを通す", () => {
    expect(validateQuiz({ ...DEFAULT_QUIZ, introClip: 'off' }).introClip).toBe('off');
    expect(validateQuiz({ ...DEFAULT_QUIZ, introClip: QUIZ_INTRO_SELF }).introClip).toBe(QUIZ_INTRO_SELF);
    expect(validateQuiz({ ...DEFAULT_QUIZ, introClip: 'cut-rose' }).introClip).toBe('cut-rose');
  });
});

describe('migrateChallengeQuizIntro(settingsVersion 11)— 導入を専用素材へ寄せ替え', () => {
  const withIntro = (introClip: string): ChallengeConfig => cfg({ introClip });

  it("v10 以前の 'off' は一度だけ専用素材へ引き上げる", () => {
    const v = migrateChallengeQuizIntro(withIntro('off'), 10);
    expect(v.quiz.introClip).toBe(QUIZ_INTRO_SELF);
  });

  it('世代印が上がったあとは触らない(自分で off へ戻した人に再配布しない)', () => {
    const v = migrateChallengeQuizIntro(withIntro('off'), 11);
    expect(v.quiz.introClip).toBe('off');
  });

  it('cut-* を自分で指名していた人の選択は尊重する', () => {
    const v = migrateChallengeQuizIntro(withIntro('cut-rose'), 10);
    expect(v.quiz.introClip).toBe('cut-rose');
  });

  it('冪等(2回通しても増えない・他のキーを壊さない)', () => {
    const base = withIntro('off');
    const once = migrateChallengeQuizIntro(base, 10);
    const twice = migrateChallengeQuizIntro(once, 10);
    expect(twice).toEqual(once);
    expect(twice.quiz.prompts).toEqual(base.quiz.prompts);
    expect(twice.quiz.amount).toBe(base.quiz.amount);
  });
});

describe('matchQuiz / judgeQuizVote — 純関数', () => {
  it('先勝ち: 同じ giftId を革命と quiz に登録したら革命が勝つ(gift 分岐の評価順)', () => {
    // 評価順そのものは worker の分岐が持つ — ここでは「両方に一致しうる」ことだけ固定し、
    // 順序はエンジンテスト(下の排他)で担保する。
    const c = cfg();
    expect(matchQuiz(c, { giftId: '777', giftName: '' })).not.toBeNull();
    expect(matchQuiz(c, { giftId: '000', giftName: '' })).toBeNull();
    expect(matchQuiz({ ...c, quiz: { ...c.quiz, enabled: false } }, { giftId: '777', giftName: '' })).toBeNull();
  });

  it('judgeQuizVote: 部分一致・大文字小文字無視・両方一致は無効票', () => {
    const good = ['よかった', 'GOOD'];
    const bad = ['だめ'];
    expect(judgeQuizVote(good, bad, 'よかったー!')).toBe('good');
    expect(judgeQuizVote(good, bad, 'good job')).toBe('good');
    expect(judgeQuizVote(good, bad, 'これはだめだね')).toBe('bad');
    expect(judgeQuizVote(good, bad, 'よかったけどだめ')).toBeNull();
    expect(judgeQuizVote(good, bad, 'ふつう')).toBeNull();
    // 空文字ワードは何にも一致しない(validate 前の値でも自衛する)。
    expect(judgeQuizVote([''], bad, 'なんでも')).toBeNull();
  });
});

describe('アーム → cue → コミット(シネマティック)', () => {
  it('トリガーで armed になり、quiz-start effect に盤面・尺・増減幅が焼き込まれる', () => {
    const { e } = quizEngine();
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    const s = e.get();
    expect(s.quiz).toMatchObject({ armed: true, good: 0, bad: 0, blocked: 0 });
    const ef = s.recentEffects[0]!;
    expect(ef.kind).toBe('quiz-start');
    expect(ef.quizPrompts).toEqual(['ものまね', '歌う']);
    expect(ef.quizPromptIndex).toBe(0);
    expect(ef.quizPrompt).toBe('ものまね');
    expect(ef.quizDurationMs).toBe(60_000);
    expect(ef.quizVoteMs).toBe(30_000);
    expect(ef.quizAmount).toBe(5000);
    expect(ef.quizIntroMs).toBe(QUIZ_INTRO_MS); // 既定は専用素材の導入あり
    expect(ef.quizIntroClip).toBe(QUIZ_INTRO_SELF);
    // お題発表準備(既定 5 秒)も前置きの一部 — モニターが窓を開く原点になる。
    expect(ef.quizPrepMs).toBe(DEFAULT_QUIZ.prepSec * 1000);
    expect(ef.fxDurationMs).toBe(DEFAULT_PRE_MS);
    // アーム中は値が動かない(トリガーギフト自体は増減規則を通らない)。
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue);
  });

  it("introClip 'off' は導入の段ごと尺を詰める(前置きは回転 + 決定 + 準備)", () => {
    const { e } = quizEngine(cfg({ introClip: 'off' }));
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    const ef = e.get().recentEffects[0]!;
    expect(ef.quizIntroMs).toBe(0);
    expect(ef.quizIntroClip).toBeUndefined(); // 尺 0 のときは id を載せない
    expect(ef.fxDurationMs).toBe(
      QUIZ_SPIN_MS + QUIZ_REVEAL_MS + DEFAULT_QUIZ.prepSec * 1000
    );
  });

  it('prepSec 0 は準備の段ごと尺を詰める(2026-08-22 以前と同じ前置き)', () => {
    const { e } = quizEngine(cfg({ prepSec: 0 }));
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    const ef = e.get().recentEffects[0]!;
    expect(ef.quizPrepMs).toBe(0);
    expect(ef.fxDurationMs).toBe(QUIZ_INTRO_MS + QUIZ_SPIN_MS + QUIZ_REVEAL_MS);
  });

  it('prepSec は窓の頭を後ろへずらす(cue の preMs 上限も伸びる)', () => {
    const { e, now } = quizEngine(cfg({ prepSec: 20 }));
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    const startId = e.get().recentEffects[0]!.id;
    const preMs = QUIZ_INTRO_MS + QUIZ_SPIN_MS + QUIZ_REVEAL_MS + 20_000;
    expect(e.quizCue({ action: 'start', effectId: startId, startedAtMs: now(), preMs })).toBe(true);
    // 上限で切り詰められていないこと(切られると準備表示の途中で制限時間が始まる)。
    expect(e.get().quiz!.startsAtMs).toBe(now() + preMs);
  });

  it('プレーン発動(モニター不在)は準備の段も無い — quizPrepMs は 0', () => {
    const { e } = quizEngine();
    e.setMonitorOpen(false);
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    const ef = e.get().recentEffects[0]!;
    expect(ef.quizPrepMs).toBe(0);
    expect(ef.fxDurationMs).toBe(0);
  });

  it('cue で窓が開く(startsAtMs = 実再生開始 + preMs)。effectId 不一致は無視', () => {
    const { e, now } = quizEngine();
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    const startId = e.get().recentEffects[0]!.id;
    expect(e.quizCue({ action: 'start', effectId: startId + 99, startedAtMs: now(), preMs: 0 })).toBe(false);
    const preMs = QUIZ_SPIN_MS + QUIZ_REVEAL_MS;
    expect(e.quizCue({ action: 'start', effectId: startId, startedAtMs: now(), preMs })).toBe(true);
    const q = e.get().quiz!;
    expect(q.armed).toBeUndefined();
    expect(q.startsAtMs).toBe(now() + preMs);
    expect(q.windowEndsAtMs).toBe(now() + preMs + 60_000);
    expect(q.voteEndsAtMs).toBe(now() + preMs + 90_000);
    expect(q.prompt).toBe('ものまね');
  });

  it('アーム期限切れは破棄ではなく強制発動(quizEndsAtMs のタイムラインが真になる)', () => {
    const { e, tick } = quizEngine();
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    tick(QUIZ_ARM_MAX_MS + 100);
    e.drainIfChanged(); // flushFxFreeze 経由で commitArmedQuizIfExpired
    const q = e.get().quiz!;
    expect(q.armed).toBeUndefined();
    expect(q.windowEndsAtMs).toBeGreaterThan(NOW);
  });

  it('drop はプレーン即発動へ倒す(投票と±は消えない)', () => {
    const { e } = quizEngine();
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    expect(e.quizCue({ action: 'drop', effectId: 0 })).toBe(true);
    const q = e.get().quiz!;
    expect(q.armed).toBeUndefined();
    expect(q.windowEndsAtMs).toBe(NOW + 60_000);
  });

  it('モニター不在はアームせず即窓オープン(プレーン)', () => {
    const { e } = quizEngine();
    e.setMonitorOpen(false);
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    const q = e.get().quiz!;
    expect(q.armed).toBeUndefined();
    expect(q.startsAtMs).toBe(NOW);
    const ef = e.get().recentEffects[0]!;
    expect(ef.fxDurationMs).toBe(0); // モニターはバナーだけ出す
  });

  it('お題0件は不発(トリガー一致でも何も起きない)', () => {
    const { e } = quizEngine(cfg({ prompts: [] }));
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    expect(e.get().quiz).toBeUndefined();
    expect(e.get().recentEffects.length).toBe(0);
  });
});

describe('発動中の停止・破棄・バリア(2026-08-21 ユーザー決定の核)', () => {
  it('窓・投票中のタップは破棄(blocked++・値不変)。アーム中は通常どおり効く', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    e.handleEvent(gift({ giftId: '777' }));
    // アーム中(バリア消化待ち)はタップが効く — ボタンが死なない。
    e.press();
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue - 1);
    // press effect が先頭に積まれているので quiz-start は kind で探す。
    const startId = e.get().recentEffects.find((x) => x.kind === 'quiz-start')!.id;
    const preMs = QUIZ_SPIN_MS + QUIZ_REVEAL_MS;
    expect(e.quizCue({ action: 'start', effectId: startId, startedAtMs: now(), preMs })).toBe(true);
    // 前置き〜窓〜投票の全期間で破棄。
    tick(preMs + 1000);
    const before = e.get().value;
    e.press();
    e.press();
    expect(e.get().value).toBe(before);
    expect(e.get().quiz!.blocked).toBe(2);
  });

  it('いいねは完全破棄(ゲージ端数も進まない)。dedup とランキングは既存規約どおり', () => {
    const { e } = quizEngine(cfg({}, { likeEvery: 10, likeStep: 1 }));
    e.start();
    e.handleEvent(gift({ giftId: '777' })); // アーム = バリア開始
    e.handleEvent(like(10, 'l1'));
    const s = e.get();
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue);
    expect(s.likeGauge!.counter).toBe(0);
    expect(s.likeGauge!.fills).toBe(0);
  });

  it('バリア: 発動以降のギフト・コメント妨害は清算後にまとめて適用される', () => {
    const c = cfg({}, { commentRules: [{ id: 'cr1', keyword: 'おやすみ', amount: 5 }] });
    const { e, tick, now } = quizEngine(c);
    e.start();
    const { preMs } = armAndCommit(e, now);
    // 発動以降のイベントは値も演出も動かさない(優先が高くても後回し)。
    e.handleEvent(gift({ giftId: '9999', diamonds: 30, diamondEach: 30 })); // 既定 perDiamond +30
    e.handleEvent(comment('おやすみ〜'));
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue);
    // 予告は fxQueue に載る(ギフトの帯予告は無効化済みなので件数は問わないが、
    // 値が動いていないことが本体)。清算まで進める:
    tick(preMs + 90_000 + 100);
    e.drainIfChanged(); // settle(無投票 ±0)+ deferred を pendingOps へ移送
    // 結果カットシーンぶんの凍結が明けてからドレインされる。
    tick(QUIZ_RESULT_MS + 1000);
    e.drainIfChanged();
    expect(e.get().value).toBe(DEFAULT_CHALLENGE.initialValue + 30 + 5);
  });

  it('発動中の追加お題ギフトは FIFO 予約(queued)され、清算後に自動で次がアームされる', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    const { preMs } = armAndCommit(e, now);
    e.handleEvent(gift({ giftId: '777' })); // 2発目 → 予約
    e.handleEvent(gift({ giftId: '777' })); // 3発目 → 予約(上限なし)
    expect(e.get().quiz!.queued).toBe(2);
    tick(preMs + 90_000 + 100);
    e.drainIfChanged(); // settle(±0)
    tick(QUIZ_RESULT_MS + 1000);
    e.drainIfChanged(); // 凍結明け → maybeStartNextQuiz
    const q = e.get().quiz!;
    expect(q.armed).toBe(true); // 次のお題がアームされた
    expect(q.queued).toBe(1);
  });

  it('フィーバーのアーム中に届いたお題は予約され、即時発動しない', () => {
    const c = cfg();
    c.tapBoost = structuredClone(DEFAULT_CHALLENGE.tapBoost);
    c.tapBoost.enabled = true;
    c.tapBoost.rules[0]!.giftId = '555';
    const { e } = quizEngine(c);
    e.start();
    e.handleEvent(gift({ giftId: '555' })); // フィーバーをアーム
    e.handleEvent(gift({ giftId: '777' })); // お題 → 窓の終了待ち
    const s = e.get();
    // quiz キーは出ない(armed ですらない — 予約のみ)。
    expect(s.quiz).toBeUndefined();
    expect(s.recentEffects.some((x) => x.kind === 'quiz-start')).toBe(false);
  });
});

describe('投票と清算', () => {
  it('挑戦ウィンドウ中のコメントは票にならない(投票タイムだけ受付)', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    const { preMs } = armAndCommit(e, now);
    tick(preMs + 1000); // 窓の中
    e.handleEvent(comment('よかった', 'u1'));
    expect(e.get().quiz!.good).toBe(0);
  });

  it('1人1票・最後の投票が有効。よかった多数 → 減算・stats.quizDown', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    const { preMs } = armAndCommit(e, now);
    tick(preMs + 60_000 + 1000); // 投票タイム
    e.handleEvent(comment('だめ', 'u1'));
    e.handleEvent(comment('やっぱりよかった!', 'u1')); // u1 は good へ変更
    e.handleEvent(comment('ヨカッタ', 'u2'));
    const q = e.get().quiz!;
    expect(q.good).toBe(2);
    expect(q.bad).toBe(0);
    tick(30_000);
    e.drainIfChanged();
    const s = e.get();
    expect(s.quiz).toBeUndefined(); // 清算でキーごと消える
    // initialValue 1000 < 5000 なので 0 でクランプ、stats は実減少量。
    expect(s.value).toBe(0);
    expect(s.stats.quizDown).toBe(1000);
    const end = s.recentEffects.find((x) => x.kind === 'quiz-end')!;
    expect(end.quizGood).toBe(2);
    expect(end.quizBad).toBe(0);
    expect(end.amount).toBe(-1000); // クランプ後の実減少量
    expect(end.quizPrompt).toBe('ものまね');
  });

  it('よかった多数で 0 到達したら達成(quiz-end → achieved の順)・予約は破棄', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    const { preMs } = armAndCommit(e, now);
    e.handleEvent(gift({ giftId: '777' })); // 予約(達成で破棄されるはず)
    tick(preMs + 60_000 + 1000);
    e.handleEvent(comment('よかった', 'u1'));
    tick(30_000);
    e.drainIfChanged();
    const s = e.get();
    expect(s.status).toBe('achieved');
    const kinds = s.recentEffects.map((x) => x.kind);
    // recentEffects は新しい順 — achieved が quiz-end より前(=新しい)に居る。
    expect(kinds.indexOf('achieved')).toBeLessThan(kinds.indexOf('quiz-end'));
    // 達成後に時間が経っても次のお題は始まらない。
    tick(QUIZ_RESULT_MS + 1000);
    e.drainIfChanged();
    expect(e.get().quiz).toBeUndefined();
  });

  it('だめ多数 → 増加・stats.quizUp。引き分け・無投票 → ±0', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    const { preMs } = armAndCommit(e, now);
    tick(preMs + 60_000 + 1000);
    e.handleEvent(comment('だめだった', 'u1'));
    tick(30_000);
    e.drainIfChanged();
    let s = e.get();
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 5000);
    expect(s.stats.quizUp).toBe(5000);

    // 2本目: 引き分け(good1 bad1)は ±0。
    tick(QUIZ_RESULT_MS + 1000);
    e.drainIfChanged();
    const { preMs: pre2 } = armAndCommit(e, now);
    tick(pre2 + 60_000 + 1000);
    e.handleEvent(comment('よかった', 'u1'));
    e.handleEvent(comment('だめ', 'u2'));
    tick(30_000);
    e.drainIfChanged();
    s = e.get();
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 5000); // 変化なし
    const end = s.recentEffects.find((x) => x.kind === 'quiz-end')!;
    expect(end.amount).toBe(0);
  });
});

describe('4出口と機能OFF', () => {
  it('stop はバリアの溜め分を値だけ適用して畳む(受領済みギフトを闇に落とさない)', () => {
    const { e, now } = quizEngine();
    e.start();
    armAndCommit(e, now);
    e.handleEvent(gift({ giftId: '9999', diamonds: 30, diamondEach: 30 })); // deferred +30
    e.stop();
    const s = e.get();
    expect(s.status).toBe('idle');
    expect(s.quiz).toBeUndefined();
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 30);
    // quiz-end は積まない(status 遷移が合図)。
    expect(s.recentEffects.some((x) => x.kind === 'quiz-end')).toBe(false);
  });

  it('reset は窓・予約・バリアごと全破棄', () => {
    const { e, now } = quizEngine();
    e.start();
    armAndCommit(e, now);
    e.handleEvent(gift({ giftId: '777' })); // 予約
    e.reset();
    const s = e.get();
    expect(s.quiz).toBeUndefined();
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue);
  });

  it('quiz.enabled OFF は進行中の窓を ±0 で畳む(quiz-end は amount 0)・溜め分の値は生かす', () => {
    const c = cfg();
    const { e, now } = quizEngine(c);
    e.start();
    armAndCommit(e, now);
    e.handleEvent(gift({ giftId: '9999', diamonds: 30, diamondEach: 30 })); // deferred
    c.quiz.enabled = false;
    e.onConfigChanged();
    const s = e.get();
    expect(s.quiz).toBeUndefined();
    const end = s.recentEffects.find((x) => x.kind === 'quiz-end')!;
    expect(end.amount).toBe(0);
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 30);
  });
});

/**
 * アーム待ちの穴(2026-08-22 に修正)。どちらも 8/21 実装時からの既存バグで、
 * 回転を 6→18 秒へ伸ばした回に一緒に潰した(前置きが長くなるほど実害が増えるため)。
 */
describe('アーム待ちの穴', () => {
  /** 演出予告(fx)を持つギフトを出せる設定 — 既定の cfg() は帯域カットインを落としている。 */
  function cfgWithBandFx(): ChallengeConfig {
    const base = structuredClone(DEFAULT_CHALLENGE);
    return cfg({}, { giftBandFx: { ...base.giftBandFx, enabled: true } });
  }

  it('期限切れの強制発動は**即窓オープン**(前置きぶんの無表示を作らない)', () => {
    const { e, tick, now } = quizEngine();
    e.start();
    const armedAt = now();
    e.handleEvent(gift({ giftId: '777' }));
    expect(e.get().quiz?.armed).toBe(true);
    tick(QUIZ_ARM_MAX_MS + 100);
    e.drainIfChanged(); // flushFxFreeze 経由で commitArmedQuizIfExpired
    const q = e.get().quiz!;
    expect(q.armed).toBeUndefined();
    // モニターが前置きを一度も再生していないので、その尺ぶん窓を後ろへずらすと
    // 「armed は落ちたのに startsAtMs は未来」= 何も出ない空白になる。
    expect(q.startsAtMs).toBe(armedAt + QUIZ_ARM_MAX_MS);
    expect(q.windowEndsAtMs).toBe(armedAt + QUIZ_ARM_MAX_MS + DEFAULT_QUIZ.durationSec * 1000);
  });

  it('effect に焼いた quizEndsAtMs も強制発動の時刻と一致する(嘘のフォールバックを配らない)', () => {
    const { e, now } = quizEngine();
    e.start();
    const armedAt = now();
    e.handleEvent(gift({ giftId: '777' }));
    const ef = e.get().recentEffects.find((x) => x.kind === 'quiz-start')!;
    expect(ef.quizEndsAtMs).toBe(
      armedAt + QUIZ_ARM_MAX_MS + (DEFAULT_QUIZ.durationSec + DEFAULT_QUIZ.voteSec) * 1000
    );
  });

  it('アーム待ち中に届いた演出付きギフトの予告には barrier 印が付く', () => {
    const { e, tick } = quizEngine(cfgWithBandFx());
    e.start();
    e.handleEvent(gift({ giftId: '777' })); // お題をアーム(バリア開始)
    expect(e.get().quiz?.armed).toBe(true);
    tick(500);
    e.handleEvent(gift({ giftId: '8888', diamonds: 30 })); // 演出付き → quizDeferredOps へ
    const q = e.get().fxQueue ?? [];
    expect(q.length).toBeGreaterThan(0);
    // 印が無いと、モニターの armed 監視が「キューが空になる」のを永久に待って
    // 前置きが一度も再生されないまま 120 秒でアーム期限切れになる。
    expect(q.every((x) => x.barrier === true)).toBe(true);
  });

  it('清算で pendingOps へ移送された同じ予告からは barrier が消える(次のお題の待ちを壊さない)', () => {
    const { e, tick, now } = quizEngine(cfgWithBandFx());
    e.start();
    const { preMs } = armAndCommit(e, now);
    e.handleEvent(gift({ giftId: '8888', diamonds: 30 }));
    expect((e.get().fxQueue ?? []).every((x) => x.barrier === true)).toBe(true);
    // 窓 + 投票を満了させて清算 → deferred は pendingOps へ移送される。
    tick(preMs + (DEFAULT_QUIZ.durationSec + DEFAULT_QUIZ.voteSec) * 1000 + 100);
    e.drainIfChanged();
    const after = e.get().fxQueue ?? [];
    expect(after.length).toBeGreaterThan(0);
    expect(after.some((x) => x.barrier === true)).toBe(false);
  });
});
