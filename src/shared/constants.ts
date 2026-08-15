/** Tunables shared by all three processes. Changing these changes behaviour, not just numbers. */

/** DB write batch cadence. Every flush is one BEGIN IMMEDIATE…COMMIT. */
export const FLUSH_MS = 250;
export const FLUSH_MAX_BATCH = 500;

/**
 * Likes are bucketed per (session, user, 60s) at ingest, or the table dwarfs
 * everything else. アプリ内でこのテーブルを読む機能は無い(CSVエクスポートの
 * 粒度にのみ影響)。10s→60s で長時間配信の行数・upsert 負荷を約1/6にした。
 */
export const LIKE_BUCKET_MS = 60_000;

/**
 * like_seen(いいね二重計上ガード)の保持期間と掃除間隔。dedupe が守るのは
 * 再接続バックログの再生(数分)+ SESSION_RESUME_GAP_MS(10分)だけなので、
 * 30分より古い行は捨てても安全 — 残すと耐久配信でいいね1件=1行のまま育つ。
 */
export const LIKE_SEEN_TTL_MS = 30 * 60_000;
export const LIKE_SEEN_PRUNE_EVERY_MS = 10 * 60_000;

/**
 * ミッション再計算の間隔。同期SQL5本(7日窓の COUNT(DISTINCT) 込み)なので
 * pushDelta = 押下の即時反映経路からは追い出し、この間隔の専用タイマーで回す。
 * ミッションは分単位で動く数字なので、この程度の遅れは体感に出ない。
 */
export const MISSIONS_CHECK_MS = 3000;

/** Aggregate deltas pushed to the renderer. 2 Hz visible, 0.5 Hz when the window is hidden. */
export const DELTA_MS = 500;
export const DELTA_MS_HIDDEN = 2000;
/**
 * challenge.press の nudge(全ウィンドウへの即時 delta)の間引き間隔。
 * フィーバー中の連打は数十Hz になりうるので、押した本人への戻り値はそのまま、
 * ブロードキャストだけこの間隔に畳む(session.nudgeChallengeCoalesced)。
 */
export const CHALLENGE_PRESS_NUDGE_MS = 80;
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
 * ApplyCtx.lastJoinMs をこの件数を超えたら掃除する。中身は入室デバウンスの
 * タイムスタンプだけで、JOIN_DEBOUNCE_MS より古い行は二度と読まれない。
 */
export const LAST_JOIN_PRUNE_AT = 2000;

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
/** cfg.set 直後の設定全量プッシュ。モニターの保険ポーリング(CFG_POLL_MS)を待たずに反映する。 */
export const CH_SETTINGS_PUSH = 'app:settings';

/**
 * モニター窓の設定/チャレンジ再取得の保険ポーリング間隔。保存(cfg.set)は
 * CH_SETTINGS_PUSH の即時プッシュで届くので、これは取りこぼしの保険 —
 * モニター窓は backgroundThrottling 無効で常時フル稼働のため、保険の RPC を
 * 刻むほど長時間配信の負荷になる(30秒 → 120秒に延ばした経緯)。
 */
export const CFG_POLL_MS = 120_000;

/**
 * 生ダッシュボードの視聴者テーブルの取得件数。
 *
 * **仮想化で実際に描画されるのは可視 ~30 行だけ**(ViewerTable の useVirtualizer)
 * なのに、以前はここが 5000 だった。所要時間は取得件数にほぼ比例し、実DB
 * (viewer 11,971行)での実測は 5000件=43.5ms / 1000件=7.3ms / 300件=2.2ms。
 * worker は単一スレッドで node:sqlite も同期なので、**その間 challenge.press は
 * 配送すらされない** = カウントボタンが効かない時間そのものになる。
 *
 * 1000 なのは「1配信のユニーク視聴者(実測 約1,100人)と現実のスクロール量を
 * 確実に超える」ため — **追記式ページングのUIがまだ無いので、ここを下げすぎると
 * 「スクロールしてもそれ以上出てこない」が黙って起きる**。ページングを入れたら
 * 300(=2.2ms)まで下げてよい。
 */
export const VIEWER_PAGE_SIZE = 1000;
