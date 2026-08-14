/**
 * 診断ログの収集口(main プロセス)。
 *
 * なぜ main か: 両レンダラと worker より長生きする唯一のプロセスだから。
 * モニターのレンダラが落ちても、worker が再起動しても、ここのリングは残る。
 * そして **レンダラのホットパスを1行も触らずに** 既存の診断が全部拾える —
 * MonitorView の fxWarn 21箇所も fx エンジンの tick 失敗も worker の
 * イベントループ遅延警告も、すでに console へは出ている。webContents の
 * 'console-message' と worker の stdout/stderr を購読するだけでよい。
 *
 * ファイルへの書き出しは**非同期・バッチ**。配信中に同期書き込みを
 * 100回やるようなことは絶対にしない(それ自体が演出を止める)。
 */

import { appendFile, mkdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { DiagRing, type DiagLevel, type DiagScope } from '@shared/diag-ring';

/** 保持件数。1行が長くても DIAG_MESSAGE_MAX で切られるので上限は効く。 */
const RING_CAP = 300;
/** ファイルのローテーション閾値。 */
const ROTATE_BYTES = 1024 * 1024;
/** 何世代残すか(diag.log + diag.1.log)。 */
const KEEP_GENERATIONS = 1;
/** バッチ書き出しの間隔と件数。 */
const FLUSH_MS = 2000;
const FLUSH_MAX = 32;

const ring = new DiagRing(RING_CAP);
let logDir: string | null = null;
let pending: string[] = [];
let flushTimer: NodeJS.Timeout | null = null;
let flushing = false;

/**
 * 拾う console 行の判別。React の開発警告や Electron の雑多な info まで
 * 溜めるとリングが一瞬で流れるので、既存の診断プレフィックスに絞る。
 * fxWarn は '[fx-skip]'、worker 側は worker-host が '[worker]' を付ける。
 */
const KEEP_PREFIX = ['[fx-skip]', '[worker]', '[diag]'];

function interesting(level: DiagLevel, message: string): boolean {
  if (level === 'error') return true;
  return KEEP_PREFIX.some((p) => message.includes(p));
}

export function initDiagLog(dataDir: string): void {
  logDir = join(dataDir, 'logs');
  void mkdir(logDir, { recursive: true }).catch(() => undefined);
  report('main', 'info', '[diag] ログ収集を開始');
}

/** リングに積み、ファイルへの書き出しを予約する。 */
export function report(scope: DiagScope, level: DiagLevel, message: string): void {
  const atMs = Date.now();
  const fresh = ring.push({ atMs, scope, level, message });
  // 同一メッセージの連発でファイルを膨らませない(リング側で件数は数えている)。
  if (!fresh) return;
  pending.push(`${new Date(atMs).toISOString()}\t${scope}\t${level}\t${message.replace(/\n/g, '\\n')}`);
  if (pending.length >= FLUSH_MAX) {
    void flush();
    return;
  }
  if (flushTimer === null) {
    flushTimer = setTimeout(() => void flush(), FLUSH_MS);
    flushTimer.unref?.();
  }
}

async function flush(): Promise<void> {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (flushing || logDir === null || pending.length === 0) return;
  flushing = true;
  const batch = pending;
  pending = [];
  try {
    const file = join(logDir, 'diag.log');
    await appendFile(file, `${batch.join('\n')}\n`, 'utf8');
    const s = await stat(file).catch(() => null);
    if (s && s.size > ROTATE_BYTES) {
      const old = join(logDir, `diag.${KEEP_GENERATIONS}.log`);
      await unlink(old).catch(() => undefined);
      await rename(file, old).catch(() => undefined);
    }
  } catch {
    // ログのために本体を落とさない。リングには残っているので画面からは読める。
  } finally {
    flushing = false;
  }
}

/** 設定画面の 状態 カード用。 */
export function recentDiag(limit = 100): ReturnType<DiagRing['recent']> {
  return ring.recent(limit);
}

export function diagLogDir(): string | null {
  return logDir;
}

/**
 * webContents の console を購読する。
 *
 * Electron 43 のシグネチャは (details) 形式 — 旧来の位置引数
 * (event, level:number, message, line, sourceId) は deprecated で、
 * 使うとフィールドが undefined になるだけで**無言で**壊れる。
 */
export function attachConsoleCapture(wc: WebContents, scope: DiagScope): void {
  wc.on(
    'console-message',
    (details: { level?: string; message?: string; lineNumber?: number; sourceId?: string }) => {
      const raw = String(details?.message ?? '');
      const lvl: DiagLevel = details?.level === 'error' ? 'error' : details?.level === 'warning' ? 'warn' : 'info';
      if (!interesting(lvl, raw)) return;
      report(scope, lvl, raw);
    }
  );
}

/** worker の stdout/stderr 行を取り込む(worker-host から呼ぶ)。 */
export function reportWorkerLine(level: DiagLevel, line: string): void {
  if (!interesting(level, line)) return;
  report('worker', level, line);
}
