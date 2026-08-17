import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_JOIN_ROULETTE,
  DEFAULT_ROULETTE_PATTERNS,
  GIFT_FX_FREEZE_MARGIN_MS,
  JOIN_ROULETTE_MIN_GAP_MS,
  validateChallengeConfig,
} from '@shared/challenge';
import type { ChallengeConfig, JoinRouletteConfig, RoulettePattern } from '@shared/dto';
import type { GiftEvent, JoinEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

let seq = 0;

/** 入室イベント。action=1(JOINED)が既定。firstEver は handleEvent の第2引数で渡す。 */
function join(userId = 'j1', over: Partial<JoinEvent> = {}): JoinEvent {
  return {
    kind: 'join',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: `viewer-${userId}` },
    action: 1,
    ...over,
  };
}

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

/**
 * 入室ルーレットを有効にした設定。バンド/全面カットは challenge.spec.ts と同じ
 * 理由で無効(凍結を検査するテストだけ bandCfg で明示的に有効化する)。
 * ギフトルーレットは空 — 既定のハートミー行に紛れて join 経路以外が回らないことを
 * spins の総数だけで検査できるようにする。
 */
function cfg(jr: Partial<JoinRouletteConfig> = {}, over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.roulettes = [];
  base.joinRoulette = { ...structuredClone(DEFAULT_JOIN_ROULETTE), enabled: true, ...jr };
  return { ...base, enabled: true, ...over };
}

/** rand 固定のエンジン。既定盤面なら rand=0 で出目 5、rand=0.995 で 1000。 */
function jrEngine(
  c: ChallengeConfig = cfg(),
  now: () => number = () => NOW,
  rand: () => number = () => 0,
  fxRand: () => number = () => 0
): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, rand, fxRand);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

describe('validateJoinRoulette — 旧 settings.json との互換', () => {
  it('キー欠損(旧 settings.json)は既定(enabled:false, target:first)へ倒れる', () => {
    const legacy = { ...DEFAULT_CHALLENGE } as Record<string, unknown>;
    delete legacy.joinRoulette;
    const v = validateChallengeConfig(legacy);
    expect(v.joinRoulette).toEqual(DEFAULT_JOIN_ROULETTE);
    expect(v.joinRoulette.enabled).toBe(false);
  });

  it('非オブジェクト・enabled 非 true は無効へ(既定 false の向き)', () => {
    expect(
      validateChallengeConfig({ ...DEFAULT_CHALLENGE, joinRoulette: 'x' }).joinRoulette
    ).toEqual(DEFAULT_JOIN_ROULETTE);
    expect(
      validateChallengeConfig({
        ...DEFAULT_CHALLENGE,
        joinRoulette: { ...DEFAULT_JOIN_ROULETTE, enabled: 'yes' },
      }).joinRoulette.enabled
    ).toBe(false);
  });

  it('target は all 以外すべて first へ倒す', () => {
    for (const t of ['first', 'all', 'everyone', 42, undefined]) {
      const v = validateChallengeConfig({
        ...DEFAULT_CHALLENGE,
        joinRoulette: { ...DEFAULT_JOIN_ROULETTE, target: t },
      });
      expect(v.joinRoulette.target).toBe(t === 'all' ? 'all' : 'first');
    }
  });

  it('label 空は既定名へ倒す(rouletteBoardKey の衝突と見出し欠落を防ぐ)', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      joinRoulette: { ...DEFAULT_JOIN_ROULETTE, label: '  ' },
    });
    expect(v.joinRoulette.label).toBe(DEFAULT_JOIN_ROULETTE.label);
  });

  it('盤面全滅(weight 全0・空)は既定 segments へ、patterns 全滅は全パターンへ', () => {
    const v = validateChallengeConfig({
      ...DEFAULT_CHALLENGE,
      joinRoulette: {
        ...DEFAULT_JOIN_ROULETTE,
        segments: [{ amount: 5, weight: 0 }],
        patterns: ['nope'],
      },
    });
    expect(v.joinRoulette.segments).toEqual(DEFAULT_JOIN_ROULETTE.segments);
    expect(v.joinRoulette.patterns).toEqual([...DEFAULT_ROULETTE_PATTERNS]);
  });
});

