import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_ROULETTE,
  DEFAULT_ROULETTES,
  DEFAULT_ROULETTE_PATTERNS,
  DJ_GLASSES_ROULETTE,
  ROULETTES_MAX,
  migrateChallengeConfig,
  migrateChallengeRouletteDjGlasses,
  validateChallengeConfig,
} from '@shared/challenge';
import { ROULETTE_HOT_ONLY_PATTERNS, ROULETTE_SELECTABLE_PATTERNS, SETTINGS_VERSION } from '@shared/dto';
import type { ChallengeConfig, ChallengeRouletteConfig } from '@shared/dto';

/**
 * 激熱確定「DJメガネ」の既定行と、それを既存ユーザーへ配る移行(v10)。
 *
 * 壊れ方は2つあって、どちらも静かに効く:
 *
 *   (a) **既定を直しても既存ユーザーに届かない** — roulettes キーは保存済みの
 *       settings.json が必ず持っているので、validate の欠損フォールバックを通らない。
 *       足す移行(この段)が唯一の経路。
 *   (b) **移行が足す行が validate の不動点でない** — loadSettings / loadChallengeDefault は
 *       validate → migrate の順で、migrate の出力は再検証されない。patterns キーを
 *       落とした行を足すと、次の保存で validate が生やして形が変わり、
 *       boot-settings の冪等検査(同梱デフォの不動点)が落ちる。
 *
 * 絵柄が 100% djglasses になることと fxRand の消費回数は roulette-hot.spec.ts 側。
 */

function cfgWith(rows: ChallengeRouletteConfig[]): ChallengeConfig {
  return { ...structuredClone(DEFAULT_CHALLENGE), roulettes: rows };
}

describe('DJメガネの既定行(DJ_GLASSES_ROULETTE)', () => {
  it('出荷既定の末尾に居て、ハートミーの位置(先頭)は動かない', () => {
    // 先頭に入れると DEFAULT_ROULETTES[0] / roulettes[0] を掴む呼び元とテストが崩れる。
    expect(DEFAULT_ROULETTES).toHaveLength(2);
    expect(DEFAULT_ROULETTES[0]).toBe(DEFAULT_ROULETTE);
    expect(DEFAULT_ROULETTES[DEFAULT_ROULETTES.length - 1]).toBe(DJ_GLASSES_ROULETTE);
  });

  it('ユーザー仕様: giftId 11583 / 有効 / 増やす / 倍率 ×10 / 盤面は全マス 500', () => {
    expect(DJ_GLASSES_ROULETTE.giftId).toBe('11583');
    expect(DJ_GLASSES_ROULETTE.enabled).toBe(true);
    expect(DJ_GLASSES_ROULETTE.direction).toBe('add');
    expect(DJ_GLASSES_ROULETTE.hot).toEqual({ enabled: true, multiplier: 10 });
    expect(DJ_GLASSES_ROULETTE.segments.map((s) => s.amount)).toEqual([500, 500, 500, 500, 500, 500]);
    // weight の合計 100 = 設定画面の % 表示がそのまま読める。
    expect(DJ_GLASSES_ROULETTE.segments.reduce((n, s) => n + s.weight, 0)).toBe(100);
  });

  it('giftName は小文字英語(日本語名では一生発火しない)', () => {
    // 配信イベントの giftName は英語で届く。日本語「DJメガネ」を入れると当たらない。
    expect(DJ_GLASSES_ROULETTE.giftName).toBe('dj glasses');
    expect(DJ_GLASSES_ROULETTE.giftName).toBe(DJ_GLASSES_ROULETTE.giftName.toLowerCase().trim());
  });

  it('**validate の不動点**であること(移行が足した直後と保存後で形が変わらない)', () => {
    const once = validateChallengeConfig(cfgWith([structuredClone(DJ_GLASSES_ROULETTE)]));
    expect(once.roulettes[0]).toEqual(DJ_GLASSES_ROULETTE);
    const twice = validateChallengeConfig(once as unknown);
    expect(twice.roulettes[0]).toEqual(DJ_GLASSES_ROULETTE);
    // patterns を落とすと validate が生やして形が変わる(この定数で省略してはいけない理由)。
    expect(DJ_GLASSES_ROULETTE.patterns).toEqual([...DEFAULT_ROULETTE_PATTERNS]);
    expect('sound' in DJ_GLASSES_ROULETTE).toBe(false);
  });
});

