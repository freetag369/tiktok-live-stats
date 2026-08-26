/**
 * 一撃クリアの**設定**の契約(match / validate / 既定)。窓の状態機械は
 * challenge-universe.spec.ts、尺と 30 分割は universe.spec.ts の担当。
 *
 * この機能は誤爆の代償が全機能中で最も大きい(**ランが即終了して巻き戻せない**)
 * ので、`exactName` まわりを対偶つきで固定してある。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_UNIVERSE,
  DEFAULT_UNIVERSE_RULE,
  UNIVERSE_RULES_MAX,
  matchUniverse,
  validateChallengeConfig,
} from '@shared/challenge';
import type { ChallengeConfig, UniverseRule } from '@shared/dto';

function cfg(rules: UniverseRule[], enabled = true): ChallengeConfig {
  return { ...structuredClone(DEFAULT_CHALLENGE), universe: { enabled, rules } };
}

const rule = (over: Partial<UniverseRule> = {}): UniverseRule => ({
  ...structuredClone(DEFAULT_UNIVERSE_RULE),
  ...over,
});

describe('matchUniverse', () => {
  it('機能 enabled が false なら常に null', () => {
    expect(matchUniverse(cfg([rule()], false), { giftId: 'x', giftName: 'TikTok Universe' })).toBeNull();
  });

  it('行 enabled が false の行は飛ばして**下の行の評価を続ける**', () => {
    const c = cfg([rule({ id: 'a', enabled: false }), rule({ id: 'b', giftId: '777', giftName: '' })]);
    expect(matchUniverse(c, { giftId: '777' })?.id).toBe('b');
  });

  it('上から先勝ち', () => {
    const c = cfg([rule({ id: 'a', giftId: '1', giftName: '' }), rule({ id: 'b', giftId: '1', giftName: '' })]);
    expect(matchUniverse(c, { giftId: '1' })?.id).toBe('a');
  });

  it('トリガー3つとも空の行はどのギフトにも一致しない(空文字 includes の罠)', () => {
    const c = cfg([rule({ giftId: '', giftName: '', canonical: '' })]);
    expect(matchUniverse(c, { giftId: 'x', giftName: 'なんでも' })).toBeNull();
  });

  it('giftId が本線・giftName は保険(どちらでも当たる)', () => {
    const c = cfg([rule({ giftId: '9999' })]);
    expect(matchUniverse(c, { giftId: '9999', giftName: '別名' })?.giftId).toBe('9999');
    expect(matchUniverse(c, { giftId: 'ちがう', giftName: 'TikTok Universe' })).not.toBeNull();
  });
});

describe('★ TikTok Universe+ との切り分け(この機能の生命線)', () => {
  it('既定行は「TikTok Universe」に当たる', () => {
    expect(matchUniverse(cfg([rule()]), { giftId: 'x', giftName: 'TikTok Universe' })).not.toBeNull();
  });

  it('既定行は「TikTok Universe+」には当たらない', () => {
    expect(matchUniverse(cfg([rule()]), { giftId: 'x', giftName: 'TikTok Universe+' })).toBeNull();
  });

  it('対偶: exactName を外すと Universe+ にも当たる(= ガードが効いている証明)', () => {
    const c = cfg([rule({ exactName: false })]);
    expect(matchUniverse(c, { giftId: 'x', giftName: 'TikTok Universe+' })).not.toBeNull();
  });

  it('canonical も universe / universe_plus で分かれる(gift-aliases の nameRules と対)', () => {
    const c = cfg([rule({ giftName: '', giftId: '' })]);
    expect(matchUniverse(c, { giftId: 'x', canonical: 'universe' })).not.toBeNull();
    expect(matchUniverse(c, { giftId: 'x', canonical: 'universe_plus' })).toBeNull();
  });
});

describe('既定', () => {
  it('機能そのものは既定 OFF(ランを終わらせるので勝手に有効化されない)', () => {
    expect(DEFAULT_UNIVERSE.enabled).toBe(false);
    expect(DEFAULT_CHALLENGE.universe.enabled).toBe(false);
  });

  it('既定行は giftId 空 + giftName 完全一致(推測の giftId は焼かない規約)', () => {
    expect(DEFAULT_UNIVERSE_RULE.giftId).toBe('');
    expect(DEFAULT_UNIVERSE_RULE.giftName).toBe('tiktok universe');
    expect(DEFAULT_UNIVERSE_RULE.exactName).toBe(true);
  });

  it('giftName / canonical は小文字で保存されている(matchGiftTrigger が小文字前提)', () => {
    expect(DEFAULT_UNIVERSE_RULE.giftName).toBe(DEFAULT_UNIVERSE_RULE.giftName.toLowerCase());
    expect(DEFAULT_UNIVERSE_RULE.canonical).toBe(DEFAULT_UNIVERSE_RULE.canonical.toLowerCase());
  });
});

describe('validateUniverse(validateChallengeConfig 経由)', () => {
  const v = (u: unknown): ChallengeConfig['universe'] =>
    validateChallengeConfig({ ...structuredClone(DEFAULT_CHALLENGE), universe: u }).universe;

  it('キー欠損は既定へ倒れる = **移行が要らない根拠**', () => {
    const raw = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    delete raw.universe;
    const out = validateChallengeConfig(raw);
    expect(out.universe).toEqual(DEFAULT_UNIVERSE);
    // 既定 OFF なので既存 settings.json の挙動は 1 ミリも変わらない。
    expect(out.universe.enabled).toBe(false);
  });

  it('enabled は `=== true` で読む(壊れた真値で勝手に有効化しない)', () => {
    expect(v({ enabled: 'yes', rules: [] }).enabled).toBe(false);
    expect(v({ enabled: 1, rules: [] }).enabled).toBe(false);
    expect(v({ enabled: true, rules: [] }).enabled).toBe(true);
  });

  it('giftName / canonical は trim + 小文字化して保存する', () => {
    const out = v({ enabled: true, rules: [{ ...DEFAULT_UNIVERSE_RULE, giftName: '  TikTok UNIVERSE ', canonical: ' UNIVERSE ' }] });
    expect(out.rules[0]!.giftName).toBe('tiktok universe');
    expect(out.rules[0]!.canonical).toBe('universe');
  });

  it('★ exactName のフォールバックは **true**(革命の `false` から意図的に外している)', () => {
    // 壊れた値から復元するとき、取り返しがつかない側(部分一致)へ倒さない。
    const out = v({ enabled: true, rules: [{ ...DEFAULT_UNIVERSE_RULE, exactName: 'yes' }] });
    expect(out.rules[0]!.exactName).toBe(true);
    // 明示的な false は尊重する(ユーザーの意思)。
    expect(v({ enabled: true, rules: [{ ...DEFAULT_UNIVERSE_RULE, exactName: false }] }).rules[0]!.exactName).toBe(false);
  });

  it('重複・欠損 id は振り直す', () => {
    const out = v({
      enabled: true,
      rules: [{ ...DEFAULT_UNIVERSE_RULE, id: 'same' }, { ...DEFAULT_UNIVERSE_RULE, id: 'same' }, { ...DEFAULT_UNIVERSE_RULE, id: '' }],
    });
    expect(new Set(out.rules.map((r) => r.id)).size).toBe(3);
    expect(out.rules[2]!.id).toBe('uni-2');
  });

  it('上限を超えた行は切り捨てる', () => {
    const many = Array.from({ length: UNIVERSE_RULES_MAX + 4 }, (_, i) => ({ ...DEFAULT_UNIVERSE_RULE, id: `r${i}` }));
    expect(v({ enabled: true, rules: many }).rules).toHaveLength(UNIVERSE_RULES_MAX);
  });

  it('明示的な空配列は空のまま通す(全行消したユーザーの意思を尊重)', () => {
    expect(v({ enabled: true, rules: [] }).rules).toHaveLength(0);
  });

  it('壊れた行(null / 非オブジェクト)は既定行へ倒れる', () => {
    const out = v({ enabled: true, rules: [null, 42, 'x'] });
    expect(out.rules).toHaveLength(3);
    for (const r of out.rules) expect(r.giftName).toBe(DEFAULT_UNIVERSE_RULE.giftName);
  });

  it('冪等(validate(validate(x)) === validate(x))', () => {
    const once = v({ enabled: true, rules: [{ ...DEFAULT_UNIVERSE_RULE, id: '', giftName: ' SWAN ' }] });
    expect(v(once)).toEqual(once);
  });

  it('DEFAULT_UNIVERSE 自体が validate の不動点', () => {
    expect(v(structuredClone(DEFAULT_UNIVERSE))).toEqual(DEFAULT_UNIVERSE);
  });
});
