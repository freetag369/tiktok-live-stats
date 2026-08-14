import type { DatabaseSync } from 'node:sqlite';
import { JOIN_DEBOUNCE_MS, LAST_JOIN_PRUNE_AT, LIKE_BUCKET_MS, SESSION_METRIC_MS } from '@shared/constants';
import type { BatchResult } from '@shared/dto';
import type { NormViewer, NormalizedEvent, UserId } from '@shared/events';
import { SQL, type Statements } from './statements';

export interface ApplyCtx {
  db: DatabaseSync;
  st: Statements;
  /** Loaded once at open(), invalidated on block/unblock. Checking per event with a SELECT would be a needless hot-path read. */
  blocked: Set<UserId>;
  /** (sessionId:userId) -> last counted join, so an app-switch re-entry is not a new visit. */
  lastJoinMs: Map<string, number>;
  /** Throttles session_metric to one row per SESSION_METRIC_MS. */
  lastMetricMs: number;
  /**
   * The room-wide like total only ever arrives on `like` events, never on the
   * roomUser message that writes session_metric — so without carrying it here the
   * timeline's like curve is NULL for every row ever recorded.
   */
  lastRoomLikes: number | null;
  /** Resolves a giftId to a canonical family; misses fall back to the name rules. */
  giftAlias: Map<string, string>;
  nameRules: Array<{ canonical: string; match: string[] }>;
}

export function makeCtx(db: DatabaseSync, st: Statements): ApplyCtx {
  return {
    db,
    st,
    blocked: new Set(),
    lastJoinMs: new Map(),
    lastMetricMs: 0,
    lastRoomLikes: null,
    giftAlias: new Map(),
    nameRules: [],
  };
}

/** Upsert identity + ensure the lifetime row + touch the per-session row. */
function touchViewer(ctx: ApplyCtx, sessionId: number, v: NormViewer, ts: number): { firstEver: boolean } {
  const { st } = ctx;
  const prev = st.get(SQL.selectViewerIdentity).get(v.userId) as { display_id: string; nickname: string } | undefined;

  st.get(SQL.upsertViewer).run(
    v.userId,
    v.secUid ?? '',
    v.displayId ?? '',
    v.nickname ?? '',
    v.avatarUrl ?? '',
    v.isModerator ? 1 : 0,
    v.isSubscriber ? 1 : 0,
    ts,
    ts,
    ts
  );

  const nowDisplay = v.displayId ?? prev?.display_id ?? '';
  const nowNick = v.nickname ?? prev?.nickname ?? '';
  if (!prev || prev.display_id !== nowDisplay || prev.nickname !== nowNick) {
    st.get(SQL.insertIdentityHistory).run(v.userId, nowDisplay, nowNick, ts);
  }

  st.get(SQL.ensureLifetime).run(v.userId, ts, ts);

  // Read visits BEFORE any increment — 初見 is latched on the first row for this
  // session and never recomputed, or every historical session would retroactively
  // mark the viewer as 初見.
  const lt = st.get(SQL.selectLifetimeVisits).get(v.userId) as { visits: number } | undefined;
  const firstEver = (lt?.visits ?? 0) === 0;

  const changes = st.get(SQL.insertVss).run(sessionId, v.userId, ts, ts, firstEver ? 1 : 0).changes;
  if (Number(changes) > 0) {
    st.get(SQL.bumpSession('unique_viewers')).run(1, sessionId);
    if (firstEver) st.get(SQL.bumpSession('first_timers')).run(1, sessionId);
    // Attending at all counts as a visit; MEMBER events are throttled by TikTok
    // on busy rooms, so keying 来店回数 off join events alone would undercount badly.
    st.get(SQL.markLifetimeVisit).run(sessionId, sessionId, ts, ts, v.userId);
  } else {
    st.get(SQL.touchVssSeen).run(ts, sessionId, v.userId);
    st.get(SQL.touchLifetimeSeen).run(ts, v.userId);
  }
  return { firstEver };
}

