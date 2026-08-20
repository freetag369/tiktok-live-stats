/**
 * 革命(白鳥 / Swan 699💎)— **窓**そのものの契約。
 *
 * この機能は「タップが×N で即時に効く」と「いいね妨害が反転して減算になる」の
 * 2つを1つの窓で同時に切り替える。つまり窓の**開く瞬間と閉じる瞬間が仕様の本体**で、
 * 演出は後付けの飾りにすぎない。ここで固定するのはその境界だけ:
 *
 *   着弾 = アームだけ(窓はまだ)→ モニターの実再生合図(revolutionCue)で
 *   前置き(導入6秒 + カウント5秒)ぶん先の時刻にコミット → 窓 → 期限で自動解除
 *
 * フィーバー(tapBoost)の設計をそのまま鏡像にしているが、**drop の扱いだけ違う** —
 * あちらは「演出も効果も無かったことにする」、こちらは**プレーン即発動へ倒す**。
 * 699💎 の課金ギフトの効果はゲームの状態であって演出ではないので、モニターの都合
 * (キュー溢れ・再読み込み)で消えてはいけない。
 *
 * モニター側(導入カットイン・5..1・走行 HUD)は別ファイルの担当。ここは worker だけ。
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BOOST_ARM_MAX_MS,
  DEFAULT_CHALLENGE,
  DEFAULT_REVOLUTION,
  DEFAULT_REVOLUTION_RULE,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  DEFAULT_TAP_LOCK,
  DEFAULT_TAP_LOCK_RULE,
  GIFT_FX_FREEZE_MARGIN_MS,
  LIKE_FX_WINDOW_MS,
  REVOLUTION_ACTIVATIONS_MAX,
  REVOLUTION_COUNT_MS,
  REVOLUTION_INTRO_MS,
  REVOLUTION_MAX_MS,
  matchRevolution,
  revolutionActivationCount,
} from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent, LikeEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 20, 12, 0, 0);
/** 白鳥の giftId は**未採取**(既定行は giftName 一致が本線)。テストの器としてだけ使う。 */
const REV_GIFT_ID = '698698';
const DUR_SEC = DEFAULT_REVOLUTION_RULE.durationSec; // 既定 60 秒
const DUR_MS = DUR_SEC * 1000;
/** シネマの前置き = 導入全面カット + 5..1 カウントダウン。窓はこのぶん後ろで開く。 */
const PRE_MS = REVOLUTION_INTRO_MS + REVOLUTION_COUNT_MS; // 11_000
const MULT = DEFAULT_REVOLUTION_RULE.multiplier; // 既定 ×3

let seq = 0;

/**
 * 既定行(白鳥)をそのまま使う設定。**giftName 'swan' の完全一致が本線**なので、
 * 行は差し替えず尺だけ引数で振る — 出荷される既定そのものを検査したい。
 */
function cfg(over: Partial<ChallengeConfig> = {}, durationSec = DUR_SEC): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定の全面カットは「バラ」に一致して別の凍結を張るので落とす(他の spec と同じ)。
  base.giftFullCut.enabled = false;
  base.roulettes = [];
  // 最終ゲートは既定オン。窓中の1タップの意味が変わるので基本形では落とし、
  // ゲート免除は専用の describe で明示的に張る。
  base.finalGate.enabled = false;
  return {
    ...base,
    enabled: true,
    initialValue: 1000,
    pressStep: 1,
    revolution: {
      ...structuredClone(DEFAULT_REVOLUTION),
      // **既定は false**(tapLock と同じ向き)。テストでは明示的に入れる。
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_REVOLUTION_RULE), durationSec }],
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

/** モニター不在(fxAllowed=false)= プレーン経路(演出なし・前置きなし・即窓オープン)。 */
function plain(c: ChallengeConfig, now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(false);
  e.setFxCaps(false);
  return e;
}

/** 白鳥。giftName はラテン文字で届く(日本限定ギフトも同じ)ので 'Swan' で一致する。 */
function revGift(over: Partial<GiftEvent> = {}): GiftEvent {
  seq += 1;
  return {
    kind: 'gift',
    msgId: `r${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: `u${seq}`, nickname: `視聴者${seq}` },
    giftId: REV_GIFT_ID,
    giftName: 'Swan',
    repeatCount: 1,
    diamondEach: 699,
    diamonds: 699,
    isBoxGift: false,
    ...over,
  };
}

function like(count: number, over: Partial<LikeEvent> = {}): LikeEvent {
  seq += 1;
  return {
    kind: 'like',
    msgId: `l${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'liker', nickname: 'いいねの人' },
    count,
    ...over,
  };
}

/** 直近の revolution-start の effect id(cue の照合キー)。 */
const startFxId = (e: ChallengeEngine): number =>
  e.get().recentEffects.find((x) => x.kind === 'revolution-start')!.id;

/** プレーンで窓を開く(開始 → 白鳥1個)。戻りは窓が開いた時刻。 */
function openPlain(e: ChallengeEngine): ChallengeEngine {
  e.start();
  e.handleEvent(revGift());
  return e;
}

