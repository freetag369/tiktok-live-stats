import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CUSTOM_SOUND_MAX_BYTES,
  importSoundFile,
  parseByteRange,
  resolveCustomSoundPath,
  sanitizeSoundFileName,
  soundMimeType,
  soundsDirIn,
} from '@main/custom-sounds';
import { isCustomSoundId } from '@shared/challenge';

/**
 * カスタム回転音の取込みと読み口。
 *
 * resolveCustomSoundPath は app-sound:// プロトコルハンドラの**最終防衛線**で、
 * ここが緩むと「設定値は config/sounds/ 内のファイル名だけ」という建前が崩れ、
 * settings.json の手編集がフルディスク読み取り口になる。electron を import
 * しない純関数として切ってあるので素の node で検査できる。
 */
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tls-sound-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 取込み元のファイルを dataDir の外に作る(実際の選択も外部のファイル)。 */
function srcFile(name: string, body: string | Buffer): string {
  const d = join(dir, 'src');
  mkdirSync(d, { recursive: true });
  const p = join(d, name);
  writeFileSync(p, body);
  return p;
}

describe('resolveCustomSoundPath — containment', () => {
  it('正規のファイル名は config/sounds/ 配下のパスへ解決する', () => {
    const sounds = soundsDirIn(dir);
    expect(resolveCustomSoundPath(sounds, '/loop.mp3')).toBe(join(sounds, 'loop.mp3'));
    // 先頭スラッシュの数に依存しない(app-sound:///name の三重スラッシュを含む)。
    expect(resolveCustomSoundPath(sounds, '///loop.mp3')).toBe(join(sounds, 'loop.mp3'));
  });

  it('パーセントエンコードされた日本語名を復号して解決する', () => {
    const sounds = soundsDirIn(dir);
    const encoded = '/' + encodeURIComponent('回転音.ogg');
    expect(resolveCustomSoundPath(sounds, encoded)).toBe(join(sounds, '回転音.ogg'));
  });

  it('トラバーサル・区切り・ドライブ相対はすべて null(404)', () => {
    const sounds = soundsDirIn(dir);
    for (const bad of [
      '/../evil.mp3',
      '/..%2Fevil.mp3',
      '/%2E%2E/evil.mp3',
      '/sub/loop.mp3',
      '/a%5Cb.mp3', // バックスラッシュ
      '/C:/Windows/System32/x.mp3',
      '/C%3Afoo.mp3', // Windows のドライブ相対パス
      '/..',
    ]) {
      expect(resolveCustomSoundPath(sounds, bad), bad).toBeNull();
    }
  });

  it('空・壊れた %xx シーケンスは null', () => {
    const sounds = soundsDirIn(dir);
    expect(resolveCustomSoundPath(sounds, '/')).toBeNull();
    expect(resolveCustomSoundPath(sounds, '')).toBeNull();
    expect(resolveCustomSoundPath(sounds, '/%E0%A4%A')).toBeNull();
  });

  it('ディレクトリ自身を指す名前は null — containment の最後の砦(base + sep)を実際に効かせる', () => {
    // '.' は '..' を含まないので前段の文字列ガードを素通りし、resolve が
    // soundsDir 自身へ畳む。ここで startsWith(base + sep) が無いと(= base だけの
    // 比較だと)ディレクトリのパスを返してしまい、main の existsSync も true になる。
    const sounds = soundsDirIn(dir);
    expect(resolveCustomSoundPath(sounds, '/.')).toBeNull();
    expect(resolveCustomSoundPath(sounds, '/%2E')).toBeNull();
  });

  it('bgm.ts が組む URL をそのまま往復できる(組み立てと解釈の突き合わせ)', () => {
    // 再生経路は「renderer が encodeURIComponent で組む」→「main が
    // new URL().pathname で解く」の2枚重ね。手書きの pathname だけを試すと、
    // エンコード漏れ('#' 以降が切れる・'%' が壊れる)が誰にも見えない。
    const sounds = soundsDirIn(dir);
    for (const name of ['loop.mp3', '回転音.ogg', 'a b.wav', 'a#b.ogg', 'a%20b.m4a', 'a+b.ogg', 'a&b?c.wav']) {
      // bgm.ts と同じ組み立て。
      const url = `app-sound:///${encodeURIComponent(name)}`;
      // main と同じ解き方。
      const pathname = new URL(url).pathname;
      expect(resolveCustomSoundPath(sounds, pathname), name).toBe(join(sounds, name));
    }
  });
});

