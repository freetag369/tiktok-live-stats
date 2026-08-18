import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CORGI_TAP_BOOST_RULE,
  DEFAULT_CHALLENGE,
  DEFAULT_TAP_BOOST,
  DEFAULT_TAP_BOOST_RULE,
  matchTapBoost,
  migrateChallengeConfig,
  migrateChallengeTapBoostCorgi,
  migrateChallengeTapBoostNebaaru,
  NEBAARU_TAP_BOOST_RULE,
  TAP_BOOST_COUNT_CLIPS,
  TAP_BOOST_INTRO_CLIPS,
  TAP_BOOST_INTRO_MS,
  TAP_BOOST_LOOP_CLIPS,
  TAP_BOOST_RESULT_CLIPS,
  TAP_BOOST_RULES_MAX,
  validateChallengeConfig,
} from '@shared/challenge';
import { ChallengeEngine } from '@worker/challenge';
import type { ChallengeConfig, TapBoostRule } from '@shared/dto';
import type { GiftEvent } from '@shared/events';

const NOW = 1_700_000_000_000;
let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定行が「バラ」等に一致すると凍結が張られ、時間を進めないテストが保留に落ちる。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  return { ...base, enabled: true, ...over };
}

function rule(over: Partial<TapBoostRule>): TapBoostRule {
  return { ...structuredClone(DEFAULT_TAP_BOOST_RULE), ...over };
}

function rules(list: Partial<TapBoostRule>[]): ChallengeConfig {
  return cfg({ tapBoost: { enabled: true, rules: list.map(rule) } });
}

