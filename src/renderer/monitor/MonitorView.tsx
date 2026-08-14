import { useEffect, useRef, useState } from 'react';
import type { AppSettings, ChallengeEffect, ChallengeRankRow } from '@shared/dto';
import {
  CHALLENGE_MINI_IDS,
  CHALLENGE_MONITOR_TOP_N,
  CHALLENGE_RESULT_TOP_N,
  CLIP_ABORT_MS,
  CLIP_QUEUE_MAX,
  FLOAT_ABORT_MS,
  FLOAT_MAX,
  GIFT_FX_REPEAT_TIMERS_MAX,
  MINI_ABORT_MS,
  MINI_MAX,
  ROULETTE_QUEUE_MAX,
  SHAKE_ABORT_MS,
  rouletteAbortMs,
  effectiveSeVolume,
  freshChallengeEffects,
  giftFxShots,
  isChallengeEffectFresh,
  matchGiftClip,
  matchGiftMini,
  miniForSlot,
  rouletteHeadline,
  tierForDiamonds,
} from '@shared/challenge';
import { num } from '@shared/format';
import { CFG_POLL_MS } from '@shared/constants';
import { runFxDrain, type FxDrainOrder } from '@shared/fx-drain';
import { boostStartTiming, planBoostStart, type BoostStartPlan } from '@shared/boost-start';
import {
  mergePendingFloat,
  shouldDeferFloat,
  shouldFlushDeferredFloats,
  type FloatHoldState,
  type PendingFloat,
} from '@shared/fx-floats';
import {
  STRIKE_TRAVEL_MAX_MS,
  STRIKE_TRAVEL_MIN_MS,
  STRIKE_TRAVEL_MS,
  planBoostSettle,
  rollupDisplayAt,
} from '@shared/boost-settle';
import { rpc } from '../ipc/client';
import { setChallenge, useLive } from '../state/liveStore';
import { Avatar } from '../components/common';
import { useChallengeSe } from '../lib/useChallengeSe';
import {
  ACHIEVED_CLIP_URL,
  GAUGE_FULL_CLIP_URL,
  STOCK_CUTIN_CLIP_URL,
  STOCK_FULL_CLIP_URL,
  STRIKE_CLIP_URL,
  boostClipUrl,
  fxClipUrl,
} from '../lib/fx';
import { playSe } from '../lib/se';
import { playBandBgm, type BgmHandle } from '../lib/bgm';
import { MiniFx } from './MiniFx';
import { RouletteFx } from './RouletteFx';
import { SevenSeg } from './SevenSeg';
import { LikeGauge } from './LikeGauge';
import { WakeRow } from './WakeRow';
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
  /**
   * 全面カット(assets/fx/cut/*.mp4)である印。true のときだけ <video> の muted を
   * 外して素材に焼き込まれた音声を鳴らす — 帯域カットインは無音素材 + 別ファイルの
   * BGM(bandBgm)なので常に muted。effect の fxFullCut をそのまま写す。
   */
  fullCut: boolean;
}
/** 再生中の簡易演出。クリップとは独立に1つだけ持つ(併用できる)。 */
interface MiniItem {
  key: number;
  id: string;
  amount: number;
  /**
   * ステージ座標での**左上**と実寸(数字の矩形から決める)。
   * 中心ではないので注意 — .mini 側にも translate は無い。
   * 写真カットイン(panic)だけ 3:2 なので、一辺ではなく w/h を分けて持つ。
   */
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 写真カットイン(panic)の縦横比 — 素材 panic-man.webp は 1024×682。 */
const PANIC_AR = 1024 / 682;
/** 数字と簡易演出のすき間(ステージpx)。 */
const MINI_GAP = 10;
/** ステージ端との最小すき間(ステージpx)。.fx-layer は overflow:hidden。 */
const MINI_EDGE = 8;

/** 着弾クリップ。全画面の ClipItem とは別枠で持つ — ギフト演出と食い合わせない。 */
interface StrikeClipItem {
  key: number;
  /** ステージ座標での左上(transform を使わず left/top で置くため中心から引いた値)。 */
  x: number;
  y: number;
  size: number;
}

/**
 * 着弾クリップの安全弁。onEnded/onError だけだと、autoplay の reject や
 * デコード停止(loadedmetadata 止まり)で静止フレームが7セグの上に screen 合成で
 * 貼りついたまま残る — ビート(0.75s)+フェード余白で必ず畳む。
 */
const STRIKE_CLIP_ABORT_MS = 2500;

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
/*
 * 弾の飛翔時間(STRIKE_TRAVEL_MS/MIN/MAX)は shared/boost-settle.ts へ移設 —
 * worker のブースト凍結予算(BOOST_SETTLE_BUDGET_MS)との整合を node テストで
 * 固定するため(boost-settle.spec.ts)。使い方は従来と同じ。
 */
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
/**
 * ストック着弾カットイン(stock-cutin.mp4)の尺。素材が 5.04 秒でもタイマーが権威で
 * 5000ms で打ち切る(バンドカットインと同じ流儀 — onEnded は使わない)。
 */
const STOCK_CUTIN_MS = 5000;
/** 終端フェード。.fx-clip の transition 400ms と一致させる。 */
const STOCK_CUTIN_FADE_MS = 400;
/**
 * カットイン区間の安全弁(= STOCK_CUTIN_MS + 2000、バンドの totalMs+2000 と同型)。
 * STRIKE_ABORT_STOCK_MS は「着弾まで」の守備範囲のまま変えない — impactStock 到達時に
 * clearStrikeTimers で除去され、カットイン区間はこちらが受け持つ。
 */
const STOCK_CUTIN_ABORT_MS = STOCK_CUTIN_MS + 2000;

/**
 * ルーレット確定バナーの中身。回転パネル(RouletteFx)と同じ文言にするため、
 * 前置き/後置きは shared の rouletteHeadline から取る。リールを出す通常経路と、
 * 盤面が無い/動きの抑制設定でリールを諦める経路の2箇所で使う。
 */
function rouletteBanner(e: ChallengeEffect): React.JSX.Element {
  const head = rouletteHeadline(e);
  const sign = e.amount < 0 ? `${num(e.amount)}` : `+${num(e.amount)}`;
  return (
    <>
      <span className="f-amt">{sign}</span>
      <span className="f-txt">
        {head.prefix}
        <b>{e.nickname ?? ''}</b>
        {head.suffix}
      </span>
    </>
  );
}

/**
 * 「♥ +N いいね妨害!」バナーの中身。保留(PendingFloat)は金額しか持たないので、
 * 描画は flush の瞬間にここで組む — 畳んだ合計でも即時1件でも同じ見た目になる。
 */
function likeFloatNode(amount: number): React.JSX.Element {
  return (
    <>
      <span className="f-heart">♥</span>
      <span className="f-amt">+{num(amount)}</span>
      <span className="f-txt">いいね妨害!</span>
    </>
  );
}

/** 「💚 +N いいねストック満杯!」バナーの中身(likeFloatNode と同じ理由で関数)。 */
function stockFloatNode(amount: number): React.JSX.Element {
  return (
    <>
      <span className="f-heart">💚</span>
      <span className="f-amt">+{num(amount)}</span>
      <span className="f-txt">いいねストック満杯!</span>
    </>
  );
}

/** 動きの抑制設定。true ならラッチごとスキップし、数字は従来どおり即時更新する。 */
function prefersReducedMotion() {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * 演出を出さなかった理由をコンソールへ残す(モニターは Ctrl+Shift+I で確認)。
 * 演出系の失敗経路はすべて無言スキップの設計なので、「なぜ出なかったか」を
 * 追える唯一の手がかりをここに集める。
 */
function fxWarn(reason: string, detail?: unknown): void {
  console.warn('[fx-skip]', reason, detail ?? '');
}

/**
 * このルーレット effect でリールが実際に回るか。回らない(バナーのみに退避する)
 * 効果に着弾ラッチ/パンチを譲ると、譲った先が何も出さず「数字だけ黙って動く」
 * になる — 譲る判定と playEffect のフォールバック判定は必ずこれを共有する。
 */
function rouletteWillSpin(e: ChallengeEffect): boolean {
  return (e.rouletteSegments?.length ?? 0) > 0 && e.rouletteIndex != null && !prefersReducedMotion();
}

/**
 * このギフト effect でダイヤ帯域カットインが実際に始まるか。クリップ id が
 * 未知(素材の削除/設定の巻き戻り)や尺不足だと startBandFx は無言で断る —
 * 譲る判定と startBandFx の入口ガードは必ずこれを共有する。
 */
function bandWillStart(e: ChallengeEffect): boolean {
  return fxClipUrl(e.fxBandClip) != null && (e.fxDurationMs ?? 0) >= 1000 && !prefersReducedMotion();
}

/**
 * このブースト effect(boost-start)で演出が実際に始まるか。専用素材が無くても
 * 暗幕+タップカウンタで成立するので、断るのは動きの抑制と尺不足だけ —
 * 譲る判定(yieldToCutin)と startBoostFx の入口ガードは必ずこれを共有する。
 */
function boostWillStart(e: ChallengeEffect): boolean {
  return (e.fxDurationMs ?? 0) >= 1000 && !prefersReducedMotion();
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
  const challenge = useLive((s) => s.challenge);
  const totals = useLive((s) => s.totals);
  const sessionId = useLive((s) => s.sessionId);
  const [cfg, setCfg] = useState<AppSettings | null>(null);
  /**
   * cfg.get の初回試行が完了した印(成功・失敗を問わない)。演出の watermark は
   * これが立つまで開始しない — cfg が null のまま最初の演出を処理すると、
   * playMini / playClip / SE が全部無言でスキップされる(▶ 実演再生の「押下」は
   * 簡易演出が唯一の視覚なので、丸ごと消えて見える)。
   */
  const [cfgTried, setCfgTried] = useState(false);
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
  /**
   * 再生中クリップの key と待ち行列。**state ではなく ref で持つのが肝** —
   * playClip は playEffect の for ループ内から同一バッチで複数回呼ばれるので、
   * clip(state)を読むと2回目も null に見えて前を上書きしてしまう
   * (「同じギフトが連続で来ても1回しか出ない」の原因そのもの)。
   * rouletteHold / bandHold と同じ「同期フラグは ref」の流儀。
   */
  const clipKey = useRef<number | null>(null);
  const clipQueue = useRef<string[]>([]);
  const clipTimer = useRef<number | null>(null);
  const [strikeClip, setStrikeClip] = useState<StrikeClipItem | null>(null);
  /** 着弾クリップの安全弁タイマー(STRIKE_CLIP_ABORT_MS)。 */
  const strikeClipTimer = useRef<number | null>(null);
  /** 簡易演出は floats/flashes と同じ「積む」層(上限 MINI_MAX)。 */
  const [minis, setMinis] = useState<MiniItem[]>([]);
  const miniTimers = useRef<number[]>([]);
  /** フロートバナーの安全弁タイマー(発火時に自己削除するので配列は有界)。 */
  const floatTimers = useRef<number[]>([]);
  /** tickGauge の強制レイアウトを次フレームへ逃がす rAF。0 = 予約なし。 */
  const gaugeTickRaf = useRef(0);
  /** 連打ギフトの反復ショットのタイマー。値には一切効かないので安全弁は不要。 */
  const repeatTimers = useRef<number[]>([]);
  const [shake, setShake] = useState<{ key: number; cls: string } | null>(null);
  /** shake の安全弁タイマー(animationend が届かないときの固着解除)。 */
  const shakeTimer = useRef<number | null>(null);
  // 粒子演出(紙吹雪・火花・光線)は canvas エンジンに任せる。
  const fxRef = useRef<FxEngine | null>(null);
  const countdownRef = useRef<HTMLDivElement | null>(null);
  const gaugeTrackRef = useRef<HTMLDivElement | null>(null);
  /** ストック満杯の弾の発射点(LikeGauge のドット行)。 */
  const stockRowRef = useRef<HTMLDivElement | null>(null);

  // CLEAR リザルト。演出を見せてから切り替えるので state で遅らせる。
  const [showResult, setShowResult] = useState(false);
  /**
   * achieved 演出を実際に再生した時刻(playEffect の非持ち越し分岐でセット)。
   * リザルトのタイマー基準はこちらを優先する — achievedMs(worker 時刻)だけだと、
   * バンドカットイン中に CLEAR したとき 2.5 秒でリザルトが不透明動画の裏に出て、
   * カットイン → CLEAR 演出 → リザルトの順序が壊れる。
   */
  const [achievedFxAt, setAchievedFxAt] = useState<number | null>(null);
  const hasResult = challenge?.status === 'achieved' && challenge.result != null;
  // ※ showResult のタイマー effect は roulette / bandClip / stockCutin の宣言後
  //   (下)にある — 宣言前に deps へ書くと TDZ で落ちる。

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
  /**
   * 着弾までバナーを我慢させる保留。「アニメーション → セグ通知」の順序を守るため、
   * like は7セグ着弾(impactStrike)、stock は2段目着弾(revealStock)で flush する。
   *
   * 積むかどうかは shouldDeferFloat(shared/fx-floats)が唯一の判断 — チェーン
   * 飛行中だけでなく、横取りで戻された持ち越し(pendingStrike)とカットイン中も
   * 保留する。出口は4つあり、どれかに必ず当たるのでバナーが闇に消えることはない:
   * 着弾(impactStrike / revealStock)/ 出す先が居ない flushStrike / チェーンを
   * 張らない drainPendingStrike / 全カットイン終了時のウォッチドッグ。
   * 出す順は必ず like → stock — 主役(ストック満杯)を手前に置くため。
   *
   * 入れ物は配列ではなく畳み込み(shared/fx-floats の PendingFloat)。配列だと
   * worker が凍結しないストックカットイン(最長7秒)の間に flushLikeFx が 1Hz で
   * 積み続け、revealStock の同期 flush が React のバッチで FLOAT_MAX を押し出して
   * 「満杯の瞬間に＋が3枚同時に出る」になっていた。金額だけを畳んで描画を flush
   * まで遅らせるので、1種類につき必ず1枚しか出ない(枚数の上限は構造で担保)。
   */
  const pendingLikeFloats = useRef<PendingFloat | null>(null);
  const pendingStockFloats = useRef<PendingFloat | null>(null);
  /**
   * ルーレット/カットイン/飛行中チェーンに譲ったいいね満タン・ストック満杯の
   * 持ち越し(合算)。据え置き(heldValue)の持ち主は常に1人という規約がある
   * ので重ねてチェーンは張れないが、演出ごと捨てるとゲージだけ 0 に戻って音も
   * 光もバナーも出ない。解除の瞬間(着弾・カットイン終了で次演出を始めない
   * パス・安全弁)に drainPendingStrike がフルチェーン1本として出す。
   */
  const pendingStrike = useRef<{ like: number; stock: number } | null>(null);
  /**
   * 飛行中チェーンの未着弾ぶん。ルーレット/カットイン開始の flushStrike に
   * 横取りされたとき pendingStrike へ戻し、演出明けに再生する。
   */
  const activeStrike = useRef<{ like: number; stock: number } | null>(null);

  // ── ギフトルーレット ─────────────────────────────────────────────────────
  // 再生は同時に1件(並行するとリールが読めない)。演出中の再トリガーはキューへ。
  // worker は値を即時適用済みなので、ここは heldValue で数字を据え置き、リール
  // 停止の瞬間に worker 値へ収束させる(like 着弾と同じ「一時上書き」の解法)。
  const [roulette, setRoulette] = useState<{ key: number; effect: ChallengeEffect; fast: boolean; spin: number } | null>(null);
  const rouletteQueue = useRef<ChallengeEffect[]>([]);
  /** 据え置きの持ち主がルーレットである印。値変化 effect の strike/punch を黙らせる。 */
  const rouletteHold = useRef(false);
  /**
   * 進行中のスピンの世代。finishRoulette は「自分が始めたスピンの完了か」を
   * これで判定する — rouletteHold の真偽だけだと、遅れて来た2回目の完了が
   * 次のスピンの開始後に走ったとき hold が true に戻っているので素通りし、
   * 新しいリールの安全弁を消してアンマウントしてしまう。
   */
  const rouletteSpinId = useRef(0);
  /** 回転中BGM。スピンの連鎖(キュー消化)をまたいで1曲を流し続ける。全出口で stop。 */
  const rouletteBgm = useRef<BgmHandle | null>(null);
  /** リール回転ループ音。onSpinQuiet(終盤の段の入り)で毎スピン止める。全出口で stop。 */
  const rouletteSpinSe = useRef<BgmHandle | null>(null);
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
  /**
   * リール中・カットイン再生中に届いたカットインの持ち越し。
   * 1件だと3本目が黙って消えるので配列(worker の凍結が直列化するので2件で足りる)。
   */
  const pendingBands = useRef<ChallengeEffect[]>([]);
  /** 再生中のカットインBGM。すべての出口(finish/abort/unmount)で stop する。 */
  const bandBgm = useRef<BgmHandle | null>(null);

  // ── タップブースト(フィーバー) ─────────────────────────────────────────
  // boost-start effect → 起動カットイン(咆哮・boostIntroMs)→ カウントダウン
  // (3/2/1 焼き込み動画・boostCountMs)→ タップウィンドウ(ループ動画+BGM・
  // タップカウンタ表示)→ boost-end effect → カウンタから7セグへ弾 → 着弾で
  // 据え置き解除(worker の一括減算値へ収束)。各段のクリップ id と尺・期限は
  // effect の焼き込み値が権威(worker の凍結と同期)。
  const [boostClip, setBoostClip] = useState<{
    key: number;
    phase: 'intro' | 'count' | 'window' | 'result';
    url: string | null;
    out: boolean;
  } | null>(null);
  /** 据え置きの持ち主がブーストである印(rouletteHold / bandHold と同じ役割)。 */
  const boostHold = useRef(false);
  const boostTimers = useRef<number[]>([]);
  /** 再生中のブーストのトリガー effect(倍率バッジ・終了フォールバックに使う)。 */
  const boostEffect = useRef<ChallengeEffect | null>(null);
  /** テスト再生(▶)の印。据え置きを張らず、boost-end を待たず自前で締める。 */
  const boostTest = useRef(false);
  /** 他演出中に届いたブーストの持ち越し(pendingBands と同型・2件上限)。 */
  const pendingBoosts = useRef<ChallengeEffect[]>([]);
  /** タップカウンタ(着弾の発射点)。 */
  const boostCounterRef = useRef<HTMLDivElement | null>(null);
  /** タップ数の前回値(増加検知で press 音とカウンタのパンチを出す)。 */
  const prevBoostTap = useRef(0);
  /**
   * テスト再生(▶)中に最後に見た worker のタップ数のミラー。タップ計数は実発動・
   * 実演とも worker が持ち(challenge.boost.tapCount — F9/PUSH/メイン窓 Space/
   * モニターの全経路が press RPC に統一)、表示はそれを読むだけ。この ref は
   * finishBoostFx(タイマークロージャ)用 — 実演ウィンドウの期限直後は worker が
   * boost を落とすので、challenge state を直接読むと 0 に巻き戻る競合がある。
   */
  const boostTestTapRef = useRef(0);
  /**
   * 清算発表(パチンコ風「-N」ロールアップ)のオーバーレイ。boost-end 受信が起点で、
   * roll(桁回転)→ lock(全桁確定)→ fly(7セグへ発射)と進む。回転中の桁文字は
   * rAF から boostSettleAmtRef.textContent へ直書きし(毎フレーム setState で
   * React を回さない)、stage 遷移だけ setState する。タイムラインの決定は
   * shared/boost-settle.ts の純関数(planBoostSettle / rollupDisplayAt)。
   */
  const [boostSettle, setBoostSettle] = useState<{
    key: number;
    stage: 'roll' | 'lock' | 'fly';
    amount: number;
    tap: number;
    mult: number;
    seed: number;
    rollupMs: number;
  } | null>(null);
  /** 発表オーバーレイ(発射点)と回転数字の DOM。 */
  const boostSettleRef = useRef<HTMLDivElement | null>(null);
  const boostSettleAmtRef = useRef<HTMLDivElement | null>(null);
  /** ロールアップの rAF id(clearBoostTimers が必ず止める — heldValue 孤児化防止)。 */
  const boostRollupRaf = useRef<number | null>(null);

  // ── ストック着弾カットイン ───────────────────────────────────────────────
  // ストック満杯の2発目(緑)が7セグに着弾した瞬間から STOCK_CUTIN_MS の間、
  // 不透明フルフレーム動画(音声焼き込み・unmute)を重ね、数字は据え置いたまま
  // reveal(revealStock)を動画の終端まで遅らせる。タイマーは strikeTimers に
  // 相乗りする — 着弾チェーンの延長線なので、出口(flushStrike)も共有できる。
  const [stockCutin, setStockCutin] = useState<{ key: number; out: boolean } | null>(null);
  /** 据え置きの持ち主がストックカットインである印(rouletteHold / bandHold と同じ役割)。 */
  const stockCutinHold = useRef(false);
  /**
   * reveal で使うボーナス量。state に載せると setTimeout 経由の finishStockCutin が
   * 古いレンダーのクロージャ(null)を読む — bandEffect と同じ「同期値は ref」の流儀。
   */
  const stockCutinDelta = useRef(0);

  // CLEAR リザルトへの切り替えタイマー。演出ホールド中は張らない —
  // achieved は pendingAchieved で持ち越され、finish* が再生した時点で
  // achievedFxAt が更新されて再実行される(state 依存)。これが無いと、
  // バンドカットイン中の CLEAR で 2.5 秒後に不透明動画の裏でリザルトへ
  // 切り替わり、「カットイン → CLEAR 演出 → リザルト」の順序が壊れる。
  // deps はオブジェクトではなく boolean に畳む — roulette/bandClip/boostClip は
  // フェード({...c, out:true})等で参照が変わるたびにタイマーを張り直していた。
  //
  // 【不変条件】最前面のオーバーレイを描く state は**全部**ここに並べること。
  // boostSettle だけ名前が *Clip で終わらないため長らく漏れていた: 清算発表は
  // finishBoostFx の startRoll が setBoostClip(null) してから setBoostSettle(...) を
  // 呼ぶので、roll/lock/fly(最長 rollup 2200 + hold 650 + 飛翔 420 ≒ 3.3 秒)の
  // あいだ「オーバーレイが出ているのに busy=false」になり、CLEAR のリザルト画面が
  // ロールアップの上に生えていた(7セグが 0 に着く前・CLEAR 演出の前)。
  // ref 由来にしてはいけない — ref は再レンダーを起こさないので、下の2つの
  // effect が解除時に再実行されず「リザルトが永久に出ない」側へ静かに壊れる。
  const fxHoldBusy =
    roulette !== null ||
    bandClip !== null ||
    stockCutin !== null ||
    boostClip !== null ||
    boostSettle !== null;

  /*
   * 保留バナーの最後の砦 — 全カットアニメーションが終わった瞬間に、取り残された
   * 「いいね妨害」「いいねストック満杯」を必ず出す。
   *
   * 着弾(impactStrike / revealStock)や flushStrike が拾えない残りがここに来る:
   * status が running でなく queueStrike されなかった / effect だけ遅れて届く
   * flushLikeFx 経路 / handoff で持ち越したまま持ち越しチェーンが無い、など。
   * チェーンか持ち越しがあるならそちらの着弾に任せる(maybeFlushDeferredFloats の
   * 判定)— ここで先に出すと「アニメーション → 通知」の順序が壊れる。
   *
   * fxHoldBusy は state 由来なので解除時に必ず再レンダーが走る。finish* は同期で
   * runDrain → drainPendingStrike → startStrike まで走ってから再レンダーされるため、
   * 次のチェーンが張られていればこの effect は no-op になる(順序は安全)。
   */
  useEffect(() => {
    maybeFlushDeferredFloats();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fxHoldBusy]);

  useEffect(() => {
    if (!hasResult) {
      setShowResult(false);
      setAchievedFxAt(null);
      return;
    }
    if (fxHoldBusy) return;
    // 達成後に開き直したモニターは待たずに出す(achievedMs が過去なので残り 0)。
    const base = achievedFxAt ?? challenge?.achievedMs ?? 0;
    const wait = Math.max(0, RESULT_DELAY_MS - (Date.now() - base));
    if (wait === 0) {
      setShowResult(true);
      return;
    }
    const t = setTimeout(() => setShowResult(true), wait);
    return () => clearTimeout(t);
    // 依存は boolean と数値・軽い state だけ — 2Hz で同じ result が再配信されても
    // タイマーは再起動しない。
  }, [hasResult, challenge?.achievedMs, achievedFxAt, fxHoldBusy]);

  useEffect(() => {
    // ワーカー再起動中は rpc が throw する — この窓にはトーストが無いので握って
    // ポーリング/delta での回復に任せる(catch しないと unhandled rejection)。
    const safeCfg = () => rpc('cfg.get', undefined).then(setCfg).catch(() => undefined);
    const safeChallenge = () => void rpc('challenge.get', undefined).then(setChallenge).catch(() => undefined);
    // 初回試行の完了(失敗込み)で watermark を解禁する。失敗時も解禁するのは、
    // ポーリング復旧(下の 120 秒)まで演出を全停止させないため — cfg 依存の
    // 演出だけが欠け、数字とバナーは動き続ける(従来の縮退と同じ)。
    void safeCfg().finally(() => setCfgTried(true));
    safeChallenge();
    // カットインを実際に再生できるか(reduced-motion でないか)を worker へ申告する。
    // worker はこれとモニター窓の開閉(main 発)の AND が立つときだけカットイン
    // 凍結を張る — 再生されないカットインのためにカウントダウンだけ止まる事故を防ぐ。
    // OS 設定の切替は matchMedia の change で即時追従、worker 再起動は 120 秒
    // ポーリングへの相乗りが保険(それまでは凍結が張られないだけの fail-open)。
    const sendCaps = (): void => {
      void rpc('challenge.fxCaps', { bandFx: !prefersReducedMotion() }).catch(() => undefined);
    };
    sendCaps();
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    mq.addEventListener('change', sendCaps);
    // 保存(cfg.set)は即時プッシュで受け、ポーリングは取りこぼしの保険なので
    // 120秒で十分(この窓は backgroundThrottling 無効で常時フル稼働のため、
    // 保険の RPC を刻むほど長時間配信の負荷になる)。challenge も同じ保険に
    // 相乗りさせ、初回取得の失敗(=「読み込み中…」固着)から復帰できるようにする。
    const offSettings = window.api.onSettings(setCfg);
    const t2 = setInterval(() => {
      void safeCfg();
      safeChallenge();
      sendCaps();
    }, CFG_POLL_MS);
    return () => {
      offSettings();
      mq.removeEventListener('change', sendCaps);
      clearInterval(t2);
    };
  }, []);

  useEffect(() => {
    if (!challenge) return;
    document.title = challenge.title || 'チャレンジモニター';
    // watermark(playEffect)と同じく cfg の初回試行を待つ — ここが先に走って
    // pendingStrike を積むと、譲った先の演出は watermark 初期化
    // (mountPlaysTest が非 test を全部「再生済み」に倒す)で誰も再生せず、
    // 持ち越しだけ残留して数分後の finish* で因果不明の着弾演出が突然出る。
    if (!cfgTried) return;

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

    // ゲージ満タン由来かは fills の単調増加で判定する。recentEffects を見ないのは、
    // watermark の 5 秒ゲートで落ちた古い演出とラッチがズレるのを避けるため。
    // 譲る判定より前に出しておく — 譲るときも「満タンが起きた」事実は要る。
    const units = fills !== null && prevF !== null ? fills - prevF : 0;
    const likeDelta = units > 0 ? units * step : 0;
    // ストック満杯はゲージ満タンと同じ tick でしか起きない(worker の従属関係)。
    // 満杯分も据え置いて2段目の着弾まで持ち越す — 引き忘れるとボーナスが
    // ゲージ演出より先に7セグへ出る(因果逆転)。
    const stockUnits = sFills !== null && prevSF !== null ? sFills - prevSF : 0;
    const stockDelta = stockUnits > 0 ? stockUnits * (stock?.step ?? 0) : 0;

    // 「値が変わっていない」だけでは帰れない — 押下(−1)といいね満タン(+1)が
    // 同一デルタで相殺すると value は不変のまま fills だけ進む。ここで帰ると
    // prevFills は上で前進済みなので、着弾チェーン(音・光・バナー)が恒久的に
    // 1回ぶん消える。fills/stock の進みがあれば下の着弾判定まで進む。
    if (prevV === challenge.value && likeDelta <= 0 && stockDelta <= 0) return;

    // 2Hz のデルタはボタン押下といいね満タンを1スナップショットに相乗りさせうる。
    // 丸ごと据え置くと押下の手応えが 0.72 秒遅れるので、いいね分だけを持ち越す。
    // 減算ぶんが現在値を超えるとき(ゴール間際など)は 0 に切り上げる —
    // 負のまま弾くと着弾チェーンが無言で丸ごと落ちる。
    const heldRaw = challenge.value - likeDelta - stockDelta;
    const held = Math.max(0, heldRaw);
    if (heldRaw < 0 && likeDelta > 0) {
      fxWarn('着弾の据え置き値が負 — 0 に切り上げ', {
        value: challenge.value,
        likeDelta,
        stockDelta,
      });
    }

    // ルーレット演出中は据え置きを守る — 着弾ラッチや通常パンチで上書きすると
    // リールが止まる前に数字がネタバレする。反映は finishRoulette が行い、
    // 解除は常に null 代入なので worker 値へ必ず収束する。
    // カットイン(バンド演出)中も同じ理由で守る — 反映は finishBandFx が行う。
    // ストック着弾カットイン中も同様(再満杯は reveal 時に worker 値へ一括収束)。
    //
    // 同一デルタの場合: この effect は演出再生(playEffect)より先に走るので、
    // これから再生される未再生ルーレット/カットインがあればラッチを譲る(直後に
    // startRoulette / startBandFx が張る)。5秒超の取りこぼしは演出側もスキップ
    // するので、そのときは譲らず通常どおり着弾/パンチへ進む。
    // 未再生 effect に譲るのは「本当にリール/カットインが始まる」ものだけ —
    // 盤面欠損・未知クリップ id・動きの抑制で始まらない effect に譲ると、
    // 譲った先が何も出さず、着弾もパンチも丸ごと消える(誰も再生しない)。
    const yieldToCutin =
      rouletteHold.current ||
      bandHold.current ||
      stockCutinHold.current ||
      boostHold.current ||
      // watermark 未確立(lastPlayed=null)では譲らない — 直後の watermark 初期化が
      // 全件を「再生済み」に倒すので、譲った先は誰も再生しない。鮮度は playEffect と
      // 同じ isChallengeEffectFresh(test 演出は 15 秒)— 生の 5000 を置くと、
      // 5〜15 秒経った test ルーレットで「譲らないのに再生はする」ズレが生まれ、
      // startRoulette の flushStrike が飛行中の着弾チェーンを打ち切る。
      (lastPlayed.current !== null &&
        challenge.recentEffects.some(
          (e) =>
            e.id > lastPlayed.current! &&
            isChallengeEffectFresh(e, Date.now()) &&
            (e.kind === 'roulette'
              ? rouletteWillSpin(e)
              : e.kind === 'boost-start'
                ? boostWillStart(e)
                : e.kind === 'gift' && e.fxBandClip != null && bandWillStart(e))
        ));

    if (yieldToCutin) {
      // 譲るのは「数字の据え置き」だけ。着弾した事実まで捨てると、ゲージが 0 に
      // 戻ったのに音も光もバナーも出ない(演出が丸ごと消える最大の経路だった)。
      // ストック満杯分も必ず持ち越す — 落とすと緑弾・カットイン・SE が永久に消える。
      // 実際の再生は解除の瞬間に drainPendingStrike がフルチェーン1本で行う。
      if ((likeDelta > 0 || stockDelta > 0) && challenge.status === 'running') {
        queueStrike(likeDelta, stockDelta);
      }
      return;
    }

    // チェーン飛行中は再スタートも flushStrike もしない — startStrike 冒頭の
    // clearStrikeTimers や下の flushStrike が前チェーンの着弾を無再生で潰すため、
    // 連続満タン時に着弾演出(パンチ/粒子/クリップ/SE)が一度も出なくなる
    // (実配信でいいねが流れ続けると常時この経路に入る)。合算して持ち越し、
    // 現行チェーンの着弾後に1本のチェーンとして出す。値のみの変化(押下/ギフト)
    // もここで止める — 数字の反映は着弾時の null 収束が引き受ける。
    if (strikeTimers.current.length > 0) {
      if ((likeDelta > 0 || stockDelta > 0) && challenge.status === 'running') {
        queueStrike(likeDelta, stockDelta);
      }
      return;
    }

    const canStrike =
      likeDelta > 0 &&
      challenge.status === 'running' &&
      // held は上で 0 に切り上げ済みなので、ここでは「着弾で数字が増えて見える」
      // (held < value)ことだけを見る。以前は held >= prevV を課していたが、
      // カットイン凍結(worker の fxFreeze)が明けると凍結中の押下といいね満タンが
      // 1デルタに合流して held < prevV になり、実配信ではほぼ毎回この条件で着弾演出
      // (gauge-full の効果音・クリップ・粒子)が丸ごと落ちていた。押下ぶんの手応えは
      // startStrike が据え置きを張る前に通常パンチとして見せるので失われない。
      held < challenge.value &&
      !prefersReducedMotion();

    if (likeDelta > 0 && challenge.status === 'running' && !canStrike && prefersReducedMotion()) {
      fxWarn('reduced-motion: ゲージ満タンの着弾演出をスキップ(数字は即時更新)');
    }

    if (canStrike) {
      startStrike(held, prevV, likeDelta, stockDelta);
      return;
    }

    flushStrike(); // 保留があれば畳んでから通常のパンチへ
    // 相殺デルタ(値不変・着弾だけ不成立)ではパンチしない — 方向が決められない。
    if (prevV !== challenge.value) {
      setPunchDir(challenge.value < prevV ? 'down' : 'up');
      setPunchKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.value, challenge?.title, challenge?.likeGauge?.fills, challenge?.likeGauge?.stock?.fills, challenge?.status, cfgTried]);

  // タイマーをアンマウント跨ぎで生き残らせない(BGM も止め忘れない)。
  useEffect(
    () => () => {
      clearStrikeTimers();
      clearRouletteTimers();
      clearBandTimers();
      clearBoostTimers();
      clearRepeatTimers();
      clearMiniTimers();
      clearFloatTimers();
      if (gaugeTickRaf.current !== 0) cancelAnimationFrame(gaugeTickRaf.current);
      clearClipTimer();
      clearStrikeClipTimer();
      clearShakeTimer();
      bandBgm.current?.stop(0);
      bandBgm.current = null;
      stopRouletteSound(0);
    },
    []
  );

  // 停止/リセット(idle)でスピン・カットインを打ち切る。achieved はここでは触らない —
  // 'sub' 方向で 0 到達した場合はリールを最後まで見せてから達成演出を出す。
  useEffect(() => {
    if (challenge?.status === 'idle') {
      abortRoulette();
      abortBandFx();
      abortBoostFx();
      clearRepeatTimers();
      clipQueue.current = [];
      // 着弾待ちのバナーも捨てる — 停止/リセット後に古い通知を出さない。
      pendingLikeFloats.current = null;
      pendingStockFloats.current = null;
      // 再生中のギフトクリップ・着弾クリップ・簡易演出・フラッシュも片付ける —
      // clipQueue だけ空にして再生中の1本を残すのは非対称だった(リセット直後に
      // 前ランの演出が流れ続ける)。floats は自アニメ終了で消えるので触らない。
      clearClipTimer();
      clipKey.current = null;
      setClip(null);
      clearStrikeClipTimer();
      setStrikeClip(null);
      clearMiniTimers();
      setMinis([]);
      setFlashes([]);
      // ストック着弾カットインも打ち切る(約5秒あるので明示的に)。保留バナーは
      // 直前で空にしてあるので flushStrike のバナー出力は no-op。
      flushStrike();
      // 持ち越しと飛行中の残は flushStrike の requeue より後で捨てる —
      // リセット後に前ランの着弾を復活させない。
      activeStrike.current = null;
      pendingStrike.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.status]);

  // ブースト中のタップ数。実発動・テスト再生(▶)とも worker の
  // challenge.boost.tapCount が権威(実演中も worker がウィンドウを持って数える)。
  const shownBoostTap = challenge?.boost?.tapCount ?? 0;

  // ブースト中のタップ検知。press effect はブースト中は積まれない(worker は
  // 数えるだけ)ので、タップの手応えはここが受け持つ — カウンタのパンチは
  // key 再マウント(render 側)、音はこの effect が press スロットで鳴らす。
  useEffect(() => {
    const prev = prevBoostTap.current;
    prevBoostTap.current = shownBoostTap;
    // テスト再生中は「最後に見た worker のタップ数」を持ち越す(0 巻き戻りは
    // 無視 — 実演ウィンドウの期限で worker が boost を落とした直後の delta 対策)。
    if (boostTest.current && shownBoostTap > boostTestTapRef.current) {
      boostTestTapRef.current = shownBoostTap;
    }
    if (shownBoostTap > prev && boostHold.current && cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['press'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['press'])
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shownBoostTap]);

  // 効果音(視覚とは独立の watermark)。モニターが開いている間はここが鳴らし、
  // ダッシュボード側は monitorOpen ゲートで黙る。設定は 120 秒ポーリング(CFG_POLL_MS)(上の
  // cfg 再取得)経由なので、音量変更の反映は最大 120 秒遅れる。
  // challenge を cfgTried でゲートするのは視覚側の watermark と同じ理由 —
  // cfg 前に watermark が確立すると、実演の音が既定割り当てで鳴ってしまう。
  useChallengeSe(cfgTried ? challenge : null, {
    active: true,
    enabled: cfg?.challenge.seEnabled ?? true,
    volume: cfg?.challenge.seVolume ?? 70,
    sounds: cfg?.challenge.seSounds,
    volumes: cfg?.challenge.seVolumes,
    mountPlaysTest: true,
  });

  // ── 演出再生(冪等) ─────────────────────────────────────────────────────
  // watermark の規約(マウント倒し / id 巻き戻り追従 / 鮮度ゲート)は shared の
  // freshChallengeEffects に集約。mountPlaysTest: マウント直後の最初のスナップ
  // ショットに test 演出(設定画面の ▶ 実演再生)が含まれていたら再生する —
  // ウィンドウ生成が実演の push より遅いと、従来は無言で「再生済み」に倒れて
  // 「▶ を押しても何も起きない、2回目は出る」になっていた。
  // cfgTried まで開始を遅らせるのは、cfg null のまま再生すると簡易演出/クリップ/SE
  // が全部スキップされるため(cfg.get と challenge.get は並走している)。
  useEffect(() => {
    if (!challenge || !cfgTried) return;
    const { next, play } = freshChallengeEffects(
      challenge.recentEffects,
      lastPlayed.current,
      Date.now(),
      { mountPlaysTest: true }
    );
    if (lastPlayed.current !== null) {
      const stale =
        challenge.recentEffects.filter((e) => e.id > lastPlayed.current!).length - play.length;
      if (stale > 0) fxWarn(`鮮度ゲート超過の演出を${stale}件スキップ(復帰直後の演出ストーム防止)`);
    }
    lastPlayed.current = next;
    for (const e of play) playEffect(e);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.recentEffects, cfgTried]);

  function pushFloat(node: React.ReactNode, cls: string): void {
    // key は updater の**外**で採番する — StrictMode は updater を二重実行するので、
    // 中で ++fxKey すると下のタイマーが存在しない key を掴む。
    const key = ++fxKey;
    setFloats((f) => [...f.slice(-(FLOAT_MAX - 1)), { key, node, cls }]);
    // 安全弁: floats だけ安全弁を持っていなかった。遮蔽ウィンドウで animationend が
    // 届かないとバナーが固着し、FLOAT_MAX=3 の枠を食って以後のバナーが出なくなる。
    // playMini と同じ自己削除方式 — 配列は FLOAT_ABORT_MS 窓で自然に有界。
    const tid = window.setTimeout(() => {
      const a = floatTimers.current;
      const at = a.indexOf(tid);
      if (at !== -1) a.splice(at, 1);
      setFloats((s2) => s2.filter((x) => x.key !== key));
    }, FLOAT_ABORT_MS);
    floatTimers.current.push(tid);
  }
  function clearFloatTimers(): void {
    for (const t of floatTimers.current) window.clearTimeout(t);
    floatTimers.current = [];
  }
  function pushFlash(cls: string): void {
    setFlashes((f) => [...f.slice(-3), { key: ++fxKey, cls }]);
  }
  function pushShake(cls: string): void {
    setShake({ key: ++fxKey, cls });
    // 安全弁: clip/mini と同型。animationend 単独依存だと遮蔽でクラスが固着し、
    // 以後すべての揺れが黙って消える(SHAKE_ABORT_MS のコメント参照)。
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
    shakeTimer.current = window.setTimeout(() => {
      shakeTimer.current = null;
      setShake(null);
    }, SHAKE_ABORT_MS);
  }
  function clearShakeTimer(): void {
    if (shakeTimer.current !== null) window.clearTimeout(shakeTimer.current);
    shakeTimer.current = null;
  }
  function clearClipTimer(): void {
    if (clipTimer.current !== null) window.clearTimeout(clipTimer.current);
    clipTimer.current = null;
  }
  function clearStrikeClipTimer(): void {
    if (strikeClipTimer.current !== null) window.clearTimeout(strikeClipTimer.current);
    strikeClipTimer.current = null;
  }
  /** 着弾クリップを安全弁つきで出す(impactStrikeVisuals / revealStock の共通経路)。 */
  function showStrikeClip(x: number, y: number, size: number): void {
    const key = ++fxKey;
    setStrikeClip({ key, x, y, size });
    clearStrikeClipTimer();
    strikeClipTimer.current = window.setTimeout(() => {
      strikeClipTimer.current = null;
      setStrikeClip((c) => (c?.key === key ? null : c));
    }, STRIKE_CLIP_ABORT_MS);
  }
  /**
   * <video> の autoplay を明示的に観測する。autoPlay 属性の再生失敗は promise の
   * reject としてしか現れず(error イベントは出ない)、放置すると各ホルダーが
   * 尺いっぱい黒画面のまま固着する — 失敗したら即 onFail(各層の終了経路)へ。
   * dataset ガードで再レンダーの ref 再呼び出しでは多重 arm しない(key 変更 =
   * 新要素でだけ再 arm される)。
   */
  function armVideoPlay(v: HTMLVideoElement | null, label: string, onFail: () => void): (() => void) | undefined {
    if (!v) return undefined;
    if (!v.dataset.playArmed) {
      v.dataset.playArmed = '1';
      v.play().catch((err: unknown) => {
        fxWarn(`${label}: play() が拒否された`, err);
        onFail();
      });
    }
    // ref cleanup(React 19)でメディアリソースを即時解放する。演出のたびに
    // key 再マウントで <video> を作り捨てる設計のため、GC 任せだと Chromium の
    // レンダラ毎メディアプレイヤ上限に達して play() が reject し始める
    // (= 時間が経つと演出動画だけ出なくなる)。cleanup は再レンダーの ref
    // 付け替えでも走るので、マイクロタスクで commit 完了を待ってから
    // 「DOM から外れた要素だけ」を解放する — 再生中の要素には触れない。
    return () => {
      queueMicrotask(() => {
        if (v.isConnected) return;
        v.pause();
        v.removeAttribute('src');
        v.load();
      });
    };
  }
  function startClip(url: string): void {
    const key = ++fxKey;
    clipKey.current = key;
    setClip({ key, url });
    clearClipTimer();
    // 安全弁: onEnded が来ない素材/遮蔽ウィンドウで再生中フラグが固着すると、
    // 以後クリップが永久に出なくなる(直したいバグより悪い)。
    clipTimer.current = window.setTimeout(() => nextClip(key), CLIP_ABORT_MS);
  }
  /** 1本終わったので次を出す。古い video の後始末(差し替え済み)は無視する。 */
  function nextClip(finishedKey: number): void {
    if (clipKey.current !== finishedKey) return;
    clearClipTimer();
    const next = clipQueue.current.shift();
    if (next !== undefined) {
      startClip(next);
      return;
    }
    clipKey.current = null;
    setClip((c) => (c?.key === finishedKey ? null : c));
  }
  /**
   * 演出クリップを再生。null(未割り当て/無効)なら何もしない。
   * 既定は 'queue' — 再生中なら順番待ちにする(**別々に届いた連続ギフトが
   * 前を打ち切って1本しか見えない**のを直す)。'restart' は連打の2発目以降で、
   * 同じクリップを頭から撃ち直して「再点火」に見せるために使う
   * (同じ4秒クリップを5本キューすると20秒になって反復が見えないため)。
   */
  function playClip(url: string | null, mode: 'queue' | 'restart' = 'queue'): void {
    if (!url) return;
    if (mode === 'restart' || clipKey.current === null) {
      startClip(url);
      return;
    }
    if (clipQueue.current.length < CLIP_QUEUE_MAX) clipQueue.current.push(url);
  }

  /**
   * 簡易演出を**カウント数字の左上**へ出す。id が null(未割り当て/無効)なら
   * 何もしない。位置は canvas エンジンの pointFor を借りてステージ座標で取る。
   *
   * 数字の実体は .seg-digit。countdownRef(.countdown)も .seg-row も
   * ステージ全幅なので、そちらを測ると「左上」がステージの左上になってしまう
   * — 必ず先頭桁の要素を測ること。.countdown は punchKey で値が変わるたび
   * 再マウントするので、ref をキャッシュせずここで毎回引き直す。
   *
   * かつては数字の中心に重ねていたが、7セグと数字が読めなくなるため外へ出した。
   * 桁数が変わると数字の左端は動くので、左端まで寄せきったときは
   * ステージ左端で止める(位置が桁数で暴れない)。
   */
  function playMini(id: string | null, amount: number, shot = 0): void {
    if (!id) return;
    // validate 済みの cfg 経由なら来ないはずだが、バージョン混在(旧モニター窓 +
    // 新設定)では起こりうる — 無言で消さず理由を残す。
    if (!CHALLENGE_MINI_IDS.includes(id)) {
      fxWarn('未知の簡易演出 id — スキップ', id);
      return;
    }
    const stageW = landscape ? STAGE_LW : STAGE_W;
    const stageH = landscape ? STAGE_LH : STAGE_H;
    const d = fxRef.current?.pointFor(countdownRef.current?.querySelector('.seg-digit') ?? null);
    const c = fxRef.current?.pointFor(countdownRef.current);
    // エンジン未接続 / 測れないときは、縦横それぞれのだいたいの数字位置へ退避。
    const digitsLeft = d ? d.x - d.w / 2 : stageW * 0.16;
    const digitsTop = d ? d.y - d.h / 2 : stageH * 0.28;
    const digitH = d ? d.h : stageH * 0.24;
    // 上端は count セル(=数字の領域)から出さない。横ステージはタイトル帯が
    // すぐ上に来るので、これが無いと帯へ食い込む。
    const ceiling = Math.max(c ? c.y - c.h / 2 : MINI_EDGE, MINI_EDGE);
    // 数字の高さに合わせつつ、数字より上に残っている高さへ必ず収める
    // (h <= digitsTop - GAP - ceiling なので y >= ceiling が保証される)。
    const room = digitsTop - MINI_GAP - ceiling;
    const h = Math.max(84, Math.min(digitH * (id === 'panic' ? 0.62 : 0.7), 300, room));
    const w = id === 'panic' ? h * PANIC_AR : h;
    // 連打で完全に重なると1枚にしか見えないので、発火ごとに少しずらす。
    const key = ++fxKey;
    const jitter = (((key + shot) % 3) - 1) * 14;
    const x = Math.max(MINI_EDGE, digitsLeft - MINI_GAP - w + jitter);
    const y = Math.max(MINI_EDGE, digitsTop - MINI_GAP - h);
    setMinis((m) => [...m.slice(-(MINI_MAX - 1)), { key, id, amount, x, y, w, h }]);
    // 安全弁: 遮蔽ウィンドウでは onAnimationEnd が来ないので必ず畳む。
    // repeatTimers と同じく発火時に自分の id を配列から抜く — 旧実装の
    // slice(-32) は、1.2 秒内に33件以上の playMini が走ると未発火タイマーが
    // 配列から落ちて clearMiniTimers で回収できなくなっていた(リセット直後に
    // mini が1枚だけ出る)。自己削除なら配列は MINI_ABORT_MS 窓で自然に有界。
    const tid = window.setTimeout(() => {
      const a = miniTimers.current;
      const at = a.indexOf(tid);
      if (at !== -1) a.splice(at, 1);
      setMinis((m) => m.filter((x2) => x2.key !== key));
    }, MINI_ABORT_MS);
    miniTimers.current.push(tid);
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

  /**
   * 着弾待ちの保留を1枚にまとめて出す(保留なしなら no-op)。node は畳んだ合計 +N で
   * ここで組む。ref を先に null にしてから push するので、どの出口から二重に
   * 呼ばれてもバナーは1枚しか出ない。
   */
  function flushPendingFloat(
    ref: { current: PendingFloat | null },
    render: (amount: number) => React.ReactNode
  ): void {
    const p = ref.current;
    if (p === null) return;
    ref.current = null;
    pushFloat(render(p.amount), 'bad like-float');
  }

  /**
   * 保留バナー判定(shared/fx-floats)に渡す現在の演出状況。ホールドは全部 ref
   * なので同期で読める。over は「この関数の中ではもう畳んだ」を伝える上書き用。
   */
  function floatHoldState(over?: Partial<FloatHoldState>): FloatHoldState {
    return {
      chainActive: strikeTimers.current.length > 0,
      strikePending: pendingStrike.current !== null,
      cutinActive:
        rouletteHold.current || bandHold.current || stockCutinHold.current || boostHold.current,
      ...over,
    };
  }

  /**
   * 保留バナーを「いいね妨害 → ストック満杯」の順で出す。畳み込みで最大2枚に
   * なったので FLOAT_MAX(3枠)の押し出しはもう起きないが、主役(ストック満杯)を
   * 後 = 手前に置く並びは revealStock の既存順として維持する。
   */
  function flushDeferredFloats(): void {
    flushPendingFloat(pendingLikeFloats, likeFloatNode);
    flushPendingFloat(pendingStockFloats, stockFloatNode);
  }

  /** 出す先の演出が誰もいないときだけ出す。取りこぼし防止の共通口。 */
  function maybeFlushDeferredFloats(): void {
    if (shouldFlushDeferredFloats(floatHoldState())) flushDeferredFloats();
  }

  /** 持ち越しキューへの合算。チェーン飛行中・カットイン中の満タン/満杯を積む。 */
  function queueStrike(like: number, stock: number): void {
    const q = pendingStrike.current ?? { like: 0, stock: 0 };
    q.like += like;
    q.stock += stock;
    pendingStrike.current = q;
  }

  /**
   * 持ち越した満タン/満杯をフルチェーン1本として出す。呼ぶのは「据え置きの
   * 持ち主がいなくなった瞬間」だけ(着弾・カットイン/リール終了で次演出を
   * 始めないパス・安全弁)— 直後に startRoulette / startBandFx が走る場所で
   * 呼ぶと、その冒頭の flushStrike が出したばかりのチェーンを畳んでしまう
   * (畳まれても activeStrike 経由で requeue はされるが、無駄な空振りになる)。
   */
  function drainPendingStrike(): void {
    const p = pendingStrike.current;
    // 持ち越しが無い = 演出が全部終わって誰もチェーンを張らないパス。runDrain の
    // idle 経路は必ずここを通るので、取り残された保留バナーはここでも拾う。
    if (!p) return maybeFlushDeferredFloats();
    pendingStrike.current = null;
    if (p.like <= 0 && p.stock <= 0) return maybeFlushDeferredFloats();
    if (prefersReducedMotion()) {
      fxWarn('reduced-motion: 持ち越し着弾をスキップ(数字は反映済み)');
      // チェーンを張らないので着弾は来ない — 保留バナーはここで出し切る。
      flushDeferredFloats();
      return;
    }
    // 据え置きは最新 worker 値から持ち越し分を戻した値。prevValue は delta の
    // たびに前進しているので、ここで読む値は常に「適用済みの現在値」。
    const v = prevValue.current ?? 0;
    const held = Math.max(0, v - p.like - p.stock);
    if (held >= v) {
      impactStrikeVisuals(); // v=0 等で据え置けない — 音と光だけ出す
      // impactStrikeVisuals が流すのは like のみ。ストック満杯の保留がここで
      // 取り残されるので、両方まとめて出し切る。
      flushDeferredFloats();
      return;
    }
    startStrike(held, held, p.like, p.stock); // held===prevV なので余計なパンチは出ない
  }

  /**
   * 保留中の据え置きを即座に畳む。数字は常に worker の値へ収束する。
   *
   * @param handoff true = 直後に別演出が始まる(startRoulette / startBandFx /
   *   startBoostFx の冒頭)。このとき保留バナーは**出さずに持ち越す** — ここで
   *   出すと、演出明けに drainPendingStrike が本番の着弾を再生してもキューが
   *   空でバナーが二度と出ない(「ストック満杯バナーが出ないことがある」の本体)。
   *   持ち越したバナーは着弾(impactStrike / revealStock)か、全カットイン終了時の
   *   ウォッチドッグ(fxHoldBusy の effect)が必ず出す。
   *   これらの start* は hold フラグを立てる**前**に呼ぶので、floatHoldState の
   *   cutinActive では「これから始まる」が見えない — だから引数で渡す。
   */
  function flushStrike(handoff = false) {
    clearStrikeTimers();
    // 飛行中チェーンの未着弾ぶんは捨てずに持ち越しへ戻す — startRoulette /
    // startBandFx の横取りで畳まれた着弾(ストックカットイン含む)は、演出明けの
    // drainPendingStrike が再生する。pendingStrike 自体はここでは消費しない。
    // 消費するのは drainPendingStrike と、停止・リセット(下の status effect)だけ。
    const a = activeStrike.current;
    activeStrike.current = null;
    if (a && (a.like > 0 || a.stock > 0)) queueStrike(a.like, a.stock);
    // カットイン中の安全弁経路でもここに来る。stockCutin が null なら両行とも
    // no-op なので、ストックなしの従来 strike 経路の挙動は変わらない。
    stockCutinHold.current = false;
    setStockCutin((c) => (c === null ? c : null));
    // 着弾を待っていたバナーも取り残さない(安全弁経路でも必ず表示される)。
    // ただし出す先(持ち越し・これから始まる演出)が居るなら持ち越したまま —
    // ここで単独に出すと「アニメーション → 通知」が壊れ、本番の着弾では消える。
    // chainActive はこの関数がたった今畳んだので false 固定で判定する。
    if (!handoff && shouldFlushDeferredFloats(floatHoldState({ chainActive: false }))) {
      flushDeferredFloats();
    }
    setHeldValue((h) => (h === null ? h : null));
  }

  /**
   * 安全弁(setTimeout 抑制などで着弾ビートが飛んだとき)専用の畳み方。
   * この着弾自体はバナーのみで畳み(従来挙動)、持ち越しがあれば続けて出す。
   * 持ち越しがあるときはバナーもそちらの着弾へ回る(flushStrike が保留したまま
   * にし、直後の drainPendingStrike が張るチェーンで出る)。
   * 横取り(startRoulette / startBandFx / startBoostFx)は flushStrike(true) を直接呼ぶ。
   */
  function abortStrike(): void {
    activeStrike.current = null;
    flushStrike();
    drainPendingStrike();
  }

  /**
   * 演出終了時の持ち越しドレイン。どのキューをどの順で見るかは
   * shared/fx-drain.ts の drainFxQueues が権威(順序はテストで固定)。
   * achieved(CLEAR)は「再生」— 開始スロットを消費せず次演出と並走する。
   * hooks はルーレット BGM の後始末(finishRoulette だけが使う)。
   */
  function runDrain(
    order: FxDrainOrder,
    hooks?: { onNext?: (kind: 'roulette' | 'boost' | 'band') => void; onIdle?: () => void }
  ): void {
    const queues = {
      achieved: pendingAchieved.current,
      boosts: pendingBoosts.current,
      bands: pendingBands.current,
      roulettes: rouletteQueue.current,
    };
    pendingAchieved.current = null;
    const r = runFxDrain(queues, order, {
      playAchieved: (e) => playEffect(e),
      start: (kind, e) => {
        if (kind === 'roulette') {
          // startRoulette は戻り値を持たず、必ず rouletteHold を張る = 断れない。
          hooks?.onNext?.('roulette');
          startRoulette(e, true);
          return true;
        }
        if (kind === 'band') {
          // 断る条件は startBandFx の入口ガードと同じ述語を先に見る — 断る相手の
          // ために onNext(ルーレット BGM の即断)を撃たないため。撃つと次の
          // スピンで BGM が頭から鳴り直す。
          if (!bandWillStart(e)) {
            fxWarn('ドレイン: カットインを開始できない — 次の持ち越しへ', {
              clip: e.fxBandClip,
              durationMs: e.fxDurationMs,
              reducedMotion: prefersReducedMotion(),
            });
            return false;
          }
          hooks?.onNext?.('band');
          return startBandFx(e);
        }
        // ブーストだけは「期限切れ」がある。worker のフィーバーは絶対時刻で走り、
        // ルーレット連鎖(最長 ~19秒)では worker は凍結しないので、キューから
        // 出す時点で終わっているフィーバーがありうる。そのまま再生すると
        // 0 のままのタップカウンタを不透明動画で最大 26 秒見せることになる。
        const plan = planBoostStart(boostStartTiming(e), Date.now());
        if (plan.action === 'skip') {
          fxWarn('ドレイン: フィーバーの期限切れ — 再生しない', {
            reason: plan.reason,
            atMs: e.atMs,
            endsAtMs: e.boostEndsAtMs,
            nowMs: Date.now(),
          });
          return false;
        }
        if (!boostWillStart(e)) {
          fxWarn('ドレイン: ブースト開始不可(尺不足 / 動きの抑制)', {
            durationMs: e.fxDurationMs,
            reducedMotion: prefersReducedMotion(),
          });
          return false;
        }
        hooks?.onNext?.('boost');
        return startBoostFx(e, plan);
      },
    });
    if (r.started) return;
    hooks?.onIdle?.();
    // 次演出を始めないパスの最後だけ — start* の冒頭 flushStrike に出したばかりの
    // チェーンを畳ませない(従来の finish* 各所にあった規約)。
    drainPendingStrike();
  }

  function clearRouletteTimers() {
    for (const t of rouletteTimers.current) window.clearTimeout(t);
    rouletteTimers.current = [];
  }

  /**
   * 回転サウンドの一括停止(stop 自体が冪等なので重複呼び出しは安全)。
   * ループ音のフェードは 150ms 上限 — リール停止後に長々と鳴り残ると
   * 「まだ回っている」ように聞こえる。BGM は fadeMs のまま(曲は余韻が要る)。
   */
  function stopRouletteSound(fadeMs: number) {
    rouletteSpinSe.current?.stop(Math.min(150, fadeMs));
    rouletteSpinSe.current = null;
    rouletteBgm.current?.stop(fadeMs);
    rouletteBgm.current = null;
  }

  /** ルーレットを開始し、リールが止まるまで数字を出目適用前の値で据え置く。 */
  function startRoulette(e: ChallengeEffect, fast: boolean) {
    // いいね着弾の保留があれば先に畳む(ラッチの持ち主を1人にする)。handoff=true —
    // 直後にこの演出が始まるので、保留バナーは出さずに持ち越す(演出明けの着弾で出る)。
    flushStrike(true);
    rouletteHold.current = true;
    // 回転サウンド。id・音量とも cfg 参照 — 全ルーレット共通なので effect に載せる
    // 情報が無い(盤面と違い、古い cfg で鳴っても正しさは壊れない)。テスト再生
    // (challenge.testEffect)もこの関数を通るので同じ音が鳴る。
    // BGM はキュー消化の連鎖中は止めない(null のときだけ開始)。ループ音は
    // onSpinQuiet で毎回止まるので、スピンごとに頭から撃ち直す。
    const snd = cfg?.challenge.rouletteSound;
    if (rouletteBgm.current === null) rouletteBgm.current = playBandBgm(snd?.bgm, snd?.bgmVolume ?? 0);
    if (rouletteSpinSe.current === null) {
      rouletteSpinSe.current = playBandBgm(snd?.spinSe, snd?.spinSeVolume ?? 0);
    }
    // 据え置き値は worker が確定させた valueAfter から出目を戻した「適用前」。
    // renderer での再計算はこの1箇所だけ — 表示上の演出のためで、解除後は必ず
    // worker の権威ある値に収束する。
    setHeldValue(Math.max(0, e.valueAfter - e.amount));
    // spin は開始時に確定して state にも焼き込む。onDone で ref を読み直すと
    // 「呼ばれた時点の世代」と常に一致してしまい、世代チェックが素通りする。
    const spin = ++rouletteSpinId.current;
    setRoulette({ key: ++fxKey, effect: e, fast, spin });
    // 安全弁: バックグラウンドで onAnimationEnd が来なくても必ず解除して収束させる。
    // 尺は fast で変わるので rouletteAbortMs に一本化する(片方だけ見て調整すると
    // もう片方が必ず壊れる)。
    clearRouletteTimers();
    rouletteTimers.current.push(window.setTimeout(() => finishRoulette(e, spin), rouletteAbortMs(fast)));
  }

  /**
   * 「止まりそう」(当選の1つ手前に着いて溜め・保持・フェイク停止に入る瞬間)。
   * 揺れは足さない — ここはまだ止まっていないので、画面が跳ねると確定の合図に読める。
   */
  function nearStopRoulette() {
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['roulette-near'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['roulette-near'])
      );
    }
  }

  /** キック(パターン3のフェイク停止からの一撃)。衝撃音と画面の揺れを足す。 */
  function kickRoulette() {
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['roulette-kick'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['roulette-kick'])
      );
    }
    pushShake('shake');
  }

  /** リール停止(または安全弁)— ここで初めて数字が動いて見える。 */
  function finishRoulette(e: ChallengeEffect, spin: number) {
    // 二重発火の遮断。素通りさせると (a) 確定音とバナーが2回、(b) キューが1本
    // 余計に消え、(c) 次のスピン開始後に走ると新しいリールを消してしまう。
    // finishBandFx と同じ自衛を、世代の一致判定つきで行う。
    if (!rouletteHold.current || spin !== rouletteSpinId.current) return;
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
    pushFloat(rouletteBanner(e), `${e.amount < 0 ? 'good' : 'bad'} banner-roulette`);

    // 持ち越しのドレイン(達成 → 短縮スピン連鎖 → ブースト → カットイン → 着弾。
    // 順序は shared/fx-drain.ts の 'roulette-first' が権威)。BGM は次が短縮スピン
    // なら鳴りっぱなし、ブースト/カットインなら即断(bandBgm と重ねない)、
    // 何も始めないなら 400ms フェード(バンドBGMの終端と同じ尺)。
    runDrain('roulette-first', {
      onNext: (kind) => {
        if (kind !== 'roulette') stopRouletteSound(0);
      },
      onIdle: () => stopRouletteSound(400),
    });
  }

  /** reset/stop 用の全破棄。演出もキューも据え置きも捨てて worker 値へ戻す。 */
  function abortRoulette() {
    clearRouletteTimers();
    // hold が立っていなくても音は残りうる(開始直後の abort 等)ので guard の前で止める。
    stopRouletteSound(0);
    rouletteQueue.current = [];
    pendingAchieved.current = null;
    if (!rouletteHold.current) return;
    rouletteHold.current = false;
    setRoulette(null);
    setHeldValue(null);
  }

  // ── ダイヤ帯域カットイン ─────────────────────────────────────────────────

  function clearRepeatTimers() {
    for (const t of repeatTimers.current) window.clearTimeout(t);
    repeatTimers.current = [];
  }
  function clearMiniTimers() {
    for (const t of miniTimers.current) window.clearTimeout(t);
    miniTimers.current = [];
  }
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
    // 入口ガードは譲る判定(yieldToCutin)と同じ bandWillStart を共有する —
    // 判定がズレると「譲ったのにカットインが始まらず、どちらも出ない」に戻る。
    if (!bandWillStart(e)) {
      fxWarn('カットイン開始不可(未知クリップ id / 尺不足 / 動きの抑制)', {
        clip: e.fxBandClip,
        durationMs,
        reducedMotion: prefersReducedMotion(),
      });
      return false;
    }
    if (!url) return false; // bandWillStart が保証するが、型のために残す
    // 連打ギフトの反復。カットインは全画面不透明なので間隔を空けず尺ぶんの直列再生。
    // 据え置き(bandHold)は総尺のあいだ維持するので、**数字が動くのは最後に1回だけ**。
    // worker 側も同じ総尺で凍結している(giftOp の fxFreezeUntilMs)。
    const { rep: bandRep } = giftFxShots(e);
    const totalMs = durationMs * bandRep;
    // いいね着弾の保留があれば先に畳む(ラッチの持ち主を1人にする)。handoff=true —
    // 直後にこの演出が始まるので、保留バナーは出さずに持ち越す(演出明けの着弾で出る)。
    flushStrike(true);
    clearBandTimers();
    bandHold.current = true;
    bandEffect.current = e;
    // 据え置き値は startRoulette と同じ「worker 確定の valueAfter から適用前へ戻す」。
    setHeldValue(Math.max(0, e.valueAfter - e.amount));
    setBandClip({ key: ++fxKey, url, durationMs, out: false, fullCut: e.fxFullCut === true });
    // BGM。曲 id は effect が権威(worker が bgmEnabled/'off' を判定済み)、
    // 音量だけ cfg から読む(roulette-hit 等と同じ 120 秒ポーリング(CFG_POLL_MS)許容)。
    // 直列再生(連続バンドギフト)で前の曲が残らないよう先に止める。
    bandBgm.current?.stop(0);
    bandBgm.current = playBandBgm(e.fxBandBgm, cfg?.challenge.giftBandFx.bgmVolume ?? 70);
    // 2本目以降。key を変えて video を貼り替える(loop 中でも頭から撃ち直す)。
    // BGM も撃ち直して「もう一発来た」を聴覚でも分からせる。据え置きは解かない。
    for (let i = 1; i < bandRep; i++) {
      bandTimers.current.push(
        window.setTimeout(() => {
          if (!bandHold.current) return; // 途中で abort されていたら何もしない
          setBandClip({ key: ++fxKey, url, durationMs, out: false, fullCut: e.fxFullCut === true });
          bandBgm.current?.stop(0);
          bandBgm.current = playBandBgm(e.fxBandBgm, cfg?.challenge.giftBandFx.bgmVolume ?? 70);
          bandBlast(durationMs);
        }, durationMs * i)
      );
    }
    // パチンコ風の追い焚き: 開始時に1発、以降 2.2 秒ごとに再発火して
    // 動画の再生中ずっと粒子が舞い続けるようにする。
    bandBlast(durationMs);
    for (let t = 2200; t < totalMs - 800; t += 2200) {
      bandTimers.current.push(window.setTimeout(() => bandBlast(durationMs), t));
    }
    // 終端 0.4 秒前にフェード(映像の .out と BGM を同時に減衰)→ 尺で解除。
    // 安全弁はバックグラウンドタブの setTimeout 抑制対策(ROULETTE_ABORT_MS と同じ役割)。
    bandTimers.current.push(
      window.setTimeout(() => {
        setBandClip((c) => (c ? { ...c, out: true } : c));
        bandBgm.current?.stop(400);
      }, Math.max(0, totalMs - 400))
    );
    bandTimers.current.push(window.setTimeout(finishBandFx, totalMs));
    bandTimers.current.push(window.setTimeout(finishBandFx, totalMs + 2000));
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
    }
    // カットイン中に我慢していた通知(ギフトカード/フラッシュ/シェイク/粒子)を
    // ここで出す — 「カットイン → セグ通知」の順序。次のカットイン開始より前に出すこと。
    // シェイクはヘルパー内の tier 判定に任せる(旧来の amount 判定は重複するので廃止)。
    if (e) giftImpactVisuals(e, 0);
    // カットイン中に届いた持ち越しのドレイン(達成 → ブースト → カットイン →
    // スピン → 着弾。順序は shared/fx-drain.ts の 'standard' が権威)。
    // bandHold はすでに false なので次のカットインへ再入して問題ない。
    runDrain('standard');
  }

