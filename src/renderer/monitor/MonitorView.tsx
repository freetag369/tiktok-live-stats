import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, ChallengeEffect, ChallengeRankRow } from '@shared/dto';
import {
  CHALLENGE_RESULT_TOP_N,
  ROULETTE_ABORT_MS,
  ROULETTE_QUEUE_MAX,
  effectiveSeVolume,
  matchGiftClip,
  matchGiftMini,
  miniForSlot,
  tierForDiamonds,
} from '@shared/challenge';
import { num } from '@shared/format';
import { rpc, useQuery } from '../ipc/client';
import { liveRows, setChallenge, useLive } from '../state/liveStore';
import { Avatar } from '../components/common';
import { useChallengeSe } from '../lib/useChallengeSe';
import { ACHIEVED_CLIP_URL, GAUGE_FULL_CLIP_URL, STOCK_FULL_CLIP_URL, STRIKE_CLIP_URL, fxClipUrl } from '../lib/fx';
import { playSe } from '../lib/se';
import { playBandBgm, type BgmHandle } from '../lib/bgm';
import { MiniFx } from './MiniFx';
import { RouletteFx } from './RouletteFx';
import { SevenSeg } from './SevenSeg';
import { LikeGauge } from './LikeGauge';
import { FxCanvas } from './fx/FxCanvas';
import type { FxEngine } from './fx/engine';

/**
 * 背面モニター画面(縦型フルスクリーン想定)。
 *
 * 構成(上から): 企画タイトル / 7セグ残数 / いいね進捗ゲージ / 配信時間 /
 * ギフトランキング TOP3。FxLayer が照明フラッシュ・紙吹雪・±N 浮上を重ねる。
 *
 * 演出は ChallengeState.recentEffects(id 単調増加)を watermark 方式で冪等再生
 * する。マウント直後は全 effect を再生済みに倒す — リロード/再接続のたびに過去
 * 演出が一斉再生される事故を防ぐ。
 */

interface FloatItem {
  key: number;
  /** 表示内容。ギフトカード等のリッチな中身も入るので文字列に限定しない。 */
  node: React.ReactNode;
  cls: string;
}
interface FlashItem {
  key: number;
  cls: string;
}
/** 再生中の演出クリップ。同時に1本だけ — 後から来たギフトが前を打ち切る。 */
interface ClipItem {
  key: number;
  url: string;
}
/**
 * 再生中のダイヤ帯域カットイン(不透明フルフレーム)。screen 合成の ClipItem とは
 * 別枠 — 素材が黒背景発光体ではないので .fx-clip-opaque で重ねる。尺は素材ではなく
 * durationMs(worker の凍結時間と同期)が権威で、loop + タイマーで打ち切る。
 */
interface BandClipItem {
  key: number;
  url: string;
  durationMs: number;
  /** 終端フェード(.out)。フラグを分けるのは video の key を保ったまま付けるため。 */
  out: boolean;
}
/** 再生中の簡易演出。クリップとは独立に1つだけ持つ(併用できる)。 */
interface MiniItem {
  key: number;
  id: string;
  amount: number;
  /** ステージ座標での中心と一辺(7セグの矩形から決める)。 */
  x: number;
  y: number;
  size: number;
}

/** 着弾クリップ。全画面の ClipItem とは別枠で持つ — ギフト演出と食い合わせない。 */
interface StrikeClipItem {
  key: number;
  /** ステージ座標での左上(transform を使わず left/top で置くため中心から引いた値)。 */
  x: number;
  y: number;
  size: number;
}

let fxKey = 0;

/*
 * いいねゲージ満タン → 数字への「着弾」シーケンス。
 *
 * worker は likeFills と value を同じ tick で進めるので、両方が同一の 2Hz デルタで
 * 届く。素直に描くと「数字が増える」→ 0.72 秒後に「ゲージが光る」となり因果が逆に
 * 見える。そこで着弾の瞬間まで数字の表示を据え置き、ゲージ満タン → 弾が飛ぶ →
 * 数字に当たって増える、の順に組み替える。
 *
 * STRIKE_LAUNCH_MS は LikeGauge の FILL_MS と一致していなければならない
 * (ズレるとゲージが満タンになる前/後に弾が出る)。
 */
const STRIKE_LAUNCH_MS = 420;
/**
 * 弾の飛翔時間。fx.strike と着弾タイマーに同じ値を渡すので、数字が変わる瞬間と
 * 弾の到達はフレーム単位で一致する。飛距離で決めるのは縦横で距離が倍以上違うため
 * (縦は約 340px、横は約 700px)。固定値にすると横だけ弾が速すぎて何が飛んだか読めない。
 */
const STRIKE_TRAVEL_MS = 300;
const STRIKE_TRAVEL_MIN_MS = 260;
const STRIKE_TRAVEL_MAX_MS = 420;
/** 飛翔速度 px/ms。この値で距離を割って飛翔時間にする。 */
const STRIKE_SPEED = 1.15;
/** 安全弁。バックグラウンドタブの setTimeout 抑制などで着弾が来なくても必ず解除する。 */
const STRIKE_ABORT_MS = 1400;
/**
 * ストック満杯を伴うときの1段目着弾 → 2発目発射までの間。LikeGauge のドット行の
 * charge 脈動(STOCK_CHARGE_MS)はこの間+飛翔時間を覆う長さになっている —
 * フレーム精度の同期は不要(数字の正しさはここのタイマーが独立に保証する)。
 */
const STOCK_PAUSE_MS = 450;
/**
 * 2段着弾時の安全弁。固定 1400ms のままだと2段目の着弾前に flushStrike が発火して
 * ボーナスが演出より先に数字へ出る(因果逆転)。
 * ≒ LAUNCH(420) + travel_max(420) + PAUSE(450) + travel_max(420) + 余白。
 */
const STRIKE_ABORT_STOCK_MS = 2600;

/** 動きの抑制設定。true ならラッチごとスキップし、数字は従来どおり即時更新する。 */
function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 固定ステージの設計解像度。レイアウトは全てこの座標系の px で組み、
 * ウィンドウには transform: scale() で丸ごと収める(OBS のキャンバスと同じ方式)。
 * ビューポート単位で組むと横長ディスプレイや小窓で 7 セグがはみ出すため。
 * 縦画面は 9:16、横画面は 16:9 の別ステージ(2カラム)を使い、黒帯の余白を出さない。
 */
const STAGE_W = 540;
const STAGE_H = 960;
const STAGE_LW = 1280;
const STAGE_LH = 720;

/** CLEAR 演出(フラッシュ/紙吹雪/クリップ)を見せてからリザルトへ切り替えるまで。 */
const RESULT_DELAY_MS = 2500;

function elapsedText(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const p = (n: number) => String(n).padStart(2, '0');
  return `${Math.floor(s / 3600)}時${p(Math.floor((s % 3600) / 60))}分${p(s % 60)}秒`;
}

/**
 * リザルトのランキング1列。行の枠は常に TOP_N 件ぶん描く — 参加者が少ない
 * ときにレイアウトが跳ねない(既存の TOP3 と同じ考え方)。
 */
