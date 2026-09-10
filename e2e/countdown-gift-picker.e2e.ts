import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, expect, relaunch } from './fixtures';
import { rpc } from './helpers/rpc';
import type { ChallengeConfig, GiftOptionsResult } from '../src/shared/dto';

test.use({ settingsPatch: { hostUniqueId: '', challenge: { enabled: true, hotkey: '', monitorWindowed: true } } });

// Seed only the isolated test database before Electron starts. No real TikTok requests.
test.beforeEach(async ({ dataDir }) => {
  mkdirSync(join(dataDir, 'db'), { recursive: true });
  const db = new DatabaseSync(join(dataDir, 'db', 'analytics.db'));
  const migrations = resolve('src/worker/store/migrations');
  const files = readdirSync(migrations).filter((p) => /^\d+.*\.sql$/.test(p)).sort();
  for (const file of files) db.exec(readFileSync(join(migrations, file), 'utf8'));
  db.exec(`PRAGMA user_version = ${files.length}`);
  const icon = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" rx="20" fill="#d7568f"/><text x="40" y="55" text-anchor="middle" font-size="45">♥</text></svg>');
  const insert = db.prepare('INSERT INTO gift_picker_cache VALUES (?, ?, ?, ?, ?, ?)');
  insert.run('', '0012', 'Hand Heart', 10, icon, 100);
  insert.run('', '13', 'Hand Heart', 20, null, 100);
  insert.run('', '14', 'Broken image', 30, 'data:image/png;base64,broken', 100);
  for (let i = 100; i < 145; i++) insert.run('', String(i), `テストギフト ${i}`, i, icon, 100);
  db.prepare('INSERT INTO gift_catalog (gift_id, name, diamond_count, first_seen_ms, last_seen_ms) VALUES (?, ?, ?, ?, ?)').run('13', 'Hand Heart', 20, 1, 50);
  db.close();
});

async function prepare(main: import('playwright').Page): Promise<ChallengeConfig> {
  const settings = await rpc<{ challenge: ChallengeConfig }>(main, 'cfg.get');
  const cfg = settings.challenge;
  for (const key of ['giftFullCut', 'giftBandFx', 'giftScale', 'fanStamp', 'tapBoost', 'tapLock', 'revolution', 'lion', 'universe', 'quiz'] as const) cfg[key].enabled = true;
  cfg.giftRules = [{ id: 'legacy-rule', canonical: 'rose', amount: -50, mode: 'fixed' }];
  cfg.giftBandFx.excludeGiftIds = ['outside-catalog'];
  cfg.giftScale.rows = [{ id: 'scale', giftId: '', giftName: 'legacy', canonical: 'old', label: '独自の表示名', perDiamond: -50 }];
  await rpc(main, 'cfg.set', { challenge: cfg });
  await main.getByRole('button', { name: 'チャレンジ', exact: true }).click();
  await expect(main.getByRole('heading', { name: 'カウントダウンチャレンジ' })).toBeVisible();
  return cfg;
}

