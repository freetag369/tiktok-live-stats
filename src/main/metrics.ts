/**
 * プロセスメトリクスの定期採取(main プロセス、60秒周期)。
 *
 * 目的: GitHub 配布先のPCで起きる長期運用の劣化・固まり(どのプロセスが
 * 何時間目から太るのか、CPU が張り付くのはレンダラか GPU か worker か)を、
 * ユーザーから logs/diag.log を送ってもらう**だけ**で追跡できるようにする。
 * 手元で再現しない障害に DevTools やタスクマネージャの操作を頼むのは無理筋。
 *
 * リング汚染対策: 毎分の詳細行はファイル専用経路(reportFileOnly)へ流し、
 * リング(RING_CAP=300)には5分に1回だけ積む — 定期行が fxWarn・例外を
 * 押し流さないため。ファイル側は1MBローテーションで上限が効く。
 *
 * electron をここで import しない: 行の整形(formatMetricsLine)を node の
 * vitest からそのまま読むため(diag-ring と同じ理由)。app.getAppMetrics も
 * pid の取得も deps で注入する。
 */

import { report, reportFileOnly } from './diag-log';

/** 採取周期。演出への影響を無視できる頻度で、かつ「何分目から」が分かる粒度。 */
const SAMPLE_EVERY_MS = 60_000;
/** リングへはこの回数に1回だけ(= 5分に1回)。 */
const RING_EVERY_TICKS = 5;

/** Electron.ProcessMetric の構造的サブセット(electron を import しないため)。 */
export interface AppMetricLike {
  pid: number;
  type: string;
  memory: { workingSetSize: number };
  cpu: { percentCPUUsage: number };
}

/** formatMetricsLine の入力1プロセス分。単位の罠はコメント参照。 */
export interface MetricsProc {
  pid: number;
  /** ProcessMetric.type。GPU プロセスは 'GPU'、main は 'Browser'。 */
  type: string;
  /** ProcessMetric.memory.workingSetSize — 単位は**KB**(electron の仕様。バイトではない)。 */
  workingSetKB: number;
  /** ProcessMetric.cpu.percentCPUUsage — 前回 getAppMetrics を呼んでからの平均使用率。 */
  cpuPercent: number;
}

export interface MetricsIds {
  /** main 自身の process.memoryUsage().rss(バイト)。getAppMetrics より素直な実測。 */
  mainRssBytes: number;
  /** メイン窓レンダラの OS pid(窓が無ければ null)。 */
  dashPid: number | null;
  /** モニター窓レンダラの OS pid(窓が無ければ null)。 */
  monitorPid: number | null;
  /**
   * worker(utilityProcess)の OS pid。getAppMetrics に載るかは electron の
   * バージョン依存なので、載っていなければ '-' と出すだけで壊れない。
   */
  workerPid: number | null;
}

export interface MetricsSamplerDeps {
  /** app.getAppMetrics() の注入。throw しても sample 側の try/catch で握る。 */
  getAppMetrics: () => AppMetricLike[];
  getMainWindowPid: () => number | null;
  getMonitorWindowPid: () => number | null;
  getWorkerPid: () => number | null;
}

/**
 * 1サンプルを diag.log の1行に畳む純関数(単体テスト対象)。
 *
 * 役割を pid で名指しする理由: getAppMetrics の type は 'Tab' が並ぶだけで、
 * どれがモニター窓かは pid を突き合わせないと分からない。突き合わせに漏れた
 * プロセス(zygote 等)は other に合算して総量の把握だけ保つ。
 */
export function formatMetricsLine(procs: MetricsProc[], ids: MetricsIds): string {
  const byPid = new Map(procs.map((p) => [p.pid, p]));
  const dash = ids.dashPid != null ? byPid.get(ids.dashPid) : undefined;
  const mon = ids.monitorPid != null ? byPid.get(ids.monitorPid) : undefined;
  const worker = ids.workerPid != null ? byPid.get(ids.workerPid) : undefined;
  const gpu = procs.find((p) => p.type === 'GPU');
  const main = procs.find((p) => p.type === 'Browser');

  const named = new Set<MetricsProc>();
  for (const p of [main, dash, mon, worker, gpu]) if (p) named.add(p);
  const others = procs.filter((p) => !named.has(p));
  const otherKB = others.reduce((a, p) => a + p.workingSetKB, 0);

  const mem = (p: MetricsProc | undefined): string => (p ? String(Math.round(p.workingSetKB / 1024)) : '-');
  const cpu = (p: MetricsProc | undefined): string => (p ? p.cpuPercent.toFixed(1) : '-');

  return (
    `[metrics] mem(MB) main=${Math.round(ids.mainRssBytes / (1024 * 1024))} dash=${mem(dash)} mon=${mem(mon)}` +
    ` worker=${mem(worker)} gpu=${mem(gpu)} other=${Math.round(otherKB / 1024)}(${others.length}p)` +
    ` / cpu(%) main=${cpu(main)} dash=${cpu(dash)} mon=${cpu(mon)} worker=${cpu(worker)} gpu=${cpu(gpu)}`
  );
}

let timer: NodeJS.Timeout | null = null;
let tick = 0;

export function startMetricsSampler(deps: MetricsSamplerDeps): void {
  if (timer) return; // 二重開始は想定外だが、タイマーを漏らさないよう無害化しておく
  tick = 0;
  timer = setInterval(() => sample(deps), SAMPLE_EVERY_MS);
  timer.unref?.(); // 終了を妨げない(diag-log の flush タイマーと同じ流儀)
}

export function stopMetricsSampler(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

function sample(deps: MetricsSamplerDeps): void {
  try {
    const procs: MetricsProc[] = deps.getAppMetrics().map((m) => ({
      pid: m.pid,
      type: m.type,
      workingSetKB: m.memory?.workingSetSize ?? 0,
      cpuPercent: m.cpu?.percentCPUUsage ?? 0,
    }));
    const line = formatMetricsLine(procs, {
      mainRssBytes: process.memoryUsage().rss,
      dashPid: deps.getMainWindowPid(),
      monitorPid: deps.getMonitorWindowPid(),
      workerPid: deps.getWorkerPid(),
    });
    tick++;
    if (tick % RING_EVERY_TICKS === 0) report('main', 'info', line);
    else reportFileOnly('main', 'info', line);
  } catch {
    // 採取失敗(getAppMetrics の異常等)で本体を巻き込まない。診断は best effort。
  }
}