describe('ギフトの一致 — 既定行は白鳥のギフト名(giftId は未採取)', () => {
  it('既定行は giftId 空 + giftName swan + exactName true', () => {
    // 実配信で採取していない giftId を推測で焼かない規約(gift-aliases の _topGifts)。
    expect(DEFAULT_REVOLUTION_RULE.giftId).toBe('');
    expect(DEFAULT_REVOLUTION_RULE.giftName).toBe('swan');
    // 'swan' は短い。部分一致だと 'black swan' 等に誤爆し、1分間ゲーム経済が変わる。
    expect(DEFAULT_REVOLUTION_RULE.exactName).toBe(true);
  });

  it('完全一致だけ拾う(Swan は一致・Black Swan は不一致)', () => {
    const c = cfg();
    expect(matchRevolution(c, { giftId: 'x', giftName: 'Swan' })?.id).toBe('rev-1');
    expect(matchRevolution(c, { giftId: 'x', giftName: ' swan ' })?.id).toBe('rev-1'); // trim される
    expect(matchRevolution(c, { giftId: 'x', giftName: 'Black Swan' })).toBeNull();
  });

  it('機能スイッチ(revolution.enabled)は既定 false で、OFF なら1行も評価しない', () => {
    // いいねの反転はゲーム経済の意味を変えるので、キー欠損のフォールバックで
    // 勝手に有効化されてはならない(DEFAULT_TAP_LOCK と同じ判断)。
    expect(DEFAULT_REVOLUTION.enabled).toBe(false);
    expect(DEFAULT_REVOLUTION.rules).toHaveLength(1);
    const c = cfg();
    c.revolution.enabled = false;
    expect(matchRevolution(c, { giftId: 'x', giftName: 'Swan' })).toBeNull();
    const e = plain(c);
    e.start();
    e.handleEvent(revGift());
    expect(e.get().revolution).toBeUndefined();
    expect(e.get().recentEffects.some((x) => x.kind === 'revolution-start')).toBe(false);
  });

  it('連打の本数は REVOLUTION_ACTIVATIONS_MAX で丸める(窓は直列化できないので尺に掛ける)', () => {
    expect(revolutionActivationCount(0)).toBe(1);
    expect(revolutionActivationCount(1)).toBe(1);
    expect(revolutionActivationCount(17)).toBe(REVOLUTION_ACTIVATIONS_MAX);
  });
});

describe('発動 — worker はアームするだけ(窓はモニターの合図で開く)', () => {
  it('着弾した瞬間はまだ窓が無い(revolution-start だけが出る)', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(revGift());
    const s = e.get();
    // ChallengeState.revolution が窓の唯一の権威。アーム中は載らない。
    expect(s.revolution).toBeUndefined();
    const fx = s.recentEffects.find((x) => x.kind === 'revolution-start');
    expect(fx).toBeDefined();
    expect(fx!.revolutionMultiplier).toBe(MULT);
    expect(fx!.revolutionMs).toBe(DUR_MS);
    expect(fx!.revolutionIntroMs).toBe(REVOLUTION_INTRO_MS);
    expect(fx!.revolutionCountMs).toBe(REVOLUTION_COUNT_MS);
    // 全画面を張るのは前置きだけ — 窓の 60 秒は通常走行(凍結しない)。
    expect(fx!.fxDurationMs).toBe(PRE_MS);
    // フォールバックのタイムライン: cue が来ないまま期限切れになったときの窓の終端。
    expect(fx!.revolutionEndsAtMs).toBe(NOW + BOOST_ARM_MAX_MS + PRE_MS + DUR_MS);
    // 暫定の凍結は「アーム期限 + 前置き」まで。cue が来たら短縮方向に張り直される。
    expect(s.fxFreezeUntilMs).toBe(NOW + BOOST_ARM_MAX_MS + PRE_MS + GIFT_FX_FREEZE_MARGIN_MS);
  });

  it('トリガーギフト自身は値を動かさない(増減規則もルーレットも通らない)', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(revGift());
    // 既定の giftDefault は perDiamond +1 = 699 加算。先勝ちで評価されないこと。
    expect(e.get().value).toBe(1000);
    expect(e.get().recentEffects.some((x) => x.kind === 'gift')).toBe(false);
  });

  it('モニター不在(fxAllowed=false)はプレーン即発動 — 前置きゼロで窓が開く', () => {
    const e = plain(cfg());
    e.start();
    e.handleEvent(revGift({ viewer: { userId: 'v1', nickname: 'なまえ' } }));
    const s = e.get();
    // 配信フォーマットは絶対時刻のみ・非アクティブ時はキーごと省く(tapLock と同じ規約)。
    expect(s.revolution).toEqual({
      startsAtMs: NOW,
      endsAtMs: NOW + DUR_MS,
      multiplier: MULT,
      nickname: 'なまえ',
      label: '白鳥',
    });
    // プレーンは凍結しない契約(映像が無いので待つ理由がない)。
    expect(s.fxFreezeUntilMs).toBeNull();
    const fx = s.recentEffects.find((x) => x.kind === 'revolution-start')!;
    expect(fx.revolutionIntroMs).toBe(0);
    expect(fx.revolutionCountMs).toBe(0);
    expect(fx.fxDurationMs).toBe(0); // モニターは revolutionWillStart=false でバナーだけ
    expect(fx.revolutionEndsAtMs).toBe(NOW + DUR_MS);
  });
});

