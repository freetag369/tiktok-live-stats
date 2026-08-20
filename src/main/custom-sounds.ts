import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join, resolve, sep } from 'node:path';
import { CUSTOM_SOUND_PREFIX, isCustomSoundId } from '@shared/challenge';

/**
 * ユーザー取込みのカスタム回転音の置き場と読み口(app-sound:// の裏側)。
 *
 * **electron を import しない** — resolveCustomSoundPath / sanitizeSoundFileName は
 * app-sound:// プロトコルの最終防衛線(パストラバーサル対策)なので、test/unit で
 * 素の node として検査できる形に保つ(metrics.ts の deps 注入と同じ動機)。
 *
 * 取込みは**コピー方式**: 元ファイルの参照ではなく config/sounds/ へ複製し、
 * 設定にはファイル名だけが入る(shared/challenge.ts の CUSTOM_SOUND_PREFIX)。
 * 元ファイルの移動・削除・USB 抜きで配信中に無音化しないため、そして
 * プロトコルの読み口をこのディレクトリに限定できるのが理由。config/ 配下なのは
 * challenge-default.json の「config をコピーすれば他PCでも同じ」の流儀に乗るため。
 * 取込んだファイルの自動削除はしない — 複数行・方向別共通・入室・デフォ保存から
 * 同じファイルが参照され得るのに参照カウントが無いので、消す方が事故になる。
 */

/** 取込みサイズ上限。ループ用の短い効果音を想定した値(超過は取込みを拒否)。 */
export const CUSTOM_SOUND_MAX_BYTES = 20 * 1024 * 1024;

/** ファイル選択ダイアログのフィルタと共有する拡張子一覧。 */
export const CUSTOM_SOUND_EXTS: readonly string[] = ['mp3', 'ogg', 'wav', 'm4a'];

export function soundsDirIn(dataDir: string): string {
  const d = join(dataDir, 'config', 'sounds');
  mkdirSync(d, { recursive: true });
  return d;
}

/**
 * 取込み時のファイル名サニタイズ。パス区切り・`..`・':' を落とすのは
 * isCustomSoundId(shared)と app-sound:// の containment 検査の両方を
 * **確実に通る名前しか作らない**ため — 取込めたのに鳴らない状態を作らない。
 * 空になったら 'sound' へ倒す(拡張子は呼び出し側が付け直す)。
 */
export function sanitizeSoundFileName(name: string): string {
  const cleaned = name
    // 制御文字は除去。区切り・':'(Windows のドライブ相対パス対策)・Windows の
    // 禁止文字は '_' へ置換。
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[/\\:<>"|?*]/g, '_')
    .replace(/\.\./g, '_')
    .trim();
  const capped = cleaned.slice(0, 120);
  return capped.length > 0 ? capped : 'sound';
}

/**
 * 保存名の主部(拡張子より前)を作る。サニタイズ後に**先頭・末尾のドットを落とす**
 * のが要点 — これが無いと `..mp3` のような元ファイル名で
 * basename('..mp3', '.mp3') === '.' となり、繋いだ結果が `..mp3` に戻って
 * isCustomSoundId が拒否する名前(= 取込めたのに鳴らない・保存で既定へ倒れる)
 * ができる。空になったら 'sound' へ。
 */
function soundStem(raw: string): string {
  const s = sanitizeSoundFileName(raw).replace(/^\.+/, '').replace(/\.+$/, '');
  return s.length > 0 ? s : 'sound';
}

/**
 * app-sound:// の URL パス名 → 実ファイルパスの解決。**containment が本体**:
 * デコード後の名前がベース名そのもの(区切り・`..` 無し)で、解決結果が
 * soundsDir 配下に収まるときだけパスを返す。それ以外は null(ハンドラは 404)。
 * ここが緩いと「設定値は名前だけ」の建前が崩れてフルディスク読み取り口になる。
 */
export function resolveCustomSoundPath(soundsDir: string, urlPathname: string): string | null {
  let name: string;
  try {
    name = decodeURIComponent(urlPathname);
  } catch {
    return null; // 壊れた %xx シーケンス
  }
  name = name.replace(/^\/+/, '');
  // ':' は Windows のドライブ相対パス('C:foo' が resolve でカレントへ飛ぶ)対策。
  // 取込み側のサニタイズが ':' を落とすので、正規の名前がここで弾かれることはない。
  if (
    name.length === 0 ||
    name.includes('/') ||
    name.includes('\\') ||
    name.includes(':') ||
    name.includes('..')
  ) {
    return null;
  }
  const base = resolve(soundsDir);
  const p = resolve(base, name);
  // 念のための二重化: 名前が本当に「1階層のベース名」として連結されたことを確認。
  if (p !== join(base, name)) return null;
  if (!p.startsWith(base + sep)) return null;
  return p;
}

/** 拡張子 → Content-Type。読み口が長さ不明ストリームにならないよう必ず付ける。 */
const MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
};

