import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';

/**
 * NDJSON capture of every decoded message.
 *
 * Enabled by the 「デバッグ記録」 toggle. Its purpose is that every future bug
 * report arrives with a fixture that reproduces it exactly, and that the replay
 * harness can drive the real dashboard at real busy-room rates offline.
 */
export class Capture {
  private stream: WriteStream | null = null;
  private startMs = 0;
  private count = 0;

  start(dir: string, meta: Record<string, unknown>): string {
    this.stop();
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const path = join(dir, `capture-${stamp}.ndjson`);
    this.stream = createWriteStream(path, { encoding: 'utf8' });
    this.startMs = Date.now();
    this.count = 0;
    this.stream.write(`${JSON.stringify({ o: -1, meta: { ...meta, capturedAt: new Date().toISOString() } })}\n`);
    return path;
  }

  write(type: string, data: unknown): void {
    if (!this.stream) return;
    try {
      this.stream.write(`${JSON.stringify({ o: Date.now() - this.startMs, type, data })}\n`);
      this.count++;
    } catch {
      // A capture failure must never break ingest.
      this.stop();
    }
  }

  get active(): boolean {
    return this.stream != null;
  }

  get messages(): number {
    return this.count;
  }

  stop(): void {
    this.stream?.end();
    this.stream = null;
  }
}
