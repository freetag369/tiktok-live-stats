import type { NormViewer, NormalizedEvent, UserId } from '@shared/events';
import type { JoinAlertCard } from '@shared/ipc';
import type { Store } from './store/index';

/**
 * 入室アラート.
 *
 * TikTok's own 入室通知 scrolls away in an instant, which is exactly why regulars
 * go ungreeted. This surfaces the recall aid — name, よみがな, 前回来店日, メモ,
 * 累計💎 — so the streamer can say 「〇〇さんいらっしゃい、この前の〇〇どうでした？」.
 */
/**
 * レイド時でもキューが無限に育たない上限。レンダラは12枚しか保持しないので、
 * これを超えた分は最古から捨てても表示上の損失は無い。
 */
const QUEUE_CAP = 60;

export class Alerts {
  private seen = new Set<UserId>();
  private queue: JoinAlertCard[] = [];

  /** 上限つき push — 溢れたら最古(=もう画面に出る見込みの薄い)カードを落とす。 */
  private enqueue(card: JoinAlertCard): void {
    this.queue.push(card);
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP);
  }

  constructor(
    private readonly store: Store,
    /** 0 = everyone (noisy), 1 = 常連以上 (default), 2 = VIP以上. */
    public minTier = 1,
    /**
     * Diamonds at or above which a gift gets its own card instead of a one-line
     * feed entry. A 4,888-diamond gift scrolling past as a single grey row is a
     * thank-you the streamer will never give.
     */
    public giftAlertDiamonds = 100
  ) {}

  reset(): void {
    this.seen.clear();
    this.queue = [];
  }

  /** Suppresses an alert for someone already recorded in a resumed session. */
  markSeen(userId: UserId): void {
    this.seen.add(userId);
  }

  consider(e: NormalizedEvent, sessionId: number | null, vipTier: number, firstEver: boolean): void {
    if (e.kind === 'gift') {
      if (e.diamonds < this.giftAlertDiamonds) return;
      const g = e.viewer;
      const base = this.store.getRecallCard(g.userId, sessionId) ?? this.synthesize(g, vipTier);
      this.enqueue({
        ...base,
        kind: 'gift',
        atMs: e.tsMs,
        gift: {
          name: e.giftName ?? e.giftId,
          iconUrl: e.iconUrl,
          count: e.repeatCount,
          diamonds: e.diamonds,
          canonical: e.canonical,
        },
      });
      return;
    }

    if (e.kind !== 'join' || e.action !== 1) return;
    const v = e.viewer;
    // Once per viewer per session — a re-entry is not a new arrival.
    if (this.seen.has(v.userId)) return;

    // 初見さん are always worth surfacing: ignoring them is the single most cited
    // cause of churn in Japanese liver coaching material.
    if (!firstEver && vipTier < this.minTier) {
      this.seen.add(v.userId);
      return;
    }
    this.seen.add(v.userId);

    // A first-time viewer has no row yet — the batcher writes 250 ms behind the
    // event stream, and a brand-new viewer has never been written at all. Looking
    // the card up and giving up on a miss silently killed the 初見アラート, which
    // is the single feature this panel exists for. Synthesize from the event.
    //
    // 初見は最初から合成に直行する — 履歴が無い相手に相関サブクエリ付きの
    // getRecallCard を取り込みホットパスで撃つのはレイド時の同期SQL爆弾になる。
    const card = firstEver
      ? this.synthesize(v, vipTier)
      : (this.store.getRecallCard(v.userId, sessionId) ?? this.synthesize(v, vipTier));
    this.enqueue({ ...card, kind: 'join', atMs: e.tsMs });
  }

  /** Minimal card built from the event itself, for viewers not yet in the database. */
  private synthesize(v: NormViewer, vipTier: number): Omit<JoinAlertCard, 'kind' | 'atMs'> {
    return {
      userId: v.userId,
      nickname: v.nickname ?? v.displayId ?? v.userId,
      displayId: v.displayId ?? '',
      avatarUrl: v.avatarUrl ?? null,
      readingKana: null,
      note: null,
      vipTier,
      visits: 0,
      prevVisitMs: null,
      diamondsLifetime: 0,
      heartMeLifetime: 0,
      lastComments: [],
      isFirstEver: true,
    };
  }

  /** At most 5 per tick so a raid cannot bury the panel. */
  drain(max = 5): JoinAlertCard[] {
    return this.queue.splice(0, max);
  }
}
