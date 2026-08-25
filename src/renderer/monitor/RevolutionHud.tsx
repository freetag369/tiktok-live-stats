import { memo, useEffect, useState } from 'react';
import { REVOLUTION_HUD_INTRO_MS } from '@shared/challenge';
import { num } from '@shared/format';

/**
 * 革命の走行 HUD 3点セット(カウントダウン・中央告知・7セグ脇ドック)。
 *
 * MonitorView から切り出した独立コンポーネント(2026-08-22)— 以前は本体に
 * 250ms の interval があり、革命の窓(最長1分超)の間ずっと MonitorView 全体を
 * 4Hz で再レンダーしていた。TapLockHud と同じ理由で tick をここに閉じる。
 *
 * 規約は本体時代のまま(worker が配るのは絶対時刻だけ・残り秒はここで数える):
 * - 開始カウントダウン(revCount 5..1)は親のタイマー駆動 state を props で
 *   受ける。終了5秒前(endCount)は endsAtMs の時刻ラッチ駆動 — 窓が開くまで
 *   windowOn は立たないので、両者が同時に出ることは構造的にない。
 * - 中央上の大きな告知は窓オープンから REVOLUTION_HUD_INTRO_MS だけ。以後は
 *   7セグ脇のドック(ピル+走行タリー)へ引き継ぐ(盤面を1分間ふさがない・
 *   2026-08-20 ユーザー決定)。起点は startsAtMs の絶対時刻 — 窓の途中で
 *   モニターを開き直しても告知は復活しない(残り秒と同じ時刻ラッチ規約)。
 * - 終了5秒前カウントダウン中は告知もドックも畳む(全画面の数字と重ねない)。
 * - key=秒 の再マウントで毎秒パンチ(.tap-lock-count と同じ手口)。
 * - reduced-motion でも出す — 「なぜタップが3倍でいいねで数字が減るのか」の説明。
 *
 * 走行タリー(2026-08-26): タップ側/いいね側の2枚並び。数値の権威は worker の
 * 窓カウンタ(revolution.tapCount / tapDown / likeDown — press は nudge で即時
 * delta、いいね反転は 2Hz 相乗り)。構造・ラベル・色軸は結果カットシーンの二者
 * (.rs-fighter、タップ左・いいね右)と対 — 窓の走行版なので変えるときは両方。
 * いいね側は額のみ(反転の発動回数は出さない — 結果側の meta と同じ判断)。
 * パンチは key=tapCount / key=likeDown の再マウント(.boost-count と同じ手口。
 * 額ではなく tapCount を key にするのはクランプで額が動かない終盤でも回数は
 * 増えるため)。
 */
export const RevolutionHud = memo(function RevolutionHud({
  startsAtMs,
  endsAtMs,
  multiplier,
  tapCount,
  tapDown,
  likeDown,
  revCount,
  mirrorOn,
  mirrorLg,
}: {
  /** challenge.revolution.startsAtMs。窓が無い(導入カウント中)は null。 */
  startsAtMs: number | null;
  /** challenge.revolution.endsAtMs。窓が無いは null。 */
  endsAtMs: number | null;
  multiplier: number;
  /** 窓中の実タップ数(worker が権威・押下ごと即時)。 */
  tapCount: number;
  /** タップ由来の実減少量(クランプ後)。 */
  tapDown: number;
  /** いいね反転由来の実減少量(ゲージ+ストック・倍率適用後)。 */
  likeDown: number;
  /** 導入の開始カウントダウン(5..1)。親(startRevolutionFx)のタイマー駆動。 */
  revCount: number | null;
  /** ルーレットの小窓が出ているか(ドックの位置切替)。 */
  mirrorOn: boolean;
  /** 小窓が large 表示か。 */
  mirrorLg: boolean;
}): React.JSX.Element | null {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (endsAtMs == null) return;
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [endsAtMs]);
  const now = Date.now();
  const leftMs = endsAtMs != null ? Math.max(0, endsAtMs - now) : 0;
  // 窓の中か(導入演出中は startsAtMs が未来 = HUD もまだ出さない)。
  const windowOn = startsAtMs != null && endsAtMs != null && now >= startsAtMs && leftMs > 0;
  const leftSecs = Math.ceil(leftMs / 1000);
  const introOn = windowOn && now - (startsAtMs ?? 0) < REVOLUTION_HUD_INTRO_MS;
  const endCount = windowOn && leftSecs <= 5 ? Math.max(1, leftSecs) : null;
  return (
    <>
      {revCount !== null || endCount !== null ? (
        <div className="revolution-count-overlay">
          <div className="revolution-count" key={`${revCount !== null ? 's' : 'e'}${revCount ?? endCount}`}>
            {num(revCount ?? endCount ?? 0)}
          </div>
        </div>
      ) : null}
      {introOn && endCount === null ? (
        <div className="revolution-overlay">
          <div className="revolution-box">
            <div className="revolution-title">革命タイム</div>
            <div className="revolution-mult">×{num(multiplier)}</div>
            <div className="revolution-label">残り {num(leftSecs)} 秒 — いいねがお助けに!</div>
          </div>
        </div>
      ) : null}
      {windowOn && !introOn && endCount === null ? (
        <div
          className={`revolution-hud-dock${mirrorOn ? ' at-mirror' : ''}${mirrorLg ? ' mirror-lg' : ''}`}
        >
          <div className="revolution-timer">
            <span className="rt-tag">革命</span>
            <span className="rt-secs" key={leftSecs}>
              残り{num(leftSecs)}秒
            </span>
            <span className="rt-mult">×{num(multiplier)}</span>
          </div>
          <div className="revolution-tally">
            <div className="rvt-panel rvt-tap">
              <span className="rvt-label">タップの戦果</span>
              <b className="rvt-amt" key={`t${tapCount}`}>
                -{num(tapDown)}
              </b>
              <span className="rvt-meta">
                タップ{num(tapCount)}回{multiplier > 1 ? <em>×{num(multiplier)}</em> : null}
              </span>
            </div>
            <div className="rvt-panel rvt-like">
              <span className="rvt-label">いいね反転</span>
              <b className="rvt-amt" key={`l${likeDown}`}>
                -{num(likeDown)}
              </b>
              <span className="rvt-meta">
                いいね{multiplier > 1 ? <em>×{num(multiplier)}</em> : null}
              </span>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
});
