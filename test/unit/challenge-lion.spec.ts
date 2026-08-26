/**
 * ライオン(Lion 29,999💎)— worker 側の契約。
 *
 * この機能の本体は「43 秒のカットシーンの**段⑥の頭**でカウントが
 * `amountEach × steps` だけ増える」の1点だけで、演出はモニターの担当。
 * したがってここで固定するのは:
 *
 *   着弾 = アームだけ(値は動かない)→ モニターの実再生合図(lionCue)で
 *   時計をコミット → 清算(value += 総額 + lion-end)→ その 5 秒後に幕が引ける
 *
 * **一撃クリア(universe)との構造差が2つ**あり、どちらもここで凍結する:
 *  1. 清算は演出の**終端ではなく段⑥の頭**(数字が動く瞬間を見せるため)。
 *  2. 演出中の**タップは通常どおり効く**(妨害なので押す手を止めさせない)。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_LION,
  DEFAULT_LION_RULE,
  DEFAULT_UNIVERSE,
  DEFAULT_UNIVERSE_RULE,
  GIFT_FX_FREEZE_MARGIN_MS,
} from '@shared/challenge';
import {
  LION_ARM_MAX_MS,
  LION_TOTAL_DISPLAY_MS,
  lionCutsceneMs,
  lionSettleAtMs,
} from '@shared/lion-settle';
import type { ChallengeConfig } from '@shared/dto';
import type { CommentEvent, GiftEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
const LION_GIFT_ID = DEFAULT_LION_RULE.giftId; // 6369(採取済み)
const EACH = DEFAULT_LION_RULE.amountEach; // 29,999
const STEPS = DEFAULT_LION_RULE.steps; // 50
const TOTAL = EACH * STEPS; // 1,499,950
const CUT_MS = lionCutsceneMs(STEPS); // 43,005
const SETTLE_MS = lionSettleAtMs(STEPS); // 38,005
const START = 1000;

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定の全面カットは「バラ」に一致して別の凍結を張るので落とす(他の spec と同じ)。
  base.giftFullCut.enabled = false;
  base.roulettes = [];
  base.finalGate.enabled = false;
  // 素ギフト・コメントお助けは値を動かすので基本形では落とす
  // (バリアの describe だけ明示的に入れる)。
  base.giftDefault = null;
  base.giftRules = [];
  base.commentHelper.enabled = false;
  // giftScale(ダイヤ増減の N 浮上)は既定 ON で 29,999💎 が値を大きく動かすので落とす。
  base.giftScale.enabled = false;
  return {
    ...base,
    enabled: true,
    initialValue: START,
    pressStep: 1,
    // **ライオンは既定 ON** — 明示しなくても入るが、意図を読めるように書いておく。
    lion: { ...structuredClone(DEFAULT_LION), enabled: true },
    ...over,
  };
}

/** モニターが開いていてカットインを再生できる = シネマ経路(アーム → cue でコミット)。 */
function engine(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

/** モニター不在(fxAllowed=false)= プレーン経路(演出なし・即加算)。 */
function plain(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(false);
  e.setFxCaps(false);
  return e;
}

function lionGift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `L${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `v${seq}`, nickname: `視聴者${seq}` },
    giftId: LION_GIFT_ID,
    giftName: 'Lion',
    repeatCount: 1,
    diamondEach: 29999,
    diamonds: 29999,
    isBoxGift: false,
    ...over,
  };
}

/** ライオンに当たらない普通のギフト(バリアの検出器)。 */
function otherGift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `o${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `w${seq}`, nickname: `他${seq}` },
    giftId: '9999',
    giftName: 'Rose',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

function comment(content: string): CommentEvent {
  seq += 1;
  return {
    kind: 'comment',
    msgId: `c${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'commenter', nickname: 'コメントの人' },
    content,
    isQuestion: false,
  };
}

const startFxId = (e: ChallengeEngine): number =>
  e.get().recentEffects.find((x) => x.kind === 'lion-start')!.id;

const kinds = (e: ChallengeEngine): string[] => e.get().recentEffects.map((x) => x.kind);

/** アームまで進める(開始 → 29,999💎 を1個)。 */
function arm(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = engine(c, now);
  e.start();
  e.handleEvent(lionGift());
  return e;
}

describe('トリガー判定', () => {
  it('既定行は giftId(6369)で当たる', () => {
    const e = arm(cfg());
    expect(e.get().lion?.armed).toBe(true);
    expect(e.get().lion?.each).toBe(EACH);
    expect(e.get().lion?.steps).toBe(STEPS);
  });

  it('★「Leon and Lion」(34,000💎)は巻き込まない(exactName の存在理由)', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(lionGift({ giftId: '7823', giftName: 'Leon and Lion' }));
    expect(e.get().lion ?? null).toBeNull();
    expect(e.get().value).toBe(START);
  });

  it('exactName を外すと Leon and Lion にも当たってしまう(対偶 — ガードが効いている証明)', () => {
    const c = cfg();
    c.lion.rules = [{ ...structuredClone(DEFAULT_LION_RULE), giftId: '', exactName: false }];
    const e = engine(c);
    e.start();
    e.handleEvent(lionGift({ giftId: '7823', giftName: 'Leon and Lion' }));
    expect(e.get().lion?.armed).toBe(true);
  });

  it('機能 enabled が false なら1行も評価しない', () => {
    const e = engine(cfg({ lion: { ...structuredClone(DEFAULT_LION), enabled: false } }));
    e.start();
    e.handleEvent(lionGift());
    expect(e.get().lion ?? null).toBeNull();
    expect(e.get().value).toBe(START);
  });

  it('同じ giftId を一撃クリアにも登録した誤設定では**一撃クリアが勝つ**(結末を決めるほう)', () => {
    const c = cfg({
      universe: {
        ...structuredClone(DEFAULT_UNIVERSE),
        enabled: true,
        rules: [{ ...structuredClone(DEFAULT_UNIVERSE_RULE), giftId: LION_GIFT_ID, giftName: '' }],
      },
    });
    const e = engine(c);
    e.start();
    e.handleEvent(lionGift());
    expect(e.get().universe?.armed).toBe(true);
    expect(e.get().lion ?? null).toBeNull();
  });

  it('未開始 / 停止中は発動しない(幽霊ガード)', () => {
    const e = engine(cfg());
    e.handleEvent(lionGift()); // start していない
    expect(e.get().lion ?? null).toBeNull();
  });
});

describe('アーム → cue → 清算', () => {
  it('着弾では**値を動かさない**(アームだけ)', () => {
    const e = arm(cfg());
    expect(e.get().value).toBe(START);
    expect(kinds(e)).toContain('lion-start');
    expect(kinds(e)).not.toContain('lion-end');
  });

  it('lion-start は額・発数・尺を焼き込む(モニターは cfg を読まない)', () => {
    const e = arm(cfg());
    const s = e.get().recentEffects.find((x) => x.kind === 'lion-start')!;
    expect(s.amount).toBe(0);
    expect(s.lionEach).toBe(EACH);
    expect(s.lionSteps).toBe(STEPS);
    expect(s.lionTotal).toBe(TOTAL);
    expect(s.fxDurationMs).toBe(CUT_MS);
    expect(s.diamonds).toBe(29999);
  });

  it('cue{start} でコミット — 清算は**段⑥の頭**(演出の終端ではない)', () => {
    const now = NOW;
    const e = arm(cfg(), () => now);
    const id = startFxId(e);
    expect(e.lionCue({ action: 'start', effectId: id, startedAtMs: now })).toBe(true);
    const st = e.get();
    expect(st.lion?.armed).toBeUndefined();
    expect(st.lion?.startsAtMs).toBe(now);
    expect(st.lion?.endsAtMs).toBe(now + SETTLE_MS);
    // 清算のあとに合計の発表が 5 秒残る = 幕が引けるのはその後。
    expect(CUT_MS - SETTLE_MS).toBe(LION_TOTAL_DISPLAY_MS);
  });

  it('清算でカウントが総額ぶん増え、lion-end が積まれる', () => {
    let now = NOW;
    const e = arm(cfg(), () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    now += SETTLE_MS + 1;
    e.drainIfChanged();
    const st = e.get();
    expect(st.value).toBe(START + TOTAL);
    expect(st.lion ?? null).toBeNull(); // バリア解除
    const end = st.recentEffects.find((x) => x.kind === 'lion-end')!;
    expect(end.amount).toBe(TOTAL);
    expect(end.lionTotal).toBe(TOTAL);
    expect(end.lionEach).toBe(EACH);
    expect(end.lionSteps).toBe(STEPS);
    expect(st.stats.giftUp).toBeGreaterThanOrEqual(TOTAL);
  });

  it('★清算は 2Hz tick に依存しない(armFreezeTimer が唯一の出口)', () => {
    // 配信終了・切断・リプレイ終了で tick が死ぬのは 100% 再現する経路。
    vi.useFakeTimers();
    try {
      let now = NOW;
      const e = arm(cfg(), () => now);
      e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
      now += SETTLE_MS + 100;
      // drainIfChanged(2Hz tick)を**一度も呼ばず**にタイマーだけ進める。
      vi.advanceTimersByTime(CUT_MS + 5_000);
      expect(e.get().value).toBe(START + TOTAL);
      expect(kinds(e)).toContain('lion-end');
    } finally {
      vi.useRealTimers();
    }
  });

  it('凍結は合計の発表(5秒)ぶんまで伸ばす — 幕の途中で他の演出を出さない', () => {
    const now = NOW;
    const e = arm(cfg(), () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    expect(e.get().fxFreezeUntilMs).toBe(
      now + SETTLE_MS + LION_TOTAL_DISPLAY_MS + GIFT_FX_FREEZE_MARGIN_MS
    );
  });

  it('cue{drop} は**プレーン即発動へ倒す**(効果は破棄しない)', () => {
    const now = NOW;
    const e = arm(cfg(), () => now);
    expect(e.lionCue({ action: 'drop', effectId: startFxId(e) })).toBe(true);
    expect(e.get().value).toBe(START + TOTAL);
    expect(kinds(e)).toContain('lion-end');
  });

  it('アーム期限切れは破棄ではなく強制発動', () => {
    let now = NOW;
    const e = arm(cfg(), () => now);
    now += LION_ARM_MAX_MS + SETTLE_MS + 100;
    e.drainIfChanged();
    expect(e.get().value).toBe(START + TOTAL);
    expect(kinds(e)).toContain('lion-end');
  });

  it('別の effectId の cue は無視する', () => {
    const e = arm(cfg());
    expect(e.lionCue({ action: 'start', effectId: startFxId(e) + 999, startedAtMs: NOW })).toBe(false);
    expect(e.get().lion?.armed).toBe(true);
  });
});

describe('プレーン経路(モニター不在)', () => {
  it('演出なしで即座に加算する(効果だけは必ず発動する)', () => {
    const e = plain(cfg());
    e.start();
    e.handleEvent(lionGift());
    const st = e.get();
    expect(st.value).toBe(START + TOTAL);
    expect(st.lion ?? null).toBeNull();
    expect(kinds(e)).toContain('lion-start');
    expect(kinds(e)).toContain('lion-end');
    const s = st.recentEffects.find((x) => x.kind === 'lion-start')!;
    expect(s.fxDurationMs).toBe(0);
    expect(s.lionEndsAtMs).toBeUndefined();
  });

  it('プレーンは凍結を張らない', () => {
    const e = plain(cfg());
    e.start();
    e.handleEvent(lionGift());
    expect(e.get().fxFreezeUntilMs ?? null).toBeNull();
  });
});

describe('重ねがけ・連打', () => {
  it('進行中の2発目は冪等に受け流す(43 秒の幕は直列化できない)', () => {
    let now = NOW;
    const e = arm(cfg(), () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    e.handleEvent(lionGift());
    expect(kinds(e).filter((k) => k === 'lion-start')).toHaveLength(1);
    now += SETTLE_MS + 1;
    e.drainIfChanged();
    // 2発目は効果ごと受け流されるので、増えるのは1回ぶんだけ。
    expect(e.get().value).toBe(START + TOTAL);
  });

  it('連打(repeatCount > 1)も発動は1回に畳む', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(lionGift({ repeatCount: 3, diamonds: 29999 * 3 }));
    expect(kinds(e).filter((k) => k === 'lion-start')).toHaveLength(1);
    expect(e.get().lion?.armed).toBe(true);
  });
});

describe('★走行中のタップは通常どおり効く(universe との振る舞い差)', () => {
  it('幕の裏の押下がそのまま減り、段⑥はその値からの上乗せになる', () => {
    let now = NOW;
    const e = arm(cfg(), () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    for (let i = 0; i < 10; i++) e.press();
    expect(e.get().value).toBe(START - 10); // 幕の裏でも即時に効く
    now += SETTLE_MS + 1;
    e.drainIfChanged();
    expect(e.get().value).toBe(START - 10 + TOTAL);
    expect(e.get().stats.presses).toBe(10);
  });
});

describe('バリア(発動〜清算に届いたイベントは清算後へ)', () => {
  it('走行中のギフトは溜まり、清算後に適用される', () => {
    let now = NOW;
    const c = cfg({ giftDefault: { mode: 'perDiamond', amount: 1 } });
    const e = arm(c, () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    e.handleEvent(otherGift({ diamonds: 3, diamondEach: 3 })); // +3(perDiamond)
    e.handleEvent(comment('がんばれ')); // コメントは値を持たないが op としては溜まる
    // 幕の中では値が動かない(タップ以外)。
    expect(e.get().value).toBe(START);
    now += SETTLE_MS + 1;
    e.drainIfChanged();
    // 清算 → 溜め分を pendingOps へ移送 → 凍結明けでドレイン。
    now += LION_TOTAL_DISPLAY_MS + GIFT_FX_FREEZE_MARGIN_MS + 100;
    e.drainIfChanged();
    expect(e.get().value).toBe(START + TOTAL + 3);
  });

  it('★溜め分は破棄しない(universe は破棄・こちらは移送)', () => {
    let now = NOW;
    const c = cfg({ giftDefault: { mode: 'perDiamond', amount: 1 } });
    const e = arm(c, () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    e.handleEvent(otherGift({ diamonds: 500, diamondEach: 500 }));
    now += SETTLE_MS + 1;
    e.drainIfChanged();
    now += LION_TOTAL_DISPLAY_MS + GIFT_FX_FREEZE_MARGIN_MS + 100;
    e.drainIfChanged();
    expect(e.get().value).toBe(START + TOTAL + 500);
  });
});

describe('停止・リセット・機能OFF', () => {
  it('stop はカウントを増やさない(lion-end も積まない)', () => {
    const now = NOW;
    const e = arm(cfg(), () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    e.stop();
    expect(e.get().value).toBe(START);
    expect(kinds(e)).not.toContain('lion-end');
    expect(e.get().lion ?? null).toBeNull();
  });

  it('機能を OFF にすると進行中の演出を畳む(値は増やさない)', () => {
    const now = NOW;
    const c = cfg();
    const e = arm(c, () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    c.lion.enabled = false;
    e.onConfigChanged();
    expect(e.get().lion ?? null).toBeNull();
    expect(e.get().value).toBe(START);
    expect(kinds(e)).not.toContain('lion-end');
  });

  it('reset で全部畳む', () => {
    const now = NOW;
    const e = arm(cfg(), () => now);
    e.lionCue({ action: 'start', effectId: startFxId(e), startedAtMs: now });
    e.reset();
    expect(e.get().lion ?? null).toBeNull();
    expect(e.get().value).toBe(START);
  });
});

describe('▶テスト実演', () => {
  it('値・統計・凍結には触れない', () => {
    const e = engine(cfg());
    e.start();
    const r = e.testEffect({ kind: 'lion' });
    expect(r.previewMs).toBe(CUT_MS);
    expect(e.get().value).toBe(START);
    expect(e.get().stats.giftUp).toBe(0);
    expect(e.get().fxFreezeUntilMs ?? null).toBeNull();
    // 実発動と同じ lion キーへ合流するが **armed は立てない**
    // (立てるとモニターの armed 監視が本物の cue を撃つ)。
    expect(e.get().lion?.test).toBe(true);
    expect(e.get().lion?.armed).toBeUndefined();
  });

  it('満了で lion-end を積む(amount 0 = 値は動かない)', () => {
    let now = NOW;
    const e = engine(cfg(), () => now);
    e.start();
    e.testEffect({ kind: 'lion' });
    now += CUT_MS + 100;
    e.drainIfChanged();
    const end = e.get().recentEffects.find((x) => x.kind === 'lion-end')!;
    expect(end.amount).toBe(0);
    expect(end.lionTotal).toBe(TOTAL);
    expect(e.get().value).toBe(START);
    expect(e.get().lion ?? null).toBeNull();
  });

  it('実発動が実演に勝つ(clearTestPreviews)', () => {
    const e = engine(cfg());
    e.start();
    e.testEffect({ kind: 'lion' });
    e.handleEvent(lionGift());
    expect(e.get().lion?.test).toBeUndefined();
    expect(e.get().lion?.armed).toBe(true);
  });
});
