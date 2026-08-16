import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type {
  AppSettings,
  ChallengeEffect,
  ChallengeFxQueueItem,
  ChallengeRankRow,
  ChallengeSeSlot,
  RoulettePattern,
} from '@shared/dto';
import {
  CHALLENGE_MINI_IDS,
  CHALLENGE_MONITOR_TOP_N,
  CHALLENGE_RESULT_TOP_N,
  CLIP_ABORT_MS,
  CLIP_QUEUE_MAX,
  FLOAT_ABORT_MS,
  GIFT_FX_REPEAT_TIMERS_MAX,
  MINI_ABORT_MS,
  MINI_MAX,
  PENDING_BANDS_MAX,
  PENDING_BOOSTS_MAX,
  JOIN_ROULETTE_QUEUE_MAX,
  ROULETTE_CHAIN_GAP_MS,
  ROULETTE_QUEUE_MAX,
  SHAKE_ABORT_MS,
  rouletteAbortMs,
  effectiveSeVolume,
  freshChallengeEffects,
  giftFxShots,
  isChallengeEffectFresh,
  matchGiftMini,
  mergeRoulette,
  miniForSlot,
  rouletteHeadline,
  rouletteReelPlan,
  rouletteRemainingAmount,
  sameRouletteBoard,
  tierForDiamonds,
} from '@shared/challenge';
import { num } from '@shared/format';
import { CFG_POLL_MS } from '@shared/constants';
import { bestDrainRank, peekNextDrainKind, runFxDrain, type FxDrainQueues } from '@shared/fx-drain';
import {
  BANNER_PRIORITY,
  bannerRank,
  shouldYieldSpinChain,
  strikeClass,
  type FxBannerKind,
  type FxDrainKind,
  type FxPriorityClass,
} from '@shared/fx-priority';
import { rouletteTeaseInit, rouletteTeaseStep, type RouletteTeaseState } from '@shared/roulette-tease';
import {
  BANNER_QUEUE_MAX,
  bannerEndAtFor,
  bannerWinsByRank,
  bestQueuedRank,
  clampBannerEndAt,
  clampStarveServedAt,
  enqueueBanner,
  pickStageNext,
  stageWaitMs,
  takeNextBanner,
} from '@shared/fx-stage';
import {
  EMPTY_FX_STOCK,
  buildFxStock,
  fxStockKey,
  type FxStockPlaying,
  type FxStockView,
} from '@shared/fx-stock';
import { boostStartTiming, planBoostStart, type BoostStartPlan } from '@shared/boost-start';
import {
  mergePendingFloat,
  shouldDeferFloat,
  shouldFlushDeferredFloats,
  type FloatHoldState,
  type PendingFloat,
} from '@shared/fx-floats';
import { fanStampBannerParts } from '@shared/fan-stamp';
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
import { countdownClass, segDigits } from './seg-class';
import { LikeGauge } from './LikeGauge';
import { WakeRow } from './WakeRow';
import { FxStockRow } from './FxStockRow';
import { FxCanvas } from './fx/FxCanvas';
import type { FxEngine } from './fx/engine';

/**
 * 背面モニター画面(縦型フルスクリーン想定)。
 *
 * 構成(上から): 企画タイトル(左上に配信時間を小さく重ねる)/ 7セグ残数 /
 * いいね進捗ゲージ / 演出ストック(待機中の演出チップ)/ ギフトランキング TOP3。
 * FxLayer が照明フラッシュ・紙吹雪・±N 浮上を重ねる。
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
/**
 * 舞台の順番待ちに積まれた ±N 浮上バナー1枚。
 * `se` は「映像と同時に鳴らす効果音スロット」— 到着時に鳴らすと、順番待ちのぶん
 * 音だけ先に出てズレる(useChallengeSe の stageSynced と対)。
 */
/** runDrain のフック。予約(pendingDrain)に載せるので型名を付ける。 */
interface DrainHooks {
  onNext?: (kind: FxDrainKind) => void;
  onIdle?: () => void;
}
/**
 * ルーレットキュー(gift / join)の1要素。resumeAt = この effect の何本目から
 * 再開するか(0 = 通常品)。§6b の連鎖の譲り合い(リール境界プリエンプション)
 * だけが resumeAt > 0 を作り、unshift で先頭へ戻す —
 * **resumeAt > 0 の要素は各キュー高々1件・常に先頭**が不変条件
 * (mergeRoulette の末尾連結は末尾要素の resumeAt を維持し、位置を動かさない)。
 */