describe('revolutionCue でコミット — 窓は「実再生開始 + 前置き」から', () => {
  it('start: startsAtMs = startedAtMs + preMs、endsAtMs = startsAtMs + 尺', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(revGift());
    const id = startFxId(e);
    // モニターが舞台待ちで 800ms 遅れて再生を始めた、の図。
    t = NOW + 800;
    expect(e.revolutionCue({ action: 'start', effectId: id, startedAtMs: t, preMs: PRE_MS })).toBe(true);
    const s = e.get();
    expect(s.revolution?.startsAtMs).toBe(t + PRE_MS);
    expect(s.revolution?.endsAtMs).toBe(t + PRE_MS + DUR_MS);
    // 暫定凍結(アーム期限起点)は必ず**短縮方向**に張り直される。凍結が窓オープン
    // まで引き戻ることで、導入中に溜めたタップが窓の頭でドレインされる。
    expect(s.fxFreezeUntilMs).toBe(t + PRE_MS + GIFT_FX_FREEZE_MARGIN_MS);
  });

  it('effectId が違う合図は無視する(遅れて届いた別演出の合図で冪等)', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(revGift());
    const id = startFxId(e);
    expect(e.revolutionCue({ action: 'start', effectId: id + 999, startedAtMs: NOW, preMs: PRE_MS })).toBe(
      false
    );
    expect(e.get().revolution).toBeUndefined(); // まだアームのまま
    // 正しい id なら開く。二重に撃っても2回目は armedRevolution が無いので false。
    expect(e.revolutionCue({ action: 'start', effectId: id, startedAtMs: NOW, preMs: PRE_MS })).toBe(true);
    expect(e.revolutionCue({ action: 'start', effectId: id, startedAtMs: NOW, preMs: PRE_MS })).toBe(false);
  });

  it('preMs は前置きの尺で頭打ち(壊れた合図で窓が未来へ飛ばない)', () => {
    const e = engine(cfg());
    e.start();
    e.handleEvent(revGift());
    e.revolutionCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW, preMs: 999_999 });
    expect(e.get().revolution?.startsAtMs).toBe(NOW + PRE_MS);
  });
});

describe('アーム期限切れ(BOOST_ARM_MAX_MS)は破棄せず強制発動', () => {
  it('deadlineMs 起点で窓が開く — effect に焼いた revolutionEndsAtMs がそのまま真になる', () => {
    // モニターが最後まで再生しなかった(舞台が塞がりっぱなし等)。課金ギフトを
    // もらったのに革命が起きない形は作らない。
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(revGift());
    const endsAtMs = e.get().recentEffects.find((x) => x.kind === 'revolution-start')!.revolutionEndsAtMs;
    // 期限 + 前置きぶん進めて press。時計の入口は flushFxFreeze の1箇所。
    t = NOW + BOOST_ARM_MAX_MS + PRE_MS;
    e.press();
    const s = e.get();
    expect(s.revolution?.startsAtMs).toBe(t);
    expect(s.revolution?.endsAtMs).toBe(endsAtMs);
    // 窓は開いているので、その press 自体が×3で効く。
    expect(s.value).toBe(1000 - MULT);
  });

  it('handleEvent の入口でも同じ(イベントだけが来ている配信でも自走する)', () => {
    let t = NOW;
    const e = engine(cfg({ likeEvery: 10, likeStep: 5 }), () => t);
    e.start();
    e.handleEvent(revGift());
    t = NOW + BOOST_ARM_MAX_MS + PRE_MS;
    e.handleEvent(like(10));
    expect(e.get().revolution?.startsAtMs).toBe(t);
  });
});

describe('drop はプレーン即発動へ倒す(モニターの都合で 699💎 を無にしない)', () => {
  it('effectId 0(種類を問わず対象)の drop で窓が即開き、凍結も引き戻る', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(revGift());
    t = NOW + 3000;
    expect(e.revolutionCue({ action: 'drop', effectId: 0 })).toBe(true);
    const s = e.get();
    expect(s.revolution?.startsAtMs).toBe(t); // 前置きゼロ = 即オープン
    expect(s.revolution?.endsAtMs).toBe(t + DUR_MS);
    expect(s.fxFreezeUntilMs).toBeNull(); // プレーンは凍結しない
    e.press();
    expect(e.get().value).toBe(1000 - MULT);
  });

  it('アームが無いときの合図は何も起こさない(false)', () => {
    const e = engine(cfg());
    e.start();
    expect(e.revolutionCue({ action: 'drop', effectId: 0 })).toBe(false);
    expect(e.revolutionCue({ action: 'start', effectId: 1, startedAtMs: NOW, preMs: 0 })).toBe(false);
  });
});

describe('窓中のタップ — pressStep × 倍率で即時', () => {
  it('1タップぶんが即座に減り、pressDownTotal も同じ量ぶん増える', () => {
    const e = plain(cfg());
    openPlain(e);
    e.press();
    e.press();
    const s = e.get();
    expect(s.value).toBe(1000 - MULT * 2);
    expect(s.pressDownTotal).toBe(MULT * 2);
    expect(s.stats.presses).toBe(2);
    const fx = s.recentEffects.filter((x) => x.kind === 'press');
    expect(fx).toHaveLength(2);
    // モニターのラッチ表示が倍率を知る唯一の口(boostMultiplier と同じ規約)。
    expect(fx[0]!.revolutionMultiplier).toBe(MULT);
    expect(fx[0]!.amount).toBe(-MULT);
  });

  it('残量より大きい押下はクランプし、effect の amount は**実減少量**', () => {
    // 名目の step を焼くと、最後の1押しでモニターのラッチ表示(valueAfter - amount)が
    // 残量ぶん上へ飛ぶ(flushPressFx / boostPlain と同じ規約)。
    const e = plain(cfg({ initialValue: 2 }));
    openPlain(e);
    e.press();
    const s = e.get();
    expect(s.value).toBe(0);
    expect(s.pressDownTotal).toBe(2); // 名目 3 ではなく実減少量
    expect(s.recentEffects.find((x) => x.kind === 'press')!.amount).toBe(-2);
    // 0 到達 = 達成(プレーンは凍結が無いので即時に出る)。
    expect(s.status).toBe('achieved');
  });

  it('pressStep>1 にも倍率が乗る(焼き込みは着弾時点の pressStep)', () => {
    const c = cfg({ initialValue: 1000, pressStep: 4 });
    const e = plain(c);
    openPlain(e);
    // 窓が開いたあとに設定を変えても、窓の中の1タップの重みは変わらない。
    c.pressStep = 1;
    e.onConfigChanged();
    e.press();
    expect(e.get().value).toBe(1000 - 4 * MULT);
  });
});

