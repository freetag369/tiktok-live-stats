import { ControlEvent, SignConfig, TikTokLiveConnection } from 'tiktok-live-connector';
import {
  EULER_RATE_LIMIT_URL,
  OFFLINE_MAX_WAIT_MS,
  OFFLINE_POLL_SEC,
  OFFLINE_POLL_SEC_NO_KEY,
  QUOTA_STOP_FRACTION,
} from '@shared/constants';
import type { AdapterSink, ConnectOptions, QuotaInfo, TikTokAdapter } from '@shared/events';
import { makeNormalizeCtx, normalize, type NormalizeCtx } from './normalize';
import { classify } from './reconnect';

/**
 * THE SWAP POINT. Nothing outside this directory imports tiktok-live-connector.
 *
 * Ingest goes through ControlEvent.DECODED_DATA rather than the ~60 named events,
 * for three reasons:
 *  1. decodedData fires exactly ONCE per wire message, whereas the named-event
 *     dispatcher emits some messages twice (an envelope from a SuperFanBox emits
 *     both `superFanBox` and `envelope`) — a structural double-count we avoid entirely.
 *  2. Unrecognised message types are counted instead of vanishing, so TikTok
 *     protocol drift shows up as a number in 設定 rather than silent data loss.
 *  3. The capture format and the replay fixture are byte-identical to what the
 *     live path sees, so the replay harness tests the real code.
 *
 * The payload shape is `(method, { type, data }, binary)` — the second argument is
 * a WRAPPER, not the message itself.
 */
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

function barrageKind(data: Record<string, any>): string | null {
  const keys = [data?.content?.key, data?.commonBarrageContent?.key]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .map((v) => v.toLowerCase());
  if (keys.some((k) => k.includes('ttlive_superfan_commentnotif_superfanjoined'))) return 'superFanJoin';
  if (keys.some((k) => k.includes('ttlive_superfan'))) return 'superFan';
  return null;
}

export interface AdapterDeps {
  sink: AdapterSink;
  /** Enabled by the 「デバッグ記録」 toggle; every real stream then yields a replayable fixture. */
  capture?: (protoType: string, data: unknown) => void;
  log?: (kind: string, detail?: string) => void;
}

export class LiveAdapter implements TikTokAdapter {
  readonly sink: AdapterSink;
  private conn: TikTokLiveConnection | null = null;
  private norm: NormalizeCtx = makeNormalizeCtx();
  private abort: AbortController | null = null;
  private stopped = false;
  private looping = false;
  private attempt = 0;
  private quota: QuotaInfo | null = null;
  private apiKey: string | undefined;

  constructor(private readonly deps: AdapterDeps) {
    this.sink = deps.sink;
  }

  async connect(o: ConnectOptions): Promise<void> {
    this.stopped = false;
    this.attempt = 0;
    this.abort = new AbortController();
    this.apiKey = o.signApiKey || undefined;

    // SignConfig is process-global and the Euler client is cached on first use, so
    // the key must be set before any connection is constructed. Main restarts the
    // worker when the key changes rather than guessing about cache lifetimes.
    if (this.apiKey) SignConfig.apiKey = this.apiKey;

    this.lastOpts = o;
    await this.refreshQuota();
    // fire-and-forget だが、reject を放置すると unhandled rejection がプロセス
    // 全体のクラッシュハンドラに落ちて DB ごと閉じられる。必ず status に変換する。
    void this.loop(o).catch((e) => this.fail(e));
  }

  private fail(e: unknown): void {
    this.deps.log?.('error', String((e as Error)?.message ?? e));
    if (!this.stopped) {
      this.sink.status({ state: 'error', message: '接続処理で予期しないエラーが発生しました。', fatal: false });
    }
  }

  async disconnect(reason: string): Promise<void> {
    this.stopped = true;
    this.abort?.abort(new Error(reason));
    const c = this.conn;
    this.conn = null;
    if (c) {
      try {
        await c.disconnect();
      } catch {
        /* already gone */
      }
      c.removeAllListeners();
    }
  }

  /** The library's own helper is unverified; a quota-display failure must never break connect. */
  async getQuota(): Promise<QuotaInfo | null> {
    return this.quota;
  }