test('search, same-name IDs, missing images, multi-selection, save and restart', async ({ main, app, dataDir }, info) => {
  await prepare(main);
  await main.getByRole('button', { name: 'ギフト増減', exact: true }).click();
  const field = main.locator('.gift-field').first();
  await expect(field).toContainText('legacy');
  await field.getByRole('button', { name: '変更', exact: true }).click();
  const dialog = main.getByRole('dialog', { name: 'ギフトを選ぶ', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('searchbox')).toBeFocused();
  await expect(dialog.locator('.gift-picker-card')).toHaveCount(48);
  await expect(dialog.locator('.gift-picker-card').filter({ hasText: 'Broken image' }).getByRole('img', { name: '画像なし' })).toBeVisible();
  const bounds = await dialog.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { right: r.right, bottom: r.bottom, width: innerWidth, height: innerHeight };
  });
  expect(bounds.right).toBeLessThanOrEqual(bounds.width);
  expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
  // Native capture avoids Playwright's Electron screenshot crop at Windows high DPI.
  const windowHandle = await app.browserWindow(main);
  const png = await windowHandle.evaluate(async (win) => (await win.webContents.capturePage()).toPNG().toString('base64'));
  writeFileSync(info.outputPath('gift-picker.png'), Buffer.from(png, 'base64'));
  expect(await dialog.locator('.gift-picker-grid').evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await dialog.getByRole('searchbox').fill('hand heart');
  await expect(dialog.locator('.gift-picker-card')).toHaveCount(2);
  await dialog.getByLabel('受信済みのみ').check();
  await expect(dialog.locator('.gift-picker-card')).toHaveCount(1);
  await expect(dialog.locator('.gift-picker-card')).toContainText('ID: 13');
  await dialog.getByLabel('受信済みのみ').uncheck();
  await dialog.getByRole('searchbox').fill('0012');
  await dialog.locator('.gift-picker-card').click();
  await expect(dialog).not.toBeVisible();
  await expect(field).toContainText('Hand Heart');
  await expect(main.getByLabel('表示名(メモ)', { exact: true })).toHaveValue('独自の表示名');
  await expect(main.getByLabel('単価(ダイヤ)', { exact: true })).toHaveValue('10');
  await field.getByRole('button', { name: '変更', exact: true }).click();
  await main.keyboard.press('Escape');
  await expect(field.getByRole('button', { name: '変更', exact: true })).toBeFocused();
  await main.getByRole('button', { name: '演出', exact: true }).click();
  const fullcut = main.locator('.fullcut-rule').first();
  await fullcut.getByRole('button', { name: /^(変更|ギフトを選ぶ)$/ }).click();
  await dialog.getByRole('searchbox').fill('0012');
  await dialog.locator('.gift-picker-card').click();
  await expect(fullcut.locator('.gift-field')).toContainText('Hand Heart');
  await main.getByRole('button', { name: '除外ギフトを選ぶ' }).click();
  await dialog.getByRole('searchbox').fill('Hand Heart');
  await dialog.locator('.gift-picker-card').first().click();
  await dialog.getByRole('button', { name: '閉じる', exact: true }).click();
  await expect(main.locator('.gift-chips')).not.toContainText('Hand Heart');
  await main.getByRole('button', { name: '除外ギフトを選ぶ' }).click();
  await dialog.getByRole('searchbox').fill('Hand Heart');
  await dialog.locator('.gift-picker-card').first().click();
  await dialog.locator('.gift-picker-card').nth(1).click();
  await dialog.getByRole('button', { name: '選択を確定' }).click();
  await expect(main.locator('.gift-chip')).toHaveCount(3);
  await main.getByRole('button', { name: 'outside-catalogの除外を解除' }).click();
  await main.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await rpc<{ challenge: ChallengeConfig }>(main, 'cfg.get');
  expect(saved.challenge.giftScale.rows[0]).toMatchObject({ giftId: '0012', giftName: '', canonical: '', diamonds: 10, label: '独自の表示名' });
  expect(saved.challenge.giftBandFx.excludeGiftIds).toEqual(['0012', '13']);
  expect(saved.challenge.giftRules[0]?.canonical).toBe('rose');
  await app.close();
  const restarted = await relaunch(dataDir);
  try {
    const page = await restarted.firstWindow();
    const restored = await rpc<{ challenge: ChallengeConfig }>(page, 'cfg.get');
    expect(restored.challenge.giftScale.rows[0]?.giftId).toBe('0012');
    expect((await rpc<GiftOptionsResult>(page, 'q.giftOptions')).rows).toHaveLength(48);
  } finally { await restarted.close(); }
});

test('every trigger has a picker; threshold mode and failed refresh preserve data', async ({ main }) => {
  await prepare(main);
  for (const tab of ['ルーレット', 'お助け', 'ブースト', 'お邪魔', '革命', 'ライオン', '一撃クリア', 'お題ルーレット']) {
    await main.getByRole('button', { name: tab, exact: true }).click();
    const field = main.locator('.gift-field').first();
    await expect(field).toBeVisible();
    await field.getByRole('button', { name: /^(変更|ギフトを選ぶ)$/ }).click();
    const dialog = main.getByRole('dialog');
    await dialog.getByRole('searchbox').fill('0012');
    await dialog.locator('.gift-picker-card').click();
    await expect(field).toContainText('Hand Heart');
  }
  await main.getByRole('button', { name: 'ギフト増減', exact: true }).click();
  await main.getByLabel('対象の指定方法').selectOption('diamonds');
  await main.getByLabel('最低ダイヤ数', { exact: true }).fill('500');
  await main.getByRole('button', { name: '保存', exact: true }).click();
  const saved = await rpc<{ challenge: ChallengeConfig }>(main, 'cfg.get');
  expect(saved.challenge.giftRules[0]).toMatchObject({ minDiamonds: 500 });
  expect(saved.challenge.giftRules[0]?.canonical).toBeUndefined();
  await main.getByLabel('対象の指定方法').selectOption('gift');
  const field = main.locator('.gift-rule-target .gift-field');
  await field.getByRole('button', { name: 'ギフトを選ぶ', exact: true }).click();
  const dialog = main.getByRole('dialog');
  await dialog.getByLabel('取得対象の配信者名').fill('invalid name');
  await dialog.getByRole('button', { name: '一覧を更新', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('一覧を更新できませんでした');
  await expect(dialog.locator('.gift-picker-card')).toHaveCount(48);
  await dialog.getByRole('searchbox').fill('no-such-gift');
  await expect(dialog).toContainText('条件に合うギフトがありません');
  await dialog.getByRole('searchbox').fill('0012');
  await dialog.locator('.gift-picker-card').click();
  await field.getByRole('button', { name: '解除', exact: true }).click();
  await expect(field).toContainText('ギフト未選択');
});