function bump(ctx: ApplyCtx, sessionId: number, userId: UserId, col: string, n: number): void {
  ctx.st.get(SQL.bumpVss(col)).run(n, sessionId, userId);
  ctx.st.get(SQL.bumpLifetime(col)).run(n, userId);
}

export function resolveCanonical(ctx: ApplyCtx, giftId: string, giftName: string | undefined): string | null {
  const cached = ctx.giftAlias.get(giftId);
  if (cached) return cached;
  const row = ctx.st.get(SQL.selectGiftAlias).get(giftId) as { canonical: string } | undefined;
  if (row) {
    ctx.giftAlias.set(giftId, row.canonical);
    return row.canonical;
  }
  // Auto-register by normalised name, so a new localized Heart Me id self-heals
  // instead of silently reporting zero for the product's headline metric.
  const n = (giftName ?? '').trim().toLowerCase();
  if (!n) return null;
  for (const rule of ctx.nameRules) {
    if (rule.match.some((m) => n === m || n.includes(m))) {
      ctx.st.get(SQL.upsertGiftAlias).run(giftId, rule.canonical);
      ctx.giftAlias.set(giftId, rule.canonical);
      return rule.canonical;
    }
  }
  return null;
}

/**
 * One event -> rows. Called inside the batch transaction; never opens its own.
 * Returns false when the event was dropped (blocked viewer).
 */
