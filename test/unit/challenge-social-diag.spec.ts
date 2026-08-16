import { describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE, DEFAULT_GIFT_BAND_FX, GIFT_FX_FREEZE_MARGIN_MS } from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent, SocialEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * フォロー妨害の診断ログ([challenge/social])。
 *
 * gift は [challenge/gift] が実配信で数千行残るのに follow は 0 行で、
 * 「フォロー妨害が発生しない」の切り分けが DB 直読みでしか出来なかった —
 * その非対称を埋めた socialDiag の契約を固定する。
 *
 * 頻度の契約: 適用と凍結保留は1行/件(gift と同オーダー)。重複スキップと
 * followStep<=0 は洪水になる(実測 455件/h 級)ので、初回は即時1行・以降は
 * 60 秒ごとの要約1行に畳む。
 */

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

let seq = 0;

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 凍結を張るテストのために既定バンドを有効化(challenge-fx-queue.spec と同じ)。
  base.giftBandFx = structuredClone(DEFAULT_GIFT_BAND_FX);
  base.giftFullCut.enabled = false;
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
    giftId: '5655',
    giftName: 'Rose',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

function follow(userId: string, nickname?: string): SocialEvent {
  return {
    kind: 'social',
    sub: 'follow',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId, nickname: nickname ?? `viewer-${userId}` },
  };
}

/** diag をスパイする engine(setMonitorOpen/setFxCaps の焼き込みは規約)。 */
function engine(
  c: ChallengeConfig,
  now: () => number
): { e: ChallengeEngine; social: () => string[] } {
  const lines: string[] = [];
  const e = new ChallengeEngine(() => c, now, Math.random, Math.random, (m) => lines.push(m));
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return { e, social: () => lines.filter((l) => l.includes('[challenge/social]')) };
}

describe('socialDiag — フォロー妨害の診断ログ', () => {
  it('即時経路の適用は1行/件(値と nick が読める)', () => {
    const { e, social } = engine(cfg({ initialValue: 100, followStep: 10 }), () => NOW);
    e.start();
    expect(e.handleEvent(follow('a', 'たろう'))).toBe(true);
    const lines = social();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('適用 +10');
    expect(lines[0]).toContain('たろう');
    expect(lines[0]).toContain('値 110');
  });

  it('重複スキップは初回だけ即時、以降は 60 秒ごとの要約に畳む', () => {
    let t = NOW;
    const { e, social } = engine(cfg({ initialValue: 100, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(follow('a'));
    expect(social()).toHaveLength(1); // 適用

    e.handleEvent(follow('a')); // 重複1回目 → 即時に要約1行(×1)
    expect(social()).toHaveLength(2);
    expect(social()[1]).toContain('重複スキップ ×1');

    e.handleEvent(follow('a'));
    e.handleEvent(follow('a'));
    e.handleEvent(follow('a')); // 60秒以内は無言でカウントだけ
    expect(social()).toHaveLength(2);

    t = NOW + 61_000;
    e.handleEvent(follow('a')); // 窓明けの到達でまとめて1行(溜めた3+これ1=×4)
    expect(social()).toHaveLength(3);
    expect(social()[2]).toContain('重複スキップ ×4');
  });

  it('followStep=0 は値も統計も動かさず、要約で必ず痕跡を残す', () => {
    let t = NOW;
    const { e, social } = engine(cfg({ initialValue: 100, followStep: 0 }), () => t);
    e.start();
    expect(e.handleEvent(follow('a'))).toBe(false);
    expect(e.handleEvent(follow('b'))).toBe(false); // 60秒以内 → 無言でカウント
    expect(e.get().value).toBe(100);
    expect(e.get().stats.follows).toBe(0);
    const lines = social();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('followStep=0 のため無効 ×1');

    t = NOW + 61_000;
    e.handleEvent(follow('c'));
    expect(social()).toHaveLength(2);
    expect(social()[1]).toContain('×2');
  });

  it('凍結中は「保留」を残し、ドレインで「適用」と「合算」が出る', () => {
    let t = NOW;
    const { e, social } = engine(cfg({ initialValue: 1000, followStep: 10 }), () => t);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1 一致 → 6 秒凍結
    t += 1000;
    e.handleEvent(follow('a'));
    e.handleEvent(follow('b'));
    let lines = social();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('凍結中 → 保留 +10');
    expect(lines.some((l) => l.includes('適用'))).toBe(false); // まだ値に入っていない

    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    e.drainIfChanged(); // 凍結解除 → 保留2件が適用され、finishDrain が1件に畳む
    lines = social();
    expect(lines.filter((l) => l.includes('適用 +10'))).toHaveLength(2);
    const merged = lines.filter((l) => l.includes('凍結明け合算 follow ×2'));
    expect(merged).toHaveLength(1);
    expect(merged[0]).toContain('+20');
  });

  it('チャレンジ非実行中は1行も出ない(giftDiag と同じ生存条件)', () => {
    const { e, social } = engine(cfg({ followStep: 10 }), () => NOW);
    e.handleEvent(follow('a')); // start 前
    expect(social()).toHaveLength(0);
  });
});
