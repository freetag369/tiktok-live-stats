import { describe, expect, it } from 'vitest';
import {
  BOOST_RESUME_COUNT_MIN_MS,
  BOOST_RESUME_MIN_MS,
  BOOST_START_GRACE_MS,
  boostStartTiming,
  planBoostStart,
  type BoostStartPlan,
  type QueuedBoostTiming,
} from '@shared/boost-start';
import {
  BOOST_ARM_MAX_MS,
  GIFT_FX_FREEZE_MAX_TOTAL_MS,
  TAP_BOOST_COUNT_MS,
  TAP_BOOST_DURATION_MIN_SEC,
  TAP_BOOST_INTRO_MS,
} from '@shared/challenge';
import type { ChallengeEffect } from '@shared/dto';

/*
 * 既定設定そのままの数字で読めるようにしておく — 実配信で起きる形と表が一致する。
 * 起動 5秒 + カウント 3秒 + ウィンドウ 5秒 = 総尺 13秒。
 */
const AT = 1_000_000;
const INTRO = TAP_BOOST_INTRO_MS; // 5000
const COUNT = TAP_BOOST_COUNT_MS; // 3000
const WINDOW = 5000;
const TOTAL = INTRO + COUNT + WINDOW; // 13000
const ENDS = AT + TOTAL;

function t(over: Partial<QueuedBoostTiming> = {}): QueuedBoostTiming {
  return { atMs: AT, endsAtMs: ENDS, introMs: INTRO, countMs: COUNT, totalMs: TOTAL, ...over };
}

/**
 * 判定の原点。planBoostStart は endsAt - totalMs を起点に elapsed を測るので、
 * ここが「タイムラインが始まったことになっている時刻」。通常形では atMs だが、
 * **アーム形では atMs + BOOST_ARM_MAX_MS(= アーム期限)**になる — それが
 * 「アーム中は必ず full = 起動カットインが満尺で出る」を追加コードなしで
 * 成立させている仕掛け(shared/boost-start.ts の冒頭)。
 */
function origin(timing: QueuedBoostTiming): number {
  return (timing.endsAtMs ?? timing.atMs + timing.totalMs) - timing.totalMs;
}

describe('planBoostStart — 持ち越しブーストの再開判定', () => {
  const cases: Array<[string, QueuedBoostTiming, number, BoostStartPlan]> = [
    ['遅延ゼロ(即ドレイン)= 従来どおり頭から', t(), AT, { action: 'full' }],
    ['猶予ちょうど(delta 配送の最悪遅延を飲む)', t(), AT + BOOST_START_GRACE_MS, { action: 'full' }],
    [
      '猶予の 1ms 外 → 前置きの残りでカウントダウンから',
      t(),
      AT + BOOST_START_GRACE_MS + 1,
      { action: 'resume', phase: 'count', introMs: INTRO + COUNT - 751 - COUNT, countMs: COUNT, remainingMs: TOTAL - 751 },
    ],
    [
      '前置き途中(ストックカットイン 5秒ぶん遅れ)',
      t(),
      AT + 6000,
      { action: 'resume', phase: 'count', introMs: 0, countMs: 2000, remainingMs: 7000 },
    ],
    [
      '前置き残りが 600ms 未満 → 段ごと捨てて即ウィンドウ',
      t(),
      AT + 7500,
      { action: 'resume', phase: 'window', introMs: 0, countMs: 0, remainingMs: 5500 },
    ],
    [
      'ウィンドウ突入後(スピン1本ぶん遅れ)',
      t(),
      AT + 9000,
      { action: 'resume', phase: 'window', introMs: 0, countMs: 0, remainingMs: 4000 },
    ],
    [
      '残り 1500 ちょうど(境界・再生側 — 規則は remaining < MIN で見送り)',
      t(),
      ENDS - BOOST_RESUME_MIN_MS,
      { action: 'resume', phase: 'window', introMs: 0, countMs: 0, remainingMs: BOOST_RESUME_MIN_MS },
    ],
    ['残り 1499(境界・見送り側)', t(), ENDS - BOOST_RESUME_MIN_MS + 1, { action: 'skip', reason: 'tail' }],
    ['期限ちょうど', t(), ENDS, { action: 'skip', reason: 'ended' }],
    ['ルーレット連鎖 19秒後(B2 の本命)', t(), AT + 19_050, { action: 'skip', reason: 'ended' }],
    [
      'カウント段なし(countClip が off)',
      t({ countMs: 0, totalMs: INTRO + WINDOW, endsAtMs: AT + INTRO + WINDOW }),
      AT + 3000,
      { action: 'resume', phase: 'window', introMs: 0, countMs: 0, remainingMs: 7000 },
    ],
    [
      'プレーンモード(前置きなし)',
      t({ introMs: 0, countMs: 0, totalMs: WINDOW, endsAtMs: AT + WINDOW }),
      AT + 2000,
      { action: 'resume', phase: 'window', introMs: 0, countMs: 0, remainingMs: 3000 },
    ],
    [
      'endsAtMs 欠損(旧 worker)→ atMs + totalMs で代用',
      t({ endsAtMs: undefined }),
      AT + 9000,
      { action: 'resume', phase: 'window', introMs: 0, countMs: 0, remainingMs: 4000 },
    ],
    ['endsAtMs 欠損 かつ totalMs 0 → 素通し(fail-open)', t({ endsAtMs: undefined, totalMs: 0 }), AT + 99_999, { action: 'full' }],
    ['未来の effect(時計ずれ・負の elapsed)', t(), AT - 3000, { action: 'full' }],
    [
      '壊れた effect(totalMs < introMs + countMs)ではカウント段を選ばない',
      t({ totalMs: 6000, endsAtMs: AT + 6000 }),
      AT + 3000,
      { action: 'resume', phase: 'window', introMs: 0, countMs: 0, remainingMs: 3000 },
    ],
  ];

  for (const [name, timing, now, expected] of cases) {
    it(name, () => {
      expect(planBoostStart(timing, now)).toEqual(expected);
    });
  }
});

