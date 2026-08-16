import { useEffect, useRef, useState } from 'react';
import type { RoulettePattern } from '@shared/dto';
import { rouletteHeadline, rouletteRevealMs, rouletteSpinMs } from '@shared/challenge';
import { isJackPattern } from '@shared/roulette-tease';
import {
  RL_CLIP_REMOVE_MS,
  ROULETTE_BLOCK_GAP,
  ROULETTE_BLOCK_W,
  ROULETTE_PATTERN_TIMING,
  ROULETTE_TARGET_BLOCK,
  rouletteRun,
  rouletteStrip,
} from '@shared/roulette-fx';
import { rouletteClipUrl } from '../lib/fx';
import { num } from '@shared/format';

/**
 * ギフトルーレットの横並びブロックリール。
 *
 * MiniFx と同じ流儀: 形(DOM)はここ、動き(@keyframes)は monitor.css。
 * 盤面と当選 index は effect に載ってきた自己完結の値を使う — モニターの設定は
 * 120秒ポーリング(CFG_POLL_MS)で古くなりうるので cfg からは読まない(dto.ts の規約)。
 * 幾何(並べ方・走行距離)は shared/roulette-fx.ts の純関数から取る(テスト可能)。
 *
 * **窓の中央で止まったブロックが確定**という見せ方 — 抽選は worker で確定済みで、
 * ここは「もう決まった出目」をそれらしく見せるだけの演出装置。
 *
 * ── 結果を先に見せないための約束 ─────────────────────────────────────────
 * - 当選ブロックの目印(.win)と符号(+/-)は **.hit が付くまで DOM に出さない**。
 *   旧実装は当選ブロックにマウント時点から色が付いており、減速して近づいてくる
 *   「一番緊張してほしい瞬間」に答えが見えていた。
 * - 終盤は窓の左右を覆い(.rl-veil)、隣のブロックを読ませない。キック系は、
 *   暗がりから当選ブロックが蹴り出されてくる見せ方になる。
 * - 着地位置(--rl-shift)とノード数は index に依存しない。走行距離と尺は
 *   パターンの段位(信頼度方式)には依存するが index には依存しない — 段位は
 *   .rl-p-* クラスとして最初から DOM に見えている情報なので、これで漏れるのは
 *   パターン自身が示す「確率のヒント」まで(roulette-fx.ts の解説を参照)。
 * - 超焦らし系(jackstop/jackslip/jackback)のゴーストブロック(.rl-jack)は、
 *   当選の1つ手前の固定スロットに「盤面の一番下の出目」を被せる — 値も位置も
 *   当選と無相関なので、これ自体は何も漏らさない(monitor.css の解説を参照)。
 */

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
  clipVolume,
  seEnabled,
  onNearStop,
  onKick,
  onStep,
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
  /**
   * 超激アツ動画の音量(0-100)。素材に焼き込まれた効果音を鳴らす。
   * 出所は cfg の rouletteSound.clipVolume — 音の id・音量だけは「effect 自己完結」
   * の例外として cfg 直読みが許されており、その参照は MonitorView 側にある
   * (古い cfg で鳴っても正しさは壊れないため)。
   */
  clipVolume: number;
  /** 効果音のマスタースイッチ。false なら動画も無音で流す。 */
  seEnabled: boolean;
  nickname?: string;
  /** 見出しの前置き(設定の label)。effect.rouletteLabel。 */
  rouletteLabel?: string;
  /** label 未設定のときの前置きのフォールバック。effect.giftName。 */
  giftName?: string;
  giftIconUrl?: string;
  /**
   * 「止まりそう」の瞬間(当選の1つ手前の帯に入るところ)。全パターン共通で
   * 1スピンにつき1回だけ呼ぶ。呼び出し側がスイッチ音を足す。短縮スピンでは呼ばない
   * (段が無く、鳴らすと確定音とほぼ同時になる)。
   */
  onNearStop?: () => void;
  /**
   * キック級の衝撃の瞬間(キック・巻き戻し・再点火・暗転など)。呼び出し側が
   * 衝撃音と揺れを足す。doublefake は2回呼ばれる — 冪等な実装にすること。
   */
  onKick?: () => void;
  /**
   * 段・ホップ・微停止への到達(ROULETTE_PATTERN_TIMING.stepAts)。呼び出し側が
   * 「コツン」の弱い音を足す。最大4回/スピン。
   */
  onStep?: () => void;
  /**
   * 回転ループ音を止めてよい時刻(終盤の段に入るところ)。保持やフェイク停止で
   * リールが止まって見えるのにカラカラ鳴り続けると錯覚が音で割れるため、
   * リール停止(onDone)より前に来る。冪等に扱うこと — 保険で停止時にも呼ぶ。
   */
  onSpinQuiet?: () => void;
  onDone: () => void;
}): React.JSX.Element {
  const [hit, setHit] = useState(false);
  /**
   * 超激アツ(ultra)の全画面動画ウィンドウ。n = clips の添字、out = フェード中。
   * スケジュールは ROULETTE_PATTERN_TIMING.clips × spinMs の壁時計タイマー —
   * 動画は装飾で、尺の権威はあくまでタイマーとリールの animationend(ブースト前例)。
   * 動画の本数・時刻はパターンのみの関数(.rl-p-* で既に DOM に見えている情報)で、
   * 出目には依存しない — アンチリークの構造は崩れない。
   */
  const [clip, setClip] = useState<{ n: number; out: boolean } | null>(null);
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

  // 短縮スピンは段の演出を入れない。保持やフェイク停止は 900ms に物理的に入らず、
  // 入れると「止まりかけて再加速する」カクつきになるだけ(通常スピンとは別尺の
  // キーフレームを当てる)。
  const key = fast ? 'fast' : pattern;
  // 尺と走行距離はパターンの段位で決まる(信頼度方式 — shared/challenge.ts と
  // roulette-fx.ts が権威)。SE キューは spinMs × 割合なので自動で追従する。
  const spinMs = rouletteSpinMs(key);
  // 超焦らし系はゴーストブロック(一番下の出目の被せ)を出す。fast では key が
  // 'fast' になるので自然に消える(段が無いスピンにフェイクの主役は出せない)。
  // 判定は shared/roulette-tease.ts の isJackPattern が唯一の実装(カウント方式の
  // 降格判定と食い違わせない)。
  const jack = key !== 'fast' && isJackPattern(key);
  const strip = rouletteStrip(segments, index);
  const run = rouletteRun(seed, segments.length, key);
  const shift = -(ROULETTE_TARGET_BLOCK - 1) * ROULETTE_BLOCK_W;
  const sign = amount < 0 ? '-' : '+';
  const bad = amount >= 0;
  const head = rouletteHeadline({ rouletteLabel, giftName });

  function finish(): void {
    if (done.current) return;
    done.current = true;
    // fast(段なし)はここが最初の quiet。他パターンでは既に鳴り止んでいる(冪等)。
    onSpinQuiet?.();
    // 遮蔽ウィンドウで消灯タイマーが遅れても、確定見せを動画に覆わせない(冪等)。
    setClip(null);
    setHit(true);
    timers.current.push(window.setTimeout(onDone, rouletteRevealMs(key)));
  }

  /**
   * 超激アツ動画の autoplay を明示的に観測し、ref cleanup でメディアリソースを
   * 即時解放する。MonitorView の armVideoPlay の意図的な複製 — あちらは別セッションが
   * 並行作業中のモジュール内関数で、共通化のための移動はここではしない。
   * 再生失敗はオーバーレイを畳んで純ホールドの焦らしに縮退(スピンは止めない)。
   * cleanup の queueMicrotask + isConnected は「DOM から外れた要素だけ解放」のため
   * (Chromium のレンダラ毎メディアプレイヤ上限対策 — 放置すると play() が
   * reject し始めて動画だけ出なくなる)。
   */
  function armClipPlay(v: HTMLVideoElement | null): (() => void) | undefined {
    if (!v) return undefined;
    // 音量は毎回入れ直す(設定変更が次のウィンドウから効く)。muted は JSX 側。
    v.volume = Math.max(0, Math.min(1, clipVolume / 100));
    if (!v.dataset.playArmed) {
      v.dataset.playArmed = '1';
      v.play().catch(() => {
        // 取り壊し起因の中断は失敗ではない — cleanup の pause()/load() は pending の
        // play() を AbortError で落とす。ultra はウィンドウごとに key 差し替えで
        // 旧要素を捨てるので、旧要素の遅延 reject で消灯すると表示中の後続
        // ウィンドウを巻き添えで消す(MonitorView の armVideoPlay と同じガード)。
        if (!v.isConnected) return;
        setClip(null);
      });
    }
    return () => {
      queueMicrotask(() => {
        if (v.isConnected) return;
        v.pause();
        v.removeAttribute('src');
        v.load();
      });
    };
  }

  // SE の合図(止まりそう・衝撃・段のコツン・ループ音の消灯)をテーブル駆動で発火。
  // 壁時計とアニメーション時計はフレームが出ない窓ではズレるが、音が数十 ms
  // 前後するだけで破綻はしない(完了検知は animationend が本線)。
  useEffect(() => {
    const t = ROULETTE_PATTERN_TIMING[key];
    // 「止まりそう」。fast は番兵 1 で弾かれる。
    if (onNearStop && t.nearAt < 1) {
      timers.current.push(window.setTimeout(onNearStop, Math.round(spinMs * t.nearAt)));
    }
    // キック級の衝撃(doublefake は2発)。
    if (onKick) {
      for (const at of t.kickAts) {
        timers.current.push(window.setTimeout(onKick, Math.round(spinMs * at)));
      }
    }
    // 段・ホップ・微停止の「コツン」。
    if (onStep) {
      for (const at of t.stepAts) {
        timers.current.push(window.setTimeout(onStep, Math.round(spinMs * at)));
      }
    }
    // 終盤の段に入るところでループ音を閉じる(fast は 1 = finish に任せる)。
    if (onSpinQuiet && t.quietAt < 1) {
      timers.current.push(window.setTimeout(onSpinQuiet, Math.round(spinMs * t.quietAt)));
    }
    // 超激アツの動画ウィンドウ(ultra の行にだけ clips がある。fast は 'fast' 行 =
    // 未定義なので自然に素通り)。at で表示、out で一撃=溶暗開始、
    // +RL_CLIP_REMOVE_MS で撤去(溶暗の完了より後 — 余白ぶん遅らせないと
    // コミット遅延でフェードの尻尾が切られる)。
    // out/撤去は「同じウィンドウがまだ出ているときだけ」畳む — 遮蔽ウィンドウで
    // タイマーがまとめて発火しても後続ウィンドウを誤って消さない。
    for (const [i, w] of (t.clips ?? []).entries()) {
      timers.current.push(window.setTimeout(() => setClip({ n: i, out: false }), Math.round(spinMs * w.at)));
      timers.current.push(
        window.setTimeout(
          () => setClip((prev) => (prev?.n === i ? { n: i, out: true } : prev)),
          Math.round(spinMs * w.out)
        )
      );
      timers.current.push(
        window.setTimeout(
          () => setClip((prev) => (prev?.n === i ? null : prev)),
          Math.round(spinMs * w.out) + RL_CLIP_REMOVE_MS
        )
      );
    }
    // マウント時に1回だけ。key/spinMs はこのマウントの間ずっと不変。タイマーは
    // 共有の timers 配列に積むのでアンマウント時の一括 cleanup が回収する。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 動画URL(未投入なら null → オーバーレイ自体を出さず純ホールドに縮退)。
  const clipSrc = clip != null ? rouletteClipUrl(pattern, clip.n + 1) : null;

  return (
    <>
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
            {/*
             * ゴーストブロック(超焦らし系のみ)。当選の1つ手前 strip[TARGET-1] の
             * 真上に「盤面の一番下の出目」を被せる。値は盤面の最終行で固定・位置も
             * 定数 — どちらも当選と無相関なので DOM に出ても何も漏れない(素直に
             * 実位置で狙うと当選 index が逆算できてしまう。monitor.css の解説参照)。
             * 見た目は .rl-block と同一。消灯は rl-jack-fade(97% までに opacity 0)。
             */}
            {jack ? (
              <div
                className="rl-block rl-jack"
                style={{
                  left: `calc(var(--rl-w) * ${ROULETTE_TARGET_BLOCK - 1} + var(--rl-gap))`,
                }}
              >
                {num(segments[segments.length - 1] ?? 0)}
              </div>
            ) : null}
          </div>
        </div>
        {/* 終盤に左右を覆って隣のブロックを読ませない目隠し。 */}
        <div className="rl-veil" />
        <div className="rl-pointer rl-pointer-top">▼</div>
        <div className="rl-pointer rl-pointer-bottom">▲</div>
        {/* 暗転レイヤ(blackout のみ)。veil・ポインタより後 = 最前面で窓を呑む。 */}
        {key === 'blackout' ? <div className="rl-blackout" /> : null}
      </div>
      </div>
      {/*
       * 超激アツの全画面動画。.roulette-screen(absolute inset:0)の直下・パネルの
       * 後ろに置くので画面全体を覆う。不透明(黒地・cover)— screen 合成は
       * .fx-layer 内では黒矩形になるため禁止(monitor.css の規約)。key=n で
       * ウィンドウごとに作り直し、armClipPlay の cleanup が旧要素を即時解放する。
       * loop しない — 素材はウィンドウ実尺へトリム済みで、終端の一撃ポーズで
       * 静止したまま溶暗が被る。**音声は素材に焼き込み**(全面カットと同じ流儀。
       * 音量は rouletteSound.clipVolume、効果音オフなら muted)。回転ループ音は
       * 最初のウィンドウ(= quietAt)で閉じているので鳴りは被らない。
       */}
      {clip != null && clipSrc != null ? (
        <video
          key={clip.n}
          className={`rl-clip${clip.out ? ' out' : ''}`}
          src={clipSrc}
          autoPlay
          muted={!seEnabled}
          playsInline
          preload="auto"
          ref={armClipPlay}
          onError={() => setClip(null)}
        />
      ) : null}
    </>
  );
}
