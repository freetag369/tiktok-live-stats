import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test as base, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

// package.json は "type": "commonjs" で、Playwright も CJS へ変換して読み込む。
// import.meta は使えないので __filename を基点にする(__dirname と同じ理由)。
const require_ = createRequire(__filename);
/** electron の Node 側 export は実行ファイルのパス文字列。 */
const ELECTRON_BIN = require_('electron') as unknown as string;
const APP_ROOT = resolve(__dirname, '..');

/**
 * ⚠️ このハーネスの最重要要件は「ユーザーの実データを壊さないこと」。
 *
 * 隔離は Chromium の `--user-data-dir` で行う。src/main/paths.ts は
 * `app.getPath('userData')` をモジュール評価時に捕まえるので、このスイッチを
 * 渡すだけで settings.json / analytics.db / logs / 単一インスタンスロックが
 * すべて temp 配下へ移る。プロダクションコードの変更はゼロ。
 *
 * **PORTABLE_EXECUTABLE_DIR を使ってはいけない。** isPortable=true にしても
 * INSTALLED_USER_DATA はリダイレクト前の値(= ユーザーの実 %APPDATA%)のままで
 * (paths.ts の "Deliberately the pre-redirect path")、findExistingDb がそれを
 * 返し、dialogs.ts の offerAdoptDb が **「既存のデータを使う」を既定ボタンにした
 * 実DB採用モーダル**を開く。E2E がそれを閉じると本番DBに書き込む。
 */
async function assertIsolated(app: ElectronApplication, dataDir: string): Promise<void> {
  const actual = (await app.evaluate(({ app: a }) => a.getPath('userData'))) as string;
  if (!actual.startsWith(dataDir)) {
    await app.close().catch(() => undefined);
    throw new Error(
      'E2E 中断: userData の隔離に失敗しました。\n' +
        `  期待: ${dataDir}\n  実際: ${actual}\n` +
        'ユーザーの実際の設定・データベースを壊す可能性があるため起動を打ち切ります。'
    );
  }
}

/**
 * 部分 settings.json を temp の config/ へ置く。loadSettings は
 * sanitizeSettings(defaults, raw) を通すので部分で足りるが、**欠損キーは
 * DEFAULT_CHALLENGE へ倒れる**(resources/challenge-default.json ではない)ので、
 * 決定性に効くものは全部明示する。
 */
export function seedSettings(dataDir: string, patch: Record<string, unknown> = {}): void {
  const cfgDir = join(dataDir, 'config');
  mkdirSync(cfgDir, { recursive: true });
  const body = {
    // 無いと from=0 とみなされ migrateChallengeConfig が設定を書き換える。
    // SETTINGS_VERSION と同値にしておくこと(古いままだと移行段が走る)。
    settingsVersion: 10,
    eulerApiKey: '',
    hostUniqueId: 'e2e-host',
    waitUntilLive: false,
    // アバターの外部 fetch を止める(CI にネットワークを期待しない)。
    loadAvatars: false,
    captureDebug: false,
    challenge: {
      enabled: true,
      title: 'E2E カウントダウン',
      initialValue: 100,
      pressStep: 1,
      followStep: 10,
      likeEvery: 0,
      likeStep: 1,
      likeStockCount: 0,
      giftDefault: { mode: 'perDiamond', amount: 1 },
      giftRules: [],
      commentRules: [],
      // ── 決定性: 凍結を張る機能を全部落とす。既定はどれも true なので明示が要る。
      roulettes: [],
      joinRoulette: { enabled: false },
      giftBandFx: { enabled: false, bands: [] },
      giftFullCut: { enabled: false, rules: [] },
      tapBoost: { enabled: false, rules: [] },
      // 革命も明示的に落とす。既定は OFF だが、行(白鳥)は配られるので明示して
      // おく — 既定が将来 ON になったとき、いいね妨害が反転して全テストの
      // 「いいねで +N 増える」前提が静かに壊れるのを防ぐ(tapBoost と同じ規約)。
      revolution: { enabled: false, rules: [] },
      fanStamp: { enabled: false },
      stampTriggers: { enabled: false, rules: [] },
      fxClipsEnabled: false,
      miniFxEnabled: false,
      seEnabled: false,
      // ── 窓の形。DEFAULT_CHALLENGE.monitorWindowed は false なので必須
      //    (開発機のマルチディスプレイでは全画面になってしまう)。
      monitorWindowed: true,
      monitorDisplayId: null,
      // ホットキーは Playwright から発火できない(OS レベル)。登録自体を止めて
      // 常駐アプリとの衝突による偽の警告トーストを避ける。
      hotkey: '',
      wakeEnabled: false,
      lowThreshold: 10,
      // 最終ゲートは既定オン(欠損は有効へ倒れる)なので明示的に落とす —
      // lowThreshold 以下へ削るテストの「press 1回 = 1減」の決定性を守る。
      // ゲートそのものの検証は countdown-final-gate.e2e.ts が有効化する。
      finalGate: { enabled: false, taps: 30 },
    },
    ...patch,
  };
  writeFileSync(join(cfgDir, 'settings.json'), JSON.stringify(body, null, 2), 'utf8');
}

