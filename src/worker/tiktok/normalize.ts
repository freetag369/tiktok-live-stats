import type { NormViewer, NormalizedEvent } from '@shared/events';
import { normaliseTs } from '@shared/time';
import { counterMsgId, idStr, numOr, pickUrl, str, synthMsgId } from './ids';

/**
 * Raw v3 protobuf -> NormalizedEvent. Every field-name trap in the project lives
 * in this file and nowhere else.
 *
 * The library emits the decoded protobuf VERBATIM — it does no renaming — and its
 * README documents the older v1 names. Copying README snippets produces a
 * database full of NULL with no runtime error. Verified against the shipped
 * tiktok-live-proto@0.2.4 .d.ts:
 *
 *   user.uniqueId      does NOT exist  -> user.displayId (and it is MUTABLE)
 *   chat.comment       does NOT exist  -> chat.content
 *   like.likeCount     does NOT exist  -> like.count   (per-user, this batch)
 *   like.totalLikeCount does NOT exist -> like.total   (room-wide, this stream)
 *   gift.giftDetails   does NOT exist  -> gift.gift.{name,type,diamondCount}
 *   repeatEnd is a NUMBER, not a boolean
 */

export interface NormalizeCtx {
  seq: number;
  /** Counts events we had to key by counter — reconnect may duplicate those. */
  unstableKeys: number;
}

export function makeNormalizeCtx(): NormalizeCtx {
  return { seq: 0, unstableKeys: 0 };
}

type Any = Record<string, any>;

function viewerOf(u: Any | undefined, identity?: Any): NormViewer | null {
  if (!u) return null;
  const userId = idStr(u.idStr) || idStr(u.id);
  if (!userId) return null;
  const v: NormViewer = { userId };
  const sec = str(u.secUid);
  if (sec) v.secUid = sec;
  const disp = str(u.displayId);
  if (disp) v.displayId = disp;
  const nick = str(u.nickname);
  if (nick) v.nickname = nick;
  const avatar = pickUrl(u.avatarThumb) || pickUrl(u.avatarMedium);
  if (avatar) v.avatarUrl = avatar;
  if (identity) {
    v.isModerator = identity.isModeratorOfAnchor === true;
    v.isSubscriber = identity.isSubscriberOfAnchor === true;
    v.isFollower = identity.isFollowerOfAnchor === true;
  }
  const badges = Array.isArray(u.badgeList) ? (u.badgeList as Any[]) : [];
  for (const b of badges) {
    const scene = numOr(b?.sceneType, -1);
    const lvl = numOr(b?.combine?.level ?? b?.image?.level ?? b?.text?.level, 0);
    if (scene === 8 && lvl) v.gifterLevel = lvl;
    if (scene === 10 && lvl) v.fansClubLevel = lvl;
  }
  return v;
}

function ts(data: Any, now: number): { tsMs: number; source: 'server' | 'local'; serverTs: number | null } {
  const raw = data?.common?.createTime ?? data?.common?.clientSendTime;
  const r = normaliseTs(raw, now);
  return { tsMs: r.ts, source: r.source, serverTs: r.source === 'server' ? r.ts : null };
}

function baseOf(
  ctx: NormalizeCtx,
  data: Any,
  type: string,
  userId: string,
  now: number,
  content?: string,
  extra?: string
): { msgId: string; tsMs: number; tsSource: 'server' | 'local'; seq: number } {
  const t = ts(data, now);
  const given = str(data?.common?.msgId);
  let msgId: string;
  if (given && given !== '0') {
    msgId = given;
  } else if (t.serverTs != null || content || extra) {
    msgId = synthMsgId({ type, userId, serverTsMs: t.serverTs, content, extra });
  } else {
    ctx.unstableKeys++;
    msgId = counterMsgId(type, userId, ctx.seq);
  }
  return { msgId, tsMs: t.tsMs, tsSource: t.source, seq: ctx.seq++ };
}

/**
 * Returns null when the message carries no usable information, or when it is a
 * mid-streak gift (see below). Callers must treat null as "skip", not "error".
 */
