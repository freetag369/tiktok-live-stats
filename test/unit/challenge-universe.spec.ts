/**
 * 一撃クリア(TIKTOK UNIVERSE 44,999💎)— worker 側の契約。
 *
 * この機能の本体は「25 秒後に必ずカウントが 0 になり、**その後で** CLEAR が出る」の
 * 2点だけで、演出はモニターの担当。したがってここで固定するのは:
 *
 *   着弾 = アームだけ(値は動かない)→ モニターの実再生合図(universeCue)で
 *   25 秒の時計をコミット → 清算(value=0 + universe-end)→ その 500ms 後に CLEAR
 *
 * **最重要は「清算が 2Hz tick に依存しない」こと**(§armFreezeTimer)。配信終了・
 * 切断・リプレイ終了で tick が死ぬのは 100% 再現する経路で、ブーストの結果カット
 * シーンが実際にそこで消えた前例がある。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_REVOLUTION,
  DEFAULT_REVOLUTION_RULE,
  DEFAULT_UNIVERSE,
  DEFAULT_UNIVERSE_RULE,
  GIFT_FX_FREEZE_MARGIN_MS,
} from '@shared/challenge';
import { UNIVERSE_ARM_MAX_MS, UNIVERSE_TOTAL_MS } from '@shared/universe';
import type { ChallengeConfig } from '@shared/dto';
import type { CommentEvent, GiftEvent, LikeEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
/** TIKTOK UNIVERSE の giftId は**未採取**(既定行は giftName 完全一致が本線)。 */
const UNI_GIFT_ID = 'e2e-universe';
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
  // giftScale(ダイヤ増減の N 浮上)は既定 ON で 44,999💎 が値を大きく動かすので落とす。
  base.giftScale.enabled = false;
  return {
    ...base,
    enabled: true,
    initialValue: START,
    pressStep: 1,
    universe: {
      ...structuredClone(DEFAULT_UNIVERSE),
      // **既定は false**(revolution / tapLock と同じ向き)。テストでは明示的に入れる。
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_UNIVERSE_RULE), giftId: UNI_GIFT_ID }],
    },
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

/** モニター不在(fxAllowed=false)= プレーン経路(演出なし・即 0 + CLEAR)。 */
function plain(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(false);
  e.setFxCaps(false);
  return e;
}

function uniGift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `u${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `v${seq}`, nickname: `視聴者${seq}` },
    giftId: UNI_GIFT_ID,
    giftName: 'TikTok Universe',
    repeatCount: 1,
    diamondEach: 44999,
    diamonds: 44999,
    isBoxGift: false,
    ...over,
  };
}

/** 一撃クリアに当たらない普通のギフト(バリアの検出器)。 */
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

function like(count: number): LikeEvent {
  seq += 1;
  return {
    kind: 'like',
    msgId: `l${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'liker', nickname: 'いいねの人' },
    count,
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
  e.get().recentEffects.find((x) => x.kind === 'universe-start')!.id;

const kinds = (e: ChallengeEngine): string[] => e.get().recentEffects.map((x) => x.kind);

/** アームまで進める(開始 → 44,999💎 を1個)。 */
function arm(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = engine(c, now);
  e.start();
  e.handleEvent(uniGift());
  return e;
}

describe('トリガー判定', () => {
  it('既定行は giftName の完全一致で当たる(giftId は未採取)', () => {
    const c = cfg();
    c.universe.rules = [structuredClone(DEFAULT_UNIVERSE_RULE)];
    const e = engine(c);
    e.start();
    e.handleEvent(uniGift({ giftId: '0' }));
    expect(e.get().universe?.armed).toBe(true);
  });

  it('★「TikTok Universe+」は巻き込まない(exactName の存在理由)', () => {
    const c = cfg();
    c.universe.rules = [structuredClone(DEFAULT_UNIVERSE_RULE)];
    const e = engine(c);
    e.start();
    e.handleEvent(uniGift({ giftId: '0', giftName: 'TikTok Universe+' }));
    expect(e.get().universe ?? null).toBeNull();
  });

  it('exactName を外すと Universe+ にも当たってしまう(対偶 — ガードが効いている証明)', () => {
    const c = cfg();
    c.universe.rules = [{ ...structuredClone(DEFAULT_UNIVERSE_RULE), exactName: false }];
    const e = engine(c);
    e.start();
    e.handleEvent(uniGift({ giftId: '0', giftName: 'TikTok Universe+' }));
    expect(e.get().universe?.armed).toBe(true);
  });

  it('機能 enabled が false なら1行も評価しない', () => {
    const e = engine(cfg({ universe: { ...structuredClone(DEFAULT_UNIVERSE), enabled: false } }));
    e.start();
    e.handleEvent(uniGift());
    expect(e.get().universe ?? null).toBeNull();
    expect(e.get().value).toBe(START);
  });

  it('同じ giftId を革命にも登録した誤設定では**革命が勝つ**(安全側)', () => {
    const c = cfg({
      revolution: {
        ...structuredClone(DEFAULT_REVOLUTION),
        enabled: true,
        rules: [{ ...structuredClone(DEFAULT_REVOLUTION_RULE), giftId: UNI_GIFT_ID, giftName: '' }],
      },
    });
    const e = engine(c);
    e.start();
    e.handleEvent(uniGift());
    // 一撃クリアは評価すらされない = ランは終わらない。
    expect(e.get().universe ?? null).toBeNull();
    expect(kinds(e)).toContain('revolution-start');
  });
});

