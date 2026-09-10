import { TikTokLiveConnection } from 'tiktok-live-connector';
import type { GiftOption } from '@shared/dto';

/** Do not coerce IDs through Number: long IDs and leading zeroes must survive. */
export function normalizeGiftOptions(raw: unknown, updatedMs: number): GiftOption[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('ギフト一覧が空です。保存済みの一覧を使用してください。');
  const rows = new Map<string, GiftOption>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const g = item as Record<string, unknown>;
    if (typeof g.id !== 'string' && !(typeof g.id === 'number' && Number.isSafeInteger(g.id))) continue;
    const giftId = String(g.id);
    const diamonds = g.diamond_count ?? g.diamondCount;
    if (!/^\d+$/.test(giftId) || typeof g.name !== 'string' || !g.name.trim() ||
      typeof diamonds !== 'number' || !Number.isSafeInteger(diamonds) || diamonds < 0) continue;
    const image = (g.image ?? g.icon) as { url_list?: unknown; urlList?: unknown } | undefined;
    const urls = image?.url_list ?? image?.urlList;
    const iconUrl = Array.isArray(urls) ? urls.find((u: unknown) => typeof u === 'string' && /^https?:\/\//i.test(u)) as string | undefined : undefined;
    rows.set(giftId, { giftId, name: g.name, diamonds, iconUrl: iconUrl ?? null, received: false, source: 'available', updatedMs });
  }
  if (!rows.size) throw new Error('ギフト一覧の形式を読み取れませんでした。保存済みの一覧を使用してください。');
  return [...rows.values()];
}

export async function fetchGiftOptions(target: string, roomId?: string, apiKey?: string): Promise<GiftOption[]> {
  // Dedicated HTTP client: never connect/disconnect the active live connection.
  const connection = new TikTokLiveConnection(target, {
    enableExtendedGiftInfo: false,
    ...(apiKey ? { signApiKey: apiKey } : {}),
  });
  const request = async (): Promise<GiftOption[]> => {
    if (roomId) connection.webClient.roomId = roomId;
    else await connection.fetchRoomId();
    return normalizeGiftOptions(await connection.fetchAvailableGifts(), Date.now());
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([request(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('ギフト一覧の取得がタイムアウトしました。時間をおいて再試行してください。')), 55_000);
    })]);
  } finally { clearTimeout(timer); }

}
