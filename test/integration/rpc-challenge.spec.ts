import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CHALLENGE_PRESS_NUDGE_MS } from '@shared/constants';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { DEFAULT_MISSIONS } from '@shared/missions';
import type { ChallengeConfig, ChallengeState } from '@shared/dto';
import type { LiveMessage, RpcRequest, RpcResponse } from '@shared/ipc';
import { ChallengeEngine } from '../../src/worker/challenge';
import { MissionStore, createRpcServer } from '../../src/worker/rpc-server';
import { SessionManager } from '../../src/worker/session';
import { Store } from '../../src/worker/store/index';

/**
 * RPC ハンドラ層の貫通テスト。
 *
 * これまで `challenge.*` は**エンジンのメソッド単位でしか**テストされていなかった
 * (test/unit/challenge.spec.ts)。RPC ハンドラは「エンジンを叩いて nudge する」薄い層
 * だが、その nudge の有無と回数こそがモニター/ダッシュボードの同期の全てで、ここが
 * 壊れると「押しても他の窓に反映されない」という配信事故になる。
 *
 * rpc-server.ts は electron を型すら import しないので、実 Store + 実 SessionManager +
 * 実 ChallengeEngine をそのまま組んで駆動できる。モックは無い。
 */
let dir: string;
let store: Store;
let sm: SessionManager | null = null;
let posts: LiveMessage[] = [];
let cfg: ChallengeConfig;
let engine: ChallengeEngine;
let handle: (req: RpcRequest) => Promise<RpcResponse>;
let reqSeq = 0;

/**
 * 既定は enabled:true。カットイン凍結を張る機能は全部落として delta 数を素直にする
 * (challenge.spec.ts の cfg() と同じ判断 — 時間を進めないテストで保留キューへ
 * 乗ってしまうのを防ぐ)。凍結そのものを見るテストだけが個別に有効化する。
 */
function baseCfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  base.tapBoost.enabled = false;
  base.fanStamp.enabled = false;
  base.stampTriggers.enabled = false;
  base.roulettes = [];
  return { ...base, enabled: true, initialValue: 100, pressStep: 1, ...over };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-rpc-'));
  store = new Store();
  store.open({ dbPath: join(dir, 'db', 'test.db') }, { idAliases: {}, nameRules: [] });
  posts = [];
  cfg = baseCfg();
  engine = new ChallengeEngine(() => cfg, Date.now, Math.random, Math.random, () => undefined);
  // 凍結を張れる状態にしておく(fxAllowed = monitorOpen && bandFx)。
  engine.setMonitorOpen(true);
  engine.setFxCaps(true);
  sm = new SessionManager({
    store,
    post: (m) => posts.push(m as LiveMessage),
    userDataDir: dir,
    getSettings: () => ({ eulerApiKey: '', captureDebug: false, alertMinTier: 3, giftAlertDiamonds: 100 }),
    getMissionConfig: () => DEFAULT_MISSIONS,
    challenge: engine,
  });
  handle = createRpcServer(
    {
      store,
      session: sm,
      challenge: engine,
      configDir: join(dir, 'config'),
      resourcesDir: resolve('resources'),
      appInfo: { gitSha: 'test', buildTime: 'test', appVersion: '0.0.0-test' },
      loopLagMaxMs: () => 0,
    },
    new MissionStore(join(dir, 'config'), resolve('resources'))
  ) as unknown as (req: RpcRequest) => Promise<RpcResponse>;
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

/** RPC を1本撃つ。id は自動採番して封筒の突き合わせに使う。 */
async function rpc(method: string, params?: unknown): Promise<RpcResponse> {
  const id = `t-${(reqSeq += 1)}`;
  return handle({ id, method, params } as RpcRequest);
}

function clearPosts(): void {
  posts = [];
}

/** challenge を載せた delta だけを数える(セッション由来の tick と混ざらないように)。 */
function challengeDeltas(): ChallengeState[] {
  return posts
    .filter((m): m is Extract<LiveMessage, { t: 'delta' }> => m.t === 'delta')
    .map((d) => d.challenge)
    .filter((c): c is ChallengeState => c != null);
}

function okResult<T>(res: RpcResponse): T {
  expect(res.ok, res.ok ? '' : `RPC failed: ${res.error.message}`).toBe(true);
  return (res as unknown as { result: T }).result;
}

