import { describe, expect, it } from 'vitest';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import type { CommentEvent, GiftEvent, JoinEvent, LikeEvent, SocialEvent } from '@shared/events';

/**
 * One assertion per row of the field-name trap table.
 *
 * The library README documents v1 names but emits v3 protobuf verbatim, so every
 * one of these would silently produce NULL columns if the normalizer used the
 * documented name. Verified against the shipped tiktok-live-proto@0.2.4 .d.ts.
 */

const NOW = Date.UTC(2026, 6, 28, 12, 0, 0);

function user(over: Record<string, unknown> = {}) {
  return {
    id: '7000000000000000001',
    idStr: '7000000000000000001',
    // NOTE: `uniqueId` does NOT exist on the v3 User message.
    displayId: 'taro_live',
    nickname: 'たろう',
    secUid: 'MS4wLjABAAAAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
    avatarThumb: { urlList: ['https://p16.tiktokcdn.com/a.webp'] },
    badgeList: [],
    ...over,
  };
}

function common(over: Record<string, unknown> = {}) {
  return { msgId: '1234567890', createTime: String(Math.floor(NOW / 1000)), ...over };
}

describe('normalize — identity', () => {
  it('uses user.id as the stable key and displayId as the (mutable) @handle', () => {
    const e = normalize(makeNormalizeCtx(), 'chat', { common: common(), user: user(), content: 'やっほー' }, NOW);
    const c = e as CommentEvent;
    expect(c.viewer.userId).toBe('7000000000000000001');
    expect(c.viewer.displayId).toBe('taro_live');
    expect(c.viewer.nickname).toBe('たろう');
  });

  it('keeps int64 ids as strings — parseInt would lose precision', () => {
    const e = normalize(makeNormalizeCtx(), 'chat', { common: common(), user: user(), content: 'x' }, NOW);
    expect(typeof (e as CommentEvent).viewer.userId).toBe('string');
    expect((e as CommentEvent).viewer.userId).toBe('7000000000000000001');
  });

  it('reads the avatar from avatarThumb.urlList[0], not profilePictureUrl', () => {
    const e = normalize(makeNormalizeCtx(), 'chat', { common: common(), user: user(), content: 'x' }, NOW);
    expect((e as CommentEvent).viewer.avatarUrl).toBe('https://p16.tiktokcdn.com/a.webp');
  });

  it('reads moderator/subscriber from userIdentity, not top-level booleans', () => {
    const e = normalize(
      makeNormalizeCtx(),
      'chat',
      {
        common: common(),
        user: user(),
        content: 'x',
        userIdentity: { isModeratorOfAnchor: true, isSubscriberOfAnchor: true },
      },
      NOW
    );
    expect((e as CommentEvent).viewer.isModerator).toBe(true);
    expect((e as CommentEvent).viewer.isSubscriber).toBe(true);
  });
});

describe('normalize — chat', () => {
  it('reads the text from `content`, not `comment`', () => {
    const e = normalize(makeNormalizeCtx(), 'chat', { common: common(), user: user(), content: 'こんばんは' }, NOW);
    expect((e as CommentEvent).content).toBe('こんばんは');
  });

  it('reads the language from contentLanguage', () => {
    const e = normalize(
      makeNormalizeCtx(),
      'chat',
      { common: common(), user: user(), content: 'x', contentLanguage: 'ja' },
      NOW
    );
    expect((e as CommentEvent).lang).toBe('ja');
  });
});

describe('normalize — like', () => {
  it('reads count/total, not likeCount/totalLikeCount', () => {
    const e = normalize(makeNormalizeCtx(), 'like', { common: common(), user: user(), count: 7, total: '12345' }, NOW);
    const l = e as LikeEvent;
    expect(l.count).toBe(7);
    expect(l.roomTotal).toBe(12345);
  });

  it('treats `total` as room-wide, never per-user (documented as the whole stream)', () => {
    const e = normalize(makeNormalizeCtx(), 'like', { common: common(), user: user(), count: 3, total: '999999' }, NOW);
    const l = e as LikeEvent;
    // Only `count` may ever be attributed to this viewer.
    expect(l.count).toBe(3);
    expect(l.roomTotal).toBe(999999);
  });
});

