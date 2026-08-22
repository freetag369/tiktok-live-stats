/**
 * モニター窓のフレームタイム計測(2026-08-22)。
 *
 * これまでレンダラ側には FPS/フレームタイムの計器が一切なく、「カクついた」を
 * 事後に diag.log から特定する手段が無かった(metrics.ts の CPU% は60秒平均で
 * 数百msのヒッチは原理的に見えない)。ここで rAF の連続タイムスタンプ差を
 * 60秒ごとに1行へ畳み、console.info('[frame] …') で吐く — main の
 * attachConsoleCapture がファイル専用経路(reportFileOnly)へ回すので、
 * logs/diag.log に毎分1行だけ残り、設定画面のリング(RING_CAP=300)は汚さない。
 *
 * オーバーヘッドは空の rAF コールバック+配列 push のみ(µs 級)。この窓は
 * backgroundThrottling:false の常時描画前提なので、rAF 常駐による省電力阻害は
 * 元から存在しない。
 *
 * 異常時だけ '[diag]' プレフィックスで warn を1行出す(10分に1回まで)—
 * こちらはリングに載り、設定画面の「状態」カードから見える。
 */

/** 集計窓(1行/分)。 */
const REPORT_EVERY_MS = 60_000;
/** 窓あたりのサンプル上限(144Hz でも 8,640/分 — 安全弁)。 */
const DTS_CAP = 10_000;
/**
 * これ以上のフレーム間隔は「窓の遮蔽・サスペンド」とみなして捨てる。
 * rAF は最小化や電源イベントで平気で数秒止まる — それをジャンクとして
 * 数えると、復帰のたびに偽の max が立って本物のヒッチが埋もれる。
 */
const IGNORE_ABOVE_MS = 2_000;
/** エスカレーション(warn)の間隔。 */
const ESCALATE_EVERY_MS = 10 * 60_000;

export interface FrameWindowSummary {
  /** 計測できたフレーム間隔の数。 */
  n: number;
  p50: number;
  p95: number;
  max: number;
  /** 34ms 超(60Hz で 2vsync = 1コマ落ち)の件数。 */
  j34: number;
  /** 50ms 超の件数。 */
  j50: number;
  /** 100ms 超(明確なヒッチ)の件数。 */
  j100: number;
}

/** 窓のフレーム間隔列を要約する(純関数 — テスト対象)。 */
export function summarizeFrames(dts: readonly number[]): FrameWindowSummary {
  if (dts.length === 0) return { n: 0, p50: 0, p95: 0, max: 0, j34: 0, j50: 0, j100: 0 };
  const sorted = [...dts].sort((a, b) => a - b);
  const at = (p: number): number => sorted[Math.min(sorted.length - 1, Math.floor((sorted.length * p) / 100))]!;
  let j34 = 0;
  let j50 = 0;
  let j100 = 0;
  for (const dt of dts) {
    if (dt > 34) j34++;
    if (dt > 50) j50++;
    if (dt > 100) j100++;
  }
  return {
    n: dts.length,
    p50: Math.round(at(50)),
    p95: Math.round(at(95)),
    max: Math.round(sorted[sorted.length - 1]!),
    j34,
    j50,
    j100,
  };
}

export interface TaskWindowSummary {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface MediaLatencySample {
  label: string;
  count: number;
  maxMs: number;
}

/** 1行のログへ整形する(純関数 — テスト対象)。 */
export function formatFrameLine(
  f: FrameWindowSummary,
  task: TaskWindowSummary,
  media: readonly MediaLatencySample[]
): string {
  let line =
    `[frame] n=${f.n} p50=${f.p50} p95=${f.p95} max=${f.max}` +
    ` j34=${f.j34} j50=${f.j50} j100=${f.j100}` +
    ` task=${task.count}/${Math.round(task.totalMs)}ms`;
  if (media.length > 0) {
    line += ` media=${media.map((m) => `${m.label}:${Math.round(m.maxMs)}×${m.count}`).join(',')}`;
  }
  return line;
}

/**
 * リング(設定画面)へ上げるべき異常か(純関数 — テスト対象)。
 * p95 が 50ms 超 = 定常的にコマ落ち、または明確なヒッチが窓内に5回以上。
 */
export function shouldEscalate(f: FrameWindowSummary): boolean {
  if (f.n === 0) return false;
  return f.p95 > 50 || f.j100 >= 5;
}

/** 演出動画の「arm → playing」実測(armVideoPlay / armClipPlay から)。 */
const mediaLatency = new Map<string, { count: number; maxMs: number }>();

export function noteMediaLatency(label: string, ms: number): void {
  const e = mediaLatency.get(label);
  if (e) {
    e.count++;
    if (ms > e.maxMs) e.maxMs = ms;
  } else {
    mediaLatency.set(label, { count: 1, maxMs: ms });
  }
}

let installed = false;

/** モニター窓のエントリ(monitor.tsx)から1回だけ呼ぶ。 */
export function installFrameMeter(): void {
  if (installed) return;
  installed = true;

  let dts: number[] = [];
  let dropped = 0;
  let last = -1;
  const loop = (t: number): void => {
    if (last >= 0) {
      const dt = t - last;
      if (dt >= IGNORE_ABOVE_MS) {
        // 遮蔽・サスペンド明け — この区間は数えない(上の解説)。
        dropped++;
      } else if (dts.length < DTS_CAP) {
        dts.push(dt);
      }
    }
    last = t;
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);

  let task: TaskWindowSummary = { count: 0, totalMs: 0, maxMs: 0 };
  try {
    const obs = new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        task.count++;
        task.totalMs += e.duration;
        if (e.duration > task.maxMs) task.maxMs = e.duration;
      }
    });
    obs.observe({ entryTypes: ['longtask'] });
  } catch {
    // longtask 未対応環境では rAF 差分だけで運用する。
  }

  let lastEscalateMs = 0;
  setInterval(() => {
    const f = summarizeFrames(dts);
    const media: MediaLatencySample[] = [...mediaLatency.entries()].map(([label, m]) => ({
      label,
      count: m.count,
      maxMs: m.maxMs,
    }));
    if (f.n > 0 || task.count > 0 || media.length > 0) {
      let line = formatFrameLine(f, task, media);
      if (dropped > 0) line += ` gap=${dropped}`;
      console.info(line);
      if (shouldEscalate(f)) {
        const now = Date.now();
        if (now - lastEscalateMs >= ESCALATE_EVERY_MS) {
          lastEscalateMs = now;
          console.warn(`[diag] 長フレーム多発 — p95=${f.p95}ms j100=${f.j100}/分(詳細は diag.log の [frame] 行)`);
        }
      }
    }
    dts = [];
    dropped = 0;
    task = { count: 0, totalMs: 0, maxMs: 0 };
    mediaLatency.clear();
  }, REPORT_EVERY_MS);
}