describe('planBoostStart — 不変条件(掃引)', () => {
  /** 既定形を 50ms 刻みで掃く。 */
  function sweep(timing: QueuedBoostTiming, from: number, to: number): Array<[number, BoostStartPlan]> {
    const out: Array<[number, BoostStartPlan]> = [];
    for (let n = from; n <= to; n += 50) out.push([n, planBoostStart(timing, n)]);
    return out;
  }

  it('resume の残り尺は必ず startBoostFx の下限(1000ms)を超える', () => {
    for (const [, p] of sweep(t(), AT - 2000, ENDS + 5000)) {
      if (p.action === 'resume') expect(p.remainingMs).toBeGreaterThan(1000);
    }
  });

  it('phase === "count" ⇔ countMs > 0', () => {
    for (const [, p] of sweep(t(), AT - 2000, ENDS + 5000)) {
      if (p.action !== 'resume') continue;
      expect(p.countMs > 0).toBe(p.phase === 'count');
    }
  });

  it('カウント段は素材の実尺(3秒)を超えない — 超えると 3・2・1 の後に静止フレームで待つ', () => {
    // v0.7.2 のバグ: 前置きの残りを丸ごと countMs へ入れていたため、遅れが intro より
    // 小さいと段が 3 秒を超え、`<video loop>` は window 段でしか立たない(MonitorView の
    // boost-cutin)ので素材が終わってから静止画で待っていた。
    for (const [, p] of sweep(t(), AT - 2000, ENDS + 5000)) {
      if (p.action === 'resume') expect(p.countMs).toBeLessThanOrEqual(COUNT);
    }
  });

  it('起動カットイン段は実尺(5秒)を超えず、2段の合計は前置きの残りと一致する', () => {
    for (const [now, p] of sweep(t(), AT - 2000, ENDS + 5000)) {
      if (p.action !== 'resume') continue;
      expect(p.introMs).toBeLessThanOrEqual(INTRO);
      // 守る契約は「ウィンドウが開く時刻」— 段の分け方に依らず合計は不変。
      if (p.phase === 'count')
        expect(p.introMs + p.countMs).toBe(INTRO + COUNT - (now - origin(t())));
    }
  });

  it('ウィンドウ部分(remainingMs - countMs)は必ず BOOST_RESUME_MIN_MS 以上', () => {
    for (const [, p] of sweep(t(), AT - 2000, ENDS + 5000)) {
      if (p.action === 'resume') {
        expect(p.remainingMs - p.countMs).toBeGreaterThanOrEqual(BOOST_RESUME_MIN_MS);
      }
    }
  });

  it('時間が進むと full → resume → skip の一方向にしか遷移しない', () => {
    const seen = sweep(t(), AT - 2000, ENDS + 5000).map(([, p]) => p.action);
    const rank = { full: 0, resume: 1, skip: 2 } as const;
    for (let i = 1; i < seen.length; i++) {
      expect(rank[seen[i]!], `index ${i}`).toBeGreaterThanOrEqual(rank[seen[i - 1]!]);
    }
    // 3相すべてを実際に通っていること(掃引が意味を持っている証拠)。
    expect(new Set(seen)).toEqual(new Set(['full', 'resume', 'skip']));
  });
});

describe('planBoostStart — 定数の整合', () => {
  it('最短のフィーバー(5秒)を即時ドレインで見送らない', () => {
    expect(BOOST_RESUME_MIN_MS).toBeLessThan(TAP_BOOST_DURATION_MIN_SEC * 1000);
  });

  it('猶予は delta 配送の最悪遅延(~525ms)を飲む', () => {
    expect(BOOST_START_GRACE_MS).toBeGreaterThan(525);
  });

  it('resume の残り尺の下限は startBoostFx の boostWillStart 下限(1000)を超える', () => {
    expect(BOOST_RESUME_MIN_MS).toBeGreaterThan(1000);
  });

  it('カウント段の最小残りは段の実尺より短い(そうでないと resume/count に入れない)', () => {
    expect(BOOST_RESUME_COUNT_MIN_MS).toBeLessThan(TAP_BOOST_COUNT_MS);
  });
});

