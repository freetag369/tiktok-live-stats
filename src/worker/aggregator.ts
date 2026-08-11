import { DELTA_MAX_VIEWERS } from '@shared/constants';
import type { NormalizedEvent, UserId } from '@shared/events';
import { VF_FIRST, VF_MOD, VF_PRESENT, VF_REGULAR, VF_SUB, VF_VIP, type DeltaViewer, type LiveTotals } from '@shared/ipc';

interface Acc {
  d: number;
  c: number;
  l: number;
  g: number;
  h: number;
  n?: string;
  a?: string;
  di?: string;
  ls: number;
  flags: number;
}

/**
 * Coalesces the firehose into one 2 Hz message.
 *
 * The renderer never sees a per-event message: at 20k events/min that would be
 * ~330 postMessage calls per second and a permanently janky table. The worker
 * merges into a Map and the tick drains it.
 */
export class Aggregator {
  private dirty = new Map<UserId, Acc>();
  private tick = 0;

  totals: LiveTotals = emptyTotals();

  reset(): void {
    this.dirty.clear();
    this.totals = emptyTotals();
  }

  setRoomTotals(p: Partial<LiveTotals>): void {
    Object.assign(this.totals, p);
  }

  private acc(u: UserId): Acc {
    let a = this.dirty.get(u);
    if (!a) {
      a = { d: 0, c: 0, l: 0, g: 0, h: 0, ls: 0, flags: 0 };
      this.dirty.set(u, a);
    }
    return a;
  }

  observe(e: NormalizedEvent, extra?: { firstEver?: boolean; vipTier?: number; visits?: number }): void {
    if (!('viewer' in e)) {
      if (e.kind === 'roomStats') {
        if (e.viewerCount != null) {
          this.totals.viewers = e.viewerCount;
          if (e.viewerCount > this.totals.peakViewers) this.totals.peakViewers = e.viewerCount;
        }
        if (e.totalViewers != null) this.totals.totalViewers = Math.max(this.totals.totalViewers, e.totalViewers);
        if (e.roomTotalLikes != null) this.totals.roomTotalLikes = Math.max(this.totals.roomTotalLikes, e.roomTotalLikes);
      }
      return;
    }

    const v = e.viewer;
    const a = this.acc(v.userId);
    a.ls = Math.max(a.ls, e.tsMs);
    if (v.nickname) a.n = v.nickname;
    if (v.avatarUrl) a.a = v.avatarUrl;
    if (v.displayId) a.di = v.displayId;
    a.flags |= VF_PRESENT;
    if (v.isModerator) a.flags |= VF_MOD;
    if (v.isSubscriber) a.flags |= VF_SUB;
    if (extra?.vipTier != null && extra.vipTier >= 2) a.flags |= VF_VIP;
    if (extra?.vipTier === 1) a.flags |= VF_REGULAR;
    if (extra?.firstEver) a.flags |= VF_FIRST;

    switch (e.kind) {
      case 'comment':
        a.c += 1;
        this.totals.comments += 1;
        break;
      case 'like':
        a.l += e.count;
        this.totals.observedLikes += e.count;
        if (e.roomTotal != null) this.totals.roomTotalLikes = Math.max(this.totals.roomTotalLikes, e.roomTotal);
        break;
      case 'gift':
        a.g += 1;
        a.d += e.diamonds;
        this.totals.diamonds += e.diamonds;
        if (e.canonical === 'heart_me') {
          a.h += e.repeatCount;
          this.totals.heartMe += e.repeatCount;
        }
        break;
      case 'social':
        if (e.sub === 'follow') this.totals.newFollowers += 1;
        else if (e.sub === 'share') this.totals.shares += 1;
        break;
      default:
        break;
    }
  }

  /** Marks a gift as Heart Me after the store resolved the canonical family. */
  addHeartMe(userId: UserId, n: number): void {
    this.acc(userId).h += n;
    this.totals.heartMe += n;
  }

  countUnique(n: number, firstTimers: number): void {
    this.totals.uniqueViewers = n;
    this.totals.firstTimers = firstTimers;
  }

  /** Drains up to DELTA_MAX_VIEWERS entries; the remainder slides to the next tick. */
  drain(): { tick: number; viewers: DeltaViewer[]; deferred: number } {
    this.tick++;
    const out: DeltaViewer[] = [];
    let deferred = 0;
    for (const [u, a] of this.dirty) {
      if (out.length >= DELTA_MAX_VIEWERS) {
        deferred++;
        continue;
      }
      const dv: DeltaViewer = { u };
      if (a.d) dv.d = a.d;
      if (a.c) dv.c = a.c;
      if (a.l) dv.l = a.l;
      if (a.g) dv.g = a.g;
      if (a.h) dv.h = a.h;
      if (a.n) dv.n = a.n;
      if (a.a) dv.a = a.a;
      if (a.di) dv.di = a.di;
      if (a.ls) dv.ls = a.ls;
      if (a.flags) dv.flags = a.flags;
      out.push(dv);
      this.dirty.delete(u);
    }
    return { tick: this.tick, viewers: out, deferred };
  }
}

export function emptyTotals(): LiveTotals {
  return {
    viewers: null,
    peakViewers: 0,
    totalViewers: 0,
    roomTotalLikes: 0,
    observedLikes: 0,
    diamonds: 0,
    heartMe: 0,
    comments: 0,
    newFollowers: 0,
    shares: 0,
    uniqueViewers: 0,
    firstTimers: 0,
    elapsedMs: 0,
  };
}