function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  return {
    kind: 'gift',
    msgId: `m${++seq}`,
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

function engine(c: ChallengeConfig): ChallengeEngine {
  const e = new ChallengeEngine(
    () => c,
    () => NOW,
    Math.random,
    Math.random,
    () => undefined
  );
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

const PANTHER = { id: 'boost-panther', giftId: '723500', multiplier: 3, loopClip: 'loop-panther' };
const CORGI = { id: 'boost-corgi', giftId: '6267', multiplier: 7, loopClip: 'loop-corgi' };

describe('タップブーストの複数ルール — matchTapBoost', () => {
  it('ギフトごとに自分の行が返る(倍率もクリップも行ごと)', () => {
    const c = rules([PANTHER, CORGI]);
    const p = matchTapBoost(c, { giftId: '723500' });
    const k = matchTapBoost(c, { giftId: '6267' });
    expect(p?.multiplier).toBe(3);
    expect(p?.loopClip).toBe('loop-panther');
    expect(k?.multiplier).toBe(7);
    expect(k?.loopClip).toBe('loop-corgi');
  });

  it('両方に一致するギフトは上の行が勝つ(先勝ち)', () => {
    const c = rules([
      { id: 'a', giftId: '6267', multiplier: 3 },
      { id: 'b', giftId: '6267', multiplier: 9 },
    ]);
    expect(matchTapBoost(c, { giftId: '6267' })?.multiplier).toBe(3);
  });

  it('無効な行は飛ばすが、**下の行の判定は続く**', () => {
    const c = rules([
      { id: 'a', giftId: '6267', multiplier: 3, enabled: false },
      { id: 'b', giftId: '6267', multiplier: 9 },
    ]);
    expect(matchTapBoost(c, { giftId: '6267' })?.multiplier).toBe(9);
  });

  it('機能全体の enabled: false は全行を止める', () => {
    const c = rules([PANTHER, CORGI]);
    c.tapBoost.enabled = false;
    expect(matchTapBoost(c, { giftId: '6267' })).toBeNull();
  });

  it('トリガーが3つとも空の行はどのギフトにも一致しない(既定が無害である担保)', () => {
    expect(matchTapBoost(cfg(), { giftId: '6267' })).toBeNull();
    expect(matchTapBoost(cfg(), { giftId: '723500', giftName: 'Panther' })).toBeNull();
  });

  it('exactName: 部分一致は近い名前を巻き込むが、完全一致なら巻き込まない', () => {
    const partial = rules([{ id: 'a', giftId: '', giftName: 'panther', exactName: false }]);
    const exact = rules([{ id: 'a', giftId: '', giftName: 'panther', exactName: true }]);
    // 実カタログに実在する紛らわしい2件(Panther 723500 / Panther Paw 17632)。
    expect(matchTapBoost(partial, { giftId: '17632', giftName: 'Panther Paw' })).not.toBeNull();
    expect(matchTapBoost(exact, { giftId: '17632', giftName: 'Panther Paw' })).toBeNull();
    expect(matchTapBoost(exact, { giftId: '723500', giftName: 'Panther' })).not.toBeNull();
  });
});

describe('タップブーストの複数ルール — validate(旧・単一設定の引き継ぎ)', () => {
  /** v0.5.4 までの実 settings.json が持っていた形(黒豹1本)。 */
  const legacyFlat = {
    enabled: true,
    giftId: '723500',
    giftName: '黒豹(限定ギフト)',
    canonical: '',
    multiplier: 3,
    durationSec: 10,
    introClip: 'intro-panther',
    countClip: 'count-321',
    loopClip: 'loop-panther',
    resultClip: 'off',
    flash: true,
  };

  it('旧・単一設定は rules[0] へ包み直され、そのまま発動する', () => {
    const v = validateChallengeConfig({
      ...structuredClone(DEFAULT_CHALLENGE),
      tapBoost: legacyFlat,
    } as unknown as ChallengeConfig);
    expect(v.tapBoost.rules).toHaveLength(1);
    expect(v.tapBoost.rules[0]).toMatchObject({
      id: 'boost-1',
      giftId: '723500',
      giftName: '黒豹(限定ギフト)'.toLowerCase(),
      multiplier: 3,
      durationSec: 10,
      loopClip: 'loop-panther',
      // 旧設定に完全一致の概念は無いので、必ず従来どおりの部分一致で始める。
      exactName: false,
    });
    expect(matchTapBoost(v, { giftId: '723500' })?.multiplier).toBe(3);
  });

  it('変換は冪等 — validate を2回通しても結果が変わらない', () => {
    const base = { ...structuredClone(DEFAULT_CHALLENGE), tapBoost: legacyFlat } as unknown as ChallengeConfig;
    const once = validateChallengeConfig(base);
    const twice = validateChallengeConfig(once);
    expect(twice).toEqual(once);
  });

  it('tapBoost キーごと無い旧 settings.json は既定へ', () => {
    const legacy = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    delete legacy.tapBoost;
    expect(validateChallengeConfig(legacy as unknown as ChallengeConfig).tapBoost).toEqual(DEFAULT_TAP_BOOST);
  });

  it('明示的な空配列は空のまま通す(全行消したユーザーの意思)', () => {
    const v = validateChallengeConfig({
      ...structuredClone(DEFAULT_CHALLENGE),
      tapBoost: { enabled: true, rules: [] },
    } as unknown as ChallengeConfig);
    expect(v.tapBoost.rules).toEqual([]);
    expect(matchTapBoost(v, { giftId: '6267' })).toBeNull();
  });

  it('上限で切り、重複・欠損 id は振り直す', () => {
    const many = Array.from({ length: TAP_BOOST_RULES_MAX + 4 }, () => ({ id: 'same', giftId: '1' }));
    const v = validateChallengeConfig({
      ...structuredClone(DEFAULT_CHALLENGE),
      tapBoost: { enabled: true, rules: many },
    } as unknown as ChallengeConfig);
    expect(v.tapBoost.rules).toHaveLength(TAP_BOOST_RULES_MAX);
    expect(new Set(v.tapBoost.rules.map((r) => r.id)).size).toBe(TAP_BOOST_RULES_MAX);
  });

  it('未知のクリップ id は既定へ、明示の off は尊重する', () => {
    const v = validateChallengeConfig({
      ...structuredClone(DEFAULT_CHALLENGE),
      tapBoost: { enabled: true, rules: [{ id: 'a', introClip: 'nope', countClip: 'off', loopClip: 'loop-corgi' }] },
    } as unknown as ChallengeConfig);
    expect(v.tapBoost.rules[0]?.introClip).toBe(DEFAULT_TAP_BOOST_RULE.introClip);
    expect(v.tapBoost.rules[0]?.countClip).toBe('off');
    expect(v.tapBoost.rules[0]?.loopClip).toBe('loop-corgi');
  });

  it('同梱の公開デフォ(resources/challenge-default.json)も黒豹1行として復元される', () => {
    const p = join(__dirname, '../../resources/challenge-default.json');
    const raw = JSON.parse(readFileSync(p, 'utf8')) as ChallengeConfig;
    const v = validateChallengeConfig(raw);
    expect(v.tapBoost.rules[0]?.giftId).toBe('723500');
    expect(matchTapBoost(v, { giftId: '723500' })).not.toBeNull();
  });
});

describe('タップブーストの複数ルール — コーギー行の移行(v7)', () => {
  const legacyPanther = () =>
    validateChallengeConfig({
      ...structuredClone(DEFAULT_CHALLENGE),
      tapBoost: {
        enabled: true,
        giftId: '723500',
        giftName: '',
        canonical: '',
        multiplier: 3,
        durationSec: 10,
        introClip: 'intro-panther',
        countClip: 'count-321',
        loopClip: 'loop-panther',
        resultClip: 'off',
        flash: true,
      },
    } as unknown as ChallengeConfig);

  it('v7 未満の設定にはコーギー行が1本だけ足され、黒豹はそのまま残る', () => {
    const out = migrateChallengeTapBoostCorgi(legacyPanther(), 6);
    expect(out.tapBoost.rules).toHaveLength(2);
    expect(out.tapBoost.rules[0]?.giftId).toBe('723500');
    expect(out.tapBoost.rules[1]).toMatchObject({
      giftId: '6267',
      label: 'コーギー',
      introClip: 'intro-corgi',
      countClip: 'count-corgi',
      loopClip: 'loop-corgi',
      resultClip: 'result-corgi',
    });
  });

  it('二重に増えない — 2回流しても、既に自分でコーギー行を作っていても1本のまま', () => {
    const once = migrateChallengeTapBoostCorgi(legacyPanther(), 6);
    const twice = migrateChallengeTapBoostCorgi(once, 6);
    expect(twice.tapBoost.rules.filter((r) => r.giftId === '6267')).toHaveLength(1);

    const hand = rules([{ id: 'mine', giftId: '6267', multiplier: 2 }]);
    const out = migrateChallengeTapBoostCorgi(hand, 6);
    expect(out.tapBoost.rules).toHaveLength(1);
    expect(out.tapBoost.rules[0]?.multiplier).toBe(2);
  });

  it('v7 以降の設定には配らない(消した人に復活させない)', () => {
    const c = legacyPanther();
    expect(migrateChallengeTapBoostCorgi(c, 7)).toBe(c);
    expect(migrateChallengeConfig(c, 7).tapBoost.rules).toHaveLength(1);
  });

  it('上限に達している設定には足さない', () => {
    const full = rules(Array.from({ length: TAP_BOOST_RULES_MAX }, (_, i) => ({ id: `r${i}`, giftId: `${i}` })));
    expect(migrateChallengeTapBoostCorgi(full, 0).tapBoost.rules).toHaveLength(TAP_BOOST_RULES_MAX);
  });

  it('配られるコーギー行はカタログに実在するクリップだけを指す(validate で落ちない)', () => {
    const out = migrateChallengeTapBoostCorgi(legacyPanther(), 0);
    const v = validateChallengeConfig(out);
    expect(v.tapBoost.rules[1]).toEqual(out.tapBoost.rules[1]);
    expect(v.tapBoost.rules[1]?.loopClip).toBe('loop-corgi');
    expect(CORGI_TAP_BOOST_RULE.resultClip).toBe('result-corgi');
  });
});

describe('タップブーストの複数ルール — エンジン経由で別々に発動する', () => {
  it('黒豹とコーギーが、それぞれ自分の倍率とクリップで boost-start を焼き込む', () => {
    const c = rules([
      { ...PANTHER, durationSec: 10, introClip: 'intro-panther', countClip: 'count-321' },
      { ...CORGI, durationSec: 15, introClip: 'intro-corgi', countClip: 'count-corgi', resultClip: 'result-corgi' },
    ]);
    // エンジンは1本ずつ分ける — 1本目のブーストが最長23秒の凍結を張るので、
    // 時刻を進めないこのテストでは同じエンジンの2発目が保留キューへ落ちる。
    const e = engine(c);
    e.start();

    expect(e.handleEvent(gift({ giftId: '723500', giftName: 'Panther' }))).toBe(true);
    const first = e.get().recentEffects.filter((x) => x.kind === 'boost-start');
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      boostMultiplier: 3,
      boostLoopClip: 'loop-panther',
      boostIntroClip: 'intro-panther',
    });
    // 前置き5秒+カウント3秒+ウィンドウ10秒 ぶんの尺が焼き込まれている。
    expect(first[0]?.fxDurationMs).toBe(TAP_BOOST_INTRO_MS + 3000 + 10_000);

    const e2 = engine(c);
    e2.start();
    expect(e2.handleEvent(gift({ giftId: '6267', giftName: 'Corgi' }))).toBe(true);
    const second = e2.get().recentEffects.filter((x) => x.kind === 'boost-start');
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({
      boostMultiplier: 7,
      boostLoopClip: 'loop-corgi',
      boostIntroClip: 'intro-corgi',
      boostCountClip: 'count-corgi',
      boostResultClip: 'result-corgi',
    });
  });

  it('どの行にも一致しないギフトはブーストを起こさない', () => {
    const e = engine(rules([PANTHER, CORGI]));
    e.start();
    e.handleEvent(gift({ giftId: '5655', giftName: 'Rose' }));
    expect(e.get().recentEffects.filter((x) => x.kind === 'boost-start')).toHaveLength(0);
  });
});

