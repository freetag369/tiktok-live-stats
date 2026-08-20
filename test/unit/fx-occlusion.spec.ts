/**
 * 着弾の遮蔽(occlusion)判定の凍結。2026-08-17 ユーザー決定:
 * 「いいねゲージ満杯・いいねストック満杯はキュー作動中も**後ろで**再生される。
 *   ルーレット中は後ろで少し見える、ギフト中・ブースト再生中は音だけ聞こえる」。
 *
 * ここで固定するのは、その要望がそのまま 3 行になった真理値表:
 * 1. 'opaque' なら見えるものは全部 false・se だけ残る(= 音だけ聞こえる状態)
 * 2. 'sheer' の plan は 'none' と fullClip 以外まったく同じ
 *    (「少し見える」は CSS の暗幕と DOM 順が作る — fx-backdrop.spec.ts が見張る)
 * 3. fullClip が真になるのは 'sheer' かつ clipsEnabled のときだけ
 */
import { describe, expect, it } from 'vitest';
import {
  fxImpactPlan,
  maxOcclusion,
  occlusionOfCutin,
  type FxCutinKind,
  type FxOcclusion,
} from '@shared/fx-occlusion';

const ALL: readonly FxOcclusion[] = ['none', 'sheer', 'opaque'];
const BOOLS = [false, true] as const;

describe('maxOcclusion — 濃いほうを採る順序束', () => {
  it('全 9 組を凍結する', () => {
    const rank: Record<FxOcclusion, number> = { none: 0, sheer: 1, opaque: 2 };
    for (const a of ALL)
      for (const b of ALL) {
        const expected = rank[a] >= rank[b] ? a : b;
        expect(maxOcclusion(a, b), `${a} vs ${b}`).toBe(expected);
      }
  });

  it('可換・冪等・結合的(畳み込みの順序に依存しない)', () => {
    for (const a of ALL) {
      expect(maxOcclusion(a, a)).toBe(a); // 冪等
      expect(maxOcclusion(a, 'none')).toBe(a); // 'none' は単位元
      for (const b of ALL) {
        expect(maxOcclusion(a, b)).toBe(maxOcclusion(b, a)); // 可換
        for (const c of ALL) {
          expect(maxOcclusion(maxOcclusion(a, b), c)).toBe(maxOcclusion(a, maxOcclusion(b, c)));
        }
      }
    }
  });

  it('opaque はどんな相手にも勝つ(ギフト+ルーレット同時でも音だけが守られる)', () => {
    for (const a of ALL) expect(maxOcclusion(a, 'opaque')).toBe('opaque');
  });
});

describe('occlusionOfCutin — カットイン種別 → 幕の濃さ', () => {
  it('ルーレットだけが半透明の暗幕、残りは不透明フルフレーム', () => {
    const table: Record<FxCutinKind, FxOcclusion> = {
      roulette: 'sheer',
      band: 'opaque',
      'stock-cutin': 'opaque',
      boost: 'opaque',
      revolution: 'opaque',
    };
    for (const [kind, expected] of Object.entries(table)) {
      expect(occlusionOfCutin(kind as FxCutinKind), kind).toBe(expected);
    }
  });
});

describe('fxImpactPlan — 何を出すかの真理値表(全 12 通り)', () => {
  it('12 通りすべてを凍結する', () => {
    for (const occ of ALL)
      for (const clipsEnabled of BOOLS)
        for (const seEnabled of BOOLS) {
          const visible = occ !== 'opaque';
          expect(fxImpactPlan(occ, { clipsEnabled, seEnabled }), `${occ}/${clipsEnabled}/${seEnabled}`).toEqual({
            shake: visible,
            particles: visible,
            mini: visible,
            strikeClip: visible && clipsEnabled,
            fullClip: occ === 'sheer' && clipsEnabled,
            se: seEnabled,
          });
        }
  });

  it('【要望1】opaque は「音だけ聞こえる状態」— 見えるものは全部止まり SE だけ残る', () => {
    for (const clipsEnabled of BOOLS)
      for (const seEnabled of BOOLS) {
        const p = fxImpactPlan('opaque', { clipsEnabled, seEnabled });
        expect(p.shake).toBe(false);
        expect(p.particles).toBe(false);
        expect(p.mini).toBe(false);
        expect(p.strikeClip).toBe(false);
        expect(p.fullClip).toBe(false);
        // SE は遮蔽に依存しない — ここを落とすと「音だけ」が「何も起きない」に退化する。
        expect(p.se).toBe(seEnabled);
      }
  });

  it('【要望2】sheer の plan は none と fullClip 以外まったく同じ(少し見えるのは CSS が作る)', () => {
    for (const clipsEnabled of BOOLS)
      for (const seEnabled of BOOLS) {
        const s = { clipsEnabled, seEnabled };
        const sheer = fxImpactPlan('sheer', s);
        const none = fxImpactPlan('none', s);
        expect({ ...sheer, fullClip: null }).toEqual({ ...none, fullClip: null });
      }
  });

  it('【要望3】fullClip が真になるのは sheer かつ clipsEnabled のときだけ', () => {
    for (const occ of ALL)
      for (const clipsEnabled of BOOLS)
        for (const seEnabled of BOOLS) {
          expect(fxImpactPlan(occ, { clipsEnabled, seEnabled }).fullClip).toBe(
            occ === 'sheer' && clipsEnabled
          );
        }
    // none で撃たないのが要点 — フルチェーン(launchStrike / launchStock)が
    // 既に全画面クリップを流す経路なので、ビート側で撃つと二重再生になる。
    expect(fxImpactPlan('none', { clipsEnabled: true, seEnabled: true }).fullClip).toBe(false);
    // opaque で撃たないのも要点 — 96% 不透明の下では見えないのに clipQueue を食い、
    // カットイン明けに SE も着弾も伴わない演出が遅れて漏れる。
    expect(fxImpactPlan('opaque', { clipsEnabled: true, seEnabled: true }).fullClip).toBe(false);
  });

  it('動画マスタースイッチ(fxClipsEnabled)off でもクリップ以外と SE は生きる', () => {
    const p = fxImpactPlan('sheer', { clipsEnabled: false, seEnabled: true });
    expect(p.strikeClip).toBe(false);
    expect(p.fullClip).toBe(false);
    expect(p.shake).toBe(true);
    expect(p.particles).toBe(true);
    expect(p.se).toBe(true);
  });
});
