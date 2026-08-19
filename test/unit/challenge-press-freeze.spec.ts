/**
 * 「カウントダウン走行中はタップが必ず効く」の契約。
 *
 * 押下は**カットイン凍結を素通しして値へ即時に効く**。保留キューへ落としていた頃は
 * カットイン1本で最長 15 秒・連鎖で最大 45 秒ぶん数字が1も動かず、配信者からは
 * ボタンが死んで見えた(これが実配信での最大の苦情)。
 *
 * ただし演出は分ける — 凍結中の押下 SE と簡易演出はカットインの音と絵に重なるうえ、
 * 1タップ1 effect ではリングバッファを連打で押し流して待っている演出を落とす。
 * よって「値は即時・演出は凍結明けに合算1件」。達成も凍結明け(達成演出が
 * 再生中のカットインに重ならないように)。
 *
 * challenge.spec.ts と分けたのは、こちらが**押下と凍結の交差点だけ**を見る
 * 回帰網だから(challenge-longrun.spec.ts と同じ切り出し方)。
 *
 * 【例外】お邪魔(タップ封じ)だけはこの契約を意図的に上書きする — 封印中の押下は
 * 凍結を素通しせず、値も統計も動かさずに**捨てられる**。封印は演出の遅延ではなく
 * ゲームの状態そのものだから。その交差点は tap-lock-press.spec.ts が持つ。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  GIFT_FX_FREEZE_MARGIN_MS,
  TAP_BOOST_COUNT_MS,
  TAP_BOOST_INTRO_MS,
} from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
/** band1(30💎)のカットイン尺 + margin = 凍結が明ける時刻。 */
const BAND_MS = 6000;
const RELEASE = NOW + BAND_MS + GIFT_FX_FREEZE_MARGIN_MS;

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 全面カットは既定行が「バラ」に一致して別の凍結を張るので落とす。
  // 帯域カットイン(凍結を張る側)はこのファイルの主役なので既定のまま有効。
  base.giftFullCut.enabled = false;
  base.giftBandFx = structuredClone(DEFAULT_GIFT_BAND_FX);
  base.roulettes = [];
  // 最終ゲート(既定オン)は落とす — lowThreshold 以下の押下の意味が変わり、
  // 0 到達クランプを見るこのファイルのテストが成立しなくなる。
  base.finalGate.enabled = false;
  return { ...base, enabled: true, initialValue: 1000, pressStep: 1, ...over };
}

function engine(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  // 凍結は「モニターが開いていてカットインを再生できる」ときだけ張られる。
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

/** band1 に一致する 30💎 のギフト(= 6 秒の凍結を張る)。 */
function bandGift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `m${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `u${seq}` },
    giftId: '999999',
    giftName: 'NoMatch',
    repeatCount: 1,
    diamondEach: 30,
    diamonds: 30,
    isBoxGift: false,
    ...over,
  };
}

function follow(userId: string): SocialEvent {
  seq += 1;
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `f${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: userId },
  };
}

describe('押下は凍結を素通しする — 値は即時', () => {
  it('カットイン中でも1タップぶんその場で減り、pressDownTotal に載る', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(bandGift());
    expect(e.get().fxFreezeUntilMs).not.toBeNull();
    e.press();
    e.press();
    const s = e.get();
    expect(s.value).toBe(1030 - 2);
    expect(s.stats.presses).toBe(2);
    expect(s.pressDownTotal).toBe(2);
  });

  it('保留キューには積まれない — 演出予告(fxQueue)にも出ない', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(bandGift());
    for (let i = 0; i < 5; i += 1) e.press();
    // fxQueue はカットイン級の保留だけ。押下はそもそも保留されない。
    expect(e.get().fxQueue).toBeUndefined();
  });

  it('視聴者由来のイベントは従来どおり保留される(押下だけの特例)', () => {
    let t = NOW;
    const e = engine(cfg({ followStep: 10 }), () => t);
    e.start();
    e.handleEvent(bandGift());
    e.handleEvent(follow('f1'));
    e.press();
    expect(e.get().value).toBe(1029); // 押下だけが効いている
    expect(e.get().stats.follows).toBe(0);
    t = RELEASE;
    expect(e.drainIfChanged()!.value).toBe(1039); // 解除で follow の +10 が乗る
  });
});