/**
 * Range の解釈。**ここが無いとループ音が途中で死ぬ**: net.fetch(file://) に丸投げ
 * すると要求ヘッダが引き継がれず、Chromium の `Range: bytes=N-` に対しても常に
 * 200 + 先頭からの全体が返る。要求と食い違うデータを渡されたメディアスタックは
 * PIPELINE_ERROR_READ で落ち、その回の回転音が無音のまま復帰しない。
 */
describe('parseByteRange — メディア要素の再取得に正しく答える', () => {
  it('レンジ指定なし・解釈できない形は null(= 全体を 200 で返す)', () => {
    expect(parseByteRange(null, 100)).toBeNull();
    expect(parseByteRange(undefined, 100)).toBeNull();
    expect(parseByteRange('', 100)).toBeNull();
    expect(parseByteRange('bytes=-', 100)).toBeNull();
    // 複数レンジは非対応。206 を騙らず全体返しへ倒す(multipart を返さないため)。
    expect(parseByteRange('bytes=0-9,20-29', 100)).toBeNull();
    expect(parseByteRange('items=0-9', 100)).toBeNull();
  });

  it('bytes=start-end / start- / -suffix をすべて解く', () => {
    expect(parseByteRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    // 開いた終端はファイル末尾まで(ループ折返しの再取得がこの形)。
    expect(parseByteRange('bytes=50-', 100)).toEqual({ start: 50, end: 99 });
    // 末尾 N バイト。
    expect(parseByteRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    // 終端がファイル長を超えたら丸める(RFC どおり。416 にはしない)。
    expect(parseByteRange('bytes=90-999', 100)).toEqual({ start: 90, end: 99 });
    expect(parseByteRange(' bytes=0-0 ', 100)).toEqual({ start: 0, end: 0 });
  });

  it('範囲外は invalid(416)— 200 で全体を返すとメディアスタックが壊れる', () => {
    expect(parseByteRange('bytes=100-200', 100)).toBe('invalid');
    expect(parseByteRange('bytes=200-', 100)).toBe('invalid');
    expect(parseByteRange('bytes=10-5', 100)).toBe('invalid');
    expect(parseByteRange('bytes=-0', 100)).toBe('invalid');
  });
});

describe('soundMimeType — 長さ不明ストリームにしない', () => {
  it('対応拡張子に音声の Content-Type を返す(大文字も)', () => {
    expect(soundMimeType('a.mp3')).toBe('audio/mpeg');
    expect(soundMimeType('a.ogg')).toBe('audio/ogg');
    expect(soundMimeType('a.wav')).toBe('audio/wav');
    expect(soundMimeType('a.m4a')).toBe('audio/mp4');
    expect(soundMimeType('a.MP3')).toBe('audio/mpeg');
  });
});

describe('sanitizeSoundFileName — 取込めたのに鳴らない名前を作らない', () => {
  it('サニタイズ結果は必ず isCustomSoundId を通る(取込み → 設定値 → 再生の一貫性)', () => {
    for (const raw of ['loop.mp3', '回転音', 'a/b', 'a\\b', '..', 'C:evil', 'a<b>c|d?e*f"g']) {
      const safe = sanitizeSoundFileName(raw);
      expect(isCustomSoundId('custom:' + safe), `${raw} -> ${safe}`).toBe(true);
    }
  });

  it('空になる入力は sound へ倒す(拡張子だけのファイル名を作らない)', () => {
    expect(sanitizeSoundFileName('')).toBe('sound');
    expect(sanitizeSoundFileName('   ')).toBe('sound');
  });

  it('長い名前は切り詰める(id の 200 文字上限に収める)', () => {
    expect(sanitizeSoundFileName('a'.repeat(500)).length).toBe(120);
  });
});

describe('importSoundFile — config/sounds/ へのコピー', () => {
  it('コピーして保存名を返す。設定値にすると isCustomSoundId を通る', () => {
    const r = importSoundFile(dir, srcFile('my loop.mp3', 'AUDIO'));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.file).toBe('my loop.mp3');
    expect(isCustomSoundId('custom:' + r.file)).toBe(true);
    expect(readFileSync(join(soundsDirIn(dir), r.file), 'utf8')).toBe('AUDIO');
  });

  it('同名は上書きせず連番にする — 既存の行が同名の旧ファイルを参照しうる', () => {
    const first = importSoundFile(dir, srcFile('loop.mp3', 'FIRST'));
    expect(first.ok && first.file).toBe('loop.mp3');
    // 別の場所から同名・別内容を取り込む(取込み済みを壊さないことの確認)。
    const other = mkdtempSync(join(tmpdir(), 'tls-sound-src-'));
    writeFileSync(join(other, 'loop.mp3'), 'SECOND');
    const second = importSoundFile(dir, join(other, 'loop.mp3'));
    expect(second.ok && second.file).toBe('loop-2.mp3');
    expect(readFileSync(join(soundsDirIn(dir), 'loop.mp3'), 'utf8')).toBe('FIRST');
    expect(readFileSync(join(soundsDirIn(dir), 'loop-2.mp3'), 'utf8')).toBe('SECOND');
    rmSync(other, { recursive: true, force: true });
  });

  it('返す保存名は必ず設定値として通る(取込み成功なのに保存で既定へ戻る、を作らない)', () => {
    // 病的な元ファイル名。とくに '..mp3' は basename('..mp3','.mp3') === '.' に
    // なるので、素朴に `${stem}.${ext}` と繋ぐと '..mp3' が復活し、
    // isCustomSoundId が '..' で拒否 → validate が既定へ倒す = 取込めたのに
    // 黙って元の音のまま、という一番気づきにくい壊れ方になる。
    // 'loop..mp3' 系がこの穴の本体: extname が '.mp3'、basename から除くと 'loop.' が
    // 残り、素朴に繋ぐと '..' が復活する。「Coming Soon....mp3」「第1章..mp3」など
    // 実在しうる名前で踏む。
    for (const raw of ['..mp3', '. .mp3', '...mp3', 'a..b.mp3', '   .mp3', 'loop..mp3', 'Coming Soon....mp3']) {
      const r = importSoundFile(dir, srcFile(raw, 'X'));
      expect(r.ok, raw).toBe(true);
      if (!r.ok) continue;
      expect(isCustomSoundId('custom:' + r.file), `${raw} -> ${r.file}`).toBe(true);
      // 拡張子は保つ(読み口の Content-Type は拡張子から決まる)。
      expect(r.file.endsWith('.mp3'), `${raw} -> ${r.file}`).toBe(true);
      // **設定値として通るだけでなく、実際に読み口が解決できること**まで見る —
      // id 検査(shared)と containment(main)は受理集合が違う(':' の扱いなど)ので
      // 両方に当てないと「保存はできるが 404」を見逃す。
      const resolved = resolveCustomSoundPath(soundsDirIn(dir), '/' + encodeURIComponent(r.file));
      expect(resolved, `${raw} -> ${r.file}`).not.toBeNull();
    }
  });

  it('非 ASCII・記号入りの実名でも取込み → 設定値 → 読み口が一貫する', () => {
    for (const raw of ['曲.名前..wav', '回転音 #1.ogg', 'ループ(短).m4a']) {
      const r = importSoundFile(dir, srcFile(raw, 'X'));
      expect(r.ok, raw).toBe(true);
      if (!r.ok) continue;
      expect(isCustomSoundId('custom:' + r.file), `${raw} -> ${r.file}`).toBe(true);
      expect(resolveCustomSoundPath(soundsDirIn(dir), '/' + encodeURIComponent(r.file)), raw).not.toBeNull();
    }
  });

  it('音声以外の拡張子は取り込まない(ダイアログのフィルタは直接入力で抜けられる)', () => {
    // '.mp3' は Node の extname が '' を返す(先頭ドットは拡張子ではなく名前の一部)。
    // 形式が判定できない以上は取り込まない — 拡張子は net.fetch の Content-Type の
    // 出所でもあるので、当て推量で付け足すより断るほうが正しい。
    for (const bad of ['evil.html', 'payload.exe', 'noext', '.mp3']) {
      const r = importSoundFile(dir, srcFile(bad, 'X'));
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.message).toContain('対応していない形式');
    }
  });

  it('存在しないファイルはエラーメッセージを返す(throw しない)', () => {
    const r = importSoundFile(dir, join(dir, 'nope.mp3'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('読み取れませんでした');
  });

  it('上限超過は取込まない(ループ用途の想定を外れる長尺曲)', () => {
    const r = importSoundFile(dir, srcFile('huge.wav', Buffer.alloc(CUSTOM_SOUND_MAX_BYTES + 1)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toContain('大きすぎます');
  });
});
