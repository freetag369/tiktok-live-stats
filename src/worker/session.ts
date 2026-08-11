import { join } from 'node:path';
import { DELTA_MS, DELTA_MS_HIDDEN, FEED_MS } from '@shared/constants';
import type { AdapterStatus, EndReason, NormalizedEvent, QuotaInfo, TikTokAdapter, UserId } from '@shared/events';
import type { LiveMessage } from '@shared/ipc';
import type { MissionConfig, MissionProgress } from '@shared/dto';
import { evaluateMissions } from '@shared/missions';
import { Aggregator } from './aggregator';
import { Alerts } from './alerts';
import { Batcher } from './batcher';
import type { ChallengeEngine } from './challenge';
import { Capture } from './capture';
import { Feed } from './feed';
import { LiveAdapter } from './tiktok/adapter';
import { ReplayAdapter } from './tiktok/replay-adapter';
import type { Store } from './store/index';

/**
 * Resolved once per viewer per session and reused for every row they produce, so
 * the feed can show who someone is without a database hit per comment.
 */
interface ViewerMeta {
  vipTier: number;
  visits: number;
  firstEver: boolean;
  prevVisitMs?: number;
  diamondsLifetime?: number;
  heartMeLifetime?: number;
  likesLifetime?: number;
  readingKana?: string;
  note?: string;
}

export interface SessionDeps {
  store: Store;
  post: (m: LiveMessage) => void;
  userDataDir: string;
  getSettings: () => { eulerApiKey: string; captureDebug: boolean; alertMinTier: number; giftAlertDiamonds: number };
  getMissionConfig: () => MissionConfig;
  /** カウントダウンチャレンジ。寿命はワーカーと同じ — reset() では触らない。 */
  challenge: ChallengeEngine;
}

/**
 * The session state machine: resolve -> connect -> live -> (end | reconnect).
 *
 * Owns the sessionId, the resume rule, and the 2 Hz / 4 Hz push cadence. Written
 * against the TikTokAdapter interface so the live and replay adapters are
 * interchangeable — the FSM cannot tell which one it is driving.
 */
export class SessionManager {
  private adapter: TikTokAdapter | null = null;
  private batcher: Batcher;
  private agg = new Aggregator();
  private feed = new Feed();
  private alerts: Alerts;
  private capture = new Capture();

  private deltaTimer: NodeJS.Timeout | null = null;
  private feedTimer: NodeJS.Timeout | null = null;
  private hidden = false;

  private meta = new Map<UserId, ViewerMeta>();
  /** Distinct viewers seen this session whose very first visit this is. */
  private firstTimers = 0;
  private sessionStartMs = 0;
  private lastMissions = '';

