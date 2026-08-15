import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type * as D from '@shared/dto';
import type { RpcRequest, RpcResponse } from '@shared/ipc';
import { DEFAULT_MISSIONS, MissionConfigError, parseMissionConfig } from '@shared/missions';
import { evaluateMissions } from '@shared/missions';
import type { ChallengeEngine } from './challenge';
import type { SessionManager } from './session';
import type { Store } from './store/index';

export interface RpcDeps {
  store: Store;
  session: SessionManager;
  challenge: ChallengeEngine;
  configDir: string;
  resourcesDir: string;
  appInfo: { gitSha: string; buildTime: string; appVersion: string };
  /**
   * worker イベントループの直近最大停止(ms)。読み出しリセット式(loop-lag.ts の
   * drainLoopLagMaxMs)。関数注入なのは循環 import(rpc-server → index)回避のため。
   */
  loopLagMaxMs: () => number;
}

/**
 * Mission config: a user-editable JSON file, because TikTok revises reward
 * thresholds and a hardcoded 25 would quietly become wrong. A broken file falls
 * back to the bundled default and reports why, rather than taking the app down.
 */
export class MissionStore {
  private cfg: D.MissionConfig = DEFAULT_MISSIONS;
  lastError: string | null = null;

  constructor(
    private readonly configDir: string,
    private readonly resourcesDir: string
  ) {
    this.reload();
  }

  reload(): { ok: boolean; error?: string } {
    for (const p of [join(this.configDir, 'missions.json'), join(this.resourcesDir, 'missions.default.json')]) {
      try {
        const raw = JSON.parse(readFileSync(p, 'utf8')) as unknown;
        this.cfg = parseMissionConfig(raw);
        this.lastError = null;
        return { ok: true };
      } catch (e) {
        if (e instanceof MissionConfigError) {
          this.lastError = `${p}: ${e.message}`;
          continue;
        }
        // Missing user file is normal — fall through to the bundled default.
      }
    }
    this.cfg = DEFAULT_MISSIONS;
    return this.lastError ? { ok: false, error: this.lastError } : { ok: true };
  }

  get(): D.MissionConfig {
    return this.cfg;
  }
}

export function createRpcServer(deps: RpcDeps, missions: MissionStore) {
  const { store, session, challenge } = deps;

  const handlers: { [K in keyof HandlerMap]: HandlerMap[K] } = {
    'conn.start': async (p) => session.start(p.uniqueId, p.waitUntilLive),
    'conn.stop': async () => {
      await session.stop('userStopped');
    },
    'conn.status': async () => ({ status: session.status, sessionId: session.sessionId, quota: session.quota }),
    'conn.refreshQuota': async () => session.refreshQuota(),
    'conn.startReplay': async (p) => session.startReplay(p.file, p.speed),

    // カウントダウンチャレンジ — 状態変更は nudge で全ウィンドウへ即時配信し、
    // 戻り値で呼び出し元(押した本人の画面)も同時に更新する。両方受けても冪等。
    'challenge.get': async () => challenge.get(),
    'challenge.start': async () => {
      const s = challenge.start();
      session.nudgeChallenge();
      return s;
    },
    'challenge.stop': async () => {
      const s = challenge.stop();
      session.nudgeChallenge();
      return s;
    },
    'challenge.reset': async () => {
      const s = challenge.reset();
      session.nudgeChallenge();
      return s;
    },
    'challenge.press': async () => {
      const s = challenge.press();
      // press だけは間引き nudge — フィーバー中の連打(数十Hz)で全ウィンドウへの
      // ブロードキャストが毎押下走ると発動後の体感が重くなる。押した本人はこの
      // 戻り値 s で即時更新される(nudgeChallengeCoalesced のコメント参照)。
      session.nudgeChallengeCoalesced();
      return s;
    },
    'challenge.toggleRank': async () => {
      const s = challenge.toggleRank();
      session.nudgeChallenge();
      return s;
    },
    'challenge.testEffect': async (p) => {
      challenge.testEffect(p);
      // 未接続でも challenge-only の delta が出る(pushDelta の許可規約)。
      session.nudgeChallenge();
    },
    'challenge.fxCaps': async (p) => {
      // caps が落ちて凍結を即時解除した場合だけ状態が変わる(nudge で配る)。
      if (challenge.setFxCaps(p.bandFx)) session.nudgeChallenge();
    },

    'q.viewerTable': async (p) => store.getSessionViewerTable(p.sessionId, p),
    'q.viewer': async (p) => store.getViewer(p.userId, p.sessionId),
    'q.recallCard': async (p) => store.getRecallCard(p.userId, p.sessionId),
    'q.comments': async (p) => store.searchComments(p),
    'q.gifts': async (p) => store.listViewerGifts(p.userId, p),
    'q.likeSeries': async (p) => store.getViewerLikeSeries(p.userId, p.limitSessions),
    'q.sessions': async (p) => store.listSessions(p),
    'q.sessionDetail': async (p) => store.getSessionDetail(p.sessionId),
    'q.sessionTotals': async (p) => store.getSessionTotals(p.sessionId),
    'q.timeline': async (p) => store.getSessionTimeline(p.sessionId, p.bucketMs),
    'q.leaderboard': async (p) => store.getLeaderboard(p),
    'q.churn': async (p) => store.getChurnCandidates(p),
    'q.matrix': async (p) => store.getHourWeekdayMatrix(p),
    'q.missions': async (p) => {
      const cfg = missions.get();
      return evaluateMissions(cfg, store.getMissionInputs(cfg, p.sessionId));
    },
    'q.diagnostics': async () => ({
      ...store.diagnostics(),
      loopLagMaxMs: deps.loopLagMaxMs(),
      // Batcher 統計のスナップショット(累積)。maxFlushMs と loopLagMaxMs を
      // 並べて読めば「worker 停止の犯人が DB フラッシュか」が一発で分かる。
      ingest: session.ingestStats,
      quota: session.quota,
      gitSha: deps.appInfo.gitSha,
      buildTime: deps.appInfo.buildTime,
      appVersion: deps.appInfo.appVersion,
    }),

    'm.viewerMeta': async (p) => {
      store.updateViewerMeta(p.userId, p.patch);
      // The live feed caches each viewer's record for the session; drop it so the
      // new memo shows on their very next comment rather than next broadcast.
      session.invalidateMeta(p.userId);
    },
    'm.forgetViewer': async (p) => {
      store.forgetViewer(p.userId, p.mode);
    },
    'm.unblockViewer': async (p) => {
      store.unblockViewer(p.userId);
    },
    'm.recomputeScores': async (p) => ({ updated: store.recomputeScores({ full: p.full }) }),
    'm.purge': async (p) => store.purge(p),
    'm.reloadMissions': async () => missions.reload(),

    'w.exportCsv': async (p) => ({ rows: store.exportCsv(p.spec, p.path) }),
    'w.backup': async (p) => {
      store.backupTo(p.path);
    },
  };

  return async function handle(req: RpcRequest): Promise<RpcResponse> {
    const h = (handlers as Record<string, ((p: unknown) => Promise<unknown>) | undefined>)[req.method];
    if (!h) {
      return { id: req.id, ok: false, error: { code: 'VALIDATION', message: `未対応のメソッド: ${req.method}` } };
    }
    try {
      const result = await h(req.params);
      return { id: req.id, ok: true, result } as RpcResponse;
    } catch (e) {
      const message = (e as Error)?.message ?? String(e);
      return { id: req.id, ok: false, error: { code: 'DB', message } };
    }
  };
}

