import type { LiveDelta, LiveMessage } from './ipc';

/**
 * lite ポート(モニター窓)向けの firehose 間引き(2026-08-22)。
 *
 * モニター窓の liveStore は `attachLive({ lite: true })` で viewers を読まずに
 * 捨て、feed を丸ごと捨てる — が、**structured clone のデシリアライズは受信時に
 * 済んでいる**ため、捨てる前の展開コストと GC 圧(最大 800 視聴者 × 2Hz +
 * 40 フィード × 4Hz。ニックネーム・コメント本文・アバターURL込み)が長時間配信で
 * モニターのメインスレッドへ積み上がっていた。worker 側の送り分けで
 * 「捨てるものはそもそも送らない」にする。
 *
 * 受け側の lite ガード(liveStore)は**そのまま残す** — 全ポート死亡時の
 * main 経由フォールバック(worker/index.ts の pushLive)はフル payload のまま
 * 流れてくるので、防御は両側に要る。
 *
 * challenge / totals / sessionId は無加工で通す(演出 watermark・押下の即時性の
 * 契約に一切触れない)。status / job も素通し。
 */

const EMPTY_VIEWERS: LiveDelta['viewers'] = [];
const EMPTY_ALERTS: LiveDelta['alerts'] = [];

/** lite ポートへ送る形へ間引く。null = そのメッセージは送らない(feed)。 */
export function liteLiveMessage(m: LiveMessage): LiveMessage | null {
  if (m.t === 'feed') return null;
  if (m.t !== 'delta') return m;
  const lite: LiveDelta = {
    t: 'delta',
    tick: m.tick,
    atMs: m.atMs,
    sessionId: m.sessionId,
    totals: m.totals,
    // モニターが読まない配列は空で送る(missions もキーごと落とす)。
    viewers: EMPTY_VIEWERS,
    alerts: EMPTY_ALERTS,
    deferred: 0,
  };
  if (m.challenge) lite.challenge = m.challenge;
  return lite;
}
