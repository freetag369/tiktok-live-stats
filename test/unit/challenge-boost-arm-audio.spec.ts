/**
 * 「フィーバーのギフトが着弾してから起動カットインが始まるまで、タップの音が消える」
 * の契約(ユーザー報告 2026-08-19)。
 *
 * activateBoost は**アーム時点**(= ギフト着弾の瞬間・タップ窓はまだ開いていない)で
 * fxFreezeUntilMs を張る。これは applyOrQueue の連打直列化に必要なので外せない。
 * しかし押下 FX を畳む理由は「カットインの音と絵に重ねない」であって、**アーム中は
 * まだ何も映っていない**ので理由が存在しない。アームはモニターが実再生を始めるまで
 * (ルーレット連鎖の裏なら十数秒、最長 BOOST_ARM_MAX_MS = 60 秒)続くので、
 * その間ずっと押下が無音になっていた。
 *
 * 分離の述語は `fxCurtainUp() = isFxFrozen() && armedBoost === null`。
 * **使ってよいのは effect を出すか畳むかの判定だけ** — 値・stats・pressDownTotal・
 * maybeAchieve の先送りは従来どおり isFxFrozen() が決める(こちらへ寄せると
 * アーム中に 0 へ到達した押下がフィーバー前に CLEAR を出す)。
 *
 * 述語の健全性は「applyOrQueue が凍結中の critical op を積むか捨てるかしかしない」
 * ことに乗っている = activateBoost が走れた瞬間は必ず非凍結 = 幕は出ていない。
 * 将来ルーレットでも凍結を張るようにしたらこの前提が崩れる —
 * その検出器が下の「帯域カットインの凍結では従来どおり畳む」。
 *
 * 無音のもう半分(モニターが舞台待ちで映像を 2.7 秒遅らせる)は
 * boost-arm-silence.spec.ts が持つ。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  GIFT_FX_FREEZE_MARGIN_MS,
} from '@shared/challenge';
import type { ChallengeConfig, ChallengeEffect } from '@shared/dto';
import type { GiftEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 19, 12, 0, 0);
const BOOST_GIFT = '424242';
/** band1(30💎)のカットイン尺 + margin = 帯域凍結が明ける時刻。 */
const BAND_MS = 6000;
const RELEASE = NOW + BAND_MS + GIFT_FX_FREEZE_MARGIN_MS;

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 全面カットの既定行は「バラ」に一致して別の凍結を張るので落とす。
  base.giftFullCut.enabled = false;
  base.giftBandFx = structuredClone(DEFAULT_GIFT_BAND_FX);
  base.roulettes = [];
  // 最終ゲートは既定オン。閾値以下の押下の意味が変わるので、基本形では落として
  // 通常経路を見る(ゲート経路は専用の describe で別に張る)。
  base.finalGate.enabled = false;
  return {
    ...base,
    enabled: true,
    initialValue: 1000,
    pressStep: 1,
    tapBoost: {
      ...DEFAULT_TAP_BOOST,
      enabled: true,
      rules: [{ ...DEFAULT_TAP_BOOST_RULE, giftId: BOOST_GIFT }],
    },
    ...over,
  };
}

function engine(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(
    () => c,
    now,
    () => 0,
    () => 0,
    () => undefined
  );
  // 凍結は「モニターが開いていてカットインを再生できる」ときだけ張られる。
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

function boostGift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `b${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `u${seq}` },
    giftId: BOOST_GIFT,
    giftName: 'Boost Gift',
    repeatCount: 1,
    diamondEach: 299,
    diamonds: 299,
    isBoxGift: false,
    ...over,
  };
}

/** band1 に一致する 30💎 のギフト(= ブースト非依存の凍結を張る)。 */
function bandGift(): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `m${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `v${seq}`, nickname: `v${seq}` },
    giftId: '999999',
    giftName: 'NoMatch',
    repeatCount: 1,
    diamondEach: 30,
    diamonds: 30,
    isBoxGift: false,
  };
}

const pressesOf = (e: ChallengeEngine): ChallengeEffect[] =>
  e.get().recentEffects.filter((x) => x.kind === 'press');

