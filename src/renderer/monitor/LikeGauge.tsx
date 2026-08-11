import { useEffect, useRef, useState } from 'react';
import type { ChallengeLikeGauge } from '@shared/dto';
import { num } from '@shared/format';
import type { FxEngine } from './fx/engine';

/**
 * いいね進捗ゲージ(◯いいねで +N の分子を見せる)。
 *
 * データは 2Hz の delta で届くため、幅は CSS transition(mbar と同カーブ)で
 * 滑らかに追従させる。満タン検出は counter の増減ではなく worker が持つ単調
 * カウンタ fills の前回比較で行う — counter は閾値跨ぎで「増えて見える」し
 * reset でも減るので、増減ヒューリスティックは誤発火する。
 *
 * 満タン演出の相:
 *   idle → fill(100% へ掃引)→ hold(バースト)→ snap(transition 無効で
 *   端数へ)→ double-rAF → idle(transition 復帰)
 * snap の width をコミットさせてから transition を戻さないと 100%→端数が
 * 逆方向にアニメーションしてしまう(rAF 1回ではコミット前に併合されうる)。
 * transitionend は幅が偶然一致すると発火せず相が固まるため使わない。
 */

type Phase = 'idle' | 'fill' | 'hold' | 'snap';

/** fill 相の長さ。CSS の width transition(0.4s)+コミット余白。 */
const FILL_MS = 420;
/** hold 相(白閃+バースト)の長さ。CSS の lg-burst と同じ。 */
const HOLD_MS = 300;

export function LikeGauge({
  gauge,
  fxRef,
  trackRef,
}: {
  gauge: ChallengeLikeGauge;
  fxRef: { current: FxEngine | null };
  /** 親(いいね吸い込みの着弾点)と共有するトラック要素の ref。 */
  trackRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const prevFills = useRef<number | null>(null);

  useEffect(() => {
    const f = gauge.fills;
    if (prevFills.current === null) {
      prevFills.current = f; // マウント採用 — 過去の満タンでは光らせない
      return;
    }
    if (f < prevFills.current) {
      prevFills.current = f; // worker 再起動の巻き戻り — 無音で追従
      return;
    }
    if (f > prevFills.current) {
      prevFills.current = f; // 複数ユニット同時越えでも1バーストに合体
      setPhase('fill');
    }
  }, [gauge.fills]);

  useEffect(() => {
    if (phase === 'fill') {
      const t = setTimeout(() => setPhase('hold'), FILL_MS);
      return () => clearTimeout(t);
    }
    if (phase === 'hold') {
      const fx = fxRef.current;
      const r = fx?.pointFor(trackRef.current);
      if (fx && r) fx.burstGauge(r.x + r.w / 2 - 14, r.y);
      const t = setTimeout(() => setPhase('snap'), HOLD_MS);
      return () => clearTimeout(t);
    }
    if (phase === 'snap') {
      let r2 = 0;
      const r1 = requestAnimationFrame(() => {
        r2 = requestAnimationFrame(() => setPhase('idle'));
      });
      return () => {
        cancelAnimationFrame(r1);
        if (r2 !== 0) cancelAnimationFrame(r2);
      };
    }
    return undefined;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const pct = gauge.every > 0 ? Math.min(100, (gauge.counter / gauge.every) * 100) : 0;
  const filling = phase === 'fill' || phase === 'hold';
  const displayPct = filling ? 100 : pct;
  // hold 中は state 上もう端数だが、見た目は「満タン到達」を出し切る。
  const shownCount = filling ? gauge.every : gauge.counter;
  const noAnim = phase === 'snap' ? { transition: 'none' } : undefined;

  return (
    <div className="like-gauge" data-phase={phase} data-hot={!filling && pct >= 85}>
      <div className="lg-track" ref={trackRef}>
        <i className="lg-fill" style={{ width: `${displayPct}%`, ...noAnim }}>
          <i className="lg-shimmer" />
        </i>
        <span className="lg-spark" style={{ left: `${displayPct}%`, ...noAnim }} />
        <i className="lg-flash" />
        <span className="lg-label">
          <span className="lg-heart">♥</span> {num(shownCount)} / {num(gauge.every)}
        </span>
        <span className="lg-reward">満タンで +{num(gauge.step)}</span>
      </div>
    </div>
  );
}
