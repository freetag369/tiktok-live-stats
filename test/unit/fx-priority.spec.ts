import { describe, expect, it } from 'vitest';
import type { ChallengeEffect } from '@shared/dto';
import {
  BANNER_PRIORITY,
  DRAIN_PRIORITY,
  FX_BANNER_KINDS,
  FX_DRAIN_KINDS,
  FX_PRIORITY_ORDER,
  bannerRank,
  bestRank,
  fxClassForEffect,
  fxRank,
  shouldYieldSpinChain,
  strikeClass,
} from '@shared/fx-priority';

/**
 * 演出の優先順位の凍結。**順位を変えるときは必ずこのテストの期待値を一緒に
 * 編集する** — それが「順位変更は明示的な決定を伴う」の強制点であり、
 * fx-priority.ts の規約(新演出はユーザーに位置を確認して登録)の値レベル担保。
 * 型レベル(satisfies / 網羅 switch)は typecheck が担うので、ここは値だけ見る。
 */

describe('FX_PRIORITY_ORDER — 序列の凍結(ユーザー決定 2026-08-16 / 2026-08-18)', () => {
  it('15ランクの並びは固定(変更にはユーザー確認とこのテストの編集が要る)', () => {
    expect(FX_PRIORITY_ORDER).toEqual([
      'follow',
      'strike-like',
      'strike-stock',
      'boost',
      'tap-lock',
      'helper',
      // ダイヤ増減の浮上(2026-08-26)。ユーザー決定はお助けの直後(入室ルーレットの
      // 直前)。高額ギフトの手応えをルーレット・カットインに埋もれさせないため。
      'gift-scale',
      // ライオン(Lion 29,999💎・2026-08-26)。ユーザー決定は「お助けの直後・初見
      // ルーレットより上」。gift-scale の直後なのは、あちらの「お助けの直後」という
      // 同日の決定(下の等式で凍結)を崩さずに実質の要件を満たせるから。
      'lion',
      'join-roulette',
      'hot-roulette',
      'band',
      'revolution',
      // 一撃クリア(TIKTOK UNIVERSE・2026-08-26)。ユーザー決定は revolution の直後
      // (quiz の直前)。開始順は quiz と同じくバリア方式が支配する。
      'universe',
      // お題ルーレット(2026-08-21)。序列上は revolution の直後だが、実際の開始順は
      // バリア方式(モニターの armed 監視 + worker の quizDeferredOps)が支配する —
      // ここへの登録は quiz-end(結果発表)の持ち越しとバナーの取り出し順の保険。
      'quiz',
      'other',
    ]);
  });

  it('革命は band の直後・通常ギフトルーレットの直前(2026-08-20 ユーザー決定)', () => {
    // ユーザー決定は「通常ルーレットの前だけ」— 初見(⑥)と激熱確定(⑥.5)は
    // 革命より上のまま。band(⑦)より下なのは、革命が 13 秒の導入を持つ山場でも
    // カットインの列を追い越すほどではないという位置づけ。
    expect(fxRank('revolution')).toBe(fxRank('band') + 1);
    expect(fxRank('revolution')).toBeLessThan(fxRank('other'));
    expect(fxRank('revolution')).toBeGreaterThan(fxRank('join-roulette'));
    expect(fxRank('revolution')).toBeGreaterThan(fxRank('hot-roulette'));
  });

  it('ライオンはダイヤ増減の直後・初見ルーレットの直前(2026-08-26 ユーザー決定)', () => {
    // ユーザー決定は「お助けの直後・初見ルーレットより上」。同日に決まった
    // gift-scale が helper の直後を取っているので、その**直後**に置いて両方の
    // 決定を満たす(gift-scale は 1.6 秒の浮上バナーなので、43 秒の幕の前に
    // 通しても失うものが無い)。
    expect(fxRank('lion')).toBe(fxRank('gift-scale') + 1);
    expect(fxRank('lion')).toBe(fxRank('join-roulette') - 1);
    expect(fxRank('lion')).toBeGreaterThan(fxRank('helper'));
    // 実質の要件: 初見・激熱確定・band・通常ルーレットより先に出る。
    expect(fxRank('lion')).toBeLessThan(fxRank('hot-roulette'));
    expect(fxRank('lion')).toBeLessThan(fxRank('band'));
    expect(fxRank('lion')).toBeLessThan(fxRank('other'));
    // effect 側の分類とバナー側が一致する(飢餓の罠の機械的な回帰止め)。
    const e = {
      kind: 'lion-end',
      id: 1,
      amount: 1_499_950,
      atMs: 0,
      valueAfter: 0,
    } as unknown as Parameters<typeof fxClassForEffect>[0];
    expect(fxClassForEffect(e)).toBe('lion');
    expect(bannerRank('lion')).toBe(fxRank('lion'));
    expect(bannerRank('lion')).toBeLessThan(fxRank(DRAIN_PRIORITY.band));
    expect(bannerRank('lion')).toBeLessThan(fxRank(DRAIN_PRIORITY.roulette));
  });

  it('一撃クリアは革命の直後・お題の直前(2026-08-26 ユーザー決定)', () => {
    // 位置の根拠: カウントを 0 にしてランを終わらせる 25 秒の山場(導入カット8秒
    // + 30段の減算連打9秒 + 締めカット8秒)。band より下なのは revolution と同じ
    // 位置づけで、カットインの列を追い越すほどではないという判断。
    expect(fxRank('universe')).toBe(fxRank('revolution') + 1);
    expect(fxRank('universe')).toBe(fxRank('quiz') - 1);
    expect(fxRank('universe')).toBeGreaterThan(fxRank('band'));
    expect(fxRank('universe')).toBeLessThan(fxRank('other'));
  });

  it('激熱確定は band より上・初見ルーレットより下(2026-08-18 ユーザー決定)', () => {
    // 位置の根拠: 激熱確定は専用ギフトでしか出ない 1 本 43 秒の山場なので、
    // 通常のギフトルーレット(⑧)と同じ列で待たせると因果が読めなくなる。
    // カットイン(band)は何度でも出るが激熱確定は出ないので、band より上。
    expect(fxRank('hot-roulette')).toBeLessThan(fxRank('band'));
    expect(fxRank('hot-roulette')).toBeGreaterThan(fxRank('join-roulette'));
    expect(fxRank('hot-roulette')).toBeLessThan(fxRank('other'));
  });

  it('お邪魔(タップ封じ)は boost の直後・helper より上(2026-08-18 ユーザー決定)', () => {
    // 位置の根拠は boost が④に居るのと同じ — 封印は worker の絶対時刻で走るので、
    // band(⑦)の後ろに並べると渋滞中に「残り数秒」で告知が出る。
    expect(fxRank('tap-lock')).toBe(fxRank('boost') + 1);
    expect(fxRank('tap-lock')).toBeLessThan(fxRank('helper'));
  });

  it('strike-like と strike-stock は隣接する(pendingStrike を合算1件で扱える根拠)', () => {
    // ②③の間に他の演出が挟まると「いいね+ストックの2段着弾を1チェーンで流す」
    // 既存設計(queueStrike の合算)と矛盾する — 並び替えるならまず設計を見直すこと。
    expect(fxRank('strike-stock')).toBe(fxRank('strike-like') + 1);
  });

  it('登録簿の種別一覧も凍結(登録漏れ・無断追加の検出)', () => {
    expect(FX_DRAIN_KINDS).toEqual([
      'strike',
      'boost',
      'join-roulette',
      'hot-roulette',
      'band',
      'revolution',
      'quiz',
      'roulette',
    ]);
    expect(FX_BANNER_KINDS).toEqual([
      'follow',
      'helper',
      'gift-card',
      'gift-scale',
      'comment',
      'like-float',
      'stock-float',
      'roulette-result',
      'roulette-rest',
      'roulette-result-hot',
      'roulette-rest-hot',
      'boost-announce',
      'boost-result',
      'tap-lock',
      'revolution-announce',
      'revolution-result',
      'universe',
      'lion',
      'quiz-announce',
      'quiz-result',
    ]);
    // 全登録が有効なクラスを指す(satisfies の値レベル二重化)。
    for (const k of FX_DRAIN_KINDS) expect(FX_PRIORITY_ORDER).toContain(DRAIN_PRIORITY[k]);
    for (const k of FX_BANNER_KINDS) expect(FX_PRIORITY_ORDER).toContain(BANNER_PRIORITY[k]);
  });

  it('ギフトルーレットは「その他」・バナーは由来のある3種以外すべて「その他」', () => {
    expect(DRAIN_PRIORITY.roulette).toBe('other');
    expect(BANNER_PRIORITY.follow).toBe('follow');
    expect(BANNER_PRIORITY.helper).toBe('helper');
    // フィーバーのバナーは effect 側(fxClassForEffect の boost-start / boost-end)と
    // 同じ④。⑧のままだと band(⑦)のドレインに bannerWinsByRank(厳密 <)で
    // **構造的に永久に負け**、結果バナーが順番待ちの底に沈む(2026-08-17 修正)。
    expect(BANNER_PRIORITY['boost-announce']).toBe('boost');
    expect(BANNER_PRIORITY['boost-result']).toBe('boost');
    // お邪魔の告知も同じ理由で effect 側の分類と揃える(⑧のままだと band に永久に負ける)。
    expect(BANNER_PRIORITY['tap-lock']).toBe('tap-lock');
    // 激熱確定のバナーも effect 側(fxClassForEffect の 'hot-roulette')と揃える。
    expect(DRAIN_PRIORITY['hot-roulette']).toBe('hot-roulette');
    expect(BANNER_PRIORITY['roulette-result-hot']).toBe('hot-roulette');
    expect(BANNER_PRIORITY['roulette-rest-hot']).toBe('hot-roulette');
    // 革命のバナーも同じ理由で effect 側(revolution-start/-end)と揃える。
    expect(DRAIN_PRIORITY.revolution).toBe('revolution');
    expect(BANNER_PRIORITY['revolution-announce']).toBe('revolution');
    expect(BANNER_PRIORITY['revolution-result']).toBe('revolution');
    // お題ルーレットも同じ理由(quiz-start/-end → 'quiz')。'other' のままだと
    // band のドレインに厳密 < 判定で永久に負ける(boost / tap-lock / revolution の前例)。
    expect(DRAIN_PRIORITY.quiz).toBe('quiz');
    expect(BANNER_PRIORITY['quiz-announce']).toBe('quiz');
    expect(BANNER_PRIORITY['quiz-result']).toBe('quiz');
    // 一撃クリアのバナーも同じ理由(universe-start/-end → 'universe')。
    // **ドレインキューは持たない**(バリア方式なので universe-start は積まれず、
    // universe-end も結果カットシーンを持たない)ので DRAIN_PRIORITY には出てこない。
    expect(BANNER_PRIORITY.universe).toBe('universe');
    // ライオンも同じ理由(lion-start/-end → 'lion')。**ドレインキューは持たない**
    // (universe と同じバリア方式)ので DRAIN_PRIORITY には出てこない。
    expect(BANNER_PRIORITY.lion).toBe('lion');
    // ダイヤ増減のバナーも同じ理由で effect 側(fxClassForEffect の gift + giftScale)と
    // 揃える。'other' のままだと band のドレインに厳密 < 判定で永久に負ける。
    expect(BANNER_PRIORITY['gift-scale']).toBe('gift-scale');
    const named = new Set([
      'follow',
      'helper',
      'boost-announce',
      'boost-result',
      'tap-lock',
      'roulette-result-hot',
      'roulette-rest-hot',
      'revolution-announce',
      'revolution-result',
      'universe',
      'lion',
      'quiz-announce',
      'quiz-result',
      'gift-scale',
    ]);
    for (const k of FX_BANNER_KINDS) {
      if (!named.has(k)) expect(BANNER_PRIORITY[k]).toBe('other');
    }
  });

  it('フィーバーのバナーは band / ギフトルーレットのドレインに勝てる', () => {
    // 「勝てない」= 渋滞中にフィーバー結果が一度も出ない、という実害の回帰検知。
    expect(bannerRank('boost-result')).toBeLessThan(fxRank(DRAIN_PRIORITY.band));
    expect(bannerRank('boost-result')).toBeLessThan(fxRank(DRAIN_PRIORITY.roulette));
  });

  it('ダイヤ増減のバナーと effect の分類が一致する(飢餓の罠の機械的な回帰止め)', () => {
    // バナー側と effect 側でクラスがズレると bannerWinsByRank の厳密 < 判定で
    // band のドレインに構造的に永久に負ける — boost-announce / tap-lock /
    // roulette-*-hot / revolution / quiz が4回踏んだ罠。ここで機械的に止める。
    const e = {
      kind: 'gift',
      id: 1,
      amount: -250_000,
      atMs: 0,
      valueAfter: 0,
      giftScale: true,
    } as unknown as Parameters<typeof fxClassForEffect>[0];
    expect(fxClassForEffect(e)).toBe('gift-scale');
    expect(bannerRank('gift-scale')).toBe(fxRank('gift-scale'));
    // お助けより下・入室ルーレットより上(ユーザー決定の位置)。
    expect(fxRank('gift-scale')).toBe(fxRank('helper') + 1);
    expect(fxRank('gift-scale')).toBeLessThan(fxRank('join-roulette'));
    // band / ギフトルーレットのドレインには勝てる(渋滞中でも「ドン」が出る)。
    expect(bannerRank('gift-scale')).toBeLessThan(fxRank(DRAIN_PRIORITY.band));
    expect(bannerRank('gift-scale')).toBeLessThan(fxRank(DRAIN_PRIORITY.roulette));
  });

  it('お邪魔のバナーも band / ギフトルーレットのドレインに勝てる', () => {
    // 実害は「押せない理由が渋滞明けまで出ない」= 配信者も視聴者も理由が分からない。
    expect(bannerRank('tap-lock')).toBeLessThan(fxRank(DRAIN_PRIORITY.band));
    expect(bannerRank('tap-lock')).toBeLessThan(fxRank(DRAIN_PRIORITY.roulette));
  });
});

