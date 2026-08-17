import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_STAMP_TRIGGERS,
  STAMP_TRIGGER_RULES_MAX,
  STAMP_TRIGGER_RULES_V8,
  matchStampTriggers,
  migrateChallengeConfig,
  migrateChallengeStampTriggers,
  validateChallengeConfig,
} from '@shared/challenge';
import { FAN_STAMP_FX_WINDOW_MS } from '@shared/fan-stamp';
import type { ChallengeConfig, ChallengeEffect, StampTriggerRule } from '@shared/dto';
import type { CommentEvent, EmoteEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * チャットスタンプ(サブスクエモート)トリガーのテスト。
 *
 * スタンプはギフトではなく WebcastChatMessage の emotes(または
 * WebcastEmoteChatMessage)として届く。1メッセージに複数スタンプが載るので、
 * 一致した全部の合計を1回で適用し、演出はお助け(fanStamp)のバナー・合算窓を
 * 丸ごと流用する — このファイルが固定するのはその契約。
 * ヘルパーの形は challenge-fan-stamp-merge.spec.ts に合わせてある。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const V0 = DEFAULT_CHALLENGE.initialValue;

/** 実測に合わせた 19 桁の emoteId(ようこそ / またね)。 */
const ID_WELCOME = '7671092908083137301';
const ID_BYE = '7671092908083170069';

let seq = 0;

function comment(over: Partial<CommentEvent> = {}): CommentEvent {
  seq += 1;
  return {
    kind: 'comment',
    msgId: `c${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'u1', nickname: 'すたんぱー' },
    content: ' ',
    isQuestion: false,
    ...over,
  };
}

function emote(over: Partial<EmoteEvent> = {}): EmoteEvent {
  seq += 1;
  return {
    kind: 'emote',
    msgId: `e${seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'u1', nickname: 'すたんぱー' },
    emoteId: ID_WELCOME,
    emoteIds: [ID_WELCOME],
    ...over,
  };
}

function rule(over: Partial<StampTriggerRule> = {}): StampTriggerRule {
  return { id: 'r1', label: 'ようこそ', emoteId: ID_WELCOME, amountEach: -1, enabled: true, ...over };
}

function stCfg(
  rules: StampTriggerRule[],
  c: Partial<ChallengeConfig> = {}
): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定のカットイン系がバラ等に一致して凍結を張るのを避ける(fan-stamp-merge と同じ)。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  return {
    ...base,
    enabled: true,
    stampTriggers: { ...structuredClone(DEFAULT_STAMP_TRIGGERS), rules },
    ...c,
  };
}