  sessionId: number | null = null;
  status: AdapterStatus = { state: 'idle' };
  quota: QuotaInfo | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.batcher = new Batcher(deps.store, (e) => {
      deps.store.recordConnectLog('error', `flush: ${e.message}`);
    });
    const s0 = deps.getSettings();
    this.alerts = new Alerts(deps.store, s0.alertMinTier, s0.giftAlertDiamonds);
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  async start(uniqueId: string, waitUntilLive: boolean): Promise<{ sessionId: number | null }> {
    await this.stop('userStopped', false);

    const clean = uniqueId.trim().replace(/^@/, '').replace(/^https?:\/\/(www\.)?tiktok\.com\/@?/, '').split(/[/?#]/)[0] ?? '';
    if (!clean) {
      this.setStatus({ state: 'error', message: 'ユーザー名を入力してください。', fatal: true });
      return { sessionId: null };
    }

    this.reset();
    this.setStatus({ state: 'resolving', uniqueId: clean });

    const settings = this.deps.getSettings();
    this.alerts.minTier = settings.alertMinTier;
    this.alerts.giftAlertDiamonds = settings.giftAlertDiamonds;

    const adapter = new LiveAdapter({
      sink: {
        event: (e) => this.onEvent(e),
        status: (s) => this.onStatus(s, clean),
      },
      capture: settings.captureDebug
        ? (type, data) => this.capture.write(type, data)
        : undefined,
      log: (kind, detail) => this.deps.store.recordConnectLog(kind as 'error', detail),
    });
    this.adapter = adapter;

    if (settings.captureDebug) {
      this.capture.start(join(this.deps.userDataDir, 'captures'), { uniqueId: clean });
    }

    this.batcher.start();
    this.startTimers();
    await adapter.connect({
      uniqueId: clean,
      signApiKey: settings.eulerApiKey || undefined,
      waitUntilLive,
      processInitialData: true,
    });
    this.quota = await adapter.getQuota();
    return { sessionId: this.sessionId };
  }

  /** Drives the dashboard from an NDJSON capture — no network, no Euler quota. */
  async startReplay(file: string, speed: number): Promise<{ sessionId: number | null }> {
    await this.stop('userStopped', false);
    this.reset();
    const adapter = new ReplayAdapter(
      { event: (e) => this.onEvent(e), status: (s) => this.onStatus(s, 'replay') },
      { file, speed, shiftToNow: true }
    );
    this.adapter = adapter;
    this.batcher.start();
    this.startTimers();
    await adapter.connect({ uniqueId: 'replay', waitUntilLive: false, processInitialData: true });
    return { sessionId: this.sessionId };
  }

  async stop(reason: EndReason = 'userStopped', announce = true): Promise<void> {
    this.stopTimers();
    if (this.adapter) {
      await this.adapter.disconnect(reason);
      this.adapter = null;
    }
    this.batcher.stop();
    this.capture.stop();
    if (this.sessionId != null) {
      this.deps.store.closeSession(this.sessionId, { endedMs: Date.now(), reason });
      this.batcher.setSession(null);
      this.sessionId = null;
    }
    if (announce) this.setStatus({ state: 'ended', reason });
  }

  setHidden(hidden: boolean): void {
    if (this.hidden === hidden) return;
    this.hidden = hidden;
    if (this.deltaTimer) {
      this.startTimers();
      // On restore, send one full-state delta rather than replaying the gap.
      if (!hidden) this.pushDelta(true);
    }
  }

  private reset(): void {
    this.agg.reset();
    this.feed.reset();
    this.alerts.reset();
    this.meta.clear();
    this.firstTimers = 0;
    this.lastMissions = '';
    this.sessionStartMs = 0;
  }

  private startTimers(): void {
    this.stopTimers();
    this.deltaTimer = setInterval(() => this.pushDelta(false), this.hidden ? DELTA_MS_HIDDEN : DELTA_MS);
    this.deltaTimer.unref?.();
    if (!this.hidden) {
      this.feedTimer = setInterval(() => this.pushFeed(), FEED_MS);
      this.feedTimer.unref?.();
    }
  }

  private stopTimers(): void {
    if (this.deltaTimer) clearInterval(this.deltaTimer);
    if (this.feedTimer) clearInterval(this.feedTimer);
    this.deltaTimer = null;
    this.feedTimer = null;
  }

  // ── adapter callbacks ─────────────────────────────────────────────────────

  private onStatus(s: AdapterStatus, uniqueId: string): void {
    if (s.state === 'live') {
      const opened = this.deps.store.openSession({
        hostUserId: s.hostUserId ?? null,
        hostUniqueId: s.hostDisplayId || uniqueId,
        roomId: s.roomId || null,
        startedMs: s.startedMs,
      });
      this.sessionId = opened.sessionId;
      this.sessionStartMs = s.startedMs;
      this.batcher.setSession(opened.sessionId);
      this.deps.store.recordConnectLog('connected', `${uniqueId} room=${s.roomId}`);
      // A resumed session already has totals in the DB; reload them so the live
      // counters continue from where the drop happened instead of restarting at 0.
      if (opened.resumed) this.hydrateTotals(opened.sessionId);
    }

    if (s.state === 'ended') {
      void this.stop(s.reason);
      return;
    }

    this.setStatus(s);
  }

  private hydrateTotals(sessionId: number): void {
    const t = this.deps.store.getSessionTotals(sessionId);
    if (!t) return;
    this.sessionStartMs = t.startedMs;

    // Restore the roster so 観測ユニーク does not restart at zero and regulars are
    // not re-announced as fresh arrivals after a reconnect.
    this.meta.clear();
    this.firstTimers = 0;
    for (const a of this.deps.store.getSessionAttendees(sessionId)) {
      this.meta.set(a.userId, {
        vipTier: a.vipTier,
        visits: a.visits,
        firstEver: a.firstEver,
        prevVisitMs: a.prevVisitMs,
        diamondsLifetime: a.diamondsLifetime,
        heartMeLifetime: a.heartMeLifetime,
        likesLifetime: a.likesLifetime,
        readingKana: a.readingKana,
        note: a.note,
      });
      if (a.firstEver) this.firstTimers++;
      this.alerts.markSeen(a.userId);
    }
    this.agg.setRoomTotals({
      peakViewers: t.peakViewers,
      roomTotalLikes: t.roomTotalLikes,
      observedLikes: t.observedLikes,
      diamonds: t.diamonds,
      heartMe: t.heartMe,
      comments: t.comments,
      newFollowers: t.newFollowers,
      shares: t.shares,
      uniqueViewers: t.uniqueViewers,
      firstTimers: t.firstTimers,
    });
  }

  /**
   * Drops the cached record for one viewer so the next row they produce reflects
   * a memo or よみがな just saved. Without this, writing a note mid-stream has no
   * visible effect until the next broadcast — which reads as the feature not working.
   */
  invalidateMeta(userId: UserId): void {
    this.meta.delete(userId);
  }

  private metaOf(userId: UserId): ViewerMeta {
    let m = this.meta.get(userId);
    if (!m) {
      const card = this.deps.store.getRecallCard(userId, this.sessionId);
      m = card
        ? {
            vipTier: card.vipTier,
            visits: card.visits,
            firstEver: card.visits === 0,
            prevVisitMs: card.prevVisitMs ?? undefined,
            diamondsLifetime: card.diamondsLifetime,
            heartMeLifetime: card.heartMeLifetime,
            likesLifetime: card.likesLifetime,
            readingKana: card.readingKana ?? undefined,
            note: card.note ?? undefined,
          }
        : { vipTier: 0, visits: 0, firstEver: true };
      this.meta.set(userId, m);
      if (m.firstEver) this.firstTimers++;
    }
    return m;
  }

  private onEvent(e: NormalizedEvent): void {
    // DB first — the record is the product; the UI is a view of it.
    this.batcher.push(e);

    if ('viewer' in e) {
      const m = this.metaOf(e.viewer.userId);
      this.agg.observe(e, { firstEver: m.firstEver, vipTier: m.vipTier, visits: m.visits });
      this.feed.add(e, {
        vipTier: m.vipTier,
        firstEver: m.firstEver,
        vis: m.visits,
        pv: m.prevVisitMs,
        dl: m.diamondsLifetime,
        ll: m.likesLifetime,
        hl: m.heartMeLifetime,
        kana: m.readingKana,
        note: m.note,
      });
      this.alerts.consider(e, this.sessionId, m.vipTier, m.firstEver);
    } else {
      this.agg.observe(e);
    }

    // カウントダウンチャレンジ — DB に書かない第5の消費者。フォロー/ギフトの
    // 増減は 2Hz tick を待たず即時に配る(モニターの演出が遅れると企画が死ぬ)。
    if (this.deps.challenge.handleEvent(e)) this.pushDelta(false);

    if (e.kind === 'roomControl' && (e.action === 'ended' || e.action === 'suspended')) {
      void this.stop(e.action === 'suspended' ? 'suspended' : 'streamEnd');
    }
  }

  /** チャレンジ操作(押下/開始/停止)の即時反映。タイマー停止中でも1回だけ delta を送る。 */
  nudgeChallenge(): void {
    this.pushDelta(false);
  }

  private setStatus(s: AdapterStatus): void {
    this.status = s;
    this.deps.post({ t: 'status', status: s, sessionId: this.sessionId, quota: this.quota });
  }

  // ── push ──────────────────────────────────────────────────────────────────

  private pushDelta(full: boolean): void {
    // 接続していなくてもチャレンジ変化だけの delta は出す(モニターは常時表示)。
    const challenge = full ? this.deps.challenge.get() : this.deps.challenge.drainIfChanged();
    const { tick, viewers, deferred } = this.agg.drain();
    if (!full && viewers.length === 0 && deferred === 0 && this.sessionId == null && !challenge) return;

    // The meta cache holds exactly the distinct viewers observed this session, so
    // it is the live source for 観測ユニーク / 初見 — previously these were only
    // ever written to the database and always displayed as 0 during the stream.
    this.agg.countUnique(this.meta.size, this.firstTimers);

    const totals = { ...this.agg.totals };
    totals.elapsedMs = this.sessionStartMs ? Date.now() - this.sessionStartMs : 0;

    const missions = this.computeMissions();

    this.deps.post({
      t: 'delta',
      tick,
      atMs: Date.now(),
      sessionId: this.sessionId,
      totals,
      viewers,
      alerts: this.alerts.drain(),
      ...(missions ? { missions } : {}),
      ...(challenge ? { challenge } : {}),
      deferred,
    });
  }

  /** Only sent when a threshold state actually changes — not on every tick. */
  private computeMissions(): MissionProgress[] | null {
    try {
      const cfg = this.deps.getMissionConfig();
      const inputs = this.deps.store.getMissionInputs(cfg, this.sessionId);
      const list = evaluateMissions(cfg, inputs);
      const sig = list.map((m) => `${m.id}:${Math.round(m.current)}:${m.done ? 1 : 0}`).join('|');
      if (sig === this.lastMissions) return null;
      this.lastMissions = sig;
      return list;
    } catch {
      return null;
    }
  }

  private pushFeed(): void {
    const { tick, items, dropped } = this.feed.drain();
    if (items.length === 0 && dropped === 0) return;
    this.deps.post({ t: 'feed', tick, items, dropped });
  }

  // ── diagnostics ───────────────────────────────────────────────────────────

  get ingestStats(): Batcher['stats'] & { queue: number; capture: number } {
    return { ...this.batcher.stats, queue: this.batcher.queueLength, capture: this.capture.messages };
  }

  async refreshQuota(): Promise<QuotaInfo | null> {
    this.quota = (await this.adapter?.getQuota()) ?? this.quota;
    return this.quota;
  }
}