/** Only the worker-handled subset. The `cfg.` and `file.` methods live in main. */
type HandlerMap = {
  'conn.start': (p: { uniqueId: string; waitUntilLive: boolean }) => Promise<{ sessionId: number | null }>;
  'conn.stop': () => Promise<void>;
  'conn.status': () => Promise<unknown>;
  'conn.refreshQuota': () => Promise<unknown>;
  'conn.startReplay': (p: { file: string; speed: number }) => Promise<{ sessionId: number | null }>;
  'challenge.get': () => Promise<D.ChallengeState>;
  'challenge.start': () => Promise<D.ChallengeState>;
  'challenge.stop': () => Promise<D.ChallengeState>;
  'challenge.reset': () => Promise<D.ChallengeState>;
  'challenge.press': () => Promise<D.ChallengeState>;
  'challenge.toggleRank': () => Promise<D.ChallengeState>;
  'challenge.testEffect': (p: D.ChallengeTestEffectSpec) => Promise<void>;
  'challenge.fxCaps': (p: { bandFx: boolean }) => Promise<void>;
  'q.viewerTable': (p: { sessionId: number | null } & D.ViewerTableQuery) => Promise<unknown>;
  'q.viewer': (p: { userId: string; sessionId: number | null }) => Promise<unknown>;
  'q.recallCard': (p: { userId: string; sessionId: number | null }) => Promise<unknown>;
  'q.comments': (p: D.CommentSearchQuery) => Promise<unknown>;
  'q.gifts': (p: { userId: string } & D.Paged) => Promise<unknown>;
  'q.likeSeries': (p: { userId: string; limitSessions: number }) => Promise<unknown>;
  'q.sessions': (p: D.Paged) => Promise<unknown>;
  'q.sessionDetail': (p: { sessionId: number }) => Promise<unknown>;
  'q.sessionTotals': (p: { sessionId: number }) => Promise<unknown>;
  'q.timeline': (p: { sessionId: number; bucketMs: number }) => Promise<unknown>;
  'q.leaderboard': (p: D.LeaderboardQuery) => Promise<unknown>;
  'q.churn': (p: D.ChurnQuery) => Promise<unknown>;
  'q.matrix': (p: D.MatrixQuery) => Promise<unknown>;
  'q.missions': (p: { sessionId: number | null }) => Promise<unknown>;
  'q.diagnostics': () => Promise<unknown>;
  'm.viewerMeta': (p: { userId: string; patch: D.ViewerMetaPatch }) => Promise<void>;
  'm.forgetViewer': (p: { userId: string; mode: 'block' | 'purge' }) => Promise<void>;
  'm.unblockViewer': (p: { userId: string }) => Promise<void>;
  'm.recomputeScores': (p: { full: boolean }) => Promise<unknown>;
  'm.purge': (p: D.PurgeSpec) => Promise<unknown>;
  'm.reloadMissions': () => Promise<unknown>;
  'w.exportCsv': (p: { spec: D.CsvExportSpec; path: string }) => Promise<{ rows: number }>;
  'w.backup': (p: { path: string }) => Promise<void>;
};
