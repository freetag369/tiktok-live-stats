import { describe, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  webClient: { roomId: '' },
  fetchRoomId: vi.fn(async () => 'room'),
  fetchAvailableGifts: vi.fn(),
}));
vi.mock('tiktok-live-connector', () => ({ TikTokLiveConnection: vi.fn(function () { return client; }) }));
import { fetchGiftOptions, normalizeGiftOptions } from '../../src/worker/tiktok/gift-options';

describe('available gift adapter', () => {
  it('preserves same-name IDs, leading zeroes and large string IDs', () => {
    const rows = normalizeGiftOptions([
      { id: '0012', name: 'Hand Heart', diamond_count: 10, image: { url_list: ['https://example.com/gift.png'] } },
      { id: '90071992547409930', name: 'Hand Heart', diamond_count: 20 },
      { id: Number.MAX_SAFE_INTEGER + 1, name: 'unsafe', diamond_count: 20 },
    ], 123);
    expect(rows.map((r) => r.giftId)).toEqual(['0012', '90071992547409930']);
    expect(rows[0]?.iconUrl).toBe('https://example.com/gift.png');
    expect(rows[1]?.iconUrl).toBeNull();
    expect(rows.every((r) => !r.received && r.updatedMs === 123)).toBe(true);
  });
  it('rejects empty/invalid responses and untrusted image schemes', () => {
    for (const raw of [[], {}, null, [{ id: '1', name: 'bad', diamond_count: -1 }]]) {
      expect(() => normalizeGiftOptions(raw, 1)).toThrow();
    }
    expect(normalizeGiftOptions([{ id: 1, name: 'Rose', diamond_count: 1, image: { url_list: ['file:///private.png'] } }], 1)[0]?.iconUrl).toBeNull();
  });
  it('uses the current room over resolution and propagates network errors', async () => {
    client.fetchRoomId.mockClear();
    client.fetchAvailableGifts.mockResolvedValueOnce([{ id: '42', name: 'Rose', diamond_count: 1 }]);
    expect((await fetchGiftOptions('host', 'active-room'))[0]?.giftId).toBe('42');
    expect(client.webClient.roomId).toBe('active-room');
    expect(client.fetchRoomId).not.toHaveBeenCalled();
    client.fetchAvailableGifts.mockRejectedValueOnce(new Error('network unavailable'));
    await expect(fetchGiftOptions('host')).rejects.toThrow('network unavailable');
    expect(client.fetchRoomId).toHaveBeenCalledOnce();
  });
});
