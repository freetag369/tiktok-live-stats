import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FAN_STAMP_FX_WINDOW_MS,
  FAN_STAMP_NAMES_BUDGET,
  FAN_STAMP_NAMES_MAX,
  FAN_STAMP_NAME_CHARS,
  fanStampBannerParts,
  mergeFanStampName,
} from '@shared/fan-stamp';

/**
 * お助け(ファンスタンプ)合算バナーの文言決定を、レンダラを起動せずに固定する
 * (fx-stage.spec.ts / fx-floats.spec.ts と同型)。
 *
 * 最重要の契約は「**1人ぶんのときは従来と完全に同じ**」— 合算が効かない設定でも、
 * 古い worker が作った effect でも、見た目が1ドットも変わらないこと。
 */

const CSS = readFileSync(resolve('src/renderer/styles/monitor.css'), 'utf8');

describe('お助け合算 — 窓の長さ', () => {
  it('FAN_STAMP_FX_WINDOW_MS は monitor.css の .float の floatup 尺と同値', () => {
    // 「先頭の1枚が画面に出ているあいだ」が窓の意味なので、CSS を変えたらここも変える。
    const m = /animation:\s*floatup\s+([\d.]+)(m?s)\b/.exec(CSS);
    expect(m, 'monitor.css に .float の floatup アニメーションが見つからない').not.toBeNull();
    const ms = m![2] === 's' ? Math.round(Number(m![1]) * 1000) : Number(m![1]);
    expect(FAN_STAMP_FX_WINDOW_MS).toBe(ms);
  });
});

describe('mergeFanStampName', () => {
  it('重複は積まない', () => {
    const names: string[] = [];
    mergeFanStampName(names, 'たろう');
    mergeFanStampName(names, 'たろう');
    expect(names).toEqual(['たろう']);
  });

  it('上限に達したらそれ以上積まない(メモリ一定)', () => {
    const names: string[] = [];
    for (const n of ['a', 'b', 'c', 'd', 'e']) mergeFanStampName(names, n);
    expect(names).toHaveLength(FAN_STAMP_NAMES_MAX);
    expect(names).toEqual(['a', 'b', 'c']);
  });

  it('空の表示名は積まない(nickname 未設定の視聴者で空欄が並ぶのを防ぐ)', () => {
    const names: string[] = [];
    mergeFanStampName(names, '');
    expect(names).toEqual([]);
  });
});

describe('fanStampBannerParts — 1人ぶん(従来と完全同一)', () => {
  it('fanStampPeople が無ければ nickname をそのまま1人で出す', () => {
    const p = fanStampBannerParts({ amount: -1, nickname: 'たろう' });
    expect(p).toEqual({
      amount: -1,
      names: ['たろう'],
      othersCount: 0,
      what: 'がお助け!',
      giftCount: 1,
      multi: false,
    });
  });

  it('連打(giftCount>1)は ×N を出す情報を返す', () => {
    const p = fanStampBannerParts({ amount: -30, nickname: 'たろう', giftCount: 10 });
    expect(p.giftCount).toBe(10);
    expect(p.multi).toBe(false);
    expect(p.othersCount).toBe(0);
  });

  it('同じ人が何度押しても people=1 なら1人文言のまま(名前は切り詰めない)', () => {
    const p = fanStampBannerParts({
      amount: -3,
      nickname: 'とてもながいなまえのひと',
      fanStampNames: ['とてもながいなまえのひと'],
      fanStampPeople: 1,
      giftCount: 3,
    });
    expect(p.multi).toBe(false);
    // 1人ぶんは従来どおり素通し — 折り返しは .f-txt の 2 行クランプ任せ。
    expect(p.names).toEqual(['とてもながいなまえのひと']);
  });

  it('nickname も名前リストも無ければ空文字1件(既存の `e.nickname ?? ""` と同じ)', () => {
    const p = fanStampBannerParts({ amount: -1 });
    expect(p.names).toEqual(['']);
    expect(p.multi).toBe(false);
  });
});