interface QueuedRoulette {
  e: ChallengeEffect;
  resumeAt: number;
  queuedAtMs: number;
}
interface QueuedBanner {
  node: React.ReactNode;
  cls: string;
  /** 優先クラスの引き当てキー(fx-priority の BANNER_PRIORITY / bannerRank)。 */
  kind: FxBannerKind;
  se: ChallengeSeSlot | null;
  /**
   * バナーに随伴する演出(フラッシュ / シェイク / 粒子 / 簡易演出)。
   * **到着時に撃ってはいけない** — バナーだけ順番待ちに載ると、光と揺れだけが
   * 先に走って再生中の演出に重なる(直そうとしている症状そのもの)。
   * fxRef はこの中で読み直すこと(canvas が remount されると入口の参照は死ぬ)。
   */
  onShow?: (() => void) | undefined;
  /** 積まれた時刻。飢餓弁(pickStageNext)の判定に使う。 */
  atMs: number;
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
 * 着弾チェーンが飛行中で舞台を明け渡せないときの再確認間隔。チェーンの終端
 * (impactStrike / revealStock / abortStrike)は必ずしも pumpStage を呼ばないので、
 * 「順番待ちのバナーがあるのにチェーンが終わって誰も進めない」を最大この長さの
 * 遅れへ落とすためだけのポーリング。チェーンと行列が両方ある間しか張られない。
 */
const STAGE_RECHECK_MS = 400;

/**
 * ホールド固着の番犬。各ホールド(roulette/band/stockCutin/boost)の解除は自前の
 * 安全弁タイマーが本線だが、タイマー消失やコールバック内の例外で孤児化すると
 * anyCutinHold() が立ちっぱなしになり pumpStage が全死する(数字も演出も止まる)。
 * MonitorView に時間ベースの脱出口はこの番犬だけ。期限は各 start* が自分の
 * 安全弁と同じ権威尺 + FX_HOLD_GRACE_MS で書くので、正当な長尺演出(連打バンドの
 * 直列再生・連鎖リール等)では発火しない。**hold を true にする箇所は必ず直後に
 * fxHoldDeadlines へ期限を書くこと**(番犬は hold が真の間しか期限を読まない)。
 */
const FX_HOLD_WATCHDOG_MS = 10_000;
/** 番犬の猶予。既存の安全弁より必ず後に発火させる(本線の解除を横取りしない)。 */
const FX_HOLD_GRACE_MS = 5000;
/**
 * ブースト安全弁の余白。startBoostFx(boost-end 待ち)と finishBoostFx(清算発表の
 * 再アーム)の両方が同じ値を使う — 片方だけ調整すると他方の守備範囲が壊れる。
 */
const BOOST_EXPIRE_MARGIN_MS = 3000;

/**
 * 名前入りバナーの下段。ギフト名 / ニックネーム / 動作を**必ず別の行**に割る。
 *
 * 1 本の文を .f-txt に流して CSS だけで折り返させると、"柚木茜(search)" のような
 * 名前が行またぎで裂けて「誰の通知か」が読めなくなる(overflow-wrap:anywhere は
 * 区切りの無い名前を平気で途中で切る)。行そのものを分けてしまえば裂けようがない。
 *
 * 各行は nowrap + 末尾 "…"(monitor.css の .f-line)。gift は省略可 —
 * ギフト名の前置きが要るのはルーレットだけで、フォロー等は 2 行になる。
 */
function nameLines(p: { gift?: string; who: string; act: string }): React.JSX.Element {
  // rouletteHeadline の prefix は区切りの空白を末尾に含む(1 本の文だった名残)。
  const gift = (p.gift ?? '').trim();
  return (
    <span className="f-txt f-lines">
      {gift !== '' ? <span className="f-line f-gift">{gift}</span> : null}
      <span className="f-line f-who">{p.who}</span>
      <span className="f-line f-act">{p.act}</span>
    </span>
  );
}

/**
 * ルーレット確定バナーの中身。回転パネル(RouletteFx)と同じ文言にするため、
 * 前置き/後置きは shared の rouletteHeadline から取る。リールを出す通常経路と、
 * 盤面が無い/動きの抑制設定でリールを諦める経路の2箇所で使う。
 */
function rouletteBanner(e: ChallengeEffect, amount: number = e.amount): React.JSX.Element {
  const head = rouletteHeadline(e);
  const sign = amount < 0 ? `${num(amount)}` : `+${num(amount)}`;
  return (
    <>
      <span className="f-amt">{sign}</span>
      {nameLines({ gift: head.prefix, who: e.nickname ?? '', act: head.suffix })}
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
  return rouletteReelPlan(e).reels.length > 0 && !prefersReducedMotion();
}

/**
 * 尺の都合で回さなかったぶんの合算バナー。**値は worker が適用済み**なので、
 * これを出さないと「数字だけ黙って動く」最悪の見え方になる。
 */
function rouletteRestBanner(e: ChallengeEffect, amount: number, count: number): React.JSX.Element {
  const head = rouletteHeadline(e);
  const sign = amount < 0 ? `${num(amount)}` : `+${num(amount)}`;
  return (
    <>
      <span className="f-amt">{sign}</span>
      {nameLines({
        gift: head.prefix,
        who: e.nickname ?? '',
        act: `${head.suffix}(残り${count}回ぶん)`,
      })}
    </>
  );
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
  const workerState = useLive((s) => s.workerState);
  /**
   * worker の世代(liveStore)。**演出 watermark の唯一のリセット信号** —
   * 再起動すると effect の id が 1 から振り直されるので、ここが変わったら
   * lastPlayed を null(= 全件再生済みに倒す)へ戻す。
   */
  const workerEpoch = useLive((s) => s.workerEpoch);
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

  // タイマー(armBannerTimer → 張った時点のレンダーの pumpStage → showBannerNow)
  // 越しに呼ばれる関数が state を直読みすると、タイマーを張った時点の値で固まる
  // (ステールクロージャ)。ref を毎レンダー同期し、タイマー越しに読まれる
  // playSeSlot / playMini だけこちらを使う(clipKey と同じ「同期は ref」の流儀)。
  const cfgRef = useRef<AppSettings | null>(null);
  cfgRef.current = cfg;
  const landscapeRef = useRef(false);
  landscapeRef.current = landscape;

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
  /*
   * ── 舞台(stage)の占有 ────────────────────────────────────────────────
   * ±N 浮上バナーは「同時に1枚だけ」「消えてから次(バナーでも演出でも)」。
   * 判定は shared/fx-stage.ts の純関数、状態はこの3本だけ。
   *
   * bannerEndAt は【時刻ラッチ】— boolean にしてはいけない。遮蔽ウィンドウで
   * setTimeout が絞られたり animationend が届かなかったりするとフラグが立ちっ
   * ぱなしになり、以後すべての演出が永久にキューされる(モニターの全死)。
   * 絶対時刻なら誰も何もしなくても「今」が過ぎた瞬間に解放される。
   * 0 = 遥か過去 = 空き、が初期値としてそのまま機能する。
   */
  const bannerEndAt = useRef(0);
  const bannerQueue = useRef<QueuedBanner[]>([]);
  /** 舞台を進める唯一のタイマー。常に1本だけ(張り直しは clearBannerTimer 経由)。 */
  const bannerTimer = useRef<number | null>(null);
  /** finish* が予約したドレイン。間合いが明けたら pumpStage が実行する。 */
  const pendingDrain = useRef<{ hooks?: DrainHooks } | null>(null);
  /**
   * 飢餓弁が最後にバナーを通した時刻(0 = 未発火)。bannerEndAt と同じ
   * 【時刻ラッチ】— boolean にすると固着して弁が死ぬ。書くのは pumpStage の
   * 実供給点(追い越し時のみ)と後方ステップ clamp と idle リセットの3箇所だけ。
   */
  const lastStarveServeAt = useRef(0);
  /** pumpStage の同期再入ガード(runDrain → start* → … から戻ってくる経路がある)。 */
  const pumping = useRef(false);
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

  // 数字パンチ: 値が変わるたびに punchKey を進め、classList の付け直しで CSS
  // アニメーションを再生する(remove → リフロー → add は tickGauge と同じ手口)。
  // 方向(減=進捗/増=妨害)でグローの色と動きを変える。
  // かつては punchKey を .countdown の key にした再マウントで再生していたが、数字が動くたびに
  // 7セグ SVG 全体(フィルタ付きポリゴン最大42個)を破棄→再生成するため、
  // 弱い GPU での残像・GC ジッタの温床だった(配布先の実機報告)。
  const prevValue = useRef<number | null>(null);
  const [punchKey, setPunchKey] = useState(0);
  const [punchDir, setPunchDir] = useState<'down' | 'up' | 'strike'>('down');
  useLayoutEffect(() => {
    // paint 前に張り直す(再マウントと同じ見え方)。punchDir は punchKey と同じ
    // コミットで set される(全 setPunchKey 箇所)ので deps は punchKey だけで足りる。
    // 注意: React が className を書き戻すのは segCls の値が変わる再レンダー
    // (low/clear 切替)だけで、そのとき進行中のパンチは途中終了する(低頻度・
    // 尺 ≤1120ms なので許容)。それ以外の再レンダーでは手動クラスは生き残る —
    // React は自分の前回 props としか diff しないため。
    const el = countdownRef.current;
    if (!el) return;
    el.classList.remove('punch-down', 'punch-up', 'punch-strike');
    void el.offsetWidth; // リフローで CSS アニメーションのリスタートを確定させる
    el.classList.add(`punch-${punchDir}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [punchKey]);
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
   * 張らない startStrikeFromPending / 全カットイン終了時のウォッチドッグ。
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
   * 光もバナーも出ない。解除の瞬間(チェーン終端の continueStrikeChain・ドレインの
   * 序列②③)に startStrikeFromPending がフルチェーン1本として出す。
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
  // effect 1件が複数スピンを持つ(連打ギフト)。at はその何本目を回しているか。
  const [roulette, setRoulette] = useState<{
    key: number;
    effect: ChallengeEffect;
    fast: boolean;
    spin: number;
    /** この effect の何本目のリールか(0 始まり)。 */
    at: number;
    /** 実際に回す1本ぶんの出目・パターン・増減量(rouletteDraws の 1 要素)。 */
    draw: { index: number; pattern: RoulettePattern; amount: number };
  } | null>(null);
  const rouletteQueue = useRef<QueuedRoulette[]>([]);
  /** 入室(初見)ルーレット専用キュー(優先度⑥ — rouletteOrigin === 'join')。 */
  const joinRouletteQueue = useRef<QueuedRoulette[]>([]);
  /**
   * ドレイン系キュー(strike / boosts / bands / join / roulettes)が「空 → 非空」に
   * なった瞬間の時刻。全部空になったら null。pickStageNext のドレイン側飢餓弁
   * (DRAIN_STARVE_MS)の入力 — 上位バナーの連流でキュー溢れ=演出消失に落ちる
   * 前に1件流すための時刻ラッチ。更新は noteDrainQueues(refreshFxStock 相乗り)。
   */
  const drainWaitingSinceMs = useRef<number | null>(null);
  /** 据え置きの持ち主がルーレットである印。値変化 effect の strike/punch を黙らせる。 */
  const rouletteHold = useRef(false);
  /**
   * 進行中のスピンの世代。finishRoulette は「自分が始めたスピンの完了か」を
   * これで判定する — rouletteHold の真偽だけだと、遅れて来た2回目の完了が
   * 次のスピンの開始後に走ったとき hold が true に戻っているので素通りし、
   * 新しいリールの安全弁を消してアンマウントしてしまう。
   */
  const rouletteSpinId = useRef(0);
  /**
   * 超焦らし(jack 3種)カウント方式の状態(shared/roulette-tease.ts)。
   * 「並びの最後のフル尺スピン」を数え、5回か7回に1回だけ発動する。
   * 遅延初期化(初回使用時に rouletteTeaseInit)— セッション内のみで永続化しない。
   */
  const rouletteTease = useRef<RouletteTeaseState | null>(null);
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
  /**
   * 他演出中に届いたブーストの持ち越し(pendingBands と同型)。上限は
   * PENDING_BOOSTS_MAX — 連打コンボが worker 側で直列発動になった(1メッセージで
   * 最大 TAP_BOOST_ACTIVATIONS_MAX 本)ぶん、2件では溢れて無言破棄が起きうる。
   */
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

  // ── 演出ストック表示(右下オーバーレイ) ─────────────────────────────────
  // 持ち越しキューは全部 ref なので変異しても再レンダーされない。変異のチョーク
  // ポイント(pumpStage の finally / idle クリア / fxQueue effect / start・shot の
  // 明示 refresh)から refreshFxStock() が state へ写す。等値ガードは fxStockKey。
  const [fxStock, setFxStock] = useState<FxStockView>(EMPTY_FX_STOCK);
  const fxStockKeyRef = useRef('');
  /**
   * ワーカー凍結キューの予告(challenge.fxQueue)のミラー。refreshFxStock は
   * タイマー等の古いクロージャからも呼ばれるので、render スコープの challenge を
   * 直接読まず ref 経由にする(他のキュー ref と同じ規約)。
   */
  const fxQueueRef = useRef<ChallengeFxQueueItem[]>([]);
  /**
   * 再生中の演出(ストックの先頭行)。連続ルーレットのスピン/連続ギフトの
   * ショットを消費するたび remaining を減らし、同じ key の行の ×N が減っていく。
   * 書くのは start・finish・abort・expire 系、読むのは refreshFxStock。
   */
  const playingFx = useRef<FxStockPlaying | null>(null);

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

  /**
   * ホールド番犬の期限(絶対時刻 ms、0 = 未使用)。各 start* が hold を立てた直後に
   * 自分の安全弁と同じ権威尺から書き、hold が偽の間は読まれない(解除側で 0 に
   * 戻す義務は無い — hold を立てる側が必ず上書きする)。判定は番犬 interval。
   */
  const fxHoldDeadlines = useRef({ roulette: 0, band: 0, stock: 0, boost: 0 });

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
   * runDrain → startStrikeFromPending → startStrike まで走ってから再レンダーされる
   * ため、次のチェーンが張られていればこの effect は no-op になる(順序は安全)。
   */
  useEffect(() => {
    maybeFlushDeferredFloats();
    // 全カットインが終わった瞬間に舞台も進める。fxHoldBusy は state 由来なので
    // 解除で必ず再レンダーが走る = 予約タイマーが遮蔽で失われていても復帰する。
    pumpStage();
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

  /** 凍結許可(fxCaps)の申告。worker 側は既定 false なので、届くまでカットインは全拒否。 */
  function sendCaps(): void {
    void rpc('challenge.fxCaps', { bandFx: !prefersReducedMotion() }).catch(() => undefined);
  }

  // ワーカー再起動・起動レースで凍結許可(fxCaps)は既定 false に戻る/失われる。
  // 従来は 120 秒ポーリングが唯一の再送で、その間ワーカーは全カットインを
  // 「モニター未表示/動きの抑制」として拒否していた(dev 起動直後の実配信で
  // 2 分弱の拒否連発を diag ログで実測)。ready への遷移で即時に再申告する。
  useEffect(() => {
    if (workerState === 'ready') sendCaps();
  }, [workerState]);

  // worker 再起動で effect の id が振り直されたら watermark を白紙へ戻す。
  // かつては freshChallengeEffects が「id が watermark を下回ったら再起動」と
  // 推測していたが、その判定は**古いスナップショットの後着**でも成立し、直近5秒の
  // 演出が丸ごと再生され直していた(ルーレット/ギフトが個数を超えて出る主因)。
  // null は「全件再生済みに倒す」なので、いつ走っても重複再生は起こさない
  // (初回マウントでは既に null で完全な no-op)。
  useEffect(() => {
    lastPlayed.current = null;
  }, [workerEpoch]);

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
    // OS 設定の切替は matchMedia の change で即時追従。worker 再起動・起動レースは
    // 下の workerState effect が ready への遷移で即時再送し、120 秒ポーリングは
    // 最後の保険に格下げ(従来はポーリングだけで、最大2分カットインが全拒否だった)。
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

  // ── ホールド番犬(時間ベースの最後の脱出口) ─────────────────────────────
  // 各ホールドの解除は自前の安全弁タイマーが本線。それでもタイマー消失・
  // コールバック内の例外でホールドが孤児化すると anyCutinHold() が立ちっぱなしに
  // なり、pumpStage が毎回 return して数字も演出も永久に止まる(実配信で
  // 「ブースト明けに突然固まる」として観測された壊れ方)。ここは期限超過を検知して
  // 既存の expire/finish 経路で強制解除する保険 — 期限は各 start* が権威尺
  // + FX_HOLD_GRACE_MS で書くので、正当な演出中には発火しない。出口は必ず既存の
  // 締め関数を使うこと(新規のクリーンアップをここに書くと後始末が二重管理になる)。
  useEffect(() => {
    const t = setInterval(() => {
      const now = Date.now();
      const d = fxHoldDeadlines.current;
      if (boostHold.current && d.boost !== 0 && now > d.boost) {
        fxWarn('ホールド番犬: boost が期限超過 — 強制解除', { overdueMs: now - d.boost });
        expireBoostFx();
      }
      if (bandHold.current && d.band !== 0 && now > d.band) {
        fxWarn('ホールド番犬: band が期限超過 — 強制解除', { overdueMs: now - d.band });
        finishBandFx();
      }
      if (stockCutinHold.current && d.stock !== 0 && now > d.stock) {
        fxWarn('ホールド番犬: stockCutin が期限超過 — 強制解除', { overdueMs: now - d.stock });
        abortStrike();
      }
      if (rouletteHold.current && d.roulette !== 0 && now > d.roulette) {
        fxWarn('ホールド番犬: roulette が期限超過 — 強制解除', { overdueMs: now - d.roulette });
        expireRoulette();
      }
    }, FX_HOLD_WATCHDOG_MS);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
    // 同一デルタに相乗りした未再生 effect は「再生中」扱い(この直後に必ず
    // start* が走る)— 据え置き(heldValue)の持ち主は常に1人の規約なので、
    // ここで着弾チェーンを張ってしまうと持ち主が二重になる。
    const yieldToCutin =
      anyCutinHold() ||
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
      // 実際の再生は解除の瞬間に startStrikeFromPending がフルチェーン1本で行う。
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

    /*
     * ±N 浮上バナーが出ている(または消え際の間合い中)なら、いいねゲージ/ストックの
     * 着弾チェーンは始めない — 「バナーが消えてから演出」の対象。ここに来た時点で
     * カットインもチェーンも居ない(上の2つで return 済み)ので、塞いでいるのは
     * バナーだけ。
     *
     * **数字は「まだ見せていないぶん」を引いた値で据え置く。** 素通しすると、いったん
     * worker 値まで進んでから、演出の開始時にその増減ぶんだけ**巻き戻って**見える
     * (実機ハーネスで実測: 1050 → 1030 → 1050)。ルーレットではさらに悪く、リールが
     * 回る前に数字が答えを出す(出目の先漏れ)。
     * 据え置きは delta のたびに張り直すので、待っている間の押下(値の変化)は
     * そのまま反映され、パンチも出る。持ち主は「舞台待ちの持ち越し」— 解除は
     * 各 start* の張り直しか flushStrike(null 代入)で、舞台が空けば次の delta が
     * 必ず flushStrike を通るので、従来どおり必ず worker 値へ収束する。
     */
    if (stageBusy()) {
      if ((likeDelta > 0 || stockDelta > 0) && challenge.status === 'running') {
        queueStrike(likeDelta, stockDelta);
      }
      if (applyStageHold()) {
        if (prevV !== challenge.value) {
          setPunchDir(challenge.value < prevV ? 'down' : 'up');
          setPunchKey((k) => k + 1);
        }
        return;
      }
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
      clearBannerTimer();
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
      // 舞台の順番待ちとドレイン予約も同じ理由で捨てる。**bannerEndAt は戻さない** —
      // 表示中のバナーは自分のアニメで消えるので、ラッチも自然に切れるのが正しい。
      clearBannerTimer();
      bannerQueue.current = [];
      pendingDrain.current = null;
      // 飢餓弁の発火記録もランごとにまっさらへ(0 = 未発火 = 武装済み)。
      lastStarveServeAt.current = 0;
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
      // ドレイン側飢餓弁の時刻ラッチもまっさらへ(全キュー空 = 待機なし)。
      drainWaitingSinceMs.current = null;
      // abort* が空にしたキューぶんの演出ストック表示も消す。
      refreshFxStock();
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
    // 舞台の直列化中はバナー/リールの実際の再生点で鳴らす(到着時だと先走る)。
    stageSynced: true,
    mountPlaysTest: true,
    // 視覚側と同じ worker 世代でリセットする(音だけ取り残さない)。
    epoch: workerEpoch,
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
    // 【最後の砦】遮蔽ウィンドウでは setTimeout が 1Hz 以下に絞られ、舞台を進める
    // 予約タイマーが実質失われる。worker の delta が届く限りここで回復するので、
    // 固着は「永久」ではなく「最大 500ms の遅れ」に落ちる。
    pumpStage();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.recentEffects, cfgTried]);

  // ── ワーカー凍結キューの予告(fxQueue) ─────────────────────────────────
  // カットイン/ブースト再生中に届いたイベントは凍結明けまで recentEffects に
  // 載らない(worker の pendingOps)。その間も演出ストック表示に出すため、
  // delta の fxQueue をミラーして組み直す(上の effect は recentEffects 依存で、
  // fxQueue だけの変化では走らない)。
  useEffect(() => {
    fxQueueRef.current = challenge?.fxQueue ?? [];
    refreshFxStock();
    // refreshFxStock は ref しか読まない同期チョークポイント(deps は fxQueue だけで
    // 正しい)。noteDrainQueues の相乗りで解析器が安定と見なせなくなったための抑止。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.fxQueue]);

  // ── 舞台(stage)の排他 ────────────────────────────────────────────────
  // 判定は shared/fx-stage.ts の純関数、状態は bannerEndAt / bannerQueue /
  // pendingDrain の3本だけ。ここから下の述語は**すべて ref を同期に読む** —
  // fxHoldBusy(state 由来)とは役割が違う(あちらは再レンダーの引き金)。

  /** 不透明フルフレームが被さっている(この下に描いても見えない)。 */
  function opaqueCutinActive(): boolean {
    return bandHold.current || stockCutinHold.current || boostHold.current;
  }
  /** カットイン(= 据え置きの持ち主)が居る。 */
  function anyCutinHold(): boolean {
    return rouletteHold.current || bandHold.current || stockCutinHold.current || boostHold.current;
  }
  /** 着弾チェーンが飛行中。 */
  function chainActive(): boolean {
    return strikeTimers.current.length > 0;
  }
  /**
   * 演出(ルーレット / 帯域・全面カット / 着弾チェーン / ストック / ブースト)を
   * 今すぐ始めてよいか。**±N 浮上バナーが出ている間と、消えた直後の間合い中は false** —
   * これが「バナーが消えてから演出」の本体。
   *
   * 着弾チェーンは含めない — カットインがチェーンを横取りする既存規約
   * (start* 冒頭の flushStrike(true))を壊さないため。
   */
  function stageBusy(): boolean {
    // 読み取り側もクランプを通す — 時計の後方ステップでラッチが未来に固着すると
    // ここが true を返し続け、演出が全死する。current への書き込みは pumpStage の
    // 1箇所だけに保つ(こちらは読み取り専用のクランプ)。
    const now = Date.now();
    return anyCutinHold() || stageWaitMs(clampBannerEndAt(bannerEndAt.current, now), now, 'cutin') > 0;
  }
  /**
   * 舞台待ちの演出が「まだ見せていない」増減量の合計。worker は値を即時適用するので、
   * これを差し引かずに表示すると **結果が先漏れする** — ルーレットなら出目が回る前に
   * 数字が答えを出し、開始時に巻き戻って見える(実機ハーネスで実測)。
   * 符号はそのまま合算して `value - withheld` を据え置く(減算ギフトは held > value)。
   */
  function pendingStageAmount(): number {
    const p = pendingStrike.current;
    let n = p ? p.like + p.stock : 0;
    // ルーレット2キューは resumeAt 起点の残量で数える(スライス位置の権威は
    // shared の rouletteRemainingAmount)— 全リール直和のままだと §6b の譲り合いで
    // キューへ戻した連鎖の再開時に、消化済みリールぶん数字が巻き戻る。
    for (const w of rouletteQueue.current) n += rouletteRemainingAmount(w.e, w.resumeAt);
    for (const w of joinRouletteQueue.current) n += rouletteRemainingAmount(w.e, w.resumeAt);
    for (const e of pendingBands.current) n += e.amount;
    return n;
  }

  /**
   * 据え置き会計の唯一の式。own = これから自分が見せる(= もう自分のキューからは
   * 抜いた)増減量。「worker の現在値 − 自分 − 舞台待ちの持ち越し全部」を据え置く —
   * 4つの開始点(startRoulette / startBandFx / startBoostFx / startStrikeFromPending)
   * がこれを共有することで、誰が先に始まっても数字の先漏れ・巻き戻りが出ない。
   * 各開始点は「キューから抜いてから計算」の順序を守ること(抜く前に呼ぶと
   * pendingStageAmount に自分が二重計上される)。
   */
  function heldValueFor(ownNotYetShown: number): number {
    return Math.max(0, (prevValue.current ?? 0) - ownNotYetShown - pendingStageAmount());
  }

  /**
   * 舞台待ちの持ち越しぶんを差し引いて数字を据え置く。**2箇所から呼ぶ必要がある** —
   * 持ち越しを積むのは playEffect だが、値を反映する値変化 effect はそれより先に
   * 走るので、値変化 effect だけでは同じ delta の中で結果が1フレーム漏れる。
   * もう一方は pumpStage(= playEffect の直後に必ず通る)。
   * 同一フラッシュ内の setState は React が畳むので、見た目の往復は起きない。
   */
  function applyStageHold(): boolean {
    if (anyCutinHold() || chainActive()) return false; // 据え置きの持ち主が別に居る
    if (stageWaitMs(bannerEndAt.current, Date.now(), 'cutin') === 0) return false;
    const withheld = pendingStageAmount();
    const v = prevValue.current;
    if (withheld === 0 || v === null) return false;
    setHeldValue(Math.max(0, v - withheld));
    return true;
  }

  /** 持ち主が居なくなった据え置きを解く(worker 値へ収束させる唯一の後始末)。 */
  function releaseOrphanHold(): void {
    if (anyCutinHold() || chainActive()) return;
    setHeldValue((h) => (h === null ? h : null));
  }

  /** ドレインすべき持ち越しがあるか(pumpStage が drain を選ぶ条件)。 */
  function stageQueuesPending(): boolean {
    return (
      pendingAchieved.current !== null ||
      pendingBoosts.current.length > 0 ||
      pendingBands.current.length > 0 ||
      joinRouletteQueue.current.length > 0 ||
      rouletteQueue.current.length > 0 ||
      pendingStrike.current !== null
    );
  }

  /**
   * ドレイン系キューの覗き見スナップショット(消費しない)。ランク比較
   * (bestDrainRank)・次種別の先読み(peekNextDrainKind)・runDrain の入力の
   * 3用途で同じ形を使う — キューを1本足したらここへも足すこと。
   */
  function drainQueuesView(): FxDrainQueues<ChallengeEffect, QueuedRoulette> {
    return {
      achieved: pendingAchieved.current,
      strike: pendingStrike.current,
      boosts: pendingBoosts.current,
      bands: pendingBands.current,
      joinRoulettes: joinRouletteQueue.current,
      roulettes: rouletteQueue.current,
    };
  }

  /**
   * ドレイン側飢餓弁の時刻ラッチ(drainWaitingSinceMs)の更新。キュー変異の
   * チョークポイント = refreshFxStock に相乗りする(enqueue も dequeue も最終的に
   * 必ず refreshFxStock を通る)。「空 → 非空」の瞬間だけ now を書き、全空で null —
   * 待機中はラッチを進めない(最古の待ち時間の起点を保つ)。
   */
  function noteDrainQueues(): void {
    const waiting =
      pendingStrike.current !== null ||
      pendingBoosts.current.length > 0 ||
      pendingBands.current.length > 0 ||
      joinRouletteQueue.current.length > 0 ||
      rouletteQueue.current.length > 0;
    if (!waiting) drainWaitingSinceMs.current = null;
    else if (drainWaitingSinceMs.current === null) drainWaitingSinceMs.current = Date.now();
  }

  /**
   * 持ち越しキュー(ref)を演出ストック表示の state へ写す。呼び出しは変異の
   * チョークポイント3箇所 — pumpStage の finally(enqueue は playEffect ループ後の
   * pumpStage、dequeue は runDrain がここ経由でしか走らない)、status-idle の
   * 一括クリア後、fxQueue(ワーカー凍結キューの予告)の effect。
   * 満杯系の保留(pendingStrike)は表示対象外(ユーザー指定)なのでここでは読まない。
   * キーが同じなら setState しない(冪等・StrictMode 安全)。
   */
  function refreshFxStock(): void {
    // ドレイン側飢餓弁の時刻ラッチはここに相乗りする(全チョークポイントが通る)。
    noteDrainQueues();
    // ルーレット2キューの spins は resumeAt 起点の残数 — §6b でキューへ戻した
    // 連鎖の「×N」が、消化済みリールぶんを二重に数えない。
    const spinsOf = (w: QueuedRoulette): number => rouletteReelPlan(w.e).reels.length - w.resumeAt;
    const v = buildFxStock({
      playing: playingFx.current,
      achievedPending: pendingAchieved.current !== null,
      boosts: pendingBoosts.current.map((e) => ({ id: e.id, nickname: e.nickname })),
      bands: pendingBands.current.map((e) => ({
        id: e.id,
        nickname: e.nickname,
        rep: giftFxShots(e).rep,
      })),
      joinRoulettes: joinRouletteQueue.current.map((w) => ({
        id: w.e.id,
        nickname: w.e.nickname,
        spins: spinsOf(w),
      })),
      roulettes: rouletteQueue.current.map((w) => ({
        id: w.e.id,
        nickname: w.e.nickname,
        spins: spinsOf(w),
      })),
      workerQueue: fxQueueRef.current,
    });
    const key = fxStockKey(v);
    if (key === fxStockKeyRef.current) return;
    fxStockKeyRef.current = key;
    setFxStock(v);
  }
  function clearBannerTimer(): void {
    if (bannerTimer.current !== null) window.clearTimeout(bannerTimer.current);
    bannerTimer.current = null;
  }
  function armBannerTimer(ms: number): void {
    clearBannerTimer();
    bannerTimer.current = window.setTimeout(() => {
      bannerTimer.current = null;
      pumpStage();
    }, Math.max(0, ms));
  }
  /**
   * 演出と同時に鳴らす効果音(到着時に鳴らすと順番待ちのぶんズレるスロット)。
   * cfg は ref 経由で読む — バナータイマー越しに呼ばれるので、state 直読みだと
   * タイマーを張った時点の音量・有効設定で鳴ってしまう。
   */
  function playSeSlot(slot: ChallengeSeSlot): void {
    const c = cfgRef.current;
    if (!c?.challenge.seEnabled) return;
    playSe(
      c.challenge.seSounds[slot],
      effectiveSeVolume(c.challenge.seVolume, c.challenge.seVolumes[slot])
    );
  }

  /** バナーを実際に舞台へ出す。ラッチを伸ばし、随伴演出と効果音を撃ち、次の番を予約する。 */
  function showBannerNow(b: QueuedBanner): void {
    // key は updater の**外**で採番する — StrictMode は updater を二重実行するので、
    // 中で ++fxKey すると下のタイマーが存在しない key を掴む。
    const key = ++fxKey;
    // **常に1枚へ置き換える**。積むと `.floats` の column flex がそのまま縦2〜3段に
    // なる(ユーザーの言う「2列」)。順番待ちは bannerQueue が持つので取りこぼさない。
    setFloats([{ key, node: b.node, cls: b.cls }]);
    bannerEndAt.current = bannerEndAtFor(bannerEndAt.current, Date.now(), b.cls);
    if (b.se !== null) playSeSlot(b.se);
    b.onShow?.();
    // 安全弁: 遮蔽ウィンドウで animationend が届かないとバナーが固着する。
    // playMini と同じ自己削除方式 — 配列は FLOAT_ABORT_MS 窓で自然に有界。
    const tid = window.setTimeout(() => {
      const a = floatTimers.current;
      const at = a.indexOf(tid);
      if (at !== -1) a.splice(at, 1);
      setFloats((s2) => s2.filter((x) => x.key !== key));
    }, FLOAT_ABORT_MS);
    floatTimers.current.push(tid);
    // 消えた瞬間に次を出すための予約。ラッチが権威なので、このタイマーが遮蔽で
    // 失われても次の pumpStage(delta 到着・ウォッチドッグ)で自然に回復する。
    armBannerTimer(stageWaitMs(bannerEndAt.current, Date.now(), 'banner'));
  }

  /**
   * ±N 浮上バナーの唯一の入口。舞台が空いていればその場で出し、塞がっていれば
   * 順番待ちへ積む(1件も捨てない・尺は常に一定 = ユーザー決定)。
   * 呼び出し側13箇所は原則そのまま — 下の2つだけ immediate を渡す。
   *
   * @param opts.immediate 順番待ちを飛ばして即座に出す。**演出そのもののビートに
   *   同期していなければならないバナー専用**:
   *   (a) ルーレットの確定バナー。コンボ中は rouletteHold が張られたままなので、
   *       積むとチェーンが全部終わるまで1枚も出ず、額とリールの対応が読めなくなる。
   *   (b) 着弾チェーンの通知(flushPendingFloat)。飛行中に積むとパンチ・粒子・SE から
   *       切り離され、「アニメーション → 通知」の規約(fx-floats.ts)が逆向きに壊れる。
   * @param opts.se 表示と同時に鳴らす効果音スロット。
   * @param kind 優先クラスの引き当てキー(fx-priority の登録簿2)。順番待ちの
   *   取り出し順(takeNextBanner)と溢れの破棄順(enqueueBanner の rankOf)、
   *   ドレインとのランク比較(pickStageNext)の全部がこれで決まる。
   */
  function pushFloat(
    node: React.ReactNode,
    cls: string,
    kind: FxBannerKind,
    opts?: { immediate?: boolean; se?: ChallengeSeSlot; onShow?: () => void }
  ): void {
    const now = Date.now();
    const item: QueuedBanner = {
      node,
      cls,
      kind,
      se: opts?.se ?? null,
      onShow: opts?.onShow,
      atMs: now,
    };
    const free =
      bannerQueue.current.length === 0 &&
      !anyCutinHold() &&
      !chainActive() &&
      stageWaitMs(bannerEndAt.current, now, 'banner') === 0;
    if (opts?.immediate === true || free) {
      showBannerNow(item);
      return;
    }
    // 溢れは「最低ランクの最古」から捨てる — フォロー(①)やお助け(⑤)を
    // like-float(⑧)より先に失わない。
    const { dropped } = enqueueBanner(bannerQueue.current, item, BANNER_QUEUE_MAX, (b) =>
      bannerRank(b.kind)
    );
    if (dropped > 0) {
      fxWarn(`バナーの順番待ちが上限(${BANNER_QUEUE_MAX}件)— 最古を${dropped}件破棄`);
    } else if (bannerQueue.current.length >= 8) {
      fxWarn(`バナーの順番待ちが渋滞(${bannerQueue.current.length}件)`);
    }
    pumpStage();
  }

  /**
   * 舞台を1歩進める唯一の合流点。「次に何を出すか」を決めるのはここだけ。
   * 呼ばれるのは: バナー投入 / バナー消滅(タイマー・animationend)/ finish* の
   * ドレイン予約 / 全カットイン終了のウォッチドッグ / delta 到着(2Hz の最後の砦)。
   */
  function pumpStage(): void {
    // runDrain → start* → … から同期で戻ってくる経路があるので再入を止める。
    if (pumping.current) return;
    pumping.current = true;
    try {
      clearBannerTimer();
      // 時計の後方ステップ(NTP/スリープ復帰)でラッチが未来に固着すると舞台が
      // 全死する — 不変条件の上限まで引き戻す。pumpStage は舞台を進める唯一の
      // 合流点で 2Hz の delta 到着からも呼ばれるので、ここ1箇所の書き込みで
      // 最大 2.2s+間合いで自然回復する(fx-stage.ts の clampBannerEndAt 参照)。
      bannerEndAt.current = clampBannerEndAt(bannerEndAt.current, Date.now());
      lastStarveServeAt.current = clampStarveServedAt(lastStarveServeAt.current, Date.now());
      // カットイン中は何もしない — その finish* が必ず scheduleDrain で戻ってくる。
      // ただし冒頭で clearBannerTimer 済みなので、待ち案件があるのに手ぶらで
      // 戻るとタイマーが1本も残らない — finish* が失われた場合(例外・遮蔽)の
      // 自己復帰用に再確認だけ張り直す(armBannerTimer は前の1本を必ず消すので
      // 「常に1本だけ」は崩れない)。
      if (anyCutinHold()) {
        if (bannerQueue.current.length > 0 || pendingDrain.current !== null || stageQueuesPending()) {
          armBannerTimer(STAGE_RECHECK_MS);
        }
        return;
      }
      // 直前に playEffect が積んだ持ち越しぶんを数字から差し引く(結果の先漏れ防止)。
      applyStageHold();
      const now = Date.now();
      const q = bannerQueue.current;
      const hasDrain = pendingDrain.current !== null || stageQueuesPending();
      // ランク比較の入力(fx-priority の序列)。バナーとドレインの最高ランク同士を
      // 比べ、フォロー(①)やお助け(⑤)のバナーは下位ドレイン(⑥⑦⑧)より先に出る。
      const pickInput = {
        hasDrain,
        queuedCount: q.length,
        // takeNextBanner は途中の要素を抜くが相対順序は保つので、先頭が常に最古。
        oldestQueuedAtMs: q.length > 0 ? q[0]!.atMs : null,
        nowMs: now,
        lastStarveServeMs: lastStarveServeAt.current,
        drainBestRank: bestDrainRank(drainQueuesView()),
        bannerBestRank: bestQueuedRank(q, (b) => bannerRank(b.kind)),
        oldestDrainWaitingSinceMs: drainWaitingSinceMs.current,
      };
      const pick = pickStageNext(pickInput);
      if (pick === 'idle') {
        // 待っている演出がもう無い = 舞台待ちの据え置きも役目を終えた。
        releaseOrphanHold();
        return;
      }
      // 間合い(前のバナーが消えるまで + 息継ぎ)。時刻ラッチなので必ず切れる。
      const wait = stageWaitMs(bannerEndAt.current, now, pick === 'drain' ? 'cutin' : 'banner');
      if (wait > 0) return armBannerTimer(wait);
      if (pick === 'drain') {
        const d = pendingDrain.current;
        // **runDrain より前に必ず落とす** — 再入で同じドレインを二度走らせない。
        pendingDrain.current = null;
        if (runDrain(d?.hooks)) {
          // カットインが始まったならその finish* が scheduleDrain で戻ってくる。
          // 着弾チェーンだけが立った場合は誰も戻さないので、順番待ちがあるときは
          // 自分で再確認を予約する(2Hz の最後の砦より早く復帰させる)。
          if (q.length > 0 && !anyCutinHold()) armBannerTimer(STAGE_RECHECK_MS);
          return;
        }
        // 何も始まらなかった(全部断られた等)。据え置きの持ち主が居なくなるので解く。
        releaseOrphanHold();
        // そのままバナーへ落ちる。
      }
      // 飛行中の着弾チェーンは自分の通知(flushPendingFloat)を出し切るまで待つ。
      // チェーンの終端は必ずしも pumpStage を呼ばないので、ここだけ再確認を張る。
      if (chainActive()) return armBannerTimer(STAGE_RECHECK_MS);
      // 取り出しは「最高ランク・同ランク内は最古」— 到着順(shift)ではない。
      const b = takeNextBanner(q, (x) => bannerRank(x.kind));
      if (b) {
        // 飢餓弁でドレインを追い越した供給のときだけ発火時刻を記録して弁を閉じる。
        // ランク勝ち(bannerWinsByRank)の供給は正規の追い越しなので刻まない —
        // 刻むと連続フォローの2枚目が飢餓弁の窓に食われて8秒待つ。
        // ドレイン空('banner' でも hasDrain=false)や全断フォールスルー
        // (pick='drain' のままここへ落ちた)は追い越しではないので閉じない。
        // pick 時ではなくここで書くのは、wait>0 でタイマー再アームだけの周回に
        // 窓を消費させないため(消費すると先頭が最長 2 窓ぶん待つ)。
        if (pick === 'banner' && hasDrain && !bannerWinsByRank(pickInput)) lastStarveServeAt.current = now;
        showBannerNow(b);
      }
    } finally {
      pumping.current = false;
      // 舞台を進める唯一の合流点 — enqueue(playEffect ループ直後の pumpStage)と
      // dequeue(runDrain はこの try 内でしか走らない)の両方をここ1箇所で拾う。
      // 再入時は冒頭の pumping ガードが try の前に return するので、外側の1回だけ写す。
      refreshFxStock();
    }
  }

  /**
   * finish*(リール / カットイン / ブースト / ストック)からのドレイン予約。
   * 直前に出した ±N バナーが消えるまで待ってから runDrain する — これが
   * 「±N 浮上バナーが消えたら演出を発生させる」の本体。
   * 予約が重なったら後勝ち(演出は同時に1つなので実際には重ならない)。
   */
  function scheduleDrain(hooks?: DrainHooks): void {
    pendingDrain.current = { hooks };
    pumpStage();
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
        // 取り壊し起因の中断は失敗ではない — 下の cleanup の pause()/load() は
        // pending の play() を AbortError で落とすので、key 差し替え(band の反復
        // 2発目・boost のフェーズ遷移・clip の restart 連打)のたびに旧要素から
        // 遅延 reject が届く。これを finisher へ流すと現行の演出を巻き添えで畳む
        // (band は hold ガードを素通り、boost は無ガードで暗幕化)。本物の拒否
        // (メディアプレイヤ枯渇など)は要素がまだ DOM にいる間に届く。
        if (!v.isConnected) return;
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
   * — 必ず先頭桁の要素を測ること。桁の要素は桁数の変化で作り直されるので、
   * ref をキャッシュせずここで毎回引き直す(パンチの再マウント廃止後も同じ)。
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
    // タイマー越しに呼ばれるので ref 経由で読む(playSeSlot と同じ理由 —
    // 窓の回転直後に古い向きの座標で出さない)。
    const stageW = landscapeRef.current ? STAGE_LW : STAGE_W;
    const stageH = landscapeRef.current ? STAGE_LH : STAGE_H;
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
    render: (amount: number) => React.ReactNode,
    kind: FxBannerKind
  ): void {
    const p = ref.current;
    if (p === null) return;
    ref.current = null;
    // 着弾の瞬間に出すのが仕様(「アニメーション → 通知」)。順番待ちへ積むと
    // パンチ・粒子・SE から切り離されて規約が逆向きに壊れる。
    pushFloat(render(p.amount), 'bad like-float', kind, { immediate: true });
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
    flushPendingFloat(pendingLikeFloats, likeFloatNode, 'like-float');
    flushPendingFloat(pendingStockFloats, stockFloatNode, 'stock-float');
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
   * 持ち越した満タン/満杯(pendingStrike の合算)をフルチェーン1本として開始する。
   * 戻り値 true = チェーンを張った / false = 張らない(reduced-motion・据え置け
   * ない held >= v の縮退表示はここで済ませてから断る — runFxDrain は false で
   * 次のキューへ落ちる)。
   *
   * 呼び出しは2経路だけ: runDrain の start('strike')と、チェーン終端の直結継続
   * (continueStrikeChain)。**どちらも p はキューから抜き済みで渡すこと** —
   * 抜く前に呼ぶと heldValueFor の pendingStageAmount に自分が二重計上される。
   * 直後に startRoulette / startBandFx が走る場所で呼ばないのは従来どおり —
   * その冒頭の flushStrike が出したばかりのチェーンを畳んでしまう。
   */
  function startStrikeFromPending(p: { like: number; stock: number }): boolean {
    if (p.like <= 0 && p.stock <= 0) {
      maybeFlushDeferredFloats();
      return false;
    }
    if (prefersReducedMotion()) {
      fxWarn('reduced-motion: 持ち越し着弾をスキップ(数字は反映済み)');
      // チェーンを張らないので着弾は来ない — 保留バナーはここで出し切る。
      flushDeferredFloats();
      return false;
    }
    // 据え置きは最新 worker 値から「自分 + 舞台待ちの持ち越し」を戻した値
    // (据え置き会計は heldValueFor に一本化)。prevValue は delta のたびに
    // 前進しているので、ここで読む値は常に「適用済みの現在値」。
    const v = prevValue.current ?? 0;
    const held = heldValueFor(p.like + p.stock);
    if (held >= v) {
      impactStrikeVisuals(); // v=0 等で据え置けない — 音と光だけ出す
      // impactStrikeVisuals が流すのは like のみ。ストック満杯の保留がここで
      // 取り残されるので、両方まとめて出し切る。
      flushDeferredFloats();
      return false;
    }
    startStrike(held, held, p.like, p.stock); // held===prevV 相当なので余計なパンチは出ない
    return true;
  }

  /**
   * 着弾チェーン終端(impactStrike / impactStock / abortStrike)の続き。持ち越しが
   * あれば従来どおり**間合いなしの直結**で次のチェーンを張り、継続する strike が
   * 無ければ scheduleDrain で舞台へ戻す — strike より下位の持ち越し(ブースト/
   * カットイン/ルーレット)がチェーン終端で取り残されないため。runDrain の直呼びは
   * 禁止(舞台の間合いは pumpStage が一手に握る — fx-stage.spec の不変条件)。
   */
  function continueStrikeChain(): void {
    const p = pendingStrike.current;
    if (p !== null) {
      pendingStrike.current = null; // 「先に取る」規律(drainFxQueues の shift と同型)
      if (startStrikeFromPending(p)) return; // 直結継続 — 舞台はチェーンが持ったまま
    } else {
      // 持ち越しが無い = 誰もチェーンを張らないパス。取り残された保留バナーを拾う。
      maybeFlushDeferredFloats();
    }
    scheduleDrain();
  }

  /**
   * 保留中の据え置きを即座に畳む。数字は常に worker の値へ収束する。
   *
   * @param handoff true = 直後に別演出が始まる(startRoulette / startBandFx /
   *   startBoostFx の冒頭)。このとき保留バナーは**出さずに持ち越す** — ここで
   *   出すと、演出明けに startStrikeFromPending が本番の着弾を再生してもキューが
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
    // startStrikeFromPending が再生する。pendingStrike 自体はここでは消費しない。
    // 消費するのは runDrain / continueStrikeChain の「先に取る」と、停止・リセット
    // (下の status effect)だけ。
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
   * にし、直後の continueStrikeChain が張るチェーンで出る)。
   * 横取り(startRoulette / startBandFx / startBoostFx)は flushStrike(true) を直接呼ぶ。
   */
  function abortStrike(): void {
    activeStrike.current = null;
    flushStrike();
    continueStrikeChain();
  }

  /**
   * 演出終了時の持ち越しドレイン。どのキューをどの順で見るかは
   * shared/fx-drain.ts の drainFxQueues が権威(FX_PRIORITY_ORDER 由来・テストで固定)。
   * achieved(CLEAR)は「再生」— 開始スロットを消費せず次演出と並走する。
   * strike(保留着弾)は序列②③の一級市民としてここで消化する — 消費は
   * drainFxQueues の take に一本化(呼び出し前に queues.strike へ移し、take され
   * なかった場合は必ず戻す)。hooks はルーレット BGM の後始末(finishRoulette 系)。
   */
  function runDrain(hooks?: DrainHooks): boolean {
    const queues = drainQueuesView();
    pendingAchieved.current = null;
    // 保留着弾は queues.strike へ移した(take と分離すると宙に浮く)。runFxDrain 中の
    // 横取り(start* の flushStrike(true))が pendingStrike を積み直すことがあるので、
    // ここでの null 代入と後段の戻しは queueStrike のマージで整合させる。
    pendingStrike.current = null;
    const r = runFxDrain(queues, {
      playAchieved: (e) => playEffect(e),
      start: (next) => {
        if (next.kind === 'strike') {
          // 縮退表示込みの判定は startStrikeFromPending が持つ。onNext(ルーレット
          // BGM の即断)は張れたときだけ後から撃つ — 断る相手のために撃つと、
          // 次のキューがルーレットだったとき BGM が頭から鳴り直す。
          if (!startStrikeFromPending(next.strike)) return false;
          hooks?.onNext?.('strike');
          return true;
        }
        if (next.kind === 'roulette' || next.kind === 'join-roulette') {
          const w = next.effect;
          // 断るのは「盤面が無くて回す出目が1本も無い」ときだけ(playEffect の
          // rouletteWillSpin で弾いているので通常は来ない)。断る相手のために
          // onNext(ルーレット BGM の即断)を撃たないよう、判定を先に済ませる。
          if (rouletteReelPlan(w.e).reels.length === 0) {
            fxWarn('ドレイン: ルーレットを開始できない — 次の持ち越しへ');
            return false;
          }
          hooks?.onNext?.(next.kind);
          // キュー消化でも短縮しない — 消化スピンもフル尺で回す(ユーザー仕様)。
          // 短縮が残るのはコンボ2本目以降と §6b の連鎖再開のみ(startRoulette 側の
          // at > 0)。resumeAt は §6b の譲り合いがキューへ戻した再開位置(通常品は 0)。
          // 「並びの最後の1本」の超焦らしカウントは startRoulette 側が
          // rouletteQueue.current.length(shift 済みなので残りの並び)で判定する。
          return startRoulette(w.e, false, w.resumeAt);
        }
        if (next.kind === 'band') {
          const e = next.effect;
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
        // ルーレット連鎖(最長 ~39秒 — heavy 12.9 + 19×1.35)では worker は凍結しないので、キューから
        // 出す時点で終わっているフィーバーがありうる。そのまま再生すると
        // 0 のままのタップカウンタを不透明動画で最大 26 秒見せることになる。
        const e = next.effect;
        const plan = planBoostStart(boostStartTiming(e), Date.now());
        if (plan.action === 'skip') {
          fxWarn('ドレイン: フィーバーの期限切れ — 再生しない', {
            reason: plan.reason,
            atMs: e.atMs,
            endsAtMs: e.boostEndsAtMs,
            nowMs: Date.now(),
            waitedMs: Date.now() - e.atMs,
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
    // take されなかった保留着弾は必ず戻す(= next が strike になる前に返った場合。
    // 宙に浮かせない)。横取りが積み直した分と衝突しないようマージで戻す。
    if (queues.strike !== null) {
      queueStrike(queues.strike.like, queues.strike.stock);
      queues.strike = null;
    }
    if (r.started) return true;
    hooks?.onIdle?.();
    // 誰も始まらなかった(idle)。strike は上で一級市民として消化済みなので、
    // 従来 drainStrike 経路が担っていた保留バナー回収だけをここで行う。
    maybeFlushDeferredFloats();
    // 着弾チェーンが立ったなら舞台は埋まった(バナーはその着弾通知を待つ)。
    return chainActive();
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

  /**
   * ルーレットを開始し、リールが止まるまで数字を出目適用前の値で据え置く。
   *
   * at = この effect の何本目か。連打ギフト(バラ等)は1 effect が N 本の出目を
   * 持つので、finishRoulette が at+1 で自分を呼び直して同じ effect の中を進む。
   * 2本目以降は必ず短縮スピン — 同一人物の連打なので間合いも入れない
   * (別ギフトへ移るときだけ ROULETTE_CHAIN_GAP_MS を挟む)。
   * 例外は入室ルーレット(e.rouletteJoin): 常にフル尺 — マージで同一 effect に
   * 畳まれた2本目以降(at > 0)も短縮しない。超焦らしカウントの対象外でもある。
   */
  function startRoulette(e: ChallengeEffect, fast: boolean, at = 0): boolean {
    const plan = rouletteReelPlan(e);
    let draw = plan.reels[at];
    if (!draw) {
      // 盤面欠損などで回すものが無い。**false を返して呼び出し側に断る** —
      // hold を張らないまま true を返すと runFxDrain が「始まった」と誤認し、
      // 誰も演出していないのに保留着弾(pendingStrike)が宙に浮く。
      fxWarn('ルーレットのリール開始不可 — 回す出目が無い', { at, reels: plan.reels.length });
      return false;
    }
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
    // 回転開始のジングルは**ギフト1件につき1回**(連打で N 本のリールでも1回)。
    // useChallengeSe は stageSynced のとき鳴らさないので、ここが唯一の再生点。
    if (at === 0) playSeSlot('roulette');
    // 据え置き値は「適用済みの現在値」から**まだ見せていない出目**(このリール
    // 以降 + 回さない rest)と舞台待ちの持ち越し全部を戻した「このリールの適用前」。
    // 連打では1本止まるごとに数字が段階的に動く。スライス位置の権威は shared の
    // rouletteRemainingAmount、会計の式は heldValueFor(4開始点で共有)— 解除後は
    // 必ず worker の権威ある値に収束する。原点が e.valueAfter でなく prevValue
    // なのは、バナー待ちや持ち越しで遅れて始まると valueAfter が古いため。
    setHeldValue(heldValueFor(rouletteRemainingAmount(e, at)));
    // 短縮するのはコンボ2本目以降(at > 0)のみ。入室ルーレット(rouletteJoin)は
    // マージで畳まれた2本目以降でも短縮しない — 初見さんの1本は常にフル尺。
    const short = !e.rouletteJoin && (fast || at > 0);
    // 超焦らし(jack 3種)のカウント方式。フル尺スピンだけが対象で、「並びの
    // 最後の1本」= キューに後続が居ない effect のフル尺スピン(at=0)。連打
    // effect の最終リールは短縮でゴーストを出せないので、フル尺である1本目を
    // 並びの締めとして数える。drainFxQueues は shift 済みなので
    // rouletteQueue.current.length がそのまま残りの並び(runDrain のコメント参照)。
    // 入室ルーレットと試写(test)は素通し — 抽選パターンをそのまま再生する
    // (試写を通すとパターン別 ▶ の jack が doublefake に化ける)。
    const tease = cfg?.challenge.rouletteTease;
    if (!short && !e.rouletteJoin && e.test !== true && tease?.enabled) {
      const lastOne = at === 0 && rouletteQueue.current.length === 0;
      const r = rouletteTeaseStep(
        (rouletteTease.current ??= rouletteTeaseInit(Math.random)),
        draw.pattern,
        { lastOne, allowed: tease.patterns },
        Math.random
      );
      rouletteTease.current = r.state;
      if (r.pattern !== draw.pattern) draw = { ...draw, pattern: r.pattern };
    }
    // spin は開始時に確定して state にも焼き込む。onDone で ref を読み直すと
    // 「呼ばれた時点の世代」と常に一致してしまい、世代チェックが素通りする。
    const spin = ++rouletteSpinId.current;
    setRoulette({ key: ++fxKey, effect: e, fast: short, spin, at, draw });
    // ストック先頭行の ×N。コンボ2本目以降は finishRoulette からの直行で
    // pumpStage を通らないため、ここで明示的に写す(スピンごとに残数が減る)。
    playingFx.current = {
      kind: e.rouletteOrigin === 'join' ? 'join-roulette' : 'roulette',
      id: e.id,
      nickname: e.nickname,
      remaining: plan.reels.length - at,
    };
    refreshFxStock();
    // 安全弁: バックグラウンドで onAnimationEnd が来なくても必ず解除して収束させる。
    // 尺は fast とパターンの段位で変わるので rouletteAbortMs に一本化する(片方だけ
    // 見て調整するともう片方が必ず壊れる)。連鎖の間合いぶんも足す — 間合い中は
    // hold を張ったままなので、間合いのタイマーが失われると据え置きが固着する。
    // キーは RouletteFx と同じ規約: 短縮スピンは 'fast'、通常は再生パターン
    // (超焦らしカウントの差し替え後の draw.pattern — jack⇔doublefake は同じ
    // heavy 段位なので尺は変わらないが、権威は常に差し替え後とする)。
    clearRouletteTimers();
    const abortAfterMs = rouletteAbortMs(short ? 'fast' : draw.pattern) + ROULETTE_CHAIN_GAP_MS;
    // 番犬の期限は安全弁と同じ権威尺から導く(連鎖では1本ごとに張り直される)。
    fxHoldDeadlines.current.roulette = Date.now() + abortAfterMs + FX_HOLD_GRACE_MS;
    rouletteTimers.current.push(window.setTimeout(() => finishRoulette(e, spin, at), abortAfterMs));
    return true;
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

  /**
   * キック級の衝撃(キックの一撃・巻き戻し・再点火・暗転)。衝撃音と画面の揺れを
   * 足す。doublefake は1スピンで2回来る — playSe も pushShake も冪等なので素通し。
   */
  function kickRoulette() {
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['roulette-kick'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['roulette-kick'])
      );
    }
    pushShake('shake');
  }

  /**
   * 段・ホップ・微停止への到達の「コツン」。'roulette-near' の音を弱く(×0.55)
   * 使い回す — 専用素材を足すと se-catalog(実ファイル突合)と設定UIのスロットが
   * 1個ずつ増えるが、段の音は near と同族なので流用で十分。揺れは足さない。
   */
  function stepRoulette() {
    if (cfg?.challenge.seEnabled) {
      playSe(
        cfg.challenge.seSounds['roulette-near'],
        effectiveSeVolume(cfg.challenge.seVolume, cfg.challenge.seVolumes['roulette-near']) * 0.55
      );
    }
  }

  /**
   * §6b(連鎖の譲り合い)の判定に渡す「待機中の優先クラス」一覧。excludeSelf =
   * 回転中の連鎖自身のキュー(同格に譲らないのは shouldYieldSpinChain の厳密比較が
   * 保証するが、自分の並びを待機と数えない意図をここで明示する)。
   * achieved(CLEAR)は序列外の並走再生なので含めない — 含めると譲った先で
   * 開始スロットを消費せず、譲りが空振りする。
   */
  function collectWaitingClasses(excludeSelf: FxPriorityClass): FxPriorityClass[] {
    const waiting: FxPriorityClass[] = [];
    for (const b of bannerQueue.current) waiting.push(BANNER_PRIORITY[b.kind]);
    const p = pendingStrike.current;
    if (p !== null) waiting.push(strikeClass(p));
    if (pendingBoosts.current.length > 0) waiting.push('boost');
    if (pendingBands.current.length > 0) waiting.push('band');
    if (excludeSelf !== 'join-roulette' && joinRouletteQueue.current.length > 0) {
      waiting.push('join-roulette');
    }
    if (excludeSelf !== 'other' && rouletteQueue.current.length > 0) waiting.push('other');
    return waiting;
  }

  /**
   * リール境界・連鎖終端の BGM 即断。実際のドレインは scheduleDrain の間合い後
   * だが、音のタイミングは従来と 1:1 に保つためここで先読みする —
   * 次が 'roulette'/'join-roulette'(連鎖の続き)なら鳴りっぱなし、
   * 'boost'/'band'(カットイン系)なら即断(bandBgm と重ねない)、
   * strike・バナー勝ち(ランク比較で先にバナーが出る)・idle なら 400ms フェード
   * (バンドBGMの終端と同じ尺)。
   */
  function decideRouletteBgm(): void {
    const q = drainQueuesView();
    const nextKind = peekNextDrainKind(q);
    const bannerBest = bestQueuedRank(bannerQueue.current, (b) => bannerRank(b.kind));
    const drainBest = bestDrainRank(q);
    const bannerWins = bannerBest !== null && drainBest !== null && bannerBest < drainBest;
    if (bannerWins || nextKind === null || nextKind === 'strike') {
      stopRouletteSound(400);
    } else if (nextKind === 'boost' || nextKind === 'band') {
      stopRouletteSound(0);
    }
    // 'roulette' / 'join-roulette'(かつバナー非勝ち)は鳴りっぱなし。
  }

  /** finishRoulette 系のドレイン予約フック(ルーレット BGM の後始末)。 */
  function rouletteDrainHooks(): DrainHooks {
    return {
      onNext: (kind) => {
        if (kind !== 'roulette' && kind !== 'join-roulette') stopRouletteSound(0);
      },
      onIdle: () => stopRouletteSound(400),
    };
  }

  /** リール停止(または安全弁)— ここで初めて数字が動いて見える。 */
  function finishRoulette(e: ChallengeEffect, spin: number, at = 0) {
    // 二重発火の遮断。素通りさせると (a) 確定音とバナーが2回、(b) キューが1本
    // 余計に消え、(c) 次のスピン開始後に走ると新しいリールを消してしまう。
    // finishBandFx と同じ自衛を、世代の一致判定つきで行う。
    if (!rouletteHold.current || spin !== rouletteSpinId.current) return;
    clearRouletteTimers();
    const plan = rouletteReelPlan(e);
    // このリール1本ぶんの増減(effect 全体の合計ではない — 連打では別物)。
    const amount = plan.reels[at]?.amount ?? e.amount;
    // 同じ effect にまだリールが残っていれば、据え置きは次のスピンへ引き継ぐ。
    const more = at + 1 < plan.reels.length;
    if (!more) {
      rouletteHold.current = false;
      setHeldValue(null);
    }
    setRoulette(null);
    // ストック先頭行を落とす。コンボ継続なら直後の startRoulette(at+1) が残数-1で
    // 張り直す(表示の反映も向こうの refreshFxStock)。終了ならドレイン経由の
    // pumpStage が空きを写す。
    playingFx.current = null;
    setPunchDir(amount < 0 ? 'down' : 'up');
    setPunchKey((k) => k + 1);
    const big = Math.abs(amount) >= 1000;
    pushShake(big ? 'shake-strong' : 'shake');

    const fx = fxRef.current;
    const r = fx?.pointFor(countdownRef.current);
    if (fx && r) {
      const hue = amount < 0 ? 140 : 0;
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
    // 確定バナーはリールが止まった瞬間の額そのものなので**順番待ちを飛ばす** —
    // コンボ中は rouletteHold が張られたままで、積むとチェーン終了まで1枚も出ず、
    // どのリールの額なのか読めなくなる。1枚に置き換わるので「2列」にはならない。
    // §6b の譲り判定より必ず前 — 譲るときも「止まったリールの額」は先に見せる
    // (fx-hold-safety.spec の不変条件)。
    pushFloat(rouletteBanner(e, amount), `${amount < 0 ? 'good' : 'bad'} banner-roulette`, 'roulette-result', {
      immediate: true,
    });

    if (more) {
      // §6b: リール境界の譲り合い。待機中に**厳密に上位**の演出/バナーが居るとき
      // だけ、残りリールを自キューへ戻して先を譲る(唯一の「連鎖への割り込み」点。
      // 回転中の1本は完走済みなので、譲りごとに連鎖は最低1リール進む = livelock
      // は構造的に起きない — shouldYieldSpinChain 参照)。
      const selfClass: FxPriorityClass = e.rouletteOrigin === 'join' ? 'join-roulette' : 'other';
      if (shouldYieldSpinChain(selfClass, collectWaitingClasses(selfClass))) {
        // 【不変条件】resumeAt > 0 の要素は各キュー高々1件・常に先頭 — 作るのは
        // この unshift だけ(消費は runDrain の startRoulette(w.e, false, w.resumeAt)
        // で、必ず先頭から取り出す)。上限は MAX+1 を許容 — unshift は上限検査を
        // 通さない(完走済みの連鎖の残りを捨てるほうが実害が大きい)。
        const selfQueue = e.rouletteOrigin === 'join' ? joinRouletteQueue : rouletteQueue;
        selfQueue.current.unshift({ e, resumeAt: at + 1, queuedAtMs: Date.now() });
        // 据え置きはここでは解かない — 解くと譲った瞬間に残りリールの出目が数字へ
        // 先漏れする。直後の pumpStage の applyStageHold が同一フラッシュで
        // 「舞台待ちの持ち越し」として張り替える(pendingStageAmount は resumeAt
        // 起点の残量で数えるので、消化済みリールぶんの巻き戻りも起きない)。
        rouletteHold.current = false;
        fxWarn('ルーレット連鎖を譲る', {
          at,
          remaining: plan.reels.length - (at + 1),
          to: peekNextDrainKind(drainQueuesView()),
        });
        decideRouletteBgm();
        scheduleDrain(rouletteDrainHooks());
        return;
      }
      // 同一ギフトのコンボ内。**間合いを入れない** — 同じ人の連打なので誰の分かを
      // 読み直す必要がなく、17連打が間合いぶん更に伸びるだけになる。hold は
      // 張ったまま次のリールへ渡す(値の据え置きの持ち主を切らさない)。
      if (startRoulette(e, true, at + 1)) return;
      // 断られた(到達しないはず — more は次のリールの存在から計算している)。
      // hold を張ったまま抜けると据え置きが固着するので、必ず解いてドレインへ落とす。
      rouletteHold.current = false;
      setHeldValue(null);
    }
    // 尺の都合で回さなかったぶんは合算バナーで締める(値は適用済み)。真の終端
    // だけ — §6b で譲った連鎖は上の return で抜けており、rest は再開後の終端で出す。
    if (plan.restCount > 0) {
      pushFloat(
        rouletteRestBanner(e, plan.restAmount, plan.restCount),
        `${plan.restAmount < 0 ? 'good' : 'bad'} banner-roulette`,
        'roulette-rest'
      );
    }

    // 持ち越しのドレイン(順序は shared/fx-drain.ts = FX_PRIORITY_ORDER が権威)。
    // 実行は確定バナーが消えてから — 間合いは scheduleDrain / bannerEndAt が一手に
    // 引き受けるので、かつてここにあった自前の ROULETTE_CHAIN_GAP_MS の待ちは
    // 持たない(待ちはバナー尺 1.6s + 間合い 0.5s = 2.1s で、旧 600ms より必ず長い)。
    // **BGM の即断だけは間合いの前に済ませる**(decideRouletteBgm)。
    decideRouletteBgm();
    scheduleDrain(rouletteDrainHooks());
  }

  /** reset/stop 用の全破棄。演出もキューも据え置きも捨てて worker 値へ戻す。 */
  function abortRoulette() {
    clearRouletteTimers();
    // hold が立っていなくても音は残りうる(開始直後の abort 等)ので guard の前で止める。
    stopRouletteSound(0);
    rouletteQueue.current = [];
    joinRouletteQueue.current = [];
    drainWaitingSinceMs.current = null; // reset/stop 文脈 — 残キューは呼び出し側が続けて捨てる
    pendingAchieved.current = null;
    playingFx.current = null; // ストック先頭行(表示は idle エフェクトの refresh が写す)
    if (!rouletteHold.current) return;
    rouletteHold.current = false;
    setRoulette(null);
    setHeldValue(null);
  }

  /**
   * 番犬専用の締め(スピンの安全弁タイマーごと失われた異常系)。abortRoulette と
   * 違い rouletteQueue / pendingAchieved は捨てず、finish 系と同じドレインで
   * 持ち越し(CLEAR・キュー済みスピン/カットイン/ブースト)を必ず流す。
   */
  function expireRoulette() {
    if (!rouletteHold.current) return;
    clearRouletteTimers();
    stopRouletteSound(0);
    rouletteHold.current = false;
    setRoulette(null);
    setHeldValue(null);
    playingFx.current = null; // 表示はドレイン経由の pumpStage が写す
    scheduleDrain();
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
    // 別ギフトの未発火の反復ショットを持ち込まない。不透明カットインの最中は
    // playGiftVisual の opaqueCutinActive ガードで黙るだけなので、残しておくと
    // **カットインが明けた後**に前のギフトの閃光・粒子が因果不明に撃たれる
    // (clearRepeatTimers は従来 idle とアンマウントでしか呼ばれていなかった)。
    clearRepeatTimers();
    bandHold.current = true;
    // 番犬の期限は下の二重安全弁(totalMs+2000)と同じ権威尺から導く。
    fxHoldDeadlines.current.band = Date.now() + totalMs + 2000 + FX_HOLD_GRACE_MS;
    bandEffect.current = e;
    // 据え置き値は startRoulette と同じ「適用済みの現在値から自分の適用前へ戻す」
    // (会計の式は heldValueFor に一本化 — 舞台待ちの持ち越しぶんも差し引く)。
    // この effect は呼び出し前にキューから抜き済み(pendingStageAmount に二重計上
    // されない)。原点が e.valueAfter でないのは、pendingBands / バナー待ちで
    // 遅れて始まると valueAfter が古く、カットイン開始で数字が過去へ飛ぶため。
    setHeldValue(heldValueFor(e.amount));
    setBandClip({ key: ++fxKey, url, durationMs, out: false, fullCut: e.fxFullCut === true });
    // ストック先頭行の ×N(連続ギフトの残ショット数)。ショット毎のタイマーが減らす。
    playingFx.current = { kind: 'band', id: e.id, nickname: e.nickname, remaining: bandRep };
    refreshFxStock();
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
          // 残ショット数を減らす(×N が同じ行の上で減っていく)。
          playingFx.current = { kind: 'band', id: e.id, nickname: e.nickname, remaining: bandRep - i };
          refreshFxStock();
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
    playingFx.current = null; // 表示はドレイン経由の pumpStage が写す
    if (e && e.amount !== 0) {
      setPunchDir(e.amount < 0 ? 'down' : 'up');
      setPunchKey((k) => k + 1);
    }
    // カットイン中に我慢していた通知(ギフトカード/フラッシュ/シェイク/粒子)を
    // ここで出す — 「カットイン → セグ通知」の順序。次のカットイン開始より前に出すこと。
    // シェイクはヘルパー内の tier 判定に任せる(旧来の amount 判定は重複するので廃止)。
    if (e) giftImpactVisuals(e, 0);
    // カットイン中に届いた持ち越しのドレイン(順序は shared/fx-drain.ts =
    // FX_PRIORITY_ORDER が権威)。bandHold はすでに false なので次のカットインへ
    // 再入して問題ない。
    scheduleDrain();
  }

  /** reset/stop 用の全破棄。据え置きもタイマーもBGMも捨てて worker 値へ戻す。 */
  function abortBandFx() {
    clearBandTimers();
    bandBgm.current?.stop(0);
    bandBgm.current = null;
    pendingBands.current = [];
    if (playingFx.current?.kind === 'band') playingFx.current = null; // idle の refresh が写す
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
    // 途中参加(resume)は前置きの残りを段ごとに組み直す。3・2・1 は映像に
    // 焼き込まれていて「1」がタップ開始と同期する契約(shared/challenge.ts の
    // TAP_BOOST_COUNT_CLIPS)なので、**ウィンドウが開く時刻**を守りつつ、
    // カウント段には実尺を超える尺を渡さない(超えると素材が終わってから
    // 静止フレームで待つことになり、同じ契約が別の形で壊れる)。段の分配は
    // shared/boost-start.ts の planBoostStart が権威。
    const introMs = plan.action === 'full' ? (e.boostIntroMs ?? 0) : plan.introMs;
    const countMs = plan.action === 'full' ? (e.boostCountMs ?? 0) : plan.countMs;
    const preMs = introMs + countMs;
    const totalMs = plan.action === 'full' ? (e.fxDurationMs ?? 0) : plan.remainingMs;
    // いいね着弾の保留があれば先に畳む(ラッチの持ち主を1人にする)。handoff=true —
    // 直後にこの演出が始まるので、保留バナーは出さずに持ち越す(演出明けの着弾で出る)。
    flushStrike(true);
    clearBoostTimers();
    boostHold.current = true;
    // 番犬の期限は下の安全弁(totalMs + BOOST_EXPIRE_MARGIN_MS)と同じ権威尺から導く。
    // boost-end 受信後は finishBoostFx が清算発表の尺で張り直す。
    fxHoldDeadlines.current.boost = Date.now() + totalMs + BOOST_EXPIRE_MARGIN_MS + FX_HOLD_GRACE_MS;
    boostEffect.current = e;
    boostTest.current = e.test === true;
    boostTestTapRef.current = 0;
    // テスト再生は据え置かない(testEffect は値を変えない契約 — 実タップで値が
    // 動いたときに表示が固まって見えるのを避ける)。会計の式は heldValueFor に
    // 一本化(この effect は呼び出し前にキューから抜き済み)。
    if (!e.test) setHeldValue(heldValueFor(e.amount));
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
      push(totalMs + BOOST_EXPIRE_MARGIN_MS, expireBoostFx);
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
   * 冒頭の clearBoostTimers は startBoostFx が張った expire 安全弁も消すため、
   * plan 確定直後に必ず張り直す(bandTimers の二重弁と同じ思想)— これが無いと
   * ビート1つの消失で boostHold が孤児化し、舞台(pumpStage)ごと全死する。
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
    // 安全弁の再アーム。ここから先は素の setTimeout 連鎖だけなので、1拍でも失われる
    // と据え置きが永久固着する。余白は着弾の飛翔(≤ STRIKE_TRAVEL_MAX_MS)込みで覆う。
    // 正常完走後の遅発は expireBoostFx 冒頭の boostHold ガードで no-op
    // (次の start/abort の clearBoostTimers でも消える)。
    boostTimers.current.push(window.setTimeout(expireBoostFx, plan.totalMs + BOOST_EXPIRE_MARGIN_MS));
    fxHoldDeadlines.current.boost = Date.now() + plan.totalMs + BOOST_EXPIRE_MARGIN_MS + FX_HOLD_GRACE_MS;
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
          scheduleDrain();
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
        scheduleDrain();
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
      'good banner-boost',
      'boost-result'
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
      joinRouletteQueue: joinRouletteQueue.current.length,
      rouletteQueue: rouletteQueue.current.length,
      achieved: pendingAchieved.current != null,
    });
    boostHold.current = false;
    boostEffect.current = null;
    boostTest.current = false;
    setBoostClip(null);
    setBoostSettle(null);
    setHeldValue(null);
    scheduleDrain();
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
    // 続きが無ければ scheduleDrain で下位の持ち越しへ番を回す。
    continueStrikeChain();
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
    flushPendingFloat(pendingLikeFloats, likeFloatNode, 'like-float');
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
    continueStrikeChain(); // カットイン無しでチェーン完了 — 持ち越しを続けて出す
  }

  /**
   * 着弾の瞬間からフルスクリーンカットイン(音声焼き込み)を開始する。
   * 据え置き(heldValue)は startStrike が張ったまま維持 — 動画中に数字は動かない。
   * worker 側は凍結しない設計なので、カットイン中に届いた press/gift 等は
   * reveal の一括ジャンプに合流する(数値の正しさは null 収束規約で保証)。
   */
  function startStockCutin(stockDelta: number) {
    stockCutinHold.current = true;
    // 番犬の期限は下の安全弁(STOCK_CUTIN_ABORT_MS)と同じ権威尺から導く。
    fxHoldDeadlines.current.stock = Date.now() + STOCK_CUTIN_ABORT_MS + FX_HOLD_GRACE_MS;
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
    scheduleDrain();
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
   * 出さず、打撃系(フラッシュ・簡易演出・粒子)だけを撃ち直す。
   *
   * 戻り値 = カットインが**この effect の反復を引き受けた**か(開始した/持ち越した)。
   * 呼び出し側(playEffect case 'gift')はこれが true なら repeatTimers を張らない —
   * 反復ドライバを1本に保つための唯一の担保(下の :playEffect のコメント参照)。
   */
  function playGiftVisual(e: ChallengeEffect, shot: number): boolean {
    // カットイン再生中の反復(shot > 0)は撃たない — 反復は startBandFx が映像・BGM・
    // bandBlast の直列再生で面倒を見ており、ここ由来のフラッシュ/簡易演出/粒子は
    // 不透明動画の前面に重なって「カットイン → 通知」の順序を壊すだけ。
    if (shot > 0 && opaqueCutinActive()) return false;
    // ダイヤ帯域カットイン。effect 側の fxBandClip が権威(worker が判定済み・
    // 凍結も開始済み)なので cfg は見ない — 120 秒ポーリング(CFG_POLL_MS)の古い設定に
    // 依存しない。開始できたら簡易演出は出さない(全画面を
    // 不透明動画が覆うため見えない)。リール中・カットイン中は持ち越し、
    // 解決できなければ従来経路へフォールバックする。
    // カットインの反復は startBandFx が尺ぶん直列で面倒を見るので、ここは shot 0 のみ。
    let banded = false;
    // bandWillStart を先に判定する — 始まらないカットイン(未知クリップ id 等)を
    // 持ち越しキューへ積むと、解除時の startBandFx が false を返してそのギフトの
    // 演出が丸ごと消える。始まらないなら最初から通常経路へ落とす。
    if (shot === 0 && e.fxBandClip != null && bandWillStart(e)) {
      if (stageBusy()) {
        // bandHold を見ずに startBandFx を再入すると clearBandTimers が1本目の
        // finishBandFx を消し、据え置きが解けないまま数字が固まる。
        // 持ち越しキューが満杯なら banded は立てない — 立てると簡易演出も
        // 通知も出ず、そのギフトの演出が丸ごと消える。
        // 上限 4: 連打ルーレットの連鎖(最長 ~39秒)の裏で溜まるぶんを飲めるだけ
        // 確保する(2 のままだと長い連鎖のたびにカットインが落ちる)。
        if (pendingBands.current.length < PENDING_BANDS_MAX) {
          pendingBands.current.push(e);
          banded = true;
        }
      } else {
        banded = startBandFx(e);
      }
    }
    // 簡易演出。cfg は 120 秒ポーリング(CFG_POLL_MS)で届く。
    if (cfg && !banded) {
      // お助け(ファンスタンプ)は専用スロット。ダイヤ数で引くと gift-t1 と同じに
      // なってしまい、お助けだけ簡易演出を変えられない(useChallengeSe の音と同じ規約)。
      playMini(
        e.fanStamp
          ? miniForSlot(cfg.challenge, 'helper')
          : matchGiftMini(cfg.challenge, { diamonds: e.diamonds ?? 0 }),
        e.amount,
        shot
      );
    }
    // 通知(フラッシュ/シェイク/カード/粒子)。カットインが始まった(または持ち越された)
    // ときはここでは出さず、finishBandFx がカットイン終了時にまとめて出す —
    // 「カットイン → セグ通知」の順序。
    if (!banded) giftImpactVisuals(e, shot);
    return banded;
  }

  /**
   * ギフト通知の一式(フラッシュ/シェイク/ギフトカード/粒子)。カットイン無しの
   * ギフトは到着時に、カットイン有りは finishBandFx が終了時に呼ぶ。
   * fxRef はここで読み直すこと — 途中で canvas が remount されると、入口で掴んだ
   * 参照は破棄済みエンジンを指す。
   */
  function giftImpactVisuals(e: ChallengeEffect, shot: number): void {
    const tier = tierForDiamonds(e.diamonds ?? 0);
    // 照明と粒子は**バナーと同時**に撃つ(shot 0 は onShow 経由)。バナーが順番待ちに
    // 回ったときにここで撃つと、光・揺れ・紙吹雪だけが先走って再生中の演出に重なる。
    const lighting = (): void => {
      // 「照明」= 画面フラッシュ。flash 指定は「確実に見える t2 相当」を保証
      // するだけで tier を偽らない(旧実装は小額 flash ギフトが t3 に化けた)。
      pushFlash(`gift-t${Math.max(tier, e.flash ? 2 : 1)}`);
      // shake は反復しない — .monitor-root の className に載せて data 属性だけ key で
      // 変える作りなので、同じクラスの連続 shake は CSS アニメが再スタートせず1回しか
      // 揺れない(直すには remove→reflow→add が要る。既知の制限)。
      if (shot === 0 && tier >= 2) pushShake(tier >= 4 ? 'shake-strong' : 'shake');
    };
    /** お助けの粒はコメント応援と同じ緑 — 「応援」の色をギフトの金と混ぜない。 */
    const helperSparks = (): void => {
      const o = fxOrigin();
      fxRef.current?.sparkBurst(o.x, o.y, 14, { hue: 140, speed: 420 });
    };
    const tierSparks = (): void => {
      const fx = fxRef.current;
      if (!fx) return;
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
    };
    // お助け(ファンスタンプ)は専用バナー。ギフトカードも tier の金色粒子も出さない —
    // 1ダイヤ・高頻度で届くので両方出すと上限3枠(FLOAT_MAX)を食い潰し、フォロー/いいねの行が
    // 押し流される。判定は effect の焼き込み(cfg は 120 秒ポーリング(CFG_POLL_MS)で古くなりうる)。
    if (e.fanStamp) {
      if (shot === 0) {
        // 文言の決定は shared/fan-stamp.ts が唯一の実装(レンダラにテスト環境が無いので
        // 決定ロジックは shared の純関数へ出す規約)。ここは JSX を組むだけ。
        // 既定は減算(お助け)だが amountEach は正にもできる設定なので符号で言い換える。
        const p = fanStampBannerParts(e);
        const sign = p.amount > 0 ? `+${num(p.amount)}` : p.amount < 0 ? `${num(p.amount)}` : '±0';
        // 連打は amount へ畳み込み済み(worker 規約)。×N を出さないと
        // 「1個 −3 の設定なのに −30」が読めない。
        // 複数人ぶんの合算バナーでは出さない — 「ほかN人」と ×N が並ぶと桁が2つ出て
        // 読み違える(総個数は −N の数字が語る)。
        const times = !p.multi && p.giftCount > 1 ? ` ×${num(p.giftCount)}` : '';
        // 名前は who 行、「ほかN人がお助け!」は act 行 — 行ごとに "…" が付くので、
        // 長い名前でも動作("がお助け!")が消えない(nameLines の設計意図)。
        const others = p.othersCount > 0 ? `ほか${num(p.othersCount)}人` : '';
        pushFloat(
          <>
            <span className="f-heart">💖</span>
            <span className="f-amt">{sign}</span>
            {nameLines({ who: p.names.join('・'), act: `${others}${p.what}${times}` })}
          </>,
          `banner-helper ${p.multi ? 'multi ' : ''}${e.amount > 0 ? 'bad' : 'good'}`,
          'helper',
          {
            onShow: () => {
              lighting();
              helperSparks();
            },
          }
        );
        return;
      }
      lighting();
      helperSparks();
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
        `gift-card t${tier} ${e.amount > 0 ? 'bad' : 'good'}`,
        'gift-card',
        {
          onShow: () => {
            lighting();
            tierSparks();
          },
        }
      );
      return;
    }
    lighting();
    tierSparks();
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
        // フラッシュ・シェイク・粒子・簡易演出・効果音は**バナーと同時**に出す。
        // 連続フォローではバナーが順番待ちに回るので、ここで撃つと光と揺れだけが
        // 先走って再生中の演出に重なる(要望そのもの)。
        pushFloat(
          <>
            <span className="f-amt">+{num(e.amount)}</span>
            {nameLines({ who: e.nickname ?? '', act: 'がフォロー!' })}
          </>,
          'bad banner-follow',
          'follow',
          {
            se: 'follow',
            onShow: () => {
              pushFlash('follow');
              pushShake('shake');
              const o = fxOrigin();
              // バナーが 2 倍になったぶん、粒の数だけでなく大きさも上げる — 数だけ
              // 増やすと 203px のバナーに対して 10〜30px の粒が砂粒に見えてしまう。
              const g = fxRef.current;
              g?.sparkBurst(o.x, o.y, 40, { hue: 0, speed: 700, size: 1.6 });
              g?.heartBurst(o.x, o.y, 18, { hue: 0, size: 1.6 });
              if (cfg) playMini(miniForSlot(cfg.challenge, 'follow'), e.amount);
            },
          }
        );
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
          pushFloat(likeFloatNode(e.amount), 'bad like-float', 'like-float');
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
            {nameLines({
              who: e.nickname ?? '',
              act: `が${e.commentKeyword ? `「${e.commentKeyword}」` : 'コメント'}!`,
            })}
          </>,
          'bad',
          'comment',
          {
            se: 'comment',
            onShow: () => {
              const o = fxOrigin();
              fxRef.current?.sparkBurst(o.x, o.y, 14, { hue: 0, speed: 420 });
              if (cfg) playMini(miniForSlot(cfg.challenge, 'comment'), e.amount);
            },
          }
        );
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
          pushFloat(stockFloatNode(e.amount), 'bad like-float', 'stock-float');
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
        // banded = カットインが反復を引き受けた(すぐ始めた or pendingBands へ持ち越した)。
        // **そのときは repeatTimers を張らない** — 反復ドライバは startBandFx の
        // bandTimers 1本に保つ。両方張ると、カットインが持ち越されている間
        // (bandHold はまだ false)playGiftVisual の `shot > 0 && opaqueCutinActive()`
        // ガードが素通りし、閃光・簡易演出・紙吹雪が (rep-1) 回**余計に**撃たれた
        // うえで、あとからカットインが rep 回再生されていた
        // (opaqueCutinActive は rouletteHold もバナー待ちも見ないため)。
        const banded = playGiftVisual(e, 0);
        if (!banded && rep > 1 && repeatTimers.current.length < GIFT_FX_REPEAT_TIMERS_MAX) {
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
          pushFloat(rouletteBanner(e), `${e.amount < 0 ? 'good' : 'bad'} banner-roulette`, 'roulette-result');
          return;
        }
        // カットイン据え置き中も積む。ここで走らせると、直後に finishBandFx が
        // setHeldValue(null) を実行して回転中に数字が最終値へ飛ぶ(= 出目が先漏れ)。
        // playGiftVisual の busy 判定と同じ形に揃える。
        if (stageBusy()) {
          // 再生中はキューへ。入室(初見)は専用キュー(優先度⑥・rouletteOrigin
          // 焼き込みで判別 — label はユーザー編集で衝突しうる)、ギフト由来は従来
          // キュー(⑧)。**溢れても捨てない** — 捨てると「値だけ動いてリールが
          // 出ない」最悪の見え方になる(以前の挙動)。同じ盤面の末尾へ出目を連結して
          // 1件ぶんの枠で全部回す(worker の finishDrain と同じ畳み方)。
          const join = e.rouletteOrigin === 'join';
          const q = join ? joinRouletteQueue.current : rouletteQueue.current;
          const max = join ? JOIN_ROULETTE_QUEUE_MAX : ROULETTE_QUEUE_MAX;
          if (q.length < max) {
            q.push({ e, resumeAt: 0, queuedAtMs: Date.now() });
            return;
          }
          const tail = q[q.length - 1];
          if (tail && sameRouletteBoard(tail.e, e)) {
            // cfg を渡すのは worker の finishDrain と同じ規約に揃えるため —
            // 渡さないと「連打でもリールは1本」(rouletteEnabled=false)で worker が
            // 1本に絞った effect が、ここの連結で最大20本に化ける。
            // resumeAt / queuedAtMs は末尾要素のものを維持する — 連結は e の中身
            // だけの操作で、§6b が戻した再開位置(常に先頭 = 長さ1のときだけ末尾と
            // 一致しうる)を動かさない。
            q[q.length - 1] = { ...tail, e: mergeRoulette(tail.e, e, cfg?.challenge) };
            return;
          }
          // 盤面違いで連結できない(出目 index の意味が変わる)。ここだけは諦めるが、
          // 値が動いた事実はバナーで残す。
          fxWarn('ルーレット: キュー満杯で盤面違い — バナーのみ出す', {
            queued: q.length,
            join,
          });
          pushFloat(rouletteBanner(e), `${e.amount < 0 ? 'good' : 'bad'} banner-roulette`, 'roulette-result');
          return;
        }
        startRoulette(e, false);
        return;
      }
      case 'boost-start': {
        // 他演出の再生中は持ち越す(pendingBands と同型・PENDING_BOOSTS_MAX 上限)。テストは
        // 持ち越さずスキップ — ▶ は今すぐ見たいもので、数十秒後に因果不明の
        // 再生が始まるほうが混乱する。
        if (stageBusy()) {
          if (e.test) {
            fxWarn('tapBoost 実演: 他演出の再生中 — スキップ');
            return;
          }
          if (pendingBoosts.current.length < PENDING_BOOSTS_MAX) pendingBoosts.current.push(e);
          else fxWarn('boost-start: 持ち越しキュー満杯 — 破棄', { queued: pendingBoosts.current.length });
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
              {nameLines({ who: e.nickname ?? '', act: 'がフィーバー発動!' })}
            </>,
            'good banner-boost',
            'boost-announce'
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
        // 押し出し効果もある — 積む側の上限は PENDING_BOOSTS_MAX 件なので、死んだ
        // 持ち越しが枠を占めると直後の**生きた**ブーストが入り口で捨てられる。
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
        if (stageBusy()) {
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
  const digits = segDigits(challenge.initialValue);
  // 据え置き中はこちらを出す。桁数(initialValue 由来)と status は据え置かない。
  const shownValue = heldValue ?? challenge.value;
  const showAvatars = cfg?.loadAvatars ?? true;
  // 「何時起き」— 有効かつ時刻が入っているときだけ最下段の行を足す。
  const wakeTime = cfg?.challenge.wakeEnabled ? (cfg.challenge.wakeTime ?? null) : null;
  // punch-* は React の className では持たない — 付け外しは punchKey の
  // useLayoutEffect(classList リプレイ)が担う。ここに足すと二重管理になり、
  // 同方向の連続パンチでアニメーションが再スタートしなくなる。
  const segCls = countdownClass({ status: challenge.status, shownValue, lowThreshold });

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

      {/* 配信時間はタイトルと同じ grid セルの左上に小さく重ねる(タイトルの後 =
          DOM 後勝ちで上に描画。ボタン等の内訳は視聴者に見せない方針は従来通り)。 */}
      <div className="elapsed-row">
        配信時間: {totals.elapsedMs > 0 ? elapsedText(totals.elapsedMs) : '—'}
      </div>

      <div className={segCls} ref={countdownRef}>
        <SevenSeg value={shownValue} digits={digits} />
        {achieved ? <div className="clear-banner">CLEAR!</div> : null}
        {!running && !achieved ? (
          <div className="idle-note">
            {challenge.startedMs ? '一時停止中' : 'ダッシュボードの「開始」で始まります'}
          </div>
        ) : null}
      </div>

      {/* 演出ストックの縦リストはここではなく fx-layer 内の右下オーバーレイ
          (ルーレット・カットインより手前に出すため — 下の .fx-layer 参照)。 */}
      <div className="bars">
        {challenge.likeGauge && running ? (
          <LikeGauge
            gauge={challenge.likeGauge}
            fxRef={fxRef}
            trackRef={gaugeTrackRef}
            stockRowRef={stockRowRef}
            showAvatars={showAvatars}
          />
        ) : null}
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
              index={roulette.draw.index}
              amount={roulette.draw.amount}
              fast={roulette.fast}
              pattern={roulette.draw.pattern}
              // 同じ effect の全リールが同じ走行ジッタで走らないよう at を混ぜる
              // (出目とは無関係の見た目パラメータ — 相関させない規約は変えない)。
              seed={roulette.effect.id * 31 + roulette.at}
              // 超激アツ動画に焼き込まれた効果音。id・音量が cfg 参照なのは回転音と
              // 同じ理由(盤面と違い、古い cfg で鳴っても正しさは壊れない)。
              // cfg 未取得は 0 = 無音へ倒す — 設定が届く前に音だけ先に出さない。
              clipVolume={cfg?.challenge.rouletteSound?.clipVolume ?? 0}
              seEnabled={cfg?.challenge.seEnabled ?? true}
              onNearStop={nearStopRoulette}
              onKick={kickRoulette}
              onStep={stepRoulette}
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
              onDone={() => finishRoulette(roulette.effect, roulette.spin, roulette.at)}
            />
          </div>
        ) : null}
        {/*
          演出ストック(右下の縦リスト)。fx-layer 内(z-index:50)・DOM 順で
          .roulette-screen(ultra の全面動画 .rl-clip 含む)の後 = ルーレット中も
          不透明カットイン(.fx-clip-opaque は fx-layer より下)の再生中も必ず手前に
          見える(ユーザー要件)。mix-blend を使わない要素なので fx-layer 内でよい
          (:1340 付近の制約は blend 要素側の話)。
        */}
        <FxStockRow stock={fxStock} />
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
                // 実際に消えた = 舞台が空いた。ラッチは**短縮方向にだけ**倒す
                // (伸ばす方向に使うと、遮蔽で animationend が届かないときに
                // 舞台が永久に開かない = モニターの全死になる)。
                bannerEndAt.current = Math.min(bannerEndAt.current, Date.now());
                pumpStage();
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
