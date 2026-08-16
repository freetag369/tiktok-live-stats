import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import { SETTINGS_VERSION, type AppSettings, type ChallengeConfig } from '@shared/dto';
import {
  challengeDefaultPath,
  clearChallengeDefault,
  defaultSettings,
  loadChallengeDefault,
  loadSettings,
  needsWorkerRestart,
  saveChallengeDefault,
  saveSettings,
} from '@main/boot-settings';

/**
 * settings.json の実ファイル入出力。
 *
 * これまで検証されていたのは `validateChallengeConfig` / `migrateChallengeConfig` の
 * **純関数だけ**で、それを呼ぶファイル I/O 層はゼロカバーだった。ここが壊れると
 * 「アプリを起動しただけで API キーと全設定が既定へ巻き戻る」という、DB より
 * 復旧しにくい事故になる(設定はバックアップ対象にしていない)。
 *
 * electron は test/stubs/electron.ts へ差し替えている(vitest.config.ts の alias)。
 * boot-settings の公開関数はすべて dataDir を引数で取るので、実体は temp dir。
 */
let dir: string;

/** settings.json の生バイトを書く(sanitize を通さない = 手編集や旧版の再現)。 */
function writeRaw(text: string): void {
  const cfgDir = join(dir, 'config');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'settings.json'), text, 'utf8');
}

function settingsPath(): string {
  return join(dir, 'config', 'settings.json');
}

/**
 * process.platform を差し替えて fn を実行する。
 *
 * vi.stubGlobal は globalThis のプロパティにしか効かず、process.platform は
 * process 自身の読み取り専用プロパティなので届かない。defineProperty で直接
 * 置き換え、finally で元の記述子ごと戻す(他のテストへ漏らさない)。
 */
