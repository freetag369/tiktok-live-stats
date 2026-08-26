import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_GIFT_SCALE,
  GIFT_SCALE_ROWS_MAX,
  matchGiftRule,
  matchGiftScale,
  migrateChallengeGiftScaleRows,
  validateChallengeConfig,
} from '@shared/challenge';
import type { ChallengeConfig, ChallengeEffect } from '@shared/dto';
import type { GiftEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * ダイヤ増減層(cfg.giftScale)。ユーザー決定(2026-08-26):
 *   - 💎 ≥ 9699 は 1💎につき +50(増える) / 💎 ≤ 9698 は +30(増える)
 *   - 例外行のギフトは 1💎につき −50(減る)
 *   - 「ギフト増減」タブの手動行(giftRules)がこの層より優先
 *   - お助け/フィーバー/お邪魔/革命/お題/ルーレットのギフトはそもそもここへ来ない
 *   - カットイン(全面カット/帯域)とは併発する
 */

const NOW = Date.UTC(2026, 7, 26, 12, 0, 0);
let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // このファイルの主役は増減の写像なので、凍結を張るカットインは既定で落とす。
  // 併発の検査だけが明示的に戻す。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.finalGate.enabled = false;
  base.commentHelper.enabled = false;
  base.roulettes = [];
  // 初期値は帯域の額(💎×50)を飲み込める大きさにする — 実運用でも ×50 のスケールに
  // 合わせて目標値を上げる前提。小さいままだと clampDownAmount の残量クランプが
  // 効いて「規則どおりか」ではなく「残量ちょうどか」を見るテストになってしまう。
  base.initialValue = 5_000_000;
  return { ...base, enabled: true, ...over };
}

function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  return {
    kind: 'gift',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'g1', nickname: 'gifter' },
    giftId: '99999',
    giftName: 'Some Gift',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