describe('fxClassForEffect — effect kind の網羅分類', () => {
  const base = { id: 1, amount: 0, valueAfter: 100, atMs: 0 };
  const eff = (over: Partial<ChallengeEffect> & Pick<ChallengeEffect, 'kind'>): ChallengeEffect =>
    ({ ...base, ...over }) as ChallengeEffect;

  it.each([
    [eff({ kind: 'achieved' }), 'parallel'],
    [eff({ kind: 'follow' }), 'follow'],
    [eff({ kind: 'gauge-full' }), 'strike-like'],
    [eff({ kind: 'stock-full' }), 'strike-stock'],
    [eff({ kind: 'boost-start' }), 'boost'],
    [eff({ kind: 'boost-end' }), 'boost'],
    [eff({ kind: 'tap-lock' }), 'tap-lock'],
    [eff({ kind: 'roulette', rouletteOrigin: 'join' }), 'join-roulette'],
    [eff({ kind: 'roulette' }), 'other'],
    [eff({ kind: 'gift', fanStamp: true }), 'helper'],
    [eff({ kind: 'gift', fxBandClip: 'band1' }), 'band'],
    [eff({ kind: 'gift' }), 'other'],
    [eff({ kind: 'press' }), 'other'],
    [eff({ kind: 'like' }), 'other'],
    [eff({ kind: 'comment' }), 'other'],
  ] as const)('%# 番目の分類', (e, expected) => {
    expect(fxClassForEffect(e)).toBe(expected);
  });

  it('お助け(fanStamp)はカットイン付きでも helper(⑤)が勝つ', () => {
    // 実運用のお助けには全面カット5秒が割り当たっている(fan-stamp.ts のコメント)。
    // fanStamp を band 扱いにすると「お助け=⑤」のユーザー序列が実質空文になる。
    expect(fxClassForEffect(eff({ kind: 'gift', fanStamp: true, fxBandClip: 'cut-x' }))).toBe('helper');
  });
});

