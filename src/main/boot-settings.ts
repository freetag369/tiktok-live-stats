import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppSettings } from '@shared/dto';
import { DEFAULT_CHALLENGE, validateChallengeConfig } from '@shared/challenge';
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
    zoomFactor: 1,
    challenge: structuredClone(DEFAULT_CHALLENGE),
  };
}

function file(dataDir: string): string {
  return join(configDirIn(dataDir), 'settings.json');
}

export function loadSettings(dataDir: string): AppSettings {
  const d = defaultSettings(dataDir);
  const p = file(dataDir);
  if (!existsSync(p)) return d;
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8')) as Partial<AppSettings>;
    return {
      ...d,
      ...raw,
      // Never trust a hand-edited weights block into the scoring engine.
      scoring: validateScoringConfig(raw.scoring ?? d.scoring),
      dbPath: typeof raw.dbPath === 'string' && raw.dbPath ? raw.dbPath : d.dbPath,
      diamondToJpy: Number.isFinite(raw.diamondToJpy) ? Number(raw.diamondToJpy) : d.diamondToJpy,
      alertMinTier: Number.isFinite(raw.alertMinTier) ? Number(raw.alertMinTier) : d.alertMinTier,
      giftAlertDiamonds: Number.isFinite(raw.giftAlertDiamonds) ? Number(raw.giftAlertDiamonds) : d.giftAlertDiamonds,
      // A corrupt value here would render the app unusable, so clamp rather than trust.
      zoomFactor: Number.isFinite(raw.zoomFactor) ? Math.min(2.5, Math.max(0.6, Number(raw.zoomFactor))) : d.zoomFactor,
      // 手編集された値をそのままエンジンへ入れない — throw せずサニタイズ。
      challenge: validateChallengeConfig(raw.challenge ?? d.challenge),
    };
  } catch {
    return d;
  }
}

export function saveSettings(dataDir: string, s: AppSettings): void {
  writeFileSync(file(dataDir), JSON.stringify(s, null, 2), 'utf8');
}

/**
 * Changing these requires a worker restart: the database handle is opened once,
 * and Euler's SignConfig is process-global and cached on first use — restarting
 * is deterministic where cache-invalidation guesswork is not.
 */
export function needsWorkerRestart(prev: AppSettings, next: AppSettings): boolean {
  return prev.eulerApiKey !== next.eulerApiKey || prev.dbPath !== next.dbPath;
}
