import { describe, expect, it } from 'vitest';
import {
  CHALLENGE_EFFECTS_MAX,
  DEFAULT_CHALLENGE,
  EFFECT_FRESH_MS,
  TEST_EFFECT_FRESH_MS,
  freshChallengeEffects,
  isChallengeEffectFresh,
} from '@shared/challenge';
import type { ChallengeConfig, ChallengeEffect } from '@shared/dto';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function fx(id: number, over: Partial<ChallengeEffect> = {}): ChallengeEffect {
  return { id, kind: 'press', amount: -1, valueAfter: 100, atMs: NOW, ...over };
}

describe('freshChallengeEffects — 演出 watermark の共有規約', () => {
  it('マウント直後(lastPlayed=null)は全件を再生済みに倒す', () => {
    const r = freshChallengeEffects([fx(3), fx(2), fx(1)], null, NOW);
    expect(r.next).toBe(3);
    expect(r.play).toEqual([]);
  });

  it('マウント直後でも mountPlaysTest なら鮮度内の test 演出は再生する(▶ 実演の取りこぼし防止)', () => {
    const effects = [fx(3, { test: true, atMs: NOW - 3000 }), fx(2), fx(1)];
    const r = freshChallengeEffects(effects, null, NOW, { mountPlaysTest: true });
    expect(r.next).toBe(3);
    expect(r.play.map((e) => e.id)).toEqual([3]); // 非 test の 1,2 は倒したまま
  });

  it('mountPlaysTest でも古すぎる test 演出は再生しない', () => {
    const effects = [fx(1, { test: true, atMs: NOW - TEST_EFFECT_FRESH_MS - 1 })];
    const r = freshChallengeEffects(effects, null, NOW, { mountPlaysTest: true });
    expect(r.play).toEqual([]);
  });

  it('mountPlaysTest 無し(ダッシュボード)は test 演出も倒す', () => {
    const r = freshChallengeEffects([fx(1, { test: true, atMs: NOW })], null, NOW);
    expect(r.play).toEqual([]);
  });

  it('通常進行: watermark より新しい鮮度内の演出だけを id 昇順で返す', () => {
    const effects = [fx(5), fx(4, { atMs: NOW - EFFECT_FRESH_MS - 1 }), fx(3), fx(2)];
    const r = freshChallengeEffects(effects, 3, NOW);
    expect(r.next).toBe(5);
    expect(r.play.map((e) => e.id)).toEqual([5]); // 4 は鮮度ゲート超過、2,3 は再生済み
  });

  it('test 演出は通常進行でも 15 秒の緩いゲートで再生される', () => {
    const effects = [fx(2, { test: true, atMs: NOW - EFFECT_FRESH_MS - 1 })];
    const r = freshChallengeEffects(effects, 1, NOW);
    expect(r.play.map((e) => e.id)).toEqual([2]);
  });

  it('watermark は後退しない — 古いスナップショットが後着しても再生し直さない', () => {
    // press RPC の返り値(setChallenge が即時反映)が、あとから来た delta より後に
    // 着弾する逆転。かつてはこれを「worker 再起動で id が振り直された」と誤検知して
    // 0 に倒し、リング内の鮮度ゲート内 effect を丸ごと再生し直していた
    // (= ルーレット/ギフトが贈られた個数を超えて再生される主因)。
    const effects = [fx(2), fx(1)];
    const r = freshChallengeEffects(effects, 100, NOW);
    expect(r.play).toEqual([]);
    expect(r.next).toBe(100); // 下げない
  });

  it('worker 再起動の追従は呼び出し側の lastPlayed=null で行う(workerEpoch)', () => {
    // 再起動直後は「全件再生済みに倒す」— そのあとの新しい id が普通に再生される。
    const first = freshChallengeEffects([fx(2), fx(1)], null, NOW);
    expect(first.next).toBe(2);
    expect(first.play).toEqual([]);
    const second = freshChallengeEffects([fx(3), fx(2), fx(1)], first.next, NOW);
    expect(second.play.map((e) => e.id)).toEqual([3]);
  });

  it('リング溢れ(1 delta に上限+1件以上)は古い方から欠番になるが、watermark は前進し新しい分は再生される', () => {
    // 仕様の文書化: recentEffects は CHALLENGE_EFFECTS_MAX(12)件のリングなので、
    // 500ms の delta 間に 13 件以上積まれると古い方が renderer に届かない。
    // 「値だけ適用して演出は捨てる」意図的設計 — 演出が出ない調査の際は
    // まずこの欠番(id の飛び)と fxWarn ログを疑う。
    const n = CHALLENGE_EFFECTS_MAX;
    // watermark=0 から、id 2..n+1 だけが残った(id 1 が溢れた)状況。
    const effects = Array.from({ length: n }, (_, i) => fx(n + 1 - i)); // [n+1, n, ..., 2]
    const r = freshChallengeEffects(effects, 0, NOW);
    expect(r.next).toBe(n + 1);
    // 残っている n 件は全部再生される(欠番 id:1 はそもそも配られない)。
    expect(r.play.map((e) => e.id)).toEqual(Array.from({ length: n }, (_, i) => i + 2));
  });

  it('空配列でも壊れない — reset 直後でも watermark は下げない', () => {
    expect(freshChallengeEffects([], null, NOW)).toEqual({ next: 0, play: [] });
    // reset で recentEffects は消えるが worker の id カウンタは続く(nextEffectId は
    // start/stop/reset でリセットされない)。据え置きで正しく、次の effect は必ず
    // watermark を越えて再生される。0 に倒すと、直後に古いスナップショットが後着した
    // ときにリング内が丸ごと再生され直す。
    expect(freshChallengeEffects([], 5, NOW)).toEqual({ next: 5, play: [] });
  });
});

describe('isChallengeEffectFresh — 鮮度述語(yieldToCutin と freshChallengeEffects の共有規約)', () => {
  it('通常演出は 5 秒ちょうどまで新鮮、1ms でも過ぎたら古い', () => {
    expect(isChallengeEffectFresh(fx(1, { atMs: NOW - EFFECT_FRESH_MS }), NOW)).toBe(true);
    expect(isChallengeEffectFresh(fx(1, { atMs: NOW - EFFECT_FRESH_MS - 1 }), NOW)).toBe(false);
  });

  it('test 演出は 15 秒の緩いゲート', () => {
    expect(isChallengeEffectFresh(fx(1, { test: true, atMs: NOW - TEST_EFFECT_FRESH_MS }), NOW)).toBe(true);
    expect(isChallengeEffectFresh(fx(1, { test: true, atMs: NOW - TEST_EFFECT_FRESH_MS - 1 }), NOW)).toBe(false);
  });
});

describe('ChallengeEngine.testEffect — gauge-full の実演', () => {
  function cfg(): ChallengeConfig {
    const base = structuredClone(DEFAULT_CHALLENGE);
    return { ...base, enabled: true };
  }

  it('値・統計を変えずに test 付きの gauge-full effect を積む', () => {
    const c = cfg();
    const en = new ChallengeEngine(() => c, () => NOW);
    const before = en.get();
    en.testEffect({ kind: 'gauge-full' });
    const after = en.get();
    expect(after.value).toBe(before.value);
    expect(after.stats).toEqual(before.stats);
    const e = after.recentEffects[0]!;
    expect(e.kind).toBe('gauge-full');
    expect(e.test).toBe(true);
    expect(e.amount).toBe(Math.max(1, c.likeStep));
    // モニターのラッチ表示(valueAfter - amount)が現在値に一致する契約。
    expect(e.valueAfter - e.amount).toBe(after.value);
  });
});
