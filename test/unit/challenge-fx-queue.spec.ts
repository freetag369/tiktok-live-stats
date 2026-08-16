import { describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE, DEFAULT_GIFT_BAND_FX, GIFT_FX_FREEZE_MARGIN_MS } from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * ChallengeState.fxQueue — 凍結中(カットイン再生中)にワーカーの保留キューで
 * 待っている「演出付きイベント」の予告。
 *
 * 凍結中は effect が recentEffects に載らないため、モニターの演出ストック表示は
 * これが無いとカットイン連発の間だけ盲目になる(「ストックが出てない」の正体)。
 * 契約: カットイン級(band / boost / roulette)と **follow** が載る・値しか
 * 動かさない他の保留(press / like)は載らない・ドレインで消える・予告だけでも
 * delta が出る。
 *
 * 【仕様変更 2026-08-16】follow は以前「値だけ = 予告なし」だったが、凍結中の
 * フォローが配信者から完全に無反応に見える(「フォロー妨害が発生しない」誤認の
 * 一因)ため予告に載せる方針へ反転した。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定バンドを有効化(凍結を張る側のテストなので challenge.spec と逆の既定)。
  base.giftBandFx = structuredClone(DEFAULT_GIFT_BAND_FX);
  base.giftFullCut.enabled = false;
  return { ...base, enabled: true, ...over };
}

let seq = 0;

function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  return {
    kind: 'gift',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'g1', nickname: 'gifter' },
    giftId: '5655',
    giftName: 'Rose',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

function follow(userId = 'u1'): SocialEvent {
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: `viewer-${userId}` },
  };
}

function engine(c: ChallengeConfig, now: () => number): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, Math.random, Math.random, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

describe('ChallengeState.fxQueue — 凍結中の演出予告', () => {
  it('凍結中のバンドギフト/ルーレットに加えて follow も予告に載る(仕様変更)', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    expect(e.get().fxQueue).toBeUndefined(); // 平時はキーごと無い

    e.handleEvent(gift({ diamonds: 30 })); // band1 一致 → 6 秒凍結
    t += 1000;
    e.handleEvent(gift({ giftId: '8888', diamonds: 80 })); // 保留(band2 予告)
    e.handleEvent(follow('f1')); // 保留(follow 予告 — 1 effect = 1人なので count 無し)
    e.handleEvent(
      gift({
        giftId: '7934',
        giftName: 'Heart Me',
        repeatCount: 5,
        viewer: { userId: 'g2', nickname: 'まわす人' },
      })
    ); // 保留(ルーレット予告・5連 = ×5)

    const q = e.get().fxQueue;
    expect(q).toHaveLength(3);
    expect(q![0]).toMatchObject({ kind: 'band', nickname: 'gifter' });
    expect(q![1]).toMatchObject({ kind: 'follow', nickname: 'viewer-f1' });
    expect(q![1]!.count).toBeUndefined();
    // count はモニターの ×N(実際に回る本数 = rouletteReelCount)。
    expect(q![2]).toMatchObject({ kind: 'roulette', nickname: 'まわす人', count: 5 });
    // id は採番済みで相異なる(モニターの行キー = スライドアニメの同一性)。
    expect(new Set(q!.map((w) => w.id)).size).toBe(3);
  });

  it('予告だけの変化でも delta が出る(dirty が立つ)', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 1000 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    e.drainIfChanged(); // トリガーぶんの delta を掃く
    t += 1000;
    // 保留(値は動かない = handleEvent は false)でも、予告が積まれたら配る。
    expect(e.handleEvent(gift({ giftId: '8888', diamonds: 80 }))).toBe(false);
    const s = e.drainIfChanged();
    expect(s).not.toBeNull();
    expect(s!.fxQueue).toHaveLength(1);
  });

  it('ドレインで予告は消える(再凍結した次のバンドは自分の effect になっている)', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 1000 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1(6秒)
    t += 1000;
    e.handleEvent(gift({ giftId: '8888', diamonds: 80 })); // 保留(band2 予告)
    expect(e.get().fxQueue).toHaveLength(1);

    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS; // 期限到達
    e.drainIfChanged(); // 解除 → band2 が実行され再凍結
    const s = e.get();
    expect(s.fxQueue).toBeUndefined(); // 予告は空 = キーごと省く
    expect(s.recentEffects[0]).toMatchObject({ kind: 'gift', amount: 80 }); // effect 化済み
  });

  it('凍結中に stop しても予告は残らない', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 1000 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 }));
    t += 1000;
    e.handleEvent(gift({ giftId: '8888', diamonds: 80 }));
    expect(e.get().fxQueue).toHaveLength(1);
    e.stop(); // 強制適用(forceApplyPendingOps)
    expect(e.get().fxQueue).toBeUndefined();
  });
});
