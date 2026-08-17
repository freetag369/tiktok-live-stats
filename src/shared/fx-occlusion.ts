/**
 * 着弾(いいねゲージ満杯 / いいねストック満杯)の**遮蔽 (occlusion)** 判定。
 *
 * 【背景 — 2026-08-17 ユーザー決定】満杯・ストック満杯は
 * 「キュー作動中も**後ろで**演出が再生される」。見え方は被さっている幕で決まる:
 *
 *   - ルーレット中(半透明の暗幕)      → 後ろで**少し見える**   = 'sheer'
 *   - ギフト全面カット / 帯域カットイン /
 *     ストック着弾カットイン / ブースト   → **音だけ聞こえる**     = 'opaque'
 *   - 何も被さっていない                  → 従来どおりフル演出     = 'none'
 *
 * 【重要 — この判定が JS 側で作れるもの/作れないもの】
 * 「後ろで少し見える」を作っているのは **JS ではなく CSS と DOM 順**である。
 * `.fx-clip` / `.fx-strike` は `.monitor-root` 直下・z-index なしに置かれ、
 * `.roulette-screen`(`rgba(5, 3, 10, 0.8)` の半透明暗幕・`.fx-layer` z-index:50 の中)の
 * 下に来るので、放っておけば約 20% 透けて見える。だから `'sheer'` の plan は
 * `'none'` と **`fullClip` 以外まったく同じ**で正しい — ここで opacity を下げる等の
 * 小細工をすると `mix-blend-mode: screen` が壊れて黒い矩形になる
 * (monitor.css:1343-1348 の警告を参照)。
 *
 * 逆に **`'opaque'` では JS 側の抑制が必須**。粒子 canvas(`.fx-canvas`)・照明
 * (`.flash`)・簡易演出(`.mini`)は `.fx-layer`(z-index:50)の中にあり、
 * `.monitor-root` 直下・z-index なしの `.fx-clip-opaque`(opacity .96)より
 * **必ず手前**に描かれる。黙らせなければ「音だけ」にならず、動画の上に光が漏れる。
 * 構造の凍結は test/unit/fx-backdrop.spec.ts。
 *
 * shared に置くのは fx-strike-route.ts / fx-stage.ts / fx-drain.ts と同じ理由 —
 * レンダラのテスト環境がこのリポジトリに無いので、判定は純関数として node の
 * vitest で凍結する。
 */

/** 着弾の上に被さっている幕の濃さ。'none' < 'sheer' < 'opaque'。 */
export type FxOcclusion = 'none' | 'sheer' | 'opaque';

/** 濃い順の並び(添字が大きいほど濃い)。 */
const OCCLUSION_ORDER = ['none', 'sheer', 'opaque'] as const satisfies readonly FxOcclusion[];

/**
 * 濃いほうを採る(順序束の join)。可換・冪等・結合的。
 *
 * 同一デルタに複数のカットインが相乗りしたとき、**先勝ちで畳んではいけない** —
 * ルーレットとギフト帯域が同時に来ると `'sheer'` に倒れて「ギフト中は音だけ」が
 * 破れる。畳み込みは必ずこの関数で行うこと。
 */
export function maxOcclusion(a: FxOcclusion, b: FxOcclusion): FxOcclusion {
  return OCCLUSION_ORDER.indexOf(a) >= OCCLUSION_ORDER.indexOf(b) ? a : b;
}

/** 据え置きを持つカットインの種別(MonitorView の 4 ホールドと 1 対 1)。 */
export type FxCutinKind = 'roulette' | 'band' | 'stock-cutin' | 'boost';

/**
 * カットイン種別 → 遮蔽。ルーレットだけが半透明の暗幕で、残り 3 種は
 * 不透明フルフレーム(`.fx-clip-opaque` = opacity .96 + `background:#000`)。
 */
export function occlusionOfCutin(kind: FxCutinKind): FxOcclusion {
  return kind === 'roulette' ? 'sheer' : 'opaque';
}

/** 着弾演出のうち「何を出すか」。false のものは撃たない。 */
export interface FxImpactPlan {
  /** 画面全体の揺れ(pushShake)。`.monitor-root` に掛かるのでカットイン動画ごと揺れる。 */
  shake: boolean;
  /** 粒子(ringWave / sparkBurst / heartBurst)。`.fx-layer` の中 = 不透明動画より手前。 */
  particles: boolean;
  /** 簡易演出(playMini)。同上。 */
  mini: boolean;
  /** 着弾クリップ `.fx-strike`(7セグ位置・screen 合成)。 */
  strikeClip: boolean;
  /** 全画面クリップ `.fx-clip`(gauge-full / stock-full)。 */
  fullClip: boolean;
  /** 着弾効果音(gauge-burst / stock-burst)。**遮蔽では絶対に落とさない**。 */
  se: boolean;
}

export interface FxImpactPlanInput {
  /** cfg.challenge.fxClipsEnabled(動画のマスタースイッチ)。 */
  clipsEnabled: boolean;
  /** cfg.challenge.seEnabled。 */
  seEnabled: boolean;
}

/**
 * 遮蔽と設定から「何を出すか」を決める。**ユーザー要望の 3 行がそのまま出る**:
 *
 * - `'opaque'` → 見えるものは全部 false・`se` だけ残る = **音だけ聞こえる状態**
 * - `'sheer'`  → `'none'` と `fullClip` 以外同一(暗幕越しに全部見える)
 * - `'none'`   → 従来どおり(1 バイトも挙動を変えない)
 *
 * `fullClip` が `'sheer'` 限定なのは重要な安全策。`playClip` の既定は `'queue'` で
 * 上限 `CLIP_QUEUE_MAX = 3`、帯域カットインは最長 45 秒あるので、`'opaque'` でも
 * 積むと **カットイン明けに SE も着弾も伴わない満タン演出が数秒〜十数秒遅れて漏れる**。
 * かといって `'restart'` で割り込むのは「再生中の演出は中断しない」(fx-priority.ts)の
 * 規約違反。96% 不透明の下では見えないのだから、撃たないのが正解。
 *
 * `se` が遮蔽に依存しないのは、useChallengeSe が `gauge-full` / `stock-full` を常に
 * null にしており(二重再生の防止)、モニターの着弾処理が**唯一の発音点**だから。
 * ここを黙らせると「音だけ」が「何も起きない」に退化する。
 */
export function fxImpactPlan(occ: FxOcclusion, s: FxImpactPlanInput): FxImpactPlan {
  const visible = occ !== 'opaque';
  return {
    shake: visible,
    particles: visible,
    mini: visible,
    strikeClip: visible && s.clipsEnabled,
    fullClip: occ === 'sheer' && s.clipsEnabled,
    se: s.seEnabled,
  };
}