export function normalize(ctx: NormalizeCtx, libType: string, data: Any, now = Date.now()): NormalizedEvent | null {
  switch (libType) {
    case 'member': {
      const v = viewerOf(data.user);
      if (!v) return null;
      const action = numOr(data.action, 0);
      const b = baseOf(ctx, data, 'member', v.userId, now, '', String(action));
      const e: NormalizedEvent = { ...b, kind: 'join', viewer: v, action };
      const src = str(data.clientEnterSource);
      if (src) (e as { enterSource?: string }).enterSource = src;
      return e;
    }

    case 'chat': {
      const v = viewerOf(data.user, data.userIdentity);
      if (!v) return null;
      const content = str(data.content);
      const b = baseOf(ctx, data, 'chat', v.userId, now, content);
      // スタンプ(サブスクエモート)。実データでは `emotes: [{ index, emote: { emoteId } }]`
      // の形で届く(スタンプだけのメッセージは content が ' ')。emotesList は
      // ライブラリ世代違いの保険。出現順・重複込みで載せる(個数トリガーの材料)。
      const rawEmotes = (data.emotes ?? data.emotesList) as unknown;
      const emoteIds = Array.isArray(rawEmotes)
        ? rawEmotes
            .map((x) => idStr((x as Any)?.emote?.emoteId ?? (x as Any)?.emoteId))
            .filter((id) => id !== '')
        : [];
      return {
        ...b,
        kind: 'comment',
        viewer: v,
        content,
        lang: str(data.contentLanguage) || undefined,
        isQuestion: false,
        ...(emoteIds.length > 0 ? { emoteIds } : {}),
      };
    }

    case 'questionNew': {
      // The question payload nests the details one level deeper.
      const q = (data.questionDetails ?? data.details ?? data) as Any;
      const v = viewerOf(q.user ?? data.user, data.userIdentity);
      if (!v) return null;
      const content = str(q.questionText ?? q.text ?? data.content);
      const b = baseOf(ctx, data, 'questionNew', v.userId, now, content);
      return { ...b, kind: 'comment', viewer: v, content, isQuestion: true };
    }

    case 'like': {
      const v = viewerOf(data.user);
      if (!v) return null;
      const count = numOr(data.count, 0);
      const total = numOr(data.total, NaN);
      // createTime は秒粒度なので、同一秒に同じ count・同じ total の like が
      // 2通来ると合成キーが衝突して2通目が重複扱いで捨てられる。clientSendTime
      // (ms粒度・メッセージ固有・リプレイでも同値)を材料に足して分離する。
      const b = baseOf(ctx, data, 'like', v.userId, now, String(count), `${idStr(data.total)}:${idStr(data?.common?.clientSendTime)}`);
      return {
        ...b,
        kind: 'like',
        viewer: v,
        count,
        roomTotal: Number.isFinite(total) ? total : undefined,
      };
    }

    case 'gift': {
      const v = viewerOf(data.user, data.userIdentity);
      if (!v) return null;
      const gift = (data.gift ?? {}) as Any;
      const giftType = gift.type == null ? undefined : numOr(gift.type, 0);

      // Streakable gifts (type 1) emit one message per tick with repeatEnd = 0 and
      // a final one with repeatEnd = 1 carrying the full repeatCount. Counting the
      // intermediates multiplies every combo. NOTE repeatEnd is a NUMBER — the
      // idiomatic `=== false` check is always false and silently counts everything.
      if (giftType === 1 && !numOr(data.repeatEnd, 0)) return null;

      const repeatCount = Math.max(1, numOr(data.repeatCount, 1));
      const diamondEach = Math.max(0, numOr(gift.diamondCount, 0));
      const giftId = idStr(gift.id) || idStr(data.giftId);
      const groupId = idStr(data.groupId);
      const b = baseOf(ctx, data, 'gift', v.userId, now, giftId, `${groupId}:${repeatCount}`);

      return {
        ...b,
        kind: 'gift',
        viewer: v,
        giftId,
        giftName: str(gift.name) || undefined,
        giftType,
        iconUrl: pickUrl(gift.icon) || pickUrl(gift.image) || undefined,
        repeatCount,
        diamondEach,
        diamonds: diamondEach * repeatCount,
        groupId: groupId || undefined,
        toUserId: idStr(data.toUser?.idStr) || idStr(data.toUser?.id) || undefined,
        isBoxGift: gift.isBoxGift === true || data.isAssetBundleGift === true || data.giftsInBox != null,
      };
    }

    case 'follow':
    case 'share':
    case 'social': {
      const v = viewerOf(data.user);
      if (!v) return null;
      const rawKey = str(data.common?.displayText?.key);
      // The library `return`s early on follow/share, so a handler on `social`
      // alone never sees them — all three are subscribed, and the kind is decided
      // here from the event name first, the i18n key second.
      let sub: 'follow' | 'share' | 'other';
      if (libType === 'follow') sub = 'follow';
      else if (libType === 'share') sub = 'share';
      else if (rawKey.includes('follow')) sub = 'follow';
      else if (rawKey.includes('share')) sub = 'share';
      else sub = 'other';
      const b = baseOf(ctx, data, libType, v.userId, now, sub, rawKey);
      return { ...b, kind: 'social', viewer: v, sub, rawKey: rawKey || undefined };
    }

    case 'subNotify':
    case 'superFan':
    case 'superFanJoin': {
      const v = viewerOf(data.user);
      if (!v) return null;
      const months = numOr(data.subMonth ?? data.months, 0) || undefined;
      const b = baseOf(ctx, data, libType, v.userId, now, libType, String(months ?? ''));
      return { ...b, kind: 'sub', viewer: v, sub: libType as 'subNotify' | 'superFan' | 'superFanJoin', months };
    }

    case 'envelope': {
      const info = (data.envelopeInfo ?? data.envelope ?? {}) as Any;
      const senderUserId = idStr(info.sendUserId ?? info.senderUserId ?? data.user?.idStr);
      const envelopeId = idStr(info.envelopeId ?? info.id);
      if (!senderUserId || !envelopeId) return null;
      const b = baseOf(ctx, data, 'envelope', senderUserId, now, envelopeId);
      return {
        ...b,
        kind: 'envelope',
        senderUserId,
        envelopeId,
        diamonds: Math.max(0, numOr(info.diamondCount, 0)),
        peopleCount: numOr(info.peopleCount, 0) || undefined,
      };
    }

    case 'emote': {
      const v = viewerOf(data.user);
      if (!v) return null;
      // 全件を出現順で拾う(チャット添付と同じくスタンプトリガーの材料)。
      // emoteId(先頭1件)は既存呼び出しの後方互換のため残す。
      const list = (data.emoteList ?? []) as Any[];
      const emoteIds = list
        .map((x) => idStr(x?.emote?.emoteId ?? x?.emoteId))
        .filter((id: string) => id !== '');
      const emoteId = emoteIds[0] ?? '';
      const b = baseOf(ctx, data, 'emote', v.userId, now, emoteId);
      return {
        ...b,
        kind: 'emote',
        viewer: v,
        emoteId: emoteId || undefined,
        ...(emoteIds.length > 0 ? { emoteIds } : {}),
      };
    }

    case 'roomUser': {
      const b = baseOf(ctx, data, 'roomUser', 'room', now, idStr(data.totalUser), idStr(data.total));
      // `total` is wire field 3 — the same field the v1 schema named `viewerCount`
      // — and it is the concurrent count shown in the TikTok app.
      // `totalUser` (field 7) is CUMULATIVE: measured against a real room it
      // climbed 11,635 -> 12,219 over 15 minutes and never meaningfully fell.
      // Using it as 同接 overstates the figure by orders of magnitude.
      const viewerCount = numOr(data.total, NaN);
      const totalViewers = numOr(data.totalUser, NaN);
      const contributors = (Array.isArray(data.ranks) ? (data.ranks as Any[]) : [])
        .map((c, i) => {
          const v = viewerOf(c?.user);
          return v ? { viewer: v, score: idStr(c.score), rank: numOr(c.rank, i + 1) } : null;
        })
        .filter((x): x is { viewer: NormViewer; score: string; rank: number } => x != null);
      return {
        ...b,
        kind: 'roomStats',
        viewerCount: Number.isFinite(viewerCount) ? viewerCount : undefined,
        totalViewers: Number.isFinite(totalViewers) ? totalViewers : undefined,
        anonymous: numOr(data.anonymous, 0) || undefined,
        popularity: numOr(data.popularity, 0) || undefined,
        topContributors: contributors.length ? contributors : undefined,
      };
    }

    case 'controlMessage': {
      const action = numOr(data.action, 0);
      const map: Record<number, 'paused' | 'unpaused' | 'ended' | 'suspended'> = {
        1: 'paused',
        2: 'unpaused',
        3: 'ended',
        4: 'suspended',
      };
      const mapped = map[action];
      if (!mapped) return null;
      const b = baseOf(ctx, data, 'controlMessage', 'room', now, String(action));
      return { ...b, kind: 'roomControl', action: mapped };
    }

    default: {
      const b = baseOf(ctx, data, libType, 'room', now, libType, String(ctx.seq));
      return { ...b, kind: 'unknown', libType };
    }
  }
}

/** Event names we normalise into something meaningful; everything else is counted as unknown. */
export const HANDLED_EVENTS = [
  'chat',
  'member',
  'gift',
  'like',
  'social',
  'follow',
  'share',
  'roomUser',
  'emote',
  'envelope',
  'subNotify',
  'superFan',
  'superFanJoin',
  'questionNew',
  'controlMessage',
] as const;
