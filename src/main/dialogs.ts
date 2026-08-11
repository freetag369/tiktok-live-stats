import { join } from 'node:path';
import { BrowserWindow, dialog } from 'electron';
import type { CsvExportKind } from '@shared/dto';

const CSV_LABEL: Record<CsvExportKind, string> = {
  viewers: 'リスナー一覧',
  comments: 'コメント履歴',
  gifts: 'ギフト履歴',
  sessions: '配信履歴',
  agencyMonthly: '月次レポート',
};

function stamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

export async function askCsvPath(win: BrowserWindow | null, kind: CsvExportKind): Promise<string | null> {
  const r = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
    title: 'CSV の保存先',
    defaultPath: `${CSV_LABEL[kind]}-${stamp()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
}

export async function askBackupPath(win: BrowserWindow | null): Promise<string | null> {
  const r = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
    title: 'バックアップの保存先',
    defaultPath: `tiktok-live-stats-backup-${stamp()}.db`,
    filters: [{ name: 'SQLite データベース', extensions: ['db'] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
}

export async function askSourceZipPath(win: BrowserWindow | null, version: string): Promise<string | null> {
  const r = await dialog.showSaveDialog(win ?? BrowserWindow.getAllWindows()[0]!, {
    title: 'ソースコードの保存先',
    defaultPath: `tiktok-live-stats-source-${version}.zip`,
    filters: [{ name: 'ZIP', extensions: ['zip'] }],
  });
  return r.canceled || !r.filePath ? null : r.filePath;
}

export async function confirmDestructive(win: BrowserWindow | null, message: string, detail: string): Promise<boolean> {
  const r = await dialog.showMessageBox(win ?? BrowserWindow.getAllWindows()[0]!, {
    type: 'warning',
    buttons: ['キャンセル', '削除する'],
    defaultId: 0,
    cancelId: 0,
    message,
    detail,
    noLink: true,
  });
  return r.response === 1;
}

export async function offerAdoptDb(
  win: BrowserWindow | null,
  found: { portable: string | null; installed: string | null },
  currentPath: string
): Promise<string | null> {
  const other = [found.portable, found.installed].find((p) => p && p !== currentPath) ?? null;
  if (!other) return null;
  const r = await dialog.showMessageBox(win ?? BrowserWindow.getAllWindows()[0]!, {
    type: 'question',
    buttons: ['新しく始める', '既存のデータを使う'],
    defaultId: 1,
    cancelId: 0,
    message: '既存のデータが見つかりました',
    detail: `別の場所に過去の記録があります。\n\n${other}\n\nこちらを読み込みますか？`,
    noLink: true,
  });
  return r.response === 1 ? other : null;
}

export function backupDefaultDir(dataDir: string): string {
  return join(dataDir, 'backups');
}
