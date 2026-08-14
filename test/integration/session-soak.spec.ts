import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { DEFAULT_MISSIONS } from '@shared/missions';
import type { LiveMessage } from '@shared/ipc';
import { ChallengeEngine } from '../../src/worker/challenge';
import { SessionManager } from '../../src/worker/session';
import { Store } from '../../src/worker/store/index';

/**
 * レイド級レートのソーク(長時間配信の圧縮模擬)。
 *
 * ReplayAdapter(speed=0 = 全速)で 3 万イベント / 1 万ユニーク視聴者を
 * **実際の取り込み経路**(normalize → batcher/agg/feed/alerts/challenge →
 * 2Hz delta)へ流し込み、以下を固定する:
 *  - 観測ユニーク / 初見が正確(meta 剪定カウンタ分離の end-to-end 検証)
 *  - meta キャッシュがユニーク数を超えて育たない
 *  - 取り込み中のイベントループ最大停止が破綻級(2秒超)にならない —
 *    worker は単一スレッドなので、ここが伸びる変更は press RPC と演出 delta を
 *    直に止める。実プロセスでは worker/index.ts のラグメーターが同じ値を警告する。
 */
let dir: string;
let store: Store;
let sm: SessionManager | null = null;
let posts: LiveMessage[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-soak-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, { idAliases: {}, nameRules: [] });
  posts = [];
});

afterEach(async () => {
  await sm?.stop('userStopped', false);
  sm = null;
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

const UNIQUES = 10_000;

/** レイド 3 万行: 全員 join + いいね 18k + コメント 1.5k + フォロー 0.5k。 */
function writeRaidFixture(file: string): void {
  const lines: string[] = ['{"o":-1,"meta":{"note":"ソーク用の合成レイド"}}'];
  let o = 0;
  const user = (i: number) => ({
    id: String(i),
    idStr: String(i),
    displayId: `h_${i}`,
    nickname: `視聴者${i}`,
    secUid: `MS4wLjABAAAA${i}`,
    avatarThumb: { urlList: [`https://p16.tiktokcdn.com/${i}.webp`] },
    badgeList: [],
  });
  const push = (type: string, data: Record<string, unknown>) => {
    o += 1;
    lines.push(JSON.stringify({ o, type, data }));
  };
  const common = (id: string) => ({ msgId: id, createTime: String(1785240000 + Math.floor(o / 100)) });

  for (let i = 0; i < UNIQUES; i += 1) {
    push('WebcastMemberMessage', { common: common(`jm${i}`), user: user(i), action: 1 });
    // 10人に1人はその場でいいねを1発(join だけの行列にしない)。
    if (i % 10 === 0) {
      push('WebcastLikeMessage', { common: common(`l0-${i}`), user: user(i), count: 3, total: '0' });
    }
  }
  for (let i = 0; i < 17_000; i += 1) {
    const u = (i * 7) % UNIQUES;
    push('WebcastLikeMessage', { common: common(`l1-${i}`), user: user(u), count: 5, total: '0' });
  }
  for (let i = 0; i < 1_500; i += 1) {
    const u = (i * 13) % UNIQUES;
    push('WebcastChatMessage', { common: common(`c-${i}`), user: user(u), content: `コメント${i}` });
  }
  for (let i = 0; i < 500; i += 1) {
    const u = (i * 17) % UNIQUES;
    push('WebcastSocialMessage', {
      common: { ...common(`f-${i}`), displayText: { key: 'pm_main_follow_message_viewer_2' } },
      user: user(u),
    });
  }
  writeFileSync(file, lines.join('\n'), 'utf8');
}

interface SmInternals {
  meta: Map<string, unknown>;
  uniqueViewers: number;
  firstTimers: number;
}

describe('ソーク — レイド級レートの実取り込み経路', () => {
  it('3万イベント/1万ユニークで数字が正確・キャッシュ有界・ループ停止が破綻しない', async () => {
    const fixture = join(dir, 'raid.ndjson');
    writeRaidFixture(fixture);

    const challenge = new ChallengeEngine(() => ({ ...structuredClone(DEFAULT_CHALLENGE), enabled: true }));
    challenge.start();
    sm = new SessionManager({
      store,
      post: (m) => posts.push(m),
      userDataDir: dir,
      getSettings: () => ({ eulerApiKey: '', captureDebug: false, alertMinTier: 3, giftAlertDiamonds: 100 }),
      getMissionConfig: () => DEFAULT_MISSIONS,
      challenge,
    });

    // イベントループの最大停止を測る(worker/index.ts のラグメーターと同じ原理)。
    let maxLagMs = 0;
    let last = Date.now();
    const meter = setInterval(() => {
      const now = Date.now();
      maxLagMs = Math.max(maxLagMs, now - last - 25);
      last = now;
    }, 25);

    const started = await sm.startReplay(fixture, 0);
    expect(started.sessionId).not.toBeNull();

    // EOF で ReplayAdapter が ended を流し、safeStop が closeSession する。
    const deadline = Date.now() + 90_000;
    for (;;) {
      const ended = posts.some((p) => p.t === 'status' && p.status.state === 'ended');
      if (ended || Date.now() > deadline) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    clearInterval(meter);
    expect(posts.some((p) => p.t === 'status' && p.status.state === 'ended')).toBe(true);

    // 観測ユニーク / 初見は全数(空 DB なので全員初見)。剪定カウンタ分離の e2e。
    const s = sm as unknown as SmInternals;
    expect(s.uniqueViewers).toBe(UNIQUES);
    expect(s.firstTimers).toBe(UNIQUES);
    // meta はユニーク数ぶんだけ(重複イベントで育たない)。
    expect(s.meta.size).toBe(UNIQUES);

    // DB 側の viewer もユニーク数と一致(batcher 経路の欠落・重複なし)。
    const viewers = (store.rawAll('SELECT COUNT(*) AS c FROM viewer') as Array<{ c: number }>)[0]!.c;
    expect(viewers).toBe(UNIQUES);

    // 破綻級のイベントループ停止(2秒超)が無いこと。実測値はログに残す —
    // 前後比較は CI のログで行う(閾値をキツくするとマシン差でフレークする)。
    console.log(`[soak] max event-loop lag: ${maxLagMs}ms`);
    // CI ランナー(特に GitHub の windows-latest)は素のマシンより桁違いに遅く、
    // 同じ入力でこのソークが 10秒 → 41秒 かかる。lag も 519ms → 2575/4501ms と
    // 閾値を常時超えるので、CI では実測値をログに残すだけにして assert しない —
    // 上の「前後比較は CI のログで行う」という方針をそのまま徹底する。上のアサート
    // 群(ユニーク数・meta・DB 一致)は CI でも同じく効いているので、取り込み経路の
    // e2e 検証自体は失われない。
    if (!process.env.CI) expect(maxLagMs).toBeLessThan(2000);
  }, 120_000);
});