export function applyEvent(ctx: ApplyCtx, sessionId: number, e: NormalizedEvent, res: BatchResult): void {
  const { st } = ctx;

  if (e.kind === 'unknown') {
    st.get(SQL.bumpUnknown).run(e.libType, e.tsMs, e.tsMs);
    if (!res.unhandled.includes(e.libType)) res.unhandled.push(e.libType);
    return;
  }

  if (e.kind === 'roomStats') {
    if (e.viewerCount != null) st.get(SQL.setSessionPeak).run(e.viewerCount, sessionId);
    if (e.totalViewers != null) st.get(SQL.setSessionTotalViewers).run(e.totalViewers, sessionId);
    if (e.roomTotalLikes != null) {
      ctx.lastRoomLikes = e.roomTotalLikes;
      st.get(SQL.setSessionRoomLikes).run(e.roomTotalLikes, sessionId);
    }
    if (e.tsMs - ctx.lastMetricMs >= SESSION_METRIC_MS) {
      ctx.lastMetricMs = e.tsMs;
      st.get(SQL.insertMetric).run(
        sessionId,
        e.tsMs,
        e.viewerCount ?? null,
        e.roomTotalLikes ?? ctx.lastRoomLikes,
        e.totalViewers ?? null
      );
    }
    // Top contributors carry full user objects — cheap identity refresh.
    for (const c of e.topContributors ?? []) {
      if (!ctx.blocked.has(c.viewer.userId)) touchViewer(ctx, sessionId, c.viewer, e.tsMs);
    }
    res.applied++;
    return;
  }

  if (e.kind === 'roomControl') {
    st.get(SQL.insertConnectLog).run(e.tsMs, 'roomControl', e.action);
    res.applied++;
    return;
  }

  if (e.kind === 'envelope') {
    if (ctx.blocked.has(e.senderUserId)) {
      res.droppedBlocked++;
      return;
    }
    const changes = st.get(SQL.insertEnvelope).run(e.envelopeId, sessionId, e.senderUserId, e.tsMs, e.diamonds, e.peopleCount ?? null).changes;
    if (Number(changes) === 0) {
      res.ignoredDuplicates++;
      return;
    }
    // The envelope message carries no user object, so only attribute if we know them.
    const known = st.get('SELECT 1 AS x FROM viewer WHERE user_id = ?').get(e.senderUserId);
    if (known) {
      // 既知だが今セッションの vss 行がまだ無い(過去配信からの常連が今回未入室)
      // 場合、bump が 0行更新で静かに消えてセッション合計とだけ乖離する。
      // touchViewer と同じ流儀で行を確保してから加算する。
      st.get(SQL.ensureLifetime).run(e.senderUserId, e.tsMs, e.tsMs);
      const vssNew = Number(st.get(SQL.insertVss).run(sessionId, e.senderUserId, e.tsMs, e.tsMs, 0).changes) > 0;
      if (vssNew) {
        st.get(SQL.bumpSession('unique_viewers')).run(1, sessionId);
        st.get(SQL.markLifetimeVisit).run(sessionId, sessionId, e.tsMs, e.tsMs, e.senderUserId);
      }
      bump(ctx, sessionId, e.senderUserId, 'diamonds', e.diamonds);
      st.get(SQL.bumpSession('diamonds')).run(e.diamonds, sessionId);
    }
    res.applied++;
    return;
  }

  const v = 'viewer' in e ? e.viewer : null;
  if (!v) return;
  if (ctx.blocked.has(v.userId)) {
    res.droppedBlocked++;
    return;
  }

  touchViewer(ctx, sessionId, v, e.tsMs);

  switch (e.kind) {
    case 'join': {
      // action 3 is SUBSCRIBED, not a room entry.
      if (e.action === 3) {
        const c = st.get(SQL.insertSub).run(e.msgId, sessionId, v.userId, e.tsMs, 'memberSubscribed', null).changes;
        if (Number(c) === 0) {
          res.ignoredDuplicates++;
          return;
        }
        st.get(SQL.setVssFlag('subscribed')).run(sessionId, v.userId);
        res.applied++;
        return;
      }
      const c = st.get(SQL.insertJoin).run(e.msgId, sessionId, v.userId, e.tsMs, e.action, e.enterSource ?? null).changes;
      if (Number(c) === 0) {
        res.ignoredDuplicates++;
        return;
      }
      // Debounce re-entries so 入室 counts stay meaningful.
      //
      // 判定に使うのは「直近 JOIN_DEBOUNCE_MS 以内か」だけなので、それより古い
      // エントリは二度と読まれない純粋なゴミ。5時間の耐久配信では入室ユニーク数
      // ぶん(数万件)まで無制限に育つので、たまに掃く。閾値を超えたときだけ回すので
      // 通常の join では追加コストが乗らない。
      if (ctx.lastJoinMs.size > LAST_JOIN_PRUNE_AT) {
        const cutoff = e.tsMs - JOIN_DEBOUNCE_MS;
        for (const [k, t] of ctx.lastJoinMs) if (t < cutoff) ctx.lastJoinMs.delete(k);
      }
      const key = `${sessionId}:${v.userId}`;
      const last = ctx.lastJoinMs.get(key) ?? -Infinity;
      if (e.tsMs - last >= JOIN_DEBOUNCE_MS) {
        ctx.lastJoinMs.set(key, e.tsMs);
        st.get(SQL.bumpVss('joins')).run(1, sessionId, v.userId);
      }
      res.applied++;
      return;
    }

    case 'comment': {
      const c = st
        .get(SQL.insertComment)
        .run(
          e.msgId,
          sessionId,
          v.userId,
          e.tsMs,
          e.content,
          e.lang ?? null,
          v.isModerator ? 1 : 0,
          v.isSubscriber ? 1 : 0,
          e.isQuestion ? 1 : 0
        ).changes;
      if (Number(c) === 0) {
        res.ignoredDuplicates++;
        return;
      }
      bump(ctx, sessionId, v.userId, 'comments', 1);
      st.get(SQL.bumpSession('comments')).run(1, sessionId);
      res.applied++;
      return;
    }

    case 'like': {
      if (e.count <= 0) return;
      // Bucketed likes are an accumulator, so replaying the same message adds
      // again. This gate is what makes reconnect safe for the firehose.
      if (Number(st.get(SQL.markLikeSeen).run(e.msgId, sessionId, e.tsMs).changes) === 0) {
        res.ignoredDuplicates++;
        return;
      }
      const bucket = e.tsMs - (e.tsMs % LIKE_BUCKET_MS);
      st.get(SQL.upsertLikeBucket).run(sessionId, v.userId, bucket, e.count);
      bump(ctx, sessionId, v.userId, 'likes', e.count);
      st.get(SQL.bumpSession('observed_likes')).run(e.count, sessionId);
      // `total` is room-wide and TikTok's own ground truth — never per-user.
      // Carried forward so the next session_metric row can record it.
      if (e.roomTotal != null) {
        ctx.lastRoomLikes = Math.max(ctx.lastRoomLikes ?? 0, e.roomTotal);
        st.get(SQL.setSessionRoomLikes).run(e.roomTotal, sessionId);
      }
      res.applied++;
      return;
    }

    case 'gift': {
      // gift_catalog first: gift_alias has an FK onto it and foreign_keys is ON.
      st.get(SQL.upsertGiftCatalog).run(
        e.giftId,
        e.giftName ?? '',
        e.diamondEach,
        e.giftType ?? null,
        e.iconUrl ?? '',
        e.tsMs,
        e.tsMs
      );
      const canonical = resolveCanonical(ctx, e.giftId, e.giftName);

      let changes = 0;
      try {
        changes = Number(
          st
            .get(SQL.insertGift)
            .run(
              e.msgId,
              sessionId,
              v.userId,
              e.tsMs,
              e.giftId,
              e.giftName ?? null,
              e.giftType ?? null,
              e.repeatCount,
              e.diamondEach,
              e.diamonds,
              e.groupId ?? null,
              e.toUserId ?? null,
              e.isBoxGift ? 1 : 0
            ).changes
        );
      } catch (err) {
        // The partial unique index on (session, user, group_id) is the backstop
        // against a streak that slipped past the repeatEnd check.
        if (/UNIQUE constraint failed/i.test(String((err as Error).message))) {
          res.ignoredDuplicates++;
          return;
        }
        throw err;
      }
      if (changes === 0) {
        res.ignoredDuplicates++;
        return;
      }

      bump(ctx, sessionId, v.userId, 'gifts', 1);
      bump(ctx, sessionId, v.userId, 'diamonds', e.diamonds);
      st.get(SQL.bumpSession('gifts')).run(1, sessionId);
      st.get(SQL.bumpSession('diamonds')).run(e.diamonds, sessionId);
      if (canonical === 'heart_me') {
        bump(ctx, sessionId, v.userId, 'heart_me', e.repeatCount);
        st.get(SQL.bumpSession('heart_me')).run(e.repeatCount, sessionId);
      }
      res.applied++;
      return;
    }

    case 'social': {
      const kind = e.sub === 'other' ? 'other' : e.sub;
      const c = st.get(SQL.insertSocial).run(e.msgId, sessionId, v.userId, e.tsMs, kind, e.rawKey ?? null).changes;
      if (Number(c) === 0) {
        res.ignoredDuplicates++;
        return;
      }
      if (kind === 'follow') {
        st.get(SQL.setVssFlag('followed')).run(sessionId, v.userId);
        st.get(SQL.bumpSession('new_followers')).run(1, sessionId);
      } else if (kind === 'share') {
        bump(ctx, sessionId, v.userId, 'shares', 1);
        st.get(SQL.bumpSession('shares')).run(1, sessionId);
      }
      res.applied++;
      return;
    }

    case 'sub': {
      const c = st.get(SQL.insertSub).run(e.msgId, sessionId, v.userId, e.tsMs, e.sub, e.months ?? null).changes;
      if (Number(c) === 0) {
        res.ignoredDuplicates++;
        return;
      }
      st.get(SQL.setVssFlag('subscribed')).run(sessionId, v.userId);
      res.applied++;
      return;
    }

    case 'emote':
      // Engagement signal only — touchViewer already refreshed last_seen.
      res.applied++;
      return;

    default:
      return;
  }
}