describe('起動演出中のタップは溜めて、窓オープンで**等倍**一括反映', () => {
  it('**アーム中**(まだ何も映っていない)の押下は凍結を素通しして即時に効く', () => {
    // アームは「モニターが導入を再生し始めるのを待っている」時間で、舞台が他演出で
    // 塞がっていれば最長 BOOST_ARM_MAX_MS(60秒)続く。画面には「まだ押す時間では
    // ない」の合図が何も出ていないのだから、溜める理由が存在しない — ここを保留に
    // すると 699💎 を撃った直後から最大71秒、押しても数字が1も動かない。
    // フィーバーの起動カットイン分岐が `boostUntilMs !== null` でアーム中に入らない
    // のと同じ形(worker/challenge.ts の該当コメント)。
    const e = engine(cfg(), () => NOW);
    e.start();
    e.handleEvent(revGift());
    expect(e.get().revolution).toBeUndefined(); // 窓はまだ開いていない(アーム中)
    for (let i = 0; i < 5; i += 1) e.press();
    const armed = e.get();
    expect(armed.value).toBe(1000 - 5); // 等倍で即時に効く(倍率は窓の中だけ)
    expect(armed.stats.presses).toBe(5);
    expect(armed.pressDownTotal).toBe(5);
  });

  it('cue 後の導入再生中(窓オープン前)だけ溜めて、窓の頭で等倍一括(取りこぼしゼロ)', () => {
    // 導入カットインと 5..1 は「まだ押す時間ではない」合図。フライングで数字が
    // 動くと溜めの意味が消えるので applyOrQueue 行き — ただし**捨てない**
    // (お邪魔と違い、これは遅延であって封印ではない)。
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(revGift());
    // 合図 → 窓は NOW + 前置き。凍結もそこまで引き戻る。ここから導入再生中。
    e.revolutionCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW, preMs: PRE_MS });
    const startsAtMs = e.get().revolution!.startsAtMs;
    for (let i = 0; i < 5; i += 1) e.press();
    const during = e.get();
    expect(during.value).toBe(1000); // 導入中は数字が動かない
    expect(during.stats.presses).toBe(0);
    expect(during.pressDownTotal).toBeUndefined();
    t = startsAtMs + GIFT_FX_FREEZE_MARGIN_MS;
    const s = e.drainIfChanged()!;
    // **等倍**(pressStep × 1)。窓の倍率は「窓が開いてから押した」ぶんだけの報酬。
    expect(s.value).toBe(1000 - 5);
    expect(s.pressDownTotal).toBe(5);
    expect(s.stats.presses).toBe(5);
    const fx = s.recentEffects.filter((x) => x.kind === 'press');
    expect(fx).toHaveLength(1); // finishDrain が同種を1件へ畳む
    expect(fx[0]!.coalesced).toBe(5);
    expect(fx[0]!.amount).toBe(-5);
    // ドレイン直後の押下は窓の中なので×3。
    e.press();
    expect(e.get().value).toBe(1000 - 5 - MULT);
  });
});

