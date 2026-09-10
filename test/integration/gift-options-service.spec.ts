import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { SessionManager } from '../../src/worker/session';
import { ChallengeEngine } from '../../src/worker/challenge';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { DEFAULT_MISSIONS } from '@shared/missions';
import type { GiftOption } from '@shared/dto';

const fetchGifts = vi.hoisted(() => vi.fn());
vi.mock('../../src/worker/tiktok/gift-options', () => ({ fetchGiftOptions: fetchGifts }));
let dir: string;
let store: Store;
let session: SessionManager;
const row: GiftOption = { giftId: '001', name: 'Test', diamonds: 1, iconUrl: null, updatedMs: 1, received: false, source: 'available' };
beforeEach(() => {
  fetchGifts.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'tls-gift-service-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'test.db') }, { idAliases: {}, nameRules: [] });
  const cfg = structuredClone(DEFAULT_CHALLENGE);
  session = new SessionManager({
    store, post: () => undefined, userDataDir: dir,
    getSettings: () => ({ eulerApiKey: '', captureDebug: false, alertMinTier: 3, giftAlertDiamonds: 100 }),
    getMissionConfig: () => DEFAULT_MISSIONS,
    challenge: new ChallengeEngine(() => cfg, Date.now, Math.random, Math.random, () => undefined),
  });
});
afterEach(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });

it('remembers first target, uses it offline, and prioritizes the live room', async () => {
  fetchGifts.mockResolvedValue([row]);
  expect((await session.refreshGiftOptions('@first')).target).toBe('first');
  expect(store.listGiftCatalog()).toEqual([]);
  await session.refreshGiftOptions('ignored');
  expect(fetchGifts).toHaveBeenLastCalledWith('first', undefined, '');
  session.status = { state: 'live', hostDisplayId: 'livehost', roomId: 'room', startedMs: 1 };
  expect((await session.refreshGiftOptions('ignored')).target).toBe('livehost');
  expect(fetchGifts).toHaveBeenLastCalledWith('livehost', 'room', '');
});

it('preserves stored metadata when fetching fails and allows a retry', async () => {
  store.setSetting('giftPicker.target', 'first');
  store.saveGiftOptions('first', [row]);
  fetchGifts.mockRejectedValueOnce(new Error('HTTP 403'));
  await expect(session.refreshGiftOptions()).rejects.toThrow('HTTP 403');
  expect(session.giftOptions().rows).toEqual([row]);
  fetchGifts.mockResolvedValueOnce([{ ...row, name: 'Updated' }]);
  expect((await session.refreshGiftOptions()).rows[0]?.name).toBe('Updated');
});

it('coalesces concurrent refreshes and cannot overwrite a newly selected live target', async () => {
  let finish!: (rows: GiftOption[]) => void;
  fetchGifts.mockImplementation(() => new Promise<GiftOption[]>((resolve) => { finish = resolve; }));
  store.setSetting('giftPicker.target', 'first');
  const pending = session.refreshGiftOptions();
  expect(session.refreshGiftOptions()).toBe(pending);
  expect(fetchGifts).toHaveBeenCalledOnce();
  session.status = { state: 'live', hostDisplayId: 'second', roomId: 'new-room', startedMs: 2 };
  store.setSetting('giftPicker.target', 'second');
  finish([row]);
  expect((await pending).target).toBe('second');
  expect(store.lastGiftTarget()).toBe('second');
  expect(store.listGiftOptions('first')).toEqual([row]);
});