describe('fanStampBannerParts — 複数人ぶん', () => {
  it('5人・名前3件 → 名前3件 + ほか2人', () => {
    const p = fanStampBannerParts({
      amount: -6,
      nickname: 'たろう',
      fanStampNames: ['たろう', 'はなこ', 'じろう'],
      fanStampPeople: 5,
      giftCount: 6,
    });
    expect(p.names).toEqual(['たろう', 'はなこ', 'じろう']);
    expect(p.othersCount).toBe(2);
    expect(p.multi).toBe(true);
  });

  it('3人・名前3件 → 「ほか0人」を出さない', () => {
    const p = fanStampBannerParts({
      amount: -3,
      fanStampNames: ['あ', 'い', 'う'],
      fanStampPeople: 3,
    });
    expect(p.othersCount).toBe(0);
  });

  it('名前1つが上限を超えたら … に詰める(上限は超えない)', () => {
    const long = 'あ'.repeat(FAN_STAMP_NAME_CHARS + 5);
    const p = fanStampBannerParts({
      amount: -2,
      fanStampNames: [long, 'はなこ'],
      fanStampPeople: 2,
    });
    expect(Array.from(p.names[0]!)).toHaveLength(FAN_STAMP_NAME_CHARS);
    expect(p.names[0]!.endsWith('…')).toBe(true);
  });

  it('文字数予算を超えるぶんは人数を減らして「ほかN人」へ回す', () => {
    // 8文字 × 3人 + 区切り2 = 26 文字で FAN_STAMP_NAMES_BUDGET(14) を大きく超える。
    const p = fanStampBannerParts({
      amount: -3,
      fanStampNames: ['ながいなまえだよ', 'これもながいよ', 'みっつめ'],
      fanStampPeople: 3,
    });
    const used = p.names.reduce((a, n) => a + Array.from(n).length, 0) + (p.names.length - 1);
    expect(used).toBeLessThanOrEqual(FAN_STAMP_NAMES_BUDGET);
    expect(p.names.length).toBeLessThan(3);
    // 落とした人数は「ほかN人」に必ず現れる(人が消えない)。
    expect(p.names.length + p.othersCount).toBe(3);
  });

  it('予算を1人目だけで使い切っても必ず1人は残す', () => {
    const p = fanStampBannerParts({
      amount: -9,
      fanStampNames: ['ながいなまえだよ', 'つぎのひと', 'みっつめ'],
      fanStampPeople: 9,
    });
    expect(p.names.length).toBeGreaterThanOrEqual(1);
    expect(p.othersCount).toBe(9 - p.names.length);
  });

  it('絵文字ニックネームでもサロゲートペアを割らない', () => {
    const p = fanStampBannerParts({
      amount: -2,
      fanStampNames: ['🎉🎉🎉🎉🎉🎉🎉🎉🎉🎉', 'はなこ'],
      fanStampPeople: 2,
    });
    // 割れていれば置換文字(U+FFFD)になる。
    expect(p.names[0]).not.toContain('\uFFFD');
  });

  it('people が名前リストより多くても矛盾しない(名前は上限で打ち切られている)', () => {
    const p = fanStampBannerParts({
      amount: -40,
      fanStampNames: ['a', 'b', 'c'],
      fanStampPeople: 40,
      giftCount: 40,
    });
    expect(p.othersCount).toBe(37);
  });
});

describe('fanStampBannerParts — 符号による言い換え(既存規約)', () => {
  it.each([
    [-1, 'がお助け!'],
    [1, 'が妨害!'],
    [0, 'がファンスタンプ!'],
  ])('amount=%d → %s', (amount, what) => {
    expect(fanStampBannerParts({ amount, nickname: 'x' }).what).toBe(what);
  });

  it('妨害(正)でも複数人の畳み方は同じ', () => {
    const p = fanStampBannerParts({
      amount: 4,
      fanStampNames: ['a', 'b'],
      fanStampPeople: 4,
    });
    expect(p.what).toBe('が妨害!');
    expect(p.othersCount).toBe(2);
    expect(p.multi).toBe(true);
  });
});
