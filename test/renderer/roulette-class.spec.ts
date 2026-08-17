import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isHelpRoulette,
  rouletteBannerClass,
  rouletteBlockSign,
  roulettePanelClass,
  rouletteScreenClass,
} from '../../src/renderer/monitor/roulette-class';

/**
 * 減らす(応援)ルーレットの「お助けテーマ」の規則。
 *
 * seg-class.spec.ts と同じ分担 — 規則そのものはここで、配線(コンポーネントが
 * 実際にこれを呼んでいること)は下のソース検査で見る。vitest は node 環境なので
 * .tsx を描画して確かめることはできない。
 *
 * **最重要は「増やす(add)が1文字も変わらないこと」** — 今回の変更は応援側の
 * 見た目を足すだけで、既存の妨害ルーレットには一切触れない約束になっている。
 */

const SRC = (p: string): string => readFileSync(join(__dirname, '../../src/renderer/monitor', p), 'utf8');

describe('roulettePanelClass — 増やす(add)は従来と完全に同じ', () => {
  it('回転中', () => {
    expect(roulettePanelClass({ direction: 'add', amount: 30, hit: false })).toBe('roulette-panel bad');
  });

  it('確定後', () => {
    expect(roulettePanelClass({ direction: 'add', amount: 30, hit: true })).toBe('roulette-panel bad hit');
  });

  it('direction 未指定(古い effect / rouletteDirection はキーごと省かれる)も add 扱い', () => {
    expect(roulettePanelClass({ amount: 30, hit: false })).toBe('roulette-panel bad');
  });
});

describe('roulettePanelClass — 減らす(sub)は help が付く', () => {
  it('回転中から help が付く(確定を待たない)', () => {
    expect(roulettePanelClass({ direction: 'sub', amount: -30, hit: false })).toBe(
      'roulette-panel good help'
    );
  });

  it('確定後は good help hit', () => {
    expect(roulettePanelClass({ direction: 'sub', amount: -30, hit: true })).toBe(
      'roulette-panel good help hit'
    );
  });

  it('**bad/good は従来どおり amount の符号で決める** — .hit.good .rl-block.win が依存している', () => {
    // 出目は 1 以上へ clamp されるので sub で amount >= 0 は本来起こらないが、
    // 万一起きても「緑の枠に赤い当選マス」という読み違えを作らないことを固定する。
    expect(roulettePanelClass({ direction: 'sub', amount: 0, hit: true })).toBe(
      'roulette-panel bad help hit'
    );
  });
});

describe('rouletteScreenClass — 全面暗幕(後光の色はパネルの親が持つ)', () => {
  it('add / 未指定は素のまま', () => {
    expect(rouletteScreenClass('add')).toBe('roulette-screen');
    expect(rouletteScreenClass(undefined)).toBe('roulette-screen');
  });

  it('sub で help', () => {
    expect(rouletteScreenClass('sub')).toBe('roulette-screen help');
  });
});

describe('rouletteBannerClass — 確定バナー(±N 浮上)', () => {
  it('add は従来と完全に同じ文字列', () => {
    expect(rouletteBannerClass({ direction: 'add', amount: 30 })).toBe('bad banner-roulette');
    expect(rouletteBannerClass({ amount: 30 })).toBe('bad banner-roulette');
  });

  it('sub は good banner-roulette help', () => {
    expect(rouletteBannerClass({ direction: 'sub', amount: -30 })).toBe('good banner-roulette help');
  });

  it('**gift-card トークンを含まない** — bannerDurationMs が 2200ms を返すと尺がズレる', () => {
    for (const cls of [
      rouletteBannerClass({ direction: 'sub', amount: -30 }),
      rouletteBannerClass({ direction: 'add', amount: 30 }),
    ]) {
      expect(cls.split(/\s+/)).not.toContain('gift-card');
    }
  });
});

describe('rouletteBlockSign — リールのマスに出す符号', () => {
  it('add / 未指定は出さない(従来どおり確定した当選マスだけ)', () => {
    expect(rouletteBlockSign('add')).toBeNull();
    expect(rouletteBlockSign(undefined)).toBeNull();
  });

  it('sub は全マスにマイナス', () => {
    expect(rouletteBlockSign('sub')).toBe('-');
  });
});

describe('isHelpRoulette', () => {
  it("'sub' だけが true", () => {
    expect(isHelpRoulette('sub')).toBe(true);
    expect(isHelpRoulette('add')).toBe(false);
    expect(isHelpRoulette(undefined)).toBe(false);
  });
});

