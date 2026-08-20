import { copyFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, openMonitor, test } from './fixtures';

/**
 * カスタムリール回転音の再生経路(app-sound:// プロトコル)。
 *
 * この機能は「CSP の media-src」「main の特権スキーム登録」「protocol.handle の
 * containment 検査」の3点が揃って初めて音が出る。**どれが欠けても設定は保存
 * できるのに鳴らない**うえ、registerSchemesAsPrivileged の位置ずれや
 * `stream: true` の欠落は dev では気づけず packaged でだけ壊れる。
 * vitest はソース文字列しか見られないので、実 Electron で本当に読めることは
 * ここでしか確かめられない。
 *
 * 音を鳴らさずに検証できるのが要点: <audio> の loadedmetadata が来れば
 * 「CSP を通り、プロトコルが応答し、Chromium がデコードできた」が全部言える
 * (E2E は --mute-audio で起動している)。
 */

/** 同梱のループ音を、ユーザーが取り込んだ体で config/sounds/ へ置く。 */
function seedSound(dataDir: string, name: string): void {
  const dir = join(dataDir, 'config', 'sounds');
  mkdirSync(dir, { recursive: true });
  copyFileSync(resolve(__dirname, '..', 'src/renderer/assets/se/roulette/spin-reel1.ogg'), join(dir, name));
}

/**
 * ページ内で <audio> を作り、読めたかどうかだけを返す。
 * 'ok' = loadedmetadata(CSP 通過 + プロトコル 200 + デコード成功)。
 * 'error' = CSP 遮断・404・デコード失敗のいずれか(区別は付かないが、
 * 正常系と異常系の切り分けにはこれで足りる)。
 */
const PROBE = `(url) => new Promise((done) => {
  const a = new Audio(url);
  const t = setTimeout(() => done({ result: 'timeout', duration: 0 }), 8000);
  a.addEventListener('loadedmetadata', () => {
    clearTimeout(t);
    done({ result: 'ok', duration: a.duration });
  });
  a.addEventListener('error', () => {
    clearTimeout(t);
    done({ result: 'error', duration: 0 });
  });
})`;

type Probe = { result: string; duration: number };

test('取り込んだ音声が app-sound:// で読める(設定窓・モニター窓の両方)', async ({ app, main, dataDir }) => {
  seedSound(dataDir, 'e2e-loop.ogg');
  const url = 'app-sound:///e2e-loop.ogg';

  // 設定画面(試聴の経路)。
  const onMain = (await main.evaluate(`(${PROBE})(${JSON.stringify(url)})`)) as Probe;
  expect(onMain.result).toBe('ok');
  expect(onMain.duration).toBeGreaterThan(0);

  // モニター窓(本番再生の経路)。プロトコルはデフォルトセッション登録なので
  // 両窓に効くはずだが、CSP は窓ごとの meta なので別々に確かめる価値がある。
  const monitor = await openMonitor(app, main);
  const onMonitor = (await monitor.evaluate(`(${PROBE})(${JSON.stringify(url)})`)) as Probe;
  expect(onMonitor.result).toBe('ok');
  expect(onMonitor.duration).toBeGreaterThan(0);
});

test('日本語ファイル名もエンコード往復で読める', async ({ main, dataDir }) => {
  seedSound(dataDir, '回転音.ogg');
  const url = 'app-sound:///' + encodeURIComponent('回転音.ogg');
  const r = (await main.evaluate(`(${PROBE})(${JSON.stringify(url)})`)) as Probe;
  expect(r.result).toBe('ok');
});

test('長さが確定し、Range 要求に 206 で正しく答える(ループ折返しの再取得が壊れない)', async ({
  app,
  main,
  dataDir,
}) => {
  // net.fetch(file://) へ丸投げすると**要求ヘッダが引き継がれず**、Chromium の
  // `Range: bytes=N-` にも常に 200 + 先頭からの全体が返る。さらに file:// の応答は
  // Content-Length を持たないので長さ不明ストリーム扱いになり duration が Infinity。
  // その状態でモニターがカットイン動画を並行再生してバッファが追い出されると、
  // ループ折返しの再取得が要求と食い違い PIPELINE_ERROR_READ で回転音が死ぬ
  // (以後その要素は復帰せず、その回の回転だけ無音になる)。
  seedSound(dataDir, 'e2e-loop.ogg');
  const url = 'app-sound:///e2e-loop.ogg';

  // (1) レンダラから見て長さが確定していること(= Content-Length が効いている)。
  const meta = (await main.evaluate(`(${PROBE})(${JSON.stringify(url)})`)) as Probe;
  expect(meta.result).toBe('ok');
  expect(Number.isFinite(meta.duration)).toBe(true);
  expect(meta.duration).toBeGreaterThan(0);

  // (2) 応答そのものを実測する。ページからの fetch は connect-src 'self' に
  //     阻まれるので、同じ既定セッションを使う main プロセス側から撃つ。
  const r = await app.evaluate(async ({ net }, u) => {
    const full = await net.fetch(u);
    const fullLen = (await full.arrayBuffer()).byteLength;
    const part = await net.fetch(u, { headers: { Range: 'bytes=10-19' } });
    const partLen = (await part.arrayBuffer()).byteLength;
    const over = await net.fetch(u, { headers: { Range: 'bytes=99999999-' } });
    return {
      fullStatus: full.status,
      fullLen,
      contentLength: full.headers.get('content-length'),
      acceptRanges: full.headers.get('accept-ranges'),
      contentType: full.headers.get('content-type'),
      partStatus: part.status,
      partLen,
      contentRange: part.headers.get('content-range'),
      overStatus: over.status,
    };
  }, url);

  expect(r.fullStatus).toBe(200);
  expect(r.contentLength).toBe(String(r.fullLen));
  expect(r.acceptRanges).toBe('bytes');
  expect(r.contentType).toBe('audio/ogg');
  // 要求どおり 10 バイトだけ返る(ここが全体長になるのが修正前の壊れ方)。
  expect(r.partStatus).toBe(206);
  expect(r.partLen).toBe(10);
  expect(r.contentRange).toBe(`bytes 10-19/${r.fullLen}`);
  // 範囲外は 416。200 で全体を返すとメディアスタックが誤ったデータを読む。
  expect(r.overStatus).toBe(416);
});

test('config/sounds の外は読めない(トラバーサル・欠損はどちらも失敗)', async ({ main, dataDir }) => {
  seedSound(dataDir, 'e2e-loop.ogg');
  for (const bad of [
    // 実在する隣のファイル(settings.json)を狙う典型形。
    'app-sound:///..%2Fsettings.json',
    'app-sound:///..%2F..%2Fconfig%2Fsettings.json',
    'app-sound:///sub%2Fe2e-loop.ogg',
    // 取り込んでいないファイル。
    'app-sound:///not-imported.ogg',
  ]) {
    const r = (await main.evaluate(`(${PROBE})(${JSON.stringify(bad)})`)) as Probe;
    expect(r.result, bad).toBe('error');
  }
});