/** env は渡すと全置換なので process.env をベースに、危険なものだけ落とす。 */
function buildEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue;
    // 開発者のシェルに残っていると isPortable が true になり隔離が壊れる。
    if (k === 'PORTABLE_EXECUTABLE_DIR') continue;
    // dev サーバの取り違え防止(out/ を起動する前提)。
    if (k === 'ELECTRON_RENDERER_URL') continue;
    out[k] = v;
  }
  out.ELECTRON_ENABLE_LOGGING = '1';
  out.E2E = '1';
  return out;
}

/**
 * 同じ dataDir でアプリをもう一度起動する(再起動の検証用)。
 * 隔離ガードは launch と同じものを通す。
 */
export async function relaunch(dataDir: string, reducedMotion = true): Promise<ElectronApplication> {
  const app = await launch(dataDir, reducedMotion);
  await assertIsolated(app, dataDir);
  return app;
}

async function launch(dataDir: string, reducedMotion: boolean): Promise<ElectronApplication> {
  return electron.launch({
    executablePath: ELECTRON_BIN,
    cwd: APP_ROOT,
    args: [
      APP_ROOT, // package.json main = ./out/main/index.js
      `--user-data-dir=${dataDir}`,
      // fxAllowed() = monitorOpen && bandFx を構造的に false に落とす。
      // カットイン凍結が起きないので「ギフト N 件 → 値がちょうど M」が決定的になる。
      // **演出そのもの**を見るテスト(シネマティックのブースト)だけ false にする。
      ...(reducedMotion ? ['--force-prefers-reduced-motion'] : []),
      '--mute-audio',
      '--disable-dev-shm-usage',
      ...(process.env.CI && process.platform === 'linux' ? ['--no-sandbox', '--disable-gpu'] : []),
    ],
    env: buildEnv(),
    timeout: 60_000,
  });
}

/** Windows は sqlite のハンドル解放が遅れることがあるのでリトライして諦める。 */
function rmWithRetry(dir: string): void {
  for (let i = 0; i < 3; i += 1) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch {
      /* 次の試行へ */
    }
  }
}

type Opts = {
  /**
   * `--force-prefers-reduced-motion` を渡すか(既定 true)。
   * true = fxAllowed() が常に false → カットイン凍結が起きず値が決定的。
   * 演出そのもの(シネマティックのブースト段)を見るテストだけ false にする。
   */
  reducedMotion: boolean;
  /** seedSettings に重ねる差分。challenge を丸ごと差し替える形で渡す。 */
  settingsPatch: Record<string, unknown>;
};

type Fx = {
  dataDir: string;
  app: ElectronApplication;
  main: Page;
};

export const test = base.extend<Opts & Fx>({
  reducedMotion: [true, { option: true }],
  settingsPatch: [{}, { option: true }],

  dataDir: async ({ settingsPatch }, use) => {
    const dir = mkdtempSync(join(tmpdir(), 'tls-e2e-'));
    seedSettings(dir, settingsPatch);
    await use(dir);
    rmWithRetry(dir);
  },

  app: async ({ dataDir, reducedMotion }, use) => {
    if (!existsSync(join(APP_ROOT, 'out', 'main', 'index.js'))) {
      throw new Error('out/ が見つかりません。`npm run build` を先に実行してください(npm run test:e2e は自動で行います)。');
    }
    const app = await launch(dataDir, reducedMotion);
    // 何かを触る前に。ここで throw すれば以降は1行も走らない。
    await assertIsolated(app, dataDir);
    await use(app);
    // before-quit が host.shutdown() を await するので、固まった場合に備えて上限を切る。
    await Promise.race([app.close(), new Promise((r) => setTimeout(r, 15_000))]).catch(() => undefined);
  },

  main: async ({ app }, use) => {
    const page = await app.firstWindow({ timeout: 30_000 });
    await page.waitForLoadState('domcontentloaded');
    await use(page);
  },
});

/**
 * モニター窓を開いて Page を返す。
 *
 * `waitForEvent('window')` の Promise は **RPC を撃つ前に**作ること —
 * 撃ってから待つと、窓が先に生まれた場合にイベントを取りこぼす。
 */
export async function openMonitor(app: ElectronApplication, main: Page): Promise<Page> {
  const pending = app.waitForEvent('window', { timeout: 30_000 });
  await main.evaluate(() =>
    (window as unknown as { api: { rpc(m: string, p: unknown): Promise<unknown> } }).api.rpc('monitor.open', undefined)
  );
  const mon = await pending;
  await mon.waitForLoadState('domcontentloaded');
  // 「読み込み中…」が消える = challenge.get が解決した。
  await expect(mon.locator('.stage-viewport.idle-hint')).toHaveCount(0, { timeout: 20_000 });

  // 全画面になっていないことを main プロセス側で確認する。
  // CDP アタッチ方式では原理的に取れない情報 — _electron.launch を選ぶ理由の1つ。
  const bw = await app.browserWindow(mon);
  const full = await bw.evaluate((w: { isFullScreen(): boolean; isSimpleFullScreen?: () => boolean }) =>
    w.isFullScreen() || (w.isSimpleFullScreen?.() ?? false)
  );
  expect(full, 'E2E ではモニターを全画面にしない(monitorWindowed: true)').toBe(false);
  return mon;
}

/** モニターの7セグが表示している値。SevenSeg の aria-label が生の数字。 */
export async function segValue(monitor: Page): Promise<number> {
  const label = await monitor.locator('.countdown .seg-row').getAttribute('aria-label');
  return Number(label);
}

export { expect };
