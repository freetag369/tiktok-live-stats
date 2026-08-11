import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import { matchGiftClip, DEFAULT_CHALLENGE, DEFAULT_GIFT_CLIPS } from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { NormalizedEvent } from '@shared/events';

/**
 * 最上位ギフト16種の「名前 → canonical → 演出クリップ」の一本道を守るテスト。
 *
 * nameRules は「小文字化して完全一致 or 部分一致、先頭ルール勝ち」で評価される
 * (worker/store/apply.ts の resolveCanonical)。つまり順序を1行入れ替えるだけで
 *「ホワイトペガサス」が pegasus に、「TikTok Universe」が tiktok に化ける。
 * 出荷する resources/gift-aliases.default.json をそのまま読んで実DBに通し、
 * 順序事故を検出する。
 */

const ALIASES = JSON.parse(
  readFileSync(join(__dirname, '../../resources/gift-aliases.default.json'), 'utf8')
) as { idAliases: Record<string, string>; nameRules: Array<{ canonical: string; match: string[] }> };

const T0 = Date.UTC(2026, 7, 11, 12, 0, 0);

let dir: string;
let store: Store;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-clips-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, ALIASES);
});

afterEach(() => {
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const ctx = () => makeNormalizeCtx();

/** 1件のギフトイベント。giftId は名前ごとに変えて alias キャッシュの汚染を避ける。 */
function giftEvent(userId: string, giftId: string, name: string, diamonds: number): NormalizedEvent {
  const e = normalize(
    ctx(),
    'gift',
    {
      common: { msgId: `g-${giftId}`, createTime: String(T0 / 1000) },
      user: {
        id: userId,
        idStr: userId,
        displayId: `handle_${userId}`,
        nickname: `user${userId}`,
        secUid: `MS4wLjABAAAA${userId}`,
        badgeList: [],
      },
      giftId,
      repeatCount: 1,
      repeatEnd: 1,
      gift: { id: giftId, name, type: 1, diamondCount: diamonds },
    },
    T0
  );
  if (!e) throw new Error(`normalize returned null for ${name}`);
  return e;
}

/** ギフト名を1件流して、DB が解決した canonical を読み戻す。 */
function canonicalFor(name: string, giftId: string, diamonds = 30000): string | null {
  const sid = store.openSession({
    hostUserId: 'host1',
    hostUniqueId: 'me',
    roomId: `room-${giftId}`,
    startedMs: T0,
  }).sessionId;
  const userId = `u${giftId}`;
  store.applyBatch(sid, [giftEvent(userId, giftId, name, diamonds)]);
  const detail = store.getViewer(userId, sid);
  return detail?.giftTotals[0]?.canonical ?? null;
}

/** 実配信で出るギフト表示名 → 期待する canonical。 */
const CASES: Array<[name: string, canonical: string]> = [
  ['TikTok Universe', 'universe'],
  ['TikTok Universe+', 'universe_plus'],
  ['TikTok Stars', 'tiktok_stars'],
  ['ホワイトペガサス', 'white_pegasus'],
  ['ペガサス', 'pegasus'],
  ['ファイアフェニックス', 'fire_phoenix'],
  ['サンダーファルコン', 'thunder_falcon'],
  ['鯨と蜃気楼', 'whale_mirage'],
  ['アザラシとクジラ', 'seal_whale'],
  ["Adam's Dream", 'adams_dream'],
  ['獅子奮迅', 'lion_charge'],
  ['レオンとライオン', 'leon_lion'],
  ['クジラのサム', 'whale_sam'],
  ['ライオン', 'lion'],
  ['宮殿', 'palace'],
  ['ドラゴン', 'dragon'],
];

describe('gift-aliases: 最上位ギフトの名寄せ順序', () => {
  it.each(CASES)('「%s」→ %s', (name, expected) => {
    // giftId は名前から決定的に作る(実IDは言語/地域で変わるため使わない)。
    const giftId = String(900000 + CASES.findIndex((c) => c[0] === name));
    expect(canonicalFor(name, giftId)).toBe(expected);
  });

  it('部分一致の共食いが起きていない(具体的な規則が先に並んでいる)', () => {
    // ここが崩れると「ホワイトペガサス」が pegasus に、「レオンとライオン」が
    // lion に、「TikTok Universe」が tiktok に化ける。
    const idx = (c: string): number => ALIASES.nameRules.findIndex((r) => r.canonical === c);
    expect(idx('universe_plus')).toBeLessThan(idx('universe'));
    expect(idx('universe')).toBeLessThan(idx('tiktok'));
    expect(idx('tiktok_stars')).toBeLessThan(idx('tiktok'));
    expect(idx('white_pegasus')).toBeLessThan(idx('pegasus'));
    expect(idx('leon_lion')).toBeLessThan(idx('lion'));
    expect(idx('lion_charge')).toBeLessThan(idx('lion'));
  });

  it('16種すべてに既定のクリップ割り当てがある', () => {
    const assigned = new Set(DEFAULT_GIFT_CLIPS.map((c) => c.canonical));
    for (const [, canonical] of CASES) expect(assigned.has(canonical)).toBe(true);
  });
});

describe('matchGiftClip', () => {
  const cfg = (over: Partial<ChallengeConfig> = {}): ChallengeConfig => ({
    ...structuredClone(DEFAULT_CHALLENGE),
    ...over,
  });

  it('canonical 一致で専用クリップを返す', () => {
    expect(matchGiftClip(cfg(), { canonical: 'dragon', diamonds: 26999 })).toBe('dragon');
    expect(matchGiftClip(cfg(), { canonical: 'palace', diamonds: 20000 })).toBe('palace');
  });

  it('割り当ての無い canonical はダイヤ数の tier クリップに落ちる', () => {
    expect(matchGiftClip(cfg(), { canonical: 'rose', diamonds: 1 })).toBe('gift-t1');
    expect(matchGiftClip(cfg(), { canonical: 'rose', diamonds: 100 })).toBe('gift-t2');
    expect(matchGiftClip(cfg(), { canonical: 'rose', diamonds: 1000 })).toBe('gift-t3');
    expect(matchGiftClip(cfg(), { canonical: 'rose', diamonds: 5000 })).toBe('gift-t4');
  });

  it('canonical 不明(名寄せ未登録)でも tier クリップは出る', () => {
    expect(matchGiftClip(cfg(), { diamonds: 7000 })).toBe('gift-t4');
  });

  it("clip:'off' の割り当ては tier に落ちず「出さない」", () => {
    const c = cfg({ giftClips: [{ id: 'x', canonical: 'dragon', clip: 'off' }] });
    expect(matchGiftClip(c, { canonical: 'dragon', diamonds: 26999 })).toBeNull();
  });

  it('上から順に最初の一致を使う(重複した canonical は先勝ち)', () => {
    const c = cfg({
      giftClips: [
        { id: 'a', canonical: 'dragon', clip: 'palace' },
        { id: 'b', canonical: 'dragon', clip: 'dragon' },
      ],
    });
    expect(matchGiftClip(c, { canonical: 'dragon', diamonds: 100 })).toBe('palace');
  });

  it('fxClipsEnabled=false なら常に null', () => {
    const c = cfg({ fxClipsEnabled: false });
    expect(matchGiftClip(c, { canonical: 'dragon', diamonds: 26999 })).toBeNull();
    expect(matchGiftClip(c, { diamonds: 7000 })).toBeNull();
  });
});
