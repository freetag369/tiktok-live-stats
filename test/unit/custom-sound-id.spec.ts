import { describe, expect, it } from 'vitest';
import { CUSTOM_SOUND_PREFIX, customSoundFileName, isCustomSoundId } from '@shared/challenge';

/**
 * カスタム回転音 id(custom:<ファイル名>)の判定の境界。この判定は
 * 検証(validateRouletteSound)・再生(bgm.ts)・設定UIの3者が共有する唯一の
 * 実装なので、ここが緩むと settings.json 手編集のトラバーサル文字列が
 * app-sound:// まで届く(最終防衛線は main 側 containment だが、二重にする)。
 */
describe('isCustomSoundId', () => {
  it('取込み結果の正規形を受け付ける(日本語名・連番・各拡張子)', () => {
    for (const ok of [
      'custom:loop.mp3',
      'custom:回転音.ogg',
      'custom:loop-2.wav',
      'custom:sound.m4a',
      // 拡張子なしも許す — 判定はファイル名の安全性のみで、鳴るかどうかは再生側の責務。
      'custom:noext',
    ]) {
      expect(isCustomSoundId(ok), ok).toBe(true);
    }
  });

  it('カタログ id・off・非文字列は対象外', () => {
    for (const no of ['spin-reel2', 'off', '', null, undefined, 42, {}, ['custom:a.mp3']]) {
      expect(isCustomSoundId(no), JSON.stringify(no)).toBe(false);
    }
  });

  it('空名・トラバーサル・区切り入りは拒否', () => {
    for (const no of [
      'custom:',
      'custom:../evil.mp3',
      'custom:..',
      'custom:a/b.mp3',
      'custom:a\\b.mp3',
      'custom:/abs.mp3',
      'custom:a..b.mp3', // '..' を含む名前はサニタイズが作らない — 一律拒否でよい
    ]) {
      expect(isCustomSoundId(no), no).toBe(false);
    }
  });

  it('長すぎる名前は拒否(200 文字上限)', () => {
    expect(isCustomSoundId(CUSTOM_SOUND_PREFIX + 'a'.repeat(200))).toBe(true);
    expect(isCustomSoundId(CUSTOM_SOUND_PREFIX + 'a'.repeat(201))).toBe(false);
  });
});

describe('customSoundFileName', () => {
  it('接頭辞を除いたファイル名を返す(id → URL 組み立ての素材)', () => {
    expect(customSoundFileName('custom:回転音.ogg')).toBe('回転音.ogg');
    expect(customSoundFileName(CUSTOM_SOUND_PREFIX + 'loop.mp3')).toBe('loop.mp3');
  });
});