describe('いいねの反転 — 妨害がお助けになる', () => {
  const likeCfg = (over: Partial<ChallengeConfig> = {}): ChallengeConfig =>
    cfg({ likeEvery: 10, likeStep: 5, likeStockCount: 2, likeStockStep: 25, ...over });

  it('ゲージ満タンで value が減り、会計は likeUp ではなく likeDown へ載る', () => {
    const e = plain(likeCfg());
    openPlain(e);
    e.handleEvent(like(10));
    const s = e.get();
    expect(s.value).toBe(1000 - 5);
    // likeUp = 加算 fills × step の検算を壊さないため、減算は別枠(likeStockUp と同じ判断)。
    expect(s.stats.likeDown).toBe(5);
    expect(s.stats.likeUp).toBe(0);
    // downFills は据え置き会計の符号復元の唯一のソース。fills は符号を問わず数える。
    expect(s.likeGauge?.fills).toBe(1);
    expect(s.likeGauge?.downFills).toBe(1);
  });

  it('反転中の −N バナーも 2Hz tick(drainIfChanged)で出る — 窓の終わりまで滞留しない', () => {
    // flushLikeFx の保留ガードは **`=== 0`** でなければならない。`<= 0` だと反転中の
    // 保留(負)がその間ずっと弾かれ、合算窓を跨いだ2件目以降の −N が窓が閉じるまで
    // (最長1分)出ない。値と会計は正しいのにバナーだけが消える壊れ方なので、
    // 「いいねで数字が減っているのに何も出ない」= 配信者にも視聴者にも説明がつかない。
    let t = NOW;
    const e = plain(likeCfg(), () => t);
    openPlain(e);
    e.handleEvent(like(10)); // 1件目: 合算窓の頭なので即時に出る
    const first = e.get().recentEffects.filter((x) => x.kind === 'like');
    expect(first).toHaveLength(1);
    expect(first[0]!.amount).toBe(-5);
    // 2件目は合算窓の中なので push されず保留(負)へ積まれる。
    e.handleEvent(like(10));
    expect(e.get().recentEffects.filter((x) => x.kind === 'like')).toHaveLength(1);
    // 窓が明けたら tick が拾う。窓はまだ開いたまま(60秒)。
    t = NOW + LIKE_FX_WINDOW_MS + 1;
    e.drainIfChanged();
    const after = e.get().recentEffects.filter((x) => x.kind === 'like');
    expect(after).toHaveLength(2);
    expect(after[0]!.amount).toBe(-5);
  });

  it('ストック満杯のボーナスも反転する(likeStockDown / stock.downFills)', () => {
    const e = plain(likeCfg());
    openPlain(e);
    e.handleEvent(like(10)); // 満タン1回目
    e.handleEvent(like(10)); // 満タン2回目 = ストック 2/2 → 満杯
    const s = e.get();
    expect(s.value).toBe(1000 - 5 - 5 - 25);
    expect(s.stats.likeDown).toBe(10);
    expect(s.stats.likeStockDown).toBe(25);
    expect(s.stats.likeStockUp).toBe(0);
    expect(s.likeGauge?.downFills).toBe(2);
    expect(s.likeGauge?.stock?.fills).toBe(1);
    expect(s.likeGauge?.stock?.downFills).toBe(1);
    // バナーも減算方向で出る(-0 は作らない規約)。
    expect(s.recentEffects.find((x) => x.kind === 'stock-full')!.amount).toBe(-25);
  });

  it('0 到達はクランプされ、達成になる(押さずに 0 へ落ちる唯一の新経路)', () => {
    const e = plain(likeCfg({ initialValue: 3 }));
    openPlain(e);
    e.handleEvent(like(10));
    const s = e.get();
    expect(s.value).toBe(0);
    expect(s.stats.likeDown).toBe(3); // 名目 5 ではなく実減少量
    expect(s.status).toBe('achieved');
    // 達成で窓も畳む(達成後のイベントは無視される規約なので残す意味がない)。
    expect(s.revolution).toBeUndefined();
  });

  it('窓が閉じたあとのいいねは元どおり妨害(加算)へ戻る', () => {
    let t = NOW;
    // ストックは切る(2回目の満タンで満杯ボーナスが乗ると符号の検算が濁る)。
    const e = plain(likeCfg({ likeStockCount: 0 }), () => t);
    openPlain(e);
    e.handleEvent(like(10));
    expect(e.get().value).toBe(995);
    t = NOW + DUR_MS;
    e.drainIfChanged();
    expect(e.get().revolution).toBeUndefined();
    e.handleEvent(like(10));
    const s = e.get();
    expect(s.value).toBe(1000); // 減った 5 が戻る
    expect(s.stats.likeUp).toBe(5);
    expect(s.stats.likeDown).toBe(5);
    expect(s.likeGauge?.fills).toBe(2);
    expect(s.likeGauge?.downFills).toBe(1); // 反転したのは1回だけ
  });

  it('反転は**op 実行時**の窓で決まる(到着時点ではない)', () => {
    // 尺・倍率は「到着時点で確定」だが、反転はゲームの状態なので窓と同期させる —
    // 凍結ドレインで遅れて実行されたいいねは実行時点の窓が基準(clampDownAmount と
    // 同じ哲学)。アーム中に届いたいいねは窓オープン後にドレインされる = 反転する。
    let t = NOW;
    const e = engine(likeCfg(), () => t);
    e.start();
    e.handleEvent(revGift());
    e.handleEvent(like(10)); // 凍結中 = pendingOps 行き(値はまだ動かない)
    expect(e.get().value).toBe(1000);
    e.revolutionCue({ action: 'start', effectId: startFxId(e), startedAtMs: NOW, preMs: PRE_MS });
    t = e.get().revolution!.startsAtMs + GIFT_FX_FREEZE_MARGIN_MS;
    const s = e.drainIfChanged()!;
    expect(s.value).toBe(995);
    expect(s.stats.likeDown).toBe(5);
  });
});

