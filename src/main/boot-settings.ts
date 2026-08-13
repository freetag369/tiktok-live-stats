import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_ZOOM_FACTOR, SETTINGS_VERSION, type AppSettings } from '@shared/dto';
import { DEFAULT_CHALLENGE, migrateChallengeSeSounds, validateChallengeConfig } from '@shared/challenge';
import { DEFAULT_SCORING, validateScoringConfig } from '@shared/scoring';
import { configDirIn, dbPathIn } from './paths';

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
    challenge: { ...structuredClone(DEFAULT_CHALLENGE), hotkey: defaultHotkey() },
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
    return { ...s, settingsVersion: SETTINGS_VERSION, challenge: migrateChallengeSeSounds(s.challenge, from) };
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
 * Changing these requires a worker restart: the database handle is opened once,
 * and Euler's SignConfig is process-global and cached on first use — restarting
 * is deterministic where cache-invalidation guesswork is not.
 */
export function needsWorkerRestart(prev: AppSettings, next: AppSettings): boolean {
  return prev.eulerApiKey !== next.eulerApiKey || prev.dbPath !== next.dbPath;
}
