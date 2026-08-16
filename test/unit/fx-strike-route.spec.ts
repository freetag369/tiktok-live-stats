/**
 * 着弾(strike)の経路決定の凍結。2026-08-16 ユーザー決定:
 * 「いいねゲージ着弾・いいねストック着弾はキューに入れず常時実行」。
 *
 * ここで固定するのは3点:
 * 1. 真理値表そのもの(全組み合わせ)。
 * 2. **入力に stageBusy が存在しない** — バナーは着弾を止めない。
 * 3. **'defer'(舞台待ち)という出力が存在しない** — 4値のどれもが「即時に
 *    何かが起きる」経路(coalesce も終端直結で必ず即再生される)。
 */
import { describe, expect, it } from 'vitest';
import { routeStrike, type StrikeRoute, type StrikeRouteInput } from '@shared/fx-strike-route';

function input(over: Partial<StrikeRouteInput>): StrikeRouteInput {
  return {
    hasFill: true,
    running: true,
    chainFlying: false,
    cutinActive: false,
    cutinImminent: false,
    ...over,
  };
}

describe('routeStrike — 着弾の経路決定(真理値表の凍結)', () => {
  it('全組み合わせ(2^5)を凍結する', () => {
    const bools = [false, true];
    for (const hasFill of bools)
      for (const running of bools)
        for (const chainFlying of bools)
          for (const cutinActive of bools)
            for (const cutinImminent of bools) {
              const s = { hasFill, running, chainFlying, cutinActive, cutinImminent };
              const expected: StrikeRoute =
                !hasFill || !running
                  ? 'none'
                  : chainFlying
                    ? 'coalesce'
                    : cutinActive || cutinImminent
                      ? 'beat'
                      : 'chain';
              expect(routeStrike(s), JSON.stringify(s)).toBe(expected);
            }
  });

  it('着弾なし・停止中は none(従来の値のみパンチ経路)', () => {
    expect(routeStrike(input({ hasFill: false }))).toBe('none');
    expect(routeStrike(input({ running: false }))).toBe('none');
    // 停止中はカットインが居ても beat を撃たない(status !== running で演出しない従来規約)。
    expect(routeStrike(input({ running: false, cutinActive: true }))).toBe('none');
  });

  it('chainFlying が cutin 系より優先 — ストックカットイン中は coalesce', () => {
    // ストックカットインは strikeTimers を握ったまま hold を取る(startStockCutin)。
    // beat に倒すと自分のチェーンと二重に鳴る — 合算して終端直結で1本にする。
    expect(routeStrike(input({ chainFlying: true, cutinActive: true }))).toBe('coalesce');
    expect(routeStrike(input({ chainFlying: true, cutinImminent: true }))).toBe('coalesce');
  });

  it('カットイン中/直前は beat(据え置きの持ち主に触らない visuals-only 即時)', () => {
    expect(routeStrike(input({ cutinActive: true }))).toBe('beat');
    expect(routeStrike(input({ cutinImminent: true }))).toBe('beat');
  });

  it('それ以外は chain — バナー表示中でもフルチェーンを張る(stageBusy は入力に無い)', () => {
    expect(routeStrike(input({}))).toBe('chain');
    // 入力の形そのものを凍結 — stageBusy / bannerActive のようなキーを後から
    // 足して「バナー待ち」を復活させたら、このテストが構造の変化を検知する。
    const keys = Object.keys(input({})).sort();
    expect(keys).toEqual(['chainFlying', 'cutinActive', 'cutinImminent', 'hasFill', 'running']);
  });

  it("'defer' という出力は存在しない(全経路が即時)", () => {
    const seen = new Set<StrikeRoute>();
    const bools = [false, true];
    for (const hasFill of bools)
      for (const running of bools)
        for (const chainFlying of bools)
          for (const cutinActive of bools)
            for (const cutinImminent of bools)
              seen.add(routeStrike({ hasFill, running, chainFlying, cutinActive, cutinImminent }));
    expect([...seen].sort()).toEqual(['beat', 'chain', 'coalesce', 'none']);
  });
});
