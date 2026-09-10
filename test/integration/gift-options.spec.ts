import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import type { GiftOption } from '@shared/dto';

let dir: string;
let store: Store;
const aliases = { idAliases: { '999': 'unverified' }, nameRules: [] };
const option = (giftId: string, name = 'Hand Heart'): GiftOption => ({
  giftId, name, diamonds: 10, iconUrl: 'https://example.com/gift.png', received: false, source: 'available', updatedMs: 1,
});
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-gift-options-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'test.db') }, aliases);
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

describe('gift options cache', () => {
  it('persists unseen gifts independently of received counts and isolates targets', () => {
    store.saveGiftOptions('a', [option('001'), option('2')]);
    store.saveGiftOptions('b', [option('3')]);
    store.setSetting('giftPicker.target', 'a');
    expect(store.listGiftCatalog()).toEqual([]);
    expect(store.listGiftOptions('a').map((r) => r.giftId)).toEqual(['001', '2']);
    expect(store.listGiftOptions('b').map((r) => r.giftId)).toEqual(['3']);
    store.close();
    store = new Store();
    store.open({ dbPath: join(dir, 'test.db') }, aliases);
    expect(store.lastGiftTarget()).toBe('a');
    expect(store.listGiftOptions('a')).toHaveLength(2);
  });
  it('merges received metadata by ID without duplicate cards or alias guesses', () => {
    store.saveGiftOptions('a', [option('12'), option('13')]);
    const sid = store.openSession({ hostUserId: 'h', hostUniqueId: 'a', roomId: 'r', startedMs: 1000 }).sessionId;
    const event = normalize(makeNormalizeCtx(), 'gift', {
      common: { msgId: '1', createTime: '2' }, user: { id: '1', idStr: '1', nickname: 'User' },
      giftId: '12', repeatCount: 2, repeatEnd: 1,
      gift: { id: '12', name: 'Received name', type: 1, diamondCount: 30 },
    }, 2000);
    if (!event) throw new Error('missing normalized gift');
    store.applyBatch(sid, [event]);
    const rows = store.listGiftOptions('a');
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.giftId === '12')).toMatchObject({ name: 'Received name', diamonds: 30, received: true, source: 'both', iconUrl: option('12').iconUrl });
    expect(store.listGiftCatalog()[0]).toMatchObject({ count: 1, totalDiamonds: 60 });
  });
  it('keeps the previous cache on empty data or transaction failure', () => {
    store.saveGiftOptions('a', [option('old')]);
    expect(() => store.saveGiftOptions('a', [])).toThrow();
    expect(() => store.saveGiftOptions('a', [option('duplicate'), option('duplicate')])).toThrow();
    expect(store.listGiftOptions('a').map((r) => r.giftId)).toEqual(['old']);
  });
});
