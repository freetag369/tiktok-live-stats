/**
 * ライオンの**設定**の契約(match / validate / 既定)。状態機械は
 * challenge-lion.spec.ts、尺と段組は lion-settle.spec.ts の担当。
 *
 * この機能は**全機能で唯一「既定 ON」**なので、次の2点を機械的に固定してある:
 *  1. 既定行が「Leon and Lion」(34,000💎)と「獅子奮迅」を**巻き込まない**こと
 *     — 既定 ON である以上、誤爆は入れた瞬間から本番で起きる。
 *  2. **キー欠損が既定へ倒れる**こと — 旧 settings.json に `lion` キーは無いので、
 *     このフォールバックがそのまま全ユーザーへの配布経路になる
 *     (だから SETTINGS_VERSION を上げていない)。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_LION,
  DEFAULT_LION_RULE,
  LION_RULES_MAX,
  matchLion,
  validateChallengeConfig,
} from '@shared/challenge';
import {
  LION_AMOUNT_EACH_DEFAULT,
  LION_AMOUNT_EACH_MAX,
  LION_STEPS_DEFAULT,
  LION_STEPS_MAX,
  LION_STEPS_MIN,
} from '@shared/lion-settle';
import type { ChallengeConfig, LionRule } from '@shared/dto';

function cfg(rules: LionRule[], enabled = true): ChallengeConfig {
  return { ...structuredClone(DEFAULT_CHALLENGE), lion: { enabled, rules } };
}

const rule = (over: Partial<LionRule> = {}): LionRule => ({
  ...structuredClone(DEFAULT_LION_RULE),
  ...over,
});

describe('matchLion', () => {
  it('機能 enabled が false なら常に null', () => {
    expect(matchLion(cfg([rule()], false), { giftId: '6369', giftName: 'Lion' })).toBeNull();
  });

  it('行 enabled が false の行は飛ばして**下の行の評価を続ける**', () => {
    const c = cfg([rule({ id: 'a', enabled: false }), rule({ id: 'b', giftId: '777', giftName: '' })]);
    expect(matchLion(c, { giftId: '777' })?.id).toBe('b');
  });

  it('上から先勝ち', () => {
    const c = cfg([rule({ id: 'a', giftId: '1', giftName: '' }), rule({ id: 'b', giftId: '1', giftName: '' })]);
    expect(matchLion(c, { giftId: '1' })?.id).toBe('a');
  });

  it('トリガー3つとも空の行はどのギフトにも一致しない(空文字 includes の罠)', () => {
    const c = cfg([rule({ giftId: '', giftName: '', canonical: '' })]);
    expect(matchLion(c, { giftId: 'x', giftName: 'なんでも' })).toBeNull();
  });

  it('giftId が本線・giftName / canonical は保険(どれでも当たる)', () => {
    expect(matchLion(cfg([rule()]), { giftId: '6369', giftName: '別名' })).not.toBeNull();
    expect(matchLion(cfg([rule()]), { giftId: 'ちがう', giftName: 'Lion' })).not.toBeNull();
    expect(matchLion(cfg([rule()]), { giftId: 'ちがう', canonical: 'lion' })).not.toBeNull();
  });
});

describe('★ 同名ギフトとの切り分け(既定 ON なのでここが生命線)', () => {
  it('既定行は「Lion」(29,999💎・giftId 6369)に当たる', () => {
    expect(matchLion(cfg([rule()]), { giftId: '6369', giftName: 'Lion' })).not.toBeNull();
  });

  it('既定行は「Leon and Lion」(34,000💎・giftId 7823)には当たらない', () => {
    // giftId も canonical も違うので落ちる。giftName も exactName:true で
    // 'leon and lion' !== 'lion' として弾かれる(部分一致なら巻き込む)。
    expect(
      matchLion(cfg([rule()]), {
        giftId: '7823',
        giftName: 'Leon and Lion',
        canonical: 'leon_lion',
      })
    ).toBeNull();
  });

  it('既定行は「獅子奮迅」(canonical lion_charge)には当たらない', () => {
    expect(
      matchLion(cfg([rule()]), { giftId: '1234', giftName: 'Lion Charge', canonical: 'lion_charge' })
    ).toBeNull();
  });

  it('対偶: exactName を外すと両方を巻き込む(だから既定は true)', () => {
    const loose = cfg([rule({ giftId: '', canonical: '', exactName: false })]);
    expect(matchLion(loose, { giftId: '7823', giftName: 'Leon and Lion' })).not.toBeNull();
    expect(matchLion(loose, { giftId: '1234', giftName: 'Lion Charge' })).not.toBeNull();
  });
});

describe('validateLion(validateChallengeConfig 経由)', () => {
  const v = (lion: unknown): ChallengeConfig['lion'] =>
    validateChallengeConfig({ ...structuredClone(DEFAULT_CHALLENGE), lion } as ChallengeConfig).lion;

  it('★キー欠損は既定へ倒れる(= 移行の代わり。SETTINGS_VERSION を上げない根拠)', () => {
    expect(v(undefined)).toEqual(DEFAULT_LION);
    expect(v(null)).toEqual(DEFAULT_LION);
    expect(v('こわれた')).toEqual(DEFAULT_LION);
    // 既定は **ON**(universe / revolution とは逆向き)。
    expect(DEFAULT_LION.enabled).toBe(true);
  });

  it('enabled は `!== false` で読む(既定 true の向き)', () => {
    expect(v({ enabled: undefined, rules: [] }).enabled).toBe(true);
    expect(v({ enabled: 'yes', rules: [] }).enabled).toBe(true);
    expect(v({ enabled: false, rules: [] }).enabled).toBe(false);
  });

  it('rules が配列でなければ既定の行へ倒す(enabled は尊重する)', () => {
    const out = v({ enabled: false, rules: 'x' });
    expect(out.enabled).toBe(false);
    expect(out.rules).toEqual(DEFAULT_LION.rules);
  });

  it('明示的な空配列は空のまま通す(全行消した意思を尊重)', () => {
    expect(v({ enabled: true, rules: [] }).rules).toEqual([]);
  });

  it('LION_RULES_MAX で切る', () => {
    const many = Array.from({ length: LION_RULES_MAX + 4 }, (_, i) => rule({ id: `r${i}` }));
    expect(v({ enabled: true, rules: many }).rules).toHaveLength(LION_RULES_MAX);
  });

  it('重複 id と欠損 id は振り直す', () => {
    const out = v({ enabled: true, rules: [rule({ id: 'dup' }), rule({ id: 'dup' }), rule({ id: '' })] });
    const ids = out.rules.map((r) => r.id);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]).toBe('dup');
  });

  it('giftName / canonical は trim + 小文字化(実イベントは Latin で届く)', () => {
    const out = v({ enabled: true, rules: [rule({ giftName: '  LION  ', canonical: ' LION ' })] });
    expect(out.rules[0]!.giftName).toBe('lion');
    expect(out.rules[0]!.canonical).toBe('lion');
  });

  it('★exactName の壊れた値は true へ倒す(安全側 — 誤爆で +1,499,950 が飛ぶため)', () => {
    const out = v({ enabled: true, rules: [rule({ exactName: 'まる' as unknown as boolean })] });
    expect(out.rules[0]!.exactName).toBe(true);
    // 明示的な false は尊重する(ユーザーが外した意思)。
    const off = v({ enabled: true, rules: [rule({ exactName: false })] });
    expect(off.rules[0]!.exactName).toBe(false);
  });

  it('額と発数は clamp する(発数は演出尺そのものなので外さない)', () => {
    const out = v({
      enabled: true,
      rules: [rule({ amountEach: 10 ** 9, steps: 9_999 }), rule({ id: 'b', amountEach: -1, steps: 0 })],
    });
    expect(out.rules[0]!.amountEach).toBe(LION_AMOUNT_EACH_MAX);
    expect(out.rules[0]!.steps).toBe(LION_STEPS_MAX);
    expect(out.rules[1]!.amountEach).toBe(1);
    expect(out.rules[1]!.steps).toBe(LION_STEPS_MIN);
  });

  it('数値以外は既定へ倒す', () => {
    const out = v({ enabled: true, rules: [rule({ amountEach: 'x' as unknown as number, steps: Number.NaN })] });
    expect(out.rules[0]!.amountEach).toBe(LION_AMOUNT_EACH_DEFAULT);
    expect(out.rules[0]!.steps).toBe(LION_STEPS_DEFAULT);
  });
});

describe('既定行の凍結', () => {
  it('Lion / giftId 6369 / 29,999 × 50 / 完全一致', () => {
    expect(DEFAULT_LION_RULE.giftId).toBe('6369');
    expect(DEFAULT_LION_RULE.giftName).toBe('lion');
    expect(DEFAULT_LION_RULE.canonical).toBe('lion');
    expect(DEFAULT_LION_RULE.exactName).toBe(true);
    expect(DEFAULT_LION_RULE.amountEach).toBe(LION_AMOUNT_EACH_DEFAULT);
    expect(DEFAULT_LION_RULE.steps).toBe(LION_STEPS_DEFAULT);
    expect(DEFAULT_LION_RULE.amountEach * DEFAULT_LION_RULE.steps).toBe(1_499_950);
  });

  it('既定は 1 行だけ配る', () => {
    expect(DEFAULT_LION.rules).toHaveLength(1);
  });

  it('★既定そのものが validate の不動点(コード既定 = 検証後の形)', () => {
    // challenge.spec.ts の DEFAULT_CHALLENGE 全体の不動点検査と同じ規約の局所版。
    expect(validateChallengeConfig(structuredClone(DEFAULT_CHALLENGE)).lion).toEqual(DEFAULT_LION);
  });
});
