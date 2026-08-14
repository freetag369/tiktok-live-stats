import { useEffect, useRef, useState } from 'react';
import type { ChallengeLikeGauge } from '@shared/dto';
import { dripCommitNeeded } from '@shared/challenge';
import { num } from '@shared/format';
import type { FxEngine } from './fx/engine';

/**
 * いいね進捗ゲージ(◯いいねで +N の分子を見せる)。
 *
 * データは 2Hz の delta で届き、しかも TikTok はいいねをバッチで送ってくる
 * (LikeEvent.count が 15 など)。素の counter をそのまま出すと 0→15→30 と飛ぶので、
 * idle 中は表示用の分子 drip を cubic ease-out の時間補間で追いつかせる(滴下)—
 * 速く始まってゆっくり止まるスコアカウンターの動き。CSS transition は tick 間を
 * 潰さない程度の追従だけを担当する(monitor.css の data-phase='idle' 参照)。
 *
 * 満タン検出は counter の増減ではなく worker が持つ単調カウンタ fills の前回比較で
 * 行う — counter は閾値跨ぎで「増えて見える」し reset でも減るので、増減
 * ヒューリスティックは誤発火する。滴下側も同じ理由で counter の減少を単独では信じない。
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
 * 1バッチ分のカウントアップ尺。ease-out でこの時間内に必ず追いつく。
 * DELTA_MS(500)より短いので遅れを次のバッチへ繰り越さず、
 * FILL_MS + HOLD_MS(720)より短いので満タン演出中に持ち越しが残ることもない。
 */
const DRIP_MS = 450;
/**
 * 表示更新の間隔。イージングの評価は時刻ベースなので、tick が遅れても
 * 追いつきの保証(DRIP_MS)は崩れない。28ms(36Hz)から 48ms(≈20Hz)へ —
 * DRIP_MS=450 内に9ステップ入り ease-out の見た目は保たれる。加えて
 * dripCommitNeeded の量子化で「表示が動かない tick」は setState 自体を省く。
 */
const DRIP_TICK_MS = 48;

/** 動きの抑制設定。MonitorView の同名関数と同じ(あちらは module private で、
 *  import すると MonitorView → LikeGauge と循環するため複製している)。 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

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

/**
 * ストックドット1個。点灯中は区間1位のアバターを描き、URL 無し・読込失敗・
 * アバター表示 OFF では従来の緑グラデ(.lgs-dot.on)がそのまま見える。
 * <i> コンテナを維持するので lgs-pop/charge/burst と drain の transitionDelay は
 * 全部そのまま効き、stockRowRef(FX 発射点)の矩形も変わらない。
 */
function StockDot({ on, url, delay }: { on: boolean; url: string | null; delay?: string }): React.JSX.Element {
  // 読込失敗のラッチ。URL が変わったら再挑戦する(common.tsx の Avatar と同じ流儀)。
  const [failed, setFailed] = useState(false);
  const prevUrl = useRef(url);
  if (prevUrl.current !== url) {
    prevUrl.current = url;
    if (failed) setFailed(false);
  }
  const showImg = on && url !== null && !failed;
  return (
    <i
      className={`lgs-dot${on ? ' on' : ''}${showImg ? ' has-avatar' : ''}`}
      style={delay ? { transitionDelay: delay } : undefined}
    >
      {showImg ? (
        <img
          className="lgs-avatar"
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      ) : null}
    </i>
  );
}