  /** reset/stop 用の全破棄。据え置きもタイマーもBGMも捨てて worker 値へ戻す。 */
  function abortBandFx() {
    clearBandTimers();
    bandBgm.current?.stop(0);
    bandBgm.current = null;
    pendingBands.current = [];
    if (!bandHold.current) return;
    bandHold.current = false;
    bandEffect.current = null;
    setBandClip(null);
    setHeldValue(null);
  }

  // ── タップブースト(フィーバー) ─────────────────────────────────────────

  function clearBoostTimers() {
    for (const t of boostTimers.current) window.clearTimeout(t);
    boostTimers.current = [];
    if (boostRollupRaf.current != null) {
      cancelAnimationFrame(boostRollupRaf.current);
      boostRollupRaf.current = null;
    }
  }

  /**
   * ブースト開始。起動カットイン(3/2/1 焼き込み・boostIntroMs)→ タップ
   * ウィンドウ(ループ動画+タップカウンタ)。数字は boost-end の着弾まで
   * 発動時の値で据え置く。専用素材が無ければ暗幕+カウンタで縮退する。
   * 尺は effect の焼き込み値が権威(worker の凍結と同期)。
   * 戻り値 false = 開始不可(呼び出し側はバナーへフォールバック)。
   */
  function startBoostFx(e: ChallengeEffect, plan: BoostStartPlan = { action: 'full' }): boolean {
    if (plan.action === 'skip') return false; // 呼び出し側で判定済み(型を閉じるだけ)
    if (!boostWillStart(e)) {
      fxWarn('ブースト開始不可(尺不足 / 動きの抑制)', {
        durationMs: e.fxDurationMs,
        reducedMotion: prefersReducedMotion(),
      });
      return false;
    }
    // 途中参加(resume)は起動カットインを丸ごと捨て、カウントダウンの残りと
    // ウィンドウの残りだけを組み直す。3・2・1 は映像に焼き込まれていて「1」が
    // タップ開始と同期する契約(shared/challenge.ts の TAP_BOOST_COUNT_CLIPS)
    // なので、段の尺ではなく**ウィンドウが開く時刻**の側を守る。
    const introMs = plan.action === 'full' ? (e.boostIntroMs ?? 0) : 0;
    const countMs = plan.action === 'full' ? (e.boostCountMs ?? 0) : plan.countMs;
    const preMs = introMs + countMs;
    const totalMs = plan.action === 'full' ? (e.fxDurationMs ?? 0) : plan.remainingMs;
    // いいね着弾の保留があれば先に畳む(ラッチの持ち主を1人にする)。handoff=true —
    // 直後にこの演出が始まるので、保留バナーは出さずに持ち越す(演出明けの着弾で出る)。
    flushStrike(true);
    clearBoostTimers();
    boostHold.current = true;
    boostEffect.current = e;
    boostTest.current = e.test === true;
    boostTestTapRef.current = 0;
    // テスト再生は据え置かない(testEffect は値を変えない契約 — 実タップで値が
    // 動いたときに表示が固まって見えるのを避ける)。
    if (!e.test) setHeldValue(Math.max(0, e.valueAfter - e.amount));
    if (e.flash) pushFlash('gift-t3');
    const push = (ms: number, fn: () => void) => {
      boostTimers.current.push(window.setTimeout(fn, ms));
    };
    // 3段の直列再生。各段のクリップは effect の焼き込み id から解決し、素材が
    // 無ければ暗幕で同じ尺を待つ(尺は worker の凍結と同期しているので詰めない。
    // カウントダウンが暗幕でも、タップ開始は boost-start SE が合図する)。
    const startWindow = (): void => {
      if (!boostHold.current) return;
      setBoostClip({ key: ++fxKey, phase: 'window', url: boostClipUrl(e.boostLoopClip), out: false });
      boostWindowBlast();
    };
    const startCount = (): void => {
      if (!boostHold.current) return;
      setBoostClip({ key: ++fxKey, phase: 'count', url: boostClipUrl(e.boostCountClip), out: false });
    };
    if (introMs > 0) {
      setBoostClip({ key: ++fxKey, phase: 'intro', url: boostClipUrl(e.boostIntroClip), out: false });
      if (countMs > 0) push(introMs, startCount);
      push(preMs, startWindow);
    } else if (countMs > 0) {
      startCount();
      push(preMs, startWindow);
    } else {
      startWindow();
    }
    // ウィンドウ中の追い焚き(パチンコ風の粒子)。bandBlast の 2.2 秒周期と同じ。
    for (let t = preMs + 2200; t < totalMs - 800; t += 2200) {
      push(t, () => boostBlast());
    }
    // 終端 0.4 秒前にフェード。数字への反映は boost-end effect 駆動(worker が
    // 権威)なので、尺タイマーでは finish しない — settle の遅延(最大 ~525ms)は
    // .out フェードが繋ぐ。
    push(Math.max(0, totalMs - 400), () => setBoostClip((c) => (c ? { ...c, out: true } : c)));
    if (e.test) {
      // テストは worker から boost-end が来ないので自前で締める(着弾だけ試写)。
      push(totalMs, () => finishBoostFx(null));
    } else {
      // 安全弁: boost-end が届かない(worker 再起動等)なら強制解除。
      // abort ではなく expire — 持ち越しキューを捨てずにドレインする。
      push(totalMs + 3000, expireBoostFx);
    }
    return true;
  }

