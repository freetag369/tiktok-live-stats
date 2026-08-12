import { useEffect, useMemo, useRef, useState } from 'react';
import type { AppSettings, ChallengeEffect, ChallengeRankRow } from '@shared/dto';
import {
  CHALLENGE_RESULT_TOP_N,
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
import { ACHIEVED_CLIP_URL, GAUGE_FULL_CLIP_URL, STRIKE_CLIP_URL, fxClipUrl } from '../lib/fx';
import { playSe } from '../lib/se';
import { MiniFx } from './MiniFx';
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
  const strikeTimers = useRef<number[]>([]);

  useEffect(() => {
    void rpc('cfg.get', undefined).then(setCfg);
    void rpc('challenge.get', undefined).then(setChallenge);
    // 設定(lowThreshold / loadAvatars 等)は delta に乗らないので定期再取得する。
    const t2 = setInterval(() => void rpc('cfg.get', undefined).then(setCfg), 30_000);
    return () => {
      clearInterval(t2);
    };
  }, []);

  useEffect(() => {
    if (!challenge) return;
    document.title = challenge.title || 'チャレンジモニター';

    const fills = challenge.likeGauge?.fills ?? null;
    const step = challenge.likeGauge?.step ?? 0;
    const prevF = prevFills.current;
    const prevV = prevValue.current;
    prevFills.current = fills;
    prevValue.current = challenge.value;

    if (prevV === null) return; // マウント直後はアダプト(過去の変化で光らせない)
    if (prevV === challenge.value) return;

    // ゲージ満タン由来かは fills の単調増加で判定する。recentEffects を見ないのは、
    // watermark の 5 秒ゲートで落ちた古い演出とラッチがズレるのを避けるため。
    const units = fills !== null && prevF !== null ? fills - prevF : 0;
    const likeDelta = units > 0 ? units * step : 0;
    // 2Hz のデルタはボタン押下といいね満タンを1スナップショットに相乗りさせうる。
    // 丸ごと据え置くと押下の手応えが 0.72 秒遅れるので、いいね分だけを持ち越す。
    const held = challenge.value - likeDelta;

    const canStrike =
      likeDelta > 0 &&
      challenge.status === 'running' &&
      held >= prevV && // 逆行するラッチは張らない(step が窓中に変わった場合の保険)
      held < challenge.value &&
      !prefersReducedMotion();

    if (canStrike) {
      startStrike(held, prevV);
      return;
    }

    flushStrike(); // 保留があれば畳んでから通常のパンチへ
    setPunchDir(challenge.value < prevV ? 'down' : 'up');
    setPunchKey((k) => k + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.value, challenge?.title, challenge?.likeGauge?.fills, challenge?.status]);

  // タイマーをアンマウント跨ぎで生き残らせない。
  useEffect(() => () => clearStrikeTimers(), []);

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

  /**
   * 着弾シーケンスを開始する。全ビートをここのタイマーが握る —
   * LikeGauge.onFull や canvas の到達判定に依存させない(ゲージが非表示になったり
   * 縦横切替で粒子が捨てられても、数字は必ず着弾時刻に更新される)。
   */
  function startStrike(held: number, prevV: number) {
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
    const travel = strikeTravelMs();
    push(STRIKE_LAUNCH_MS, () => launchStrike(travel));
    push(STRIKE_LAUNCH_MS + travel, impactStrike);
    push(STRIKE_ABORT_MS, flushStrike);
  }

  /** ゲージ→7セグの距離から飛翔時間を出す。座標が取れなければ既定値。 */
  function strikeTravelMs(): number {
    const fx = fxRef.current;
    const a = fx?.pointFor(gaugeTrackRef.current);
    const b = fx?.pointFor(countdownRef.current);
    if (!a || !b) return STRIKE_TRAVEL_MS;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    return Math.round(Math.min(STRIKE_TRAVEL_MAX_MS, Math.max(STRIKE_TRAVEL_MIN_MS, d / STRIKE_SPEED)));
  }

  /** 満タンの瞬間 — ゲージから7セグへ弾を撃ち出す。 */
  function launchStrike(travelMs: number) {
    const fx = fxRef.current;
    const from = fx?.pointFor(gaugeTrackRef.current);
    const to = fx?.pointFor(countdownRef.current);
    // pointFor が null(canvas 未アタッチ/幅0)でも粒子を諦めるだけ。
    // 数字はタイマーが独立に更新するので演出が欠けても破綻しない。
    if (fx && from && to) {
      fx.strike({ x: from.x, y: from.y }, { x: to.x, y: to.y }, { ms: travelMs, hue: 332 });
    }
    if (cfg?.challenge.fxClipsEnabled) playClip(GAUGE_FULL_CLIP_URL);
  }

  /** 着弾 — ここで初めて数字が増える。 */
  function impactStrike() {
    clearStrikeTimers();
    setHeldValue(null);
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
        // フラッシュは連打で鬱陶しいので出さない(パンチは値の変化側で再生済み)。
        // 代わりに 7 セグ中心からのリング波紋で「押した手応え」だけ足す。
        const r = fx?.pointFor(countdownRef.current);
        if (fx && r) {
          fx.ringWave(r.x, r.y, { hue: 200, radius: Math.min(r.w, r.h) * 0.5 });
          fx.sparkBurst(r.x, r.y, 6, { hue: 200, speed: 380 });
        }
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
      case 'gift': {
        const tier = tierForDiamonds(e.diamonds ?? 0);
        // 映像クリップ。canonical 一致の専用クリップ → 無ければ tier の汎用クリップ。
        // 割り当ては設定画面で変更でき、cfg は 30 秒ポーリングで届く。
        if (cfg) {
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
      case 'achieved':
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
          <LikeGauge gauge={challenge.likeGauge} fxRef={fxRef} trackRef={gaugeTrackRef} />
        ) : null}
      </div>

      <div className="elapsed-row">
        配信時間: {totals.elapsedMs > 0 ? elapsedText(totals.elapsedMs) : '—'}
        <span className="stats-inline">
          {' '}
          ボタン{num(challenge.stats.presses)} / 妨害{num(challenge.stats.follows)}
          {challenge.stats.likeUp > 0 ? ` / いいね+${num(challenge.stats.likeUp)}` : ''}
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