describe('窓中は最終ゲート免除・お邪魔は封じが勝つ', () => {
  it('ラスト◯◯モードでも 1 タップで pressStep × 倍率ぶん減る(gauntlet キーも省く)', () => {
    // press() の革命窓分岐がゲートより**上**に居るのと、get() の gauntlet 省略条件が対。
    let t = NOW;
    const c = cfg({ initialValue: 10, lowThreshold: 10 });
    c.finalGate = { enabled: true, taps: 30 };
    const e = plain(c, () => t);
    e.start();
    expect(e.get().gauntlet).toEqual({ taps: 0, needed: 30 }); // 窓の前はゲート中
    e.handleEvent(revGift());
    expect(e.get().gauntlet).toBeUndefined(); // 窓中は免除
    e.press();
    expect(e.get().value).toBe(10 - MULT); // 30 タップではなく1タップで 3 減る
    // 窓明けにゲートは戻る(免除は窓の間だけ)。
    t = NOW + DUR_MS;
    e.drainIfChanged();
    expect(e.get().gauntlet).toEqual({ taps: 0, needed: 30 });
  });

  it('お邪魔(タップ封じ)中は窓でもタップが効かない — 封じが勝つ(2026-08-20 ユーザー決定)', () => {
    // press() の革命窓分岐は tapLock 分岐より**下**。革命は 699💎 の課金ギフトだが、
    // 封印は「押させない」というゲームの状態そのものなので、そちらの契約を上書き
    // しない。フィーバーの窓が封印より上に居るのは排他スケジューリングの防御であって
    // 「窓は封印より強い」という一般則ではない(worker/challenge.ts の該当コメント)。
    const c = cfg();
    c.tapLock = {
      ...structuredClone(DEFAULT_TAP_LOCK),
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_TAP_LOCK_RULE), giftId: '5555' }],
    };
    const e = plain(c);
    openPlain(e);
    const endsAtBefore = e.get().revolution!.endsAtMs;
    e.handleEvent(revGift({ giftId: '5555', giftName: 'Jam Gift' }));
    expect(e.get().tapLock).toBeDefined(); // 封印は張られている
    e.press();
    const s = e.get();
    expect(s.value).toBe(1000); // 封じが勝つ = タップは捨てられる(溜まらない)
    expect(s.tapLock?.blocked).toBe(1); // 「押したのに効かない」手応えは出る
    // **革命の時計は止まらない** — 封印で失うのはタップだけで、窓の残り時間は減り続ける。
    expect(s.revolution?.endsAtMs).toBe(endsAtBefore);
  });
});

