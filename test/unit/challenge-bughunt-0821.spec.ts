/**
 * 2026-08-21 の網羅バグ調査で確定した worker 側修正の回帰網。
 *
 * - B2: stop()/機能OFF 時、pendingOps に居た発動 op(フィーバー/革命/お邪魔)が
 *   forceApplyPendingOps で走って掃除の後に再アームする「幽霊」の禁止。
 *   値だけの保留 op(follow 等)は従来どおり消えないこと(値の正しさ優先)も対で見る。
 * - B4: ルーレット出目の残量クランプ(実減少量規約)と、キュー溢れ時の縮退 op。
 * - B6: joinRouletteLastMs の clampFutureMs(時計巻き戻しで入室が長時間沈黙しない)。
 * - L1: 革命の走行中延長がコミット済み導入中でも窓を**縮めない**。
 * - L2: 達成(maybeAchieve)がフィーバー窓も畳む(CLEAR 後の boost-end 漏れ禁止)。
 * - L3: 封印/お題の進行中は ▶実演のタップ窓を登録しない(封印の抜け道禁止)。
 * - L4: 革命の自然満了時、fxAllowed() でなければ結果カットシーンの凍結を張らない。
 * - L11: 革命単独OFFはコミット済み導入中でも凍結を即時に引き戻す。
 * - L7(shared): mergeRoulette の切り詰め補償と rouletteDraws の実適用量優先。
 */
import { describe, expect, it } from 'vitest';
import {
  BOOST_ARM_MAX_MS,
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_QUIZ,
  DEFAULT_QUIZ_RULE,
  DEFAULT_REVOLUTION,
  DEFAULT_REVOLUTION_RULE,
  DEFAULT_ROULETTE,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  DEFAULT_TAP_LOCK,
  DEFAULT_TAP_LOCK_RULE,
  GIFT_FX_PENDING_OPS_MAX,
  JOIN_ROULETTE_MIN_GAP_MS,
  REVOLUTION_COUNT_MS,
  REVOLUTION_INTRO_MS,
  REVOLUTION_MAX_MS,
  ROULETTE_DRAWS_MAX,
  mergeRoulette,
  rouletteDraws,
  rouletteReelPlan,
  rouletteRemainingAmount,
  rouletteRemainingCount,
} from '@shared/challenge';
import type { ChallengeConfig, ChallengeEffect } from '@shared/dto';
import type { GiftEvent, NormalizedEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const BOOST_GIFT = '9001';
const REV_GIFT = '9002';
const LOCK_GIFT = '9003';
const QUIZ_GIFT = '9004';
const RL_GIFT = DEFAULT_ROULETTE.giftId; // '7934'(ハートミー)
const PRE_MS = REVOLUTION_INTRO_MS + REVOLUTION_COUNT_MS;

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定の全面カット行(バラ)と最終ゲートは別の凍結・別の減算規約を持ち込むので落とす。
  base.giftFullCut.enabled = false;
  base.finalGate.enabled = false;
  base.roulettes = [];
  base.giftBandFx = structuredClone(DEFAULT_GIFT_BAND_FX); // 30💎 で凍結を張る(freeze ヘルパ)
  return {
    ...base,
    enabled: true,
    initialValue: 1000,
    pressStep: 1,
    tapBoost: { ...structuredClone(DEFAULT_TAP_BOOST), enabled: true, rules: [{ ...structuredClone(DEFAULT_TAP_BOOST_RULE), giftId: BOOST_GIFT, giftName: '', exactName: false }] },
    revolution: { ...structuredClone(DEFAULT_REVOLUTION), enabled: true, rules: [{ ...structuredClone(DEFAULT_REVOLUTION_RULE), giftId: REV_GIFT, giftName: '', exactName: false }] },
    tapLock: { ...structuredClone(DEFAULT_TAP_LOCK), enabled: true, rules: [{ ...structuredClone(DEFAULT_TAP_LOCK_RULE), giftId: LOCK_GIFT, giftName: '', exactName: false, enabled: true }] },
    ...over,
  };
}