function ResultList({
  title,
  rows,
  kind,
  showAvatars,
}: {
  title: string;
  rows: ChallengeRankRow[];
  kind: 'gift' | 'like';
  showAvatars: boolean;
}): React.JSX.Element {
  return (
    <section className={`rs-col rs-${kind}`}>
      <h2 className="rs-head">{title}</h2>
      <ol className="rs-list">
        {Array.from({ length: CHALLENGE_RESULT_TOP_N }, (_, i) => {
          const r = rows[i];
          return (
            <li key={r?.userId ?? `ph-${kind}-${i}`} className={`rs-row p${i + 1}${r ? '' : ' empty'}`}>
              <span className="rs-place">{i + 1}</span>
              {r ? (
                <>
                  <Avatar url={r.avatarUrl} name={r.nickname || '?'} size={56} enabled={showAvatars} />
                  <span className="rs-name">{r.nickname || '名無し'}</span>
                  <span className="rs-val">{kind === 'gift' ? `${num(r.diamonds)}💎` : `${num(r.likes)}♥`}</span>
                </>
              ) : (
                <span className="rs-dash">—</span>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

export function MonitorView(): React.JSX.Element {
  const { challenge, totals, sessionId, version } = useLive();
  const [cfg, setCfg] = useState<AppSettings | null>(null);
  const [scale, setScale] = useState(1);
  const [landscape, setLandscape] = useState(false);

  useEffect(() => {
    const fit = (): void => {
      const land = window.innerWidth > window.innerHeight;
      const w = land ? STAGE_LW : STAGE_W;
      const h = land ? STAGE_LH : STAGE_H;
      setLandscape(land);
      setScale(Math.min(window.innerWidth / w, window.innerHeight / h));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);

  // 演出レイヤの揮発状態(store は汚さない)。
  const lastPlayed = useRef<number | null>(null);
  const [floats, setFloats] = useState<FloatItem[]>([]);
  const [flashes, setFlashes] = useState<FlashItem[]>([]);
  const [clip, setClip] = useState<ClipItem | null>(null);
  const [strikeClip, setStrikeClip] = useState<StrikeClipItem | null>(null);
  const [mini, setMini] = useState<MiniItem | null>(null);
  const [shake, setShake] = useState<{ key: number; cls: string } | null>(null);
  // 粒子演出(紙吹雪・火花・光線)は canvas エンジンに任せる。
  const fxRef = useRef<FxEngine | null>(null);
  const countdownRef = useRef<HTMLDivElement | null>(null);
  const gaugeTrackRef = useRef<HTMLDivElement | null>(null);
  /** ストック満杯の弾の発射点(LikeGauge のドット行)。 */
  const stockRowRef = useRef<HTMLDivElement | null>(null);

  // CLEAR リザルト。演出を見せてから切り替えるので state で遅らせる。
  const [showResult, setShowResult] = useState(false);
  const hasResult = challenge?.status === 'achieved' && challenge.result != null;

  useEffect(() => {
    if (!hasResult) {
      setShowResult(false);
      return;
    }
    // 達成後に開き直したモニターは待たずに出す(achievedMs が過去なので残り 0)。
    const wait = Math.max(0, RESULT_DELAY_MS - (Date.now() - (challenge?.achievedMs ?? 0)));
    if (wait === 0) {
      setShowResult(true);
      return;
    }
    const t = setTimeout(() => setShowResult(true), wait);
    return () => clearTimeout(t);
    // 依存は boolean と数値だけ — 2Hz で同じ result が再配信されてもタイマーは再起動しない。
  }, [hasResult, challenge?.achievedMs]);

  // 数字パンチ: 値が変わるたびに key を進めてアニメーションを再生する。
  // 方向(減=進捗/増=妨害)でグローの色と動きを変える。
  const prevValue = useRef<number | null>(null);
  const [punchKey, setPunchKey] = useState(0);
  const [punchDir, setPunchDir] = useState<'down' | 'up' | 'strike'>('down');
  /**
   * 着弾までの数字の据え置き。null = 据え置きなし(= challenge.value をそのまま出す)。
   * 「複製」ではなく「一時上書き」にしてあるので、解除は常に null を入れるだけで
   * worker の権威ある値へ必ず収束する。
   */
  const [heldValue, setHeldValue] = useState<number | null>(null);
  const prevFills = useRef<number | null>(null);
  /** ストック満杯累計の前回値。likeGauge.fills と同じ単調増加規約で比較する。 */
  const prevStockFills = useRef<number | null>(null);
  const strikeTimers = useRef<number[]>([]);

  // ── ギフトルーレット ─────────────────────────────────────────────────────
  // 再生は同時に1件(並行するとリールが読めない)。演出中の再トリガーはキューへ。
  // worker は値を即時適用済みなので、ここは heldValue で数字を据え置き、リール
  // 停止の瞬間に worker 値へ収束させる(like 着弾と同じ「一時上書き」の解法)。
  const [roulette, setRoulette] = useState<{ key: number; effect: ChallengeEffect; fast: boolean } | null>(null);
  const rouletteQueue = useRef<ChallengeEffect[]>([]);
  /** 据え置きの持ち主がルーレットである印。値変化 effect の strike/punch を黙らせる。 */
  const rouletteHold = useRef(false);
  const rouletteTimers = useRef<number[]>([]);
  /** スピン中に届いた achieved 演出の持ち越し(1件で足りる — achieved は1回だけ)。 */
  const pendingAchieved = useRef<ChallengeEffect | null>(null);

  // ── ダイヤ帯域カットイン(バンド演出) ───────────────────────────────────
  // 不透明フルフレーム動画を .fx-clip-opaque で最前面に重ね、worker の凍結
  // (fxFreeze)と同じ fxDurationMs だけ数字を「適用前の値」で据え置く。
  // worker 側が凍結中は後続イベントを保留するので、再生中に数字が裏で動くことは
  // なく、表示と権威値は解除タイミングまで一致し続ける。
  const [bandClip, setBandClip] = useState<BandClipItem | null>(null);
  /** 据え置きの持ち主がカットインである印(rouletteHold と同じ役割)。 */
  const bandHold = useRef(false);
  const bandTimers = useRef<number[]>([]);
  /** 再生中のカットインのトリガー effect(終了時のパンチ方向に使う)。 */
  const bandEffect = useRef<ChallengeEffect | null>(null);
  /** ルーレットのリール中に届いたカットインの持ち越し(最新1件で足りる)。 */
  const pendingBand = useRef<ChallengeEffect | null>(null);
  /** 再生中のカットインBGM。すべての出口(finish/abort/unmount)で stop する。 */
  const bandBgm = useRef<BgmHandle | null>(null);

  useEffect(() => {
    void rpc('cfg.get', undefined).then(setCfg);
    void rpc('challenge.get', undefined).then(setChallenge);
    // 保存(cfg.set)は即時プッシュで受け、30秒ポーリングは取りこぼしの保険。
    const offSettings = window.api.onSettings(setCfg);
    // 設定(lowThreshold / loadAvatars 等)は delta に乗らないので定期再取得する。
    const t2 = setInterval(() => void rpc('cfg.get', undefined).then(setCfg), 30_000);
    return () => {
      offSettings();
      clearInterval(t2);
    };
  }, []);

  useEffect(() => {
    if (!challenge) return;
    document.title = challenge.title || 'チャレンジモニター';

    const fills = challenge.likeGauge?.fills ?? null;
    const step = challenge.likeGauge?.step ?? 0;
    const stock = challenge.likeGauge?.stock ?? null;
    const sFills = stock?.fills ?? null;
    const prevF = prevFills.current;
    const prevSF = prevStockFills.current;
    const prevV = prevValue.current;
    prevFills.current = fills;
    prevStockFills.current = sFills;
    prevValue.current = challenge.value;

    if (prevV === null) return; // マウント直後はアダプト(過去の変化で光らせない)
    if (prevV === challenge.value) return;

    // ルーレット演出中は据え置きを守る — 着弾ラッチや通常パンチで上書きすると
    // リールが止まる前に数字がネタバレする。反映は finishRoulette が行い、
    // 解除は常に null 代入なので worker 値へ必ず収束する。
    // カットイン(バンド演出)中も同じ理由で守る — 反映は finishBandFx が行う。
    if (rouletteHold.current || bandHold.current) return;
    // 同一デルタの場合: この effect は演出再生(playEffect)より先に走るので、
    // これから再生される未再生ルーレット/カットインがあればパンチを譲る(直後に
    // startRoulette / startBandFx がラッチする)。5秒超の取りこぼしは演出側も
    // スキップするので通常どおり punch。
    if (
      challenge.recentEffects.some(
        (e) =>
          (e.kind === 'roulette' || (e.kind === 'gift' && e.fxBandClip != null)) &&
          e.id > (lastPlayed.current ?? 0) &&
          Date.now() - e.atMs <= 5000
      )
    ) {
      return;
    }

    // ゲージ満タン由来かは fills の単調増加で判定する。recentEffects を見ないのは、
    // watermark の 5 秒ゲートで落ちた古い演出とラッチがズレるのを避けるため。
    const units = fills !== null && prevF !== null ? fills - prevF : 0;
    const likeDelta = units > 0 ? units * step : 0;
    // ストック満杯はゲージ満タンと同じ tick でしか起きない(worker の従属関係)。
    // 満杯分も据え置いて2段目の着弾まで持ち越す — 引き忘れるとボーナスが
    // ゲージ演出より先に7セグへ出る(因果逆転)。
    const stockUnits = sFills !== null && prevSF !== null ? sFills - prevSF : 0;
    const stockDelta = stockUnits > 0 ? stockUnits * (stock?.step ?? 0) : 0;
    // 2Hz のデルタはボタン押下といいね満タンを1スナップショットに相乗りさせうる。
    // 丸ごと据え置くと押下の手応えが 0.72 秒遅れるので、いいね分だけを持ち越す。
    const held = challenge.value - likeDelta - stockDelta;

    const canStrike =
      likeDelta > 0 &&
      challenge.status === 'running' &&
      held >= prevV && // 逆行するラッチは張らない(step が窓中に変わった場合の保険)
      held < challenge.value &&
      !prefersReducedMotion();

    if (canStrike) {
      startStrike(held, prevV, likeDelta, stockDelta);
      return;
    }

    flushStrike(); // 保留があれば畳んでから通常のパンチへ
    setPunchDir(challenge.value < prevV ? 'down' : 'up');
    setPunchKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.value, challenge?.title, challenge?.likeGauge?.fills, challenge?.likeGauge?.stock?.fills, challenge?.status]);

  // タイマーをアンマウント跨ぎで生き残らせない(BGM も止め忘れない)。
  useEffect(
    () => () => {
      clearStrikeTimers();
      clearRouletteTimers();
      clearBandTimers();
      bandBgm.current?.stop(0);
      bandBgm.current = null;
    },
    []
  );

  // 停止/リセット(idle)でスピン・カットインを打ち切る。achieved はここでは触らない —
  // 'sub' 方向で 0 到達した場合はリールを最後まで見せてから達成演出を出す。
  useEffect(() => {
    if (challenge?.status === 'idle') {
      abortRoulette();
      abortBandFx();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.status]);

  // 効果音(視覚とは独立の watermark)。モニターが開いている間はここが鳴らし、
  // ダッシュボード側は monitorOpen ゲートで黙る。設定は 30 秒ポーリング(上の
  // cfg 再取得)経由なので、音量変更の反映は最大 30 秒遅れる。
  useChallengeSe(challenge, {
    active: true,
    enabled: cfg?.challenge.seEnabled ?? true,
    volume: cfg?.challenge.seVolume ?? 70,
    sounds: cfg?.challenge.seSounds,
    volumes: cfg?.challenge.seVolumes,
  });

  // ── 演出再生(冪等) ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!challenge) return;
    const effects = challenge.recentEffects;
    const maxId = effects.reduce((m, e) => Math.max(m, e.id), 0);
    if (lastPlayed.current === null) {
      lastPlayed.current = maxId;
      return;
    }
    // worker 再起動で effect id が 1 から振り直されると watermark が天井に残り、
    // 以後の演出が全て「再生済み」扱いで死ぬ。巻き戻りを検知したら追従させる
    // (古すぎる演出は下の 5 秒ゲートが落とす)。
    if (lastPlayed.current > maxId) lastPlayed.current = 0;
    const fresh = effects
      .filter((e) => e.id > lastPlayed.current!)
      .sort((a, b) => a.id - b.id);
    for (const e of fresh) {
      lastPlayed.current = Math.max(lastPlayed.current, e.id);
      // 取りこぼしの古い演出は無音でスキップ(復帰直後の演出ストーム防止)。
      if (Date.now() - e.atMs > 5000) continue;
      playEffect(e);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.recentEffects]);

  function pushFloat(node: React.ReactNode, cls: string): void {
    setFloats((f) => [...f.slice(-7), { key: ++fxKey, node, cls }]);
  }
  function pushFlash(cls: string): void {
    setFlashes((f) => [...f.slice(-3), { key: ++fxKey, cls }]);
  }
  function pushShake(cls: string): void {
    setShake({ key: ++fxKey, cls });
  }
  /** 演出クリップを差し替えて頭から再生。null(未割り当て/無効)なら何もしない。 */
  function playClip(url: string | null): void {
    if (!url) return;
    setClip({ key: ++fxKey, url });
  }

  /**
   * 簡易演出を7セグの位置へ出す。id が null(未割り当て/無効)なら何もしない。
   * 位置は canvas エンジンの pointFor を借りてステージ座標で取る — 縦横ステージ
   * どちらでも数字の上に乗る。エンジン未接続時はステージ中央へ退避。
   */
  function playMini(id: string | null, amount: number): void {
    if (!id) return;
    const r = fxRef.current?.pointFor(countdownRef.current);
    const stageW = landscape ? STAGE_LW : STAGE_W;
    const stageH = landscape ? STAGE_LH : STAGE_H;
    const x = r?.x ?? stageW / 2;
    const y = r?.y ?? stageH * 0.45;
    // 数字の短辺に合わせる — 7セグを覆い隠さない程度の大きさ。
    const size = Math.max(120, Math.min(r ? Math.min(r.w, r.h) * 1.15 : 240, 340));
    setMini({ key: ++fxKey, id, amount, x, y, size });
  }

  /** フロート帯(上部 26%)付近のステージ座標 — 粒子演出の既定の発生点。 */
  function fxOrigin(): { x: number; y: number } {
    return {
      x: (landscape ? STAGE_LW : STAGE_W) / 2,
      y: (landscape ? STAGE_LH : STAGE_H) * 0.3,
    };
  }

  function clearStrikeTimers() {
    for (const t of strikeTimers.current) window.clearTimeout(t);
    strikeTimers.current = [];
  }

  /** 保留中の据え置きを即座に畳む。数字は常に worker の値へ収束する。 */
  function flushStrike() {
    clearStrikeTimers();
    setHeldValue((h) => (h === null ? h : null));
  }

  function clearRouletteTimers() {
    for (const t of rouletteTimers.current) window.clearTimeout(t);
    rouletteTimers.current = [];
  }

  /** ルーレットを開始し、リールが止まるまで数字を出目適用前の値で据え置く。 */
  function startRoulette(e: ChallengeEffect, fast: boolean) {
    flushStrike(); // いいね着弾の保留があれば先に畳む(ラッチの持ち主を1人にする)
    rouletteHold.current = true;
    // 据え置き値は worker が確定させた valueAfter から出目を戻した「適用前」。
    // renderer での再計算はこの1箇所だけ — 表示上の演出のためで、解除後は必ず
    // worker の権威ある値に収束する。
    setHeldValue(Math.max(0, e.valueAfter - e.amount));
    setRoulette({ key: ++fxKey, effect: e, fast });
    // 安全弁: バックグラウンドで onAnimationEnd が来なくても必ず解除して収束させる。
    clearRouletteTimers();
    rouletteTimers.current.push(window.setTimeout(() => finishRoulette(e), ROULETTE_ABORT_MS));
  }

  /** リール停止(または安全弁)— ここで初めて数字が動いて見える。 */
  function finishRoulette(e: ChallengeEffect) {
    clearRouletteTimers();
    rouletteHold.current = false;
    setRoulette(null);
    setHeldValue(null);
    setPunchDir(e.amount < 0 ? 'down' : 'up');
    setPunchKey((k) => k + 1);
    const big = Math.abs(e.amount) >= 1000;
    pushShake(big ? 'shake-strong' : 'shake');

    const fx = fxRef.current;
    const r = fx?.pointFor(countdownRef.current);
    if (fx && r) {
      const hue = e.amount < 0 ? 140 : 0;
      fx.ringWave(r.x, r.y, { hue, radius: Math.max(r.w, r.h) * 0.62 });
      fx.sparkBurst(r.x, r.y, big ? 48 : 26, { hue, speed: big ? 680 : 560 });
      if (big) {
        fx.rays(r.x, r.y, { count: 12, hue: 45 });
        fx.confettiRain(120, { gold: true });
      }
    }
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['roulette-hit'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['roulette-hit'])
      );
    }
    const sign = e.amount < 0 ? `${num(e.amount)}` : `+${num(e.amount)}`;
    pushFloat(
      <>
        <span className="f-amt">{sign}</span>
        <span className="f-txt">
          <b>{e.nickname ?? ''}</b> のルーレット!
        </span>
      </>,
      `${e.amount < 0 ? 'good' : 'bad'} banner-roulette`
    );

    // スピン中に届いた達成演出をここで再生する(リザルト画面は RESULT_DELAY_MS
    // 側の独立タイマーで出るため、多少遅れても破綻しない)。
    const a = pendingAchieved.current;
    pendingAchieved.current = null;
    if (a) playEffect(a);

    // キューが詰まっていれば短縮スピンで消化する。
    const next = rouletteQueue.current.shift();
    if (next) {
      startRoulette(next, true);
      return;
    }
    // リール中に届いたカットインをここで開始する(worker はすでに凍結中 —
    // 見た目の開始が遅れるだけで、数字の整合は凍結側が保証している)。
    const b = pendingBand.current;
    pendingBand.current = null;
    if (b) startBandFx(b);
  }

  /** reset/stop 用の全破棄。演出もキューも据え置きも捨てて worker 値へ戻す。 */
  function abortRoulette() {
    clearRouletteTimers();
    rouletteQueue.current = [];
    pendingAchieved.current = null;
    if (!rouletteHold.current) return;
    rouletteHold.current = false;
    setRoulette(null);
    setHeldValue(null);
  }

  // ── ダイヤ帯域カットイン ─────────────────────────────────────────────────

  function clearBandTimers() {
    for (const t of bandTimers.current) window.clearTimeout(t);
    bandTimers.current = [];
  }

  /**
   * カットインを開始し、fxDurationMs の間、数字を適用前の値で据え置く。
   * 尺は effect の fxDurationMs が権威(worker の凍結時間と同期)。動画が短ければ
   * loop で持たせ、タイマーで打ち切る。戻り値 false = クリップ未解決(呼び出し側は
   * 従来の screen 合成クリップへフォールバックする)。
   */
  function startBandFx(e: ChallengeEffect): boolean {
    const url = fxClipUrl(e.fxBandClip);
    const durationMs = e.fxDurationMs ?? 0;
    if (!url || durationMs < 1000 || prefersReducedMotion()) return false;
    flushStrike(); // いいね着弾の保留があれば先に畳む(ラッチの持ち主を1人にする)
    clearBandTimers();
    bandHold.current = true;
    bandEffect.current = e;
    // 据え置き値は startRoulette と同じ「worker 確定の valueAfter から適用前へ戻す」。
    setHeldValue(Math.max(0, e.valueAfter - e.amount));
    setBandClip({ key: ++fxKey, url, durationMs, out: false });
    // BGM。曲 id は effect が権威(worker が bgmEnabled/'off' を判定済み)、
    // 音量だけ cfg から読む(roulette-hit 等と同じ 30 秒ポーリング許容)。
    // 直列再生(連続バンドギフト)で前の曲が残らないよう先に止める。
    bandBgm.current?.stop(0);
    bandBgm.current = playBandBgm(e.fxBandBgm, cfg?.challenge.giftBandFx.bgmVolume ?? 70);
    // パチンコ風の追い焚き: 開始時に1発、以降 2.2 秒ごとに再発火して
    // 動画の再生中ずっと粒子が舞い続けるようにする。
    bandBlast(durationMs);
    for (let t = 2200; t < durationMs - 800; t += 2200) {
      bandTimers.current.push(window.setTimeout(() => bandBlast(durationMs), t));
    }
    // 終端 0.4 秒前にフェード(映像の .out と BGM を同時に減衰)→ 尺で解除。
    // 安全弁はバックグラウンドタブの setTimeout 抑制対策(ROULETTE_ABORT_MS と同じ役割)。
    bandTimers.current.push(
      window.setTimeout(() => {
        setBandClip((c) => (c ? { ...c, out: true } : c));
        bandBgm.current?.stop(400);
      }, Math.max(0, durationMs - 400))
    );
    bandTimers.current.push(window.setTimeout(finishBandFx, durationMs));
    bandTimers.current.push(window.setTimeout(finishBandFx, durationMs + 2000));
    return true;
  }

  /** カットイン終了(または安全弁)— ここで初めて数字が動いて見える。 */
  function finishBandFx() {
    if (!bandHold.current) return;
    clearBandTimers();
    // 通常はフェード済み(stop は冪等)。onError 等の異常経路では即時停止になる。
    bandBgm.current?.stop(0);
    bandBgm.current = null;
    bandHold.current = false;
    const e = bandEffect.current;
    bandEffect.current = null;
    setBandClip(null);
    setHeldValue(null);
    if (e && e.amount !== 0) {
      setPunchDir(e.amount < 0 ? 'down' : 'up');
      setPunchKey((k) => k + 1);
      pushShake(Math.abs(e.amount) >= 100 ? 'shake-strong' : 'shake');
    }
    // カットイン中に届いた達成演出をここで再生する(finishRoulette と同じ持ち越し)。
    const a = pendingAchieved.current;
    pendingAchieved.current = null;
    if (a) playEffect(a);
  }

  /** reset/stop 用の全破棄。据え置きもタイマーもBGMも捨てて worker 値へ戻す。 */
  function abortBandFx() {
    clearBandTimers();
    bandBgm.current?.stop(0);
    bandBgm.current = null;
    pendingBand.current = null;
    if (!bandHold.current) return;
    bandHold.current = false;
    bandEffect.current = null;
    setBandClip(null);
    setHeldValue(null);
  }

  /**
   * カットイン中の粒子・照明の一斉発火。強さは尺で段階分け(6秒 < 8秒 < 10秒)—
   * バンドの閾値は設定で自由に変わるため、ダイヤ数ではなく尺を強さの代理にする。
   */
  function bandBlast(durationMs: number) {
    const level = durationMs >= 10_000 ? 4 : durationMs >= 8000 ? 3 : 2;
    pushFlash(`gift-t${level}`);
    pushShake(level >= 4 ? 'shake-strong' : 'shake');
    const fx = fxRef.current;
    if (!fx) return;
    const o = fxOrigin();
    if (level >= 4) {
      fx.rays(o.x, o.y, { count: 12, hue: 45 });
      fx.fireworkVolley(o.x, o.y, { count: 3, hue: 45 });
      fx.confettiRain(240, { gold: true });
    } else if (level === 3) {
      fx.rays(o.x, o.y, { count: 10, hue: 45 });
      fx.fireworkVolley(o.x, o.y, { count: 2, hue: 45 });
      fx.confettiRain(160);
    } else {
      fx.sparkBurst(o.x, o.y, 32, { hue: 45, speed: 600 });
      fx.confettiRain(80);
    }
  }

  /**
   * 着弾シーケンスを開始する。全ビートをここのタイマーが握る —
   * LikeGauge.onFull や canvas の到達判定に依存させない(ゲージが非表示になったり
   * 縦横切替で粒子が捨てられても、数字は必ず着弾時刻に更新される)。
   *
   * stockDelta > 0(ストック満杯が同 tick に相乗り)のときは2段着弾:
   * 1段目はいいね分だけの「部分着弾」で据え置きを held+likeDelta に切り上げ、
   * STOCK_PAUSE_MS 置いてドット行から2発目(緑)→ 最終着弾で全解除。
   */
  function startStrike(held: number, prevV: number, likeDelta: number, stockDelta: number) {
    clearStrikeTimers();
    setHeldValue(held);
    // 同デルタに押下/ギフトが混ざっていた分は据え置かず、その場で見せる。
    if (held !== prevV) {
      setPunchDir(held < prevV ? 'down' : 'up');
      setPunchKey((k) => k + 1);
    }
    const push = (ms: number, fn: () => void) => {
      strikeTimers.current.push(window.setTimeout(fn, ms));
    };
    // レイアウトはゲージが溜まっても動かないので、飛翔時間は今の座標で確定できる。
    const travel = strikeTravelMs(gaugeTrackRef.current);
    push(STRIKE_LAUNCH_MS, () => launchStrike(travel, stockDelta > 0));
    const t1 = STRIKE_LAUNCH_MS + travel;
    if (stockDelta <= 0) {
      push(t1, impactStrike);
      push(STRIKE_ABORT_MS, flushStrike);
      return;
    }
    const travel2 = strikeTravelMs(stockRowRef.current);
    push(t1, () => impactStrikePartial(held + likeDelta));
    push(t1 + STOCK_PAUSE_MS, () => launchStock(travel2));
    push(t1 + STOCK_PAUSE_MS + travel2, () => impactStock(stockDelta));
    // 安全弁は必ず2段目の着弾より後ろに置く(固定 1400ms だと因果逆転)。
    push(STRIKE_ABORT_STOCK_MS, flushStrike);
  }

  /** 発射点→7セグの距離から飛翔時間を出す。座標が取れなければ既定値。 */
  function strikeTravelMs(from: HTMLElement | null): number {
    const fx = fxRef.current;
    const a = fx?.pointFor(from);
    const b = fx?.pointFor(countdownRef.current);
    if (!a || !b) return STRIKE_TRAVEL_MS;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return Math.round(Math.min(STRIKE_TRAVEL_MAX_MS, Math.max(STRIKE_TRAVEL_MIN_MS, d / STRIKE_SPEED)));
  }

  /** 満タンの瞬間 — ゲージから7セグへ弾を撃ち出す。 */
  function launchStrike(travelMs: number, stockFollows: boolean) {
    const fx = fxRef.current;
    const from = fx?.pointFor(gaugeTrackRef.current);
    const to = fx?.pointFor(countdownRef.current);
    // pointFor が null(canvas 未アタッチ/幅0)でも粒子を諦めるだけ。
    // 数字はタイマーが独立に更新するので演出が欠けても破綻しない。
    if (fx && from && to) {
      fx.strike({ x: from.x, y: from.y }, { x: to.x, y: to.y }, { ms: travelMs, hue: 332 });
    }
    // ストック満杯が続くときは全画面クリップを2段目(stock-full)に譲る —
    // 直後に打ち切られて中途半端に見えるより1本をフルに見せる。
    if (cfg?.challenge.fxClipsEnabled && !stockFollows) playClip(GAUGE_FULL_CLIP_URL);
  }

  /** 着弾 — ここで初めて数字が増える。 */
  function impactStrike() {
    clearStrikeTimers();
    setHeldValue(null);
    impactStrikeVisuals();
  }

  /**
   * 2段着弾の1段目 — いいね分だけ数字を進め、ストック分は据え置いたまま残す。
   * clearStrikeTimers は呼ばない(後続ビートと安全弁が生きている)。
   */
  function impactStrikePartial(shown: number) {
    setHeldValue(shown);
    impactStrikeVisuals();
  }

  /** ゲージ満タン着弾の共通演出(パンチ/シェイク/粒子/クリップ/SE)。 */
  function impactStrikeVisuals() {
    setPunchDir('strike');
    setPunchKey((k) => k + 1);
    pushShake('shake');

    const fx = fxRef.current;
    const r = fx?.pointFor(countdownRef.current);
    const stageW = landscape ? STAGE_LW : STAGE_W;
    const stageH = landscape ? STAGE_LH : STAGE_H;
    const cx = r?.x ?? stageW / 2;
    const cy = r?.y ?? stageH * 0.4;
    if (fx && r) {
      fx.ringWave(cx, cy, { hue: 330, radius: Math.max(r.w, r.h) * 0.62 });
      fx.sparkBurst(cx, cy, 26, { hue: 332, speed: 620 });
      fx.heartBurst(cx, cy, 12, { hue: 338 });
    }
    if (cfg?.challenge.fxClipsEnabled) {
      // 全画面ではなく7セグの実位置へ。ステージからはみ出さない範囲で数字を覆う。
      const base = r ? Math.min(r.w, r.h) : 320;
      const size = Math.min(Math.max(base * 1.4, 300), Math.min(stageW, stageH));
      setStrikeClip({ key: ++fxKey, x: cx - size / 2, y: cy - size / 2, size });
    }
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['gauge-full'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['gauge-full'])
      );
    }
    if (cfg) playMini(miniForSlot(cfg.challenge, 'gauge-full'), 0);
  }

  /** ストック満杯 — ドット行から7セグへ2発目(緑)を撃ち出す。 */
  function launchStock(travelMs: number) {
    const fx = fxRef.current;
    const from = fx?.pointFor(stockRowRef.current) ?? fx?.pointFor(gaugeTrackRef.current);
    const to = fx?.pointFor(countdownRef.current);
    if (fx && from && to) {
      fx.strike({ x: from.x, y: from.y }, { x: to.x, y: to.y }, { ms: travelMs, hue: 140 });
    }
    if (cfg?.challenge.fxClipsEnabled) playClip(STOCK_FULL_CLIP_URL);
  }

  /** ストック分の着弾 — ここで初めてボーナスが数字に乗る(据え置き全解除)。 */
  function impactStock(stockDelta: number) {
    clearStrikeTimers();
    setHeldValue(null);
    setPunchDir('strike');
    setPunchKey((k) => k + 1);
    pushShake('shake-strong');

    const fx = fxRef.current;
    const r = fx?.pointFor(countdownRef.current);
    const stageW = landscape ? STAGE_LW : STAGE_W;
    const stageH = landscape ? STAGE_LH : STAGE_H;
    const cx = r?.x ?? stageW / 2;
    const cy = r?.y ?? stageH * 0.4;
    if (fx && r) {
      fx.ringWave(cx, cy, { hue: 140, radius: Math.max(r.w, r.h) * 0.7 });
      fx.sparkBurst(cx, cy, 36, { hue: 140, speed: 680 });
      fx.heartBurst(cx, cy, 14, { hue: 140 });
    }
    if (cfg?.challenge.fxClipsEnabled) {
      const base = r ? Math.min(r.w, r.h) : 320;
      const size = Math.min(Math.max(base * 1.4, 300), Math.min(stageW, stageH));
      setStrikeClip({ key: ++fxKey, x: cx - size / 2, y: cy - size / 2, size });
    }
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['stock-full'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['stock-full'])
      );
    }
    if (cfg) playMini(miniForSlot(cfg.challenge, 'stock-full'), stockDelta);
  }

  /** いいね着弾でゲージを明滅させる(remove→reflow→add で毎回再生)。 */
  function tickGauge(): void {
    const el = gaugeTrackRef.current;
    if (!el) return;
    el.classList.remove('tick');
    void el.offsetWidth;
    el.classList.add('tick');
  }

  function playEffect(e: ChallengeEffect): void {
    const fx = fxRef.current;
    switch (e.kind) {
      case 'press': {
        // 押下の映像演出は出さない。フラッシュは連打で鬱陶しいので元々無し、
        // リング波紋＋火花も非表示にした（連打で画面がうるさいため）。手応えは効果音と、
        // 値の変化側で再生される 7 セグのパンチが受け持つ。
        if (cfg) playMini(miniForSlot(cfg.challenge, 'press'), e.amount);
        return;
      }
      case 'follow': {
        pushFlash('follow');
        pushShake('shake');
        pushFloat(
          <>
            <span className="f-amt">+{num(e.amount)}</span>
            <span className="f-txt">
              <b>{e.nickname ?? ''}</b> がフォロー!
            </span>
          </>,
          'bad banner-follow'
        );
        const o = fxOrigin();
        fx?.sparkBurst(o.x, o.y, 24, { hue: 0, speed: 560 });
        fx?.heartBurst(o.x, o.y, 10, { hue: 0 });
        if (cfg) playMini(miniForSlot(cfg.challenge, 'follow'), e.amount);
        return;
      }
      case 'like': {
        // 高頻度なのでフラッシュ/シェイクは付けない — 合算済みの +N だけ流す。
        pushFloat(
          <>
            <span className="f-heart">♥</span>
            <span className="f-amt">+{num(e.amount)}</span>
            <span className="f-txt">いいね妨害!</span>
          </>,
          'bad like-float'
        );
        // ハートがゲージへ吸い込まれて着弾ごとに明滅 — 「いいねが注がれて
        // ゲージが貯まる」の視覚連結。ゲージ非表示時は弾け上がりへ退避。
        const lg = challenge?.likeGauge;
        const o = fxOrigin();
        const anchor = fx?.pointFor(gaugeTrackRef.current);
        if (fx && anchor && lg) {
          const units = Math.max(1, Math.round(e.amount / Math.max(1, lg.step)));
          fx.heartStream(o, { x: anchor.x, y: anchor.y }, Math.min(12, 3 + units * 2), tickGauge);
        } else {
          fx?.heartBurst(o.x, o.y, 8, { hue: 338 });
        }
        if (cfg) playMini(miniForSlot(cfg.challenge, 'like'), e.amount);
        return;
      }
      case 'stock-full': {
        // フロートだけ出す — フラッシュ/シェイク/クリップ/SE は着弾側(impactStock)
        // が担当する(gauge-full と同じ分担)。フロートが着弾より先に出るのは
        // like の「+N → 後からゲージ着弾」と同じ既存挙動。
        pushFloat(
          <>
            <span className="f-heart">💚</span>
            <span className="f-amt">+{num(e.amount)}</span>
            <span className="f-txt">いいねストック満杯!</span>
          </>,
          'bad like-float'
        );
        return;
      }
      case 'gift': {
        const tier = tierForDiamonds(e.diamonds ?? 0);
        // ダイヤ帯域カットイン。effect 側の fxBandClip が権威(worker が判定済み・
        // 凍結も開始済み)なので cfg は見ない — 30 秒ポーリングの古い設定に
        // 依存しない。開始できたら通常クリップ・簡易演出は出さない(全画面を
        // 不透明動画が覆うため見えない)。リール中は持ち越し、解決できなければ
        // 従来経路へフォールバックする。
        let banded = false;
        if (e.fxBandClip != null) {
          if (rouletteHold.current) {
            pendingBand.current = e;
            banded = true;
          } else {
            banded = startBandFx(e);
          }
        }
        // 映像クリップ。canonical 一致の専用クリップ → 無ければ tier の汎用クリップ。
        // 割り当ては設定画面で変更でき、cfg は 30 秒ポーリングで届く。
        if (cfg && !banded) {
          const g = { canonical: e.canonical, diamonds: e.diamonds ?? 0 };
          playClip(fxClipUrl(matchGiftClip(cfg.challenge, g)));
          playMini(matchGiftMini(cfg.challenge, g), e.amount);
        }
        // 「照明」= 画面フラッシュ。flash 指定は「確実に見える t2 相当」を保証
        // するだけで tier を偽らない(旧実装は小額 flash ギフトが t3 に化けた)。
        pushFlash(`gift-t${Math.max(tier, e.flash ? 2 : 1)}`);
        if (tier >= 2) pushShake(tier >= 4 ? 'shake-strong' : 'shake');
        const gift = e.giftName ?? 'ギフト';
        const sign = e.amount > 0 ? `+${num(e.amount)}` : e.amount < 0 ? `${num(e.amount)}` : '±0';
        pushFloat(
          <>
            <span className="gc-icon">
              <span className="gc-emoji">🎁</span>
              {e.giftIconUrl ? (
                <img
                  src={e.giftIconUrl}
                  alt=""
                  onError={(ev) => {
                    ev.currentTarget.style.display = 'none'; // 絵文字へフォールバック
                  }}
                />
              ) : null}
            </span>
            <span className="gc-main">
              <span className="gc-name">{gift}</span>
              <span className="gc-who">{e.nickname ?? ''}</span>
            </span>
            <span className="gc-amt">{sign}</span>
            {e.diamonds ? <span className="gc-dia">💎{num(e.diamonds)}</span> : null}
          </>,
          `gift-card t${tier} ${e.amount > 0 ? 'bad' : 'good'}`
        );
        if (fx) {
          const o = fxOrigin();
          if (tier >= 4) {
            fx.rays(o.x, o.y, { count: 12, hue: 45 });
            fx.fireworkVolley(o.x, o.y, { count: 3, hue: 45 });
            fx.confettiRain(240, { gold: true });
          } else if (tier === 3) {
            fx.rays(o.x, o.y, { count: 10, hue: 45 });
            fx.sparkBurst(o.x, o.y, 40, { hue: 45, speed: 640 });
            fx.confettiRain(120);
          } else if (tier === 2) {
            fx.sparkBurst(o.x, o.y, 26, { hue: 45, speed: 540 });
            fx.confettiRain(40);
          } else {
            fx.sparkBurst(o.x, o.y, 12, { hue: 45, speed: 420 });
          }
        }
        return;
      }
      case 'roulette': {
        const segs = e.rouletteSegments;
        // 演出に必要な盤面が無い(旧 worker との混在等)/動きの抑制設定なら、
        // リールは諦めてバナーだけ出す — 値は worker が適用済みなので破綻しない。
        if (!segs || segs.length === 0 || e.rouletteIndex == null || prefersReducedMotion()) {
          const sign = e.amount < 0 ? `${num(e.amount)}` : `+${num(e.amount)}`;
          pushFloat(
            <>
              <span className="f-amt">{sign}</span>
              <span className="f-txt">
                <b>{e.nickname ?? ''}</b> のルーレット!
              </span>
            </>,
            `${e.amount < 0 ? 'good' : 'bad'} banner-roulette`
          );
          return;
        }
        if (rouletteHold.current) {
          // 再生中はキューへ。溢れた分は演出スキップ(数字は解除時に一括で合う)。
          if (rouletteQueue.current.length < ROULETTE_QUEUE_MAX) rouletteQueue.current.push(e);
          return;
        }
        startRoulette(e, false);
        return;
      }
      case 'achieved':
        // ルーレットのリール/カットインの再生中は持ち越す — 出目・演出を見せる前に
        // CLEAR のフラッシュが走ると何で達成したのか読めない。
        // finishRoulette / finishBandFx が再生する。
        if (rouletteHold.current || bandHold.current) {
          pendingAchieved.current = e;
          return;
        }
        pushFlash('clear');
        pushShake('shake-strong');
        if (cfg?.challenge.fxClipsEnabled) playClip(ACHIEVED_CLIP_URL);
        if (cfg) playMini(miniForSlot(cfg.challenge, 'achieved'), 0);
        fx?.celebrate();
        return;
    }
  }

  // ── ボタン: クリック / Space / Enter。Esc で閉じる ───────────────────────
  useEffect(() => {
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.repeat) return;
      if (ev.key === ' ' || ev.key === 'Enter') {
        ev.preventDefault();
        void rpc('challenge.press', undefined).then(setChallenge);
      } else if (ev.key === 'Escape') {
        void rpc('monitor.close', undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── ギフトランキング: DB がソース、live delta が隙間埋め ─────────────────
  const { data: baseRank } = useQuery(
    'q.viewerTable',
    { sessionId, sort: 'diamondsCurrent', desc: true, filter: 'gifter', limit: 10 },
    [sessionId, Math.floor(version / 60)],
    { skip: sessionId == null }
  );
  const top3 = useMemo(() => {
    const byId = new Map<string, { userId: string; nickname: string; avatarUrl: string | null; diamonds: number }>();
    for (const r of baseRank?.rows ?? []) {
      byId.set(r.userId, { userId: r.userId, nickname: r.nickname, avatarUrl: r.avatarUrl, diamonds: r.diamondsCurrent });
    }
    for (const l of liveRows()) {
      if (l.diamonds <= 0) continue;
      const e = byId.get(l.userId);
      if (e) e.diamonds = Math.max(e.diamonds, l.diamonds);
      else byId.set(l.userId, { userId: l.userId, nickname: l.nickname, avatarUrl: l.avatarUrl, diamonds: l.diamonds });
    }
    return [...byId.values()].sort((a, b) => b.diamonds - a.diamonds).slice(0, 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseRank, version]);

  if (!challenge) {
    return <div className="stage-viewport idle-hint">読み込み中…</div>;
  }

  const lowThreshold = cfg?.challenge.lowThreshold ?? 10;
  const running = challenge.status === 'running';
  const achieved = challenge.status === 'achieved';
  const digits = Math.max(4, String(challenge.initialValue).length);
  // 据え置き中はこちらを出す。桁数(initialValue 由来)と status は据え置かない。
  const shownValue = heldValue ?? challenge.value;
  const showAvatars = cfg?.loadAvatars ?? true;
  const segCls = [
    'countdown',
    `punch-${punchDir}`,
    achieved ? 'clear' : '',
    running && shownValue <= lowThreshold ? 'low' : '',
  ].join(' ');

  return (
    // stage-viewport がウィンドウ全面、stage-scale が 540×960 の固定ステージを
    // 中央に scale で収める。shake は内側の monitor-root に掛ける(外側に掛けると
    // keyframes の transform が scale を上書きして一瞬拡大が外れる)。
    <div
      className="stage-viewport"
      onPointerDown={() => void rpc('challenge.press', undefined).then(setChallenge)}
    >
    <div
      className={`stage-scale${landscape ? ' landscape' : ''}`}
      style={{
        width: landscape ? STAGE_LW : STAGE_W,
        height: landscape ? STAGE_LH : STAGE_H,
        transform: `translate(-50%, -50%) scale(${scale})`,
      }}
    >
    <div
      className={`monitor-root${shake ? ` ${shake.cls}` : ''}`}
      data-shake={shake?.key}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) setShake(null);
      }}
    >
      <div className={`title-banner${achieved ? ' clear' : ''}`}>{challenge.title}</div>

      <div className={segCls} key={punchKey} ref={countdownRef}>
        <SevenSeg value={shownValue} digits={digits} />
        {achieved ? <div className="clear-banner">CLEAR!</div> : null}
        {!running && !achieved ? (
          <div className="idle-note">
            {challenge.startedMs ? '一時停止中' : 'ダッシュボードの「開始」で始まります'}
          </div>
        ) : null}
      </div>

      <div className="bars">
        {challenge.likeGauge && running ? (
          <LikeGauge gauge={challenge.likeGauge} fxRef={fxRef} trackRef={gaugeTrackRef} stockRowRef={stockRowRef} />
        ) : null}
      </div>

      <div className="elapsed-row">
        配信時間: {totals.elapsedMs > 0 ? elapsedText(totals.elapsedMs) : '—'}
        <span className="stats-inline">
          {' '}
          ボタン{num(challenge.stats.presses)} / 妨害{num(challenge.stats.follows)}
          {challenge.stats.likeUp > 0 ? ` / いいね+${num(challenge.stats.likeUp)}` : ''}
          {challenge.stats.likeStockUp > 0 ? ` / ストック+${num(challenge.stats.likeStockUp)}` : ''}
        </span>
      </div>

      <div className="ranking">
        {[0, 1, 2].map((i) => {
          const g = top3[i];
          return (
            <div key={g?.userId ?? `ph-${i}`} className={`rank rank-${i + 1}`}>
              <div className="rank-place">{i + 1}位</div>
              {g ? (
                <>
                  <Avatar url={g.avatarUrl} name={g.nickname} size={80} enabled={showAvatars} />
                  <div className="rank-name">{g.nickname}</div>
                  <div className="rank-dia">{num(g.diamonds)}💎</div>
                </>
              ) : (
                <div className="rank-empty">—</div>
              )}
            </div>
          );
        })}
      </div>

      {/*
        CLEAR リザルト(全画面)。配置は monitor-root 直下・fx-clip より DOM 順で前。
        - z-index は付けない。付けると position 済みなのでスタッキングの段が上がり、
          z-index:auto の .fx-clip より手前に回って演出クリップが隠れる。
        - fx-layer(z-index:50)と fx-clip は DOM 順で後ろなので、CLEAR のフラッシュ・
          紙吹雪・映像クリップはリザルトの上でそのまま見える。
        - 下の 7セグ等は unmount せず覆うだけ。display:none にすると
          fxRef.pointFor(countdownRef) の矩形が潰れ、簡易演出と波紋が中央へ退避する。
      */}
      {showResult && challenge.result ? (
        <div className="result-screen">
          <div className="rs-title">CLEAR!</div>
          <div className="rs-sub">{challenge.title}</div>
          <div className="rs-lists">
            <ResultList
              title="ギフトランキング TOP5"
              rows={challenge.result.gifts}
              kind="gift"
              showAvatars={showAvatars}
            />
            <ResultList
              title="イイネランキング TOP5"
              rows={challenge.result.likes}
              kind="like"
              showAvatars={showAvatars}
            />
          </div>
          <div className="rs-foot">
            {challenge.result.participants > 0
              ? `参加 ${num(challenge.result.participants)}人 / 所要 ${
                  challenge.result.startedMs
                    ? elapsedText(challenge.result.atMs - challenge.result.startedMs)
                    : '—'
                }`
              : 'このチャレンジ中の参加者はいませんでした'}
          </div>
        </div>
      ) : null}

      {/*
        演出クリップ。fx-layer の「中」には置けない — fx-layer は z-index:50 で
        スタッキングコンテキストを作るので、その内側の mix-blend-mode は
        fx-layer 内でしか合成されず、黒が抜けずに UI を覆ってしまう。
        monitor-root 直下(z-index:auto のまま)に置くことで、合成の相手が
        stage-scale(transform でコンテキストを作る)配下の UI 全体になる。
      */}
      {clip ? (
        <video
          key={clip.key}
          className="fx-clip"
          src={clip.url}
          autoPlay
          muted
          playsInline
          preload="auto"
          onTimeUpdate={(ev) => {
            // 末尾まで完全に減衰しないクリップがあるので、終端手前で自分から
            // フェードさせて唐突に切れないようにする(assets/fx/CREDITS.md の既知の癖)。
            const v = ev.currentTarget;
            if (v.duration > 0 && v.duration - v.currentTime < 0.4) v.classList.add('out');
          }}
          onEnded={() => setClip((c) => (c?.key === clip.key ? null : c))}
          // デコード失敗でも演出は canvas 側が主役なので黙って畳む。
          onError={() => setClip((c) => (c?.key === clip.key ? null : c))}
        />
      ) : null}

      {/*
        着弾クリップ。.fx-clip と同じスタッキングの制約を受ける — monitor-root 直下に
        z-index 無しで置くこと。全画面ではなく7セグの実位置に重ねるので、位置と寸法は
        fx.pointFor のステージ座標からインラインで入れる(transform は使わない)。
      */}
      {strikeClip ? (
        <video
          key={strikeClip.key}
          className="fx-strike"
          src={STRIKE_CLIP_URL}
          style={{
            left: strikeClip.x,
            top: strikeClip.y,
            width: strikeClip.size,
            height: strikeClip.size,
          }}
          autoPlay
          muted
          playsInline
          preload="auto"
          onTimeUpdate={(ev) => {
            // 素材は 4 秒だが演出のビートは 0.75 秒。残光に入る前に自分でフェードさせる。
            if (ev.currentTarget.currentTime > 0.75) ev.currentTarget.classList.add('out');
          }}
          onEnded={() => setStrikeClip((c) => (c?.key === strikeClip.key ? null : c))}
          onError={() => setStrikeClip((c) => (c?.key === strikeClip.key ? null : c))}
        />
      ) : null}

      {/*
        ダイヤ帯域カットイン(不透明フルフレーム)。.fx-clip と同じスタッキングの
        制約を受ける — .monitor-root 直下・z-index なし。DOM 順で .fx-clip の後ろに
        置くので、screen 合成のクリップより手前に重なる(不透明動画が主役)。
        尺は fxDurationMs のタイマー(startBandFx)が権威で、loop で持たせて
        打ち切る。onEnded は使わない。onError は即時解除(据え置きも解く)。
      */}
      {bandClip ? (
        <video
          key={bandClip.key}
          className={`fx-clip fx-clip-opaque${bandClip.out ? ' out' : ''}`}
          src={bandClip.url}
          autoPlay
          muted
          playsInline
          loop
          preload="auto"
          onError={finishBandFx}
        />
      ) : null}

      {/* 演出レイヤ(クリックを拾わない)。重なりは 映像 < flash < 粒子 canvas < テキスト */}
      <div className="fx-layer">
        {flashes.map((f) => (
          <div
            key={f.key}
            className={`flash ${f.cls}`}
            onAnimationEnd={() => setFlashes((s) => s.filter((x) => x.key !== f.key))}
          />
        ))}
        <FxCanvas
          engineRef={fxRef}
          stageW={landscape ? STAGE_LW : STAGE_W}
          stageH={landscape ? STAGE_LH : STAGE_H}
          scale={scale}
        />
        {mini ? (
          <div
            key={mini.key}
            className="mini"
            style={{ left: mini.x, top: mini.y, width: mini.size, height: mini.size }}
            onAnimationEnd={(ev) => {
              // SVG 内の子アニメーション(着弾の星)のバブリングで早死にしないよう、
              // 自分の直下要素の終了だけを拾う。
              if (ev.target !== ev.currentTarget.firstChild) return;
              setMini((m) => (m?.key === mini.key ? null : m));
            }}
          >
            <MiniFx id={mini.id} amount={mini.amount} />
          </div>
        ) : null}
        {roulette ? (
          <RouletteFx
            key={roulette.key}
            segments={roulette.effect.rouletteSegments ?? []}
            index={roulette.effect.rouletteIndex ?? 0}
            amount={roulette.effect.amount}
            fast={roulette.fast}
            nickname={roulette.effect.nickname}
            giftIconUrl={roulette.effect.giftIconUrl}
            onDone={() => finishRoulette(roulette.effect)}
          />
        ) : null}
        <div className="floats">
          {floats.map((f) => (
            <div
              key={f.key}
              className={`float ${f.cls}`}
              onAnimationEnd={(ev) => {
                // ギフトカード内の子アニメーション(シマー等)のバブリングで
                // 早死にしないよう、自分自身の浮上アニメ終了だけを拾う。
                if (ev.target !== ev.currentTarget) return;
                setFloats((s) => s.filter((x) => x.key !== f.key));
              }}
            >
              {f.node}
            </div>
          ))}
        </div>
      </div>
    </div>
    </div>
    </div>
  );
}
