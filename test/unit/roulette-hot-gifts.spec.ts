import { describe, expect, it } from 'vitest';
import {
  BUNNY_DJ_ROULETTE,
  DEFAULT_CHALLENGE,
  DEFAULT_ROULETTE,
  DEFAULT_ROULETTES,
  DEFAULT_ROULETTE_PATTERNS,
  DJ_GLASSES_ROULETTE,
  ROULETTES_MAX,
  ROULETTE_HOT_GIFT_PATTERNS,
  UNICORN_ROULETTE,
  matchRoulette,
  migrateChallengeConfig,
  migrateChallengeRouletteHotGifts,
  rouletteHotPatternPool,
  validateChallengeConfig,
} from '@shared/challenge';
import { ROULETTE_HOT_ONLY_PATTERNS, ROULETTE_SELECTABLE_PATTERNS } from '@shared/dto';
import type { ChallengeConfig, ChallengeRouletteConfig } from '@shared/dto';

/**
 * 激熱確定「ユニコーン」「バニーDJ」の既定行と、それを既存ユーザーへ配る移行(v13)。
 * 骨格は roulette-dj-glasses.spec.ts(v10)と同じで、v13 固有の論点は3つ:
 *
 *   (a) **2行を1段で配る** — 上限(ROULETTES_MAX)は行ごとに見ないと超える。
 *   (b) **倍率が確率抽選(hot.multipliers)** — 正規形は「キー存在 ⇔ 候補2件以上」で、
 *       multiplier には代表値(最大 weight)が焼かれていなければ validate の不動点にならない。
 *   (c) **ユニコーンの giftName は空** — 部分一致(includes)なので 'unicorn' を置くと
 *       'Unicorn Fantasy'(giftId 7237)まで巻き込む。
 */

function cfgWith(rows: ChallengeRouletteConfig[]): ChallengeConfig {
  return { ...structuredClone(DEFAULT_CHALLENGE), roulettes: rows };
}

const NEW_ROWS = [UNICORN_ROULETTE, BUNNY_DJ_ROULETTE];

describe('激熱確定の既定行(ユニコーン / バニーDJ)', () => {
  it('出荷既定に居て、ハートミーの位置(先頭)は動かない', () => {
    expect(DEFAULT_ROULETTES).toHaveLength(4);
    expect(DEFAULT_ROULETTES[0]).toBe(DEFAULT_ROULETTE);
    expect(DEFAULT_ROULETTES).toContain(UNICORN_ROULETTE);
    expect(DEFAULT_ROULETTES).toContain(BUNNY_DJ_ROULETTE);
    // 激熱確定は DJメガネより後ろ(足した順)。
    expect(DEFAULT_ROULETTES.indexOf(UNICORN_ROULETTE)).toBeGreaterThan(
      DEFAULT_ROULETTES.indexOf(DJ_GLASSES_ROULETTE)
    );
  });

  it('ユーザー仕様: 有効 / 増やす / 盤面は全マス同額(ユニコーン 2499・バニーDJ 1200)', () => {
    expect(UNICORN_ROULETTE.giftId).toBe('12453');
    expect(BUNNY_DJ_ROULETTE.giftId).toBe('437679');
    for (const [row, amount] of [
      [UNICORN_ROULETTE, 2499],
      [BUNNY_DJ_ROULETTE, 1200],
    ] as const) {
      expect(row.enabled, row.id).toBe(true);
      expect(row.direction, row.id).toBe('add');
      expect(row.segments, row.id).toHaveLength(6);
      expect(row.segments.every((s) => s.amount === amount), row.id).toBe(true);
      // weight 合計 100 = 設定画面の % 表示がそのまま読める。
      expect(row.segments.reduce((a, s) => a + s.weight, 0), row.id).toBe(100);
    }
  });

  it('倍率は確率抽選 ×5 60% / ×10 30% / ×20 10%、代表値は最大 weight の ×5', () => {
    for (const row of NEW_ROWS) {
      expect(row.hot, row.id).toEqual({
        enabled: true,
        multiplier: 5,
        multipliers: [
          { multiplier: 5, weight: 60 },
          { multiplier: 10, weight: 30 },
          { multiplier: 20, weight: 10 },
        ],
      });
    }
  });

  it('giftName はユニコーンだけ空 — 部分一致で Unicorn Fantasy を巻き込まない', () => {
    expect(UNICORN_ROULETTE.giftName).toBe('');
    // giftName が 'unicorn' だったら、この 5000💎 のギフトがユニコーン行に一致してしまう。
    const cfg = cfgWith([structuredClone(UNICORN_ROULETTE)]);
    expect(matchRoulette(cfg, { giftId: '7237', giftName: 'Unicorn Fantasy' })).toBeNull();
    expect(matchRoulette(cfg, { giftId: '12453', giftName: 'Unicorn' })?.id).toBe(
      UNICORN_ROULETTE.id
    );
    // バニーDJ は名前でも一意なので保険の giftName を持たせてある。
    const bunny = cfgWith([structuredClone(BUNNY_DJ_ROULETTE)]);
    expect(BUNNY_DJ_ROULETTE.giftName).toBe('bunny dj');
    expect(matchRoulette(bunny, { giftId: '', giftName: 'Bunny DJ' })?.id).toBe(
      BUNNY_DJ_ROULETTE.id
    );
  });

  it('**validate の不動点**であること(移行が足した直後と保存後で形が変わらない)', () => {
    const v = validateChallengeConfig(cfgWith(NEW_ROWS.map((r) => structuredClone(r))));
    expect(v.roulettes[0]).toEqual(UNICORN_ROULETTE);
    expect(v.roulettes[1]).toEqual(BUNNY_DJ_ROULETTE);
    for (const row of NEW_ROWS) {
      // patterns を省略すると validate が生やして形が変わる(不動点が壊れる)。
      expect(row.patterns, row.id).toEqual([...DEFAULT_ROULETTE_PATTERNS]);
      expect('sound' in row, row.id).toBe(false);
    }
  });

  it('絵柄は 100% 専用パターン(ギフト連動)で、通常の選択一覧からは締め出されている', () => {
    expect(rouletteHotPatternPool(UNICORN_ROULETTE)).toEqual(['unicorngift']);
    expect(rouletteHotPatternPool(BUNNY_DJ_ROULETTE)).toEqual(['bunnydj']);
    for (const p of ['unicorngift', 'bunnydj'] as const) {
      expect(ROULETTE_HOT_ONLY_PATTERNS, p).toContain(p);
      expect(ROULETTE_SELECTABLE_PATTERNS, p).not.toContain(p);
      expect(ROULETTE_HOT_GIFT_PATTERNS.some((g) => g.pattern === p), p).toBe(true);
    }
  });
});