export function LikeGauge({
  gauge,
  fxRef,
  trackRef,
  stockRowRef,
  showAvatars,
}: {
  gauge: ChallengeLikeGauge;
  fxRef: { current: FxEngine | null };
  /** 親(いいね吸い込みの着弾点)と共有するトラック要素の ref。 */
  trackRef: React.RefObject<HTMLDivElement | null>;
  /** 親(ストック満杯の弾の発射点)と共有するドット行の ref。 */
  stockRowRef: React.RefObject<HTMLDivElement | null>;
  /** cfg.loadAvatars。OFF ならドットは従来の緑丸のまま。 */
  showAvatars: boolean;
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

  /**
   * 表示用の分子(滴下値・小数許容)。idle 中だけ gauge.counter を追いかけ、
   * それ以外の相では素の counter に張り付く — idle 復帰時にゼロ距離で再開でき、
   * snap の transition:'none' と表示権を取り合わない。バーは小数のまま使い、
   * 数字は floor で整数にする(render 側)。
   */
  const [drip, setDrip] = useState(gauge.counter);
  const dripRef = useRef(gauge.counter);
  /** setDrip で最後に commit した値(量子化スキップの基準)。 */
  const dripShown = useRef(gauge.counter);
  const dripTimer = useRef(0);
  /** 補間のアンカー(開始値・開始時刻・目標)。バッチが重なったら現在値から張り直す。 */
  const dripFrom = useRef(gauge.counter);
  const dripStart = useRef(0);
  const dripTarget = useRef(gauge.counter);
  /** 滴下側の fills 前回値。相マシンの prevFills とは共有しない — あちらは先に
   *  走る effect で更新済みなので、読むと effect の宣言順が仕様になってしまう。 */
  const dripFills = useRef<number | null>(null);
  const dripEvery = useRef(gauge.every);

  /** 滴下を止めて表示を即時同期する。アンカーも揃えて補間の残骸を消す。 */
  function adoptDrip(v: number): void {
    if (dripTimer.current) {
      clearTimeout(dripTimer.current);
      dripTimer.current = 0;
    }
    dripRef.current = v;
    dripFrom.current = v;
    dripTarget.current = v;
    dripShown.current = v;
    setDrip(v);
  }

  /**
   * 滴下1歩 — 時刻ベースの quadratic ease-out 補間。速く始まってゆっくり止まる
   * (スコアカウンターの動き)ので、等間隔で 1 ずつ刻むより連打が自然に見える。
   * cubic だと序盤に距離の半分を 90ms で消化してしまい +5 ずつ飛んで見えた
   * (実測)ので、一段浅い 2 乗にしてある。増分ではなく経過時間から現在値を
   * 引くため、バックログ量によらず必ず DRIP_MS で追いつき、tick の遅延
   * (タブ非表示等)でも到達時刻はズレない。
   */
  function dripStep(): void {
    dripTimer.current = 0;
    const t = Math.min(1, (Date.now() - dripStart.current) / DRIP_MS);
    const e = 1 - (1 - t) ** 2;
    const v = dripFrom.current + (dripTarget.current - dripFrom.current) * e;
    dripRef.current = v;
    if (t >= 1) {
      // 到達(v は厳密に target の整数)— 量子化に関わらず必ず commit する。
      // 「必ず DRIP_MS で追いつく」契約はここが守る。次の増加で effect が再点火。
      dripShown.current = v;
      setDrip(v);
      return;
    }
    // 表示(数字の floor / バー幅の 0.25% 刻み)が動かない中間 tick は setState を
    // 省く — いいねが流れ続ける配信で LikeGauge + 全ドットの常時再レンダーを
    // 積まないため(dripCommitNeeded のコメント参照)。
    if (dripCommitNeeded(dripShown.current, v, dripEvery.current)) {
      dripShown.current = v;
      setDrip(v);
    }
    dripTimer.current = window.setTimeout(dripStep, DRIP_TICK_MS);
  }

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

  // 滴下の司令塔。判定順がそのまま仕様なので入れ替えないこと。
  useEffect(() => {
    const f = gauge.fills;
    const prevF = dripFills.current;
    const prevEvery = dripEvery.current;
    dripFills.current = f;
    dripEvery.current = gauge.every;

    // fill/hold/snap は表示が固定(100% / 端数)。素の counter に張り付かせておく。
    if (phase !== 'idle') return adoptDrip(gauge.counter);
    // マウント採用 / worker 再起動の巻き戻り / 分母変更 — fills と同じ3点規約で無音追従。
    if (prevF === null || f < prevF || gauge.every !== prevEvery) return adoptDrip(gauge.counter);
    // 満タン跨ぎ。counter は端数へ落ちているが、この commit の phase はまだ 'idle'
    // (上の effect の setPhase は同じフラッシュ内では見えない)。ここで追従すると
    // バーが 92%→8% と逆走してから 100% へ掃引してしまうので、drip は据え置く。
    if (f > prevF) {
      if (dripTimer.current) {
        clearTimeout(dripTimer.current);
        dripTimer.current = 0;
      }
      return;
    }
    // reset / 再 start による 0 復帰。減らす向きの滴下は「いいねを取り消された」
    // ように見えるので即時(ストックドットの減少と同じ扱い)。
    if (gauge.counter < dripRef.current) return adoptDrip(gauge.counter);
    if (gauge.counter === dripRef.current) return;
    if (prefersReducedMotion()) return adoptDrip(gauge.counter);

    // 現在の表示値から新目標へ張り直す。補間中に次のバッチが来たら、そこまでの
    // 到達点を新しい起点にする — 連続流入時は 500ms ごとにサージが重なる動きになる。
    dripFrom.current = dripRef.current;
    dripStart.current = Date.now();
    dripTarget.current = gauge.counter;
    if (!dripTimer.current) dripTimer.current = window.setTimeout(dripStep, DRIP_TICK_MS);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gauge.counter, gauge.fills, gauge.every, phase]);

  // 連鎖を止めるのはアンマウントの時だけ。依存配列の cleanup に置くと delta ごとに
  // 切れて張り直され、期限(dripDeadline)の割り付けが毎回リセットされてしまう。
  useEffect(
    () => () => {
      if (dripTimer.current) clearTimeout(dripTimer.current);
    },
    []
  );

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

  const filling = phase === 'fill' || phase === 'hold';
  // 分子の権威は相ごとに1つだけ: fill/hold は「満タン到達」を出し切る(state 上は
  // もう端数)/ snap は端数へハード同期 / idle は滴下値。
  // バーは小数のままなめらかに、数字は floor で整数カウントアップにする。
  const shownFloat = filling ? gauge.every : phase === 'snap' ? gauge.counter : drip;
  const shownCount = Math.floor(shownFloat);
  const pct = gauge.every > 0 ? Math.min(100, (shownFloat / gauge.every) * 100) : 0;
  const displayPct = filling ? 100 : pct;
  const noAnim = phase === 'snap' ? { transition: 'none' } : undefined;

  const stock = gauge.stock;
  // charge/burst 中は「満杯到達」を出し切る(ゲージの shownCount と同じ思想)。
  const litCount = sphase === 'charge' || sphase === 'burst' ? (stock?.count ?? 0) : shownFilled;
  const draining = sphase === 'drain';
  // ドット i のアバターURL。worker は満杯処理を1 delta 内で完結させるので、満杯
  // シーケンス(arm/charge/burst)中の stock.slots は既に消費済み — 消費一式の
  // スナップショット lastFullSlots から引く(arm は litCount がまだ旧値だが、
  // lastFullSlots の先頭は直前まで表示していたスロットと同一なので絵は変わらない)。
  const slotUrlFor = (i: number): string | null => {
    if (!showAvatars) return null;
    const inFullSeq = sphase === 'arm' || sphase === 'charge' || sphase === 'burst';
    const slot = inFullSeq ? (stock?.lastFullSlots?.[i] ?? stock?.slots?.[i]) : stock?.slots?.[i];
    return slot?.avatarUrl ?? null;
  };

  return (
    <div
      className="like-gauge"
      data-phase={phase}
      data-hot={!filling && pct >= 85}
      data-empty={displayPct <= 0}
    >
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
              <StockDot
                key={i}
                on={i < litCount}
                url={slotUrlFor(i)}
                delay={draining ? `${i * 40}ms` : undefined}
              />
            ))}
          </span>
          <span className="lgs-label">満杯で +{num(stock.step)}</span>
        </div>
      ) : null}
    </div>
  );
}
