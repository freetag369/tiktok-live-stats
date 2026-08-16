import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAIN_HANDLED, RPC_OWNER } from '@shared/ipc';
import type { RpcMethod } from '@shared/ipc';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { DEFAULT_MISSIONS } from '@shared/missions';
import { ChallengeEngine } from '@worker/challenge';
import { MissionStore, createRpcServer } from '@worker/rpc-server';
import { SessionManager } from '@worker/session';
import { Store } from '@worker/store/index';

/**
 * RPC の振り分けが型と実装で食い違わないこと。
 *
 * 型(RPC_OWNER が Record<RpcMethod, …>)は「分類し忘れ」を typecheck で止めるが、
 * **worker が実際にそのハンドラを持っているか**までは言えない。分類だけして
 * ハンドラを書き忘れると、main は転送し worker は「未対応のメソッド」を返す —
 * 実行時にしか分からない壊れ方をする。ここで実物の鍵束と突き合わせる。
 */
let dir: string;
let store: Store;
let sm: SessionManager;
let workerMethods: string[];

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-routing-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, { idAliases: {}, nameRules: [] });
  const challenge = new ChallengeEngine(() => DEFAULT_CHALLENGE, Date.now, Math.random, Math.random, () => undefined);
  sm = new SessionManager({
    store,
    post: () => undefined,
    userDataDir: dir,
    getSettings: () => ({ eulerApiKey: '', captureDebug: false, alertMinTier: 3, giftAlertDiamonds: 100 }),
    getMissionConfig: () => DEFAULT_MISSIONS,
    challenge,
  });
  const handle = createRpcServer(
    {
      store,
      session: sm,
      challenge,
      configDir: join(dir, 'config'),
      resourcesDir: resolve('resources'),
      appInfo: { gitSha: 't', buildTime: 't', appVersion: '0.0.0-test' },
      loopLagMaxMs: () => 0,
    },
    new MissionStore(join(dir, 'config'), resolve('resources'))
  );
  workerMethods = handle.methods;
});

afterAll(async () => {
  await sm.stop('userStopped', false);
  try {
    store.close();
  } catch {
    /* already closed */
  }
  rmSync(dir, { recursive: true, force: true });
});

function ownedBy(owner: 'main' | 'worker'): string[] {
  return Object.entries(RPC_OWNER)
    .filter(([, o]) => o === owner)
    .map(([m]) => m)
    .sort();
}

describe('RPC_OWNER — 型と実装の突き合わせ', () => {
  it('worker 側の分類と実際のハンドラ一覧が過不足なく一致する', () => {
    expect([...workerMethods].sort()).toEqual(ownedBy('worker'));
  });

  it('main 側に分類したメソッドを worker は持っていない(二重実装の検出)', () => {
    const overlap = ownedBy('main').filter((m) => workerMethods.includes(m));
    expect(overlap).toEqual([]);
  });

  it('MAIN_HANDLED は RPC_OWNER からの導出値と一致する', () => {
    expect([...MAIN_HANDLED].sort()).toEqual(ownedBy('main'));
  });

  it('MAIN_HANDLED に RpcMap 外の死んだエントリが無い', () => {
    const known = new Set(Object.keys(RPC_OWNER));
    expect([...MAIN_HANDLED].filter((m) => !known.has(m))).toEqual([]);
  });

  it('main と worker の集合は素で、合わせて全チャネルを覆う', () => {
    const all = Object.keys(RPC_OWNER).sort();
    expect([...ownedBy('main'), ...ownedBy('worker')].sort()).toEqual(all);
  });

  it('challenge.* はすべて worker が持つ(main へ流れると無言で失敗する)', () => {
    const ch = Object.keys(RPC_OWNER).filter((m) => m.startsWith('challenge.'));
    expect(ch.length).toBeGreaterThan(0);
    for (const m of ch) {
      expect(RPC_OWNER[m as RpcMethod], m).toBe('worker');
      expect(workerMethods).toContain(m);
    }
  });

  it('challengeDefault.* は main が持つ(設定ファイルは main の担当)', () => {
    const cd = Object.keys(RPC_OWNER).filter((m) => m.startsWith('challengeDefault.'));
    expect(cd.length).toBeGreaterThan(0);
    for (const m of cd) {
      expect(RPC_OWNER[m as RpcMethod], m).toBe('main');
      expect(workerMethods).not.toContain(m);
    }
  });
});
