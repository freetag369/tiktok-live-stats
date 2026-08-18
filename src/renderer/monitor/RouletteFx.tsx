import { useEffect, useLayoutEffect, useRef, useState } from 'react';
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
import {
  type RouletteDirection,
  rouletteBlockSign,
  roulettePanelClass,
} from './roulette-class';
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
 * - **向き(direction)だけは最初から出してよい。** 減らす(応援)の行は緑テーマで、
 *   全マスに `-` が付く。direction は**行ごとの属性**で当選 index に依存せず、
 *   しかも出目は 1 以上へ clamp される(sanitizeRouletteSegments)ので、"sub" の行は
 *   **全マスが必ず負** — どのマスが当たりかは一切漏れない。**ゴーストにも同じ符号を
 *   付けること**(片方だけだと本物と見分けが付いてフェイクが成立しなくなる)。
 */

/**
 * 激熱確定の CSS クラス用の段番号(1 始まり)。倍率そのものをクラス名にすると
 * `rl-x50` のような定義の無いクラスが生えて、`.rl-x` が要求する --rl-mult-ink が
 * 未定義になり数字の色が落ちる(monitor.css の .rl-window.rl-x .rl-block を参照)。
 * 見つからない倍率は最終段扱い — 色が消えるより熱いほうへ倒す。
 */
export function rouletteHotStep(mults: readonly number[], mult: number): number {
  const i = mults.indexOf(mult);
  return i >= 0 ? i + 1 : mults.length;
}