describe('押下の演出は凍結明けに合算1件', () => {
  it('凍結中は press effect を積まず、解除で1件だけ出す(coalesced)', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(bandGift());
    for (let i = 0; i < 12; i += 1) e.press();
    expect(e.get().recentEffects.some((x) => x.kind === 'press')).toBe(false);
    t = RELEASE;
    const s = e.drainIfChanged()!;
    const presses = s.recentEffects.filter((x) => x.kind === 'press');
    expect(presses).toHaveLength(1);
    expect(presses[0]).toMatchObject({ amount: -12, coalesced: 12, valueAfter: 1018 });
  });

  it('1タップだけなら coalesced は付かない(1件グループの既存規約)', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(bandGift());
    e.press();
    t = RELEASE;
    const p = e.drainIfChanged()!.recentEffects.find((x) => x.kind === 'press')!;
    expect(p).toMatchObject({ amount: -1 });
    expect(p).not.toHaveProperty('coalesced');
  });

  it('凍結していなければ従来どおり1タップ1件で即時に出る', () => {
    const e = engine(cfg());
    e.start();
    e.press();
    e.press();
    const s = e.get();
    expect(s.value).toBe(998);
    expect(s.recentEffects.filter((x) => x.kind === 'press')).toHaveLength(2);
  });

  it('stop は溜めた押下演出を捨てる(値は適用済みなので残る)', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(bandGift());
    e.press();
    e.press();
    const stopped = e.stop();
    expect(stopped.value).toBe(1028); // 値は残る
    t = RELEASE;
    e.drainIfChanged();
    // 停止後に押下音だけ鳴らさない。
    expect(e.get().recentEffects.some((x) => x.kind === 'press')).toBe(false);
  });
});

describe('凍結中に 0 到達 — 達成は演出が明けてから', () => {
  it('status は running のまま 0 を表示し、解除でまとめて達成する', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 3, pressStep: 1 }), () => t);
    e.start();
    // band1 は +30(既定 perDiamond)なので、まず凍結だけ張って値を戻しておく。
    e.handleEvent(bandGift());
    expect(e.get().value).toBe(33);
    for (let i = 0; i < 33; i += 1) e.press();
    const frozen = e.get();
    expect(frozen.value).toBe(0);
    expect(frozen.status).toBe('running'); // 演出中は達成にしない
    expect(frozen.result).toBeNull();
    expect(frozen.recentEffects.some((x) => x.kind === 'achieved')).toBe(false);

    t = RELEASE;
    const s = e.drainIfChanged()!;
    expect(s.status).toBe('achieved');
    expect(s.achievedMs).toBe(RELEASE);
    expect(s.result).not.toBeNull();
    // 押下音 → 達成の順(達成演出が押下音に潰されない・その逆もない)。
    const press = s.recentEffects.find((x) => x.kind === 'press')!;
    const achieved = s.recentEffects.find((x) => x.kind === 'achieved')!;
    expect(press.id).toBeLessThan(achieved.id);
  });

  it('0 到達後の連打は値も統計も動かさない(達成待ちの空押し)', () => {
    const e = engine(cfg({ initialValue: 1, pressStep: 1 }));
    e.start();
    e.handleEvent(bandGift()); // +30 → 31
    for (let i = 0; i < 31; i += 1) e.press();
    expect(e.get().value).toBe(0);
    const presses = e.get().stats.presses;
    for (let i = 0; i < 10; i += 1) e.press();
    expect(e.get().stats.presses).toBe(presses);
    expect(e.get().pressDownTotal).toBe(31);
  });

  it('保留ギフトが 0 から戻したら達成しない(判定はドレインの後)', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 3, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(bandGift()); // +30 → 33(凍結)
    e.handleEvent(follow('f1')); // 保留(+10)
    for (let i = 0; i < 33; i += 1) e.press();
    expect(e.get().value).toBe(0);
    t = RELEASE;
    const s = e.drainIfChanged()!;
    expect(s.value).toBe(10);
    expect(s.status).toBe('running'); // 妨害で戻ったので達成ではない
  });
});

