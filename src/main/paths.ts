import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { app } from 'electron';

/**
 * The portable build and the installed build would otherwise keep two separate
 * databases: a user who trials the portable exe for a month and then installs the
 * NSIS build silently loses that month. `findExistingDb` powers the first-run
 * offer to adopt whichever one already exists.
 */
export const isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR);

/**
 * Electron's userData path as it is BEFORE we redirect it.
 *
 * Captured at module load because portable mode calls app.setPath('userData', …);
 * after that, asking Electron where userData is only ever returns the portable
 * folder — so the installed build's database becomes undiscoverable and a user
 * switching to the portable exe is told, wrongly, that they have no history.
 */
const INSTALLED_USER_DATA = app.getPath('userData');

export function defaultDataDir(): string {
  if (isPortable) return join(process.env.PORTABLE_EXECUTABLE_DIR as string, 'TikTokLiveStats-data');
  return INSTALLED_USER_DATA;
}

export function dbPathIn(dataDir: string): string {
  return join(dataDir, 'db', 'analytics.db');
}

export function configDirIn(dataDir: string): string {
  const d = join(dataDir, 'config');
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * extraResources places `resources/` at <resourcesPath>/app-resources in a
 * packaged build; in dev it is just the repo folder.
 */
export function resourcesDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'app-resources') : resolve(app.getAppPath(), 'resources');
}

export function docsPath(name: string): string {
  return app.isPackaged ? join(process.resourcesPath, name) : resolve(app.getAppPath(), name);
}

/**
 * The worker is an ESM entry loaded by utilityProcess.fork. It is always
 * asarUnpack'd: Node's ESM loader resolving through Electron's asar fs patches is
 * the highest-risk unknown in this stack, and the unpacked path removes it.
 */
export function workerEntry(): string {
  const appPath = app.getAppPath();
  if (appPath.includes('app.asar')) {
    return join(appPath.replace('app.asar', 'app.asar.unpacked'), 'out', 'worker', 'index.mjs');
  }
  return join(appPath, 'out', 'worker', 'index.mjs');
}

/** Both candidate locations, so first run can offer to adopt an existing database. */
export function findExistingDb(): { portable: string | null; installed: string | null } {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR
    ? join(process.env.PORTABLE_EXECUTABLE_DIR, 'TikTokLiveStats-data')
    : null;
  const p = portableDir ? dbPathIn(portableDir) : null;
  // Deliberately the pre-redirect path — see INSTALLED_USER_DATA above.
  const i = dbPathIn(INSTALLED_USER_DATA);
  return { portable: p && existsSync(p) ? p : null, installed: existsSync(i) ? i : null };
}
