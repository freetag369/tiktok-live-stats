import { join } from 'node:path';
import {
  DELTA_MS,
  DELTA_MS_HIDDEN,
  FEED_MS,
  LIKE_SEEN_PRUNE_EVERY_MS,
  LIKE_SEEN_TTL_MS,
  MISSIONS_CHECK_MS,
} from '@shared/constants';
import type { AdapterStatus, EndReason, NormalizedEvent, QuotaInfo, TikTokAdapter, UserId } from '@shared/events';
import type { LiveMessage } from '@shared/ipc';
import type { MissionConfig, MissionProgress } from '@shared/dto';
import { evaluateMissions } from '@shared/missions';
import { pruneLiveRows } from '@shared/live-rows';
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
  /** 剪定(pruneMeta)用。最後にこの視聴者の行を作った時刻。 */
  lastSeenMs: number;
}

/**
 * meta キャッシュの剪定パラメータ。レンダラ側 liveStore の rows と同じ値 —
 * worker は単一スレッドで同期 sqlite と同居するため、耐久配信でヒープが
 * ユニーク視聴者数に比例して育つと GC 停止が press RPC / 2Hz delta を塞ぐ。
 * 剪定された常連が戻ると getRecallCard の同期 SQL が1回走る(初見と同じコスト)。
 */