export function soundMimeType(file: string): string {
  return MIME[extname(file).replace(/^\./, '').toLowerCase()] ?? 'application/octet-stream';
}

/**
 * Range ヘッダ(`bytes=start-end`)の解釈。単一レンジのみ対応 — メディア要素が
 * 投げるのは実質これだけで、複数レンジは multipart/byteranges が要る。
 *
 * null = レンジ指定なし(全体を 200 で返す)。
 * 'invalid' = 範囲外(416 を返す)。start が size 以上のときで、これを 200 で
 * 返すとメディアスタックが「要求と違うデータ」を読んで壊れる。
 */
export function parseByteRange(
  header: string | null | undefined,
  size: number
): { start: number; end: number } | null | 'invalid' {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // 解釈できない形は全体返しへ倒す(206 を騙らない)
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return null;
  let start: number;
  let end: number;
  if (rawStart === '') {
    // `bytes=-N` = 末尾 N バイト。
    const n = Number(rawEnd);
    if (!Number.isFinite(n) || n <= 0) return 'invalid';
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === '' ? size - 1 : Number(rawEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return 'invalid';
    end = Math.min(end, size - 1);
  }
  if (start > end || start >= size || start < 0) return 'invalid';
  return { start, end };
}

/**
 * 音声ファイルを config/sounds/ へ取り込む。成功なら保存名(ベース名)を返す。
 * 失敗は message 付きで返す — 呼び出し側(handleMainRpc)が VALIDATION エラーへ
 * 写し、renderer の rpc() throw → トースト表示に乗る。
 * 同名衝突は上書きせず `name-2.ext` 連番 — 別の行が同名の旧ファイルを
 * 参照しているかもしれないため(自動削除をしないのと同じ理由)。
 */
export function importSoundFile(
  dataDir: string,
  srcPath: string
): { ok: true; file: string } | { ok: false; message: string } {
  let size: number;
  try {
    size = statSync(srcPath).size;
  } catch {
    return { ok: false, message: '選択したファイルを読み取れませんでした。' };
  }
  if (size > CUSTOM_SOUND_MAX_BYTES) {
    return {
      ok: false,
      message: `ファイルが大きすぎます(上限 ${Math.round(CUSTOM_SOUND_MAX_BYTES / 1024 / 1024)}MB)。ループ用の短い音声を選んでください。`,
    };
  }
  const ext = extname(srcPath).replace(/^\./, '').toLowerCase();
  // 拡張子はダイアログのフィルタだけに頼らない — Windows のファイル選択は
  // ファイル名を直接入力すれば任意のファイルを選べる。中身を見ない代わりに、
  // 少なくとも音声以外を config/sounds/(app-sound:// の配信対象)へ入れない。
  if (!CUSTOM_SOUND_EXTS.includes(ext)) {
    return {
      ok: false,
      message: `対応していない形式です(${CUSTOM_SOUND_EXTS.join(' / ')} を選んでください)。`,
    };
  }
  const dir = soundsDirIn(dataDir);
  const stem = soundStem(basename(srcPath, extname(srcPath)));
  let file = `${stem}.${ext}`;
  for (let i = 2; existsSync(join(dir, file)); i++) {
    file = `${stem}-${i}.${ext}`;
  }
  // 不変条件: ここで返す名前は必ず設定値として通る。破れると「取込みは成功
  // したのに、保存した瞬間 validate が既定へ倒す(＝黙って元の音に戻る)」
  // という、いちばん気づきにくい壊れ方になる。
  if (!isCustomSoundId(CUSTOM_SOUND_PREFIX + file)) {
    return { ok: false, message: 'このファイル名は使えません。名前を変えてからもう一度選んでください。' };
  }
  try {
    copyFileSync(srcPath, join(dir, file));
  } catch (e) {
    return { ok: false, message: `ファイルをコピーできませんでした: ${(e as Error)?.message ?? String(e)}` };
  }
  return { ok: true, file };
}