function engine(c: ChallengeConfig = cfg()): ChallengeEngine {
  const e = new ChallengeEngine(() => c, () => NOW, Math.random, Math.random, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

/** 直近のギフト effect。 */
function lastGift(e: ChallengeEngine): ChallengeEffect | undefined {
  return [...e.get().recentEffects].reverse().find((x) => x.kind === 'gift');
}

describe('matchGiftScale — 帯域と例外行', () => {
  const c = cfg();

  it('境界: 9698💎 は ×30・9699💎 は ×50(レオンとリリーがちょうど下端)', () => {
    expect(matchGiftScale(c, { giftId: 'x', diamonds: 9698 })?.amount).toBe(9698 * 30);
    expect(matchGiftScale(c, { giftId: 'x', diamonds: 9699 })?.amount).toBe(9699 * 50);
  });

  it('IMG1 の6件は個別登録なしで ×50 帯に入る', () => {
    // フェニックス / パーティーは続く / ホワイトウルフ / ハヤブサ / 夕暮れを背に / レオンとリリー
    for (const d of [25999, 15000, 12000, 10999, 10000, 9699]) {
      expect(matchGiftScale(c, { giftId: 'x', diamonds: d })?.amount).toBe(d * 50);
    }
  });

  it('例外行(giftId 一致)は帯域より先勝ちで応援(負)方向', () => {
    // 実測済みの giftId(streamdps の日本向け一覧 + analytics.db)。ID が入れ替わると
    // 「減らすはずのギフトで増える」という最悪の取り違えになるので値ごと固定する。
    // 幻のユニコーン 5000💎(Unicorn Fantasy)は ×30 帯に入るダイヤ数だが、例外行が勝つ。
    expect(matchGiftScale(c, { giftId: '7237', diamonds: 5000 })?.amount).toBe(-250_000);
    // 未来との遭遇 1500💎(Future Encounter)。
    expect(matchGiftScale(c, { giftId: '10668', diamonds: 1500 })?.amount).toBe(-75_000);
    // 流星群 3000💎(Meteor Shower・2026-08-26 実測)。
    expect(matchGiftScale(c, { giftId: '6563', diamonds: 3000 })?.amount).toBe(-150_000);
  });

  it('ユーザー指定の増加リストは個別登録なしで ×50 帯に入る(境界 9699 の根拠)', () => {
    // 2026-08-26 実測: ドラゴンの炎 26999 = Dragon Flame(7610) / フェニックス 25999 =
    // Phoenix(7319) / レオンとリリー 9699 = Leon and Lili(8916)。境界を上げ下げすると
    // ここが落ちる — リストの下端(9699)を割ってはいけない。
    for (const [giftId, diamonds] of [
      ['7610', 26999],
      ['7319', 25999],
      ['11586', 15000],
      ['8916', 9699],
    ] as const) {
      const r = matchGiftScale(c, { giftId, diamonds });
      expect(r?.amount, `${giftId} が ×50 帯から外れた`).toBe(diamonds * 50);
    }
  });

  it('行の単価(diamonds)は判定に使わない — 実際に届いた💎で計算する', () => {
    // 単価は表示と ▶ 実演のためだけの値。ここが判定に混ざると、連打で 2 個届いた
    // ときに 1 個ぶんしか動かない(または常に単価ぶん動く)という壊れ方をする。
    const row = c.giftScale.rows.find((r) => r.giftId === '7237');
    expect(row?.diamonds, '既定行に単価が入っている').toBe(5000);
    // 単価 5000 の行でも、届いた💎が 10000(連打2個)なら倍動く。
    expect(matchGiftScale(c, { giftId: '7237', diamonds: 10_000 })?.amount).toBe(-500_000);
  });

  it('富士花火は giftId 未確定でも英語名(Summer Fuji Mountain)で拾える', () => {
    // giftId が本線だが未確定なので giftName 'fuji' の部分一致で保険を張っている。
    // ライブ経路ではギフト名がローマ字で届く(canonical は乗らない)。
    expect(
      matchGiftScale(c, { giftId: '99999', giftName: 'Summer Fuji Mountain', diamonds: 7999 })?.amount
    ).toBe(-399_950);
    // 表記の揺れも飲む(短縮を 'fuji' にした理由)。
    expect(
      matchGiftScale(c, { giftId: '99999', giftName: 'Fuji Mountain', diamonds: 7999 })?.amount
    ).toBe(-399_950);
  });

  it("'fuji' の部分一致が他のギフトを巻き込まない(unicorn の前例の予防)", () => {
    // 7999💎 の同居ギフト(Star Throne / Monster Truck)を減算にしてはいけない。
    for (const giftName of ['Star Throne', 'Monster Truck', 'Fireworks', 'Mystery Firework']) {
      expect(
        matchGiftScale(c, { giftId: '8420', giftName, diamonds: 7999 })?.amount,
        `${giftName} を巻き込んだ`
      ).toBe(7999 * 30);
    }
  });

  it('3キーとも空の行は何にも一致しない(空行が全ギフトを拾う大事故の予防)', () => {
    // matchGiftTrigger の `!== ''` ガード。giftId だけ空でも giftName があれば
    // そちらで拾う(富士花火の行)ので、ここで見るのは「全部空なら当たらない」。
    const blank = { id: 'blank', giftId: '', giftName: '', canonical: '', perDiamond: -999 };
    const withBlank = cfg({
      giftScale: { ...DEFAULT_GIFT_SCALE, rows: [blank, ...DEFAULT_GIFT_SCALE.rows] },
    });
    expect(
      matchGiftScale(withBlank, { giftId: 'zzz', giftName: 'anything', diamonds: 7999 })?.amount
    ).toBe(7999 * 30);
  });

  it('enabled:false / 0💎 は対象外', () => {
    const off = cfg({ giftScale: { ...DEFAULT_GIFT_SCALE, enabled: false } });
    expect(matchGiftScale(off, { giftId: 'x', diamonds: 100 })).toBeNull();
    expect(matchGiftScale(c, { giftId: 'x', diamonds: 0 })).toBeNull();
  });

  it('係数 0 の帯は「一致しない」= giftDefault へ落とす(±0 のバナーを出さない)', () => {
    const zero = cfg({ giftScale: { ...DEFAULT_GIFT_SCALE, lowPerDiamond: 0 } });
    expect(matchGiftScale(zero, { giftId: 'x', diamonds: 100 })).toBeNull();
    expect(matchGiftRule(zero, { giftId: 'x', diamonds: 100 })?.amount).toBe(100); // giftDefault +1/💎
  });

  it('演出のしきい値は見た目だけ — 値は常に効く', () => {
    const low = matchGiftScale(c, { giftId: 'x', diamonds: 999 });
    const high = matchGiftScale(c, { giftId: 'x', diamonds: 1000 });
    expect(low?.amount).toBe(999 * 30);
    expect(low?.fx).toBe(false);
    expect(high?.fx).toBe(true);
  });
});

describe('matchGiftRule — giftScale は giftRules の後・giftDefault の前', () => {
  it('手動行(giftRules)がダイヤ増減より優先される(ユーザー決定)', () => {
    const c = cfg({
      giftRules: [{ id: 'manual', giftId: '7237', mode: 'fixed', amount: -7 }],
    });
    // 例外行にも帯域にも一致するギフトだが、手動行が勝つ。
    expect(matchGiftRule(c, { giftId: '7237', diamonds: 5000 })?.amount).toBe(-7);
    // 手動行はダイヤ増減由来ではないので演出の印を立てない。
    expect(matchGiftRule(c, { giftId: '7237', diamonds: 5000 })?.scaleFx).toBeUndefined();
  });

  it('ダイヤ増減が効いているあいだ giftDefault へは落ちない', () => {
    expect(matchGiftRule(cfg(), { giftId: 'x', diamonds: 10 })?.amount).toBe(300);
    const off = cfg({ giftScale: { ...DEFAULT_GIFT_SCALE, enabled: false } });
    expect(matchGiftRule(off, { giftId: 'x', diamonds: 10 })?.amount).toBe(10);
  });

  it('しきい値以上のときだけ scaleFx が立つ', () => {
    const c = cfg();
    expect(matchGiftRule(c, { giftId: 'x', diamonds: 1000 })?.scaleFx).toBe(true);
    expect(matchGiftRule(c, { giftId: 'x', diamonds: 999 })?.scaleFx).toBeUndefined();
  });
});

describe('ChallengeEngine — 値・統計・演出の印', () => {
  it('妨害(増える)側: 値と giftUp が動き、effect に giftScale が立つ', () => {
    const e = engine();
    e.start();
    const before = e.get().value;
    e.handleEvent(gift({ giftId: 'x', diamonds: 10_000, diamondEach: 10_000 }));
    const s = e.get();
    expect(s.value).toBe(before + 500_000);
    expect(s.stats.giftUp).toBe(500_000);
    expect(lastGift(e)?.giftScale).toBe(true);
    expect(lastGift(e)?.amount).toBe(500_000);
  });

  it('応援(減る)側: 例外行のギフトは値が減り giftDown に載る', () => {
    const e = engine();
    e.start();
    const before = e.get().value;
    e.handleEvent(gift({ giftId: '7237', diamonds: 5000, diamondEach: 5000 }));
    const s = e.get();
    expect(s.value).toBe(before - 250_000);
    expect(s.stats.giftDown).toBe(250_000);
    expect(lastGift(e)?.amount).toBe(-250_000);
  });

  it('【実減少量規約】残量を割る減算は実際に減った量で焼かれる', () => {
    // 名目のまま焼くとモニターのラッチ表示(valueAfter - amount)が飛ぶ。
    const e = engine(cfg({ initialValue: 100 }));
    e.start();
    e.handleEvent(gift({ giftId: '7237', diamonds: 5000, diamondEach: 5000 }));
    const s = e.get();
    expect(s.value).toBe(0);
    expect(lastGift(e)?.amount).toBe(-100);
    expect(s.stats.giftDown).toBe(100);
  });

  it('しきい値未満は値だけ動いて演出の印は立たない', () => {
    const e = engine();
    e.start();
    e.handleEvent(gift({ giftId: 'x', diamonds: 1, diamondEach: 1 }));
    expect(lastGift(e)?.amount).toBe(30);
    expect(lastGift(e)?.giftScale).toBeUndefined();
  });

  it('【凍結を張らない】演出はモニターの据え置きだけで完結する', () => {
    // 張ると高額ギフトのたびにカウントダウンが3秒止まる(band と違い幕が無い)。
    const e = engine();
    e.start();
    const before = e.get().value;
    e.handleEvent(gift({ giftId: 'x', diamonds: 10_000, diamondEach: 10_000 }));
    // 直後の押下がその場で効く = 凍結もバリアも張られていない。
    e.press();
    expect(e.get().value).toBe(before + 500_000 - 1);
    expect(e.get().stats.presses).toBe(1);
  });

  it('カットイン(帯域)と併発する — 印もクリップも両方載る', () => {
    const c = cfg({ giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX) });
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ giftId: 'x', diamonds: 10_000, diamondEach: 10_000 }));
    const g = lastGift(e);
    expect(g?.giftScale).toBe(true);
    expect(g?.fxBandClip).toBeTruthy(); // overflow:'top' で最上位バンドが当たる
  });

  it('お助け(ファンスタンプ)には印を立てない(専用バナーが主役)', () => {
    const c = cfg({
      fanStamp: { ...DEFAULT_CHALLENGE.fanStamp, enabled: true, giftId: 'fs1', amountEach: -3 },
    });
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ giftId: 'fs1', diamonds: 1, diamondEach: 1 }));
    const g = lastGift(e);
    expect(g?.fanStamp).toBe(true);
    expect(g?.giftScale).toBeUndefined();
    expect(g?.amount).toBe(-3); // お助けの写像が丸ごと置き換える
  });

  it('ルーレットのギフトはこの層へ到達しない(排他は既存実装で成立)', () => {
    const c = cfg({
      roulettes: [
        {
          ...structuredClone(DEFAULT_CHALLENGE.roulettes[0]!),
          enabled: true,
          giftId: 'rl1',
          giftName: '',
          canonical: '',
        },
      ],
    });
    const e = engine(c);
    e.start();
    e.handleEvent(gift({ giftId: 'rl1', diamonds: 10_000, diamondEach: 10_000 }));
    const eff = [...e.get().recentEffects].reverse()[0];
    expect(eff?.kind).toBe('roulette');
    expect(lastGift(e)).toBeUndefined();
  });
});

