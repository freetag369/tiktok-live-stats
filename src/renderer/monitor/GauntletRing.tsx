import type { GauntletRingModel } from './gauntlet-ring';

/**
 * 最終ゲートの進捗リング(モーションアニメーション)。7セグを囲むスタジアム形の
 * トラックに ticks 個の目盛りを刻み、タップごとに 1 目盛りずつ点灯していく。
 *
 * 実装の要点:
 * - `.countdown` と同じグリッドセル(count)に**兄弟**として重ねる。pointer-events は
 *   CSS で殺してあるのでモニタータップの押下は素通しする。
 * - 目盛りは個別 DOM を作らない — `pathLength={ticks}` を張った角丸 rect 1本を
 *   stroke-dasharray で塗り分ける(ticks=999 でも要素数が増えない)。
 *   レイヤは下から: 消灯トラック → 点灯分(dasharray "lit rest") → 目盛りの
 *   区切り(背景色の短い dash を境界に重ね塗り)→ タップの脈動フラッシュ。
 * - 点灯分は **transition** で滑らせる。press の他窓配信は 80ms コアレス
 *   (CHALLENGE_PRESS_NUDGE_MS)なので lit は数個まとめて飛ぶことがある —
 *   目盛りが高速で埋まっていく追い付きアニメとして吸収する。
 * - 脈動は `key={lit}` の**再マウント**で毎タップ再生する(gauntlet-flash)。
 *   点灯レイヤ本体を再マウントすると transition が死ぬので、フラッシュ専用の
 *   別レイヤに分けてある。7セグの punchKey 方式(classList リプレイ)を使わないのは、
 *   このコンポーネントは lit のたびに再レンダーされる小さな SVG で、再マウントの
 *   コスト問題(数百セグの再構築)が当たらないため。
 * - ゲート完成(30到達)の破裂は担当外 — playEffect の press(finalGate 印)が
 *   fx engine(canvas)で撃つ。リングは次のゲートの 0 目盛りに戻るだけ。
 */
export function GauntletRing({ ring }: { ring: GauntletRingModel }): React.JSX.Element {
  const { ticks, lit } = ring;
  // 目盛り境界の区切り幅(パス長単位 = 1目盛りが長さ1)。目盛りが多いほど細く。
  const sep = Math.min(0.16, 8 / Math.max(ticks, 1) / 4);
  return (
    <div className="gauntlet-ring" data-gauntlet={`${lit}/${ticks}`}>
      <svg viewBox="0 0 560 300" preserveAspectRatio="xMidYMid meet" aria-hidden="true">
        {/* 消灯トラック(常時うっすら) */}
        <rect className="gr-track" x="14" y="14" width="532" height="272" rx="136" pathLength={ticks} />
        {/* 点灯分。dasharray の第1項が点灯長 — transition で滑る */}
        <rect
          className="gr-lit"
          x="14"
          y="14"
          width="532"
          height="272"
          rx="136"
          pathLength={ticks}
          style={{ strokeDasharray: `${lit} ${Math.max(0, ticks - lit)}` }}
        />
        {/* 目盛りの区切り — 背景色の短い dash を境界(整数位置)に重ね塗りして
            トラックと点灯分を同時に分節する。offset で dash の中心を境界に合わせる */}
        <rect
          className="gr-sep"
          x="14"
          y="14"
          width="532"
          height="272"
          rx="136"
          pathLength={ticks}
          style={{ strokeDasharray: `${sep} ${1 - sep}`, strokeDashoffset: sep / 2 }}
        />
        {/* タップの脈動 — lit が変わるたびに再マウントされて 1 回だけ光る */}
        {lit > 0 ? (
          <rect
            key={lit}
            className="gr-flash"
            x="14"
            y="14"
            width="532"
            height="272"
            rx="136"
            pathLength={ticks}
            style={{ strokeDasharray: `${lit} ${Math.max(0, ticks - lit)}` }}
          />
        ) : null}
      </svg>
    </div>
  );
}