describe('normalize — gift streak dedupe', () => {
  const base = (repeatEnd: number, repeatCount: number) => ({
    common: common({ msgId: `g-${repeatCount}-${repeatEnd}` }),
    user: user(),
    giftId: '5655',
    repeatCount,
    // repeatEnd is a NUMBER in v3; `=== false` is always false and would count
    // every intermediate tick of a combo.
    repeatEnd,
    groupId: '17000001',
    gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 1, icon: { urlList: ['https://x/r.png'] } },
  });

  it('drops mid-streak events for streakable gifts (type 1)', () => {
    const ctx = makeNormalizeCtx();
    expect(normalize(ctx, 'gift', base(0, 1), NOW)).toBeNull();
    expect(normalize(ctx, 'gift', base(0, 2), NOW)).toBeNull();
    expect(normalize(ctx, 'gift', base(0, 3), NOW)).toBeNull();
  });

  it('keeps exactly the streak-final event with the full repeat count', () => {
    const e = normalize(makeNormalizeCtx(), 'gift', base(1, 4), NOW) as GiftEvent;
    expect(e).not.toBeNull();
    expect(e.repeatCount).toBe(4);
    expect(e.diamonds).toBe(4);
  });

  it('keeps non-streakable gifts immediately', () => {
    const d = base(0, 1);
    d.gift.type = 2;
    const e = normalize(makeNormalizeCtx(), 'gift', d, NOW) as GiftEvent;
    expect(e).not.toBeNull();
    expect(e.repeatCount).toBe(1);
  });

  it('reads name/type/diamondCount from gift.*, not giftDetails.*', () => {
    const e = normalize(makeNormalizeCtx(), 'gift', base(1, 2), NOW) as GiftEvent;
    expect(e.giftName).toBe('Rose');
    expect(e.giftType).toBe(1);
    expect(e.diamondEach).toBe(1);
    expect(e.diamonds).toBe(2);
    expect(e.iconUrl).toBe('https://x/r.png');
  });

  it('flags box gifts, whose diamond value is unreliable', () => {
    const d = base(1, 1);
    (d.gift as Record<string, unknown>).isBoxGift = true;
    expect((normalize(makeNormalizeCtx(), 'gift', d, NOW) as GiftEvent).isBoxGift).toBe(true);
  });
});

describe('normalize — member / social', () => {
  it('maps MemberMessageAction 1 to a join and 3 to a subscribe', () => {
    const j = normalize(makeNormalizeCtx(), 'member', { common: common(), user: user(), action: 1 }, NOW) as JoinEvent;
    expect(j.kind).toBe('join');
    expect(j.action).toBe(1);
    const s = normalize(makeNormalizeCtx(), 'member', { common: common({ msgId: 'm2' }), user: user(), action: 3 }, NOW);
    expect((s as JoinEvent).action).toBe(3);
  });

  it('distinguishes follow and share, which the library emits as separate events', () => {
    const f = normalize(makeNormalizeCtx(), 'follow', { common: common(), user: user() }, NOW) as SocialEvent;
    expect(f.sub).toBe('follow');
    const s = normalize(makeNormalizeCtx(), 'share', { common: common({ msgId: 's' }), user: user() }, NOW) as SocialEvent;
    expect(s.sub).toBe('share');
  });

  it('falls back to the i18n display key when the event name is generic', () => {
    const e = normalize(
      makeNormalizeCtx(),
      'social',
      { common: common({ displayText: { key: 'pm_main_follow_message_viewer_2' } }), user: user() },
      NOW
    ) as SocialEvent;
    expect(e.sub).toBe('follow');
  });
});

describe('normalize — roomUser', () => {
  it('takes 同接 from `total` (wire field 3) and the cumulative count from `totalUser`', () => {
    const e = normalize(
      makeNormalizeCtx(),
      'roomUser',
      {
        common: common(),
        total: '1200',
        totalUser: '34500',
        ranks: [{ user: user(), score: '900', rank: 1 }],
      },
      NOW
    );
    expect(e?.kind).toBe('roomStats');
    if (e?.kind === 'roomStats') {
      // `total` is the field v1 called `viewerCount`. Measured against a real
      // room, `totalUser` climbed monotonically for 15 minutes — it is a running
      // total of entries, not a concurrent figure, and using it as 同接
      // overstates the audience by an order of magnitude.
      expect(e.viewerCount).toBe(1200);
      expect(e.totalViewers).toBe(34500);
      // Contributor rank value is `score`, not `coinCount`.
      expect(e.topContributors?.[0]?.score).toBe('900');
    }
  });
});

describe('normalize — unknown events are counted, never dropped', () => {
  it('returns an unknown event for an unmapped type', () => {
    const e = normalize(makeNormalizeCtx(), 'WebcastSomethingNewMessage', { common: common() }, NOW);
    expect(e?.kind).toBe('unknown');
  });
});

describe('normalize — msgId determinism', () => {
  it('produces the same synthetic key for the same message on replay', () => {
    const payload = { common: { createTime: String(Math.floor(NOW / 1000)) }, user: user(), content: 'hi' };
    const a = normalize(makeNormalizeCtx(), 'chat', structuredClone(payload), NOW)!;
    const b = normalize(makeNormalizeCtx(), 'chat', structuredClone(payload), NOW + 5000)!;
    // Reconnect replays the backlog; a Date.now()-based key would differ here and
    // defeat the INSERT OR IGNORE dedupe the whole strategy rests on.
    expect(a.msgId).toBe(b.msgId);
    expect(a.msgId.startsWith('syn:')).toBe(true);
  });

  it('prefers the server-provided msgId when present', () => {
    const e = normalize(makeNormalizeCtx(), 'chat', { common: common({ msgId: '77' }), user: user(), content: 'x' }, NOW)!;
    expect(e.msgId).toBe('77');
  });
});