  private async refreshQuota(): Promise<QuotaInfo | null> {
    try {
      // タイムアウト必須: waitForLive がループ先頭で毎回 await するため、Euler が
      // ハングするとオフライン待機ごと無期限に固まる。abort にも連動させる。
      const signals = [AbortSignal.timeout(10_000), this.abort?.signal].filter(Boolean) as AbortSignal[];
      const res = await fetch(EULER_RATE_LIMIT_URL, {
        headers: this.apiKey ? { 'X-Api-Key': this.apiKey, Authorization: `Bearer ${this.apiKey}` } : {},
        signal: AbortSignal.any(signals),
      });
      if (!res.ok) return this.quota;
      const j = (await res.json()) as Record<string, any>;
      const pick = (k: string) =>
        j?.[k] ? { max: Number(j[k].max ?? 0), remaining: Number(j[k].remaining ?? 0), resetAt: j[k].reset_at ?? null } : undefined;
      this.quota = {
        hasApiKey: Boolean(this.apiKey),
        day: pick('day'),
        hour: pick('hour'),
        minute: pick('minute'),
        fetchedMs: Date.now(),
      };
    } catch {
      /* offline / blocked — keep the previous reading */
    }
    return this.quota;
  }

  /** True once QUOTA_STOP_FRACTION of the daily sign-request budget is gone. */
  private quotaExhausted(): boolean {
    const d = this.quota?.day;
    if (!d || !d.max) return false;
    return d.remaining <= d.max * (1 - QUOTA_STOP_FRACTION);
  }

  private async loop(o: ConnectOptions): Promise<void> {
    // connect 失敗時の catch 内 disconnect() が DISCONNECTED を発火し、そこから
    // reconnectSoon() → 2本目の loop() が起動して増殖する事故があった。ハンドラ側の
    // conn 同一性ガードに加え、loop 自体を単一実行にする。
    if (this.looping) return;
    this.looping = true;
    try {
      await this.loopInner(o);
    } finally {
      this.looping = false;
    }
  }

  private async loopInner(o: ConnectOptions): Promise<void> {
    while (!this.stopped) {
      this.attempt++;
      this.sink.status({ state: 'connecting', uniqueId: o.uniqueId, attempt: this.attempt });

      // A fresh instance per attempt: `processInitialData` is read once in the
      // constructor, so reusing the object silently keeps the first value and
      // replays TikTok's backlog on every reconnect.
      const conn = new TikTokLiveConnection(o.uniqueId, {
        processInitialData: o.processInitialData,
        fetchRoomInfoOnConnect: true,
        // Can 403 the whole connect (upstream issue #310) and is unnecessary:
        // gift.diamondCount is already on the event.
        enableExtendedGiftInfo: false,
        ...(this.apiKey ? { signApiKey: this.apiKey } : {}),
      });
      this.conn = conn;
      this.wire(conn);

      try {
        const state = await conn.connect();
        this.attempt = 0;
        const info = state.roomInfo as Record<string, any> | null;
        const owner = (info?.data?.owner ?? info?.owner) as Record<string, any> | undefined;
        const hostUserId = owner ? String(owner.id_str ?? owner.idStr ?? owner.id ?? '') : '';
        this.sink.status({
          state: 'live',
          roomId: String(state.roomId ?? ''),
          hostUserId: hostUserId || undefined,
          hostDisplayId: String(owner?.display_id ?? owner?.displayId ?? o.uniqueId),
          startedMs: Date.now(),
        });
        void this.refreshQuota();
        return; // stay connected; reconnection is driven by the disconnected handler
      } catch (e) {
        this.conn = null;
        try {
          await conn.disconnect();
        } catch {
          /* ignore */
        }
        // 捨てた接続のリスナーを残すと、ゾンビ接続からのコールバックが
        // 二重取り込み・二重再接続の火種になる。
        conn.removeAllListeners();
        if (this.stopped) return;

        const d = classify(e, this.attempt);
        if (d.action === 'giveUp') {
          this.sink.status({ state: 'error', message: d.reason, fatal: true });
          return;
        }
        if (d.action === 'blocked') {
          this.sink.status({ state: 'blocked', hint: d.hint });
          return;
        }
        if (d.action === 'rateLimited') {
          this.sink.status({ state: 'rateLimited', retryAfterMs: d.delayMs, scope: d.scope });
          void this.refreshQuota();
          if (!(await this.sleep(d.delayMs))) return;
          continue;
        }
        if (d.action === 'waitOffline') {
          if (!o.waitUntilLive) {
            this.sink.status({ state: 'error', message: '配信が開始されていません。', fatal: false });
            return;
          }
          const wentLive = await this.waitForLive(conn, o);
          if (!wentLive) return;
          continue;
        }
        this.sink.status({ state: 'reconnecting', attempt: this.attempt, nextAttemptMs: Date.now() + d.delayMs });
        this.deps.log?.('error', d.reason);
        if (!(await this.sleep(d.delayMs))) return;
      }
    }
  }

