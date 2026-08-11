// One-off repair: point the installed build at the database the portable build
// created, and carry the settings across. Both builds keep separate userData by
// design, so a fresh install otherwise opens an empty app.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const REAL_DB = 'C:\\Users\\81804\\Downloads\\Tiktokツール\\TikTokLiveStats-data\\db\\analytics.db';
const PORTABLE_CFG = 'C:/Users/81804/Downloads/Tiktokツール/TikTokLiveStats-data/config/settings.json';
const INSTALL_CFG_DIR = 'C:/Users/81804/AppData/Roaming/tiktok-live-stats/config';

const probe = new DatabaseSync(REAL_DB.replace(/\\/g, '/'), { readOnly: true });
const n = (sql) => Number(probe.prepare(sql).get().c ?? probe.prepare(sql).get().s ?? 0);
console.log(
  '実データ: リスナー',
  n('SELECT COUNT(*) c FROM viewer'),
  '/ 配信',
  n('SELECT COUNT(*) c FROM stream_session'),
  '/ ハートミー',
  Number(probe.prepare('SELECT SUM(heart_me) s FROM viewer_lifetime').get().s ?? 0)
);
probe.close();

let settings = {};
try {
  settings = JSON.parse(readFileSync(PORTABLE_CFG, 'utf8'));
  console.log('ポータブル版の設定を引き継ぎます（アカウント名 / APIキー / スコア設定 / 倍率）');
} catch {
  console.log('ポータブル版の設定は読めませんでした。既定値を使います。');
}
settings.dbPath = REAL_DB;

mkdirSync(INSTALL_CFG_DIR, { recursive: true });
writeFileSync(`${INSTALL_CFG_DIR}/settings.json`, JSON.stringify(settings, null, 2), 'utf8');
console.log('インストール版の dbPath を実データに向けました:', settings.dbPath);
console.log('  アカウント名:', settings.hostUniqueId || '(未設定)');
console.log('  APIキー:', settings.eulerApiKey ? '設定済み' : '未設定');
