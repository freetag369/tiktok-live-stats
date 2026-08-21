import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TAP_LOCK_DURATION_MIN_SEC, TAP_LOCK_INTRO_MS } from '@shared/challenge';

/**
 * お邪魔(タップ封じ)の導入全面カット(2026-08-20 追加)。
 *
 * 封印そのものは worker が一致した瞬間に絶対期限をラッチし、**導入を待たない** —
 * 5秒の幕はその上に被さるだけで、裏で残り時間は普通に減る。この非対称が壊れやすい
 * ところなので、入口ガード・退避先・幕の後始末をソース不変条件として凍結する
 * (レンダラのテスト環境がこのリポジトリに無いため。fx-video-pool.spec.ts /
 * fx-hold-safety.spec.ts と同型)。
 *
 * 読み口の \r\n 正規化は必須 — Windows CI は CRLF でチェックアウトするので、
 * 開発機と ubuntu で緑でもタグビルドだけ落ちる。
 */
const MONITOR = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8').replace(/\r\n/g, '\n');
const FX_LIB = readFileSync(resolve('src/renderer/lib/fx.ts'), 'utf8').replace(/\r\n/g, '\n');

const TAP_LOCK_DIR = join(__dirname, '../../src/renderer/assets/fx/tap-lock');

/** コンポーネント直下(2スペースインデント)の関数本文を切り出す。 */
function fnBody(src: string, name: string): string {
  const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\r?\\n {2}\\}`));
  expect(m, `${name} が見つからない`).toBeTruthy();
  return m![0];
}

describe('お邪魔の導入カットイン — 尺の契約', () => {
  it('導入は封印の下限(TAP_LOCK_DURATION_MIN_SEC)を超えない', () => {
    // 超えると「動画が明けた時点でもう解けている」= 何が起きたか分からないまま終わる。
    // 現状は 5 秒 = 5 秒でちょうど等しい(等号は許す)。
    expect(TAP_LOCK_INTRO_MS).toBeLessThanOrEqual(TAP_LOCK_DURATION_MIN_SEC * 1000);
  });
});

describe('お邪魔の導入カットイン — 入口ガード(tapLockWillStart)', () => {
  const GUARD = MONITOR.match(/function tapLockWillStart\([\s\S]*?\n\}/)?.[0] ?? '';

  it('関数が存在し、4条件すべてを見る', () => {
    expect(GUARD, 'tapLockWillStart が無い').not.toBe('');
    // 素材未投入 → null 縮退(革命のような仮流用は置かない)。
    expect(GUARD).toContain('TAP_LOCK_INTRO_CLIP_URL != null');
    // 動画マスタースイッチ。
    expect(GUARD).toContain('clipsEnabled');
    // **封印が導入より短いと出さない** — この検査がこのファイルの主眼。
    expect(GUARD).toContain('(e.tapLockMs ?? 0) >= TAP_LOCK_INTRO_MS');
    // 動きの抑制(boostWillStart / revolutionWillStart と同じ)。
    expect(GUARD).toContain('!prefersReducedMotion()');
  });

  it('cfg を直接読まない(純関数のままテストできる形を保つ)', () => {
    expect(GUARD).not.toContain('cfg?.');
  });
});

describe('お邪魔の導入カットイン — 退避先と後始末', () => {
  it('開始できないときは従来どおり即バナー(告知は必ず出る)', () => {
    // 封印は既に効いているので、幕を諦めても告知を落としてはいけない。
    expect(MONITOR).toContain('if (!startTapLockFx(e)) pushTapLockBanner(e);');
  });

  it('バナーの実装は pushTapLockBanner 1箇所だけ(2経路で文言が割れない)', () => {
    expect([...MONITOR.matchAll(/'bad banner-tap-lock'/g)].length).toBe(1);
  });

  it('告知は導入が明けてから出す(5秒の見せ場に文字を被せない)', () => {
    const finish = fnBody(MONITOR, 'finishTapLockFx');
    expect(finish).toContain('pushTapLockBanner(e)');
    // 幕を畳んでから告知(順序が逆だと不透明動画の上にバナーが乗る)。
    expect(finish.indexOf('setTapLockClip(null);')).toBeLessThan(finish.indexOf('pushTapLockBanner(e)'));
  });

  it('reset/stop の破棄(abortTapLockFx)は告知を出さない', () => {
    expect(fnBody(MONITOR, 'abortTapLockFx')).not.toContain('pushTapLockBanner');
  });

  it('据え置きは必ず解除される(finish と abort の両方で null 代入)', () => {
    for (const name of ['finishTapLockFx', 'abortTapLockFx']) {
      expect(fnBody(MONITOR, name), name).toContain('setHeldValue(null);');
    }
  });

  it('番犬の期限を張り、超過したら finishTapLockFx で畳む(孤児ホールドを作らない)', () => {
    expect(fnBody(MONITOR, 'startTapLockFx')).toContain('fxHoldDeadlines.current.tapLock =');
    expect(MONITOR).toContain('ホールド番犬: tapLock が期限超過');
  });

  it('6 ホールドすべてが opaqueCutinActive / anyCutinHold に載っている', () => {
    for (const name of ['opaqueCutinActive', 'anyCutinHold']) {
      expect(fnBody(MONITOR, name), name).toContain('tapLockHold.current');
    }
  });

  it('導入中は残り秒 HUD を出さない(HUD は .fx-layer = 不透明動画より手前)', () => {
    expect(MONITOR).toContain('tapLockClip === null');
  });
});

describe('お邪魔の導入カットイン — 素材の解決(renderer/lib/fx.ts)', () => {
  it('0 件許容の glob で拾い、無ければ null(仮流用を置かない)', () => {
    expect(FX_LIB).toContain("import.meta.glob('../assets/fx/tap-lock/*.mp4'");
    expect(FX_LIB).toContain(
      "export const TAP_LOCK_INTRO_CLIP_URL: string | null =\n  tapLockGlob['../assets/fx/tap-lock/intro.mp4'] ?? null;"
    );
  });
});

describe.skipIf(!existsSync(TAP_LOCK_DIR))('お邪魔の導入カットイン — 実ファイル(assets/fx/tap-lock/)', () => {
  const files = readdirSync(TAP_LOCK_DIR).filter((f) => f.endsWith('.mp4'));

  it('intro.mp4 だけが居る(孤児の検出 — 解決するのはこの1本のみ)', () => {
    expect(files).toEqual(['intro.mp4']);
  });
});
