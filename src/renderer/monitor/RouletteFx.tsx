import { useEffect, useRef, useState } from 'react';
import { ROULETTE_REVEAL_MS, ROULETTE_SPIN_FAST_MS, ROULETTE_SPIN_MS } from '@shared/challenge';
import { num } from '@shared/format';

/**
 * ギフトルーレットの横並びブロックリール。
 *
 * MiniFx と同じ流儀: 形(DOM)はここ、動き(@keyframes rl-spin)は monitor.css。
 * 盤面と当選 index は effect に載ってきた自己完結の値を使う — モニターの設定は
 * 30秒ポーリングで古くなりうるので cfg からは読まない(dto.ts の規約)。
 *
 * リールは segments を SPIN_LOOPS 周ぶん横一列に並べたブロック列で、CSS 変数
 * --rl-shift(当選ブロックを窓の中央へ置く translateX)へ向けて減速する。
 * **窓の中央で止まったブロックが確定**という見せ方 — 抽選は worker で確定済みで、
 * ここは「もう決まった出目」をそれらしく見せるだけの演出装置。
 */

/**
 * ブロック1個のステップ幅(px)。monitor.css の .rl-block の幅+左右マージンの合計と
 * 一致させること — ズレると当選ブロックが窓の中央に止まらない。
 */
export const ROULETTE_BLOCK_W = 150;
/**
 * 着地までに流す周回数。4.3秒スピンでも間延びしないだけの移動距離を確保する
 * (既定盤面6件なら総移動 ≒ 35〜40ブロック ≒ 4,600px。ease-out で高速→減速)。
 */
const SPIN_LOOPS = 6;

export function RouletteFx({
  segments,
  index,
  amount,
  fast,
  nickname,
  giftIconUrl,
  onDone,
}: {
  /** 盤面(表示順の出目の絶対値)。effect.rouletteSegments。 */
  segments: number[];
  /** 当選 index。effect.rouletteIndex。 */
  index: number;
  /** 符号適用後の実増減量。正=妨害(赤)、負=応援(緑)。 */
  amount: number;
  /** キュー消化中の短縮スピン。 */
  fast: boolean;
  nickname?: string;
  giftIconUrl?: string;
  onDone: () => void;
}): React.JSX.Element {
  const [hit, setHit] = useState(false);
  const doneTimer = useRef<number | null>(null);
  // アンマウント(親の安全弁や reset)で reveal タイマーを残さない。
  useEffect(
    () => () => {
      if (doneTimer.current !== null) window.clearTimeout(doneTimer.current);
    },
    []
  );

  const n = segments.length;
  const targetBlock = SPIN_LOOPS * n + index;
  // 窓は3ブロックぶん。中央(2個目)に当選ブロックが止まるよう、1個ぶん手前まで送る。
  const shift = -(targetBlock - 1) * ROULETTE_BLOCK_W;
  const sign = amount < 0 ? '-' : '+';
  const bad = amount >= 0;
  // 最終周の当選ブロックの右にもう1個見えるので、周回+1 セットぶん描いておく。
  const blocks: number[] = [];
  for (let i = 0; i < SPIN_LOOPS + 2; i++) blocks.push(...segments);

  return (
    <div className={`roulette-panel ${bad ? 'bad' : 'good'}${hit ? ' hit' : ''}`}>
      <div className="rl-head">
        {giftIconUrl ? <img src={giftIconUrl} alt="" /> : <span>🎰</span>}
        <b>{nickname ?? ''}</b> がルーレット!
      </div>
      <div className="rl-window">
        <div
          className="roulette-reel"
          style={
            {
              '--rl-shift': `${shift}px`,
              '--rl-ms': `${fast ? ROULETTE_SPIN_FAST_MS : ROULETTE_SPIN_MS}ms`,
            } as React.CSSProperties
          }
          onAnimationEnd={(ev) => {
            // ブロック内の子アニメーションのバブリングで早期発火しないよう自分のだけ拾う。
            if (ev.target !== ev.currentTarget) return;
            setHit(true);
            doneTimer.current = window.setTimeout(onDone, ROULETTE_REVEAL_MS);
          }}
        >
          {blocks.map((v, i) => (
            <div key={i} className={i === targetBlock ? 'rl-block win' : 'rl-block'}>
              {sign}
              {num(v)}
            </div>
          ))}
        </div>
        <div className="rl-pointer rl-pointer-top">▼</div>
        <div className="rl-pointer rl-pointer-bottom">▲</div>
      </div>
    </div>
  );
}
