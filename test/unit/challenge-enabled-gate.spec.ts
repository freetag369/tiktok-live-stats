import { describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { NormalizedEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

/**
 * 「チャレンジ機能 OFF」が本当に OFF であること。
 *
 * v0.7.3 まで `challenge.enabled` を見ていたのは①グローバルホットキーの登録
 * (main/index.ts)②ダッシュボードのカード表示(LiveDashboard.tsx)の2箇所だけで、
 * **エンジンは素通しだった**。そのため OFF にしても、
 *   - モニター窓を開いていればクリック / Space で数字が減り、
 *   - ギフト・いいね・フォローの妨害は数字を動かし続けた。
 * 「使っていないのに勝手に動く」状態で、企画をやめた配信でも背面モニターが
 * 数字を書き換えていた。入力の入口2つ(handleEvent / press)で塞ぐ。
 *
 * **塞がないもの**: testEffect と、press 冒頭のテスト実演(testBoost)タップ計数。
 * 設定画面の「▶ モニター」は有効化する前に演出を見て決めるための機能なので、
 * OFF のまま動かなければ設定作業そのものができない。
 */
const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
let seq = 0;

function cfg(enabled: boolean, over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.tapBoost.enabled = false;
  base.fanStamp.enabled = false;
  base.roulettes = [];
  return { ...base, enabled, initialValue: 1000, pressStep: 1, followStep: 10, ...over };
}

function engine(c: ChallengeConfig): ChallengeEngine {
  const e = new ChallengeEngine(() => c, () => NOW, () => 0, () => 0, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

function ev(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  seq += 1;
  return {
    kind: 'gift',
    tsMs: NOW,
    msgId: `m${seq}`,
    viewer: { userId: `u${seq}`, nickname: `u${seq}` },
    giftId: '5655',
    giftName: 'Rose',
    diamonds: 25,
    repeatCount: 1,
    ...over,
  } as NormalizedEvent;
}

describe('enabled=false — 入力の入口を塞ぐ', () => {
  it('press で数字が動かない(モニターのクリック / Space / ホットキーの実体)', () => {
    const e = engine(cfg(false));
    e.start();
    e.press();
    e.press();
    expect(e.get().value).toBe(1000);
    expect(e.get().stats.presses).toBe(0);
  });

  it('ギフトの妨害が入らない', () => {
    const e = engine(cfg(false));
    e.start();
    expect(e.handleEvent(ev({ diamonds: 25 }))).toBe(false);
    expect(e.get().value).toBe(1000);
  });

  it('フォローの妨害が入らない', () => {
    const e = engine(cfg(false));
    e.start();
    expect(e.handleEvent(ev({ kind: 'social', sub: 'follow' }))).toBe(false);
    expect(e.get().value).toBe(1000);
    expect(e.get().stats.follows).toBe(0);
  });

  it('いいねの妨害が入らない', () => {
    const e = engine(cfg(false, { likeEvery: 1, likeStep: 1 }));
    e.start();
    expect(e.handleEvent(ev({ kind: 'like', count: 5 }))).toBe(false);
    expect(e.get().value).toBe(1000);
  });

  it('コメントの妨害が入らない', () => {
    const rules = [{ id: 'c1', keyword: 'ぬるぽ', amount: 5 }];
    const off = engine(cfg(false, { commentRules: rules }));
    off.start();
    const comment = ev({ kind: 'comment', content: 'ぬるぽ', isQuestion: false });
    expect(off.handleEvent(comment)).toBe(false);
    expect(off.get().value).toBe(1000);

    // 同じイベントが ON では効くことも確かめる — 「一致しないから false」で
    // 通ってしまう偽の合格を防ぐ。
    const on = engine(cfg(true, { commentRules: rules }));
    on.start();
    expect(on.handleEvent(ev({ kind: 'comment', content: 'ぬるぽ', isQuestion: false }))).toBe(true);
    expect(on.get().value).toBe(1005);
  });

  it('フォローの重複判定を消費しない — ONに戻した後の初回がちゃんと数える', () => {
    const c = cfg(false);
    const e = engine(c);
    e.start();
    const follow = ev({ kind: 'social', sub: 'follow' });
    e.handleEvent(follow);
    expect(e.get().value).toBe(1000);

    // 配信中に設定を ON へ。同じ人の**別の**フォローは妨害として効く。
    c.enabled = true;
    expect(e.handleEvent(ev({ kind: 'social', sub: 'follow' }))).toBe(true);
    expect(e.get().value).toBe(1010);
  });
});

describe('enabled=false — 塞がないもの', () => {
  it('testEffect は流れる(設定画面の「▶ モニター」)', () => {
    const e = engine(cfg(false));
    e.testEffect({ kind: 'press' });
    const s = e.get();
    expect(s.recentEffects.some((x) => x.kind === 'press')).toBe(true);
    // 実演は値も統計も動かさない(enabled とは無関係の既存規約)。
    expect(s.value).toBe(1000);
    expect(s.stats.presses).toBe(0);
  });

  it('状態操作(start / stop / reset / toggleRank)は通る', () => {
    const e = engine(cfg(false));
    expect(e.start().status).toBe('running');
    expect(e.toggleRank().rankBoard).toBeDefined();
    expect(e.stop().status).toBe('idle');
    expect(e.reset().value).toBe(1000);
  });
});

describe('enabled=true — 従来どおり動く(回帰の網)', () => {
  it('press もギフトもフォローも効く', () => {
    const e = engine(cfg(true));
    e.start();
    e.press();
    expect(e.get().value).toBe(999);
    e.handleEvent(ev({ diamonds: 25 }));
    expect(e.get().value).toBe(1024);
    e.handleEvent(ev({ kind: 'social', sub: 'follow' }));
    expect(e.get().value).toBe(1034);
  });

  it('配信中に OFF へ切り替えると、その場で数字が動かなくなる', () => {
    const c = cfg(true);
    const e = engine(c);
    e.start();
    e.press();
    expect(e.get().value).toBe(999);

    c.enabled = false;
    e.onConfigChanged();
    e.press();
    e.handleEvent(ev({ diamonds: 25 }));
    expect(e.get().value).toBe(999);
  });
});
