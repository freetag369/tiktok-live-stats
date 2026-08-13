import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import type { CsvExportSpec } from '@shared/dto';
import type { NormalizedEvent } from '@shared/events';

/**
 * 回帰テスト: CSV エクスポート5種の実行。
 *
 * かつて exportCsv は SQL が参照しない名前付きパラメータを常にバインドしており、
 * node:sqlite の「未参照キー拒否」で viewers / sessions / agencyMonthly の3種が
 * **必ず** ERR_INVALID_STATE で失敗していた(テストが無かったため未発見)。
 */

let dir: string;
let store: Store;

const ALIASES = {
  idAliases: { '7934': 'heart_me' },
  nameRules: [{ canonical: 'heart_me', match: ['heart me'] }],
};

const T0 = Date.UTC(2026, 6, 28, 12, 0, 0);
const ctx = () => makeNormalizeCtx();

function u(id: string, nick = `user${id}`) {
  return { id, idStr: id, displayId: `handle_${id}`, nickname: nick, secUid: `MS4wLjABAAAA${id}`, badgeList: [] };
}

function ev(kind: string, data: Record<string, unknown>, at = T0): NormalizedEvent {
  const e = normalize(ctx(), kind, { common: { createTime: String(Math.floor(at / 1000)) }, ...data }, at);
  if (!e) throw new Error(`normalize returned null for ${kind}`);
  return e;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-csv-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, ALIASES);

  const sid = store.openSession({ hostUserId: 'host1', hostUniqueId: 'me', roomId: 'room-1', startedMs: T0 }).sessionId;
  store.applyBatch(sid, [
    ev('chat', { common: { msgId: 'c1', createTime: String(T0 / 1000) }, user: u('6885748734620038153'), content: 'こんばんは' }),
    ev('gift', {
      common: { msgId: 'g1', createTime: String(T0 / 1000) },
      user: u('6885748734620038153'),
      giftId: '5655',
      repeatCount: 2,
      repeatEnd: 1,
      gift: { id: '5655', name: 'Rose', type: 1, diamondCount: 1 },
    }),
  ]);
  store.closeSession(sid, { endedMs: T0 + 30 * 60_000, reason: 'streamEnd' });
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

describe('exportCsv — all kinds', () => {
  const KINDS: Array<{ spec: CsvExportSpec; minRows: number }> = [
    { spec: { kind: 'viewers' }, minRows: 1 },
    { spec: { kind: 'comments' }, minRows: 1 },
    { spec: { kind: 'gifts' }, minRows: 1 },
    { spec: { kind: 'sessions' }, minRows: 1 },
    { spec: { kind: 'agencyMonthly' }, minRows: 1 },
  ];

  for (const { spec, minRows } of KINDS) {
    it(`${spec.kind}: フィルタ無しで実行できる`, () => {
      const out = join(dir, `${spec.kind}.csv`);
      const rows = store.exportCsv(spec, out);
      expect(rows).toBeGreaterThanOrEqual(minRows);
      const text = readFileSync(out, 'utf8');
      expect(text.charCodeAt(0)).toBe(0xfeff); // BOM — 日本語Windows の Excel 対策
      expect(text.split('\r\n').length).toBeGreaterThan(1);
    });
  }

  it('comments: sessionId / 期間フィルタつきでも実行できる', () => {
    const out = join(dir, 'comments-filtered.csv');
    const rows = store.exportCsv({ kind: 'comments', sessionId: 1, fromMs: T0 - 1, toMs: T0 + 1 }, out);
    expect(rows).toBe(1);
  });

  it('sessions / agencyMonthly: 期間フィルタつきでも実行できる', () => {
    expect(store.exportCsv({ kind: 'sessions', fromMs: T0 - 1 }, join(dir, 's1.csv'))).toBe(1);
    expect(store.exportCsv({ kind: 'agencyMonthly', fromMs: T0 - 1, toMs: T0 + 1 }, join(dir, 's2.csv'))).toBe(1);
  });

  it('int64 の user_id は Excel が丸めない ="…" 形式で出る', () => {
    const out = join(dir, 'viewers.csv');
    store.exportCsv({ kind: 'viewers' }, out);
    const text = readFileSync(out, 'utf8');
    expect(text).toContain('"=""6885748734620038153"""');
    // 生の 19 桁がそのまま数値セルとして出ていないこと(丸め事故の再発防止)。
    expect(text).not.toMatch(/(^|,)6885748734620038153(,|\r\n)/);
  });

  it('未知の kind はファイルを作る前に throw する', () => {
    const out = join(dir, 'bogus.csv');
    expect(() => store.exportCsv({ kind: 'bogus' } as unknown as CsvExportSpec, out)).toThrow(/unknown export kind/);
    expect(existsSync(out)).toBe(false);
  });
});