  /**
   * Offline polling burns one Euler sign request per check. At the library's 60 s
   * floor that is ~1,440/day against a 2,500/day free quota — one forgotten toggle
   * plus a few reconnects and the user is locked out at prime time. Hence a 180 s
   * default, a 4-hour ceiling, and a hard stop at 80 % of the daily quota.
   */
  private async waitForLive(conn: TikTokLiveConnection, o: ConnectOptions): Promise<boolean> {
    const givesUpAt = Date.now() + OFFLINE_MAX_WAIT_MS;
    // An unauthenticated client gets 100 requests a day and 30 an hour; polling
    // every 3 minutes would spend the entire budget waiting for a stream that has
    // not started yet.
    const pollSec = this.apiKey ? OFFLINE_POLL_SEC : OFFLINE_POLL_SEC_NO_KEY;
    while (!this.stopped && Date.now() < givesUpAt) {
      await this.refreshQuota();
      if (this.quotaExhausted()) {
        this.sink.status({
          state: 'error',
          message: '本日の残りリクエストが少ないため、オフライン待機を停止しました。',
          fatal: false,
        });
        return false;
      }
      this.sink.status({
        state: 'waitingOffline',
        uniqueId: o.uniqueId,
        nextCheckMs: Date.now() + pollSec * 1000,
        givesUpAtMs: givesUpAt,
      });
      if (!(await this.sleep(pollSec * 1000))) return false;
      try {
        if (await conn.fetchIsLive()) return true;
      } catch {
        /* transient — keep waiting */
      }
    }
    if (!this.stopped) {
      this.sink.status({ state: 'error', message: '待機時間の上限に達しました。', fatal: false });
    }
    return false;
  }

  private sleep(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const signal = this.abort?.signal;
      const t = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve(!this.stopped);
      }, ms);
      const onAbort = () => {
        clearTimeout(t);
        resolve(false);
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private wire(conn: TikTokLiveConnection): void {
    // MUST be attached before connect(): handleError() returns early when
    // listenerCount('error') < 1, and it never rethrows — so without this a
    // mid-stream failure is completely invisible.
    conn.on(ControlEvent.ERROR, (err: unknown) => {
      const e = err as { info?: string; exception?: unknown };
      this.deps.log?.('error', `${e?.info ?? ''} ${String((e?.exception as Error)?.message ?? '')}`.trim());
    });

    conn.on(ControlEvent.WEBSOCKET_CONNECTED, () => this.deps.log?.('websocketConnected'));

    conn.on(ControlEvent.DISCONNECTED, () => {
      this.deps.log?.('disconnected');
      // 捨て済み接続(connect 失敗時の catch 内 disconnect 等)からの発火で
      // 並列の再接続 loop を起動しない。現役の接続だけが再接続を駆動する。
      if (conn !== this.conn) return;
      if (this.stopped) return;
      // 旧接続はここで手放す — loopInner は新しい接続を作って this.conn を
      // 差し替えるだけなので、リスナーを付けたまま放置すると瞬断のたびに
      // ゾンビ接続が積み上がる(disconnect()/connect 失敗 catch と同じ後始末)。
      this.conn = null;
      conn.removeAllListeners();
      // Reconnects must not replay TikTok's buffered backlog.
      this.sink.status({ state: 'reconnecting', attempt: 1, nextAttemptMs: Date.now() + 5000 });
      void this.reconnectSoon().catch((e) => this.fail(e));
    });

    conn.on(ControlEvent.DECODED_DATA, (protoType: string, decoded: unknown) => {
      if (conn !== this.conn) return; // ゾンビ接続からの二重取り込み防止
      const wrapper = decoded as { type?: string; data?: unknown } | undefined;
      const type = wrapper?.type ?? protoType;
      const payload = (wrapper && 'data' in wrapper ? wrapper.data : decoded) as Record<string, any>;
      if (!payload || typeof payload !== 'object') return;

      this.deps.capture?.(type, payload);

      let kind = PROTO_TO_KIND[type];
      if (!kind && type === 'WebcastBarrageMessage') kind = barrageKind(payload) ?? '';
      const e = normalize(this.norm, kind || type, payload);
      if (e) this.sink.event(e);
    });
  }

  private lastOpts: ConnectOptions | null = null;

  private async reconnectSoon(): Promise<void> {
    const o = this.lastOpts;
    if (!o || this.stopped) return;
    if (!(await this.sleep(5000))) return;
    // processInitialData is forced off: the backlog has already been recorded.
    await this.loop({ ...o, processInitialData: false });
  }
}