describe('pressDownTotal — モニターの据え置き追従が読む累計', () => {
  it('start / reset で 0 に戻り、stop では残る', () => {
    const e = engine(cfg());
    e.start();
    e.press();
    expect(e.get().pressDownTotal).toBe(1);
    expect(e.stop().pressDownTotal).toBe(1);
    expect(e.reset().pressDownTotal).toBeUndefined(); // 0 はキーごと省く
    e.start();
    e.press();
    expect(e.get().pressDownTotal).toBe(1);
    expect(e.start().pressDownTotal).toBeUndefined();
  });

  it('0 でクランプされた押下は「実際に減った分」だけ載る', () => {
    const e = engine(cfg({ initialValue: 3, pressStep: 5 }));
    e.start();
    e.press(); // 3 - 5 → 0(実減少は 3)
    expect(e.get().value).toBe(0);
    expect(e.get().pressDownTotal).toBe(3);
  });

  it('フィーバーの一括清算では増えない(発表前に答えが漏れないように)', () => {
    let t = NOW;
    const BOOST_GIFT = '9999';
    const c = cfg({
      tapBoost: { ...DEFAULT_TAP_BOOST, rules: [{ ...DEFAULT_TAP_BOOST_RULE, giftId: BOOST_GIFT }] },
    });
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(bandGift({ giftId: BOOST_GIFT, giftName: 'Boost Gift', diamonds: 1, diamondEach: 1 }));
    const PRE = TAP_BOOST_INTRO_MS + TAP_BOOST_COUNT_MS;
    // フィーバーはアーム(予約)止まりで届く — モニターが起動カットインを
    // 再生し始めた合図(challenge.boostCue)で初めてタップ窓が開く。
    // これがないと渋滞時に 5 秒の咆哮が削られる(shared/boost-start.ts の冒頭)。
    e.boostCue({
      action: 'start',
      effectId: e.get().recentEffects.find((x) => x.kind === 'boost-start')!.id,
      startedAtMs: NOW,
      preMs: TAP_BOOST_INTRO_MS + TAP_BOOST_COUNT_MS,
    });
    t = NOW + PRE + 1000; // タップウィンドウ中
    for (let i = 0; i < 4; i += 1) e.press();
    expect(e.get().boost?.tapCount).toBe(4);
    expect(e.get().pressDownTotal).toBeUndefined(); // まだ1タップも「即時に」減らしていない
    t = NOW + PRE + DEFAULT_TAP_BOOST_RULE.durationSec * 1000 + 1;
    const s = e.drainIfChanged()!;
    expect(s.value).toBe(1000 - 4 * 5); // 清算で一括反映(倍率5)
    expect(s.pressDownTotal).toBeUndefined(); // 清算ぶんは載せない
  });

  it('フィーバーの起動カットイン中のタップは従来どおり保留(3・2・1 のフライング防止)', () => {
    let t = NOW;
    const BOOST_GIFT = '9999';
    const c = cfg({
      tapBoost: { ...DEFAULT_TAP_BOOST, rules: [{ ...DEFAULT_TAP_BOOST_RULE, giftId: BOOST_GIFT }] },
    });
    const e = engine(c, () => t);
    e.start();
    e.handleEvent(bandGift({ giftId: BOOST_GIFT, giftName: 'Boost Gift', diamonds: 1, diamondEach: 1 }));
    // フィーバーはアーム(予約)止まりで届く — モニターが起動カットインを
    // 再生し始めた合図(challenge.boostCue)で初めてタップ窓が開く。
    // これがないと渋滞時に 5 秒の咆哮が削られる(shared/boost-start.ts の冒頭)。
    e.boostCue({
      action: 'start',
      effectId: e.get().recentEffects.find((x) => x.kind === 'boost-start')!.id,
      startedAtMs: NOW,
      preMs: TAP_BOOST_INTRO_MS + TAP_BOOST_COUNT_MS,
    });
    t = NOW + 1000; // 咆哮の途中(ウィンドウはまだ開いていない)
    e.press();
    expect(e.get().value).toBe(1000); // 即時にはしない
    expect(e.get().boost?.tapCount).toBe(0); // 倍率も乗らない
  });
});