export function RouletteFx({
  segments,
  index,
  amount,
  direction,
  fast,
  pattern,
  seed,
  nickname,
  rouletteLabel,
  giftName,
  giftIconUrl,
  clipVolume,
  seEnabled,
  hotMults,
  onNearStop,
  onKick,
  onStep,
  onSpinQuiet,
  onDon,
  onSettle,
  onDone,
}: {
  /** 盤面(表示順の出目の絶対値)。effect.rouletteSegments。 */
  segments: number[];
  /** 当選 index。effect.rouletteIndex。 */
  index: number;
  /** 符号適用後の実増減量。正=妨害(赤)、負=応援(緑)。確定まで表に出さない。 */
  amount: number;
  /**
   * 出目の方向。effect.rouletteDirection(worker の焼き込み)そのもの。
   * 'sub' で緑テーマ + 全マスのマイナス表示になる。**amount の符号から推論しない** —
   * 「effect 1件で自己完結」の規約に合わせ、盤面の見た目は行の属性から決める。
   */
  direction?: RouletteDirection;
  /** 短縮スピン(ROULETTE_FULL_REELS 超のリール・合算 effect)。段の演出は入らず単調減速になる。 */
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
  /**
   * 激熱確定(hot)の**本物の**倍率の段。ドン i 発目で `hotMults[i]` へ上がり、
   * **finish() でも戻さない** — 膨らんだ数字がそのまま確定する。
   * 出所は shared の rouletteHotMults(設定倍率から起こす純関数)。
   * undefined = 通常の超激アツ = 従来どおり ×2→×3→×4→×5 の見せかけで、
   * 確定の瞬間に 1 へ戻る(この経路は 1 バイトも変えていない)。
   *
   * 値が本物でも**全マスに一律で掛ける**のは変わらないので、当選 index は漏れない
   * (このファイル冒頭「結果を先に見せないための約束」は崩れていない)。
   */
  hotMults?: readonly number[];
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
  /**
   * 超激アツ(ultra)の「ドン」— 出目の表示倍率が上がった瞬間。
   * mult は上がったあとの倍率(通常は 2→3→4→5、激熱確定は hotMults の段)、
   * first は先頭の拍(= 激熱の合図)、last は最後の拍かどうか。
   * 激熱確定では last の拍で設定倍率へ到達し、**そのまま確定する**ので、
   * 呼び出し側はそこを払い出しの山場として鳴らす。
   * 呼び出し側が音と画面揺れを足す(onKick / onStep と同じ分担)。
   */
  onDon?: (mult: number, first: boolean, last: boolean) => void;
  /**
   * 超激アツの締め — 膨らんだ出目が元の数字へ戻る瞬間(= 確定と同時)。
   * finish() から呼ぶので、animationend でも安全弁のアンマウントでも必ず1回。
   */
  onSettle?: () => void;
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
  /**
   * 超激アツ(ultra)の出目の表示倍率。**見せかけ専用** — リールのマスに書く数字にしか
   * 掛からず、worker が確定済みの出目にも 7セグの据え置き(heldValue)にも触らない。
   * 1 = 素の出目。ドンのたびに 2 → 3 → 4 → 5 と上がり、finish() で 1 に戻る =
   * 「膨らんだ数字が元に戻って確定」の瞬間になる。
   *
   * 全マスに一律で掛けるので当選 index は漏れない(このファイル冒頭の
   * 「結果を先に見せないための約束」は崩れない)。桁が増えて箱からはみ出すのは
   * 既存の 5桁以上の出目と同じ挙動 — ステップ幅は --rl-w 固定のままなので
   * 着地の代数(min-width:0 の解説)には影響しない。
   */
  const [mult, setMult] = useState(1);
  /** ドンの打撃(rl-don)の再生キー。classList リプレイで毎回頭から再生する。 */
  const [donKey, setDonKey] = useState(0);
  const windowRef = useRef<HTMLDivElement | null>(null);
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
  // 応援(sub)は回転中から全マスに符号を出す。null = 従来どおり確定まで出さない。
  const blockSign = rouletteBlockSign(direction);
  const head = rouletteHeadline({ rouletteLabel, giftName, rouletteDirection: direction });

  function finish(): void {
    if (done.current) return;
    done.current = true;
    // fast(段なし)はここが最初の quiet。他パターンでは既に鳴り止んでいる(冪等)。
    onSpinQuiet?.();
    // 遮蔽ウィンドウで消灯タイマーが遅れても、確定見せを動画に覆わせない(冪等)。
    setClip(null);
    // 超激アツで膨らませた出目を素へ戻す。**戻すのはここだけ** — タイマーではなく
    // 完了ラッチに置くことで、animationend が先でも安全弁のアンマウントが先でも
    // 「確定した数字が倍のまま」で固まらない。倍率が動いていなければ何も起きない。
    //
    // **激熱確定(hotMults)だけは戻さない。** そこが仕様の本体で、worker も
    // 倍率込みの値を適用済み — ここで 1 へ戻すと画面の数字だけが 7セグと食い違う。
    // 戻りボイス(onSettle)も鳴らさない: あれは「膨らんだぶんが消えた」の音なので、
    // 消えていない場面で鳴らすと逆の意味になる。
    if (mult !== 1 && !hotMults) {
      setMult(1);
      setDonKey((k) => k + 1);
      onSettle?.();
    }
    setHit(true);
    timers.current.push(window.setTimeout(onDone, rouletteRevealMs(key)));
  }

  /**
   * ドンの打撃を classList リプレイで再生する(MonitorView の punch-* と同じ手口)。
   * className に混ぜると、連続するドンで React が同じ文字列を書き戻してアニメーションが
   * 再スタートしない。donKey===0 はマウント直後 = まだ打っていないので何もしない。
   */
  useLayoutEffect(() => {
    if (donKey === 0) return;
    const el = windowRef.current;
    if (!el) return;
    el.classList.remove('rl-don');
    void el.offsetWidth; // リフローで CSS アニメーションのリスタートを確定させる
    el.classList.add('rl-don');
  }, [donKey]);

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
    // 超激アツの「ドン」(ultra の行にだけ donAts がある)。i 番目で倍率が i+2 倍に
    // なる。**動画に覆われていない隙間に置いてある**(ROULETTE_ULTRA_BEATS の
    // leadMs / gapMs)ので、膨らんだ数字は必ず読める。
    const dons = t.donAts ?? [];
    for (const [i, at] of dons.entries()) {
      // 激熱確定は設定倍率から起こした段(hotMults)、通常は従来どおり i+2。
      // 段が足りない異常時は最後の段を保つ(数字を下げない)。
      const to = hotMults ? (hotMults[i] ?? hotMults[hotMults.length - 1] ?? i + 2) : i + 2;
      const last = i === dons.length - 1;
      timers.current.push(
        window.setTimeout(() => {
          setMult(to);
          setDonKey((k) => k + 1);
          onDon?.(to, i === 0, last);
        }, Math.round(spinMs * at))
      );
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
      <div className={roulettePanelClass({ direction, amount, hit, hot: hotMults != null })}>
      <div className="rl-head">
        {giftIconUrl ? <img src={giftIconUrl} alt="" /> : <span>🎰</span>}
        {/* .rl-head は flex(gap 8px)なので、区切りの空白は CSS 側に任せて trim する。 */}
        {head.prefix !== '' ? <span className="rl-gift">{head.prefix.trim()}</span> : null}
        <b>{nickname ?? ''}</b>
        {head.suffix}
      </div>
      <div
        ref={windowRef}
        /*
         * rl-x / rl-x<N> は超激アツの倍率表示。素のスピンでは mult===1 なので
         * 一切付かない = 既存の見た目は不変。色は方向テーマ(増やす=金/減らす=緑)の
         * 中で段階的に熱くする — 全マス一律なので当選は漏れず、確定の瞬間には
         * mult が 1 に戻って素の白へ帰る。
         */
        className={`rl-window rl-p-${key}${
          mult > 1
            ? ` rl-x ${hotMults ? `rl-xs${rouletteHotStep(hotMults, mult)}` : `rl-x${mult}`}`
            : ''
        }`}
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
                {hit && i === ROULETTE_TARGET_BLOCK ? (
                  <span className="rl-sign">{sign}</span>
                ) : blockSign !== null ? (
                  <span className="rl-sign">{blockSign}</span>
                ) : null}
                {/* mult は超激アツの見せかけ倍率。素のスピンでは常に 1 = 挙動不変。 */}
                {num(v * mult)}
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
                {/* 本物と同一見た目が命 — 応援の行ではゴーストにも符号をそろえる。 */}
                {blockSign !== null ? <span className="rl-sign">{blockSign}</span> : null}
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
        {/*
         * 倍率バッジ(超激アツのみ)。「数字が増えた」を数字の色だけに頼らず明示する。
         * **key={mult} で毎回作り直す** — 同じ要素を使い回すと2回目以降の
         * ドンで pop アニメーションが再生されない(punch-* の classList リプレイと
         * 同じ問題。こちらは要素ごと差し替わるので key で足りる)。
         * 窓の右上に置くのは、中央のマス(= 読ませたい数字)を隠さないため。
         * 終盤は左右が rl-veil で覆われる領域だが、バッジはその上に出る(DOM 順)。
         */}
        {mult > 1 ? (
          <div key={mult} className="rl-mult">
            ×{mult}倍
          </div>
        ) : null}
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
