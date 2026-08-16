import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ZOOM_FACTOR, SETTINGS_VERSION, type AppSettings, type ChallengeConfig } from '@shared/dto';
import { DEFAULT_CHALLENGE, migrateChallengeConfig, validateChallengeConfig } from '@shared/challenge';
import { DEFAULT_DASH_LAYOUT, normalizeDashLayout } from '@shared/dash-layout';
import { DEFAULT_SCORING, validateScoringConfig } from '@shared/scoring';
import { configDirIn, dbPathIn, resourcesDir } from './paths';

/**
 * A small JSON file read BEFORE the worker starts, because it decides where the
 * database lives and which API key the sign client is constructed with. It cannot
 * live inside the database it selects.
 */
export function defaultSettings(dataDir: string): AppSettings {
  return {
    eulerApiKey: '',
    hostUniqueId: '',
    waitUntilLive: false,
    diamondToJpy: 0.5,
    loadAvatars: true,
    captureDebug: false,
    retentionDays: null,
    scoring: DEFAULT_SCORING,
    dbPath: dbPathIn(dataDir),
    minimizeToTray: false,
    alertMinTier: 1,
    giftAlertDiamonds: 100,
    zoomFactor: DEFAULT_ZOOM_FACTOR,
    dashLayout: [...DEFAULT_DASH_LAYOUT],
    // デフォ保存(challenge-default.json)があればそれが既定 — 新しいPCへファイルを
    // コピーするだけで、初回起動からその内容で立ち上がる。
    challenge: loadChallengeDefault(dataDir) ?? { ...structuredClone(DEFAULT_CHALLENGE), hotkey: defaultHotkey() },
    // 新規インストールは既に最新の既定なので移行対象にしない。
    settingsVersion: SETTINGS_VERSION,
  };
}

/**
 * 既定のグローバルホットキー。mac の F9 は Mac キーボードでは早送りのメディアキーで、
 * 「F1、F2 などのキーを標準のファンクションキーとして使用」が OFF(既定)だと F9 が
 * アプリまで届かない — globalShortcut.register は成功するのに一度も発火しないという
 * 一番わかりにくい壊れ方をする。mac だけ F キー行を避けた組み合わせを既定にする。
 * 既存の settings.json は書き換えない(loadSettings が保存値を優先するため)。
 */
function defaultHotkey(): string {
  return process.platform === 'darwin' ? 'Control+Alt+9' : 'F9';
}

/**
 * 既定ファイル(同梱デフォ・デフォ保存)にプラットフォーム差を当てる。
 *
 * どちらも**全プラットフォーム共通の1ファイル**で、Windows で書かれたものが
 * そのまま mac へ配布・コピーされる。ファイル側では mac を表現できないので、
 * 差は読み込んだ後にコードで当てるしかない — これが無いと同梱デフォの 'F9' が
 * 必ず勝ち、defaultHotkey() は一度も到達しないまま mac の既定が死んだキーになる。
 *
 * 触るのは**組み込み既定(F9)のままの値だけ**。ファイルに別の値が入っていれば
 * それは意図して選ばれた割り当てなので尊重する。逆に「mac で意図して F9 を選んだ」
 * 場合と F9 のままの既定は区別できないが、当たるのは settings.json がまだ無い時の
 * 初期値と「既定に戻す」の戻り先だけで、UI から選び直せばその値が保存され以後優先される。
 */
function withPlatformHotkey(cfg: ChallengeConfig): ChallengeConfig {
  if (cfg.hotkey !== DEFAULT_CHALLENGE.hotkey) return cfg;
  const hotkey = defaultHotkey();
  return hotkey === cfg.hotkey ? cfg : { ...cfg, hotkey };
}

function file(dataDir: string): string {
  return join(configDirIn(dataDir), 'settings.json');
}

/**
 * 入力元を問わない設定の防御。settings.json の手編集も UI からの cfg.set も
 * 同じ関数を通す — 不正値は base(既定 or 現在値)へフォールバックし、負の重みや
 * 範囲外 zoom がスコア計算・表示に永続化されるのを防ぐ。
 */
export function sanitizeSettings(base: AppSettings, raw: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...raw,
    // Never trust a hand-edited weights block into the scoring engine.
    scoring: validateScoringConfig(raw.scoring ?? base.scoring),
    dbPath: typeof raw.dbPath === 'string' && raw.dbPath ? raw.dbPath : base.dbPath,
    diamondToJpy: Number.isFinite(raw.diamondToJpy) ? Number(raw.diamondToJpy) : base.diamondToJpy,
    alertMinTier: Number.isFinite(raw.alertMinTier) ? Number(raw.alertMinTier) : base.alertMinTier,
    giftAlertDiamonds: Number.isFinite(raw.giftAlertDiamonds) ? Number(raw.giftAlertDiamonds) : base.giftAlertDiamonds,
    // A corrupt value here would render the app unusable, so clamp rather than trust.
    zoomFactor: Number.isFinite(raw.zoomFactor) ? Math.min(2.5, Math.max(0.6, Number(raw.zoomFactor))) : base.zoomFactor,
    // 壊れた並びでダッシュボードのパネルが消えるより、既定順へ戻る方がまし。
    dashLayout: normalizeDashLayout(raw.dashLayout ?? base.dashLayout),
    // 手編集された値をそのままエンジンへ入れない — throw せずサニタイズ。
    challenge: validateChallengeConfig(raw.challenge ?? base.challenge),
  };
}