describe('期限切れ — 2Hz tick が無くても armFreezeTimer で必ず切れる', () => {
  it('イベントも press も無いまま実時間だけ進んでも窓が閉じる', () => {
    // 配信が切れた瞬間に窓が開いていたケース。ここが緑でないと「いいねで数字が
    // 減る」状態が次の配信まで持ち越される(お邪魔の固着と同種の事故)。
    vi.useFakeTimers();
    try {
      let t = NOW;
      const e = plain(cfg(), () => t);
      let nudged = 0;
      e.setOnFreezeExpired(() => nudged++);
      openPlain(e);
      expect(e.get().fxFreezeUntilMs).toBeNull(); // 凍結は張っていない
      t = NOW + DUR_MS + 25;
      vi.advanceTimersByTime(DUR_MS + 25);
      const s = e.get();
      expect(s.revolution).toBeUndefined();
      expect(nudged).toBe(1);
      const end = s.recentEffects.find((x) => x.kind === 'revolution-end');
      expect(end).toBeDefined();
      expect(end!.revolutionMultiplier).toBe(MULT);
      expect(end!.revolutionMs).toBe(DUR_MS);
      // 窓明けのタップは等倍へ戻る。
      e.press();
      expect(e.get().value).toBe(1000 - 1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('2Hz tick(drainIfChanged)でも同じ — revolution-end は1回だけ', () => {
    let t = NOW;
    const e = plain(cfg(), () => t);
    openPlain(e);
    t = NOW + DUR_MS;
    e.drainIfChanged();
    t = NOW + DUR_MS + 5000;
    e.drainIfChanged();
    expect(e.get().recentEffects.filter((x) => x.kind === 'revolution-end')).toHaveLength(1);
  });

  it('時計の巻き戻しで期限が未来に取り残されない(clampFutureMs)', () => {
    let t = NOW;
    const e = plain(cfg(), () => t);
    openPlain(e);
    t = NOW - 600_000; // NTP 巻き戻し
    e.drainIfChanged();
    // 上限は **REVOLUTION_MAX_MS + 前置き**。窓はコミット直後まだ開いておらず
    // (startsAtMs = 実再生開始 + 前置き)、endsAtMs は now から「前置き + 尺」ぶん
    // 先にある。素の MAX で切ると、尺を上限まで積んだ設定(120秒 × 連打2本)で
    // コミット直後に前置きぶん窓が削られる。安全弁(時計飛びの検出)としての
    // 意味は上限を前置きぶん広げても失われない。
    expect(e.get().revolution!.endsAtMs - t).toBeLessThanOrEqual(REVOLUTION_MAX_MS + PRE_MS);
  });
});

describe('重ねがけ — 延長 + REVOLUTION_MAX_MS でクランプ', () => {
  it('走行中の再着弾は期限へ加算する', () => {
    let t = NOW;
    const e = plain(cfg(), () => t);
    openPlain(e);
    t = NOW + 10_000;
    e.handleEvent(revGift());
    // 残り 50 秒ではなく**期限に +60 秒**(tapLock は残りへ加算、こちらは期限へ)。
    expect(e.get().revolution?.endsAtMs).toBe(NOW + 2 * DUR_MS);
  });

  it('何度重ねても着弾時刻 + REVOLUTION_MAX_MS を超えない', () => {
    let t = NOW;
    const e = plain(cfg(), () => t);
    openPlain(e);
    t = NOW + 1000;
    for (let i = 0; i < 10; i += 1) e.handleEvent(revGift());
    expect(e.get().revolution!.endsAtMs).toBe(t + REVOLUTION_MAX_MS);
  });

  it('連打コンボ(repeatCount)は尺に掛かるが上限本数で丸める', () => {
    const e = plain(cfg());
    e.start();
    e.handleEvent(revGift({ repeatCount: 17, diamonds: 699 * 17 }));
    expect(e.get().revolution!.endsAtMs - NOW).toBe(DUR_MS * REVOLUTION_ACTIVATIONS_MAX);
  });

  it('アーム中の再着弾も失われず、窓の尺へ足される', () => {
    // アーム中は暫定凍結が必ず生きているので、2本目は pendingOps へ落ちて
    // 窓オープン直後にドレインされる = 走行中の延長と同じ結果に収束する。
    let t = NOW;
    const e = engine(cfg(), () => t);
    e.start();
    e.handleEvent(revGift());
    t = NOW + 1000;
    e.handleEvent(revGift()); // アーム中の2本目
    expect(e.get().revolution).toBeUndefined();
    e.revolutionCue({ action: 'start', effectId: startFxId(e), startedAtMs: t, preMs: PRE_MS });
    const startsAtMs = e.get().revolution!.startsAtMs;
    t = startsAtMs + GIFT_FX_FREEZE_MARGIN_MS;
    const s = e.drainIfChanged()!;
    expect(s.revolution!.endsAtMs - startsAtMs).toBe(2 * DUR_MS);
  });

  it('再接続バックログの再生(同じ msgId)で二重に延長しない', () => {
    let t = NOW;
    const e = plain(cfg(), () => t);
    e.start();
    const g = revGift();
    e.handleEvent(g);
    t = NOW + 5000;
    e.handleEvent(g); // 同じ msgId
    expect(e.get().revolution?.endsAtMs).toBe(NOW + DUR_MS);
  });
});

describe('▶テスト実演との相互排他(実発動が必ず優先)', () => {
  // press() の実演ブロックは status も enabled も見ず**最優先で return** する。
  // 革命が実演窓と重なると、699💎 を撃った視聴者から見て窓のタップが1つも
  // 数字に届かない(実演カウンタへ吸われる)。activateBoost / activateTapLock が
  // 同型の事故を clearTestBoost で潰しているのと同じ規約を革命でも守る。
  const boostCfg = (c: ChallengeConfig): ChallengeConfig => ({
    ...c,
    tapBoost: {
      ...structuredClone(DEFAULT_TAP_BOOST),
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_TAP_BOOST_RULE), giftId: 'never-matches' }],
    },
  });

  it('実演の窓が生きていても、革命の発動がそれを破棄して窓のタップが実値へ届く', () => {
    const e = plain(boostCfg(cfg()));
    e.start();
    e.testEffect({ kind: 'tapBoost' }); // 配信中に設定画面から実演
    expect(e.get().boost).toBeDefined(); // 実演の計数窓が立っている
    e.handleEvent(revGift()); // 白鳥 → プレーン即発動
    e.press();
    // 実演窓が残っていれば値は 1000 のまま(タップが実演カウンタへ吸われる)。
    expect(e.get().value).toBe(1000 - MULT);
  });

  it('革命の窓/アーム中は実演の窓を登録しない(逆向きの乗っ取りも塞ぐ)', () => {
    // 窓中
    const e1 = plain(boostCfg(cfg()));
    openPlain(e1);
    e1.testEffect({ kind: 'tapBoost' });
    e1.press();
    expect(e1.get().value).toBe(1000 - MULT); // 実演に吸われていない
    // アーム中(窓はまだ開いていない)
    const e2 = engine(boostCfg(cfg()));
    e2.start();
    e2.handleEvent(revGift());
    e2.testEffect({ kind: 'tapBoost' });
    e2.press();
    expect(e2.get().value).toBe(1000 - 1); // アーム中は等倍で即時(実演には行かない)
  });
});

describe('清算 — どの出口からも窓もアームも残さない', () => {
  it('走行中に革命だけ OFF にすると revolution-end が出る(モニターが導入を畳める)', () => {
    // モニターの導入カットインは自前の 11 秒タイマーで走っており、worker が窓を
    // 畳んだことを知る合図が要る。stop / reset / 達成は status 遷移が合図になるが、
    // **機能 OFF は status を変えない**ので end を積むのがここだけの役割。
    const c = cfg();
    const e = plain(c);
    openPlain(e);
    expect(e.get().revolution).toBeDefined();
    c.revolution.enabled = false;
    e.onConfigChanged();
    expect(e.get().revolution).toBeUndefined();
    const ends = e.get().recentEffects.filter((x) => x.kind === 'revolution-end');
    expect(ends).toHaveLength(1);
    expect(ends[0]!.revolutionMultiplier).toBe(MULT);
  });

  it('**アーム止まり**で OFF にしたら revolution-end は出さない(開いていない窓の終了は嘘)', () => {
    const c = cfg();
    const e = engine(c);
    e.start();
    e.handleEvent(revGift());
    expect(e.get().revolution).toBeUndefined(); // アーム中
    c.revolution.enabled = false;
    e.onConfigChanged();
    expect(e.get().recentEffects.filter((x) => x.kind === 'revolution-end')).toHaveLength(0);
  });

  it('start / reset / stop のどれでも消える(走行中の窓)', () => {
    for (const act of ['start', 'reset', 'stop'] as const) {
      const e = plain(cfg());
      openPlain(e);
      expect(e.get().revolution).toBeDefined();
      e[act]();
      expect(e.get().revolution).toBeUndefined();
    }
  });

  it('start / reset / stop はアーム中の予約も畳む(幽霊の革命を作らない)', () => {
    for (const act of ['start', 'reset', 'stop'] as const) {
      let t = NOW;
      const e = engine(cfg(), () => t);
      e.start();
      e.handleEvent(revGift());
      e[act]();
      // アーム期限を跨いでも強制発動しない = 予約が孤児として生き残っていない。
      t = NOW + BOOST_ARM_MAX_MS + PRE_MS + 1000;
      e.drainIfChanged();
      expect(e.get().revolution).toBeUndefined();
    }
  });

  it('達成(押さずに 0 到達)でも消える', () => {
    const c = cfg({ initialValue: 5, likeEvery: 10, likeStep: 99 });
    const e = plain(c);
    openPlain(e);
    e.handleEvent(like(10)); // 反転 → クランプして 0
    expect(e.get().status).toBe('achieved');
    expect(e.get().revolution).toBeUndefined();
  });

  it('革命だけを OFF にしたら走行中の窓も畳む(無効化済み機能の効果を生かさない)', () => {
    const c = cfg();
    const e = plain(c);
    openPlain(e);
    expect(e.get().revolution).toBeDefined();
    c.revolution.enabled = false;
    e.onConfigChanged();
    expect(e.get().revolution).toBeUndefined();
    e.press();
    expect(e.get().value).toBe(1000 - 1); // 等倍へ戻っている
  });

  it('革命だけを OFF にしたアーム中は、凍結を引き戻して保留 op をドレインする', () => {
    // clearRevolution 単体だと暫定凍結(アーム期限 + 前置き = 最長 71.5 秒)が
    // 残り、その間に届いたいいね/ギフトが宙に浮く。
    const c = cfg({ likeEvery: 10, likeStep: 5 });
    const e = engine(c);
    e.start();
    e.handleEvent(revGift());
    e.handleEvent(like(10)); // 凍結中 = pendingOps 行き
    expect(e.get().value).toBe(1000);
    c.revolution.enabled = false;
    e.onConfigChanged();
    const s = e.get();
    expect(s.revolution).toBeUndefined();
    expect(s.fxFreezeUntilMs).toBeNull();
    // 反転せずに**加算**で適用される(窓は開かなかったので通常の妨害)。
    expect(s.value).toBe(1005);
    expect(s.stats.likeUp).toBe(5);
  });

  it('行ごとの enabled を落としても走行中の窓は消さない(到着時点で確定の規約)', () => {
    const c = cfg();
    const e = plain(c);
    openPlain(e);
    c.revolution.rules[0]!.enabled = false;
    e.onConfigChanged();
    expect(e.get().revolution).toBeDefined();
  });

  it('チャレンジ機能そのものの OFF も逃げ道に含む', () => {
    const c = cfg();
    const e = plain(c);
    openPlain(e);
    c.enabled = false;
    e.onConfigChanged();
    expect(e.get().revolution).toBeUndefined();
  });
});

describe('ギフト評価の先勝ち列: fanStamp → tapBoost → 革命 → tapLock', () => {
  const DUP = '424242';

  it('同じ giftId を tapBoost と革命に登録したらフィーバーが勝つ', () => {
    // どちらもタップ倍率系で、フィーバーの方が大きな山場(matchRevolution の規約)。
    const c = cfg();
    c.tapBoost = {
      ...structuredClone(DEFAULT_TAP_BOOST),
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_TAP_BOOST_RULE), giftId: DUP }],
    };
    c.revolution.rules[0]!.giftId = DUP;
    const e = plain(c);
    e.start();
    e.handleEvent(revGift({ giftId: DUP, giftName: 'Dup Gift' }));
    const fx = e.get().recentEffects;
    expect(fx.some((x) => x.kind === 'boost-start')).toBe(true);
    expect(fx.some((x) => x.kind === 'revolution-start')).toBe(false);
    expect(e.get().revolution).toBeUndefined();
  });

  it('同じ giftId を革命とお邪魔に登録したら革命が勝つ(お助けが封印に食われない)', () => {
    const c = cfg();
    c.revolution.rules[0]!.giftId = DUP;
    c.tapLock = {
      ...structuredClone(DEFAULT_TAP_LOCK),
      enabled: true,
      rules: [{ ...structuredClone(DEFAULT_TAP_LOCK_RULE), giftId: DUP }],
    };
    const e = plain(c);
    e.start();
    e.handleEvent(revGift({ giftId: DUP, giftName: 'Dup Gift' }));
    expect(e.get().revolution).toBeDefined();
    expect(e.get().tapLock).toBeUndefined();
  });

  it('フィーバーの窓と重なったらフィーバーの倍率が勝つ(press の分岐順)', () => {
    const c = cfg();
    c.tapBoost = {
      ...structuredClone(DEFAULT_TAP_BOOST),
      enabled: true,
      rules: [
        { ...structuredClone(DEFAULT_TAP_BOOST_RULE), giftId: '9999', introClip: 'off', countClip: 'off' },
      ],
    };
    const e = plain(c);
    openPlain(e); // 革命の窓(×3)
    e.handleEvent(revGift({ giftId: '9999', giftName: 'Boost Gift' }));
    // プレーンのフィーバー窓は即時×5(DEFAULT_TAP_BOOST_RULE.multiplier)。
    e.press();
    expect(e.get().value).toBe(1000 - DEFAULT_TAP_BOOST_RULE.multiplier);
    expect(e.get().revolution).toBeDefined(); // 革命の窓自体は生きたまま
  });
});