/** シネマ経路(モニター開・fxCaps あり)。 */
function engine(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

/** プレーン経路(モニター不在)。 */
function plain(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(false);
  e.setFxCaps(false);
  return e;
}

function gift(giftId: string, over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `g${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `u${seq}` },
    giftId,
    giftName: 'NoNameMatch',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

function follow(userId: string): NormalizedEvent {
  seq += 1;
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `f${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: userId },
  } as NormalizedEvent;
}

function join(userId: string): NormalizedEvent {
  seq += 1;
  return {
    kind: 'join',
    msgId: `j${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    action: 1,
    viewer: { userId, nickname: userId },
  } as NormalizedEvent;
}

/** 帯域カットイン(30💎)で凍結を張る。 */
function freeze(e: ChallengeEngine): void {
  e.handleEvent(gift('band-src', { diamondEach: 30, diamonds: 30 }));
  expect(e.get().fxFreezeUntilMs).not.toBeNull();
}

const kinds = (e: ChallengeEngine): string[] => e.get().recentEffects.map((x) => x.kind);

describe('B2: stop()/機能OFF は保留中の発動 op を幽霊化させない', () => {
  it('凍結中に積まれたフィーバー発動 op は stop() を生き残らない(値の保留 op は消えない)', () => {
    let t = NOW;
    const c = cfg({ followStep: 1 });
    const e = engine(c, () => t);
    e.start();
    freeze(e);
    const before = e.get().value;
    e.handleEvent(follow('keeper')); // 値だけの保留 op — stop で消えてはいけない
    e.handleEvent(gift(BOOST_GIFT)); // 発動 op(critical)— stop で破棄されるべき
    e.stop();
    // 値は保全、発動は破棄。
    expect(e.get().value).toBe(before + 1);
    expect(kinds(e)).not.toContain('boost-start');
    expect(e.get().boost).toBeUndefined();
    // アーム期限を跨いでも幽霊フィーバーは発動しない。
    t = NOW + BOOST_ARM_MAX_MS + 60_000;
    e.drainIfChanged();
    expect(kinds(e)).not.toContain('boost-start');
    expect(kinds(e)).not.toContain('boost-end');
    expect(e.get().status).toBe('idle');
  });

  it('封印中の stop(): 発動 op が deferredBoosts の孤児にならない(fxQueue に boost が残らない)', () => {
    let t = NOW;
    const c = cfg();
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(gift(LOCK_GIFT)); // 封印ラッチ(即時)
    expect(e.get().tapLock).toBeDefined();
    freeze(e);
    e.handleEvent(gift(BOOST_GIFT)); // 凍結中 → pendingOps(critical)
    e.stop();
    // stop 中の forceApply で走っても、封印明け予約(deferredBoosts)として残らない。
    expect((e.get().fxQueue ?? []).some((q) => q.kind === 'boost')).toBe(false);
    expect(e.get().tapLock).toBeUndefined(); // stop は封印も跨がせない(既存規約)
    t = NOW + BOOST_ARM_MAX_MS + 60_000;
    e.drainIfChanged();
    expect(kinds(e)).not.toContain('boost-start');
  });

  it('凍結中に積まれた革命発動 op はチャレンジ全体OFFを生き残らない', () => {
    let t = NOW;
    const c = cfg({ followStep: 1 });
    const e = engine(c, () => t);
    e.start();
    freeze(e);
    const before = e.get().value;
    e.handleEvent(follow('keeper'));
    e.handleEvent(gift(REV_GIFT)); // 発動 op(critical)
    c.enabled = false;
    e.onConfigChanged();
    expect(e.get().value).toBe(before + 1); // 値の保留は OFF でも消えない(stop と同じ規約)
    expect(kinds(e)).not.toContain('revolution-start');
    expect(e.get().revolution).toBeUndefined();
    t = NOW + BOOST_ARM_MAX_MS + 60_000;
    e.drainIfChanged();
    expect(kinds(e)).not.toContain('revolution-start');
    expect(e.get().revolution).toBeUndefined();
  });

  it('お題バリアに溜まった封印発動はチャレンジ全体OFFで再ラッチしない', () => {
    const c = cfg({
      quiz: {
        ...structuredClone(DEFAULT_QUIZ),
        enabled: true,
        rules: [{ ...structuredClone(DEFAULT_QUIZ_RULE), giftId: QUIZ_GIFT, giftName: '', exactName: false, enabled: true }],
      },
    });
    const e = plain(c); // プレーン = armQuiz が即窓オープン(バリア発効)
    e.start();
    e.handleEvent(gift(QUIZ_GIFT));
    expect(e.get().quiz).toBeDefined();
    e.handleEvent(gift(LOCK_GIFT)); // お題中 → quizDeferredOps へ後回し
    expect(e.get().tapLock).toBeUndefined(); // まだ発効していない
    c.enabled = false;
    e.onConfigChanged(); // deferred → pendingOps → forceApply — ここで再ラッチしないこと
    expect(e.get().tapLock).toBeUndefined();
    expect(kinds(e)).not.toContain('tap-lock');
  });
});

describe('B4: ルーレット出目の残量クランプと溢れ弁の縮退', () => {
  it('キュー溢れ時はリール effect を出さず値・統計だけ適用する(縮退 op)', () => {
    const c = cfg({ roulettes: [structuredClone(DEFAULT_ROULETTE)] });
    const e = engine(c);
    e.start();
    freeze(e);
    const before = e.get().value;
    for (let i = 0; i < GIFT_FX_PENDING_OPS_MAX; i += 1) e.handleEvent(follow(`fill-${i}`));
    e.handleEvent(gift(RL_GIFT)); // 溢れ → 縮退 op が即時実行(rand=0 → 出目 5)
    expect(e.get().value).toBe(before + 5);
    expect(e.get().stats.rouletteSpins).toBe(1);
    // リール付き effect は出ない(カットインの真上でフル再生される事故の再発防止)。
    expect(kinds(e)).not.toContain('roulette');
  });
});

describe('B6: 入室ルーレットのクールダウンは時計の巻き戻しから自己回復する', () => {
  it('時計が後退したら窓ごと失効し、直後の入室が即座に回る(初見を1人も犠牲にしない)', () => {
    let t = NOW;
    const c = cfg({
      joinRoulette: { ...structuredClone(DEFAULT_CHALLENGE.joinRoulette), enabled: true, target: 'all' },
    });
    const e = plain(c, () => t);
    e.start();
    expect(e.handleEvent(join('j1'))).toBe(true);
    // NTP 補正で時計が10分巻き戻る。lastMs(NOW)は未来に取り残される —
    // 対処が無いと10分38秒、対処が now への丸めだと j2 が dedup だけ消費されて恒久に沈黙する。
    t = NOW - 600_000;
    expect(e.handleEvent(join('j2'))).toBe(true);
    // 通常のクールダウンはそのまま生きている(失効は巻き戻し検出の1回だけ)。
    t += 1_000;
    expect(e.handleEvent(join('j4'))).toBe(false);
    t += JOIN_ROULETTE_MIN_GAP_MS;
    expect(e.handleEvent(join('j5'))).toBe(true);
  });
});

describe('L1: 革命の走行中延長は窓を縮めない', () => {
  it('尺を上限まで積んだ窓に、導入中の2発目が来ても期限は後退しない', () => {
    let t = NOW;
    const c = cfg();
    c.revolution.rules[0]!.durationSec = REVOLUTION_MAX_MS / 1000; // 上限いっぱいの尺
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(gift(REV_GIFT));
    const id = e.get().recentEffects.find((x) => x.kind === 'revolution-start')!.id;
    e.revolutionCue({ action: 'start', effectId: id, startedAtMs: NOW, preMs: PRE_MS });
    const before = e.get().revolution!.endsAtMs; // NOW + 前置き + 180s
    expect(before).toBe(NOW + PRE_MS + REVOLUTION_MAX_MS);
    // 導入の途中(前置き13秒の5秒目)に別の視聴者がもう1羽。
    t = NOW + 5_000;
    e.handleEvent(gift(REV_GIFT));
    // 修正前: capped = atMs + 180s = before − 8s に**縮んで**いた。
    expect(e.get().revolution!.endsAtMs).toBeGreaterThanOrEqual(before);
  });
});

describe('L2: 達成はフィーバー窓も畳む', () => {
  it('プレーン窓中の押下で 0 到達 → boost キーは消え、boost-end は配られない', () => {
    let t = NOW;
    const c = cfg({ initialValue: 3 });
    const e = plain(c, () => t);
    e.start();
    e.handleEvent(gift(BOOST_GIFT)); // プレーン即発動(倍率だけ)
    expect(e.get().boost).toBeDefined();
    e.press();
    e.press();
    e.press(); // ×倍率のクランプで確実に 0 へ
    const s = e.get();
    expect(s.status).toBe('achieved');
    expect(s.value).toBe(0);
    expect(s.boost).toBeUndefined(); // CLEAR リザルトとフィーバー DTO を同時に返さない
    // 窓の元の満了時刻を跨いでも boost-end は出ない(achieved より大きい id の演出禁止)。
    t = NOW + DEFAULT_TAP_BOOST_RULE.durationSec * 1000 + 60_000;
    e.drainIfChanged();
    expect(kinds(e)).not.toContain('boost-end');
  });
});

describe('L3: 封印・お題の進行中は ▶実演のタップ窓を登録しない', () => {
  it('封印中の testEffect(tapBoost) は実演窓を作らず、押下は封印が数える', () => {
    const c = cfg();
    const e = plain(c);
    e.start();
    e.handleEvent(gift(LOCK_GIFT));
    const blockedBefore = e.get().tapLock!.blocked;
    e.testEffect({ kind: 'tapBoost' });
    expect(e.get().boost).toBeUndefined(); // 実演窓(boost キー)が登録されない
    e.press();
    // 押下は実演カウンタに吸われず、封印の blocked が進む(「押したのに効かない」の手応え)。
    expect(e.get().tapLock!.blocked).toBe(blockedBefore + 1);
  });
});

describe('L4: 革命の自然満了 — 再生されない結果カットシーンのために凍結しない', () => {
  it('窓中にモニターが閉じたら、満了時の清算は凍結ゼロで即時', () => {
    let t = NOW;
    const c = cfg();
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(gift(REV_GIFT));
    const id = e.get().recentEffects.find((x) => x.kind === 'revolution-start')!.id;
    e.revolutionCue({ action: 'start', effectId: id, startedAtMs: NOW, preMs: PRE_MS });
    // 窓中に1回押して戦果(downTotal>0)を作る — これが結果カットシーンの条件。
    t = NOW + PRE_MS + 1_000;
    e.press();
    // 窓の走行中にモニターが閉じる。
    e.setMonitorOpen(false);
    // 自然満了。
    t = e.get().revolution!.endsAtMs + 1_000;
    e.drainIfChanged();
    const s = e.get();
    expect(s.revolution).toBeUndefined();
    expect(kinds(e)).toContain('revolution-end');
    // 誰も再生しない 6 秒のために約 9 秒凍結しない。
    expect(s.fxFreezeUntilMs).toBeNull();
  });
});

describe('L11: 革命単独OFFはコミット済み導入中でも凍結を即時に引き戻す', () => {
  it('導入8秒の途中で OFF → 保留 op は即時解放される', () => {
    let t = NOW;
    const c = cfg({ followStep: 1 });
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(gift(REV_GIFT));
    const id = e.get().recentEffects.find((x) => x.kind === 'revolution-start')!.id;
    e.revolutionCue({ action: 'start', effectId: id, startedAtMs: NOW, preMs: PRE_MS });
    expect(e.get().fxFreezeUntilMs).not.toBeNull(); // 導入中の暫定凍結
    const before = e.get().value;
    e.handleEvent(follow('waiting')); // 導入中に届いた値 op は保留になる
    expect(e.get().value).toBe(before);
    t = NOW + 5_000; // まだ導入中(前置き13秒の5秒目)
    c.revolution.enabled = false;
    e.onConfigChanged();
    // 修正前: armed 限定だったため凍結が窓オープン予定時刻(最長13秒後)まで残った。
    expect(e.get().fxFreezeUntilMs).toBeNull();
    expect(e.get().value).toBe(before + 1); // 保留していた follow が即時解放
    expect(e.get().revolution).toBeUndefined();
  });
});

describe('L9: WakeRow の錨(firstStartedMs)は初回 start をラッチする', () => {
  it('stop→start・reset でも維持され、worker 世代でのみリセットされる', () => {
    let t = NOW;
    const e = plain(cfg(), () => t);
    expect(e.get().firstStartedMs).toBeUndefined(); // 未 start はキーごと省く
    e.start();
    expect(e.get().firstStartedMs).toBe(NOW);
    t = NOW + 3_600_000;
    e.stop();
    e.start(); // ランの仕切り直し — startedMs は動くが錨は動かない
    expect(e.get().startedMs).toBe(t);
    expect(e.get().firstStartedMs).toBe(NOW);
    e.reset();
    expect(e.get().firstStartedMs).toBe(NOW); // reset でも消えない(ユーザー決定)
  });
});

describe('L7(shared): 切り詰め補償と実適用量の復元', () => {
  const board = (n: number, over: Partial<ChallengeEffect> = {}): ChallengeEffect => ({
    id: 1,
    kind: 'roulette',
    amount: n * 5,
    valueAfter: 0,
    atMs: NOW,
    rouletteSegments: [5],
    rouletteIndex: 0,
    rouletteIndexes: Array.from({ length: n }, () => 0),
    roulettePattern: 'slow',
    roulettePatterns: Array.from({ length: n }, () => 'slow' as const),
    rouletteReels: 1,
    ...over,
  });

  it('mergeRoulette: ROULETTE_DRAWS_MAX 超過分は rouletteTruncatedAmount/Count が運ぶ', () => {
    const a = board(150, { id: 1 });
    const b = board(100, { id: 2 });
    const m = mergeRoulette(a, b);
    expect(m.rouletteIndexes).toHaveLength(ROULETTE_DRAWS_MAX);
    expect(m.amount).toBe(250 * 5); // 値は worker 適用済みの満額
    expect(m.rouletteTruncatedCount).toBe(50);
    expect(m.rouletteTruncatedAmount).toBe(50 * 5);
    // 据え置き会計の総和 = effect.amount(超過分が先漏れしない)。
    expect(rouletteRemainingAmount(m, 0)).toBe(m.amount);
    expect(rouletteRemainingCount(m, 0)).toBe(250);
    // rest(合算バナー)にも超過分が乗る。
    expect(rouletteReelPlan(m).restAmount).toBe(rouletteRemainingAmount(m, 0) - 5 * (m.rouletteReels ?? 0));
  });

  it('mergeRoulette: 切り詰め済み effect どうしの連結は補償を引き継ぐ', () => {
    const a = board(150);
    const b = board(100);
    const m1 = mergeRoulette(a, b); // truncated 50
    const m2 = mergeRoulette(m1, board(10, { id: 3 })); // さらに 10 本超過
    expect(m2.rouletteTruncatedCount).toBe(60);
    expect(m2.rouletteTruncatedAmount).toBe(60 * 5);
    expect(rouletteRemainingAmount(m2, 0)).toBe(m2.amount);
  });

  it('切り詰めが無ければ従来と 1 バイトも変わらない(キーごと載らない)', () => {
    const m = mergeRoulette(board(3), board(4, { id: 2 }));
    expect(m.rouletteTruncatedAmount).toBeUndefined();
    expect(m.rouletteTruncatedCount).toBeUndefined();
    expect(m.rouletteAmounts).toBeUndefined();
  });

  it('rouletteDraws: rouletteAmounts(実適用量)は名目式より優先される', () => {
    const e = board(2, { amount: -8, rouletteDirection: 'sub', rouletteAmounts: [-5, -3] });
    expect(rouletteDraws(e).map((d) => d.amount)).toEqual([-5, -3]);
    // 無ければ従来どおり名目式(segments[index] × 符号)。
    expect(rouletteDraws(board(2, { rouletteDirection: 'sub' })).map((d) => d.amount)).toEqual([-5, -5]);
  });

  it('mergeRoulette: 片方だけが実適用量を持つ連結は、持たない側を名目で補完して並びを保つ', () => {
    const a = board(2, { rouletteDirection: 'sub', amount: -10 });
    const b = board(2, { id: 2, rouletteDirection: 'sub', amount: -8, rouletteAmounts: [-5, -3] });
    const m = mergeRoulette(a, b);
    expect(m.rouletteAmounts).toEqual([-5, -5, -5, -3]);
    expect(rouletteRemainingAmount(m, 0)).toBe(-18);
  });
});
