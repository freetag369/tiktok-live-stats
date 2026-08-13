import { FEED_MAX_ITEMS } from '@shared/constants';
import type { NormalizedEvent } from '@shared/events';
import type { FeedItem, FeedViewerRecord } from '@shared/ipc';

/**
 * The comment/gift/join lane.
 *
 * `like` NEVER enters the feed — it is ~90 % of all message volume and there is
 * nothing to read in it. Likes exist only as aggregate deltas.
 *
 * When the room outruns the 4 Hz drain we drop the OLDEST items and report how
 * many, because a silently truncated feed reads as "nothing happened".
 */

/** Everything the lane needs to know about the person, resolved once per session. */
export interface FeedMeta extends FeedViewerRecord {
  vipTier: number;
  firstEver: boolean;
  canonical?: string | null;
}

export class Feed {
  private buf: FeedItem[] = [];
  private droppedSinceTick = 0;
  private tick = 0;

  reset(): void {
    this.buf = [];
    this.droppedSinceTick = 0;
  }

  add(e: NormalizedEvent, meta: FeedMeta): void {
    const item = toItem(e, meta);
    if (!item) return;
    this.buf.push(item);
    // Keep a couple of ticks' worth so a burst is smoothed rather than lost.
    const cap = FEED_MAX_ITEMS * 3;
    while (this.buf.length > cap) {
      this.buf.shift();
      this.droppedSinceTick++;
    }
  }

  drain(): { tick: number; items: FeedItem[]; dropped: number } {
    this.tick++;
    const items = this.buf.splice(0, FEED_MAX_ITEMS);
    const dropped = this.droppedSinceTick;
    this.droppedSinceTick = 0;
    return { tick: this.tick, items, dropped };
  }
}

function record(meta: FeedMeta): FeedViewerRecord {
  const r: FeedViewerRecord = { vis: meta.vis };
  if (meta.pv) r.pv = meta.pv;
  if (meta.dl) r.dl = meta.dl;
  if (meta.ll) r.ll = meta.ll;
  if (meta.hl) r.hl = meta.hl;
  if (meta.kana) r.kana = meta.kana;
  if (meta.note) r.note = meta.note;
  return r;
}

function toItem(e: NormalizedEvent, meta: FeedMeta): FeedItem | null {
  if (!('viewer' in e)) return null;
  const v = e.viewer;
  const n = v.nickname || v.displayId || v.userId;
  const rec = record(meta);

  switch (e.kind) {
    case 'comment': {
      // 初見の初コメント, VIP発言, 未回答の質問 all share the one lane and are
      // told apart by colour.
      const tri = e.isQuestion ? 'question' : meta.firstEver ? 'first' : meta.vipTier >= 1 ? 'vip' : undefined;
      return { k: 'c', id: e.msgId, u: v.userId, n, a: v.avatarUrl, txt: e.content, ts: e.tsMs, tri, vt: meta.vipTier, ...rec };
    }
    case 'gift':
      return {
        k: 'g',
        id: e.msgId,
        u: v.userId,
        n,
        a: v.avatarUrl,
        gift: e.giftName ?? e.giftId,
        icon: e.iconUrl,
        cnt: e.repeatCount,
        dia: e.diamonds,
        ts: e.tsMs,
        canon: meta.canonical ?? e.canonical,
        vt: meta.vipTier,
        ...rec,
      };
    case 'join':
      if (e.action !== 1) return null;
      return { k: 'j', id: e.msgId, u: v.userId, n, a: v.avatarUrl, ts: e.tsMs, first: meta.firstEver, vt: meta.vipTier, ...rec };
    case 'social':
      if (e.sub === 'other') return null;
      return { k: 'f', id: e.msgId, u: v.userId, n, a: v.avatarUrl, ts: e.tsMs, sub: e.sub, vt: meta.vipTier, ...rec };
    case 'sub':
      return { k: 'f', id: e.msgId, u: v.userId, n, a: v.avatarUrl, ts: e.tsMs, sub: 'sub', vt: meta.vipTier, ...rec };
    default:
      return null;
  }
}