describe('行ごとの ▶ 実演(2026-08-27 の取り違え修正)', () => {
  it('spec.amount を渡すとその額で試写できる(帯域に落ちない)', () => {
    // 【踏んだバグ】worker は giftId:'test' で照合するので、spec.amount が無いと
    // どの行の ▶ でも例外行に一致せず必ず帯域(lowPerDiamond=30)へ落ちていた。
    // 「−50 と書いてあるのに +30,000 が出る」という症状の回帰止め。
    const e = engine();
    e.start();
    e.testEffect({ kind: 'gift', diamonds: 5000, scale: true, amount: -250_000 });
    const g = lastGift(e);
    expect(g?.amount).toBe(-250_000);
    expect(g?.giftScale).toBe(true);
    expect(g?.test).toBe(true);
  });

  it('spec.amount 無しは従来どおり写像を通す(帯域 ×30)', () => {
    const e = engine();
    e.start();
    e.testEffect({ kind: 'gift', diamonds: 1000, scale: true });
    expect(lastGift(e)?.amount).toBe(30_000);
  });

  it('実演は値・統計・凍結に触らない(testEffect の契約)', () => {
    const e = engine();
    e.start();
    const before = e.get().value;
    e.testEffect({ kind: 'gift', diamonds: 5000, scale: true, amount: -250_000 });
    expect(e.get().value).toBe(before);
    expect(e.get().stats.giftDown).toBe(0);
    // 凍結が張られていない = 直後の押下がその場で効く。
    e.press();
    expect(e.get().value).toBe(before - 1);
  });
});

