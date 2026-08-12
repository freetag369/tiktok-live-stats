/** Tunables shared by all three processes. Changing these changes behaviour, not just numbers. */

/** DB write batch cadence. Every flush is one BEGIN IMMEDIATE…COMMIT. */
export const FLUSH_MS = 250;
export const FLUSH_MAX_BATCH = 500;

/** Likes are bucketed per (session, user, 10s) at ingest, or the table dwarfs everything else. */
export const LIKE_BUCKET_MS = 10_000;

/** Aggregate deltas pushed to the renderer. 2 Hz visible, 0.5 Hz when the window is hidden. */
export const DELTA_MS = 500;
export const DELTA_MS_HIDDEN = 2000;
/** A single delta never carries more than this many viewers; the rest slide to the next tick. */
export const DELTA_MAX_VIEWERS = 800;

/** Comment/gift/join feed. Likes NEVER enter the feed. */
export const FEED_MS = 250;
export const FEED_MAX_ITEMS = 40;

/** session_metric rows are throttled to one per this interval. */
export const SESSION_METRIC_MS = 5000;

/** MEMBER can re-fire for the same viewer (app switch, network blip). Debounce visit counting. */
export const JOIN_DEBOUNCE_MS = 60_000;

/**
 * Reconnecting within this window to the same room_id resumes the same session
 * instead of splitting one broadcast into two rows.
 */
export const SESSION_RESUME_GAP_MS = 10 * 60_000;

/** RPC timeout enforced in main. */
export const RPC_TIMEOUT_MS = 15_000;

/** Scoring epoch — 2026-01-01T00:00:00+09:00. Changing this invalidates every stored score_e. */
export const SCORE_EPOCH_MS = Date.UTC(2025, 11, 31, 15, 0, 0);

export const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const DAY_MS = 86_400_000;

/** Euler Stream sign server. One request per connect attempt. */
export const EULER_BASE_URL = 'https://api.eulerstream.com';
export const EULER_RATE_LIMIT_URL = `${EULER_BASE_URL}/webcast/rate_limits`;
/** Stop offline-polling once this fraction of the daily quota is gone. */
export const QUOTA_STOP_FRACTION = 0.8;

/**
 * waitUntilLive poll interval — every check costs one signature request.
 *
 * With a free API key the budget is 2,500/day, so 3 minutes is comfortable
 * (~20/hour). WITHOUT a key the budget is 100/day and 30/hour: at 3 minutes a
 * single 90-minute wait would exhaust the hourly cap and a 5-hour wait the whole
 * day, leaving nothing for the actual broadcast. Hence the much slower cadence
 * when unauthenticated — a stream is not missed by checking every 10 minutes.
 */
export const OFFLINE_POLL_SEC = 180;
export const OFFLINE_POLL_SEC_NO_KEY = 600;
export const OFFLINE_MAX_WAIT_MS = 4 * 60 * 60 * 1000;

/** Reconnect backoff (full jitter), seconds. */
export const BACKOFF_STEPS_SEC = [5, 10, 20, 40, 80, 160, 300];
export const BACKOFF_MAX_ATTEMPTS = 12;

/** IPC channel names. */
export const CH_RPC = 'rpc';
export const CH_FEED_PORT = 'feed-port';
export const CH_WORKER_STATE = 'app:worker-state';
export const CH_TOAST = 'app:toast';
export const CH_VISIBILITY = 'ui:visibility';
export const CH_MONITOR_STATE = 'app:monitor-state';
/** cfg.set 直後の設定全量プッシュ。モニターの30秒ポーリングを待たずに反映する。 */
export const CH_SETTINGS_PUSH = 'app:settings';

/** Viewer table page size on the live dashboard. */
export const VIEWER_PAGE_SIZE = 5000;