describe('migrateChallengeRouletteHotGifts — v13 の「足す移行」', () => {
  it('v13 未満の設定には末尾へ2本足され、既存行の順序も内容も変わらない', () => {
    const heart = structuredClone(DEFAULT_ROULETTE);
    const out = migrateChallengeRouletteHotGifts(cfgWith([heart]), 12);
    expect(out.roulettes).toHaveLength(3);
    expect(out.roulettes[0]).toEqual(heart);
    expect(out.roulettes[1]).toEqual(UNICORN_ROULETTE);
    expect(out.roulettes[2]).toEqual(BUNNY_DJ_ROULETTE);
  });

  it('二重に増えない — 2回流しても、自分でその giftId の行を作っていても1本ずつ', () => {
    const once = migrateChallengeRouletteHotGifts(cfgWith([]), 0);
    const twice = migrateChallengeRouletteHotGifts(once, 0);
    expect(twice.roulettes).toHaveLength(2);

    const mine: ChallengeRouletteConfig = { ...structuredClone(DEFAULT_ROULETTE), giftId: '12453' };
    const out = migrateChallengeRouletteHotGifts(cfgWith([mine]), 0);
    expect(out.roulettes.filter((r) => r.giftId === '12453')).toHaveLength(1);
    expect(out.roulettes).toHaveLength(2); // 自分の 12453 + バニーDJ だけ
  });

  it('id 一致でも足さない(同梱デフォ由来の行で giftId を消した人に二重に配らない)', () => {
    const stripped: ChallengeRouletteConfig = { ...structuredClone(UNICORN_ROULETTE), giftId: '' };
    const out = migrateChallengeRouletteHotGifts(cfgWith([stripped]), 0);
    expect(out.roulettes.filter((r) => r.id === UNICORN_ROULETTE.id)).toHaveLength(1);
  });

  it('v13 以降には配らない(消した人に復活させない)', () => {
    const cfg = cfgWith([]);
    expect(migrateChallengeRouletteHotGifts(cfg, 13)).toBe(cfg);
    expect(migrateChallengeRouletteHotGifts(cfg, 99)).toBe(cfg);
  });

  it('上限(ROULETTES_MAX)は行ごとに見る — 残り1枠なら1本だけ足して止まる', () => {
    const filler = (i: number): ChallengeRouletteConfig => ({
      ...structuredClone(DEFAULT_ROULETTE),
      id: `rl-filler-${i}`,
      giftId: `900${i}`,
    });
    // 残り1枠。まとめて2本 push すると上限を超える。
    const near = Array.from({ length: ROULETTES_MAX - 1 }, (_, i) => filler(i));
    const out = migrateChallengeRouletteHotGifts(cfgWith(near), 0);
    expect(out.roulettes).toHaveLength(ROULETTES_MAX);
    expect(out.roulettes[out.roulettes.length - 1]).toEqual(UNICORN_ROULETTE);

    // 満杯には1本も足さない(参照そのままで返る)。
    const full = cfgWith(Array.from({ length: ROULETTES_MAX }, (_, i) => filler(i)));
    expect(migrateChallengeRouletteHotGifts(full, 0)).toBe(full);
  });

  it('チェーン(migrateChallengeConfig)にも組み込まれている', () => {
    const out = migrateChallengeConfig(cfgWith([]), 12);
    expect(out.roulettes.map((r) => r.id)).toEqual([UNICORN_ROULETTE.id, BUNNY_DJ_ROULETTE.id]);
  });
});
