/**
 * お邪魔(タップ封じ)の設定 — マッチングと検証。
 *
 * tap-boost-rules.spec.ts の鏡像。**キー欠損が既定へ倒れるだけで移行が要らない**
 * ことをここで固定する — 既定の行は空トリガーでどのギフトにも一致せず、機能
 * enabled も false なので、既存の settings.json に何も配らなくても挙動は変わらない。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_TAP_LOCK,
  DEFAULT_TAP_LOCK_RULE,
  TAP_LOCK_ACTIVATIONS_MAX,
  TAP_LOCK_DURATION_MAX_SEC,
  TAP_LOCK_DURATION_MIN_SEC,
  TAP_LOCK_RULES_MAX,
  matchTapLock,
  tapLockActivationCount,
  validateChallengeConfig,
} from '@shared/challenge';
import type { ChallengeConfig, TapLockRule } from '@shared/dto';

function rule(over: Partial<TapLockRule> = {}): TapLockRule {
  return { ...structuredClone(DEFAULT_TAP_LOCK_RULE), ...over };
}

function cfg(rules: TapLockRule[], enabled = true): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  return { ...base, tapLock: { enabled, rules } };
}

describe('matchTapLock — 先勝ちとトリガーの解決', () => {
  it('giftId 一致で当たる', () => {
    const c = cfg([rule({ id: 'a', giftId: '123' })]);
    expect(matchTapLock(c, { giftId: '123' })?.id).toBe('a');
    expect(matchTapLock(c, { giftId: '999' })).toBeNull();
  });

  it('上から順で最初の一致だけを返す', () => {
    const c = cfg([rule({ id: 'a', giftId: '123' }), rule({ id: 'b', giftId: '123' })]);
    expect(matchTapLock(c, { giftId: '123' })?.id).toBe('a');
  });

  it('無効な行は飛ばすが、下の行の評価は続ける', () => {
    const c = cfg([rule({ id: 'a', giftId: '123', enabled: false }), rule({ id: 'b', giftId: '123' })]);
    expect(matchTapLock(c, { giftId: '123' })?.id).toBe('b');
  });

  it('機能 enabled=false なら全行が止まる', () => {
    const c = cfg([rule({ id: 'a', giftId: '123' })], false);
    expect(matchTapLock(c, { giftId: '123' })).toBeNull();
  });

  it('トリガーが3つとも空の行はどのギフトにも一致しない(空文字 includes の罠)', () => {
    // 既定の行はこの状態で配られる — 一致してしまうと「アプリを更新したら
    // 突然ボタンが押せなくなった」になる。
    const c = cfg([rule({ id: 'a' })]);
    expect(matchTapLock(c, { giftId: '123', giftName: 'anything' })).toBeNull();
  });

  it('ギフト名は既定で部分一致、exactName で完全一致になる', () => {
    const partial = cfg([rule({ id: 'a', giftName: 'corgi' })]);
    expect(matchTapLock(partial, { giftId: '1', giftName: 'Corgi Paw' })?.id).toBe('a');
    const exact = cfg([rule({ id: 'a', giftName: 'corgi', exactName: true })]);
    expect(matchTapLock(exact, { giftId: '1', giftName: 'Corgi Paw' })).toBeNull();
    expect(matchTapLock(exact, { giftId: '1', giftName: 'Corgi' })?.id).toBe('a');
  });

  it('canonical でも当たる(リプレイ/テスト経路)', () => {
    const c = cfg([rule({ id: 'a', canonical: 'rose' })]);
    expect(matchTapLock(c, { giftId: '1', canonical: 'rose' })?.id).toBe('a');
  });
});

describe('validateChallengeConfig — tapLock の検証', () => {
  it('キーが無ければ既定へ倒れる(= 移行が要らない理由)', () => {
    const c = validateChallengeConfig({});
    expect(c.tapLock).toEqual(DEFAULT_TAP_LOCK);
    // 既定は OFF・空トリガー1行。既存設定の挙動が変わらないことの担保。
    expect(c.tapLock.enabled).toBe(false);
    expect(c.tapLock.rules).toHaveLength(1);
    expect(c.tapLock.rules[0]!.durationSec).toBe(30);
    expect(c.tapLock.rules[0]!.giftId).toBe('');
  });

  it('機能 enabled は `=== true` で読む(既定 false — 周辺機能とは逆向き)', () => {
    // 未指定・null・文字列 'true' のどれでも有効化されないこと。
    expect(validateChallengeConfig({ tapLock: { rules: [] } }).tapLock.enabled).toBe(false);
    expect(validateChallengeConfig({ tapLock: { enabled: 'true', rules: [] } }).tapLock.enabled).toBe(false);
    expect(validateChallengeConfig({ tapLock: { enabled: true, rules: [] } }).tapLock.enabled).toBe(true);
  });

  it('行の enabled / flash は `!== false`(既定 true — 周辺の行と同じ向き)', () => {
    const c = validateChallengeConfig({ tapLock: { enabled: true, rules: [{ id: 'a' }] } });
    expect(c.tapLock.rules[0]!.enabled).toBe(true);
    expect(c.tapLock.rules[0]!.flash).toBe(true);
  });

  it('durationSec は clamp され、非数は既定 30 に倒れる', () => {
    const c = validateChallengeConfig({
      tapLock: {
        enabled: true,
        rules: [{ id: 'a', durationSec: 1 }, { id: 'b', durationSec: 9999 }, { id: 'c', durationSec: 'x' }],
      },
    });
    expect(c.tapLock.rules[0]!.durationSec).toBe(TAP_LOCK_DURATION_MIN_SEC);
    expect(c.tapLock.rules[1]!.durationSec).toBe(TAP_LOCK_DURATION_MAX_SEC);
    expect(c.tapLock.rules[2]!.durationSec).toBe(30);
  });

  it('amountEach は既定 0(トリガーギフト自体は値を動かさない)で、負も通る', () => {
    const c = validateChallengeConfig({
      tapLock: { enabled: true, rules: [{ id: 'a' }, { id: 'b', amountEach: -5 }] },
    });
    expect(c.tapLock.rules[0]!.amountEach).toBe(0);
    expect(c.tapLock.rules[1]!.amountEach).toBe(-5);
  });

  it('上限を超えた行は捨て、重複・欠損 id は振り直す', () => {
    const many = Array.from({ length: TAP_LOCK_RULES_MAX + 3 }, () => ({ id: 'dup' }));
    const c = validateChallengeConfig({ tapLock: { enabled: true, rules: many } });
    expect(c.tapLock.rules).toHaveLength(TAP_LOCK_RULES_MAX);
    expect(new Set(c.tapLock.rules.map((r) => r.id)).size).toBe(TAP_LOCK_RULES_MAX);
  });

  it('明示的な空配列は空のまま通す(全行消した意思を尊重する)', () => {
    const c = validateChallengeConfig({ tapLock: { enabled: true, rules: [] } });
    expect(c.tapLock.rules).toEqual([]);
  });

  it('冪等 — validate(validate(x)) === validate(x)', () => {
    const once = validateChallengeConfig({
      tapLock: { enabled: true, rules: [{ id: 'a', giftId: ' 123 ', giftName: ' CORGI ' }] },
    });
    expect(validateChallengeConfig(once)).toEqual(once);
    // トリミングと小文字化も1回目で確定している。
    expect(once.tapLock.rules[0]!.giftId).toBe('123');
    expect(once.tapLock.rules[0]!.giftName).toBe('corgi');
  });
});

describe('tapLockActivationCount — 連打コンボの丸め', () => {
  it('1 以上・上限以下に丸める', () => {
    expect(tapLockActivationCount(0)).toBe(1);
    expect(tapLockActivationCount(1)).toBe(1);
    expect(tapLockActivationCount(17)).toBe(TAP_LOCK_ACTIVATIONS_MAX);
  });
});
