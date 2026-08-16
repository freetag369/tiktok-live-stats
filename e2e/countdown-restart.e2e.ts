import { expect, relaunch, test } from './fixtures';
import { challengeGet, rpc } from './helpers/rpc';

/**
 * アプリ再起動をまたぐ挙動。**プロセスのライフサイクルそのもの**が検証対象なので、
 * 実起動でしか確かめられない。
 *
 * チャレンジの状態は worker のメモリにしか無く DB へ一切書かない、というのが
 * 現在の仕様(src/worker/challenge.ts の冒頭コメント)。これは「配信の手動再接続で
 * 進行中のチャレンジが飛ぶと配信事故になる」ために SessionManager.reset() では
 * 消えない設計だが、**アプリ自体を落とせば消える**。仕様が変わったとき(あるいは
 * 意図せず壊れたとき)に気づく唯一の網。
 */
test('再起動すると設定は残り、走行中のカウントダウンは idle に戻る', async ({ app, main, dataDir }) => {
  // 1本目: 走らせて値を動かす。
  await rpc(main, 'challenge.start', undefined);
  for (let i = 0; i < 4; i += 1) await rpc(main, 'challenge.press', undefined);
  const before = await challengeGet(main);
  expect(before.status).toBe('running');
  expect(before.value).toBe(96);

  // 設定も1つ変えておく(こちらは settings.json なので残るはず)。
  const cfg = await rpc<{ challenge: Record<string, unknown> }>(main, 'cfg.get', undefined);
  await rpc(main, 'cfg.set', { challenge: { ...cfg.challenge, title: '再起動をまたぐタイトル' } });

  await app.close();

  // 2本目: 同じ dataDir で起動し直す。
  const app2 = await relaunch(dataDir);
  try {
    const main2 = await app2.firstWindow({ timeout: 30_000 });
    await main2.waitForLoadState('domcontentloaded');

    // 設定はファイルなので残る。
    await expect
      .poll(
        async () => (await rpc<{ challenge: { title: string } }>(main2, 'cfg.get', undefined)).challenge.title,
        { timeout: 30_000 }
      )
      .toBe('再起動をまたぐタイトル');

    // カウントダウンは永続化されないので初期状態へ戻る。
    const after = await challengeGet(main2);
    expect(after.status).toBe('idle');
    expect(after.startedMs).toBeNull();
    expect(after.value).toBe(100);
    expect(after.stats.presses).toBe(0);
  } finally {
    await Promise.race([app2.close(), new Promise((r) => setTimeout(r, 15_000))]).catch(() => undefined);
  }
});