describe('strikeClass / shouldYieldSpinChain / bestRank', () => {
  it('strike は like を含めば②・stock のみなら③', () => {
    expect(strikeClass({ like: 3, stock: 0 })).toBe('strike-like');
    expect(strikeClass({ like: 3, stock: 5 })).toBe('strike-like');
    expect(strikeClass({ like: 0, stock: 5 })).toBe('strike-stock');
  });

  it('譲り判定の真理値表 — gift(⑧)は全上位に譲り、join(⑥)は band/other に譲らない', () => {
    // gift ルーレット(other)は上位すべてに譲る。
    for (const w of ['follow', 'strike-like', 'strike-stock', 'boost', 'helper', 'join-roulette', 'band'] as const) {
      expect(shouldYieldSpinChain('other', [w])).toBe(true);
    }
    expect(shouldYieldSpinChain('other', ['other'])).toBe(false); // 同格には譲らない
    // join ルーレットは④⑤以上にだけ譲る。
    for (const w of ['follow', 'strike-like', 'strike-stock', 'boost', 'helper'] as const) {
      expect(shouldYieldSpinChain('join-roulette', [w])).toBe(true);
    }
    expect(shouldYieldSpinChain('join-roulette', ['band'])).toBe(false);
    expect(shouldYieldSpinChain('join-roulette', ['other'])).toBe(false);
    expect(shouldYieldSpinChain('join-roulette', ['join-roulette'])).toBe(false);
    // 空では譲らない。混在は最上位で判定。
    expect(shouldYieldSpinChain('other', [])).toBe(false);
    expect(shouldYieldSpinChain('join-roulette', ['other', 'follow'])).toBe(true);
  });

  it('bestRank は最小添字・空は null', () => {
    expect(bestRank([])).toBeNull();
    expect(bestRank(['other', 'boost', 'band'])).toBe(fxRank('boost'));
    expect(bannerRank('follow')).toBe(0);
    expect(bannerRank('gift-card')).toBe(fxRank('other'));
  });
});
