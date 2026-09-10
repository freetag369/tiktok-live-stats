import type { DatabaseSync } from 'node:sqlite';
import type { GiftOption } from '@shared/dto';

export function saveGiftOptions(db: DatabaseSync, target: string, rows: GiftOption[]): void {
  if (!rows.length) throw new Error('空の一覧では保存済みギフトを置き換えられません。');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM gift_picker_cache WHERE target = ?').run(target);
    const insert = db.prepare('INSERT INTO gift_picker_cache (target, gift_id, name, diamonds, icon_url, updated_ms) VALUES (?, ?, ?, ?, ?, ?)');
    for (const r of rows) insert.run(target, r.giftId, r.name, r.diamonds, r.iconUrl, r.updatedMs);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

export function listGiftOptions(db: DatabaseSync, target: string): GiftOption[] {
  const cached = db.prepare(`SELECT gift_id AS giftId, name, diamonds, icon_url AS iconUrl,
    updated_ms AS updatedMs FROM gift_picker_cache WHERE target = ?`).all(target) as unknown as GiftOption[];
  const rows = new Map(cached.map((r) => [r.giftId, { ...r, received: false, source: 'available' as GiftOption['source'] }]));
  // Only the small catalog is scanned, never the full gift_event history.
  const received = db.prepare(`SELECT gift_id AS giftId, name, diamond_count AS diamonds,
    icon_url AS iconUrl, last_seen_ms AS updatedMs FROM gift_catalog
    WHERE (name IS NOT NULL AND name <> '') OR diamond_count IS NOT NULL`).all() as unknown as GiftOption[];
  for (const r of received) {
    const c = rows.get(r.giftId);
    const latest = c && c.updatedMs > r.updatedMs ? c : r;
    rows.set(r.giftId, {
      giftId: r.giftId, name: latest.name || c?.name || r.name || '',
      diamonds: latest.diamonds ?? c?.diamonds ?? r.diamonds ?? 0,
      iconUrl: latest.iconUrl || c?.iconUrl || r.iconUrl || null,
      updatedMs: Math.max(c?.updatedMs ?? 0, r.updatedMs ?? 0),
      received: true, source: c ? 'both' : 'received',
    });
  }
  return [...rows.values()];
}