describe('ChallengeEngine — 入室ルーレット', () => {
  it('初見の入室(action=1)で1スピン回り、出目が即時適用される', () => {
    const e = jrEngine();
    e.start();
    expect(e.handleEvent(join('j1'), true)).toBe(true);
    const s = e.get();
    // rand=0 → 既定盤面の先頭 +5(direction は既定 add)。
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 5);
    expect(s.stats.rouletteSpins).toBe(1);
    expect(s.stats.joinUp).toBe(5);
    expect(s.stats.joinDown).toBe(0);
    // ギフト由来の統計には混ぜない(giftUp/Down は「ギフト由来」の契約)。
    expect(s.stats.giftUp).toBe(0);
    const fx = s.recentEffects[0]!;
    expect(fx.kind).toBe('roulette');
    expect(fx.amount).toBe(5);
    expect(fx.rouletteIndex).toBe(0);
    expect(fx.rouletteIndexes).toEqual([0]);
    expect(fx.rouletteReels).toBe(1);
    expect(fx.rouletteSegments).toEqual(DEFAULT_JOIN_ROULETTE.segments.map((x) => x.amount));
    expect(fx.rouletteLabel).toBe(DEFAULT_JOIN_ROULETTE.label);
    // モニターはこの印で短縮と超焦らしカウントを免除する(常にフル尺の契約)。
    expect(fx.rouletteJoin).toBe(true);
    // 由来印 — モニターの専用キュー(優先度⑥)振り分けが読む。label 推定は
    // ユーザー編集で衝突しうるので、この焼き込みが唯一のソース。
    expect(fx.rouletteOrigin).toBe('join');
    expect(fx.nickname).toBe('viewer-j1');
    expect(fx.valueAfter).toBe(s.value);
    // ギフトではないので gift 系フィールドは載せない(モニターは 🎰 プレースホルダ)。
    expect(fx.giftName).toBeUndefined();
    expect(fx.diamonds).toBeUndefined();
  });

  it('target:first では初見以外・action≠1・無効・idle では回らない', () => {
    const e = jrEngine();
    e.start();
    expect(e.handleEvent(join('a'), false)).toBe(false); // 初見ではない
    expect(e.handleEvent(join('b', { action: 3 }), true)).toBe(false); // SUBSCRIBED
    expect(e.get().stats.rouletteSpins).toBe(0);

    const off = jrEngine(cfg({ enabled: false }));
    off.start();
    expect(off.handleEvent(join('c'), true)).toBe(false);
    expect(off.get().stats.rouletteSpins).toBe(0);

    const idle = jrEngine(); // start() しない
    expect(idle.handleEvent(join('d'), true)).toBe(false);
    expect(idle.get().stats.rouletteSpins).toBe(0);
  });

  it('第2引数なしの呼び出し(リプレイ/旧経路)では target:first は回らない', () => {
    const e = jrEngine();
    e.start();
    expect(e.handleEvent(join('j1'))).toBe(false);
    expect(e.get().stats.rouletteSpins).toBe(0);
  });

  it('target:all は初見でなくても回る(第2引数なしでも)', () => {
    const e = jrEngine(cfg({ target: 'all' }));
    e.start();
    expect(e.handleEvent(join('j1'))).toBe(true);
    expect(e.get().stats.rouletteSpins).toBe(1);
  });

  it('同一ユーザーはチャレンジ1回につき1度だけ(target:all でも)', () => {
    let t = NOW;
    const e = jrEngine(cfg({ target: 'all' }), () => t);
    e.start();
    expect(e.handleEvent(join('j1'))).toBe(true);
    t += JOIN_ROULETTE_MIN_GAP_MS + 1; // クールダウンの外で dedup だけを見る
    expect(e.handleEvent(join('j1'))).toBe(false);
    expect(e.get().stats.rouletteSpins).toBe(1);
  });

  it('クールダウン窓内の別ユーザーは捨てられ、窓経過後は回る', () => {
    let t = NOW;
    const e = jrEngine(cfg({ target: 'all' }), () => t);
    e.start();
    expect(e.handleEvent(join('j1'))).toBe(true);
    t += JOIN_ROULETTE_MIN_GAP_MS - 1;
    expect(e.handleEvent(join('j2'))).toBe(false); // 窓内 → 値ごと捨てる
    t += 2; // 窓経過
    expect(e.handleEvent(join('j3'))).toBe(true);
    const s = e.get();
    expect(s.stats.rouletteSpins).toBe(2);
    expect(s.value).toBe(DEFAULT_CHALLENGE.initialValue + 10);
  });

  it('窓で捨てられたユーザーは再入室でも回らない(dedup が先 — 挙動が決定的)', () => {
    let t = NOW;
    const e = jrEngine(cfg({ target: 'all' }), () => t);
    e.start();
    e.handleEvent(join('j1'));
    t += 1000;
    expect(e.handleEvent(join('j2'))).toBe(false); // 窓内で捨てられる(dedup は消費済み)
    t += JOIN_ROULETTE_MIN_GAP_MS;
    expect(e.handleEvent(join('j2'))).toBe(false); // 再入室しても回らない
    expect(e.get().stats.rouletteSpins).toBe(1);
  });

  it('start() で dedup が消える(次のチャレンジでは同じ人でもまた回る)', () => {
    let t = NOW;
    const e = jrEngine(cfg(), () => t);
    e.start();
    expect(e.handleEvent(join('j1'), true)).toBe(true);
    t += JOIN_ROULETTE_MIN_GAP_MS + 1;
    e.start(); // 新しいチャレンジ
    expect(e.handleEvent(join('j1'), true)).toBe(true);
    expect(e.get().stats.rouletteSpins).toBe(1); // stats は start でリセット済み
  });

  it('start()/reset() でクールダウンも消える(前回の抽選直後に始めても取りこぼさない)', () => {
    let t = NOW;
    const e = jrEngine(cfg({ target: 'all' }), () => t);
    e.start();
    expect(e.handleEvent(join('j1'))).toBe(true);
    t += 1; // 前回の最後の抽選から 1ms — 窓を持ち越すと開始直後の入室が消える
    e.start();
    expect(e.handleEvent(join('j2'))).toBe(true);
    e.reset();
    e.start();
    expect(e.handleEvent(join('j3'))).toBe(true);
    expect(e.get().stats.rouletteSpins).toBe(1); // stats は start でリセット済み
  });

  it('direction:sub は減算・0 でクランプ・achieved がルーレットの後に積まれる', () => {
    const e = jrEngine(cfg({ direction: 'sub' }, { initialValue: 3 }));
    e.start();
    expect(e.handleEvent(join('j1'), true)).toBe(true);
    const s = e.get();
    expect(s.value).toBe(0); // 3 - 5 → clamp
    expect(s.status).toBe('achieved');
    expect(s.stats.joinDown).toBe(5);
    const [ach, rl] = s.recentEffects;
    expect(ach!.kind).toBe('achieved');
    expect(rl!.kind).toBe('roulette');
    expect(rl!.amount).toBe(-5);
    expect(rl!.rouletteDirection).toBe('sub');
    // 達成判定は pushEffect の後(id 順契約)— 逆だとモニターが CLEAR を先に再生する。
    expect(ach!.id).toBeGreaterThan(rl!.id);
  });

  it('patterns のチェックで許可されたパターンからだけ引く', () => {
    for (const fx of [0, 0.5, 0.999999]) {
      const e = jrEngine(cfg({ patterns: ['crawl'] as RoulettePattern[] }), () => NOW, () => 0, () => fx);
      e.start();
      e.handleEvent(join('j1'), true);
      expect(e.get().recentEffects[0]!.roulettePattern).toBe('crawl');
    }
  });

  it('カットイン凍結中の入室は保留され、解除後に適用される', () => {
    let t = NOW;
    const c = cfg({}, { giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX), initialValue: 1000 });
    const e = jrEngine(c, () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1: 6 秒凍結
    t += 1000;
    expect(e.handleEvent(join('j1'), true)).toBe(false); // 保留
    expect(e.get().value).toBe(1030); // 凍結中は不変
    expect(e.get().stats.rouletteSpins).toBe(0);
    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    const drained = e.drainIfChanged(); // 2Hz tick が安全弁として解除
    expect(drained).not.toBeNull();
    expect(drained!.value).toBe(1030 + 5);
    expect(drained!.stats.rouletteSpins).toBe(1);
  });

  it('testEffect(join:true)は enabled=false でも入室ルーレットの盤面で試写できる', () => {
    const e = jrEngine(cfg({ enabled: false, label: '初見さん' }));
    e.start();
    e.testEffect({ kind: 'roulette', join: true, pattern: 'kick' });
    const fx = e.get().recentEffects[0]!;
    expect(fx.kind).toBe('roulette');
    expect(fx.test).toBe(true);
    expect(fx.rouletteLabel).toBe('初見さん');
    expect(fx.roulettePattern).toBe('kick');
    expect(fx.rouletteSegments).toEqual(DEFAULT_JOIN_ROULETTE.segments.map((x) => x.amount));
    // 本番(join 経路)と effect の形を揃える — 試写でも入室ルーレットは
    // 短縮・超焦らしカウントの対象外として再生される。
    expect(fx.rouletteJoin).toBe(true);
    // 由来印も本番と同型 — 試写だけ通常キューに乗る逆事故を防ぐ。
    expect(fx.rouletteOrigin).toBe('join');
  });

  it('testEffect(行指定)の試写には rouletteJoin が載らない(ギフト扱い)', () => {
    const base = structuredClone(DEFAULT_CHALLENGE);
    const c = { ...base, enabled: true };
    const e = jrEngine(c);
    e.start();
    e.testEffect({ kind: 'roulette', pattern: 'kick' });
    const fx = e.get().recentEffects[0]!;
    expect(fx.kind).toBe('roulette');
    expect(fx.rouletteJoin).toBeUndefined();
    // 由来印もギフト経路には付けない — 付くと専用キュー(優先度⑥)へ吸われる。
    expect(fx.rouletteOrigin).toBeUndefined();
  });

  it('ギフトルーレットとは独立に数える(両方有効でも spins は経路ごとに増える)', () => {
    const base = structuredClone(DEFAULT_CHALLENGE);
    base.giftBandFx.enabled = false;
    base.giftFullCut.enabled = false;
    base.joinRoulette = { ...structuredClone(DEFAULT_JOIN_ROULETTE), enabled: true };
    const c = { ...base, enabled: true };
    const e = jrEngine(c);
    e.start();
    e.handleEvent(join('j1'), true);
    e.handleEvent(gift({ giftId: '7934', giftName: 'Heart Me', diamondEach: 1, diamonds: 1 }));
    const s = e.get();
    expect(s.stats.rouletteSpins).toBe(2);
    expect(s.stats.joinUp).toBe(5);
    expect(s.stats.giftUp).toBe(5);
    // 由来印はライブでも経路ごと — ギフト由来(recentEffects[0]、後着)には付けず、
    // 入室由来([1])にだけ付く。ここが崩れるとモニターのキュー振り分けが交差する。
    const [giftFx, joinFx] = s.recentEffects;
    expect(giftFx!.rouletteOrigin).toBeUndefined();
    expect(giftFx!.rouletteJoin).toBeUndefined();
    expect(joinFx!.rouletteOrigin).toBe('join');
  });
});