function engineAt(c: ChallengeConfig, clock: { t: number }): ChallengeEngine {
  const e = new ChallengeEngine(
    () => c,
    () => clock.t,
    Math.random,
    Math.random,
    () => undefined
  );
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

/** gift 種(スタンプは fanStamp バナー = kind 'gift')だけを古い順に。 */
function gifts(e: ChallengeEngine): ChallengeEffect[] {
  return e
    .get()
    .recentEffects.filter((x) => x.kind === 'gift')
    .reverse();
}

describe('validateStampTriggers(validateChallengeConfig 経由)', () => {
  it('キー欠損は既定の15行へ(stampTriggers を持たない設定はこれが移行を兼ねる)', () => {
    const c = validateChallengeConfig({});
    expect(c.stampTriggers).toEqual(DEFAULT_STAMP_TRIGGERS);
    // 両辺が一緒に動くトートロジーにしないため、実数と実際の番号でも留める。
    expect(c.stampTriggers.rules).toHaveLength(15);
    expect(c.stampTriggers.rules.map((r) => r.emoteId)).toContain(ID_WELCOME);
  });

  it('rules を空配列で持っている設定はそのまま空(欠損フォールバックは効かない)', () => {
    // v0.7.7 の保存済み settings.json がこの形。ここに15行を配れるのは
    // migrateChallengeStampTriggers だけ、というのが SETTINGS_VERSION 8 の理由。
    const c = validateChallengeConfig({ stampTriggers: { enabled: true, flash: true, rules: [] } });
    expect(c.stampTriggers.rules).toHaveLength(0);
  });

  it('行をサニタイズする(id 無し行は捨てる・量は丸めて clamp)', () => {
    const c = validateChallengeConfig({
      stampTriggers: {
        enabled: true,
        rules: [
          { id: 'a', label: '  ようこそ ', emoteId: ` ${ID_WELCOME} `, amountEach: -1.6 },
          { label: 'idなし', emoteId: '1', amountEach: 1 },
          { id: 'b', emoteId: '2', amountEach: 9_999_999 },
        ],
      },
    });
    expect(c.stampTriggers.rules).toHaveLength(2);
    expect(c.stampTriggers.rules[0]).toEqual({
      id: 'a',
      label: 'ようこそ',
      emoteId: ID_WELCOME,
      amountEach: -2,
      enabled: true,
    });
    expect(c.stampTriggers.rules[1]!.amountEach).toBe(999_999);
    // flash はキー欠損でも既定 true(fanStamp.flash と同じ向き)。
    expect(c.stampTriggers.flash).toBe(true);
  });

  it('行数は STAMP_TRIGGER_RULES_MAX で打ち切る', () => {
    const rules = Array.from({ length: STAMP_TRIGGER_RULES_MAX + 5 }, (_, i) => ({
      id: `r${i}`,
      emoteId: String(i),
      amountEach: -1,
    }));
    const c = validateChallengeConfig({ stampTriggers: { rules } });
    expect(c.stampTriggers.rules).toHaveLength(STAMP_TRIGGER_RULES_MAX);
  });
});

describe('matchStampTriggers', () => {
  it('同じスタンプの重複は個数ぶん数え、別スタンプは行ごとの量で合算する', () => {
    const cfg = stCfg([rule(), rule({ id: 'r2', label: 'またね', emoteId: ID_BYE, amountEach: 5 })]);
    const m = matchStampTriggers(cfg, [ID_WELCOME, ID_WELCOME, ID_BYE, '999']);
    expect(m).toEqual({ amount: -1 + -1 + 5, count: 3, flash: true });
  });

  it('無効行・空 emoteId 行・一致なし・emoteIds 空は null', () => {
    const cfg = stCfg([rule({ enabled: false }), rule({ id: 'r2', emoteId: '' })]);
    expect(matchStampTriggers(cfg, [ID_WELCOME])).toBeNull();
    expect(matchStampTriggers(cfg, [])).toBeNull();
    expect(matchStampTriggers(stCfg([rule()]), undefined)).toBeNull();
    expect(matchStampTriggers(stCfg([rule()], undefined), ['他'])).toBeNull();
  });

  it('同じ emoteId を2行に書いた誤設定は上の行が勝つ(先勝ち)', () => {
    const cfg = stCfg([rule({ amountEach: -1 }), rule({ id: 'r2', amountEach: -100 })]);
    expect(matchStampTriggers(cfg, [ID_WELCOME])).toEqual({ amount: -1, count: 1, flash: true });
  });

  it('機能オフなら一致しない', () => {
    const cfg = stCfg([rule()]);
    cfg.stampTriggers.enabled = false;
    expect(matchStampTriggers(cfg, [ID_WELCOME])).toBeNull();
  });
});

describe('スタンプトリガー — エンジン適用', () => {
  it('スタンプ付きコメントでお助けバナー(fanStamp effect)が出て値が動く', () => {
    const clock = { t: NOW };
    const e = engineAt(stCfg([rule({ amountEach: -3 })]), clock);
    e.start();
    e.handleEvent(comment({ emoteIds: [ID_WELCOME] }));
    expect(e.get().value).toBe(V0 - 3);
    const fx = gifts(e);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.fanStamp).toBe(true);
    expect(fx[0]!.amount).toBe(-3);
    expect(fx[0]!.nickname).toBe('すたんぱー');
    // 1個なら ×N は載せない(お助けの1人文言と同じ経路へ倒す)。
    expect(fx[0]!.giftCount).toBeUndefined();
  });

  it('1メッセージに複数スタンプ → 合計1回で適用し ×N が載る', () => {
    const clock = { t: NOW };
    const e = engineAt(
      stCfg([rule(), rule({ id: 'r2', label: 'またね', emoteId: ID_BYE, amountEach: -2 })]),
      clock
    );
    e.start();
    e.handleEvent(comment({ emoteIds: [ID_WELCOME, ID_BYE, ID_BYE] }));
    expect(e.get().value).toBe(V0 - 5);
    const fx = gifts(e);
    expect(fx).toHaveLength(1);
    expect(fx[0]!.amount).toBe(-5);
    expect(fx[0]!.giftCount).toBe(3);
  });

  it('お助けの合算窓を共有する — 窓内の2通目はバナーにならず値だけ動く', () => {
    const clock = { t: NOW };
    const e = engineAt(stCfg([rule()]), clock);
    e.start();
    e.handleEvent(comment({ viewer: { userId: 'a', nickname: 'A' }, emoteIds: [ID_WELCOME] }));
    clock.t = NOW + 200;
    e.handleEvent(comment({ viewer: { userId: 'b', nickname: 'B' }, emoteIds: [ID_WELCOME] }));
    expect(e.get().value).toBe(V0 - 2);
    expect(gifts(e)).toHaveLength(1); // 先頭の1枚だけ
    // 窓が明けたら尻が1枚(合算)。
    clock.t = NOW + FAN_STAMP_FX_WINDOW_MS;
    e.drainIfChanged();
    const fx = gifts(e);
    expect(fx).toHaveLength(2);
    expect(fx[1]!.amount).toBe(-1);
  });

  it('量 0 の行は演出だけ出して値を動かさない', () => {
    const clock = { t: NOW };
    const e = engineAt(stCfg([rule({ amountEach: 0 })]), clock);
    e.start();
    e.handleEvent(comment({ emoteIds: [ID_WELCOME] }));
    expect(e.get().value).toBe(V0);
    expect(gifts(e)).toHaveLength(1);
    expect(gifts(e)[0]!.amount).toBe(0);
  });

  it('スタンプ一致はコメント妨害より先勝ち(両方には発動しない)', () => {
    const clock = { t: NOW };
    const cfg = stCfg([rule({ amountEach: -1 })]);
    cfg.commentRules = [{ id: 'k1', keyword: 'あ', amount: 100 }];
    const e = engineAt(cfg, clock);
    e.start();
    e.handleEvent(comment({ content: 'あいうえお', emoteIds: [ID_WELCOME] }));
    expect(e.get().value).toBe(V0 - 1); // +100 は乗らない
    // スタンプの載っていない同文コメントは従来どおり妨害が効く。
    e.handleEvent(comment({ content: 'あいうえお' }));
    expect(e.get().value).toBe(V0 - 1 + 100);
  });

  it('emote 単独メッセージ(WebcastEmoteChatMessage)でも発動する', () => {
    const clock = { t: NOW };
    const e = engineAt(stCfg([rule({ amountEach: -2 })]), clock);
    e.start();
    e.handleEvent(emote());
    expect(e.get().value).toBe(V0 - 2);
    expect(gifts(e)[0]!.fanStamp).toBe(true);
  });

  it('emoteIds 欠損の旧 emote イベントは emoteId 1件で判定する', () => {
    const clock = { t: NOW };
    const e = engineAt(stCfg([rule({ amountEach: -2 })]), clock);
    e.start();
    e.handleEvent(emote({ emoteIds: undefined }));
    expect(e.get().value).toBe(V0 - 2);
  });

  it('同じ msgId の再配信(再接続バックログ)は二重適用しない', () => {
    const clock = { t: NOW };
    const e = engineAt(stCfg([rule()]), clock);
    e.start();
    const c1 = comment({ emoteIds: [ID_WELCOME] });
    e.handleEvent(c1);
    e.handleEvent(c1);
    const e1 = emote();
    e.handleEvent(e1);
    e.handleEvent(e1);
    expect(e.get().value).toBe(V0 - 2); // comment 1 + emote 1
  });

  it('機能オフならスタンプ付きコメントは素通り(コメント妨害の評価には進む)', () => {
    const clock = { t: NOW };
    const cfg = stCfg([rule()]);
    cfg.stampTriggers.enabled = false;
    cfg.commentRules = [{ id: 'k1', keyword: 'あ', amount: 100 }];
    const e = engineAt(cfg, clock);
    e.start();
    e.handleEvent(comment({ content: 'あ', emoteIds: [ID_WELCOME] }));
    expect(e.get().value).toBe(V0 + 100);
  });
});