describe('アーム → コミット → 清算', () => {
  it('着弾はアームだけ(値も status も動かない)', () => {
    const e = arm(cfg());
    const s = e.get();
    expect(s.universe?.armed).toBe(true);
    expect(s.universe?.endsAtMs).toBe(0);
    expect(s.value).toBe(START);
    expect(s.status).toBe('running');
    expect(kinds(e)).toContain('universe-start');
  });

  it('アーム中のタップは**通常どおり効き**、その減った値が commit の起点になる', () => {
    // アーム中(最長120秒)にボタンを殺すと 44,999💎 の着弾から無反応になる。
    const e = arm(cfg());
    e.press();
    e.press();
    expect(e.get().value).toBe(START - 2);
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    expect(e.get().universe?.fromValue).toBe(START - 2);
  });

  it('cue で 25 秒の時計が入る(armed は落ちる)', () => {
    const e = arm(cfg());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    const u = e.get().universe!;
    expect(u.armed).toBeUndefined();
    expect(u.startsAtMs).toBe(NOW);
    expect(u.endsAtMs).toBe(NOW + UNIVERSE_TOTAL_MS);
    expect(u.fromValue).toBe(START);
    // 値はまだ動かない(清算は 25 秒後)。
    expect(e.get().value).toBe(START);
  });

  it('id 違いの cue / アーム無しの cue は無視される(冪等)', () => {
    const e = arm(cfg());
    expect(e.universeCue({ action: 'start', effectId: 999, startedAtMs: NOW })).toBe(false);
    expect(e.get().universe?.armed).toBe(true);
    const e2 = engine(cfg());
    e2.start();
    expect(e2.universeCue({ action: 'start', effectId: 1, startedAtMs: NOW })).toBe(false);
  });

  it('★ 清算は 2Hz tick に依存しない — タイマーだけで 0 と CLEAR に到達する', () => {
    // 配信終了・切断・リプレイ終了で drainIfChanged が死ぬ経路の 100% 再現。
    // armFreezeTimer への登録漏れはここでしか捕まらない。
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = arm(cfg(), () => t);
      e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: t });
      // 清算の瞬間まで — **drainIfChanged を一度も呼ばない**。
      t = NOW + UNIVERSE_TOTAL_MS + 50;
      vi.advanceTimersByTime(UNIVERSE_TOTAL_MS + 50);
      expect(e.get().value).toBe(0);
      expect(kinds(e)).toContain('universe-end');
      // まだ凍結中なので CLEAR はここでは出ない(= 締めのカットインの上に出ない)。
      expect(e.get().status).toBe('running');
      // 凍結が明ける = 締めのカットインが終わった後。
      t = NOW + UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 100;
      vi.advanceTimersByTime(GIFT_FX_FREEZE_MARGIN_MS + 100);
      expect(e.get().status).toBe('achieved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('★ 順序の構造保証 — universe-start < universe-end < achieved', () => {
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = arm(cfg(), () => t);
      e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: t });
      t = NOW + UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 100;
      vi.advanceTimersByTime(UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 100);
      const fx = e.get().recentEffects;
      const id = (k: string): number => fx.find((x) => x.kind === k)!.id;
      expect(id('universe-start')).toBeLessThan(id('universe-end'));
      expect(id('universe-end')).toBeLessThan(id('achieved'));
      // 締めのカットインより後 = 演出の終端以降に達成が出る。
      expect(fx.find((x) => x.kind === 'achieved')!.atMs).toBeGreaterThanOrEqual(
        NOW + UNIVERSE_TOTAL_MS
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('清算の会計 — amount / universeDownTotal / stats.universeDown が一致し -0 を作らない', () => {
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = arm(cfg(), () => t);
      e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: t });
      t = NOW + UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 100;
      vi.advanceTimersByTime(UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 100);
      const end = e.get().recentEffects.find((x) => x.kind === 'universe-end')!;
      expect(end.amount).toBe(-START);
      expect(end.universeDownTotal).toBe(START);
      expect(end.valueAfter).toBe(0);
      expect(e.get().stats.universeDown).toBe(START);
      // giftDown へは混ぜない(ダッシュボードの検算を壊さない)。
      expect(e.get().stats.giftDown).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('アーム期限切れは破棄せず強制発動(2Hz tick 無しで到達する)', () => {
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = arm(cfg(), () => t);
      t = NOW + UNIVERSE_ARM_MAX_MS + UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 200;
      vi.advanceTimersByTime(UNIVERSE_ARM_MAX_MS + UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 200);
      expect(e.get().value).toBe(0);
      expect(e.get().status).toBe('achieved');
    } finally {
      vi.useRealTimers();
    }
  });

  it('drop はプレーン即クリアへ倒す(破棄しない)— effectId 0 でも効く', () => {
    const e = arm(cfg());
    expect(e.universeCue({ action: 'drop', effectId: 0 })).toBe(true);
    expect(e.get().value).toBe(0);
    expect(e.get().status).toBe('achieved');
  });

  it('プレーンモード(モニター不在)は演出なしで即 0 + CLEAR', () => {
    const e = plain(cfg());
    e.start();
    e.handleEvent(uniGift());
    expect(e.get().value).toBe(0);
    expect(e.get().status).toBe('achieved');
    const start = e.get().recentEffects.find((x) => x.kind === 'universe-start')!;
    expect(start.fxDurationMs ?? 0).toBe(0);
    // 順序はプレーンでも保つ。
    const id = (k: string): number => e.get().recentEffects.find((x) => x.kind === k)!.id;
    expect(id('universe-start')).toBeLessThan(id('universe-end'));
    expect(id('universe-end')).toBeLessThan(id('achieved'));
  });

  it('走行中にモニターが閉じたら待たずに即清算する', () => {
    const e = arm(cfg());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    e.setMonitorOpen(false);
    expect(e.get().value).toBe(0);
    expect(e.get().status).toBe('achieved');
  });

  it('重ねがけは冪等(2発目は何も起こさない)', () => {
    const e = arm(cfg());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    const before = e.get().universe!.endsAtMs;
    e.handleEvent(uniGift());
    expect(e.get().universe!.endsAtMs).toBe(before);
    expect(e.get().value).toBe(START);
  });
});

