import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import type { AdapterSink, ConnectOptions, QuotaInfo, TikTokAdapter } from '@shared/events';
import { makeNormalizeCtx, normalize, type NormalizeCtx } from './normalize';

/**
 * The same TikTokAdapter contract, fed from an NDJSON capture instead of the
 * network. The session FSM cannot tell the two apart — that is the entire test
 * strategy, and it is what lets the dashboard be exercised at real busy-room
 * rates without going live.
 *
 * Line format (one decoded message per line, exactly as decodedData delivers it):
 *   {"o": 1240, "type": "WebcastChatMessage", "data": { … }}
 * with an optional header line {"o": -1, "meta": { … }}.
 */
export interface ReplayOptions {
  file: string;
  /** 0 = as fast as possible (deterministic), 1 = real time, 10 = 10x. */
  speed: number;
  /** Rewrite timestamps so a months-old capture lands in the present. */
  shiftToNow?: boolean;
  onEnd?: () => void;
}

const PROTO_TO_KIND: Record<string, string> = {
  WebcastChatMessage: 'chat',
  WebcastMemberMessage: 'member',
  WebcastGiftMessage: 'gift',
  WebcastLikeMessage: 'like',
  WebcastSocialMessage: 'social',
  WebcastRoomUserSeqMessage: 'roomUser',
  WebcastEmoteChatMessage: 'emote',
  WebcastEnvelopeMessage: 'envelope',
  WebcastSubNotifyMessage: 'subNotify',
  WebcastQuestionNewMessage: 'questionNew',
  WebcastControlMessage: 'controlMessage',
};

export class ReplayAdapter implements TikTokAdapter {
  readonly sink: AdapterSink;
  private norm: NormalizeCtx = makeNormalizeCtx();
  private stopped = false;

  constructor(
    sink: AdapterSink,
    private readonly opts: ReplayOptions
  ) {
    this.sink = sink;
  }

  async connect(o: ConnectOptions): Promise<void> {
    this.stopped = false;
    this.sink.status({
      state: 'live',
      roomId: `replay:${this.opts.file}`,
      hostDisplayId: o.uniqueId || 'replay',
      startedMs: Date.now(),
    });
    void this.run();
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
  }

  async getQuota(): Promise<QuotaInfo | null> {
    return null;
  }

  private async run(): Promise<void> {
    const rl = createInterface({ input: createReadStream(this.opts.file, 'utf8'), crlfDelay: Infinity });
    const wallStart = Date.now();
    let shift = 0;
    let first = true;

    for await (const line of rl) {
      if (this.stopped) break;
      const t = line.trim();
      if (!t) continue;
      let rec: { o?: number; type?: string; data?: unknown; meta?: unknown };
      try {
        rec = JSON.parse(t);
      } catch {
        continue;
      }
      if (rec.meta || !rec.type || !rec.data) continue;

      const offset = Number(rec.o ?? 0);
      if (this.opts.speed > 0) {
        const due = wallStart + offset / this.opts.speed;
        const wait = due - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      }

      const data = rec.data as Record<string, any>;
      if (this.opts.shiftToNow) {
        if (first) {
          const raw = Number(data?.common?.createTime ?? 0);
          const asMs = raw > 0 && raw < 1e12 ? raw * 1000 : raw;
          if (asMs > 0) shift = Date.now() - asMs;
          first = false;
        }
        if (shift && data?.common?.createTime) {
          const raw = Number(data.common.createTime);
          const asMs = raw < 1e12 ? raw * 1000 : raw;
          data.common.createTime = String(asMs + shift);
        }
      }

      const kind = PROTO_TO_KIND[rec.type] ?? rec.type;
      const e = normalize(this.norm, kind, data);
      if (e) this.sink.event(e);
    }

    rl.close();
    if (!this.stopped) {
      this.sink.status({ state: 'ended', reason: 'streamEnd' });
      this.opts.onEnd?.();
    }
  }
}
