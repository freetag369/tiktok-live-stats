import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Store } from '../../src/worker/store/index';
import { makeNormalizeCtx, normalize } from '../../src/worker/tiktok/normalize';
import {
  matchGiftMini,
  miniForSlot,
  CHALLENGE_BAND_BGM_IDS,
  CHALLENGE_FX_CLIP_IDS,
  DEFAULT_CHALLENGE,
  DEFAULT_GIFT_BAND_FX,
} from '@shared/challenge';
import type { ChallengeConfig } from '@shared/dto';
import type { NormalizedEvent } from '@shared/events';

/**
 * 最上位ギフトの「名前 → canonical」の名寄せと、帯域カットイン素材の整合を守るテスト。
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
});

describe('ダイヤ帯域カットイン(gift-band1〜4)の素材と登録の整合', () => {
  // renderer/lib/fx.ts は mp4 を import するため node 環境では読み込めない。
  // 代わりに「validate が許す id 一覧」と「実ファイルの存在」を突き合わせる —
  // FX_CLIPS 側の登録漏れは validate で 'off' に倒されてもビルドは通ってしまうが、
  // ファイルが無ければ import でビルドが落ちるので、この2点で片側ずつ守れる。
  const BAND_DIR = join(__dirname, '../../src/renderer/assets/fx/band');

  it('既定バンドのクリップ id はすべて CHALLENGE_FX_CLIP_IDS に登録されている', () => {
    for (const b of DEFAULT_GIFT_BAND_FX.bands) {
      expect(CHALLENGE_FX_CLIP_IDS).toContain(b.clip);
    }
  });

  it('gift-band1〜4 の mp4 が実在する(fx.ts の import が解決できる)', () => {
    for (const id of ['gift-band1', 'gift-band2', 'gift-band3', 'gift-band4']) {
      expect(existsSync(join(BAND_DIR, `${id}.mp4`)), `${id}.mp4 が無い`).toBe(true);
    }
  });

  it('既定バンドの BGM id はすべて CHALLENGE_BAND_BGM_IDS に登録されている', () => {
    for (const b of DEFAULT_GIFT_BAND_FX.bands) {
      expect(CHALLENGE_BAND_BGM_IDS).toContain(b.bgm);
    }
  });

  it('bgm-band1〜4 の mp3 が実在する(bgm.ts の import が解決できる)', () => {
    const BGM_DIR = join(__dirname, '../../src/renderer/assets/se/band');
    for (const id of CHALLENGE_BAND_BGM_IDS) {
      expect(existsSync(join(BGM_DIR, `${id}.mp3`)), `${id}.mp3 が無い`).toBe(true);
    }
  });

  it('既定バンドは要件どおりの帯域と秒数(1-50/6s, 51-100/6s, 101-600/8s, 601-1000/10s)', () => {
    expect(
      DEFAULT_GIFT_BAND_FX.bands.map((b) => [b.min, b.max, b.durationSec])
    ).toEqual([
      [1, 50, 6],
      [51, 100, 6],
      [101, 600, 8],
      [601, 1000, 10],
    ]);
    expect(DEFAULT_GIFT_BAND_FX.overflow).toBe('top');
    expect(DEFAULT_GIFT_BAND_FX.excludeGiftIds).toContain('7934'); // ハートミー除外
  });
});

describe('matchGiftMini / miniForSlot — 簡易演出の割り当て', () => {
  const cfg = (over: Partial<ChallengeConfig> = {}): ChallengeConfig => ({
    ...structuredClone(DEFAULT_CHALLENGE),
    ...over,
  });

  it('ギフトはダイヤ数の tier スロットで決まる', () => {
    expect(matchGiftMini(cfg(), { diamonds: 1 })).toBe('stamp'); // gift-t1
    expect(matchGiftMini(cfg(), { diamonds: 100 })).toBeNull(); // gift-t2 は off
    expect(matchGiftMini(cfg(), { diamonds: 5000 })).toBeNull(); // gift-t4 は off
  });

  it('tier スロットを変えるとその段階のギフト全体に効く', () => {
    const c = cfg({ miniFx: { ...DEFAULT_CHALLENGE.miniFx, 'gift-t4': 'shock' } });
    expect(matchGiftMini(c, { diamonds: 9999 })).toBe('shock');
    expect(matchGiftMini(c, { diamonds: 1 })).toBe('stamp'); // 他の tier は影響を受けない
  });

  it('フォローといいねはスロットから引く', () => {
    expect(miniForSlot(cfg(), 'follow')).toBe('panic');
    expect(miniForSlot(cfg(), 'like')).toBe('shock');
    expect(miniForSlot(cfg(), 'press')).toBeNull(); // 既定 off
  });

  it('miniFxEnabled=false なら常に null', () => {
    const c = cfg({ miniFxEnabled: false });
    expect(matchGiftMini(c, { diamonds: 1 })).toBeNull();
    expect(miniForSlot(c, 'follow')).toBeNull();
  });
});
