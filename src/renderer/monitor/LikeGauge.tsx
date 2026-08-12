import { useEffect, useRef, useState } from 'react';
import type { ChallengeLikeGauge } from '@shared/dto';
import { num } from '@shared/format';
import type { FxEngine } from './fx/engine';

/**
 * いいね進捗ゲージ(◯いいねで +N の分子を見せる)。
 *
 * データは 2Hz の delta で届くため、幅は CSS transition(MoveTowards 相当のカーブ)で
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

/**
 * ストック満杯シーケンスの相:
 *   idle → arm(満杯検出済み。ゲージの hold 到達で charge へ)→ charge(全点灯+
 *   脈動)→ burst(白閃)→ drain(順次消灯)→ idle
 * charge の長さは MonitorView の2段着弾チェーン(1段目着弾 → STOCK_PAUSE_MS →
 * 弾発射 → 着弾)の所要時間の目安。フレーム精度の同期は不要 — 数字の正しさは
 * MonitorView 側のタイマーが独立に保証する(FILL_MS ↔ STRIKE_LAUNCH_MS と同じ思想)。
 */
type StockPhase = 'idle' | 'arm' | 'charge' | 'burst' | 'drain';

/** charge の長さ。≒ 1段目 travel(260-420)+ STOCK_PAUSE_MS(450)+ 2段目 travel。 */
const STOCK_CHARGE_MS = 1100;
/** burst(白閃)の長さ。CSS の lgs-burst と同じ。 */
const STOCK_BURST_MS = 300;
/** drain(順次消灯)の長さ。ドット数 × transitionDelay 40ms + 余白。 */
const STOCK_DRAIN_MS = 700;

export function LikeGauge({
  gauge,
  fxRef,
  trackRef,
  stockRowRef,
}: {
  gauge: ChallengeLikeGauge;
  fxRef: { current: FxEngine | null };
  /** 親(いいね吸い込みの着弾点)と共有するトラック要素の ref。 */
  trackRef: React.RefObject<HTMLDivElement | null>;
  /** 親(ストック満杯の弾の発射点)と共有するドット行の ref。 */
  stockRowRef: React.RefObject<HTMLDivElement | null>;
}): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle');
  const prevFills = useRef<number | null>(null);
  const [sphase, setSphase] = useState<StockPhase>('idle');
  /** ドット点灯数の表示コミット値。増加はゲージ hold で pop、減少(reset)は即時。 */
  const [shownFilled, setShownFilled] = useState<number>(gauge.stock?.filled ?? 0);
  const prevStockFills = useRef<number | null>(null);
  /** hold 相待ちの点灯コミット(満杯に至らない増加)。 */
  const pendingFilled = useRef<number | null>(null);
  /** タイマー系 effect の閉包が古い stock を掴まないための最新値。 */
  const stockRef = useRef(gauge.stock);
  stockRef.current = gauge.stock;

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

  // ストックの表示更新。fills(満杯累計)は likeFills と同じ3点規約:
  // マウント採用 / 巻き戻り追従(worker 再起動)/ 増分のみ満杯シーケンス発火。
  useEffect(() => {
    const s = gauge.stock;
    if (!s) {
      // 設定で無効化された — 行ごと消えるので表示状態も畳む。
      prevStockFills.current = null;
      pendingFilled.current = null;
      setShownFilled(0);
      setSphase('idle');
      return;
    }
    const sf = s.fills;
    if (prevStockFills.current === null) {
      prevStockFills.current = sf; // マウント採用 — 過去の満杯では光らせない
      setShownFilled(s.filled);
      return;
    }
    if (sf < prevStockFills.current) {
      prevStockFills.current = sf; // worker 再起動の巻き戻り — 無音で追従
      setShownFilled(s.filled);
      return;
    }
    if (sf > prevStockFills.current) {
      prevStockFills.current = sf; // 複数ユニット同時越えでも1シーケンスに合体
      setSphase('arm'); // ゲージの hold 到達(バーストの瞬間)で charge へ
      return;
    }
    // fills 不変で filled だけ動いた: 増加(点灯)はゲージ hold で pop させ、
    // 減少(reset)は即時反映する。満杯シーケンス中は drain 側が確定させる。
    if (sphase === 'idle') {
      if (s.filled < shownFilled) setShownFilled(s.filled);
      else if (s.filled > shownFilled) pendingFilled.current = s.filled;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gauge.stock, gauge.stock?.fills, gauge.stock?.filled]);

  // ゲージの hold(バーストの瞬間)に同期してドットを動かす。
  useEffect(() => {
    if (phase !== 'hold') return;
    if (pendingFilled.current !== null) {
      setShownFilled(pendingFilled.current);
      pendingFilled.current = null;
    }
    setSphase((p) => (p === 'arm' ? 'charge' : p));
  }, [phase]);

  // ストック満杯シーケンスのタイマー遷移。
  useEffect(() => {
    if (sphase === 'arm') {
      // 保険 — hold を取りこぼしても(タブ非表示等)必ず前へ進む。
      const t = setTimeout(() => setSphase('charge'), FILL_MS + HOLD_MS);
      return () => clearTimeout(t);
    }
    if (sphase === 'charge') {
      const t = setTimeout(() => setSphase('burst'), STOCK_CHARGE_MS);
      return () => clearTimeout(t);
    }
    if (sphase === 'burst') {
      const t = setTimeout(() => {
        // 満杯後の端数(通常 0、複数ユニット跨ぎなら残り)を確定させて消灯へ。
        setShownFilled(stockRef.current?.filled ?? 0);
        pendingFilled.current = null;
        setSphase('drain');
      }, STOCK_BURST_MS);
      return () => clearTimeout(t);
    }
    if (sphase === 'drain') {
      const t = setTimeout(() => setSphase('idle'), STOCK_DRAIN_MS);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [sphase]);

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

  const stock = gauge.stock;
  // charge/burst 中は「満杯到達」を出し切る(ゲージの shownCount と同じ思想)。
  const litCount = sphase === 'charge' || sphase === 'burst' ? (stock?.count ?? 0) : shownFilled;
  const draining = sphase === 'drain';

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
      {stock ? (
        <div className="lg-stock" data-sphase={sphase} ref={stockRowRef}>
          <span className="lgs-dots">
            {Array.from({ length: stock.count }, (_, i) => (
              <i
                key={i}
                className={`lgs-dot${i < litCount ? ' on' : ''}`}
                style={draining ? { transitionDelay: `${i * 40}ms` } : undefined}
              />
            ))}
          </span>
          <span className="lgs-label">満杯で +{num(stock.step)}</span>
        </div>
      ) : null}
    </div>
  );
}