  /** タップウィンドウ入りの合図(SE・フラッシュ・粒子)。3/2/1 明けの一撃。 */
  function boostWindowBlast() {
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['boost-start'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['boost-start'])
      );
    }
    pushFlash('gift-t3');
    pushShake('shake');
    const fx = fxRef.current;
    if (!fx) return;
    const o = fxOrigin();
    fx.rays(o.x, o.y, { count: 12, hue: 45 });
    fx.confettiRain(160, { gold: true });
  }

  /** ウィンドウ中の追い焚き(bandBlast の弱め版・金)。 */
  function boostBlast() {
    const fx = fxRef.current;
    if (!fx) return;
    const o = fxOrigin();
    fx.sparkBurst(o.x, o.y, 28, { hue: 45, speed: 600 });
    fx.confettiRain(60, { gold: true });
  }

  /**
   * ブースト終了。boost-end effect(e)またはテストの自動終了(null)から呼ばれる。
   * タップ>0 なら清算発表シーケンス — 結果カットシーン(boostResultMs・任意)→
   * パチンコ風「-N」ロールアップ(桁回転→上位桁から確定)→ 溜め → 7セグへ発射 —
   * を経て、着弾で据え置きを解除して worker の一括減算値へ収束させる。
   * タップ 0 は従来どおり軽い着弾だけで畳む(worker 側の凍結引き戻しと対)。
   * 全ビートは boostTimers に積む — abort/expire の clearBoostTimers で一掃できる。
   */
  function finishBoostFx(e: ChallengeEffect | null) {
    if (!boostHold.current) return;
    clearBoostTimers();
    const isTest = boostTest.current;
    boostTest.current = false;
    const startE = boostEffect.current;
    boostEffect.current = null;
    // テスト(e=null)は worker タップ数のミラー(boostTestTapRef)と boost-start の
    // 焼き込み(startE)から組み立てる — 実発動は boost-end の焼き込みが権威。
    const tap = e?.boostTapCount ?? (isTest ? boostTestTapRef.current : 0);
    const mult = e?.boostMultiplier ?? startE?.boostMultiplier ?? 1;
    const amountAbs = e ? Math.max(0, -e.amount) : tap * mult * (cfg?.challenge.pressStep ?? 1);
    const resultMs = e?.boostResultMs ?? (isTest ? (startE?.boostResultMs ?? 0) : 0);
    const resultClip = e?.boostResultClip ?? (isTest ? startE?.boostResultClip : undefined);
    const plan = planBoostSettle({ amount: amountAbs, tapCount: tap, resultMs });
    const fx = fxRef.current;

    if (plan.totalMs === 0) {
      // タップ 0(発表するものが無い)— 従来の軽い着弾だけで畳む。
      setBoostClip((c) => (c ? { ...c, out: true } : c));
      const from = fx?.pointFor(boostCounterRef.current);
      const to = fx?.pointFor(countdownRef.current);
      const willStrike = (isTest || tap > 0) && fx != null && from != null && to != null;
      const travel = willStrike ? strikeTravelMs(boostCounterRef.current) : 0;
      if (willStrike) {
        fx.strike({ x: from.x, y: from.y }, { x: to.x, y: to.y }, { ms: travel, hue: 45 });
      }
      boostTimers.current.push(
        window.setTimeout(() => {
          boostHold.current = false;
          setBoostClip(null);
          setHeldValue(null); // ここで初めて数字が一括減算後の値へ動く
          impactBoostVisuals(e);
          // ブースト中に届いた演出の持ち越しをドレインする(finishBandFx と同順)。
          runDrain('standard');
        }, travel)
      );
      return;
    }

    const push = (ms: number, fn: () => void) => {
      boostTimers.current.push(window.setTimeout(fn, ms));
    };
    // 回転桁の疑似乱数 seed。effect.id で決定的にする(StrictMode の二重レンダーや
    // 再入で毎フレーム同じ絵になる — roulettePattern と同じ動機)。
    const seed = e?.id ?? startE?.id ?? 1;

    // t=0: 結果カットシーン(1回再生。素材なし=暗幕で同じ尺、'off'=段ごとスキップ)。
    if (plan.resultMs > 0) {
      setBoostClip({ key: ++fxKey, phase: 'result', url: boostClipUrl(resultClip), out: false });
      push(Math.max(0, plan.resultMs - 400), () => setBoostClip((c) => (c ? { ...c, out: true } : c)));
    } else {
      setBoostClip((c) => (c ? { ...c, out: true } : c));
    }

    // t=resultMs: 暗幕を畳んで(7セグを見せて)「-N」ロールアップ開始。
    const startRoll = (): void => {
      if (!boostHold.current) return;
      setBoostClip(null);
      setBoostSettle({ key: ++fxKey, stage: 'roll', amount: amountAbs, tap, mult, seed, rollupMs: plan.rollupMs });
      if (cfg?.challenge.seEnabled) {
        // 専用スロットは設けず window 入りと同じファンファーレを流用。
        // 素材は 'boost-final'(assets/se/boost-final.mp3)が既にカタログにあるので、
        // 'boost-result' スロットを足すならその既定に据える想定。
        playSe(
          cfg.challenge.seSounds['boost-start'],
          effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['boost-start'])
        );
      }
      const rollStart = performance.now();
      const tick = (): void => {
        boostRollupRaf.current = null;
        if (!boostHold.current) return;
        const r = rollupDisplayAt(amountAbs, performance.now() - rollStart, plan.rollupMs, seed);
        // 初回フレームで ref が未装着(コミット前)でも回し続ける — 書けるように
        // なった次のフレームから表示が追いつく。
        const el = boostSettleAmtRef.current;
        if (el) el.textContent = `-${r.text}`;
        if (!r.done) boostRollupRaf.current = requestAnimationFrame(tick);
      };
      boostRollupRaf.current = requestAnimationFrame(tick);
    };
    if (plan.resultMs > 0) push(plan.resultMs, startRoll);
    else startRoll();

    // t=+rollupMs: 全桁確定 — フラッシュ+確定パンチ(CSS .lock)+粒子。
    push(plan.resultMs + plan.rollupMs, () => {
      if (!boostHold.current) return;
      setBoostSettle((s) => (s ? { ...s, stage: 'lock' } : s));
      pushFlash('gift-t3');
      pushShake('shake');
      const o = fx?.pointFor(boostSettleRef.current);
      if (fx && o) fx.sparkBurst(o.x, o.y, 32, { hue: 45, speed: 620 });
    });

    // t=+holdMs: 溜め明け — 発表オーバーレイから7セグへ発射 → 着弾で締め。
    push(plan.resultMs + plan.rollupMs + plan.holdMs, () => {
      if (!boostHold.current) return;
      setBoostSettle((s) => (s ? { ...s, stage: 'fly' } : s));
      const from = fx?.pointFor(boostSettleRef.current);
      const to = fx?.pointFor(countdownRef.current);
      const willStrike = fx != null && from != null && to != null;
      const travel = willStrike ? strikeTravelMs(boostSettleRef.current) : 0;
      if (willStrike) {
        fx.strike({ x: from.x, y: from.y }, { x: to.x, y: to.y }, { ms: travel, hue: 45 });
      }
      push(travel, () => {
        boostHold.current = false;
        setBoostClip(null);
        setBoostSettle(null);
        setHeldValue(null); // ここで初めて数字が一括減算後の値へ動く
        impactBoostVisuals(e);
        // ブースト中に届いた演出の持ち越しをドレインする(finishBandFx と同順)。
        runDrain('standard');
      });
    });
  }

  /** ブースト着弾の共通演出(パンチ/シェイク/粒子/クリップ/SE/バナー)。 */
  function impactBoostVisuals(e: ChallengeEffect | null) {
    if (e && e.amount !== 0) {
      setPunchDir('strike');
      setPunchKey((k) => k + 1);
      pushShake('shake-strong');
    }
    const fx = fxRef.current;
    const r = fx?.pointFor(countdownRef.current);
    const stageW = landscape ? STAGE_LW : STAGE_W;
    const stageH = landscape ? STAGE_LH : STAGE_H;
    const cx = r?.x ?? stageW / 2;
    const cy = r?.y ?? stageH * 0.4;
    if (fx && r) {
      fx.ringWave(cx, cy, { hue: 45, radius: Math.max(r.w, r.h) * 0.7 });
      fx.sparkBurst(cx, cy, 36, { hue: 45, speed: 680 });
      fx.rays(cx, cy, { count: 10, hue: 45 });
    }
    if (cfg?.challenge.fxClipsEnabled && (e == null || e.amount !== 0)) {
      const base = r ? Math.min(r.w, r.h) : 320;
      const size = Math.min(Math.max(base * 1.4, 300), Math.min(stageW, stageH));
      showStrikeClip(cx - size / 2, cy - size / 2, size);
    }
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['boost-end'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['boost-end'])
      );
    }
    if (e) pushBoostEndBanner(e);
  }

  /** ブースト結果バナー(「フィーバー タップ×N で −M」)。 */
  function pushBoostEndBanner(e: ChallengeEffect): void {
    const tap = e.boostTapCount ?? 0;
    const mult = e.boostMultiplier ?? 1;
    if (tap <= 0 && e.amount === 0) return; // タップ 0 は静かに終わる
    pushFloat(
      <>
        <span className="f-amt">{num(e.amount)}</span>
        <span className="f-txt">
          フィーバー! タップ×{num(tap)}
          {mult > 1 ? <b> {mult}倍</b> : null}
        </span>
      </>,
      'good banner-boost'
    );
  }

  /** reset/stop 用の全破棄。据え置きもタイマーもキューも捨てて worker 値へ戻す。 */
  function abortBoostFx() {
    clearBoostTimers(); // 発表シーケンスの rAF もここで止まる
    pendingBoosts.current = [];
    if (!boostHold.current) return;
    boostHold.current = false;
    boostEffect.current = null;
    boostTest.current = false;
    setBoostClip(null);
    setBoostSettle(null);
    setHeldValue(null);
  }

  /**
   * 安全弁専用の締め(boost-end が届かない — worker 再起動・遮蔽での取りこぼし等)。
   * abortBoostFx と違い pendingBoosts は捨てず、finish 系と同じドレイン連鎖で
   * 持ち越し(CLEAR・キュー済みブースト/カットイン/スピン・保留着弾)を必ず流す。
   * これが無いと pendingAchieved の CLEAR 演出が永久に出ず、残ったキューが
   * 数分後の別の finish で因果不明のカットインとして突然再生される。
   */
  function expireBoostFx() {
    if (!boostHold.current) return;
    clearBoostTimers();
    fxWarn('boost-end が届かないため強制終了 — 持ち越し演出をドレイン', {
      pendingBoosts: pendingBoosts.current.length,
      pendingBands: pendingBands.current.length,
      rouletteQueue: rouletteQueue.current.length,
      achieved: pendingAchieved.current != null,
    });
    boostHold.current = false;
    boostEffect.current = null;
    boostTest.current = false;
    setBoostClip(null);
    setBoostSettle(null);
    setHeldValue(null);
    runDrain('standard');
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
    // 飛行中の未着弾ぶんを記録 — ルーレット/カットインの横取り(flushStrike)で
    // 畳まれたとき、この記録が pendingStrike へ戻って演出明けに再生される。
    activeStrike.current = { like: likeDelta, stock: stockDelta };
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
      push(STRIKE_ABORT_MS, abortStrike);
      return;
    }
    const travel2 = strikeTravelMs(stockRowRef.current);
    push(t1, () => {
      activeStrike.current = { like: 0, stock: stockDelta }; // いいね分は着弾済み
      impactStrikePartial(held + likeDelta);
    });
    push(t1 + STOCK_PAUSE_MS, () => launchStock(travel2));
    push(t1 + STOCK_PAUSE_MS + travel2, () => impactStock(stockDelta));
    // 安全弁は必ず2段目の着弾より後ろに置く(固定 1400ms だと因果逆転)。
    push(STRIKE_ABORT_STOCK_MS, abortStrike);
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
    activeStrike.current = null;
    setHeldValue(null);
    impactStrikeVisuals();
    // 飛行中に積まれた満タン/満杯を続けて1本のチェーンで出す(直列再生)。
    drainPendingStrike();
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
    // 着弾の瞬間に「+N いいね妨害!」を出す — アニメーション → 通知の順序。
    // 2段着弾の1段目(impactStrikePartial)もここを通るので、いいね分はそこで出る。
    flushPendingFloat(pendingLikeFloats, likeFloatNode);
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
      showStrikeClip(cx - size / 2, cy - size / 2, size);
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
    // 着弾直後にフルスクリーンカットインが続くときは screen 合成の全画面クリップを
    // 譲る(launchStrike の stockFollows と同じパターン — 主役を1本に絞る)。
    if (cfg?.challenge.fxClipsEnabled && !stockCutinReady()) playClip(STOCK_FULL_CLIP_URL);
  }

  /**
   * ストック着弾カットインを出せるか。素材が無い(glob 0件)・クリップ無効・
   * 動きの抑制、のどれかで false — 呼び出し側は従来の即時 reveal へフォールバック。
   */
  function stockCutinReady(): boolean {
    return (
      STOCK_CUTIN_CLIP_URL !== null && (cfg?.challenge.fxClipsEnabled ?? false) && !prefersReducedMotion()
    );
  }

  /**
   * ストック分の着弾。カットインを出せるときは reveal(revealStock)を動画の
   * 終端まで遅らせ、出せないときは即 reveal(= 従来挙動)。
   */
  function impactStock(stockDelta: number) {
    clearStrikeTimers();
    if (stockCutinReady()) {
      startStockCutin(stockDelta);
      return;
    }
    fxWarn('ストック着弾カットイン不可 — 即時 reveal へフォールバック', {
      clipMissing: STOCK_CUTIN_CLIP_URL === null,
      clipsEnabled: cfg?.challenge.fxClipsEnabled ?? false,
      reducedMotion: prefersReducedMotion(),
    });
    revealStock(stockDelta);
    drainPendingStrike(); // カットイン無しでチェーン完了 — 持ち越しを続けて出す
  }

  /**
   * 着弾の瞬間からフルスクリーンカットイン(音声焼き込み)を開始する。
   * 据え置き(heldValue)は startStrike が張ったまま維持 — 動画中に数字は動かない。
   * worker 側は凍結しない設計なので、カットイン中に届いた press/gift 等は
   * reveal の一括ジャンプに合流する(数値の正しさは null 収束規約で保証)。
   */
  function startStockCutin(stockDelta: number) {
    stockCutinHold.current = true;
    stockCutinDelta.current = stockDelta;
    setStockCutin({ key: ++fxKey, out: false });
    const push = (ms: number, fn: () => void) => {
      strikeTimers.current.push(window.setTimeout(fn, ms));
    };
    push(STOCK_CUTIN_MS - STOCK_CUTIN_FADE_MS, () => setStockCutin((c) => (c ? { ...c, out: true } : c)));
    push(STOCK_CUTIN_MS, finishStockCutin);
    // 安全弁(バックグラウンドの setTimeout 抑制対策)。finish 済みなら no-op。
    push(STOCK_CUTIN_ABORT_MS, abortStrike);
  }

  /** カットイン終了(または onError)— ここで初めてボーナスが数字に乗る。 */
  function finishStockCutin() {
    if (!stockCutinHold.current) return;
    clearStrikeTimers();
    stockCutinHold.current = false;
    const delta = stockCutinDelta.current;
    setStockCutin(null); // unmount = 焼き込み音声も止まる
    revealStock(delta);
    // カットイン中に届いた演出の持ち越しをドレインする(finishBandFx と同順)。
    runDrain('standard');
  }

  /** ストック分の reveal — 据え置き全解除+着弾演出(パンチ/シェイク/粒子/SE)。 */
  function revealStock(stockDelta: number) {
    activeStrike.current = null; // ストック段まで着弾完了
    setHeldValue(null);
    // 2発目(緑)の着弾(カットイン有りなら終端)と同時に「いいねストック満杯!」を出す。
    // いいね側のバナーもここで必ず出す — ストック着弾カットイン(最長7秒)の間は
    // strikeTimers が生きているため playEffect が保留しており、この経路で流さないと
    // 次の着弾が起きるまでバナーが闇に消える。
    flushDeferredFloats();
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
      showStrikeClip(cx - size / 2, cy - size / 2, size);
    }
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['stock-full'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['stock-full'])
      );
    }
    if (cfg) playMini(miniForSlot(cfg.challenge, 'stock-full'), stockDelta);
  }

  /**
   * いいね着弾でゲージを明滅させる(remove→reflow→add で毎回再生)。
   *
   * これは粒子エンジンの onArrive として **rAF の中から**呼ばれる
   * (engine.ts の update() が p.onArrive?.() を叩く)。offsetWidth の読み出しは
   * 強制同期レイアウトなので、エンジンの update と render のあいだで毎ハート
   * レイアウトが走っていた。1フレーム後ろへ遅らせて、ついでに1バーストぶんの
   * 着弾を1回の再スタートに畳む(最後の再スタートだけが見えるので見た目は同じ)。
   *
   * cancel-and-reschedule にしてあるのが要点 — 素の `if (pending) return` だと、
   * 遮蔽ウィンドウで rAF が止まったときに pending が true のまま固着し、
   * 復帰後もゲージが二度と明滅しなくなる(このモニター窓は実際に遮蔽される)。
   */
  function tickGauge(): void {
    if (gaugeTickRaf.current !== 0) cancelAnimationFrame(gaugeTickRaf.current);
    gaugeTickRaf.current = requestAnimationFrame(() => {
      gaugeTickRaf.current = 0;
      const el = gaugeTrackRef.current;
      if (!el) return;
      el.classList.remove('tick');
      void el.offsetWidth;
      el.classList.add('tick');
    });
  }

  /**
   * ギフト1件ぶんの見た目。shot は連打反復の通し番号(0 = 本来の1発目)。
   *
   * shot > 0 は「同じギフトがもう一発来た」の再現なので、要約系(ギフトカード)は
   * 出さず、打撃系(フラッシュ・クリップ・簡易演出・粒子)だけを撃ち直す。
   */
  function playGiftVisual(e: ChallengeEffect, shot: number): void {
    // カットイン再生中の反復(shot > 0)は撃たない — 反復は startBandFx が映像・BGM・
    // bandBlast の直列再生で面倒を見ており、ここ由来のフラッシュ/クリップ/粒子は
    // 不透明動画の前面に重なって「カットイン → 通知」の順序を壊すだけ。
    if (shot > 0 && (bandHold.current || stockCutinHold.current || boostHold.current)) return;
    // ダイヤ帯域カットイン。effect 側の fxBandClip が権威(worker が判定済み・
    // 凍結も開始済み)なので cfg は見ない — 120 秒ポーリング(CFG_POLL_MS)の古い設定に
    // 依存しない。開始できたら通常クリップ・簡易演出は出さない(全画面を
    // 不透明動画が覆うため見えない)。リール中・カットイン中は持ち越し、
    // 解決できなければ従来経路へフォールバックする。
    // カットインの反復は startBandFx が尺ぶん直列で面倒を見るので、ここは shot 0 のみ。
    let banded = false;
    // bandWillStart を先に判定する — 始まらないカットイン(未知クリップ id 等)を
    // 持ち越しキューへ積むと、解除時の startBandFx が false を返してそのギフトの
    // 演出が丸ごと消える。始まらないなら最初から通常クリップ経路へ落とす。
    if (shot === 0 && e.fxBandClip != null && bandWillStart(e)) {
      if (rouletteHold.current || bandHold.current || stockCutinHold.current || boostHold.current) {
        // bandHold を見ずに startBandFx を再入すると clearBandTimers が1本目の
        // finishBandFx を消し、据え置きが解けないまま数字が固まる。
        // 持ち越しキューが満杯なら banded は立てない — 立てると通常クリップも
        // 簡易演出も出ず、そのギフトの演出が丸ごと消える。
        if (pendingBands.current.length < 2) {
          pendingBands.current.push(e);
          banded = true;
        }
      } else {
        banded = startBandFx(e);
      }
    }
    // 映像クリップ。canonical 一致の専用クリップ → 無ければ tier の汎用クリップ。
    // 割り当ては設定画面で変更でき、cfg は 120 秒ポーリング(CFG_POLL_MS)で届く。
    if (cfg && !banded) {
      const g = { canonical: e.canonical, diamonds: e.diamonds ?? 0 };
      // 反復の2発目以降は同じクリップを頭から撃ち直す('restart')。キューに積むと
      // 4秒クリップ×5本 = 20秒になって「連打」に見えない。
      const clipId = matchGiftClip(cfg.challenge, g);
      const clipUrl = fxClipUrl(clipId);
      // 解決できない id(素材削除・設定の巻き戻り)は無言で消えていた — 理由を残す。
      if (clipId && !clipUrl) fxWarn('未知のクリップ id — ギフトクリップをスキップ', clipId);
      playClip(clipUrl, shot === 0 ? 'queue' : 'restart');
      // お助け(ファンスタンプ)は専用スロット。ダイヤ数で引くと gift-t1 と同じに
      // なってしまい、お助けだけ簡易演出を変えられない(useChallengeSe の音と同じ規約)。
      playMini(
        e.fanStamp ? miniForSlot(cfg.challenge, 'helper') : matchGiftMini(cfg.challenge, g),
        e.amount,
        shot
      );
    }
    // 通知(フラッシュ/シェイク/カード/粒子)。カットインが始まった(または持ち越された)
    // ときはここでは出さず、finishBandFx がカットイン終了時にまとめて出す —
    // 「カットイン → セグ通知」の順序。
    if (!banded) giftImpactVisuals(e, shot);
  }

  /**
   * ギフト通知の一式(フラッシュ/シェイク/ギフトカード/粒子)。カットイン無しの
   * ギフトは到着時に、カットイン有りは finishBandFx が終了時に呼ぶ。
   * fxRef はここで読み直すこと — 途中で canvas が remount されると、入口で掴んだ
   * 参照は破棄済みエンジンを指す。
   */
  function giftImpactVisuals(e: ChallengeEffect, shot: number): void {
    const tier = tierForDiamonds(e.diamonds ?? 0);
    const fx = fxRef.current;
    // 「照明」= 画面フラッシュ。flash 指定は「確実に見える t2 相当」を保証
    // するだけで tier を偽らない(旧実装は小額 flash ギフトが t3 に化けた)。
    pushFlash(`gift-t${Math.max(tier, e.flash ? 2 : 1)}`);
    // shake は反復しない — .monitor-root の className に載せて data 属性だけ key で
    // 変える作りなので、同じクラスの連続 shake は CSS アニメが再スタートせず1回しか
    // 揺れない(直すには remove→reflow→add が要る。既知の制限)。
    if (shot === 0 && tier >= 2) pushShake(tier >= 4 ? 'shake-strong' : 'shake');
    // お助け(ファンスタンプ)は専用バナー。ギフトカードも tier の金色粒子も出さない —
    // 1ダイヤ・高頻度で届くので両方出すと上限3枠(FLOAT_MAX)を食い潰し、フォロー/いいねの行が
    // 押し流される。判定は effect の焼き込み(cfg は 120 秒ポーリング(CFG_POLL_MS)で古くなりうる)。
    if (e.fanStamp) {
      if (shot === 0) {
        // 既定は減算(お助け)だが amountEach は正にもできる設定なので符号で言い換える。
        const sign = e.amount > 0 ? `+${num(e.amount)}` : e.amount < 0 ? `${num(e.amount)}` : '±0';
        const what = e.amount < 0 ? 'がお助け!' : e.amount > 0 ? 'が妨害!' : 'がファンスタンプ!';
        // 連打は amount へ畳み込み済み(worker 規約)。×N を出さないと
        // 「1個 −3 の設定なのに −30」が読めない。
        const times = (e.giftCount ?? 1) > 1 ? ` ×${num(e.giftCount ?? 1)}` : '';
        pushFloat(
          <>
            <span className="f-heart">💖</span>
            <span className="f-amt">{sign}</span>
            <span className="f-txt">
              <b>{e.nickname ?? ''}</b> {what}
              {times}
            </span>
          </>,
          `banner-helper ${e.amount > 0 ? 'bad' : 'good'}`
        );
      }
      // 粒はコメント応援と同じ緑 — 「応援」の色をギフトの金と混ぜない。
      const o = fxOrigin();
      fx?.sparkBurst(o.x, o.y, 14, { hue: 140, speed: 420 });
      return;
    }
    if (shot === 0) {
      const gift = e.giftName ?? 'ギフト';
      const sign = e.amount > 0 ? `+${num(e.amount)}` : e.amount < 0 ? `${num(e.amount)}` : '±0';
      // ギフトカードは連打全体の要約(「バラ ×10 💎10 +10」)なので1枚だけ。
      // 反復ぶん出すと上限3枠(FLOAT_MAX)を食い潰してフォロー/いいねの行が押し流される。
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
        </>,
        `gift-card t${tier} ${e.amount > 0 ? 'bad' : 'good'}`
      );
    }
    if (fx) {
      const o = fxOrigin();
      // 反復は粒子を1段落として粒数も半減する — t4 は1発で紙吹雪 240 粒なので、
      // 素で5連発するとエンジン(上限2000粒)が詰まって全体が重くなる。
      const t = shot === 0 ? tier : Math.max(1, tier - 1);
      const half = shot === 0 ? 1 : 0.5;
      if (t >= 4) {
        fx.rays(o.x, o.y, { count: 12, hue: 45 });
        fx.fireworkVolley(o.x, o.y, { count: 3, hue: 45 });
        fx.confettiRain(Math.round(240 * half), { gold: true });
      } else if (t === 3) {
        fx.rays(o.x, o.y, { count: 10, hue: 45 });
        fx.sparkBurst(o.x, o.y, 40, { hue: 45, speed: 640 });
        fx.confettiRain(Math.round(120 * half));
      } else if (t === 2) {
        fx.sparkBurst(o.x, o.y, 26, { hue: 45, speed: 540 });
        fx.confettiRain(Math.round(40 * half));
      } else {
        fx.sparkBurst(o.x, o.y, 12, { hue: 45, speed: 420 });
      }
    }
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
        // バナーが 2 倍になったぶん、粒の数だけでなく大きさも上げる — 数だけ
        // 増やすと 203px のバナーに対して 10〜30px の粒が砂粒に見えてしまう。
        fx?.sparkBurst(o.x, o.y, 40, { hue: 0, speed: 700, size: 1.6 });
        fx?.heartBurst(o.x, o.y, 18, { hue: 0, size: 1.6 });
        if (cfg) playMini(miniForSlot(cfg.challenge, 'follow'), e.amount);
        return;
      }
      case 'like': {
        // 高頻度なのでフラッシュ/シェイクは付けない — 合算済みの +N だけ流す。
        // バナーは7セグ着弾(impactStrike)まで我慢する — 「アニメーション → 通知」。
        // 我慢するのはチェーン飛行中だけでなく、持ち越し(pendingStrike)や
        // カットイン中も含む(shared/fx-floats の shouldDeferFloat)— 出す先が
        // 居るのに今出すと、不透明カットインの上で一瞬光って本番の着弾では消える。
        // どれも無い(effect が値より遅れて届いた flushLikeFx 経路や reduced motion)
        // ときだけ即時に出す — 着弾が来ずに闇に消えるのを防ぐ。
        if (shouldDeferFloat(floatHoldState())) {
          // 保留は畳み込み — カットイン中に何件届いても、flush で出るのは合算1枚。
          pendingLikeFloats.current = mergePendingFloat(pendingLikeFloats.current, e.amount);
        } else {
          pushFloat(likeFloatNode(e.amount), 'bad like-float');
        }
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
      case 'comment': {
        // 指定コメント妨害。赤フロートに「誰が・どのキーワードで」を載せる。
        // 毎回反応の仕様で連投されうるので、フラッシュ/シェイクは付けない
        // (like と同じ判断 — フォローの flash/shake は1人1回だから許される)。
        pushFloat(
          <>
            <span className="f-amt">+{num(e.amount)}</span>
            <span className="f-txt">
              <b>{e.nickname ?? ''}</b> が{e.commentKeyword ? `「${e.commentKeyword}」` : 'コメント'}!
            </span>
          </>,
          'bad'
        );
        const o = fxOrigin();
        fx?.sparkBurst(o.x, o.y, 14, { hue: 0, speed: 420 });
        if (cfg) playMini(miniForSlot(cfg.challenge, 'comment'), e.amount);
        return;
      }
      case 'gauge-full': {
        // 実演専用(testEffect 由来のみ)。ライブ経路の着弾チェーンは likeGauge.fills
        // の差分駆動なので、この kind の effect は作られない。stock-full の実演と
        // 同じ条件で、現在値のまま着弾チェーンだけ試写する — held === prevV なので
        // 数字は動かず、弾の飛翔 → segフラッシュ/ジョルト → SE → 簡易演出が出る。
        if (
          e.test &&
          strikeTimers.current.length === 0 &&
          !rouletteHold.current &&
          !bandHold.current &&
          !stockCutinHold.current &&
          !boostHold.current &&
          !prefersReducedMotion()
        ) {
          const held = Math.max(0, e.valueAfter - e.amount);
          startStrike(held, held, e.amount, 0);
        } else if (e.test) {
          fxWarn('gauge-full の実演を開始できない(他演出の再生中 / 動きの抑制)');
        }
        return;
      }
      case 'stock-full': {
        // フラッシュ/シェイク/クリップ/SE は着弾側(impactStock)が担当する
        // (gauge-full と同じ分担)。バナーも2発目(緑)の着弾まで我慢して
        // revealStock で出す — 「アニメーション → 通知」。チェーン・持ち越し・
        // カットインのどれも無いときだけ即時(shouldDeferFloat)。
        //
        // 実演(設定画面の▶): 着弾チェーンは fills 差分駆動でテストでは再現でき
        // ないので、カットインだけ試写する。据え置きは e.valueAfter - e.amount =
        // 現在値(testEffect は値を変えない)なので数字は動かず、reveal でパンチ
        // だけ出る。バナーは下の保留判定で保留 → reveal 時に出る。
        if (
          e.test &&
          stockCutinReady() &&
          strikeTimers.current.length === 0 &&
          !rouletteHold.current &&
          !bandHold.current &&
          !stockCutinHold.current &&
          !boostHold.current
        ) {
          setHeldValue(Math.max(0, e.valueAfter - e.amount));
          startStockCutin(e.amount);
        } else if (e.test) {
          // カットインを出せない実演でも無反応にはしない — gauge-full の実演と
          // 同じく理由を残し、他演出が無ければ即時 reveal(据え置きなしなので
          // 数字は動かず、パンチ/シェイク/粒子/SE だけ試写される)。
          const busy =
            strikeTimers.current.length > 0 ||
            rouletteHold.current ||
            bandHold.current ||
            stockCutinHold.current ||
            boostHold.current;
          fxWarn('stock-full 実演: カットイン不可 — 即時演出へフォールバック', {
            clipMissing: STOCK_CUTIN_CLIP_URL === null,
            clipsEnabled: cfg?.challenge.fxClipsEnabled ?? false,
            reducedMotion: prefersReducedMotion(),
            busy,
          });
          if (!busy && !prefersReducedMotion()) revealStock(e.amount);
        }
        if (shouldDeferFloat(floatHoldState())) {
          pendingStockFloats.current = mergePendingFloat(pendingStockFloats.current, e.amount);
        } else {
          pushFloat(stockFloatNode(e.amount), 'bad like-float');
        }
        return;
      }
      case 'gift': {
        // 連打ギフト(コンボ)の反復。worker が effect に焼き込んだ回数ぶん、同じ
        // 見た目を間隔をあけて撃つ。**値は worker が1回だけ適用済み**なので、
        // ここのタイマーが全部死んでも数字は正しいまま — 安全弁は要らない。
        //
        // 絶対オフセット(gap * i)で一括 arm するのが肝。自己再スケジュールの連鎖に
        // すると、mac の遮蔽ウィンドウで setTimeout が ~1Hz に絞られたとき全体が
        // 伸びて worker の凍結尺を追い越す(一括なら復帰時のバーストに畳まれるだけ)。
        const { rep, gap } = giftFxShots(e);
        playGiftVisual(e, 0);
        if (rep > 1 && repeatTimers.current.length < GIFT_FX_REPEAT_TIMERS_MAX) {
          for (let i = 1; i < rep; i++) {
            // 発火時に自分の id を配列から抜く — 抜かないと発火済み id が上限
            // ガードに積もり、累計64発を超えた時点で以降のコンボ演出が消える。
            const id = window.setTimeout(() => {
              const a = repeatTimers.current;
              const at = a.indexOf(id);
              if (at !== -1) a.splice(at, 1);
              playGiftVisual(e, i);
            }, gap * i);
            repeatTimers.current.push(id);
          }
        }
        return;
      }
      case 'roulette': {
        // 演出に必要な盤面が無い(旧 worker との混在等)/動きの抑制設定なら、
        // リールは諦めてバナーだけ出す — 値は worker が適用済みなので破綻しない。
        // 判定は譲る側(yieldToCutin)と同じ rouletteWillSpin を共有する。
        if (!rouletteWillSpin(e)) {
          fxWarn('ルーレットのリール開始不可 — バナーのみ出す', {
            segments: e.rouletteSegments?.length ?? 0,
            index: e.rouletteIndex,
            reducedMotion: prefersReducedMotion(),
          });
          pushFloat(rouletteBanner(e), `${e.amount < 0 ? 'good' : 'bad'} banner-roulette`);
          return;
        }
        // カットイン据え置き中も積む。ここで走らせると、直後に finishBandFx が
        // setHeldValue(null) を実行して回転中に数字が最終値へ飛ぶ(= 出目が先漏れ)。
        // playGiftVisual の busy 判定と同じ形に揃える。
        if (rouletteHold.current || bandHold.current || stockCutinHold.current || boostHold.current) {
          // 再生中はキューへ。溢れた分は演出スキップ(数字は解除時に一括で合う)。
          if (rouletteQueue.current.length < ROULETTE_QUEUE_MAX) rouletteQueue.current.push(e);
          return;
        }
        startRoulette(e, false);
        return;
      }
      case 'boost-start': {
        // 他演出の再生中は持ち越す(pendingBands と同型・2件上限)。テストは
        // 持ち越さずスキップ — ▶ は今すぐ見たいもので、数十秒後に因果不明の
        // 再生が始まるほうが混乱する。
        if (rouletteHold.current || bandHold.current || stockCutinHold.current || boostHold.current) {
          if (e.test) {
            fxWarn('tapBoost 実演: 他演出の再生中 — スキップ');
            return;
          }
          if (pendingBoosts.current.length < 2) pendingBoosts.current.push(e);
          return;
        }
        // 持ち越さない直行経路でも遅れは起きる — freshChallengeEffects は
        // EFFECT_FRESH_MS(5秒)まで古い effect を通すので、既定設定
        // (前置き8秒 + ウィンドウ5秒)だと 4.9 秒遅れの再生でタップ可能時間が
        // 0.1 秒しか残らない。判定はキュー経路とまったく同じものを共有する。
        const directPlan = planBoostStart(boostStartTiming(e), Date.now());
        if (directPlan.action === 'skip') {
          // 終わったフィーバーの「発動!」バナーは出さない — 結果は boost-end 側が出す。
          fxWarn('フィーバーの期限切れ — 再生しない(直行経路)', {
            reason: directPlan.reason,
            atMs: e.atMs,
            endsAtMs: e.boostEndsAtMs,
          });
          return;
        }
        if (!startBoostFx(e, directPlan)) {
          // 動きの抑制等で演出を出せない — 発動の事実だけバナーで残す。
          pushFloat(
            <>
              <span className="f-amt">×{num(e.boostMultiplier ?? 1)}</span>
              <span className="f-txt">
                <b>{e.nickname ?? ''}</b> がフィーバー発動!
              </span>
            </>,
            'good banner-boost'
          );
        }
        return;
      }
      case 'boost-end': {
        // このフィーバーより前に積まれた boost-start は全部死んでいる — worker は
        // 同時に1本しかフィーバーを持たず(activateBoost が前を強制清算する)、
        // boost-end の id は必ずその start より大きい。
        // **期限(boostEndsAtMs)だけでは落とせない**: モニターを閉じた/動きの
        // 抑制を入れた等の強制清算(worker の applyFxCapsChange)では、期限が
        // まだ未来のままフィーバーが終わっている。
        // 押し出し効果もある — 積む側の上限は2件なので、死んだ1件が枠を占めると
        // 直後の**生きた**ブーストが入り口で捨てられる。
        if (pendingBoosts.current.length > 0) {
          const alive = pendingBoosts.current.filter((x) => x.id > e.id);
          if (alive.length !== pendingBoosts.current.length) {
            fxWarn('boost-end: 終了済みフィーバーの持ち越しを破棄', {
              dropped: pendingBoosts.current.length - alive.length,
            });
            pendingBoosts.current = alive;
          }
        }
        if (boostHold.current) {
          finishBoostFx(e);
          return;
        }
        // 据え置きが無い(モニターを途中で開いた・演出が始まらなかった)—
        // 結果のバナーと着弾音だけ出す。数字は値変化側のパンチが受け持つ。
        pushBoostEndBanner(e);
        if (cfg?.challenge.seEnabled && (e.boostTapCount ?? 0) > 0) {
          playSe(
            cfg.challenge.seSounds['boost-end'],
            effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['boost-end'])
          );
        }
        return;
      }
      case 'achieved':
        // ルーレットのリール/カットインの再生中は持ち越す — 出目・演出を見せる前に
        // CLEAR のフラッシュが走ると何で達成したのか読めない。
        // finishRoulette / finishBandFx / finishBoostFx が再生する。
        if (rouletteHold.current || bandHold.current || stockCutinHold.current || boostHold.current) {
          pendingAchieved.current = e;
          return;
        }
        // リザルト画面のタイマー基準。achievedMs(worker 時刻)ではなく「実際に
        // CLEAR 演出を再生した瞬間」を使う — カットイン持ち越し明けでも
        // 「CLEAR 演出 → RESULT_DELAY_MS → リザルト」の順序が保たれる。
        setAchievedFxAt(Date.now());
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
        // この窓にトーストは無い — 失敗は握って unhandled rejection だけ防ぐ
        // (worker 復帰後の delta / 次の押下で回復する)。テスト再生(▶)中の
        // タップも worker が数える(testBoost ウィンドウ)ので、実発動と同じ
        // press RPC 1本で済む。
        void rpc('challenge.press', undefined).then(setChallenge).catch(() => undefined);
      } else if (ev.key === 'Escape') {
        void rpc('monitor.close', undefined).catch(() => undefined);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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
  // 「何時起き」— 有効かつ時刻が入っているときだけ最下段の行を足す。
  const wakeTime = cfg?.challenge.wakeEnabled ? (cfg.challenge.wakeTime ?? null) : null;
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
      onPointerDown={() => {
        // テスト再生(▶)中のタップも worker が数える(キー入力側と同じ)。
        void rpc('challenge.press', undefined).then(setChallenge).catch(() => undefined);
      }}
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
      className={`monitor-root${wakeTime ? ' has-wake' : ''}${shake ? ` ${shake.cls}` : ''}`}
      data-shake={shake?.key}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget) {
          clearShakeTimer();
          setShake(null);
        }
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
          <LikeGauge gauge={challenge.likeGauge} fxRef={fxRef} trackRef={gaugeTrackRef} stockRowRef={stockRowRef} showAvatars={showAvatars} />
        ) : null}
      </div>

      {/* ボタン/妨害などの内訳は視聴者には見せない。配信時間だけ出す。 */}
      <div className="elapsed-row">
        配信時間: {totals.elapsedMs > 0 ? elapsedText(totals.elapsedMs) : '—'}
      </div>

      {/*
        ギフトランキング TOP3。ソースは worker の runRank ただ一つ — チャレンジの
        ラン単位(開始/リセットでクリア)なので、ダッシュボードの「リセット」で
        その場で空になる。CLEAR リザルト TOP5 の先頭3件とも必ず一致する。
        配信が終わったら出さない。判定に sessionId を使うのは、これが delta と
        status の両方に乗るから — AdapterStatus は遷移時にしか飛ばないので、
        配信中に開き直したモニター窓には 'idle' のまま何も届かない。
        自動再接続中は sessionId が生きたままなので、瞬断で順位が消えることもない。
      */}
      <div className="ranking">
        {Array.from({ length: CHALLENGE_MONITOR_TOP_N }, (_, i) => {
          const g = sessionId != null ? challenge.runRank?.[i] : undefined;
          return (
            <div key={g?.userId ?? `ph-${i}`} className={`rank rank-${i + 1}`}>
              <div className="rank-place">{i + 1}位</div>
              {g ? (
                <>
                  {/* 空名のフォールバックは ResultList と揃える(同じ worker 由来の行なので)。 */}
                  <Avatar url={g.avatarUrl} name={g.nickname || '?'} size={80} enabled={showAvatars} />
                  <div className="rank-name">{g.nickname || '名無し'}</div>
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
        「何時起き」。通常フローのグリッドアイテムなので、下の絶対配置オーバーレイ群
        (.result-screen / .fx-clip / .fx-layer)より必ず下に描かれる。それらは
        z-index ではなく DOM 順に依存しているので、この要素は必ずその手前に置くこと。
      */}
      {wakeTime ? <WakeRow wakeTime={wakeTime} refMs={challenge.startedMs} /> : null}

      {/*
        CLEAR リザルト(全画面)。配置は monitor-root 直下・fx-clip より DOM 順で前。
        - z-index は付けない。付けると position 済みなのでスタッキングの段が上がり、
          z-index:auto の .fx-clip より手前に回って演出クリップが隠れる。
        - fx-layer(z-index:50)と fx-clip は DOM 順で後ろなので、CLEAR のフラッシュ・
          紙吹雪・映像クリップはリザルトの上でそのまま見える。
        - 下の 7セグ等は unmount せず覆うだけ。display:none にすると
          fxRef.pointFor(countdownRef) の矩形が潰れ、簡易演出と波紋が中央へ退避する。
      */}
      {/*
        手動の全画面ランキング(ダッシュボードの「ランキング表示」トグル)。
        キーの有無がそのまま表示状態なので、ここでは真偽判定だけでよい。
        - CLEAR リザルトと同じ .result-screen を使うので、上の z-index/DOM 順の
          規約がそのまま効く(z-index を付けない・fx-clip より DOM 順で前)。
        - リザルトより **前** に置く。両方出る瞬間があってもリザルトが上に来る。
          worker は達成時に rankBoard を畳むので通常は重ならないが、念のため
          showResult でも伏せる(オーバーレイ2枚重ねを絶対に作らない)。
        - 中身は CLEAR と同じ ResultList。表示中は毎 delta で組み直されるので
          順位はライブに動く。
      */}
      {challenge.rankBoard && !showResult ? (
        <div className="result-screen board">
          <div className="rs-title">ランキング</div>
          <div className="rs-sub">{challenge.title}</div>
          <div className="rs-lists">
            <ResultList
              title="ギフトランキング TOP5"
              rows={challenge.rankBoard.gifts}
              kind="gift"
              showAvatars={showAvatars}
            />
            <ResultList
              title="イイネランキング TOP5"
              rows={challenge.rankBoard.likes}
              kind="like"
              showAvatars={showAvatars}
            />
          </div>
          <div className="rs-foot">
            {challenge.rankBoard.participants > 0
              ? `参加 ${num(challenge.rankBoard.participants)}人 / 経過 ${
                  challenge.rankBoard.startedMs
                    ? elapsedText(challenge.rankBoard.atMs - challenge.rankBoard.startedMs)
                    : '—'
                }`
              : 'まだ参加者がいません'}
          </div>
        </div>
      ) : null}

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
          ref={(v) => armVideoPlay(v, 'fx-clip', () => nextClip(clip.key))}
          onEnded={() => nextClip(clip.key)}
          // デコード失敗でも演出は canvas 側が主役なので、理由だけ残して次へ送る。
          onError={(ev) => {
            fxWarn('fx-clip の再生エラー', ev.currentTarget.error);
            nextClip(clip.key);
          }}
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
          ref={(v) =>
            armVideoPlay(v, 'fx-strike', () => {
              clearStrikeClipTimer();
              setStrikeClip((c) => (c?.key === strikeClip.key ? null : c));
            })
          }
          onEnded={() => {
            clearStrikeClipTimer();
            setStrikeClip((c) => (c?.key === strikeClip.key ? null : c));
          }}
          onError={(ev) => {
            fxWarn('fx-strike(着弾クリップ)の再生エラー', ev.currentTarget.error);
            clearStrikeClipTimer();
            setStrikeClip((c) => (c?.key === strikeClip.key ? null : c));
          }}
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
          playsInline
          loop
          preload="auto"
          // 全面カット(assets/fx/cut/*.mp4)だけは素材に音声が焼き込んであるので
          // muted を外す。帯域カットインは無音素材なので常に muted のままで、音は
          // 別ファイルの bandBgm 側(二重に鳴らさないための唯一の分岐点)。
          // 効果音オフなら映像ごと無音 — stock-cutin と同じ扱い。
          muted={!bandClip.fullCut || !(cfg?.challenge.seEnabled ?? true)}
          ref={(v) => {
            // 音量だけは cfg から読む(fxBandBgm の音量と同じ 120 秒ポーリング(CFG_POLL_MS)許容)。
            if (v && bandClip.fullCut) v.volume = (cfg?.challenge.giftFullCut?.volume ?? 70) / 100;
            // 再生失敗の即時解除 — 放置すると bandHold が totalMs(最大45秒)まで
            // 数字を据え置いたまま真っ黒になる(finishBandFx は hold ガードで冪等)。
            return armVideoPlay(v, 'band-cutin', finishBandFx);
          }}
          onError={(ev) => {
            fxWarn('カットイン(bandClip)の再生エラー', ev.currentTarget.error);
            finishBandFx();
          }}
        />
      ) : null}

      {/*
        ストック着弾カットイン(不透明フルフレーム・音声焼き込み)。配置の制約は
        .fx-clip-opaque と同じ — .monitor-root 直下・z-index なし。バンドと違い
        muted にしない(BGM は mp4 の音声トラック側)。音量は専用設定
        stockCutinVolume(既定 70)で、効果音オフなら映像ごと無音。尺は STOCK_CUTIN_MS の
        タイマー(startStockCutin)が権威で、loop なし・onEnded も使わない
        (素材が短くても最終フレーム静止 → フェードで隠れる)。
      */}
      {stockCutin ? (
        <video
          key={stockCutin.key}
          className={`fx-clip fx-clip-opaque${stockCutin.out ? ' out' : ''}`}
          src={STOCK_CUTIN_CLIP_URL ?? undefined}
          autoPlay
          playsInline
          preload="auto"
          muted={!(cfg?.challenge.seEnabled ?? true)}
          ref={(v) => {
            // 専用設定の絶対値(giftFullCut.volume と同じ流儀)。着弾効果音
            // stock-burst と共用だった seVolumes['stock-full'] からは切り離してある —
            // あちらは配布デフォが 16% で、動画の音まで 11% に潰していた。
            if (v) v.volume = (cfg?.challenge.stockCutinVolume ?? 70) / 100;
            return armVideoPlay(v, 'stock-cutin', finishStockCutin);
          }}
          onError={(ev) => {
            fxWarn('ストック着弾カットインの再生エラー', ev.currentTarget.error);
            finishStockCutin();
          }}
        />
      ) : null}

      {/*
        タップブーストのカットイン(不透明フルフレーム・音声焼き込み)。配置の
        制約は .fx-clip-opaque と同じ — .monitor-root 直下・z-index なし。
        起動(intro)と結果カットシーン(result・boost-end 後の発表前置き)は
        loop なし・1回再生、ウィンドウはループ動画+BGM(音声トラック側)なので
        loop。尺は startBoostFx / finishBoostFx のタイマーが権威(onEnded は
        使わない)。再生失敗は映像だけ諦めて暗幕へ
        落とす — タイマーとカウンタは生きているのでゲームは続行する。
        素材なし(url null)は最初から暗幕。
      */}
      {boostClip ? (
        boostClip.url != null ? (
          <video
            key={boostClip.key}
            className={`fx-clip fx-clip-opaque${boostClip.out ? ' out' : ''}`}
            src={boostClip.url}
            autoPlay
            playsInline
            loop={boostClip.phase === 'window'}
            preload="auto"
            muted={!(cfg?.challenge.seEnabled ?? true)}
            ref={(v) => {
              if (v) {
                v.volume =
                  effectiveSeVolume(
                    cfg?.challenge.seVolume ?? 70,
                    cfg?.challenge.seVolumes?.['boost-start']
                  ) / 100;
              }
              return armVideoPlay(v, 'boost-cutin', () =>
                setBoostClip((c) => (c ? { ...c, url: null } : c))
              );
            }}
            onError={(ev) => {
              fxWarn('ブーストカットインの再生エラー — 暗幕で続行', ev.currentTarget.error);
              setBoostClip((c) => (c ? { ...c, url: null } : c));
            }}
          />
        ) : (
          <div className={`boost-screen${boostClip.out ? ' out' : ''}`} />
        )
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
        {minis.map((m) => (
          <div
            key={m.key}
            className="mini"
            style={{ left: m.x, top: m.y, width: m.w, height: m.h }}
            onAnimationEnd={(ev) => {
              // SVG 内の子アニメーション(着弾の星)のバブリングで早死にしないよう、
              // 自分の直下要素の終了だけを拾う。
              if (ev.target !== ev.currentTarget.firstChild) return;
              setMinis((s2) => s2.filter((x) => x.key !== m.key));
            }}
          >
            <MiniFx id={m.id} amount={m.amount} />
          </div>
        ))}
        {roulette ? (
          // 暗幕ラッパーには key を付けない — キュー消化の連鎖では roulette が
          // truthy のまま切り替わるため、ラッパー DOM を再利用させて暗幕の
          // フェードインがスピンごとに再生されるチラつきを防ぐ。
          <div className="roulette-screen">
            <RouletteFx
              key={roulette.key}
              segments={roulette.effect.rouletteSegments ?? []}
              index={roulette.effect.rouletteIndex ?? 0}
              amount={roulette.effect.amount}
              fast={roulette.fast}
              pattern={roulette.effect.roulettePattern ?? 'slow'}
              seed={roulette.effect.id}
              onNearStop={nearStopRoulette}
              onKick={kickRoulette}
              onSpinQuiet={() => {
                // 終盤の段(保持・フェイク停止)ではリールが止まって見える —
                // ループ音だけ先に閉じる。BGM は連鎖の終端(finishRoulette)まで流す。
                rouletteSpinSe.current?.stop(150);
                rouletteSpinSe.current = null;
              }}
              nickname={roulette.effect.nickname}
              rouletteLabel={roulette.effect.rouletteLabel}
              giftName={roulette.effect.giftName}
              giftIconUrl={roulette.effect.giftIconUrl}
              onDone={() => finishRoulette(roulette.effect, roulette.spin)}
            />
          </div>
        ) : null}
        {/*
          タップウィンドウ中のタップカウンタ。fx-layer 内(z-index:50)なので
          不透明カットイン動画より必ず手前。表示は challenge.boost(worker 権威)
          が唯一のソースで、press RPC の nudge によりタップのたび即時更新される。
          inner の key=tapCount で再マウントさせてパンチアニメを毎タップ再生する。
          テスト実演(boost 状態なし)は 0 のまま倍率バッジだけ動く。
        */}
        {boostClip && boostClip.phase === 'window' && !boostClip.out ? (
          <div className="boost-overlay">
            <div className="boost-counter" ref={boostCounterRef}>
              <div className="boost-count" key={shownBoostTap}>
                {num(shownBoostTap)}
              </div>
              <div className="boost-label">TAP!</div>
              <div className="boost-mult">
                ×{num(challenge.boost?.multiplier ?? boostEffect.current?.boostMultiplier ?? 1)}
              </div>
            </div>
          </div>
        ) : null}
        {/*
          清算発表(パチンコ風「-N」)。roll 中の桁は finishBoostFx の rAF が
          boostSettleAmtRef.textContent へ直書きする — stage が変わると key で
          再マウントされ、React 描画(確定値)に戻る。fly の弾本体は fx.strike の
          canvas 粒子で、この要素自体は縮小フェードするだけ。
        */}
        {boostSettle ? (
          <div className={`boost-settle ${boostSettle.stage}`}>
            <div className="boost-settle-counter" ref={boostSettleRef}>
              <div
                className="boost-settle-amt"
                key={`${boostSettle.key}:${boostSettle.stage}`}
                ref={boostSettleAmtRef}
              >
                -
                {boostSettle.stage === 'roll'
                  ? rollupDisplayAt(boostSettle.amount, 0, boostSettle.rollupMs, boostSettle.seed).text
                  : String(boostSettle.amount)}
              </div>
              <div className="boost-settle-sub">
                タップ×{num(boostSettle.tap)}
                {boostSettle.mult > 1 ? <b> {num(boostSettle.mult)}倍</b> : null}
              </div>
            </div>
          </div>
        ) : null}
        <div className="floats">
          {floats.map((f) => (
            <div
              key={f.key}
              className={`float ${f.cls}`}
              onAnimationEnd={(ev) => {
                // ギフトカード内の子アニメーション(シマー等)のバブリングで
                // 早死にしないよう、自分自身の浮上アニメ終了だけを拾う。
                //
                // **擬似要素は target では弾けない**: ::after の float-shine(1.6s 固定)
                // が終わると target === currentTarget のままイベントが届くので、
                // animation-duration を 2.2s に伸ばした .float.gift-card が 1.6s で
                // 消えていた(::after 側に上書きが無いため)。擬似要素かどうかは
                // ev.pseudoElement('' / '::after')で見る。
                // Electron 43.2.0 / Chrome 150 で実測確認済み。
                if (ev.target !== ev.currentTarget || ev.pseudoElement) return;
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