describe('validateGiftScale — 欠損フォールバックとサニタイズ', () => {
  it('キー欠損は既定へ倒す(これが移行の代わり — SETTINGS_VERSION は上げない)', () => {
    expect(validateChallengeConfig({}).giftScale).toEqual(DEFAULT_GIFT_SCALE);
  });

  it('enabled / fxEnabled の既定は true(`!== false` の向き)', () => {
    // `=== true` にすると、このキーを知らない既存の settings.json 全部で機能が死ぬ。
    const v = validateChallengeConfig({ giftScale: { threshold: 5000 } });
    expect(v.giftScale.enabled).toBe(true);
    expect(v.giftScale.fxEnabled).toBe(true);
    expect(v.giftScale.threshold).toBe(5000);
    expect(validateChallengeConfig({ giftScale: { enabled: false } }).giftScale.enabled).toBe(false);
  });

  it('giftName / canonical は小文字化して保存する(matchGiftTrigger の前提)', () => {
    const v = validateChallengeConfig({
      giftScale: {
        rows: [
          { id: 'r', giftId: ' 42 ', giftName: '  Fuji Fireworks ', canonical: 'ROSE', perDiamond: -50 },
        ],
      },
    });
    expect(v.giftScale.rows[0]).toMatchObject({
      giftId: '42',
      giftName: 'fuji fireworks',
      canonical: 'rose',
      perDiamond: -50,
    });
  });

  it('perDiamond が 0 / 非数値の行は捨てる(無反応の行を残さない)', () => {
    const v = validateChallengeConfig({
      giftScale: {
        rows: [
          { id: 'a', giftId: '1', perDiamond: 0 },
          { id: 'b', giftId: '2', perDiamond: 'x' },
          { id: 'c', giftId: '3', perDiamond: -30 },
        ],
      },
    });
    expect(v.giftScale.rows.map((r) => r.id)).toEqual(['c']);
  });

  it('行数は上限で切る', () => {
    const rows = Array.from({ length: GIFT_SCALE_ROWS_MAX + 5 }, (_, i) => ({
      id: `r${i}`,
      giftId: `${i}`,
      perDiamond: -1,
    }));
    expect(validateChallengeConfig({ giftScale: { rows } }).giftScale.rows.length).toBe(
      GIFT_SCALE_ROWS_MAX
    );
  });

  it('境界は 1 以上へクランプする(0 だと「未満」が空集合になり低額帯が死ぬ)', () => {
    expect(validateChallengeConfig({ giftScale: { threshold: 0 } }).giftScale.threshold).toBe(1);
    expect(validateChallengeConfig({ giftScale: { threshold: -5 } }).giftScale.threshold).toBe(1);
  });

  it('検証は不動点(同じ設定を2回通しても変わらない)', () => {
    const once = validateChallengeConfig({ giftScale: DEFAULT_GIFT_SCALE });
    const twice = validateChallengeConfig(once);
    expect(twice.giftScale).toEqual(once.giftScale);
  });
});

