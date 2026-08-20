/**
 * 革命(Revolution)の設定 — マッチングと検証。
 *
 * tap-lock-rules.spec.ts の鏡像。**キー欠損が既定へ倒れるだけで移行が要らない**
 * ことをここで固定する — 既定の行は白鳥(swan / 699💎)を持つが、機能 enabled が
 * false なので、既存の settings.json に何も配らなくても挙動は変わらない
 * (= SETTINGS_VERSION を上げず migrate* も書かない根拠そのもの)。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_REVOLUTION,
  DEFAULT_REVOLUTION_RULE,
  REVOLUTION_ACTIVATIONS_MAX,
  REVOLUTION_DURATION_MAX_SEC,
  REVOLUTION_DURATION_MIN_SEC,
  REVOLUTION_MULT_MAX,
  REVOLUTION_MULT_MIN,
  REVOLUTION_RULES_MAX,
  matchRevolution,
  revolutionActivationCount,
  validateChallengeConfig,
} from '@shared/challenge';
import type { ChallengeConfig, RevolutionRule } from '@shared/dto';

function rule(over: Partial<RevolutionRule> = {}): RevolutionRule {
  return { ...structuredClone(DEFAULT_REVOLUTION_RULE), ...over };
}

function cfg(rules: RevolutionRule[], enabled = true): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  return { ...base, revolution: { enabled, rules } };
}

describe('matchRevolution — 先勝ちとトリガーの解決', () => {
  it('giftId 一致で当たる(採取後の本線)', () => {
    const c = cfg([rule({ id: 'a', giftId: '699' })]);
    expect(matchRevolution(c, { giftId: '699' })?.id).toBe('a');
    expect(matchRevolution(c, { giftId: '999' })).toBeNull();
  });

  it('giftId が本線・giftName は保険(ID が変わっても名前で拾える)', () => {
    // 白鳥の giftId は未採取なので、当面は giftName の完全一致だけが本線になる。
    // 採取後に giftId を焼き込んでも、名前側の行は保険として同時に効く。
    const c = cfg([rule({ id: 'a', giftId: '699', giftName: 'swan', exactName: true })]);
    // 名前が別物でも giftId で当たる。
    expect(matchRevolution(c, { giftId: '699', giftName: 'Something Else' })?.id).toBe('a');
    // giftId が変わっても名前で当たる。
    expect(matchRevolution(c, { giftId: '111111', giftName: 'Swan' })?.id).toBe('a');
  });

  it('上から順で最初の一致だけを返す', () => {
    const c = cfg([rule({ id: 'a', giftId: '699' }), rule({ id: 'b', giftId: '699' })]);
    expect(matchRevolution(c, { giftId: '699' })?.id).toBe('a');
  });

  it('無効な行は飛ばすが、下の行の評価は続ける', () => {
    const c = cfg([rule({ id: 'a', giftId: '699', enabled: false }), rule({ id: 'b', giftId: '699' })]);
    expect(matchRevolution(c, { giftId: '699' })?.id).toBe('b');
  });

  it('機能 enabled=false なら全行が止まる', () => {
    const c = cfg([rule({ id: 'a', giftId: '699' })], false);
    expect(matchRevolution(c, { giftId: '699' })).toBeNull();
  });

  it('トリガーが3つとも空の行はどのギフトにも一致しない(空文字 includes の罠)', () => {
    // 設定画面の「革命を追加」で増える行は空トリガーで始まる — ここが一致して
    // しまうと、行を1つ足しただけで全ギフトがゲームのルールを反転させる。
    const c = cfg([rule({ id: 'a', giftId: '', giftName: '', canonical: '' })]);
    expect(matchRevolution(c, { giftId: '699', giftName: 'anything' })).toBeNull();
  });

  it('既定の1行は白鳥(swan)の**完全一致**にだけ当たる', () => {
    // giftName はローマ字の実受信名。日本語の '白鳥' を置くと一度も発火しない
    // (ねば〜る君 = nebaarukun と同じ — DEFAULT_REVOLUTION_RULE のコメント参照)。
    const c = cfg([structuredClone(DEFAULT_REVOLUTION_RULE)]);
    expect(matchRevolution(c, { giftId: '0', giftName: 'Swan' })?.id).toBe('rev-1');
    expect(matchRevolution(c, { giftId: '0', giftName: '白鳥' })).toBeNull();
    // 'swan' は短い — 部分一致だったら 'Black Swan' 等を巻き込み、1分間ゲーム経済が
    // 変わってしまう。exactName: true の存在意義そのもの。
    expect(matchRevolution(c, { giftId: '0', giftName: 'Black Swan' })).toBeNull();
    expect(matchRevolution(c, { giftId: '0', giftName: 'Swan Lake' })).toBeNull();
    // 既定行は giftId が空(未採取)なので、ID 側では一致しようがない。
    expect(matchRevolution(c, { giftId: '699' })).toBeNull();
  });

  it('exactName=false なら部分一致に戻る(自分で行を作る人向け)', () => {
    const partial = cfg([rule({ id: 'a', giftId: '', giftName: 'swan', exactName: false })]);
    expect(matchRevolution(partial, { giftId: '1', giftName: 'Black Swan' })?.id).toBe('a');
    const exact = cfg([rule({ id: 'a', giftId: '', giftName: 'swan', exactName: true })]);
    expect(matchRevolution(exact, { giftId: '1', giftName: 'Black Swan' })).toBeNull();
    expect(matchRevolution(exact, { giftId: '1', giftName: 'Swan' })?.id).toBe('a');
  });

  it('canonical でも当たる(リプレイ/テスト経路)', () => {
    const c = cfg([rule({ id: 'a', canonical: 'swan' })]);
    expect(matchRevolution(c, { giftId: '1', canonical: 'swan' })?.id).toBe('a');
  });
});

describe('DEFAULT_REVOLUTION — 既定の凍結', () => {
  it('機能そのものは既定 OFF(既存の settings.json の挙動を変えないための線)', () => {
    // ここが true になった瞬間、いいね着弾の反転が全ユーザーへ無断で配られる。
    expect(DEFAULT_REVOLUTION.enabled).toBe(false);
    expect(DEFAULT_REVOLUTION.rules).toHaveLength(1);
  });

  it('既定行は白鳥1行 — giftId 空・swan の完全一致・×3・60秒', () => {
    expect(DEFAULT_REVOLUTION_RULE).toMatchObject({
      id: 'rev-1',
      // 実配信で採取していない giftId は推測で焼かない(gift-aliases の _topGifts 規約)。
      giftId: '',
      giftName: 'swan',
      // **意図的に true**。短い 'swan' が 'black swan' 等へ誤爆すると、1分間まるごと
      // ゲームのルール(タップ×3・いいね反転)が変わってしまう。
      exactName: true,
      multiplier: 3,
      durationSec: 60,
      enabled: true,
    });
  });

  it('既定行の値は clamp の内側にある(validate を通しても変わらない)', () => {
    expect(DEFAULT_REVOLUTION_RULE.multiplier).toBeGreaterThanOrEqual(REVOLUTION_MULT_MIN);
    expect(DEFAULT_REVOLUTION_RULE.multiplier).toBeLessThanOrEqual(REVOLUTION_MULT_MAX);
    expect(DEFAULT_REVOLUTION_RULE.durationSec).toBeGreaterThanOrEqual(REVOLUTION_DURATION_MIN_SEC);
    expect(DEFAULT_REVOLUTION_RULE.durationSec).toBeLessThanOrEqual(REVOLUTION_DURATION_MAX_SEC);
    // giftName は validate が trim+小文字化するので、既定も最初から小文字であること。
    expect(DEFAULT_REVOLUTION_RULE.giftName).toBe(DEFAULT_REVOLUTION_RULE.giftName.trim().toLowerCase());
  });
});

describe('validateChallengeConfig — revolution の検証', () => {
  it('キーが無ければ既定へ倒れる(= 移行が要らない理由)', () => {
    const c = validateChallengeConfig({});
    expect(c.revolution).toEqual(DEFAULT_REVOLUTION);
    // 既定は機能 OFF・白鳥1行。既存設定の挙動が変わらないことの担保。
    expect(c.revolution.enabled).toBe(false);
    expect(c.revolution.rules).toHaveLength(1);
    expect(c.revolution.rules[0]!.giftName).toBe('swan');
    expect(c.revolution.rules[0]!.durationSec).toBe(60);
  });

  it('revolution キーごと無い保存済み設定も既定へ倒れ、どのギフトにも当たらない', () => {
    // 実際の settings.json は v0.9.x までのフルセットを持っていて、この1キーだけが無い。
    const saved = structuredClone(DEFAULT_CHALLENGE) as unknown as Record<string, unknown>;
    delete saved.revolution;
    const c = validateChallengeConfig(saved);
    expect(c.revolution).toEqual(DEFAULT_REVOLUTION);
    // 機能 OFF なので、既定行があっても白鳥で発動しない = 挙動が 1 ミリも変わらない。
    expect(matchRevolution(c, { giftId: '699', giftName: 'Swan' })).toBeNull();
  });

  it('機能 enabled は `=== true` で読む(既定 false — tapLock と同じ向き)', () => {
    // 未指定・文字列 'true'・null のどれでも有効化されないこと。
    expect(validateChallengeConfig({ revolution: { rules: [] } }).revolution.enabled).toBe(false);
    expect(validateChallengeConfig({ revolution: { enabled: 'true', rules: [] } }).revolution.enabled).toBe(false);
    expect(validateChallengeConfig({ revolution: { enabled: null, rules: [] } }).revolution.enabled).toBe(false);
    expect(validateChallengeConfig({ revolution: { enabled: 1, rules: [] } }).revolution.enabled).toBe(false);
    expect(validateChallengeConfig({ revolution: { enabled: true, rules: [] } }).revolution.enabled).toBe(true);
  });

  it('rules が非配列なら既定行へ、明示的な空配列は空のまま通す(全行消した意思を尊重)', () => {
    const broken = validateChallengeConfig({ revolution: { enabled: true, rules: 'nope' } });
    expect(broken.revolution.rules).toEqual(DEFAULT_REVOLUTION.rules);
    // enabled は壊れた rules に巻き込まれず、指定どおり残る。
    expect(broken.revolution.enabled).toBe(true);

    const empty = validateChallengeConfig({ revolution: { enabled: true, rules: [] } });
    expect(empty.revolution.rules).toEqual([]);
    expect(matchRevolution(empty, { giftId: '699', giftName: 'Swan' })).toBeNull();
  });

  it('行の enabled / flash は `!== false`(既定 true — 周辺の行と同じ向き)', () => {
    const c = validateChallengeConfig({ revolution: { enabled: true, rules: [{ id: 'a' }] } });
    expect(c.revolution.rules[0]!.enabled).toBe(true);
    expect(c.revolution.rules[0]!.flash).toBe(true);
  });

  it('multiplier は clamp され、非数は既定 3 に倒れ、小数は丸まる', () => {
    const c = validateChallengeConfig({
      revolution: {
        enabled: true,
        rules: [
          { id: 'a', multiplier: 0 },
          { id: 'b', multiplier: 9999 },
          { id: 'c', multiplier: 'x' },
          { id: 'd', multiplier: 3.6 },
        ],
      },
    });
    expect(c.revolution.rules[0]!.multiplier).toBe(REVOLUTION_MULT_MIN);
    expect(c.revolution.rules[1]!.multiplier).toBe(REVOLUTION_MULT_MAX);
    expect(c.revolution.rules[2]!.multiplier).toBe(3);
    // 倍率は整数でしか使わない(press の乗算)ので、小数は四捨五入で潰す。
    expect(c.revolution.rules[3]!.multiplier).toBe(4);
  });

  it('durationSec は clamp され、非数は既定 60 に倒れる', () => {
    const c = validateChallengeConfig({
      revolution: {
        enabled: true,
        rules: [
          { id: 'a', durationSec: 1 },
          { id: 'b', durationSec: 9999 },
          { id: 'c', durationSec: null },
          { id: 'd', durationSec: 59.5 },
        ],
      },
    });
    // 下限 10 秒 — 導入6秒+カウント5秒の前置きより短い窓は「開いた瞬間に閉じる」。
    expect(c.revolution.rules[0]!.durationSec).toBe(REVOLUTION_DURATION_MIN_SEC);
    // 上限 120 秒。重ねがけの天井 REVOLUTION_MAX_MS(180秒)はこれとは別の安全弁。
    expect(c.revolution.rules[1]!.durationSec).toBe(REVOLUTION_DURATION_MAX_SEC);
    expect(c.revolution.rules[2]!.durationSec).toBe(60);
    expect(c.revolution.rules[3]!.durationSec).toBe(60);
  });

  it('壊れた行(null / 非オブジェクト)は既定行の内容へ倒れる', () => {
    const c = validateChallengeConfig({ revolution: { enabled: true, rules: [null, 'x'] } });
    expect(c.revolution.rules).toHaveLength(2);
    // 中身は既定行そのもの。id だけは重複を避けて振り直される。
    expect(c.revolution.rules[0]).toMatchObject({ giftName: 'swan', multiplier: 3, durationSec: 60 });
    expect(c.revolution.rules[1]).toMatchObject({ giftName: 'swan', multiplier: 3, durationSec: 60 });
  });

  it('giftId は trim、giftName / canonical は trim + 小文字化される', () => {
    const c = validateChallengeConfig({
      revolution: { enabled: true, rules: [{ id: ' a ', label: ' 白鳥 ', giftId: ' 699 ', giftName: ' SWAN ', canonical: ' Swan ' }] },
    });
    const r = c.revolution.rules[0]!;
    expect(r).toMatchObject({ id: 'a', label: '白鳥', giftId: '699', giftName: 'swan', canonical: 'swan' });
    // matchGiftTrigger は受信側を小文字化して比べるので、設定側も小文字で揃っていないと
    // 完全一致(exactName)が永久に外れる。
    expect(matchRevolution(c, { giftId: '0', giftName: 'SWAN' })?.id).toBe('a');
  });

  it('exactName は boolean 以外なら false へ倒す(既定行の true を壊れた値から復元はしない)', () => {
    const c = validateChallengeConfig({
      revolution: { enabled: true, rules: [{ id: 'a', giftName: 'swan', exactName: 'true' }, { id: 'b', giftName: 'swan' }] },
    });
    expect(c.revolution.rules[0]!.exactName).toBe(false);
    expect(c.revolution.rules[1]!.exactName).toBe(false);
  });

  it('重複・欠損 id は振り直す(欠損は rev-<index> 形式)', () => {
    const c = validateChallengeConfig({
      revolution: { enabled: true, rules: [{}, {}, { id: 'dup' }, { id: 'dup' }] },
    });
    const ids = c.revolution.rules.map((r) => r.id);
    expect(ids[0]).toBe('rev-0');
    expect(ids[1]).toBe('rev-1');
    expect(ids[2]).toBe('dup');
    // id は行ごとの実演(ChallengeTestEffectSpec.revolutionId)の宛先なので、
    // 重複したままだと「どの行を試すか」が決まらない。
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('上限を超えた行は捨て、id は一意のまま', () => {
    const many = Array.from({ length: REVOLUTION_RULES_MAX + 3 }, () => ({ id: 'dup' }));
    const c = validateChallengeConfig({ revolution: { enabled: true, rules: many } });
    expect(c.revolution.rules).toHaveLength(REVOLUTION_RULES_MAX);
    expect(new Set(c.revolution.rules.map((r) => r.id)).size).toBe(REVOLUTION_RULES_MAX);
  });

  it('冪等 — validate(validate(x)) === validate(x)', () => {
    const once = validateChallengeConfig({
      revolution: { enabled: true, rules: [{ id: 'a', giftId: ' 699 ', giftName: ' SWAN ', multiplier: 3.6 }] },
    });
    expect(validateChallengeConfig(once)).toEqual(once);
    // トリミング・小文字化・丸めが1回目で確定している。
    expect(once.revolution.rules[0]!.giftId).toBe('699');
    expect(once.revolution.rules[0]!.giftName).toBe('swan');
    expect(once.revolution.rules[0]!.multiplier).toBe(4);
  });

  it('既定をそのまま validate に通しても変わらない(DEFAULT_REVOLUTION が自己整合)', () => {
    expect(validateChallengeConfig({ revolution: structuredClone(DEFAULT_REVOLUTION) }).revolution).toEqual(
      DEFAULT_REVOLUTION
    );
  });
});

describe('revolutionActivationCount — 連打コンボの丸め', () => {
  it('1 以上・上限以下に丸める', () => {
    // 窓は直列化できないので、掛けるのは発動回数ではなく尺。上限 2 は
    // 既定 60 秒 × 2 = 120 秒 < REVOLUTION_MAX_MS(180秒)から来ている。
    expect(revolutionActivationCount(0)).toBe(1);
    expect(revolutionActivationCount(-5)).toBe(1);
    expect(revolutionActivationCount(1)).toBe(1);
    expect(revolutionActivationCount(2)).toBe(REVOLUTION_ACTIVATIONS_MAX);
    expect(revolutionActivationCount(17)).toBe(REVOLUTION_ACTIVATIONS_MAX);
  });

  it('小数は丸めてから clamp する', () => {
    expect(revolutionActivationCount(1.4)).toBe(1);
    expect(revolutionActivationCount(1.5)).toBe(2);
  });
});