describe('バリア(全 op を清算後へ)', () => {
  /** 走行中に色々投げて、値が1も動かないことを見る。 */
  function barrierEngine(): ChallengeEngine {
    const c = cfg();
    // 素ギフト・いいね・コメント妨害が値を動かす設定にしておく(バリアの検出器)。
    c.giftDefault = { mode: 'fixed', amount: 5 };
    c.likeEvery = 1;
    c.likeStep = 3;
    c.commentRules = [{ id: 'cr1', keyword: 'ばか', amount: 7 }];
    const e = engine(c);
    e.start();
    e.handleEvent(uniGift());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    return e;
  }

  it('★ fx を持たない値変更 op も止まる(革命式の「fx 付きだけ」では足りない)', () => {
    const e = barrierEngine();
    e.handleEvent(otherGift());
    e.handleEvent(like(3));
    e.handleEvent(comment('ばか'));
    // 25 秒の減算連打は「commit 時点の残量 N を 0 まで削る」絵なので、
    // 途中で N が動くとカウントダウンの意味そのものが壊れる。
    expect(e.get().value).toBe(START);
  });

  it('溜まった演出は fxQueue に barrier 印で予告される', () => {
    const e = barrierEngine();
    e.handleEvent(otherGift());
    const q = e.get().fxQueue ?? [];
    expect(q.length).toBeGreaterThan(0);
    expect(q.every((x) => x.barrier === true)).toBe(true);
  });

  it('溜め分は達成で破棄される(清算後に幽霊発動しない)', () => {
    vi.useFakeTimers();
    try {
      let t = NOW;
      const c = cfg();
      c.giftDefault = { mode: 'fixed', amount: 5 };
      const e = engine(c, () => t);
      e.start();
      e.handleEvent(uniGift());
      e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: t });
      e.handleEvent(otherGift());
      t = NOW + UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 200;
      vi.advanceTimersByTime(UNIVERSE_TOTAL_MS + GIFT_FX_FREEZE_MARGIN_MS + 200);
      expect(e.get().status).toBe('achieved');
      // 達成後に溜め分が効いて 0 から動く、が起きない。
      expect(e.get().value).toBe(0);
      expect(e.get().fxQueue ?? []).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('press(走行中のタップは破棄)', () => {
  it('走行中のタップは値も stats.presses も動かさず blocked だけ増える', () => {
    const e = arm(cfg());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    e.press();
    e.press();
    e.press();
    expect(e.get().value).toBe(START);
    expect(e.get().stats.presses).toBe(0);
    expect(e.get().universe!.blocked).toBe(3);
  });

  it('最終ゲートのリングは走行中に出さない(押しても進まないリングを作らない)', () => {
    const c = cfg({ initialValue: 5, lowThreshold: 10 });
    c.finalGate = { enabled: true, taps: 30 };
    const e = engine(c);
    e.start();
    e.handleEvent(uniGift());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    expect(e.get().gauntlet ?? null).toBeNull();
  });
});

describe('出口の網羅', () => {
  it('stop は演出途中でも値を 0 にしない(「値を残す」規約)', () => {
    const e = arm(cfg());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    e.stop();
    expect(e.get().value).toBe(START);
    expect(e.get().universe ?? null).toBeNull();
    expect(kinds(e)).not.toContain('universe-end');
  });

  it('reset で全部消える', () => {
    const e = arm(cfg());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    e.reset();
    expect(e.get().universe ?? null).toBeNull();
    expect(e.get().value).toBe(START);
  });

  it('start(新ラン)で前ランのアームを持ち込まない', () => {
    const e = arm(cfg());
    e.start();
    expect(e.get().universe ?? null).toBeNull();
  });

  it('機能だけ OFF にすると畳まれ、**カウントは 0 にならない**', () => {
    const c = cfg();
    const e = engine(c);
    e.start();
    e.handleEvent(uniGift());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    c.universe.enabled = false;
    e.onConfigChanged();
    expect(e.get().universe ?? null).toBeNull();
    expect(e.get().value).toBe(START);
    // 一度も 0 になっていないので「終了」は積まない。
    expect(kinds(e)).not.toContain('universe-end');
  });

  it('チャレンジ全体 OFF も逃げ道になる', () => {
    const c = cfg();
    const e = engine(c);
    e.start();
    e.handleEvent(uniGift());
    e.universeCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW });
    c.enabled = false;
    e.onConfigChanged();
    expect(e.get().universe ?? null).toBeNull();
  });
});

describe('▶テスト実演', () => {
  it('値・statsに触れず、achieved も出さない', () => {
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = engine(cfg(), () => t);
      e.start();
      const r = e.testEffect({ kind: 'universe' });
      expect(r.previewMs).toBe(UNIVERSE_TOTAL_MS);
      expect(e.get().universe?.test).toBe(true);
      expect(e.get().universe?.armed).toBeUndefined(); // armed は絶対に立てない
      expect(e.get().universe?.fromValue).toBe(START);
      t = NOW + UNIVERSE_TOTAL_MS + 200;
      vi.advanceTimersByTime(UNIVERSE_TOTAL_MS + 200);
      expect(e.get().value).toBe(START);
      expect(e.get().status).toBe('running');
      expect(kinds(e)).not.toContain('achieved');
      expect(kinds(e)).toContain('universe-end');
    } finally {
      vi.useRealTimers();
    }
  });

  it('実発動は実演を破棄する(実発動のタップが実演カウンタへ吸われない)', () => {
    const e = engine(cfg());
    e.start();
    e.testEffect({ kind: 'universe' });
    e.handleEvent(uniGift());
    expect(e.get().universe?.test).toBeUndefined();
    expect(e.get().universe?.armed).toBe(true);
  });
});
