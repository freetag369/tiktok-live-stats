/**
 * The isolation boundary.
 *
 * Nothing outside `src/worker/tiktok/` may import `tiktok-live-connector` or
 * `tiktok-live-proto`. Swapping the library = rewriting adapter.ts + normalize.ts
 * and nothing else. This matters: the upstream author states verbatim that the
 * library "is not a production-ready API. It is a reverse engineering project."
 */

export type Ms = number;
/** int64 serialized as a JS string. NEVER parseInt — it loses precision. */
export type UserId = string;

export interface NormViewer {
  /** User.id (=== User.idStr). STABLE across streams, handle changes and renames. Primary key. */
  userId: UserId;
  /** Stable but ~75 chars and not present on every message. Never overwrite a stored value with ''. */
  secUid?: string;
  /** The @handle (wire field `display_id`). MUTABLE — TikTok allows a change every 30 days. */
  displayId?: string;
  /** Display name. MUTABLE — changeable roughly weekly. */
  nickname?: string;
  avatarUrl?: string;
  isModerator?: boolean;
  isSubscriber?: boolean;
  isFollower?: boolean;
  gifterLevel?: number;
  fansClubLevel?: number;
}

export interface EventBase {
  /** common.msgId, or a DETERMINISTIC synthetic key. The dedupe key for reconnect replay. */
  msgId: string;
  /** Normalised epoch ms — always plausible, never seconds, never undefined. */
  tsMs: Ms;
  tsSource: 'server' | 'local';
  /** Monotonic per connection; orders events inside one flush. */
  seq: number;
}

export type JoinEvent = EventBase & {
  kind: 'join';
  viewer: NormViewer;
  /** MemberMessageAction: 1 = JOINED, 3 = SUBSCRIBED. Only 1 counts as a visit. */
  action: number;
  enterSource?: string;
};

export type CommentEvent = EventBase & {
  kind: 'comment';
  viewer: NormViewer;
  content: string;
  lang?: string;
  isQuestion: boolean;
};

export type LikeEvent = EventBase & {
  kind: 'like';
  viewer: NormViewer;
  /** Likes in THIS batch from THIS user. TikTok exposes no per-user cumulative total anywhere. */
  count: number;
  /** Room-wide total for the stream — TikTok's own ground truth, not per-user. */
  roomTotal?: number;
};

export type GiftEvent = EventBase & {
  kind: 'gift';
  viewer: NormViewer;
  giftId: string;
  giftName?: string;
  giftType?: number;
  iconUrl?: string;
  repeatCount: number;
  diamondEach: number;
  /** diamondEach * repeatCount, precomputed once. Never recomputed downstream. */
  diamonds: number;
  groupId?: string;
  toUserId?: UserId;
  /** 'heart_me' | 'rose' | … — resolved via the alias table / name rule. */
  canonical?: string;
  /** Box/lucky gifts report ambiguous diamond values; flagged so totals can be qualified. */
  isBoxGift: boolean;
};

export type SocialEvent = EventBase & {
  kind: 'social';
  viewer: NormViewer;
  sub: 'follow' | 'share' | 'other';
  rawKey?: string;
};

export type SubEvent = EventBase & {
  kind: 'sub';
  viewer: NormViewer;
  sub: 'subNotify' | 'superFan' | 'superFanJoin' | 'memberSubscribed';
  months?: number;
};

export type EnvelopeEvent = EventBase & {
  kind: 'envelope';
  /** This message carries no `user` object — only a sender id. */
  senderUserId: UserId;
  envelopeId: string;
  diamonds: number;
  peopleCount?: number;
};

export type EmoteEvent = EventBase & { kind: 'emote'; viewer: NormViewer; emoteId?: string };

export type RoomStatsEvent = EventBase & {
  kind: 'roomStats';
  /** 同接 — concurrent viewers right now (wire field 3, v1's `viewerCount`). */
  viewerCount?: number;
  /** Cumulative viewers since the stream started (wire field 7, `totalUser`). */
  totalViewers?: number;
  roomTotalLikes?: number;
  anonymous?: number;
  popularity?: number;
  topContributors?: Array<{ viewer: NormViewer; score: string; rank: number }>;
};

export type RoomControlEvent = EventBase & {
  kind: 'roomControl';
  action: 'paused' | 'unpaused' | 'ended' | 'suspended';
};

/** Never dropped silently — a rising count here is how protocol drift becomes visible. */
export type UnknownEvent = EventBase & { kind: 'unknown'; libType: string };

export type NormalizedEvent =
  | JoinEvent
  | CommentEvent
  | LikeEvent
  | GiftEvent
  | SocialEvent
  | SubEvent
  | EnvelopeEvent
  | EmoteEvent
  | RoomStatsEvent
  | RoomControlEvent
  | UnknownEvent;

export type NormalizedEventKind = NormalizedEvent['kind'];

/** Events that carry a viewer we should upsert. */
export function viewerOf(e: NormalizedEvent): NormViewer | null {
  return 'viewer' in e ? e.viewer : null;
}

// ── Connection status ────────────────────────────────────────────────────────

export interface Quota {
  max: number;
  remaining: number;
  resetAt: number | null;
}
export interface QuotaInfo {
  hasApiKey: boolean;
  day?: Quota;
  hour?: Quota;
  minute?: Quota;
  fetchedMs: Ms;
}

export type AdapterStatus =
  | { state: 'idle' }
  | { state: 'resolving'; uniqueId: string }
  | { state: 'connecting'; uniqueId: string; attempt: number }
  | { state: 'live'; roomId: string; hostUserId?: UserId; hostDisplayId: string; startedMs: Ms }
  | { state: 'waitingOffline'; uniqueId: string; nextCheckMs: Ms; givesUpAtMs: Ms }
  | { state: 'reconnecting'; attempt: number; nextAttemptMs: Ms }
  | { state: 'rateLimited'; retryAfterMs: Ms; scope: 'minute' | 'hour' | 'day' | 'unknown' }
  | { state: 'blocked'; hint: string }
  | { state: 'error'; message: string; fatal: boolean }
  | { state: 'ended'; reason: EndReason };

export type EndReason =
  | 'streamEnd'
  | 'suspended'
  | 'userStopped'
  | 'lostConnection'
  | 'crash'
  | 'quotaGuard';

export interface AdapterSink {
  event(e: NormalizedEvent): void;
  status(s: AdapterStatus): void;
  /** Capture mode only — feeds the NDJSON fixture writer. */
  raw?(libType: string, decoded: unknown): void;
}

export interface ConnectOptions {
  uniqueId: string;
  signApiKey?: string;
  waitUntilLive: boolean;
  /** TikTok replays a buffered backlog on connect; false on reconnects avoids inflating counts. */
  processInitialData: boolean;
}

/**
 * Implemented twice: `adapter.ts` (real network) and `replay-adapter.ts` (NDJSON
 * fixture). The session FSM cannot tell them apart — that is the whole test strategy.
 */
export interface TikTokAdapter {
  connect(o: ConnectOptions): Promise<void>;
  disconnect(reason: string): Promise<void>;
  getQuota(): Promise<QuotaInfo | null>;
  readonly sink: AdapterSink;
}
