import { FLUSH_MAX_BATCH, FLUSH_MS } from '@shared/constants';
import type { NormalizedEvent } from '@shared/events';
import type { Store } from './store/index';

/**
 * Individual auto-commit inserts run at ~200–1,000 rows/s; the same rows inside
 * one transaction exceed 100,000/s. Batching is the only ingest optimisation
 * that actually matters — everything else is noise beside it.
 */
export class Batcher {
  private pending: NormalizedEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private sessionId: number | null = null;

  /** Diagnostics surfaced in 設定 when something looks wrong. */
  readonly stats = { flushes: 0, applied: 0, duplicates: 0, dropped: 0, errors: 0, maxFlushMs: 0, queueHigh: 0 };

  constructor(
    private readonly store: Store,
    private readonly onError: (e: Error) => void
  ) {}

  setSession(sessionId: number | null): void {
    this.flush();
    this.sessionId = sessionId;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  push(e: NormalizedEvent): void {
    this.pending.push(e);
    if (this.pending.length > this.stats.queueHigh) this.stats.queueHigh = this.pending.length;
    // Under a real firehose the interval alone can fall behind; drain eagerly.
    if (this.pending.length >= FLUSH_MAX_BATCH * 4) this.flush();
  }

  flush(): void {
    const sid = this.sessionId;
    if (sid == null || this.pending.length === 0) return;
    const batch = this.pending.splice(0, FLUSH_MAX_BATCH);
    const t0 = performance.now();
    try {
      const r = this.store.applyBatch(sid, batch);
      this.stats.applied += r.applied;
      this.stats.duplicates += r.ignoredDuplicates;
      this.stats.dropped += r.droppedBlocked;
    } catch (e) {
      this.stats.errors++;
      this.onError(e as Error);
    }
    const dt = performance.now() - t0;
    if (dt > this.stats.maxFlushMs) this.stats.maxFlushMs = dt;
    this.stats.flushes++;
  }

  get queueLength(): number {
    return this.pending.length;
  }
}
