import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_FAN_STAMP,
  DEFAULT_GIFT_BAND_FX,
  GIFT_FX_FREEZE_MARGIN_MS,
} from '@shared/challenge';
import { FAN_STAMP_FX_WINDOW_MS } from '@shared/fan-stamp';
import type { ChallengeConfig, ChallengeEffect } from '@shared/dto';
import type { GiftEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * お助け(ファンスタンプ)の合算窓の回帰テスト。
 *
 * 症状: 拍手のような1ダイヤのお助けギフトが続けて届くと `−1 ◯◯ がお助け!` の
 * 浮上バナーが1枚ずつ別々に流れる。実運用の設定では同じギフトに全面カットイン
 * (5秒)が割り当たっているため、凍結明けに保留分が1件ずつ再生されて
 * 「5秒カットイン × N 本 + バナー N 枚」になっていた。
 *
 * 修正の契約は2つだけ:
 *   1. **畳むのは見た目と音だけ** — 値・統計・ランキングはイベントごとに全件反映
 *   2. **先頭の1件は即時**(遅延ゼロ)、窓の中に届いたぶんは次の1枚にまとめる
 *
 * 新規ファイルにしたのは challenge.spec.ts が並行セッションの編集下にあるため。
 * ヘルパーは同ファイルの engine() / fanStamp() / fsCfg() と同じ形にしてある。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const V0 = DEFAULT_CHALLENGE.initialValue;

let seq = 0;

function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `m${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'g1', nickname: 'gifter' },
    giftId: '5655',
    giftName: 'Rose',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

/** ファンスタンプ想定のギフト(クリエイター専用カスタムギフト・1💎・streakable)。 */
function fanStamp(over: Partial<GiftEvent> = {}): GiftEvent {
  return gift({ giftId: '76637', giftName: 'おやすみトッポ', giftType: 1, ...over });
}

/** userId(= 人数の重複排除キー)を変えたお助け。 */
function fanStampFrom(userId: string, over: Partial<GiftEvent> = {}): GiftEvent {
  return fanStamp({ viewer: { userId, nickname: `名前${userId}` }, ...over });
}

function baseCfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定のカットイン系は「バラ」等に一致して凍結を張るので、明示的に有効化する
  // テスト以外では切る(challenge.spec.ts の cfg() と同じ理由)。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  return { ...base, enabled: true, ...over };
}

/** お助けを giftId '76637' に割り当てた設定(カットイン無し)。 */
function fsCfg(
  over: Partial<ChallengeConfig['fanStamp']> = {},
  c: Partial<ChallengeConfig> = {}
): ChallengeConfig {
  return baseCfg({
    fanStamp: { ...structuredClone(DEFAULT_FAN_STAMP), giftId: '76637', ...over },
    ...c,
  });
}

/**
 * お助けにカットインを許した設定(実運用の settings.json と同じ形 —
 * suppressBandFx:false + 帯域有効)。1💎 なので最下段の帯に落ちる。
 */
function fsBandCfg(over: Partial<ChallengeConfig['fanStamp']> = {}): ChallengeConfig {
  return fsCfg(
    { suppressBandFx: false, ...over },
    { giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX) }
  );
}

function engineAt(c: ChallengeConfig, clock: { t: number }): ChallengeEngine {
  const e = new ChallengeEngine(
    () => c,
    () => clock.t,
    Math.random,
    Math.random,
    () => undefined
  );
  // 凍結は「モニターが開いていてカットインを再生できる」ときだけ張られる。
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

/** gift 種の演出だけを古い順に取り出す(recentEffects は新しい順)。 */
function gifts(e: ChallengeEngine): ChallengeEffect[] {
  return e
    .get()
    .recentEffects.filter((x) => x.kind === 'gift')
    .reverse();
}

describe('お助け合算 — カットイン無し', () => {
  it('先頭の1件は即時に出る(遅延ゼロ)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStamp());
    const fx = gifts(e);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.fanStamp).toBe(true);
    expect(fx[0]!.amount).toBe(-1);
    // 1人ぶんなので合算の印は載らない = モニターは従来の1人文言へ倒れる。
    expect(fx[0]!.fanStampPeople).toBeUndefined();
    expect(fx[0]!.coalesced).toBeUndefined();
  });

  it('窓の中の2件目は effect にならず、値だけ動く', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a'));
    clock.t = NOW + 200;
    e.handleEvent(fanStampFrom('b'));
    expect(e.get().value).toBe(V0 - 2);
    expect(gifts(e)).toHaveLength(1); // まだ先頭の1件だけ
  });

  it('窓が明けたら尻が必ず1件出る(2Hz tick から)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a'));
    clock.t = NOW + 200;
    e.handleEvent(fanStampFrom('b'));
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS;
    e.drainIfChanged();
    const fx = gifts(e);
    expect(fx).toHaveLength(2);
    expect(fx[1]!.fanStamp).toBe(true);
    expect(fx[1]!.amount).toBe(-1);
    expect(fx[1]!.valueAfter).toBe(V0 - 2); // 値はその時点の現在値
  });

  it('窓内の3人ぶんが1件に畳まれる(人数・件数・総個数が別々に載る)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a')); // 先頭(即時)
    clock.t = NOW + 100;
    e.handleEvent(fanStampFrom('b'));
    clock.t = NOW + 200;
    e.handleEvent(fanStampFrom('c'));
    clock.t = NOW + 300;
    e.handleEvent(fanStampFrom('d'));
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS;
    e.drainIfChanged();

    const fx = gifts(e);
    // 先頭 + 尻 の2枚だけ(4件届いても4枚にならない)。
    expect(fx).toHaveLength(2);
    const tail = fx[1]!;
    expect(tail.amount).toBe(-3);
    expect(tail.coalesced).toBe(3); // メッセージ件数
    expect(tail.giftCount).toBe(3); // 総個数
    expect(tail.fanStampPeople).toBe(3); // 人数
    expect(tail.fanStampNames).toEqual(['名前b', '名前c', '名前d']);
    expect(e.get().value).toBe(V0 - 4);
  });

  it('同じ人が2回押しても人数は1(合算の印は載らず従来文言のまま)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a'));
    clock.t = NOW + 100;
    e.handleEvent(fanStampFrom('b'));
    clock.t = NOW + 200;
    e.handleEvent(fanStampFrom('b'));
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS;
    e.drainIfChanged();

    const tail = gifts(e)[1]!;
    expect(tail.coalesced).toBe(2); // 2メッセージ
    expect(tail.giftCount).toBe(2); // 2個
    expect(tail.fanStampPeople).toBeUndefined(); // 1人なので載せない
    expect(tail.fanStampNames).toBeUndefined();
    expect(tail.nickname).toBe('名前b');
  });

  it('連打(repeatCount>1)を含めても値・統計は畳まれず全件ぶん動く', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a')); // 1個
    clock.t = NOW + 100;
    e.handleEvent(fanStampFrom('b', { repeatCount: 3, diamonds: 3 })); // 3個
    clock.t = NOW + 200;
    e.handleEvent(fanStampFrom('c', { repeatCount: 2, diamonds: 2 })); // 2個
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS;
    e.drainIfChanged();

    const s = e.get();
    expect(s.value).toBe(V0 - 6);
    expect(s.stats.giftDown).toBe(6);
    expect(s.stats.giftUp).toBe(0);
    const tail = gifts(e)[1]!;
    expect(tail.amount).toBe(-5);
    expect(tail.giftCount).toBe(5); // 3 + 2
    expect(tail.coalesced).toBe(2); // メッセージは2件
  });

  it('ランキング(runRank)は畳まれず全員ぶん載る', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a', { diamonds: 5 }));
    clock.t = NOW + 100;
    e.handleEvent(fanStampFrom('b', { diamonds: 3 }));
    clock.t = NOW + 200;
    e.handleEvent(fanStampFrom('c', { diamonds: 1 }));
    const rank = e.get().runRank ?? [];
    expect(rank.map((r) => r.diamonds)).toEqual([5, 3, 1]);
  });

  it('窓が明けた後の次の1件はまた即時(tick を待たない)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a'));
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS + 1;
    e.handleEvent(fanStampFrom('b'));
    expect(gifts(e)).toHaveLength(2);
  });

  it('お助けでないギフトは従来どおり1件1演出(非回帰)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg({}, { giftDefault: { mode: 'fixed', amount: 5 } }), clock);
    e.start();
    e.handleEvent(gift({ giftId: '999', giftName: 'バラ' }));
    clock.t = NOW + 100;
    e.handleEvent(gift({ giftId: '999', giftName: 'バラ' }));
    const fx = gifts(e);
    expect(fx).toHaveLength(2);
    expect(fx.every((x) => x.fanStamp === undefined)).toBe(true);
  });
});

describe('お助け合算 — カットイン有り(実運用の設定と同じ形)', () => {
  it('拍手が5個来てもカットインは1本だけ・バナーは2枚・値は5件ぶん', () => {
    const clock = { t: NOW };
    const e = engineAt(fsBandCfg(), clock);
    e.start();

    e.handleEvent(fanStampFrom('a')); // 先頭 = カットイン + 凍結
    const head = gifts(e)[0]!;
    expect(head.fxBandClip).toBeTruthy();
    const freezeUntil = e.get().fxFreezeUntilMs;
    expect(freezeUntil).not.toBeNull();

    // 凍結中に4件。既存契約どおり値も保留される。
    for (const u of ['b', 'c', 'd', 'e']) {
      clock.t += 100;
      e.handleEvent(fanStampFrom(u));
    }
    expect(e.get().value).toBe(V0 - 1); // まだ先頭の1件しか適用されていない

    // 凍結明け → 保留分が1回のドレインで全部流れ、合算バナーが1枚出る。
    clock.t = freezeUntil! + 1;
    e.drainIfChanged();

    const fx = gifts(e);
    expect(fx).toHaveLength(2);
    const tail = fx[1]!;
    expect(tail.fanStamp).toBe(true);
    // **カットインは載らない** — 先頭が既に1本再生済み。
    expect(tail.fxBandClip).toBeUndefined();
    expect(tail.amount).toBe(-4);
    expect(tail.fanStampPeople).toBe(4);
    // **再凍結していない** = 5秒カットインが連鎖しない。
    expect(e.get().fxFreezeUntilMs).toBeNull();
    expect(e.get().value).toBe(V0 - 5);
    expect(e.get().stats.giftDown).toBe(5);
  });

  it('凍結中は尻を出さない(窓 = 凍結が明けるまで)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsBandCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a'));
    clock.t += 100;
    e.handleEvent(fanStampFrom('b'));
    // 凍結の途中で tick が回っても出ない。
    clock.t = NOW + 1000;
    e.drainIfChanged();
    expect(gifts(e)).toHaveLength(1);
  });

  it('ドレインを2回流しても合算バナーは増えない(冪等)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsBandCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a'));
    const freezeUntil = e.get().fxFreezeUntilMs!;
    for (const u of ['b', 'c']) {
      clock.t += 100;
      e.handleEvent(fanStampFrom(u));
    }
    clock.t = freezeUntil + 1;
    e.drainIfChanged();
    const n = gifts(e).length;
    clock.t += 10;
    e.drainIfChanged();
    expect(gifts(e)).toHaveLength(n);
    expect(e.get().stats.giftDown).toBe(3);
  });

  it('間に別のカットイン付きギフトが挟まってもお助けの尻は失われない', () => {
    const clock = { t: NOW };
    const e = engineAt(
      fsCfg(
        { suppressBandFx: false },
        {
          giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX),
          giftDefault: { mode: 'fixed', amount: 1 },
        }
      ),
      clock
    );
    e.start();
    e.handleEvent(fanStampFrom('a')); // 先頭 = カットイン + 凍結
    const freeze1 = e.get().fxFreezeUntilMs!;
    clock.t += 100;
    e.handleEvent(fanStampFrom('b')); // 合算へ
    clock.t += 100;
    // 別ギフト(カットイン付き)。凍結明けのドレインで再凍結して中断させる。
    e.handleEvent(gift({ giftId: '999', giftName: 'ドラゴン', diamonds: 30 }));

    clock.t = freeze1 + 1;
    e.drainIfChanged();
    // 再凍結していれば尻はまだ出ていない。明けたら必ず出る。
    const freeze2 = e.get().fxFreezeUntilMs;
    if (freeze2 != null) {
      clock.t = freeze2 + GIFT_FX_FREEZE_MARGIN_MS + 1;
      e.drainIfChanged();
    }
    const tail = gifts(e).find((x) => x.fanStamp === true && x.fxBandClip === undefined);
    expect(tail).toBeDefined();
    expect(tail!.amount).toBe(-1);
  });
});

describe('お助け合算 — 達成・停止', () => {
  it('0 到達では合算バナーが CLEAR より先に出る(id 順)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg({}, { initialValue: 3 }), clock);
    e.start();
    e.handleEvent(fanStampFrom('a')); // 3 → 2(先頭・即時)
    clock.t += 100;
    e.handleEvent(fanStampFrom('b')); // 2 → 1(合算へ)
    clock.t += 100;
    e.handleEvent(fanStampFrom('c')); // 1 → 0(ここで吐き切ってから achieved)

    const s = e.get();
    expect(s.value).toBe(0);
    const byId = [...s.recentEffects].sort((a, b) => a.id - b.id);
    const lastGift = byId.filter((x) => x.kind === 'gift').at(-1)!;
    const achieved = byId.find((x) => x.kind === 'achieved');
    expect(achieved).toBeDefined();
    expect(lastGift.id).toBeLessThan(achieved!.id);
    expect(lastGift.amount).toBe(-2); // b + c を畳んだ合算
  });

  it('stop() は合算待ちの演出を捨てるが値は残す', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a'));
    clock.t += 100;
    e.handleEvent(fanStampFrom('b'));
    e.stop();
    expect(e.get().value).toBe(V0 - 2);
    expect(gifts(e)).toHaveLength(1);
    // 停止後に tick が回っても掘り起こされない。
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS + 1000;
    e.drainIfChanged();
    expect(gifts(e)).toHaveLength(1);
  });

  it('reset() は窓ごと畳んで新ランに持ち込まない', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.handleEvent(fanStampFrom('a'));
    clock.t += 100;
    e.handleEvent(fanStampFrom('b'));
    e.reset();
    e.start();
    // 新ランの1件目は「先頭」= 即時に出る(前ランの窓を引き継がない)。
    clock.t += 100;
    e.handleEvent(fanStampFrom('c'));
    const fx = gifts(e);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.amount).toBe(-1);
    expect(fx[0]!.coalesced).toBeUndefined();
  });
});

describe('お助け合算 — 実演(▶)', () => {
  it('testEffect({kind:"fanStamp", multi:true}) は複数人バナーの印を載せる', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg({ amountEach: -1 }), clock);
    e.start();
    e.testEffect({ kind: 'fanStamp', multi: true });
    const s = e.get();
    expect(s.value).toBe(V0); // 実演は値・統計に触らない
    expect(s.stats.giftDown).toBe(0);
    const fx = s.recentEffects[0]!;
    expect(fx.fanStamp).toBe(true);
    expect(fx.fanStampPeople).toBe(5);
    expect(fx.fanStampNames).toHaveLength(3);
    expect(fx.amount).toBe(-6);
  });

  it('multi 無しの実演は従来どおり1人ぶん(印が載らない)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg({ amountEach: -3 }), clock);
    e.start();
    e.testEffect({ kind: 'fanStamp' });
    const fx = e.get().recentEffects[0]!;
    expect(fx.amount).toBe(-3);
    expect(fx.nickname).toBe('テスト');
    expect(fx.fanStampPeople).toBeUndefined();
  });

  it('実演は合算窓を張らない(直後の実イベントが遅れない)', () => {
    const clock = { t: NOW };
    const e = engineAt(fsCfg(), clock);
    e.start();
    e.testEffect({ kind: 'fanStamp' });
    e.handleEvent(fanStampFrom('a'));
    // 実演 + 実イベントで2件(実演が窓を張っていたら実イベントが畳まれて1件になる)。
    expect(gifts(e)).toHaveLength(2);
  });
});