describe('ブースト素材のカタログと実ファイル', () => {
  const dir = join(__dirname, '../../src/renderer/assets/fx/boost');
  // 素材が未同梱でも boostClipUrl は 0 件許容 glob なので**黙って暗幕**になる。
  // カタログ id とファイル名のズレは実行時まで気づけないので、ここで機械検出する。
  const KNOWN_MISSING = new Set(['result-panther']);

  const all = [
    ...TAP_BOOST_INTRO_CLIPS,
    ...TAP_BOOST_COUNT_CLIPS,
    ...TAP_BOOST_LOOP_CLIPS,
    ...TAP_BOOST_RESULT_CLIPS,
  ];

  it('カタログの id は assets/fx/boost/<id>.mp4 に対応する(既知の未同梱を除く)', () => {
    const missing = all.filter((c) => !KNOWN_MISSING.has(c.id) && !existsSync(join(dir, `${c.id}.mp4`)));
    expect(missing.map((c) => c.id)).toEqual([]);
  });

  it('既定が指すクリップは必ず実ファイルがある(全ユーザーが暗幕を見ないための担保)', () => {
    for (const r of [DEFAULT_TAP_BOOST_RULE, NEBAARU_TAP_BOOST_RULE, CORGI_TAP_BOOST_RULE]) {
      for (const id of [r.introClip, r.countClip, r.loopClip, r.resultClip]) {
        if (id === 'off') continue;
        expect({ id, exists: existsSync(join(dir, `${id}.mp4`)) }).toEqual({ id, exists: true });
      }
    }
  });

  it('id はカタログ内で重複しない', () => {
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });
});

