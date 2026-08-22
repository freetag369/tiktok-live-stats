import { memo, useEffect, useState } from 'react';
import { num } from '@shared/format';

/**
 * お邪魔(タップ封じ)の残り秒 HUD。
 *
 * MonitorView から切り出した独立コンポーネント(2026-08-22)— 以前は本体に
 * 250ms の interval があり、封印中ずっと **MonitorView 全体(約1000行の JSX)を
 * 4Hz で再レンダー**していた。残り秒を描くのはこの数十ノードだけなので、
 * tick はここに閉じる。memo + プリミティブ props なので、親の 2Hz delta
 * 再レンダーでは props が変わらない限りスキップされる。
 *
 * 規約は本体時代のまま:
 * - ソースは worker 権威の**絶対期限(endsAtMs)だけ**。残り秒は描画時点の
 *   now で数える(state に now を持つと初回フレームだけ古い値が出る)。
 * - 期限切れの表示落ちは worker の delta を待たない。倒す向きは常に安全側 —
 *   「表示が遅れて残る」ことはあっても「解けていないのに解けて見える」ことはない。
 * - key=秒 の再マウントで毎秒パンチを再生する。
 * - reduced-motion でも出す — 演出ではなく「なぜ数字が動かないのか」の説明。
 */
export const TapLockHud = memo(function TapLockHud({
  endsAtMs,
  nickname,
}: {
  endsAtMs: number;
  nickname: string | null;
}): React.JSX.Element | null {
  // 250ms の interval は再描画のポンプに徹する(本体時代と同じ設計)。
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 250);
    return () => clearInterval(t);
  }, [endsAtMs]);
  const leftMs = Math.max(0, endsAtMs - Date.now());
  if (leftMs <= 0) return null;
  const secs = Math.ceil(leftMs / 1000);
  return (
    <div className="tap-lock-overlay">
      <div className="tap-lock-box">
        <div className="tap-lock-title">タップ封じ</div>
        <div className="tap-lock-count" key={secs}>
          {num(secs)}
        </div>
        <div className="tap-lock-label">{nickname ? `${nickname} さんのお邪魔` : 'お邪魔中'}</div>
      </div>
    </div>
  );
});