describe('アーム中(幕が上がる前)の押下は音を出す', () => {
  it('アーム直後は凍結しているがタップ窓は開いていない', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(boostGift());
    const s = e.get();
    expect(s.fxFreezeUntilMs).not.toBeNull();
    // 窓が開くのは boostCue(モニターの実再生開始)から。既存のタップ音ミラーは
    // この boost キーを見ているので、アーム中は鳴らせない = worker が出すしかない。
    expect(s.boost).toBeUndefined();
  });

  it('press ごとに press effect が出る(畳まれない)', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(boostGift());
    e.press();
    e.press();
    e.press();
    const fx = pressesOf(e);
    expect(fx).toHaveLength(3);
    for (const f of fx) expect(f.amount).toBe(-1);
    // 値の意味論は不変(押下は凍結を素通しして即時に効く)。
    const s = e.get();
    expect(s.value).toBe(1000 - 3);
    expect(s.pressDownTotal).toBe(3);
    expect(s.stats.presses).toBe(3);
  });

  it('【前提の検出器】帯域カットインの凍結では従来どおり1件へ畳む', () => {
    // ブーストが絡まない凍結 = 幕が実際に出ている。ここまで解禁してしまうと
    // カットインの音と絵に押下音が重なる(fxCurtainUp を !isFxFrozen() へ
    // 広げる誤りはここで赤くなる)。
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(bandGift());
    expect(e.get().fxFreezeUntilMs).not.toBeNull();
    e.press();
    e.press();
    e.press();
    expect(pressesOf(e)).toHaveLength(0);
    t = RELEASE;
    e.drainIfChanged();
    const fx = pressesOf(e);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.coalesced).toBe(3);
    expect(fx[0]!.amount).toBe(-3);
  });

  it('コミット(実再生開始)後の起動カットイン中は従来どおり無音', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(boostGift());
    const armed = e.get().recentEffects.find((x) => x.kind === 'boost-start');
    expect(armed, 'boost-start effect が無い').toBeTruthy();
    e.boostCue({ action: 'start', effectId: armed!.id, startedAtMs: NOW, preMs: 8000 });
    const before = pressesOf(e).length;
    e.press();
    e.press();
    // 3・2・1 は「まだ押す時間ではない」合図。ここは applyOrQueue 行きのまま。
    expect(pressesOf(e).length).toBe(before);
  });
});

describe('凍結の意味論は変えていない', () => {
  it('アーム中に 0 へ到達しても達成は先送りされる', () => {
    const e = engine(cfg({ initialValue: 2 }));
    e.start();
    e.handleEvent(boostGift());
    e.press();
    e.press();
    e.press(); // 0 到達後の余分な1発
    const s = e.get();
    expect(s.value).toBe(0);
    // 達成は凍結明け(flushFxFreeze の末尾)に出す規約。アーム中に CLEAR を
    // 出してしまうとフィーバーの前にリザルトが生える。
    expect(s.status).toBe('running');
    expect(s.recentEffects.some((x) => x.kind === 'achieved')).toBe(false);
    // 0 到達後の押下は値も統計も動かさない(既存ガードが生きている)。
    expect(s.stats.presses).toBe(2);
    expect(s.pressDownTotal).toBe(2);
  });
});

describe('トリガーギフトそのもの', () => {
  it('boost-start を1件だけ出し、gift の effect は1件も出さない', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(boostGift());
    const fx = e.get().recentEffects;
    const boosts = fx.filter((x) => x.kind === 'boost-start');
    expect(boosts).toHaveLength(1);
    // giftOp は matchTapBoost 一致で増減規則もバナーも通さず return する。
    // = 着弾音は useChallengeSe の boost-start 枝でしか鳴らせない。
    expect(fx.some((x) => x.kind === 'gift')).toBe(false);
    // ティア音を引くのに diamonds が要る。
    expect(boosts[0]!.diamonds).toBe(299);
  });

  it('連打(repeatCount 3)でも boost-start は1件、残りは保留予告に出る', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(boostGift({ repeatCount: 3, diamonds: 299 * 3 }));
    expect(e.get().recentEffects.filter((x) => x.kind === 'boost-start')).toHaveLength(1);
    // 1本目が凍結を張るので 2本目以降は pendingOps 行き = アーム時の凍結を
    // 外す誤修正はここで赤くなる。
    expect(e.get().fxQueue?.length).toBe(2);
  });
});

describe('最終ゲート(ラスト◯◯モード)中のアームでも音が出る', () => {
  const gateCfg = () =>
    cfg({
      initialValue: 5,
      lowThreshold: 10,
      finalGate: { enabled: true, taps: 2 },
    });

  it('ゲート完成の1件はアーム中でも畳まれない', () => {
    const e = engine(gateCfg());
    e.start();
    e.handleEvent(boostGift());
    e.press(); // 蓄積のみ(値は動かない)
    expect(e.get().value).toBe(5);
    e.press(); // taps 到達 → 1 減算 + effect
    const fx = pressesOf(e);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.finalGate).toBe(true);
    expect(fx[0]!.amount).toBe(-1);
    expect(e.get().value).toBe(4);
  });

  it('帯域カットインの凍結中は従来どおり畳む(ゲート経路も対称)', () => {
    let t = NOW;
    const e = engine(gateCfg(), () => t);
    e.start();
    e.handleEvent(bandGift());
    e.press();
    e.press(); // taps 到達
    expect(pressesOf(e)).toHaveLength(0);
    t = RELEASE;
    e.drainIfChanged();
    expect(pressesOf(e)).toHaveLength(1);
  });
});