/**
 * 出荷既定のスタンプ15行(SETTINGS_VERSION 8)を凍結した写し。番号の権威は
 * プロジェクト直下の「ファンスタ番号一覧_metafact8.md」— 実装側
 * (STAMP_TRIGGER_RULES_V8)を書き換えると、この表と食い違った時点で落ちる。
 */
const V8_TABLE: ReadonlyArray<readonly [string, string]> = [
  ['おかえり', '7673028474703203092'],
  ['やっほー', '7673028113942088469'],
  ['メンレベUP↗', '7672235836915747604'],
  ['ナイギフ', '7672236083434703637'],
  ['ようこそ', '7671092908083137301'],
  ['またね', '7671092908083170069'],
  ['がんばれ', '7671092908083202837'],
  ['ぱちぱち', '7671092908083235605'],
  ['笑', '7671092908083333909'],
  ['おめでとう', '7671092908083366677'],
  ['え?', '7671092908083399445'],
  ['いいね♡', '7671092908083432213'],
  ['TAP', '7671093685229472533'],
  ['グッド(👍)', '7671094445665700628'],
  ['ハイタッチ(🙌)', '7671096936174439188'],
];

describe('出荷既定のスタンプ15行(STAMP_TRIGGER_RULES_V8)', () => {
  it('番号一覧の表と表示名・番号が1件ずつ一致する(順序込み)', () => {
    expect(STAMP_TRIGGER_RULES_V8.map((r) => [r.label, r.emoteId])).toEqual(
      V8_TABLE.map(([label, emoteId]) => [label, emoteId])
    );
  });

  it('id も emoteId も重複しない', () => {
    expect(new Set(STAMP_TRIGGER_RULES_V8.map((r) => r.id)).size).toBe(V8_TABLE.length);
    expect(new Set(STAMP_TRIGGER_RULES_V8.map((r) => r.emoteId)).size).toBe(V8_TABLE.length);
  });

  it('全行が -1(お助け)・有効・19桁の emoteId', () => {
    for (const r of STAMP_TRIGGER_RULES_V8) {
      expect(r.amountEach, r.label).toBe(-1);
      expect(r.enabled, r.label).toBe(true);
      expect(r.emoteId, r.label).toMatch(/^[0-9]{19}$/);
    }
  });

  it('行数上限に収まっていて、利用者が足す余地も残る', () => {
    expect(STAMP_TRIGGER_RULES_V8.length).toBeLessThan(STAMP_TRIGGER_RULES_MAX);
  });

  it('既定に15行がそのまま載る(DEFAULT_CHALLENGE 経由でも同じ)', () => {
    expect(DEFAULT_STAMP_TRIGGERS.rules).toEqual([...STAMP_TRIGGER_RULES_V8]);
    expect(DEFAULT_CHALLENGE.stampTriggers.rules).toEqual([...STAMP_TRIGGER_RULES_V8]);
    // 既定は凍結配列の**写し**。既定の行を触っても凍結表は動かない。
    expect(DEFAULT_STAMP_TRIGGERS.rules[0]).not.toBe(STAMP_TRIGGER_RULES_V8[0]);
  });

  it('設定を何もいじらなくても「ようこそ」で -1 動く', () => {
    expect(matchStampTriggers(DEFAULT_CHALLENGE, [ID_WELCOME])).toEqual({
      amount: -1,
      count: 1,
      flash: true,
    });
  });

  it('配られた15行は validateChallengeConfig を通しても1文字も変わらない', () => {
    const v = validateChallengeConfig(structuredClone(DEFAULT_CHALLENGE));
    expect(v.stampTriggers.rules).toEqual([...STAMP_TRIGGER_RULES_V8]);
  });
});