describe('v16 移行 — 保存済み設定へ「あとから足した欄」を配る', () => {
  /** v15 時点の保存済み(単価も giftName も無い)を再現する。 */
  function v15(): ChallengeConfig {
    const c = cfg();
    return {
      ...c,
      giftScale: {
        ...c.giftScale,
        rows: c.giftScale.rows.map((r) => ({ ...r, giftName: '', diamonds: undefined })),
      },
    };
  }

  it('単価と富士花火の名前一致が入る(実機で壊れていた本体)', () => {
    const m = migrateChallengeGiftScaleRows(v15(), 15);
    const by = new Map(m.giftScale.rows.map((r) => [r.id, r]));
    expect(by.get('gs-unicorn-fantasy')?.diamonds).toBe(5000);
    expect(by.get('gs-future-encounter')?.diamonds).toBe(1500);
    expect(by.get('gs-meteor-shower')?.diamonds).toBe(3000);
    expect(by.get('gs-fuji-fireworks')?.diamonds).toBe(7999);
    expect(by.get('gs-fuji-fireworks')?.giftName).toBe('fuji');
  });

  it('移行後は富士花火が減算になる(逆方向に動く症状の回帰止め)', () => {
    // 移行前: 3キーとも空なので何にも一致せず、帯域(+30/💎)へ落ちて **増える**。
    const before = matchGiftScale(v15(), {
      giftId: '99999',
      giftName: 'Summer Fuji Mountain',
      diamonds: 7999,
    });
    expect(before?.amount).toBe(7999 * 30);
    // 移行後: 名前一致で拾って **減る**。
    const after = matchGiftScale(migrateChallengeGiftScaleRows(v15(), 15), {
      giftId: '99999',
      giftName: 'Summer Fuji Mountain',
      diamonds: 7999,
    });
    expect(after?.amount).toBe(-399_950);
  });

  it('v16 以降では何も触らない', () => {
    const src = v15();
    expect(migrateChallengeGiftScaleRows(src, 16)).toBe(src);
    expect(migrateChallengeGiftScaleRows(src, 99)).toBe(src);
  });

  it('ユーザーが入れた値を壊さない(欠けている欄だけ埋める)', () => {
    const src = v15();
    const mine: ChallengeConfig = {
      ...src,
      giftScale: {
        ...src.giftScale,
        rows: src.giftScale.rows.map((r) =>
          r.id === 'gs-fuji-fireworks'
            ? { ...r, diamonds: 1234, giftName: 'mine', label: '自分のメモ' }
            : r
        ),
      },
    };
    const row = migrateChallengeGiftScaleRows(mine, 15).giftScale.rows.find(
      (r) => r.id === 'gs-fuji-fireworks'
    );
    expect(row).toMatchObject({ diamonds: 1234, giftName: 'mine', label: '自分のメモ' });
  });

  it('消した行を復活させない / 自分で足した行も触らない', () => {
    const src = v15();
    const custom = { id: 'my-row', giftId: '111', giftName: '', canonical: '', perDiamond: -1 };
    const edited: ChallengeConfig = {
      ...src,
      giftScale: {
        ...src.giftScale,
        rows: [...src.giftScale.rows.filter((r) => r.id !== 'gs-meteor-shower'), custom],
      },
    };
    const out = migrateChallengeGiftScaleRows(edited, 15).giftScale.rows;
    expect(out.map((r) => r.id)).not.toContain('gs-meteor-shower');
    expect(out.length).toBe(edited.giftScale.rows.length);
    expect(out.find((r) => r.id === 'my-row')).toEqual(custom);
  });

  it('冪等 かつ validate の不動点(二度読みで同じ結果)', () => {
    const once = migrateChallengeGiftScaleRows(v15(), 15);
    expect(migrateChallengeGiftScaleRows(once, 15)).toEqual(once);
    expect(validateChallengeConfig(once).giftScale).toEqual(once.giftScale);
  });

  it('既に最新の設定には触らない(参照ごと返す)', () => {
    const fresh = cfg();
    expect(migrateChallengeGiftScaleRows(fresh, 0)).toBe(fresh);
  });
});
