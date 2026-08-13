import { useEffect, useRef, useState } from 'react';
import type { RoulettePattern } from '@shared/dto';
import { rouletteHeadline, rouletteRevealMs, rouletteSpinMs } from '@shared/challenge';
import {
  ROULETTE_BLOCK_GAP,
  ROULETTE_BLOCK_W,
  ROULETTE_KICK_AT,
  ROULETTE_NEAR_STOP_AT,
  ROULETTE_SPIN_SE_END_AT,
  ROULETTE_TARGET_BLOCK,
  rouletteRun,
  rouletteStrip,
} from '@shared/roulette-fx';
import { num } from '@shared/format';

/**
 * ギフトルーレットの横並びブロックリール。
 *
 * MiniFx と同じ流儀: 形(DOM)はここ、動き(@keyframes)は monitor.css。
 * 盤面と当選 index は effect に載ってきた自己完結の値を使う — モニターの設定は
 * 30秒ポーリングで古くなりうるので cfg からは読まない(dto.ts の規約)。
 * 幾何(並べ方・走行距離)は shared/roulette-fx.ts の純関数から取る(テスト可能)。
 *
 * **窓の中央で止まったブロックが確定**という見せ方 — 抽選は worker で確定済みで、
 * ここは「もう決まった出目」をそれらしく見せるだけの演出装置。
 *
 * ── 結果を先に見せないための約束 ─────────────────────────────────────────
 * - 当選ブロックの目印(.win)と符号(+/-)は **.hit が付くまで DOM に出さない**。
 *   旧実装は当選ブロックにマウント時点から色が付いており、減速して近づいてくる
 *   「一番緊張してほしい瞬間」に答えが見えていた。
 * - 終盤は窓の左右を覆い(.rl-veil)、隣のブロックを読ませない。パターン3の
 *   キックは、暗がりから当選ブロックが蹴り出されてくる見せ方になる。
 * - 走行距離も着地位置も index に依存しない(roulette-fx.ts の解説を参照)。
 */

/** キックの効果音を鳴らすまでの猶予。CSS の rl-run-kick の予備動作の入りと揃える。 */
function kickDelayMs(spinMs: number): number {
  return Math.round(spinMs * ROULETTE_KICK_AT);
}

