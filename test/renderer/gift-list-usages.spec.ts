import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateChallengeConfig } from '@shared/challenge';
import type { ChallengeConfig, GiftCatalogRow } from '@shared/dto';
import { usagesOf } from '../../src/renderer/screens/gift-list-usages';

/**
 * ギフトリスト「現在の用途」の発火可否モデル(2026-08-21 のバグ修正)。
 *
 * 旧実装は一致 2 件目以降を一律に「発火しません」(取り消し線)にしていたが、
 * worker の giftOp では**全面カットは増減規則と併発する**(排他の早期 return は
 * お助け/ブースト/革命/お邪魔/ルーレットの5機能だけ。お助けが全面カットを
 * 抑止するのは suppressBandFx が ON のときのみ)。この乖離で「死んでいるはず」の
 * 全面カット行を配信者が誤って消す・「出ないはず」と誤診断する実害があった。
 * ここでは UI 側モデル(usagesOf の blockedBy)を worker の実挙動へ固定する。
 */

function row(over: Partial<GiftCatalogRow> = {}): GiftCatalogRow {
  return {
    giftId: '5655',
    name: 'rose',
    diamonds: 1,
    giftType: 1,
    iconUrl: null,
    canonical: null,
    count: 1,
    maxRepeat: 1,
    totalDiamonds: 1,
    firstSeenMs: null,
    lastSeenMs: null,
    ...over,
  };
}

const FC_ROW = {
  id: 'fc1',
  label: '',
  giftId: '5655',
  giftName: '',
  canonical: '',
  exactName: false,
  clip: 'cut-rose',
  durationSec: 5,
  enabled: true,
};

// mode を欠くと isValidRule が黙って行ごと捨てる(validateChallengeConfig の規約)。
const GR_ROW = { id: 'gr1', giftId: '5655', mode: 'fixed', amount: -5 };

const TL_ROW = {
  id: 'tl1',
  label: '',
  enabled: true,
  giftId: '5655',
  giftName: '',
  canonical: '',
  exactName: false,
  durationSec: 30,
  amountEach: 0,
  flash: false,
};

function cfg(over: Record<string, unknown> = {}): ChallengeConfig {
  // 土台は全機能オフ — 出荷既定の行(バラのルーレット行・fullcut-rose 等)が
  // 'rose' に一致してテストへ混入しないようにする(既定行の増減で赤くしない)。
  return validateChallengeConfig({
    fxClipsEnabled: true, // matchGiftFullCut の前提(false だと全面カット自体が不一致)
    roulettes: [],
    giftRules: [],
    giftFullCut: { enabled: false, volume: 70, rules: [] },
    fanStamp: {
      enabled: false,
      giftId: '',
      giftName: '',
      canonical: '',
      amountEach: -1,
      suppressBandFx: true,
      flash: false,
    },
    tapBoost: { enabled: false, rules: [] },
    tapLock: { enabled: false, rules: [] },
    revolution: { enabled: false, rules: [] },
    ...over,
  });
}

function usageMap(c: ChallengeConfig, r: GiftCatalogRow): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const u of usagesOf(c, r)) out[u.key] = u.blockedBy ?? 'FIRES';
  return out;
}

describe('usagesOf — 発火可否(blockedBy)は worker の giftOp と同じモデル', () => {
  it('増減規則と全面カットは併発する(どちらも発火扱い・取り消し線なし)', () => {
    const u = usageMap(cfg({ giftRules: [GR_ROW], giftFullCut: { enabled: true, volume: 70, rules: [FC_ROW] } }), row());
    expect(u).toEqual({ giftRule: 'FIRES', fullCut: 'FIRES' });
  });

  it('排他5機能(例: お邪魔)が勝つと、増減規則も全面カットも食われる', () => {
    const u = usageMap(
      cfg({
        tapLock: { enabled: true, rules: [TL_ROW] },
        giftRules: [GR_ROW],
        giftFullCut: { enabled: true, volume: 70, rules: [FC_ROW] },
      }),
      row()
    );
    expect(u).toEqual({ tapLock: 'FIRES', giftRule: 'tapLock', fullCut: 'tapLock' });
  });

  it('お助け(suppressBandFx OFF)は増減規則を食うが、全面カットは殺さない', () => {
    const u = usageMap(
      cfg({
        fanStamp: {
          enabled: true,
          giftId: '5655',
          giftName: '',
          canonical: '',
          amountEach: -1,
          suppressBandFx: false,
          flash: false,
        },
        giftRules: [GR_ROW],
        giftFullCut: { enabled: true, volume: 70, rules: [FC_ROW] },
      }),
      row()
    );
    expect(u).toEqual({ fanStamp: 'FIRES', giftRule: 'fanStamp', fullCut: 'FIRES' });
  });

  it('お助け(suppressBandFx ON)は全面カットも抑止する', () => {
    const u = usageMap(
      cfg({
        fanStamp: {
          enabled: true,
          giftId: '5655',
          giftName: '',
          canonical: '',
          amountEach: -1,
          suppressBandFx: true,
          flash: false,
        },
        giftFullCut: { enabled: true, volume: 70, rules: [FC_ROW] },
      }),
      row()
    );
    expect(u).toEqual({ fanStamp: 'FIRES', fullCut: 'fanStamp' });
  });

  it('排他5機能どうしは先勝ち(お助けが最優先でお邪魔を食う)', () => {
    const u = usageMap(
      cfg({
        fanStamp: {
          enabled: true,
          giftId: '5655',
          giftName: '',
          canonical: '',
          amountEach: -1,
          suppressBandFx: false,
          flash: false,
        },
        tapLock: { enabled: true, rules: [TL_ROW] },
      }),
      row()
    );
    expect(u).toEqual({ fanStamp: 'FIRES', tapLock: 'fanStamp' });
  });
});

describe('worker との整合(ソース検査)', () => {
  it('worker の全面カット評価は「お助けの suppressBandFx が ON のときだけ null」の形のまま', () => {
    // この分岐の形が変わったら usagesOf の blockedBy モデルも同時に見直すこと。
    const src = readFileSync(resolve(__dirname, '../../src/worker/challenge.ts'), 'utf8');
    expect(src).toMatch(/fs\?\.suppressBandFx === true\s*\?\s*null\s*:\s*matchGiftFullCut/);
  });
});