const META_TTL_MS = 30 * 60_000;
const META_HARD_CAP = 20_000;

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
  /**
   * ミッション計算と like_seen 掃除の専用タイマー。どちらも同期SQLなので
   * pushDelta(= 押下の即時反映経路)から追い出してある。詳細は pushDelta の
   * コメントを参照。
   */
  private missionTimer: NodeJS.Timeout | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  /** missionTimer が計算して置いておく、次の delta に載せる分。 */
  private pendingMissions: MissionProgress[] | null = null;
  private hidden = false;

  private meta = new Map<UserId, ViewerMeta>();
  /**
   * 観測ユニーク / 初見のカウンタ。meta.size を表示に使うと剪定で数字が減って
   * しまうため、ID 集合とカウンタを meta のライフサイクルから分離してある。
   * seenIds は ID 文字列だけ(ViewerMeta より1桁以上軽い)なので剪定しない。
   */
  private seenIds = new Set<UserId>();
  private uniqueViewers = 0;
  /** Distinct viewers seen this session whose very first visit this is. */
  private firstTimers = 0;
  private sessionStartMs = 0;
  private lastMissions = '';
  private lastMissionsCheckMs = 0;
  private lastLikeSeenPruneMs = 0;

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
      try {
        this.capture.start(join(this.deps.userDataDir, 'captures'), { uniqueId: clean });
      } catch (e) {
        // デバッグ記録が作れなくても(書込不可のフォルダ等)配信の記録は続ける。
        this.deps.store.recordConnectLog('error', `capture: ${(e as Error).message}`);
      }
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
    // 終了後のチャレンジ nudge delta で elapsedMs が伸び続けないようにする。
    this.sessionStartMs = 0;
    // モニターの全画面ランキングは配信が終わったら畳む(下部の TOP3 が sessionId
    // で自動的に消えるのと揃える)。**冒頭で stopTimers() 済み = 2Hz tick はもう
    // 止まっている**ので、ここで自分から1回配らないとモニターに永久に残る。
    // 自動再接続はこの stop を通らないので、瞬断でランキングが消えることはない。
    if (this.deps.challenge.hideRank()) this.pushDelta(false);
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
    this.seenIds.clear();
    this.uniqueViewers = 0;
    this.firstTimers = 0;
    this.lastMissions = '';
    // 停止を跨いで持ち越すと、次の配信の最初の delta に前回のミッションが載る。
    this.pendingMissions = null;
    this.sessionStartMs = 0;
  }

  private startTimers(): void {
    this.stopTimers();
    this.deltaTimer = setInterval(() => this.pushDelta(false), this.hidden ? DELTA_MS_HIDDEN : DELTA_MS);
    this.deltaTimer.unref?.();
    // 同期SQL を持つ2つは押下経路から独立させる(pushDelta のコメント参照)。
    // 変化があった tick にだけ載る規約は変わらない — computeMissions が
    // 署名比較で null を返した場合は pendingMissions を上書きしない。
    this.missionTimer = setInterval(() => {
      this.pendingMissions = this.computeMissions() ?? this.pendingMissions;
    }, MISSIONS_CHECK_MS);
    this.missionTimer.unref?.();
    this.pruneTimer = setInterval(() => {
      this.pruneLikeSeen();
      this.pruneMeta();
    }, LIKE_SEEN_PRUNE_EVERY_MS);
    this.pruneTimer.unref?.();
    if (!this.hidden) {
      this.feedTimer = setInterval(() => this.pushFeed(), FEED_MS);
      this.feedTimer.unref?.();
    }
  }

  private stopTimers(): void {
    if (this.deltaTimer) clearInterval(this.deltaTimer);
    if (this.feedTimer) clearInterval(this.feedTimer);
    if (this.missionTimer) clearInterval(this.missionTimer);
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.deltaTimer = null;
    this.feedTimer = null;
    this.missionTimer = null;
    this.pruneTimer = null;
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
      this.safeStop(s.reason);
      return;
    }

    this.setStatus(s);
    // renderer は 'live' 受信で resetLive() し、その瞬間に保留中だった challenge
    // パッチを失いうる(drainIfChanged は dirty を1回しか返さない)。status の
    // 直後に全量 delta を1発配って、両窓とも必ず最新スナップショットへ揃える。
    // postMessage は順序保証されるので「'live' → reset → 全量」の順になる。
    if (s.state === 'live') this.pushDelta(true);
  }

  private hydrateTotals(sessionId: number): void {
    const t = this.deps.store.getSessionTotals(sessionId);
    if (!t) return;
    this.sessionStartMs = t.startedMs;

    // Restore the roster so 観測ユニーク does not restart at zero and regulars are
    // not re-announced as fresh arrivals after a reconnect.
    this.meta.clear();
    this.seenIds.clear();
    this.uniqueViewers = 0;
    this.firstTimers = 0;
    const now = Date.now();
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
        lastSeenMs: now,
      });
      this.seenIds.add(a.userId);
      this.uniqueViewers++;
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
      const now = Date.now();
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
            lastSeenMs: now,
          }
        : { vipTier: 0, visits: 0, firstEver: true, lastSeenMs: now };
      this.meta.set(userId, m);
      // 剪定後の再訪・invalidateMeta 後の再取得でユニーク/初見を二重加算しない。
      if (!this.seenIds.has(userId)) {
        this.seenIds.add(userId);
        this.uniqueViewers++;
        if (m.firstEver) this.firstTimers++;
      }
    } else {
      m.lastSeenMs = Date.now();
    }
    return m;
  }

  private onEvent(e: NormalizedEvent): void {
    // ライブ経路の normalize は canonical(ギフト名寄せ)を付けない。付けずに配る
    // と heartMe のライブ集計が常に 0 になり、DB の値と食い違う。
    if (e.kind === 'gift' && e.canonical === undefined) {
      try {
        e.canonical = this.deps.store.resolveGiftCanonical(e.giftId, e.giftName) ?? undefined;
      } catch {
        /* 名寄せ失敗でイベントを落とさない */
      }
    }
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
      this.safeStop(e.action === 'suspended' ? 'suspended' : 'streamEnd');
    }
  }

  /**
   * fire-and-forget の stop。closeSession(採点込み)が throw すると unhandled
   * rejection → プロセスのクラッシュハンドラが DB を閉じてしまうため、必ず捕捉する。
   */
  private safeStop(reason: EndReason): void {
    void this.stop(reason).catch((err) => {
      try {
        this.deps.store.recordConnectLog('error', `stop: ${(err as Error).message}`);
      } catch {
        /* DB 自体が落ちている場合は諦める */
      }
      this.setStatus({ state: 'ended', reason });
    });
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

    // 観測ユニーク / 初見 のライブ値。meta.size ではなく専用カウンタを読む —
    // meta は pruneMeta で剪定されるため、size を使うと配信中に数字が減る。
    this.agg.countUnique(this.uniqueViewers, this.firstTimers);

    const totals = { ...this.agg.totals };
    totals.elapsedMs = this.sessionStartMs ? Date.now() - this.sessionStartMs : 0;

    // 押下(nudgeChallenge)もこの経路を通る。ここで同期SQL を走らせると、その分
    // だけ challenge.press の応答が遅れる — worker は単一スレッドで node:sqlite
    // も同期なので、クエリ実行中は後続の RPC メッセージが配送すらされない。
    // ミッション計算(7日窓の COUNT(DISTINCT) 込み5クエリ)と like_seen の一括
    // DELETE は独立タイマーへ追い出し、ここでは計算済みの結果を読むだけにする。
    const missions = this.pendingMissions;
    this.pendingMissions = null;

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
    // セッション外では計算しない(従来は delta 自体が出なかった状況)。チャレンジの
    // nudge delta にゼロリセットされたミッションを相乗りさせないため。
    if (this.sessionId == null) return null;
    // チャレンジのボタン連打が pushDelta を高頻度で呼んでも、同期 SQL
    // (getMissionInputs = 7日間ウィンドウの COUNT(DISTINCT) 込み5クエリ)の
    // 実行は3秒間隔に抑える。ミッションは分単位で動く数字なので体感差はない。
    const t = Date.now();
    if (t - this.lastMissionsCheckMs < 3000) return null;
    this.lastMissionsCheckMs = t;
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

  /** 配信中10分ごと — like_seen の30分より古い行を捨て、耐久配信での肥大を止める。 */
  private pruneLikeSeen(): void {
    if (this.sessionId == null) return;
    const now = Date.now();
    if (now - this.lastLikeSeenPruneMs < LIKE_SEEN_PRUNE_EVERY_MS) return;
    this.lastLikeSeenPruneMs = now;
    try {
      this.deps.store.pruneLikeSeen(now - LIKE_SEEN_TTL_MS);
    } catch {
      /* 掃除の失敗で配信を止めない */
    }
  }

  /**
   * 配信中10分ごと — 30分動きの無い視聴者の meta を捨てる。耐久配信で meta が
   * ユニーク視聴者数に比例して育つと、単一スレッド worker の GC 停止が伸びて
   * press RPC / 2Hz delta(= モニターの演出)が引っかかる。表示値は seenIds /
   * uniqueViewers / firstTimers が持つので剪定しても減らない。
   */
  private pruneMeta(): void {
    pruneLiveRows(this.meta, Date.now(), META_TTL_MS, META_HARD_CAP);
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