describe('challenge.* RPC — 戻り値と delta 配信', () => {
  it('challenge.get は状態を返すが delta は出さない(読み取りは配らない)', async () => {
    clearPosts();
    const s = okResult<ChallengeState>(await rpc('challenge.get'));
    expect(s.status).toBe('idle');
    expect(challengeDeltas()).toHaveLength(0);
  });

  it('challenge.start は running を返し、delta を1通だけ配る', async () => {
    clearPosts();
    const s = okResult<ChallengeState>(await rpc('challenge.start'));
    expect(s.status).toBe('running');
    expect(s.value).toBe(100);
    const d = challengeDeltas();
    expect(d).toHaveLength(1);
    // 戻り値と delta は同じ状態を指す(押した本人と他の窓が食い違わない)。
    expect(d[0]!.status).toBe('running');
    expect(d[0]!.value).toBe(100);
  });

  it('challenge.stop は値を残したまま idle を返し、delta を1通だけ配る', async () => {
    await rpc('challenge.start');
    await rpc('challenge.press');
    clearPosts();
    const s = okResult<ChallengeState>(await rpc('challenge.stop'));
    expect(s.status).toBe('idle');
    // 一時停止は値も startedMs も残す規約。
    expect(s.value).toBe(99);
    expect(s.startedMs).not.toBeNull();
    expect(challengeDeltas()).toHaveLength(1);
  });

  it('challenge.reset は初期値へ戻し、delta を1通だけ配る', async () => {
    await rpc('challenge.start');
    clearPosts();
    const s = okResult<ChallengeState>(await rpc('challenge.reset'));
    expect(s.status).toBe('idle');
    expect(s.value).toBe(100);
    expect(s.startedMs).toBeNull();
    expect(challengeDeltas()).toHaveLength(1);
  });

  it('challenge.toggleRank は表示を反転し、毎回 delta を1通だけ配る', async () => {
    await rpc('challenge.start');
    clearPosts();
    const on = okResult<ChallengeState>(await rpc('challenge.toggleRank'));
    expect(on.rankBoard).toBeDefined();
    expect(challengeDeltas()).toHaveLength(1);

    clearPosts();
    const off = okResult<ChallengeState>(await rpc('challenge.toggleRank'));
    expect(off.rankBoard).toBeUndefined();
    expect(challengeDeltas()).toHaveLength(1);
  });

  it('challenge.toggleRouletteRush は焦らし短縮を反転し、毎回 delta を1通だけ配る', async () => {
    clearPosts();
    const on = okResult<ChallengeState>(await rpc('challenge.toggleRouletteRush'));
    expect(on.rouletteRush).toBe(true);
    expect(challengeDeltas()).toHaveLength(1);

    clearPosts();
    const off = okResult<ChallengeState>(await rpc('challenge.toggleRouletteRush'));
    expect(off.rouletteRush).toBeUndefined();
    expect(challengeDeltas()).toHaveLength(1);
  });
});

describe('challenge.press — 押した本人は即時、ブロードキャストは間引く', () => {
  it('戻り値は即座に減るが、delta は間引きタイマーが来るまで出ない', async () => {
    await rpc('challenge.start');
    vi.useFakeTimers();
    try {
      clearPosts();
      const s = okResult<ChallengeState>(await rpc('challenge.press'));
      // 押した本人はこの戻り値で即時更新される。
      expect(s.value).toBe(99);
      // まだブロードキャストは出ていない。
      expect(challengeDeltas()).toHaveLength(0);

      vi.advanceTimersByTime(CHALLENGE_PRESS_NUDGE_MS + 5);
      const d = challengeDeltas();
      expect(d).toHaveLength(1);
      expect(d[0]!.value).toBe(99);
    } finally {
      vi.useRealTimers();
    }
  });

  it('連打5回でも delta は1通に畳まれる(フィーバー中の数十Hz対策)', async () => {
    await rpc('challenge.start');
    vi.useFakeTimers();
    try {
      clearPosts();
      for (let i = 0; i < 5; i += 1) await rpc('challenge.press');
      expect(challengeDeltas()).toHaveLength(0);

      vi.advanceTimersByTime(CHALLENGE_PRESS_NUDGE_MS + 5);
      const d = challengeDeltas();
      expect(d).toHaveLength(1);
      // 畳まれても値は5回分ちゃんと減っている(間引くのは配信であって適用ではない)。
      expect(d[0]!.value).toBe(95);
      expect(d[0]!.stats.presses).toBe(5);
    } finally {
      vi.useRealTimers();
    }
  });

  it('idle 中の press はエラーにならず、値も動かない', async () => {
    clearPosts();
    const s = okResult<ChallengeState>(await rpc('challenge.press'));
    expect(s.status).toBe('idle');
    expect(s.value).toBe(100);
  });
});