export function loadSettings(dataDir: string): AppSettings {
  const d = defaultSettings(dataDir);
  const p = file(dataDir);
  if (!existsSync(p)) return d;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AppSettings>;
    // 世代は sanitize の前に raw から読む — sanitizeSettings は base(= 最新世代の既定)を
    // スプレッドするので、通したあとでは「印の無い古いファイル」を見分けられなくなる。
    const from = typeof raw.settingsVersion === 'number' ? raw.settingsVersion : 0;
    const s = sanitizeSettings(d, raw);
    // 移行はメモリ上だけ。ここで保存しないのは、起動のたびに settings.json を書かないため。
    // 次に UI から何か保存された時点で settingsVersion ごと永続化される(sanitizeSettings の
    // base スプレッドが運ぶ)ので、ユーザーが旧既定を選び直しても再移行はされない。
    return { ...s, settingsVersion: SETTINGS_VERSION, challenge: migrateChallengeConfig(s.challenge, from) };
  } catch {
    return d;
  }
}

export function saveSettings(dataDir: string, s: AppSettings): void {
  // temp + rename: 書き込み途中の電断で settings.json が壊れると全設定
  // (APIキー・dbPath 含む)が既定に巻き戻るため、直接上書きしない。
  const p = file(dataDir);
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  renameSync(tmp, p);
}

/**
 * 「デフォ保存」 — チャレンジ設定の既定値ファイル(config/challenge-default.json)。
 * settings.json とは別のファイルに全量を保存し、存在すれば同梱既定
 * (DEFAULT_CHALLENGE)の代わりに既定として使う。用途は2つ:
 * - 「チャレンジ設定をすべて既定に戻す」の戻り先になる(自分好みの既定)。
 * - ファイルを**他のPCの同じ場所へコピーするだけ**で、そのPCでも同じ内容が
 *   既定になる(初回起動はこの内容で立ち上がる)。
 *
 * さらに resources/challenge-default.json(リポジトリ同梱・GitHub 公開)を
 * 第2候補として読む — 配布物だけで公開デフォが全ユーザーに行き渡る。
 * ユーザー自身のデフォ保存は常にそれより優先される。
 */
export function challengeDefaultPath(dataDir: string): string {
  return join(configDirIn(dataDir), 'challenge-default.json');
}

export function loadChallengeDefault(dataDir: string): ChallengeConfig | null {
  // 優先順: ①ユーザーのデフォ保存(config/) → ②同梱の公開デフォ(resources/、
  // リポジトリにコミットされ GitHub・全配布物に入る)→ ③null(= DEFAULT_CHALLENGE)。
  // ②があるので、配布物を受け取った人は初回起動から公開デフォで立ち上がる。
  const candidates = [challengeDefaultPath(dataDir), join(resourcesDir(), 'challenge-default.json')];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<ChallengeConfig> & { settingsVersion?: number };
      // 世代印は settings.json と同じ扱い — 古いアプリで作られたファイルにも新既定の移行を配る。
      const from = typeof raw.settingsVersion === 'number' ? raw.settingsVersion : 0;
      // ホットキーだけは読み込み後にプラットフォーム差を当てる(withPlatformHotkey 参照)。
      return withPlatformHotkey(migrateChallengeConfig(validateChallengeConfig(raw as ChallengeConfig), from));
    } catch {
      // 壊れたファイルで起動不能にしない — 次の候補へフォールバック。
    }
  }
  return null;
}

/**
 * ユーザーのデフォ保存を削除して、同梱の公開デフォ(無ければ組み込み既定)へ戻す。
 * 「同梱デフォで更新」ボタンの実体 — ユーザーのファイルが常に同梱より優先されるため、
 * 公開デフォの新しい内容を受け取るにはこの削除が唯一の道。戻り値は「実際に消したか」。
 */
export function clearChallengeDefault(dataDir: string): boolean {
  const p = challengeDefaultPath(dataDir);
  if (!existsSync(p)) return false;
  rmSync(p);
  return true;
}

/** 検証(clamp)してから書く。戻り値は保存先パス(トーストでユーザーに見せる)。 */
export function saveChallengeDefault(dataDir: string, cfg: ChallengeConfig): string {
  const p = challengeDefaultPath(dataDir);
  const tmp = `${p}.tmp`;
  // validateChallengeConfig は明示リテラル return なので settingsVersion キーは残らない —
  // 先頭に付け直して世代印だけ運ぶ(loadChallengeDefault が読み、validate が捨てる)。
  const body = { settingsVersion: SETTINGS_VERSION, ...validateChallengeConfig(cfg) };
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8');
  renameSync(tmp, p);
  return p;
}

/**
 * Changing these requires a worker restart: the database handle is opened once,
 * and Euler's SignConfig is process-global and cached on first use — restarting
 * is deterministic where cache-invalidation guesswork is not.
 */
export function needsWorkerRestart(prev: AppSettings, next: AppSettings): boolean {
  return prev.eulerApiKey !== next.eulerApiKey || prev.dbPath !== next.dbPath;
}