export function RouletteFx({
  segments,
  index,
  amount,
  fast,
  pattern,
  seed,
  nickname,
  rouletteLabel,
  giftName,
  giftIconUrl,
  onNearStop,
  onKick,
  onSpinQuiet,
  onDone,
}: {
  /** 盤面(表示順の出目の絶対値)。effect.rouletteSegments。 */
  segments: number[];
  /** 当選 index。effect.rouletteIndex。 */
  index: number;
  /** 符号適用後の実増減量。正=妨害(赤)、負=応援(緑)。確定まで表に出さない。 */
  amount: number;
  /** キュー消化中の短縮スピン。段の演出は入らず単調減速になる。 */
  fast: boolean;
  /** 終盤の演出パターン。effect.roulettePattern。 */
  pattern: RoulettePattern;
  /** 走行距離のジッタの種。effect.id — 抽選結果とは無関係。 */
  seed: number;
  nickname?: string;
  /** 見出しの前置き(設定の label)。effect.rouletteLabel。 */
  rouletteLabel?: string;
  /** label 未設定のときの前置きのフォールバック。effect.giftName。 */
  giftName?: string;
  giftIconUrl?: string;
  /**
   * 「止まりそう」の瞬間(当選の1つ手前に着いて溜めに入るところ)。全パターン共通で
   * 1スピンにつき1回だけ呼ぶ。呼び出し側がスイッチ音を足す。短縮スピンでは呼ばない
   * (段が無く、鳴らすと確定音とほぼ同時になる)。
   */
  onNearStop?: () => void;
  /** キックの瞬間(パターン3のみ)。呼び出し側が衝撃音と揺れを足す。 */
  onKick?: () => void;
  /**
   * 回転ループ音を止めてよい時刻(終盤の段に入るところ)。保持やフェイク停止で
   * リールが止まって見えるのにカラカラ鳴り続けると錯覚が音で割れるため、
   * リール停止(onDone)より前に来る。冪等に扱うこと — 保険で停止時にも呼ぶ。
   */
  onSpinQuiet?: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const [hit, setHit] = useState(false);
  const timers = useRef<number[]>([]);
  /**
   * 完了をちょうど1回にするラッチ。リールに付くアニメーションは1本だけだが、
   * 将来2本目を足すと animationend は本数ぶん発火する(target は毎回リール自身
   * なので target 判定を素通りする)。onDone が二重に走ると finishRoulette が
   * 2回走り、次のスピンの安全弁まで消してしまう。
   */
  const done = useRef(false);
  // アンマウント(親の安全弁や reset)でタイマーを残さない。
  useEffect(
    () => () => {
      for (const t of timers.current) window.clearTimeout(t);
      timers.current = [];
    },
    []
  );

  const spinMs = rouletteSpinMs(fast);
  // 短縮スピンは段の演出を入れない。保持やフェイク停止は 900ms に物理的に入らず、
  // 入れると「止まりかけて再加速する」カクつきになるだけ(通常スピンとは別尺の
  // キーフレームを当てる)。
  const key = fast ? 'fast' : pattern;
  const strip = rouletteStrip(segments, index);
  const run = rouletteRun(seed, segments.length, fast);
  const shift = -(ROULETTE_TARGET_BLOCK - 1) * ROULETTE_BLOCK_W;
  const sign = amount < 0 ? '-' : '+';
  const bad = amount >= 0;
  const head = rouletteHeadline({ rouletteLabel, giftName });

  function finish(): void {
    if (done.current) return;
    done.current = true;
    // fast(段なし)はここが最初の quiet。他パターンでは既に鳴り止んでいる(冪等)。
    onSpinQuiet?.();
    setHit(true);
    timers.current.push(window.setTimeout(onDone, rouletteRevealMs(fast)));
  }

  // 「止まりそう」の合図・キックの衝撃音・回転ループ音の消灯。壁時計とアニメーション時計はフレームが
  // 出ない窓ではズレるが、音が数十 ms 前後するだけで破綻はしない(完了検知は
  // animationend が本線)。
  useEffect(() => {
    // 「止まりそう」。fast は段が無いので番兵 1 で弾かれる。
    const nearAt = ROULETTE_NEAR_STOP_AT[key];
    if (onNearStop && nearAt < 1) {
      timers.current.push(window.setTimeout(onNearStop, Math.round(spinMs * nearAt)));
    }
    if (key === 'kick' && onKick) {
      timers.current.push(window.setTimeout(onKick, kickDelayMs(spinMs)));
    }
    // 終盤の段に入るところでループ音を閉じる(fast は 1 = finish に任せる)。
    const quietAt = ROULETTE_SPIN_SE_END_AT[key];
    if (onSpinQuiet && quietAt < 1) {
      timers.current.push(window.setTimeout(onSpinQuiet, Math.round(spinMs * quietAt)));
    }
    // マウント時に1回だけ。key/spinMs はこのマウントの間ずっと不変。タイマーは
    // 共有の timers 配列に積むのでアンマウント時の一括 cleanup が回収する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className={`roulette-panel ${bad ? 'bad' : 'good'}${hit ? ' hit' : ''}`}>
      <div className="rl-head">
        {giftIconUrl ? <img src={giftIconUrl} alt="" /> : <span>🎰</span>}
        {/* .rl-head は flex(gap 8px)なので、区切りの空白は CSS 側に任せて trim する。 */}
        {head.prefix !== '' ? <span className="rl-gift">{head.prefix.trim()}</span> : null}
        <b>{nickname ?? ''}</b>
        {head.suffix}
      </div>
      <div
        className={`rl-window rl-p-${key}`}
        style={
          {
            '--rl-w': `${ROULETTE_BLOCK_W}px`,
            '--rl-gap': `${ROULETTE_BLOCK_GAP}px`,
            '--rl-shift': `${shift}px`,
            '--rl-run': `${run}`,
            '--rl-ms': `${spinMs}ms`,
          } as React.CSSProperties
        }
      >
        <div className="rl-zoom">
          <div
            className="roulette-reel"
            onAnimationEnd={(ev) => {
              // ブロック内の子アニメーション(確定発光)のバブリングで早期発火しない
              // よう自分のだけ拾い、さらに走行アニメ本体の名前で絞る。
              if (ev.target !== ev.currentTarget) return;
              if (!ev.animationName.startsWith('rl-run-')) return;
              finish();
            }}
          >
            {strip.map((v, i) => (
              // 目印はここでは付けない — 付けた瞬間に答えが DOM と画面に出る。
              <div key={i} className={hit && i === ROULETTE_TARGET_BLOCK ? 'rl-block win' : 'rl-block'}>
                {hit && i === ROULETTE_TARGET_BLOCK ? <span className="rl-sign">{sign}</span> : null}
                {num(v)}
              </div>
            ))}
          </div>
        </div>
        {/* 終盤に左右を覆って隣のブロックを読ませない目隠し。 */}
        <div className="rl-veil" />
        <div className="rl-pointer rl-pointer-top">▼</div>
        <div className="rl-pointer rl-pointer-bottom">▲</div>
      </div>
    </div>
  );
}