describe('planBoostStart — アーム形(worker がフォールバックの期限を焼いた場合)', () => {
  // worker はギフト着弾で発動を**予約するだけ**にし、boostEndsAtMs には
  // 「アーム期限で強制発動した場合」のタイムラインを焼く。実尺(totalMs)は
  // 変えないので、判定の原点はちょうどアーム期限になる。
  const DEADLINE = AT + BOOST_ARM_MAX_MS;
  const armed = (): QueuedBoostTiming => t({ endsAtMs: DEADLINE + TOTAL });

  it('アーム期限までは何秒待っても full — 「起動カットインが必ず満尺で出る」の根拠', () => {
    expect(origin(armed())).toBe(DEADLINE);
    for (const now of [AT, AT + 5_000, AT + 30_000, DEADLINE - 1, DEADLINE]) {
      expect(planBoostStart(armed(), now), `now-AT=${now - AT}`).toEqual({ action: 'full' });
    }
  });

  it('猶予(750ms)までは期限を過ぎても full', () => {
    expect(planBoostStart(armed(), DEADLINE + BOOST_START_GRACE_MS)).toEqual({ action: 'full' });
  });

  it('期限を過ぎたら従来どおり resume → skip へ連続的に劣化する', () => {
    expect(planBoostStart(armed(), DEADLINE + 6000)).toMatchObject({ action: 'resume', phase: 'count' });
    expect(planBoostStart(armed(), DEADLINE + TOTAL)).toEqual({ action: 'skip', reason: 'ended' });
  });

  it('掃引の不変条件は通常形とまったく同じ(原点が動くだけ)', () => {
    const o = origin(armed());
    const seen: BoostStartPlan['action'][] = [];
    for (let n = DEADLINE - 2000; n <= DEADLINE + TOTAL + 5000; n += 50) {
      const p = planBoostStart(armed(), n);
      seen.push(p.action);
      if (p.action !== 'resume') continue;
      expect(p.remainingMs).toBeGreaterThan(1000);
      expect(p.countMs).toBeLessThanOrEqual(COUNT);
      expect(p.introMs).toBeLessThanOrEqual(INTRO);
      expect(p.countMs > 0).toBe(p.phase === 'count');
      expect(p.remainingMs - p.countMs).toBeGreaterThanOrEqual(BOOST_RESUME_MIN_MS);
      if (p.phase === 'count') expect(p.introMs + p.countMs).toBe(INTRO + COUNT - (n - o));
    }
    const rank = { full: 0, resume: 1, skip: 2 } as const;
    for (let i = 1; i < seen.length; i += 1) {
      expect(rank[seen[i]!], `index ${i}`).toBeGreaterThanOrEqual(rank[seen[i - 1]!]);
    }
    expect(new Set(seen)).toEqual(new Set(['full', 'resume', 'skip']));
  });

  it('アーム期限は猶予より長く、舞台を塞ぐ最悪ケース(帯カットイン反復)を飲む', () => {
    expect(BOOST_ARM_MAX_MS).toBeGreaterThan(BOOST_START_GRACE_MS);
    // giftFxRepeat が GIFT_FX_FREEZE_MAX_TOTAL_MS で反復回数を削るので、1本の
    // カットインが舞台を占める最長がこの値。ここを下回ると、正当な長尺カットイン
    // の最中に期限が切れて「起動カットインが飛ばされる」が再発する。
    expect(BOOST_ARM_MAX_MS).toBeGreaterThan(GIFT_FX_FREEZE_MAX_TOTAL_MS);
  });
});

describe('boostStartTiming — effect からのフィールド対応', () => {
  it('worker が積む boost-start の形をそのまま写す', () => {
    const e = {
      id: 7,
      kind: 'boost-start',
      atMs: AT,
      amount: 0,
      valueAfter: 500,
      fxDurationMs: TOTAL,
      boostEndsAtMs: ENDS,
      boostIntroMs: INTRO,
      boostCountMs: COUNT,
    } as unknown as ChallengeEffect;
    expect(boostStartTiming(e)).toEqual({
      atMs: AT,
      endsAtMs: ENDS,
      introMs: INTRO,
      countMs: COUNT,
      totalMs: TOTAL,
    });
  });

  it('欠損フィールドは 0 / undefined に畳む(旧 worker 混在)', () => {
    const e = { id: 8, kind: 'boost-start', atMs: AT, amount: 0, valueAfter: 500 } as unknown as ChallengeEffect;
    expect(boostStartTiming(e)).toEqual({
      atMs: AT,
      endsAtMs: undefined,
      introMs: 0,
      countMs: 0,
      totalMs: 0,
    });
  });
});