/**
 * 配線のソース検査。**ここが剥がれると設定が恒久的に効かなくなる**ので、
 * roulette-sound.spec.ts の同型の検査と同じ理由で凍結しておく。
 */
describe('配線 — コンポーネントが実際に共有ヘルパを呼んでいる', () => {
  it('RouletteFx が roulettePanelClass / rouletteBlockSign を使う(クラス直書きへ戻さない)', () => {
    const src = SRC('RouletteFx.tsx');
    expect(src).toContain('roulettePanelClass({ direction, amount, hit })');
    expect(src).toContain('rouletteBlockSign(direction)');
    // 旧実装のテンプレートリテラル直書きへ戻していないこと。
    expect(src).not.toContain('`roulette-panel ${');
  });

  it('**ゴーストブロック(.rl-jack)にも符号を出す** — 本物と見分けが付くとフェイクが成立しない', () => {
    const src = SRC('RouletteFx.tsx');
    const jack = src.slice(src.indexOf('className="rl-block rl-jack"'));
    expect(jack.indexOf('blockSign'), 'ゴーストに blockSign が無い').toBeGreaterThan(-1);
    // 本物のマスとゴーストの両方 = blockSign を読む箇所が2つ以上。
    expect(src.split('blockSign !== null').length - 1).toBeGreaterThanOrEqual(2);
  });

  it('RouletteFx が見出しへ向きを渡す(パネルとバナーで文言をそろえる規約)', () => {
    expect(SRC('RouletteFx.tsx')).toContain('rouletteDirection: direction');
  });

  it('MonitorView の確定バナー4箇所が全部 rouletteBannerClass を通る', () => {
    const src = SRC('MonitorView.tsx');
    expect(src.split('rouletteBannerClass(').length - 1).toBe(4);
    // 旧いクラス直書きが1つも残っていないこと。
    expect(src).not.toContain("} banner-roulette`");
  });

  it('MonitorView が暗幕と RouletteFx へ向きを配線している', () => {
    const src = SRC('MonitorView.tsx');
    expect(src).toContain('rouletteScreenClass(roulette.effect.rouletteDirection)');
    expect(src).toContain("direction={roulette.effect.rouletteDirection ?? 'add'}");
    expect(src).not.toContain('className="roulette-screen"');
  });

  it('確定音の方向分岐が生きている(cfg 直読みへ巻き戻さない)', () => {
    const src = SRC('MonitorView.tsx');
    expect(src).toContain("playSeSlot(e.rouletteDirection === 'sub' ? 'helper' : 'roulette-hit')");
    expect(src).not.toContain("cfg.challenge.seSounds['roulette-hit']");
  });

  /**
   * 超激アツの倍率フェイク。**当選 index に依存しない**ことがアンチリークの生命線で、
   * 「全マスに一律で掛ける」「確定の瞬間に素へ戻す」の2点が剥がれると壊れる。
   */
  it('倍率は**全マス一律**に掛かる(当選マスだけ変えると出目が漏れる)', () => {
    const src = SRC('RouletteFx.tsx');
    // strip.map の中の描画が num(v * mult) であること = 104 ブロック全部に掛かる。
    expect(src).toContain('{num(v * mult)}');
    // 当選マスだけを特別扱いして倍率を掛ける書き方へ戻していないこと。
    expect(src).not.toMatch(/ROULETTE_TARGET_BLOCK[^\n]*mult/);
  });

  it('倍率は finish() で 1 へ戻る(確定した数字が倍のまま固まらない)', () => {
    const src = SRC('RouletteFx.tsx');
    // 終端は「関数の閉じ」= インデント2の }。`useLayoutEffect` を終端に使うと
    // import 行のほうが先に一致して空スライスになる(一度踏んだ)。
    const from = src.indexOf('function finish()');
    const finish = src.slice(from, src.indexOf('\n  }\n', from));
    expect(finish, 'finish() の中で素へ戻していない').toContain('setMult(1)');
    expect(finish, 'finish() で戻りコールバックを呼んでいない').toContain('onSettle?.()');
  });

  it('倍率のクラスとバッジが出る(色替えと ×N倍 の表示)', () => {
    const src = SRC('RouletteFx.tsx');
    expect(src).toContain('rl-x rl-x${mult}');
    expect(src, 'バッジは key={mult} で作り直す(pop が再生されない)').toContain('key={mult}');
    expect(src).toContain('className="rl-mult"');
  });
});