describe('migrateChallengeRouletteDjGlasses — v10 の「足す移行」', () => {
  it('v10 未満の設定には末尾へ1本だけ足され、既存行の順序も内容も変わらない', () => {
    const mine = { ...structuredClone(DEFAULT_ROULETTE), id: 'mine', label: '自分の行' };
    const out = migrateChallengeRouletteDjGlasses(cfgWith([mine]), 9);
    expect(out.roulettes).toHaveLength(2);
    expect(out.roulettes[0]).toEqual(mine);
    expect(out.roulettes[1]).toEqual(DJ_GLASSES_ROULETTE);
  });

  it('二重に増えない — 2回流しても、自分で 11583 の行を作っていても1本のまま', () => {
    const once = migrateChallengeRouletteDjGlasses(cfgWith([structuredClone(DEFAULT_ROULETTE)]), 9);
    const twice = migrateChallengeRouletteDjGlasses(once, 9);
    expect(twice.roulettes.filter((r) => r.giftId === '11583')).toHaveLength(1);

    const hand = cfgWith([{ ...structuredClone(DEFAULT_ROULETTE), id: 'mine', giftId: '11583' }]);
    const out = migrateChallengeRouletteDjGlasses(hand, 9);
    expect(out.roulettes).toHaveLength(1);
    expect(out.roulettes[0]?.id).toBe('mine');
  });

  it('id 一致でも足さない(同梱デフォ由来の行で giftId を消した人に二重に配らない)', () => {
    const hand = cfgWith([{ ...structuredClone(DJ_GLASSES_ROULETTE), giftId: '', giftName: 'dj glasses' }]);
    const out = migrateChallengeRouletteDjGlasses(hand, 0);
    expect(out.roulettes).toHaveLength(1);
  });

  it('v10 以降には配らない(消した人に復活させない)', () => {
    const c = cfgWith([structuredClone(DEFAULT_ROULETTE)]);
    expect(migrateChallengeRouletteDjGlasses(c, 10)).toBe(c);
    expect(migrateChallengeConfig(c, SETTINGS_VERSION).roulettes).toHaveLength(1);
  });

  it('上限(ROULETTES_MAX)に達している設定には足さない', () => {
    const full = cfgWith(
      Array.from({ length: ROULETTES_MAX }, (_, i) => ({
        ...structuredClone(DEFAULT_ROULETTE),
        id: `r${i}`,
        giftId: `${1000 + i}`,
      }))
    );
    expect(migrateChallengeRouletteDjGlasses(full, 0).roulettes).toHaveLength(ROULETTES_MAX);
  });

  it('チェーン(migrateChallengeConfig)にも組み込まれている', () => {
    const out = migrateChallengeConfig(cfgWith([structuredClone(DEFAULT_ROULETTE)]), 9);
    expect(out.roulettes.some((r) => r.giftId === '11583')).toBe(true);
  });
});

describe('djglasses は通常のパターン選択から締め出されている', () => {
  it('sanitizeRoulettePatterns が手編集の djglasses を落とす', () => {
    const v = validateChallengeConfig(
      cfgWith([
        {
          ...structuredClone(DEFAULT_ROULETTE),
          patterns: ['djglasses', 'pop'] as ChallengeRouletteConfig['patterns'],
        },
      ]) as unknown
    );
    expect(v.roulettes[0]?.patterns).toEqual(['pop']);
  });

  it('djglasses だけの patterns は全滅扱いで既定へ倒れる(スピンを止めない)', () => {
    const v = validateChallengeConfig(
      cfgWith([
        {
          ...structuredClone(DEFAULT_ROULETTE),
          patterns: ['djglasses'] as ChallengeRouletteConfig['patterns'],
        },
      ]) as unknown
    );
    expect(v.roulettes[0]?.patterns).toEqual([...DEFAULT_ROULETTE_PATTERNS]);
  });

  it('既定の patterns にも選べる一覧にも djglasses は居ない', () => {
    for (const p of ROULETTE_HOT_ONLY_PATTERNS) {
      expect(DEFAULT_ROULETTE_PATTERNS, p).not.toContain(p);
      expect(ROULETTE_SELECTABLE_PATTERNS, p).not.toContain(p);
    }
    // 既定の顔ぶれ自体は今回の変更で1つも変わっていない(18種のまま)。
    expect(DEFAULT_ROULETTE_PATTERNS).toHaveLength(18);
  });
});
