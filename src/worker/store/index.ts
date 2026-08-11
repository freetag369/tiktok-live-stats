import { statSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
import { SESSION_RESUME_GAP_MS } from '@shared/constants';
import type * as D from '@shared/dto';
import type { NormalizedEvent, UserId } from '@shared/events';
import { DEFAULT_SCORING, validateScoringConfig } from '@shared/scoring';
import { applyEvent, makeCtx, type ApplyCtx } from './apply';
import { openDatabase } from './open';
import { Statements, SQL } from './statements';
import * as QV from './queries/viewers';
import * as QS from './queries/sessions';
import * as QC from './queries/comments';
import * as QA from './queries/analytics';
import { backupTo, exportCsv, purge, rebuildLifetime } from './export';

/**
 * The ONLY place in the repo that contains SQL strings (plus ./queries/*).
 * `node:sqlite` is Stability 1.2 (release candidate); keeping every statement
 * behind this surface makes swapping to better-sqlite3 or node-sqlite3-wasm a
 * one-directory change.
 */
export class Store {
  private db!: DatabaseSync;
  private st!: Statements;
  private ctx!: ApplyCtx;
  private caps!: D.StoreCapabilities;
  private scoring: D.ScoringConfig = DEFAULT_SCORING;

  open(opts: D.OpenOptions, giftAliases: { idAliases: Record<string, string>; nameRules: Array<{ canonical: string; match: string[] }> }): D.StoreCapabilities {
    const { db, caps, orphanSessionIds } = openDatabase(opts.dbPath);
    this.db = db;
    this.caps = caps;
    this.st = new Statements(db);
    this.ctx = makeCtx(db, this.st);
    this.ctx.nameRules = giftAliases.nameRules;

    // Seed the alias hints. gift_catalog rows must exist first (foreign_keys = ON),
    // and these ids are UNVERIFIED guesses — the name rules are what actually
    // guarantee Heart Me is counted once a real one arrives.
    db.exec('BEGIN IMMEDIATE');
    try {
      const cat = db.prepare(
        `INSERT OR IGNORE INTO gift_catalog (gift_id, first_seen_ms, last_seen_ms) VALUES (?, ?, ?)`
      );
      const al = db.prepare(SQL.upsertGiftAlias);
      const now = Date.now();
      for (const [id, canonical] of Object.entries(giftAliases.idAliases)) {
        cat.run(id, now, now);
        al.run(id, canonical);
      }
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }

    this.reloadBlocklist();
    this.scoring = validateScoringConfig(this.getSetting('scoring.v1'));

    // A session closed by the crash-recovery path never ran the analytics pass
    // that normally happens at closeSession(). Without this, a crashed stream
    // contributes nothing to scores, VIP tiers, streaks or churn baselines.
    for (const sid of orphanSessionIds) {
      try {
        QA.applySessionScores(db, sid, this.scoring);
      } catch {
        // Recovery must never prevent the app from opening.
      }
    }

    // Self-heal: recordings exist but nothing has ever been scored. Happens after
    // a crash that predates the recovery above, or when a user restores a backup
    // taken mid-stream. Cheap to detect, and leaving it unrepaired silently
    // empties 常連ランキング, VIP判定 and every churn baseline.
    try {
      const scorable = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS c FROM stream_session s
                WHERE s.ended_ms IS NOT NULL
                  AND EXISTS (SELECT 1 FROM viewer_session_stat v WHERE v.session_id = s.session_id)`
            )
            .get() as { c: number }
        ).c
      );
      const scored = Number(
        (db.prepare('SELECT COUNT(*) AS c FROM viewer_lifetime WHERE score_e > 0').get() as { c: number }).c
      );
      if (scorable > 0 && scored === 0) {
        QA.recomputeAllScores(db, this.scoring);
        db.prepare(SQL.insertConnectLog).run(Date.now(), 'error', `scores backfilled for ${scorable} session(s)`);
      }
    } catch {
      // Never block startup on a repair.
    }
    return caps;
  }

  close(): void {
    try {
      this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* best effort */
    }
    this.st.clear();
    this.db.close();
  }

  get capabilities(): D.StoreCapabilities {
    return this.caps;
  }

  get scoringConfig(): D.ScoringConfig {
    return this.scoring;
  }

  setScoringConfig(cfg: D.ScoringConfig): void {
    this.scoring = validateScoringConfig(cfg);
    this.setSetting('scoring.v1', this.scoring);
  }

  maintain(opts?: { checkpoint?: 'PASSIVE' | 'TRUNCATE' }): void {
    try {
      this.db.exec('PRAGMA analysis_limit = 400');
      this.db.exec('PRAGMA optimize');
      this.db.exec(`PRAGMA wal_checkpoint(${opts?.checkpoint ?? 'PASSIVE'})`);
    } catch {
      /* non-fatal */
    }
  }

  private reloadBlocklist(): void {
    this.ctx.blocked = new Set(
      (this.db.prepare('SELECT user_id FROM viewer WHERE is_blocked = 1').all() as Array<{ user_id: string }>).map(
        (r) => r.user_id
      )
    );
  }

  // ── ingest ────────────────────────────────────────────────────────────────

  /** Owns its own transaction. Never throws on an unknown event kind. */
  applyBatch(sessionId: number, events: readonly NormalizedEvent[]): D.BatchResult {
    const res: D.BatchResult = { applied: 0, ignoredDuplicates: 0, droppedBlocked: 0, unhandled: [] };
    if (events.length === 0) return res;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const e of events) applyEvent(this.ctx, sessionId, e, res);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return res;
  }

  // ── sessions ──────────────────────────────────────────────────────────────

  openSession(input: D.OpenSessionInput): { sessionId: number; resumed: boolean } {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (input.hostUserId) {
        this.db
          .prepare(
            `INSERT INTO host (host_user_id, display_id, nickname, added_ms) VALUES (?, ?, ?, ?)
             ON CONFLICT(host_user_id) DO UPDATE SET display_id = excluded.display_id, nickname = excluded.nickname`
          )
          .run(input.hostUserId, input.hostUniqueId, input.hostNickname ?? '', input.startedMs);
      }

      // A 3-minute network drop is the same broadcast; 15 minutes is a new one.
      //
      // Matching on room_id alone is not enough: the first connect can succeed
      // before TikTok has returned a room id, and the websocket then re-handshakes
      // a few seconds later with the real one. Observed live — two sessions three
      // seconds apart for the same streamer, one with an empty room_id, splitting
      // a single broadcast in two. So a same-host session inside the resume window
      // is adopted whenever either side is missing a room id.
      const cand = this.db
        .prepare(
          `SELECT session_id, started_ms, ended_ms, room_id FROM stream_session
            WHERE host_unique_id = ? ORDER BY started_ms DESC LIMIT 1`
        )
        .get(input.hostUniqueId) as
        | { session_id: number; started_ms: number; ended_ms: number | null; room_id: string | null }
        | undefined;

      if (cand) {
        const sameRoom = Boolean(input.roomId) && cand.room_id === input.roomId;
        const roomUnknown = !input.roomId || !cand.room_id;
        const lastActivity = Number(cand.ended_ms ?? cand.started_ms);
        if ((sameRoom || roomUnknown) && input.startedMs - lastActivity < SESSION_RESUME_GAP_MS) {
          this.db
            .prepare(
              `UPDATE stream_session
                  SET ended_ms = NULL, end_reason = NULL, duration_ms = NULL,
                      room_id = COALESCE(NULLIF(?, ''), room_id)
                WHERE session_id = ?`
            )
            .run(input.roomId ?? '', cand.session_id);
          this.db.prepare(SQL.insertConnectLog).run(input.startedMs, 'sessionResumed', String(cand.session_id));
          this.db.exec('COMMIT');
          this.ctx.lastMetricMs = 0;
          return { sessionId: cand.session_id, resumed: true };
        }
      }

      const info = this.db
        .prepare(
          `INSERT INTO stream_session (host_user_id, host_unique_id, room_id, started_ms) VALUES (?, ?, ?, ?)`
        )
        .run(input.hostUserId, input.hostUniqueId, input.roomId, input.startedMs);
      const sessionId = Number(info.lastInsertRowid);
      this.db.prepare(SQL.insertConnectLog).run(input.startedMs, 'sessionOpened', String(sessionId));
      this.db.exec('COMMIT');
      this.ctx.lastMetricMs = 0;
      this.ctx.lastJoinMs.clear();
      return { sessionId, resumed: false };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  closeSession(sessionId: number, input: D.CloseSessionInput): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const s = this.db.prepare('SELECT started_ms FROM stream_session WHERE session_id = ?').get(sessionId) as
        | { started_ms: number }
        | undefined;
      if (!s) {
        this.db.exec('ROLLBACK');
        return;
      }
      const avg = (
        this.db.prepare('SELECT AVG(viewer_count) AS a FROM session_metric WHERE session_id = ?').get(sessionId) as {
          a: number | null;
        }
      ).a;
      this.db
        .prepare(
          `UPDATE stream_session SET ended_ms = ?, duration_ms = ?, end_reason = ?, avg_viewers = ? WHERE session_id = ?`
        )
        .run(
          input.endedMs,
          Math.max(0, input.endedMs - Number(s.started_ms)),
          input.reason,
          avg == null ? null : Math.round(avg),
          sessionId
        );
      this.db.prepare(SQL.insertConnectLog).run(input.endedMs, 'sessionClosed', `${sessionId}:${input.reason}`);
      // The like dedupe keys only matter while the stream is live.
      this.db.prepare(SQL.clearLikeSeen).run(sessionId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    // Scores/streaks/intervals are recomputed outside the close transaction so a
    // slow analytics pass cannot hold a write lock during teardown.
    QA.applySessionScores(this.db, sessionId, this.scoring);
    this.maintain({ checkpoint: 'TRUNCATE' });
  }

  recordConnectLog(kind: D.ConnectLogKind, detail?: string): void {
    this.db.prepare(SQL.insertConnectLog).run(Date.now(), kind, detail ?? null);
  }

  // ── identity / CRM ────────────────────────────────────────────────────────

  getViewer(userId: UserId, sessionId: number | null): D.ViewerDetail | null {
    return QV.getViewerDetail(this.db, userId, sessionId, this.scoring.halfLifeDays);
  }

  getRecallCard(userId: UserId, sessionId: number | null): D.RecallCard | null {
    return QV.getRecallCard(this.db, userId, sessionId);
  }

  /**
   * Lightweight roster of everyone already recorded for a session.
   *
   * Used when a dropped connection resumes an existing session: without it the
   * live counters restart from zero and every regular gets a fresh 入室アラート
   * as though they had just walked in.
   */
  getSessionAttendees(sessionId: number): Array<{
    userId: UserId;
    vipTier: number;
    visits: number;
    firstEver: boolean;
    prevVisitMs?: number;
    diamondsLifetime: number;
    heartMeLifetime: number;
    likesLifetime: number;
    readingKana?: string;
    note?: string;
  }> {
    return (
      this.db
        .prepare(
          `SELECT vss.user_id, v.vip_tier, v.reading_kana, v.note,
                  vl.visits, vl.diamonds, vl.heart_me, vl.likes, vss.is_first_ever,
                  (SELECT MAX(p.first_seen_ms) FROM viewer_session_stat p
                    WHERE p.user_id = vss.user_id AND p.session_id < :sid) AS prev_visit_ms
             FROM viewer_session_stat vss
             JOIN viewer v ON v.user_id = vss.user_id
             JOIN viewer_lifetime vl ON vl.user_id = vss.user_id
            WHERE vss.session_id = :sid`
        )
        .all({ sid: sessionId }) as Array<Record<string, unknown>>
    ).map((r) => ({
      userId: String(r.user_id),
      vipTier: Number(r.vip_tier ?? 0),
      visits: Number(r.visits ?? 0),
      firstEver: Number(r.is_first_ever ?? 0) === 1,
      prevVisitMs: r.prev_visit_ms == null ? undefined : Number(r.prev_visit_ms),
      diamondsLifetime: Number(r.diamonds ?? 0),
      heartMeLifetime: Number(r.heart_me ?? 0),
      likesLifetime: Number(r.likes ?? 0),
      readingKana: (r.reading_kana as string) || undefined,
      note: (r.note as string) || undefined,
    }));
  }

  updateViewerMeta(userId: UserId, patch: D.ViewerMetaPatch): void {
    const sets: string[] = [];
    const params: Record<string, string | number | null> = { uid: userId };
    if (patch.readingKana !== undefined) {
      sets.push('reading_kana = :kana');
      params.kana = patch.readingKana;
    }
    if (patch.note !== undefined) {
      sets.push('note = :note');
      params.note = patch.note;
    }
    if (patch.vipTierManual !== undefined) {
      if (patch.vipTierManual === null) {
        // Back to automatic: the next recompute decides.
        sets.push(`vip_source = 'auto'`);
      } else {
        sets.push('vip_tier = :tier', `vip_source = 'manual'`, 'vip_tier_since_ms = :now');
        params.tier = patch.vipTierManual;
        params.now = Date.now();
      }
    }
    if (!sets.length) return;
    this.db.prepare(`UPDATE viewer SET ${sets.join(', ')} WHERE user_id = :uid`).run(params);
  }

  /** block = stop recording from now on (history kept). purge = delete everything. */
  forgetViewer(userId: UserId, mode: 'block' | 'purge'): void {
    if (mode === 'block') {
      this.db.prepare('UPDATE viewer SET is_blocked = 1 WHERE user_id = ?').run(userId);
      this.ctx.blocked.add(userId);
      return;
    }
    purge(this.db, { scope: 'viewer', userId });
    this.ctx.blocked.delete(userId);
  }

  unblockViewer(userId: UserId): void {
    this.db.prepare('UPDATE viewer SET is_blocked = 0 WHERE user_id = ?').run(userId);
    this.ctx.blocked.delete(userId);
  }

  // ── reads ─────────────────────────────────────────────────────────────────

  getSessionViewerTable(sessionId: number | null, q: D.ViewerTableQuery): D.Page<D.ViewerTableRow> {
    return QV.getSessionViewerTable(this.db, sessionId, q, this.scoring.halfLifeDays);
  }

  getSessionTotals(sessionId: number): D.SessionTotals | null {
    return QS.getSessionTotals(this.db, sessionId);
  }

  listSessions(q: D.Paged): D.Page<D.SessionListRow> {
    return QS.listSessions(this.db, q);
  }

  getSessionDetail(sessionId: number): D.SessionDetail | null {
    return QS.getSessionDetail(this.db, sessionId);
  }

  getSessionTimeline(sessionId: number, bucketMs: number): D.TimelinePoint[] {
    return QS.getSessionTimeline(this.db, sessionId, bucketMs);
  }

  searchComments(q: D.CommentSearchQuery): D.Page<D.CommentHit> {
    return QC.searchComments(this.db, q, this.caps.fts5);
  }

  listViewerGifts(userId: UserId, q: D.Paged): D.Page<D.GiftRow> {
    return QC.listViewerGifts(this.db, userId, q);
  }

  getViewerLikeSeries(userId: UserId, limitSessions: number): D.LikeSeriesPoint[] {
    return QC.getViewerLikeSeries(this.db, userId, limitSessions);
  }

  // ── P1 analytics ──────────────────────────────────────────────────────────

  recomputeScores(opts: D.RecomputeOpts): number {
    if (opts.full) return QA.recomputeAllScores(this.db, this.scoring, opts.onProgress);
    if (opts.sessionId != null) return QA.applySessionScores(this.db, opts.sessionId, this.scoring);
    return QA.retierAll(this.db, this.scoring);
  }

  getLeaderboard(q: D.LeaderboardQuery): D.Page<D.LeaderboardRow> {
    return QA.getLeaderboard(this.db, q, this.scoring.halfLifeDays);
  }

  getChurnCandidates(q: D.ChurnQuery): D.ChurnRow[] {
    return QA.getChurnCandidates(this.db, q);
  }

  getHourWeekdayMatrix(q: D.MatrixQuery): D.MatrixCell[] {
    return QA.getHourWeekdayMatrix(this.db, q);
  }

  getMissionInputs(cfg: D.MissionConfig, sessionId: number | null): D.MissionInputs {
    return QA.getMissionInputs(this.db, cfg, sessionId);
  }

  // ── settings / files ──────────────────────────────────────────────────────

  getSetting<T>(key: string): T | null {
    const r = this.db.prepare('SELECT value FROM app_setting WHERE key = ?').get(key) as { value: string } | undefined;
    if (!r) return null;
    try {
      return JSON.parse(r.value) as T;
    } catch {
      return null;
    }
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(`INSERT INTO app_setting (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
      .run(key, JSON.stringify(value));
  }

  exportCsv(spec: D.CsvExportSpec, outPath: string, onProgress?: (rows: number) => void): number {
    return exportCsv(this.db, spec, outPath, onProgress);
  }

  backupTo(outPath: string): void {
    backupTo(this.db, outPath);
  }

  purge(spec: D.PurgeSpec): D.PurgeResult {
    const res = purge(this.db, spec);
    this.reloadBlocklist();
    if (spec.scope !== 'viewer') QA.retierAll(this.db, this.scoring);
    return res;
  }

  rebuildLifetime(): void {
    rebuildLifetime(this.db);
  }

  diagnostics(): Omit<D.DiagnosticsInfo, 'quota' | 'gitSha' | 'buildTime' | 'appVersion'> {
    const tables = [
      'viewer',
      'stream_session',
      'comment',
      'gift_event',
      'like_bucket',
      'join_event',
      'social_event',
      'viewer_session_stat',
    ];
    const rowCounts: Record<string, number> = {};
    for (const t of tables) {
      rowCounts[t] = Number((this.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c);
    }
    let dbSizeBytes = 0;
    try {
      dbSizeBytes = statSync(this.caps.dbPath).size;
    } catch {
      /* ignore */
    }
    const unknownEventCounts = (
      this.db.prepare('SELECT lib_type, count FROM unknown_event ORDER BY count DESC LIMIT 50').all() as Array<{
        lib_type: string;
        count: number;
      }>
    ).map((r) => ({ libType: r.lib_type, count: Number(r.count) }));
    return { capabilities: this.caps, unknownEventCounts, dbSizeBytes, rowCounts };
  }

  /** Escape hatch for the replay harness's golden-dump comparison. */
  rawAll(sql: string): unknown[] {
    return this.db.prepare(sql).all() as unknown[];
  }
}
