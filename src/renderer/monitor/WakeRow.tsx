import { useEffect, useState } from 'react';
import { wakeElapsedMs } from '@shared/time';

/**
 * 「何時起き」— 起床時刻と、そこからの経過(モニター左下)。
 *
 * MonitorView から切り出しているのは再描画の頻度が違うため。表示の粒度は「分」なので
 * ここだけ 10 秒で回し、2Hz の delta で回る親を毎秒巻き込まないようにする。
 *
 * refMs は「起床時刻がどの日か」を決める錨 — 企画の開始時刻(未開始なら now)。
 * now を錨にすると、24 時間を超えて起きている配信で表示が 0 へ巻き戻る。
 */
const TICK_MS = 10_000;

export function WakeRow({
  wakeTime,
  refMs,
}: {
  wakeTime: string;
  refMs: number | null;
}): React.JSX.Element | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(t);
  }, []);

  const ms = wakeElapsedMs(wakeTime, refMs ?? now, now);
  // 検証をすり抜けた不正な 'HH:mm' は黙って出さない(モニターにエラーは出せない)。
  if (ms === null) return null;

  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  // 時は 0 詰めしない(設定値 '05:30' → 表示 '5:30')。分は 0 詰めのまま。
  const wakeH = Number(wakeTime.slice(0, 2));
  const wakeM = wakeTime.slice(3, 5);

  return (
    <div className="wake-row">
      起床{' '}
      <span className="wake-num">{wakeH}</span>:<span className="wake-num">{wakeM}</span> /{' '}
      <span className="wake-num">{h}</span>時間<span className="wake-num">{m}</span>分
    </div>
  );
}