describe('challenge.testEffect — 演出だけ流し、値と統計は動かさない', () => {
  it('press の実演で delta は出るが value / stats は不変', async () => {
    await rpc('challenge.start');
    clearPosts();
    const res = await rpc('challenge.testEffect', { kind: 'press' });
    expect(res.ok).toBe(true);

    const d = challengeDeltas();
    expect(d.length).toBeGreaterThanOrEqual(1);
    const last = d[d.length - 1]!;
    // ipc.ts の「値・統計は変えない」規約の機械化。
    expect(last.value).toBe(100);
    expect(last.stats.presses).toBe(0);
    // 演出そのものは ring に載っている。
    expect(last.recentEffects.some((e) => e.kind === 'press')).toBe(true);
  });

  it('停止中(idle)でも実演は流れる — 設定画面の「▶ モニター」の前提', async () => {
    clearPosts();
    const res = await rpc('challenge.testEffect', { kind: 'follow' });
    expect(res.ok).toBe(true);
    const d = challengeDeltas();
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d[d.length - 1]!.recentEffects.some((e) => e.kind === 'follow')).toBe(true);
  });
});

describe('challenge.fxCaps — 凍結を解いたときだけ配る', () => {
  /** 帯域カットインに一致するギフトを1件流して凍結を張る。 */
  function freezeWithGift(): void {
    engine.handleEvent({
      kind: 'gift',
      tsMs: Date.now(),
      msgId: `g-${reqSeq}-${Math.random()}`,
      viewer: { userId: 'u1', nickname: 'u1' },
      giftId: '5655',
      giftName: 'Rose',
      diamonds: 30,
      repeatCount: 1,
    } as never);
  }

  it('凍結していなければ、能力が落ちても配らない(状態は何も変わっていない)', async () => {
    // beforeEach で setFxCaps(true) 済み。false への変化はあるが凍結中ではない。
    clearPosts();
    expect((await rpc('challenge.fxCaps', { bandFx: false })).ok).toBe(true);
    expect(challengeDeltas()).toHaveLength(0);
  });

  it('凍結中に能力が落ちたら即時解除して配る(再生されない演出でカウンタを止めない)', async () => {
    cfg = baseCfg({ giftBandFx: { ...structuredClone(DEFAULT_CHALLENGE.giftBandFx), enabled: true } });
    await rpc('challenge.start');
    freezeWithGift();
    expect(engine.get().fxFreezeUntilMs).not.toBeNull();

    clearPosts();
    expect((await rpc('challenge.fxCaps', { bandFx: false })).ok).toBe(true);
    // 凍結が解けた = 状態が変わった = 配る。
    expect(engine.get().fxFreezeUntilMs).toBeNull();
    expect(challengeDeltas()).toHaveLength(1);
  });

  it('同値の再申告は凍結中でも配らない(冪等)', async () => {
    cfg = baseCfg({ giftBandFx: { ...structuredClone(DEFAULT_CHALLENGE.giftBandFx), enabled: true } });
    await rpc('challenge.start');
    freezeWithGift();

    clearPosts();
    expect((await rpc('challenge.fxCaps', { bandFx: true })).ok).toBe(true);
    expect(challengeDeltas()).toHaveLength(0);
    // 能力は落ちていないので凍結は続いている。
    expect(engine.get().fxFreezeUntilMs).not.toBeNull();
  });
});

describe('RPC の封筒', () => {
  it('応答の id は要求の id を反射する', async () => {
    const res = await handle({ id: 'echo-me', method: 'challenge.get', params: undefined } as RpcRequest);
    expect(res.id).toBe('echo-me');
  });

  it('未対応のメソッドは VALIDATION で返る(throw しない)', async () => {
    const res = await rpc('challenge.doesNotExist');
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('VALIDATION');
      expect(res.error.message).toContain('未対応のメソッド');
    }
  });

  it('ハンドラが throw したら DB エラーへ畳まれる(worker は落ちない)', async () => {
    const orig = engine.start.bind(engine);
    engine.start = (() => {
      throw new Error('意図的な失敗');
    }) as ChallengeEngine['start'];
    try {
      const res = await rpc('challenge.start');
      expect(res.ok).toBe(false);
      if (!res.ok) {
        expect(res.error.code).toBe('DB');
        expect(res.error.message).toBe('意図的な失敗');
      }
    } finally {
      engine.start = orig;
    }
  });
});

describe('worker 側の結線 — エンジン単体では見えない配線', () => {
  it('設定変更(onConfigChanged)が delta として配られる', () => {
    clearPosts();
    cfg = baseCfg({ title: '新しいタイトル' });
    engine.onConfigChanged();
    sm!.nudgeChallenge();
    const d = challengeDeltas();
    expect(d).toHaveLength(1);
    expect(d[0]!.title).toBe('新しいタイトル');
  });

  it('配信終了でランキングが畳まれる(session.stop → hideRank の結線)', async () => {
    await rpc('challenge.start');
    await rpc('challenge.toggleRank');
    expect(engine.get().rankBoard).toBeDefined();

    clearPosts();
    await sm!.stop('userStopped', false);
    expect(engine.get().rankBoard).toBeUndefined();
    expect(challengeDeltas().length).toBeGreaterThanOrEqual(1);
  });
});