describe('タップブーストの既定行の差し替え(v9・黒豹 → ねば〜る君)', () => {
  /** v0.7.8 までが配っていた黒豹の既定行(実機の settings.json / デフォ保存と同じ形)。 */
  const pantherRow = (): Partial<TapBoostRule> => ({
    id: 'boost-1',
    label: '',
    giftId: '723500',
    giftName: '黒豹(限定ギフト)',
    multiplier: 3,
    durationSec: 10,
    introClip: 'intro-panther',
    countClip: 'count-321',
    loopClip: 'loop-panther',
    resultClip: 'off',
  });

  it('旧既定のままの黒豹行はねば〜る君へ寄せ替わる', () => {
    const out = migrateChallengeTapBoostNebaaru(rules([pantherRow()]), 8);
    // 足す移行ではないので行数は増えない。
    expect(out.tapBoost.rules).toHaveLength(1);
    expect(out.tapBoost.rules[0]).toMatchObject({
      id: 'boost-1',
      label: 'ねば〜る君',
      giftId: '14463',
      introClip: 'intro-nebaaru',
      countClip: 'count-nebaaru',
      loopClip: 'loop-nebaaru',
      resultClip: 'result-nebaaru',
    });
  });

  it("giftName を空にする — '黒豹(限定ギフト)' が部分一致トリガーとして残らない", () => {
    const out = migrateChallengeTapBoostNebaaru(rules([pantherRow()]), 8);
    expect(out.tapBoost.rules[0]?.giftName).toBe('');
    // 名前で黒豹を撃っても、もう当たらない。
    expect(matchTapBoost(out, { giftId: '999', giftName: '黒豹(限定ギフト)' })).toBeNull();
    // ねば〜る君の giftId では当たる。
    expect(matchTapBoost(out, { giftId: '14463' })?.loopClip).toBe('loop-nebaaru');
  });

  it('倍率・ウィンドウ秒・enabled は現場の値を残す(テーマ差し替えで巻き戻さない)', () => {
    const tuned = rules([{ ...pantherRow(), multiplier: 7, durationSec: 15, enabled: false }]);
    const out = migrateChallengeTapBoostNebaaru(tuned, 8);
    expect(out.tapBoost.rules[0]).toMatchObject({
      giftId: '14463',
      multiplier: 7,
      durationSec: 15,
      enabled: false,
    });
  });

  it('クリップを選び直してある行は触らない', () => {
    const kept = rules([{ ...pantherRow(), introClip: 'intro-corgi' }]);
    expect(migrateChallengeTapBoostNebaaru(kept, 8)).toBe(kept);
  });

  it('自分で作った別 id の黒豹行は触らない', () => {
    const mine = rules([{ ...pantherRow(), id: 'mine' }]);
    expect(migrateChallengeTapBoostNebaaru(mine, 8).tapBoost.rules[0]?.giftId).toBe('723500');
  });

  it('既に 14463 の行を持っている設定には何もしない(二重一致を作らない)', () => {
    const already = rules([pantherRow(), { id: 'mine', giftId: '14463' }]);
    expect(migrateChallengeTapBoostNebaaru(already, 8)).toBe(already);
  });

  it('v9 以降には流れない(黒豹に戻した人へ配り直さない)', () => {
    const c = rules([pantherRow()]);
    expect(migrateChallengeTapBoostNebaaru(c, 9)).toBe(c);
  });

  it('冪等 — 2回流しても変わらない', () => {
    const once = migrateChallengeTapBoostNebaaru(rules([pantherRow()]), 8);
    expect(migrateChallengeTapBoostNebaaru(once, 8)).toEqual(once);
  });

  it('コーギー行(v7)は無傷のまま、黒豹行だけが差し替わる', () => {
    const both = rules([pantherRow(), { ...CORGI_TAP_BOOST_RULE, multiplier: 10 }]);
    const out = migrateChallengeTapBoostNebaaru(both, 8);
    expect(out.tapBoost.rules.map((r) => r.giftId)).toEqual(['14463', '6267']);
    // 利用者が ×10 に詰めたコーギーの倍率は残る。
    expect(out.tapBoost.rules[1]?.multiplier).toBe(10);
  });

  it('v7 のコーギー追加と同時に走っても、黒豹が差し替わりコーギーが足される', () => {
    const out = migrateChallengeConfig(rules([pantherRow()]), 6);
    expect(out.tapBoost.rules.map((r) => r.giftId)).toEqual(['14463', '6267']);
  });

  it('寄せ替え先はカタログに実在するクリップだけを指す(validate で落ちない)', () => {
    // ここが綴りのタイポを機械検出する要。未知 id なら validate が既定へ倒して差分が出る。
    const out = migrateChallengeTapBoostNebaaru(rules([pantherRow()]), 8);
    expect(validateChallengeConfig(out).tapBoost.rules[0]).toEqual(out.tapBoost.rules[0]);
  });
});
