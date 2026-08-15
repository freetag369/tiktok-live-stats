import { describe, expect, it } from 'vitest';
import { formatMetricsLine, type MetricsProc } from '../../src/main/metrics';

/**
 * formatMetricsLine(diag.log のプロセスメトリクス1行)の純関数テスト。
 *
 * 単位の罠を固定するのが主目的: getAppMetrics の workingSetSize は KB、
 * process.memoryUsage().rss はバイト。どちらも MB へ四捨五入して並べる。
 * 役割(dash/mon/worker)は pid の突き合わせで決まり、突き合わせに失敗しても
 * '-' で埋めるだけで行自体は必ず出る(載らない electron 版でも壊れない)。
 */

const MB = 1024 * 1024;

function proc(pid: number, type: string, memMB: number, cpuPercent: number): MetricsProc {
  return { pid, type, workingSetKB: memMB * 1024, cpuPercent };
}

describe('formatMetricsLine — プロセスメトリクスの1行整形', () => {
  it('全役者が揃っているとき、役割名つきで1行に畳む(残りは other に合算)', () => {
    const procs = [
      proc(100, 'Browser', 100, 1.234),
      proc(200, 'Tab', 140, 4.06),
      proc(300, 'Tab', 96, 9.96),
      proc(400, 'Utility', 80, 0.5),
      proc(500, 'GPU', 60, 3),
      proc(600, 'Zygote', 10, 0),
    ];
    const line = formatMetricsLine(procs, { mainRssBytes: 120 * MB, dashPid: 200, monitorPid: 300, workerPid: 400 });
    expect(line).toBe(
      '[metrics] mem(MB) main=120 dash=140 mon=96 worker=80 gpu=60 other=10(1p)' +
        ' / cpu(%) main=1.2 dash=4.1 mon=10.0 worker=0.5 gpu=3.0'
    );
  });

  it('モニター窓が無い・worker が getAppMetrics に載らないときは - で埋めて壊れない', () => {
    const procs = [proc(100, 'Browser', 100, 1), proc(200, 'Tab', 140, 2), proc(500, 'GPU', 60, 3)];
    const line = formatMetricsLine(procs, { mainRssBytes: 90 * MB, dashPid: 200, monitorPid: null, workerPid: 999 });
    expect(line).toBe(
      '[metrics] mem(MB) main=90 dash=140 mon=- worker=- gpu=60 other=0(0p)' +
        ' / cpu(%) main=1.0 dash=2.0 mon=- worker=- gpu=3.0'
    );
  });

  it('プロセス一覧が空でも main の RSS だけは出る(採取途中の異常でも行は残す)', () => {
    const line = formatMetricsLine([], { mainRssBytes: 64 * MB, dashPid: null, monitorPid: null, workerPid: null });
    expect(line).toBe(
      '[metrics] mem(MB) main=64 dash=- mon=- worker=- gpu=- other=0(0p)' +
        ' / cpu(%) main=- dash=- mon=- worker=- gpu=-'
    );
  });

  it('MB へは四捨五入(KB 単位の workingSetSize と、バイト単位の rss の両方)', () => {
    const procs: MetricsProc[] = [{ pid: 500, type: 'GPU', workingSetKB: 1536, cpuPercent: 0 }]; // 1.5MB → 2
    const line = formatMetricsLine(procs, {
      mainRssBytes: Math.round(2.4 * MB), // 2.4MB → 2
      dashPid: null,
      monitorPid: null,
      workerPid: null,
    });
    expect(line).toBe(
      '[metrics] mem(MB) main=2 dash=- mon=- worker=- gpu=2 other=0(0p)' +
        ' / cpu(%) main=- dash=- mon=- worker=- gpu=0.0'
    );
  });
});
