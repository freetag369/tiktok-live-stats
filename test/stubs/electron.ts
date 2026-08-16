/**
 * vitest 用の electron スタブ。
 *
 * src/main/paths.ts は **モジュール評価時に** `app.getPath('userData')` を呼ぶ
 * (ポータブル版が app.setPath する前の値を捕まえる必要があるため — paths.ts の
 * コメント参照)。素の Node では `require('electron')` が実行ファイルのパス文字列を
 * 返すだけなので `app` が undefined になり、boot-settings.ts を import した瞬間に
 * TypeError で落ちる。
 *
 * paths.ts の評価順は**意図的**で動かせない(動かすと「ポータブル版と設置版が
 * 互いのDBを見失う」という修正済みの不具合が戻る)。そこで electron の側を
 * 差し替える — プロダクションコードは1行も変えない。
 *
 * ここで返す userData は **どのテストからも使われない前提**。boot-settings の
 * 公開関数はすべて dataDir を引数で受け取るので、テストは temp dir を明示的に渡す。
 */
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const app = {
  getPath(name: string): string {
    return join(tmpdir(), 'tls-electron-stub', name);
  },
  getAppPath(): string {
    return resolve('.');
  },
  isPackaged: false,
};

export default { app };