describe('設定移行 — お助けのスタンプ15行(SETTINGS_VERSION 8)', () => {
  /** v0.7.7 相当(stampTriggers キーはあるが行が無い)設定。 */
  function oldCfg(rules: StampTriggerRule[] = []): ChallengeConfig {
    const c = structuredClone(DEFAULT_CHALLENGE);
    c.stampTriggers = { ...c.stampTriggers, rules };
    return c;
  }

  it('v8 未満なら15行が末尾に付く', () => {
    const after = migrateChallengeStampTriggers(oldCfg(), 7);
    expect(after.stampTriggers.rules).toEqual([...STAMP_TRIGGER_RULES_V8]);
  });

  it('fromVersion >= 8 は同一参照で返す(消した人に復活させない)', () => {
    const c = oldCfg();
    expect(migrateChallengeStampTriggers(c, 8)).toBe(c);
    expect(migrateChallengeConfig(c, 8).stampTriggers.rules).toHaveLength(0);
  });

  it('二重に増えない — 2回流しても15行のまま', () => {
    const once = migrateChallengeStampTriggers(oldCfg(), 7);
    const twice = migrateChallengeStampTriggers(once, 7);
    expect(twice.stampTriggers.rules).toHaveLength(V8_TABLE.length);
    expect(new Set(twice.stampTriggers.rules.map((r) => r.emoteId)).size).toBe(V8_TABLE.length);
  });

  it('同じ番号を自分で入れていればその行は増えず、残り14行だけ足す', () => {
    const mine: StampTriggerRule = {
      id: 'mine',
      label: 'じぶんの',
      emoteId: ID_WELCOME,
      amountEach: -50,
      enabled: false,
    };
    const after = migrateChallengeStampTriggers(oldCfg([mine]), 7);
    expect(after.stampTriggers.rules).toHaveLength(V8_TABLE.length);
    // 自分で書いた行は先頭のまま・中身も変えない(量も無効フラグも尊重)。
    expect(after.stampTriggers.rules[0]).toEqual(mine);
    expect(after.stampTriggers.rules.filter((r) => r.emoteId === ID_WELCOME)).toHaveLength(1);
  });

  it('上限に達している設定には足さず、残り枠しか無ければその枠ぶんだけ足す', () => {
    const fill = (n: number) =>
      Array.from({ length: n }, (_, i) => rule({ id: `r${i}`, emoteId: `x${i}` }));

    const full = oldCfg(fill(STAMP_TRIGGER_RULES_MAX));
    expect(migrateChallengeStampTriggers(full, 0)).toBe(full);

    const near = migrateChallengeStampTriggers(oldCfg(fill(STAMP_TRIGGER_RULES_MAX - 3)), 0);
    expect(near.stampTriggers.rules).toHaveLength(STAMP_TRIGGER_RULES_MAX);
    expect(near.stampTriggers.rules.slice(-3).map((r) => r.emoteId)).toEqual(
      STAMP_TRIGGER_RULES_V8.slice(0, 3).map((r) => r.emoteId)
    );
  });

  it('入力を破壊しない', () => {
    const c = oldCfg();
    migrateChallengeStampTriggers(c, 0);
    expect(c.stampTriggers.rules).toHaveLength(0);
  });

  it('migrateChallengeConfig がスタンプの段も通す', () => {
    expect(migrateChallengeConfig(oldCfg(), 0).stampTriggers.rules).toHaveLength(V8_TABLE.length);
  });

  it('**validateChallengeConfig は行を足さない**(移行を validate に入れない担保)', () => {
    expect(validateChallengeConfig(oldCfg()).stampTriggers.rules).toHaveLength(0);
  });
});