function withPlatform<T>(platform: string, fn: () => T): T {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-cfg-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('loadSettings — 読めないときに落ちない', () => {
  it('ファイルが無ければ既定を返す', () => {
    const s = loadSettings(dir);
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
    expect(s.dbPath).toBe(join(dir, 'db', 'analytics.db'));
  });

  it('既定のホットキーは mac だけ F キー行を避けた値になる(同梱デフォの F9 に上書きされない)', () => {
    // defaultSettings は `loadChallengeDefault(dataDir) ?? {…, hotkey: defaultHotkey()}` で、
    // 同梱の resources/challenge-default.json は**常に存在する**ため左辺が必ず勝つ。
    // 同梱ファイルは全プラットフォーム共通の1ファイルなので mac 用の値を持てず、
    // 差は loadChallengeDefault が読み込んだ後に当てている(withPlatformHotkey)。
    // これが無いと mac の既定が F9(メディアキー)になり、globalShortcut.register は
    // 成功するのに一度も発火しない — 一番わかりにくい壊れ方をする。
    const bundled = JSON.parse(
      readFileSync(join(resolve('resources'), 'challenge-default.json'), 'utf8')
    ) as { hotkey?: string };
    // 差し替えの前提: 同梱ファイルは組み込み既定のまま。ここが別値に編集されたら
    // 「意図した割り当て」とみなして触らない仕様なので、その時はこのテストが気づく。
    expect(bundled.hotkey).toBe(DEFAULT_CHALLENGE.hotkey);

    // 両プラットフォームの分岐を1台のCIで検査する(mac ジョブはタグ push でしか走らない)。
    expect(withPlatform('darwin', () => loadSettings(dir).challenge.hotkey)).toBe('Control+Alt+9');
    expect(withPlatform('win32', () => loadSettings(dir).challenge.hotkey)).toBe('F9');
  });

  it('既定ファイルに明示された別のホットキーは mac でも尊重する', () => {
    // 差し替えるのは「組み込み既定のまま」の値だけ。デフォ保存(config/)は
    // 同梱より優先される経路なので、そこに書かれた明示値が生き残ることを見る。
    saveChallengeDefault(dir, { ...structuredClone(DEFAULT_CHALLENGE), hotkey: 'Control+Shift+P' });
    expect(withPlatform('darwin', () => loadSettings(dir).challenge.hotkey)).toBe('Control+Shift+P');
  });

  it('保存済みの settings.json は mac でも書き換えない(ユーザーの選択が優先)', () => {
    // 差し替えが効くのは「まだユーザーの選択が無い」初期値だけ。保存値まで
    // 触ると、mac で意図して F9 を選んだ人の設定が起動のたびに巻き戻る。
    const challenge = { ...structuredClone(DEFAULT_CHALLENGE), hotkey: 'F9' };
    writeRaw(JSON.stringify({ settingsVersion: SETTINGS_VERSION, challenge }));
    expect(withPlatform('darwin', () => loadSettings(dir).challenge.hotkey)).toBe('F9');
  });

  it('壊れた JSON は既定へ倒れ、ディスク上のファイルは書き換えない', () => {
    writeRaw('{ これは JSON ではない');
    const s = loadSettings(dir);
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
    // ここで保存してしまうと、ユーザーが手で直す前に上書きで消える。
    expect(readFileSync(settingsPath(), 'utf8')).toBe('{ これは JSON ではない');
  });

  it('読めないパス(ディレクトリになっている)でも既定へ倒れる', () => {
    // chmod は Windows で no-op なので、ディレクトリを置いて EISDIR を起こす。
    mkdirSync(join(dir, 'config'), { recursive: true });
    mkdirSync(settingsPath(), { recursive: true });
    const s = loadSettings(dir);
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('正常な移行でもディスクは書き換えない(起動のたびに書かない規約)', () => {
    const raw = JSON.stringify({ hostUniqueId: 'me' });
    writeRaw(raw);
    loadSettings(dir);
    expect(readFileSync(settingsPath(), 'utf8')).toBe(raw);
  });
});

describe('loadSettings — 部分的な設定と壊れた値', () => {
  it('欠損キーは既定で埋まり、書かれた値は生き残る', () => {
    writeRaw(JSON.stringify({ settingsVersion: SETTINGS_VERSION, hostUniqueId: 'me', diamondToJpy: 1.5 }));
    const s = loadSettings(dir);
    expect(s.hostUniqueId).toBe('me');
    expect(s.diamondToJpy).toBe(1.5);
    expect(s.alertMinTier).toBe(1); // 既定
  });

  it('範囲外・型違いの値は既定へ丸められる', () => {
    writeRaw(
      JSON.stringify({
        settingsVersion: SETTINGS_VERSION,
        zoomFactor: 99,
        diamondToJpy: 'いくら？',
        dashLayout: ['存在しないカード'],
      })
    );
    const s = loadSettings(dir);
    expect(s.zoomFactor).toBeLessThanOrEqual(2.5);
    expect(Number.isFinite(s.diamondToJpy)).toBe(true);
    expect(s.dashLayout).not.toContain('存在しないカード');
  });

  it('challenge キーが丸ごと無い旧世代でも既定のチャレンジ設定が入る', () => {
    // v0.2.0 より前の実ファイルがこの形(settingsVersion も challenge も無い)。
    writeRaw(JSON.stringify({ eulerApiKey: '', hostUniqueId: 'old', dbPath: 'x' }));
    const s = loadSettings(dir);
    expect(s.challenge).toBeDefined();
    expect(s.challenge.initialValue).toBe(DEFAULT_CHALLENGE.initialValue);
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
  });
});

describe('loadSettings — 世代の移行', () => {
  it('settingsVersion 欠損は世代0とみなして全段の移行を通す', () => {
    writeRaw(JSON.stringify({ challenge: structuredClone(DEFAULT_CHALLENGE) }));
    const s = loadSettings(dir);
    expect(s.settingsVersion).toBe(SETTINGS_VERSION);
    // 移行済みの印が付いた状態で返る(次の保存でこの値が永続化される)。
    expect(s.challenge).toBeDefined();
  });

  it('世代 0..SETTINGS_VERSION のどこから読んでも二度読みで同じ結果になる(冪等)', () => {
    for (let v = 0; v <= SETTINGS_VERSION; v += 1) {
      const d = mkdtempSync(join(tmpdir(), `tls-gen${v}-`));
      try {
        mkdirSync(join(d, 'config'), { recursive: true });
        writeFileSync(
          join(d, 'config', 'settings.json'),
          JSON.stringify({ settingsVersion: v, challenge: structuredClone(DEFAULT_CHALLENGE) }),
          'utf8'
        );
        const once = loadSettings(d);
        // 1回目の結果をそのまま保存して読み直す = 実際の使われ方。
        saveSettings(d, once);
        const twice = loadSettings(d);
        expect(twice, `世代 ${v} が不動点でない`).toEqual(once);
      } finally {
        rmSync(d, { recursive: true, force: true });
      }
    }
  });
});

describe('saveSettings — 電断で全設定を失わない', () => {
  it('保存して読み直すと同じ値が返る', () => {
    const s: AppSettings = { ...defaultSettings(dir), hostUniqueId: 'saved', diamondToJpy: 0.8 };
    saveSettings(dir, s);
    const back = loadSettings(dir);
    expect(back.hostUniqueId).toBe('saved');
    expect(back.diamondToJpy).toBe(0.8);
  });

  it('書き込みが中断しても既存の settings.json は無傷のまま読める', () => {
    const good: AppSettings = { ...defaultSettings(dir), hostUniqueId: '無事なほう' };
    saveSettings(dir, good);

    // .tmp をディレクトリとして先に作ると writeFileSync が EISDIR で throw し、
    // renameSync に到達しない = 「書き込み途中で落ちた」状態を両OSで再現できる。
    mkdirSync(`${settingsPath()}.tmp`, { recursive: true });
    expect(() => saveSettings(dir, { ...good, hostUniqueId: '壊れるほう' })).toThrow();

    // 直接上書きしていたらここで全設定が飛んでいる。
    expect(loadSettings(dir).hostUniqueId).toBe('無事なほう');
  });

  it('保存後に .tmp を残さない', () => {
    saveSettings(dir, defaultSettings(dir));
    expect(existsSync(`${settingsPath()}.tmp`)).toBe(false);
  });
});

describe('デフォ保存(challenge-default.json)', () => {
  function bundledDir(): string {
    return resolve('resources');
  }

  it('保存 → 読込 の往復で内容が保たれ、世代印が先頭に付く', () => {
    const cfg: ChallengeConfig = { ...structuredClone(DEFAULT_CHALLENGE), title: 'わたしの企画', initialValue: 777 };
    const p = saveChallengeDefault(dir, cfg);
    expect(p).toBe(challengeDefaultPath(dir));

    const onDisk = JSON.parse(readFileSync(p, 'utf8')) as Record<string, unknown>;
    // 世代印を運ぶのは load 側が「古いアプリで作られたファイル」を見分けるため。
    expect(Object.keys(onDisk)[0]).toBe('settingsVersion');
    expect(onDisk.settingsVersion).toBe(SETTINGS_VERSION);

    const back = loadChallengeDefault(dir);
    expect(back?.title).toBe('わたしの企画');
    expect(back?.initialValue).toBe(777);
    // validateChallengeConfig が settingsVersion を捨てるので戻り値には残らない。
    expect(back as unknown as Record<string, unknown>).not.toHaveProperty('settingsVersion');
  });

  it('デフォ保存があると、settings.json の無い環境の既定がその内容になる', () => {
    saveChallengeDefault(dir, { ...structuredClone(DEFAULT_CHALLENGE), title: '引き継ぎたい企画' });
    expect(defaultSettings(dir).challenge.title).toBe('引き継ぎたい企画');
  });

  it('ユーザー保存が壊れていたら同梱デフォへ落ちる(起動不能にしない)', () => {
    mkdirSync(join(dir, 'config'), { recursive: true });
    writeFileSync(challengeDefaultPath(dir), '{ 壊れている', 'utf8');
    // 候補は [ユーザー保存, 同梱] の順。1つ目が壊れていても2つ目へ進む。
    const back = loadChallengeDefault(dir);
    expect(back).not.toBeNull();
  });

  it('clear は実際に消したかを返し、消すと同梱デフォへ戻る', () => {
    expect(clearChallengeDefault(dir)).toBe(false); // まだ無い

    saveChallengeDefault(dir, { ...structuredClone(DEFAULT_CHALLENGE), title: 'ユーザーの' });
    expect(loadChallengeDefault(dir)?.title).toBe('ユーザーの');

    expect(clearChallengeDefault(dir)).toBe(true);
    expect(existsSync(challengeDefaultPath(dir))).toBe(false);
    // 同梱が残っているので null にはならない。
    expect(loadChallengeDefault(dir)?.title).not.toBe('ユーザーの');
  });

  it('同梱の challenge-default.json は検証を通り、移行後が不動点になる', () => {
    // 同梱ファイルは settingsVersion 5、コードは 7 なので毎回2段の移行が走る。
    // 「手編集で壊した」「新しい移行段が同梱ファイルに対して冪等でない」の両方をここが捕まえる。
    const bundled = JSON.parse(readFileSync(join(bundledDir(), 'challenge-default.json'), 'utf8')) as {
      settingsVersion?: number;
    };
    expect(typeof bundled.settingsVersion).toBe('number');

    const loaded = loadChallengeDefault(dir);
    expect(loaded).not.toBeNull();

    // 一度読んだ結果を自分のデフォ保存として書き戻し、もう一度読んでも変わらない。
    saveChallengeDefault(dir, loaded!);
    expect(loadChallengeDefault(dir)).toEqual(loaded);
  });
});

describe('needsWorkerRestart — 再起動が要る設定変更', () => {
  it('dbPath / eulerApiKey の変更だけが再起動を要求する', () => {
    const base = defaultSettings(dir);
    expect(needsWorkerRestart(base, base)).toBe(false);
    expect(needsWorkerRestart(base, { ...base, dbPath: `${base.dbPath}x` })).toBe(true);
    expect(needsWorkerRestart(base, { ...base, eulerApiKey: 'k' })).toBe(true);
    // チャレンジ設定は settings メッセージで即時反映される(再起動不要)。
    expect(
      needsWorkerRestart(base, { ...base, challenge: { ...base.challenge, initialValue: 1 } })
    ).toBe(false);
  });
});
