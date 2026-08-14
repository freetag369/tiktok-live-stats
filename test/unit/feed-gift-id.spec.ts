import { describe, expect, it } from 'vitest';
import { Feed, type FeedMeta } from '@worker/feed';
import type { NormalizedEvent } from '@shared/events';

const META: FeedMeta = { vipTier: 0, firstEver: false, vis: 1 };

function giftEvent(over: Partial<Extract<NormalizedEvent, { kind: 'gift' }>> = {}) {
  return {
    kind: 'gift',
    msgId: 'm1',
    tsMs: 1_700_000_000_000,
    viewer: { userId: 'u1', displayId: 'someone', nickname: 'Someone' },
    giftId: '76637',
    giftName: 'おやすみトッポ',
    repeatCount: 1,
    diamonds: 1,
    ...over,
  } as Extract<NormalizedEvent, { kind: 'gift' }>;
}

describe('ライブフィードの gid(お助けの対象 giftId を配信中に拾うための値)', () => {
  it('ギフト行に生の giftId が載る', () => {
    const f = new Feed();
    f.add(giftEvent(), META);
    const item = f.drain().items[0]!;
    expect(item.k).toBe('g');
    expect(item.k === 'g' ? item.gid : null).toBe('76637');
  });

  it('ギフト名が無くても gid は ID のまま(表示用の gift とは別物)', () => {
    const f = new Feed();
    f.add(giftEvent({ giftName: undefined }), META);
    const item = f.drain().items[0]!;
    if (item.k !== 'g') throw new Error('gift item を期待');
    // 表示用の gift は名前が無いと ID に落ちるが、gid は常に ID。
    expect(item.gift).toBe('76637');
    expect(item.gid).toBe('76637');
  });

  it('名前がある場合も gid は名前に引きずられない', () => {
    const f = new Feed();
    f.add(giftEvent({ giftName: 'Rose', giftId: '5655' }), META);
    const item = f.drain().items[0]!;
    if (item.k !== 'g') throw new Error('gift item を期待');
    expect(item.gift).toBe('Rose');
    expect(item.gid).toBe('5655');
  });
});
