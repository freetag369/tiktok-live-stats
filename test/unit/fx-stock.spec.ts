import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  EMPTY_FX_STOCK,
  FX_STOCK_DISPLAY_MAX,
  STOCK_SECTION_ORDER,
  buildFxStock,
  fxStockKey,
  type FxStockSnapshot,
} from '@shared/fx-stock';

/**
 * 演出ストック表示(右下オーバーレイの縦リスト)の組み立ての固定。
 *
 * 契約:
 * - 並び順は playing(再生中・先頭) → clear → boost → band → roulette → workerQueue
 * - メイン行は FX_STOCK_DISPLAY_MAX(5)まで(playing 込み)、溢れは overflow(+N)
 * - 連続ぶんは count(×N)。再生中は remaining がそのまま count になり、
 *   スピン/ショットを消費するたび同じ key の行の上で減っていく
 * - item.key は effect.id ベースで**キュー→再生中を跨いで安定** — FxStockRow の
 *   スライド(FLIP)と「同じ行のまま ×N が減る」見え方はこの安定性が前提
 * - 満杯系(pendingStrike)は表示しない(ユーザー指定 — スナップショットにも無い)
 */

function snap(over: Partial<FxStockSnapshot> = {}): FxStockSnapshot {
  return {
    playing: null,
    achievedPending: false,
    boosts: [],
    bands: [],
    joinRoulettes: [],
    roulettes: [],
    workerQueue: [],
    ...over,
  };
}

describe('buildFxStock', () => {
  it('空スナップショット → 空ビュー(共有インスタンス)', () => {
    expect(buildFxStock(snap())).toEqual({ items: [], overflow: 0 });
    expect(buildFxStock(snap())).toBe(EMPTY_FX_STOCK);
  });

  it('並び順の固定と5行上限: playing が先頭、6メインは末尾の workerQueue が溢れる', () => {
    const v = buildFxStock(
      snap({
        playing: { kind: 'roulette', id: 99, nickname: 'いま', remaining: 3 },
        achievedPending: true,
        boosts: [{ id: 10, nickname: 'ぶ' }],
        bands: [{ id: 11, nickname: 'か', rep: 1 }],
        roulettes: [{ id: 12, nickname: 'る', spins: 1 }],
        workerQueue: [{ id: 3, kind: 'band', nickname: 'よこく' }],
      })
    );
    expect(v.items.map((it) => it.key)).toEqual([
      'roulette:99',
      'clear',
      'boost:10',
      'band:11',
      'roulette:12',
    ]);
    expect(v.items[0]).toEqual({
      key: 'roulette:99',
      kind: 'roulette',
      name: 'いま',
      count: 3,
      playing: true,
    });
    expect(v.items).toHaveLength(FX_STOCK_DISPLAY_MAX);
    expect(v.overflow).toBe(1);
  });

  it('キー契約(FLIP の前提): キュー→再生中で key が変わらず、count = remaining に置き換わる', () => {
    const queued = buildFxStock(snap({ roulettes: [{ id: 7, nickname: 'A', spins: 4 }] }));
    expect(queued.items).toEqual([
      { key: 'roulette:7', kind: 'roulette', name: 'A', count: 4, playing: false },
    ]);
    const playing = buildFxStock(
      snap({ playing: { kind: 'roulette', id: 7, nickname: 'A', remaining: 4 } })
    );
    expect(playing.items).toEqual([
      { key: 'roulette:7', kind: 'roulette', name: 'A', count: 4, playing: true },
    ]);
    // スピンを1本消費 → 同じ key のまま count だけ減る
    const consumed = buildFxStock(
      snap({ playing: { kind: 'roulette', id: 7, nickname: 'A', remaining: 3 } })
    );
    expect(consumed.items[0]).toEqual({
      key: 'roulette:7',
      kind: 'roulette',
      name: 'A',
      count: 3,
      playing: true,
    });
  });

  it('先頭を消費しても残った行の key は不変', () => {
    const before = buildFxStock(
      snap({ boosts: [{ id: 1 }, { id: 2 }], roulettes: [{ id: 5, spins: 1 }] })
    );
    const after = buildFxStock(snap({ boosts: [{ id: 2 }], roulettes: [{ id: 5, spins: 1 }] }));
    expect(before.items.map((it) => it.key)).toEqual(['boost:1', 'boost:2', 'roulette:5']);
    expect(after.items.map((it) => it.key)).toEqual(['boost:2', 'roulette:5']);
  });

  it('昇格: 6件から先頭を消費すると隠れていた6件目が安定 key のまま現れ、overflow が減る', () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const before = buildFxStock(snap({ bands: ids.map((id) => ({ id, rep: 1 })) }));
    expect(before.overflow).toBe(1);
    const after = buildFxStock(snap({ bands: ids.slice(1).map((id) => ({ id, rep: 1 })) }));
    expect(after.items.map((it) => it.key)).toEqual([
      'band:2',
      'band:3',
      'band:4',
      'band:5',
      'band:6',
    ]);
    expect(after.overflow).toBe(0);
  });

  it('count: ルーレット=スピン数・ギフト=反復数・wq=count(欠損/0 は 1 に底上げ)', () => {
    const v = buildFxStock(
      snap({
        bands: [{ id: 1, nickname: 'ば', rep: 3 }],
        roulettes: [{ id: 2, spins: 11 }, { id: 3, spins: 0 }],
        workerQueue: [
          { id: 4, kind: 'roulette', count: 5 },
          { id: 5, kind: 'band' },
        ],
      })
    );
    expect(v.items.map((it) => [it.key, it.count])).toEqual([
      ['band:1', 3],
      ['roulette:2', 11],
      ['roulette:3', 1],
      ['wq:4', 5],
      ['wq:5', 1],
    ]);
  });

  it('name: nickname を写し、欠けは空文字。clear は常に空文字', () => {
    const v = buildFxStock(
      snap({
        achievedPending: true,
        boosts: [{ id: 1, nickname: 'みかん🍊' }],
        bands: [{ id: 2, rep: 1 }],
      })
    );
    expect(v.items.map((it) => [it.kind, it.name])).toEqual([
      ['clear', ''],
      ['boost', 'みかん🍊'],
      ['band', ''],
    ]);
  });

  it('ワーカー凍結キューの予告はレンダラーのキューの後に wq: キーで並ぶ', () => {
    const v = buildFxStock(
      snap({
        roulettes: [{ id: 9, nickname: 'るれ', spins: 1 }],
        workerQueue: [
          { id: 3, kind: 'band', nickname: 'ばんど' },
          { id: 4, kind: 'roulette' },
        ],
      })
    );
    expect(v.items.map((it) => [it.key, it.kind, it.name])).toEqual([
      ['roulette:9', 'roulette', 'るれ'],
      ['wq:3', 'band', 'ばんど'],
      ['wq:4', 'roulette', ''],
    ]);
  });

  it('ワーカー予告も5行の枠と溢れ数に数える', () => {
    const v = buildFxStock(
      snap({
        boosts: [{ id: 1 }, { id: 2 }],
        workerQueue: Array.from({ length: 4 }, (_, i) => ({ id: i + 10, kind: 'band' as const })),
      })
    );
    expect(v.items).toHaveLength(5);
    expect(v.overflow).toBe(1);
    expect(v.items.map((it) => it.key)).toEqual(['boost:1', 'boost:2', 'wq:10', 'wq:11', 'wq:12']);
  });
});

describe('fxStockKey: setState 等値ガードの合成キー', () => {
  it('同じビューは同じキー', () => {
    const a = buildFxStock(snap({ boosts: [{ id: 1, nickname: 'A' }] }));
    const b = buildFxStock(snap({ boosts: [{ id: 1, nickname: 'A' }] }));
    expect(fxStockKey(a)).toBe(fxStockKey(b));
  });

  it('count(×N の減算)・playing・overflow の差はキーに現れる', () => {
    const base = fxStockKey(
      buildFxStock(snap({ playing: { kind: 'roulette', id: 1, remaining: 3 } }))
    );
    // スピン消費(remaining 3→2)で必ず違うキーになる = 必ず再レンダーされる
    expect(
      fxStockKey(buildFxStock(snap({ playing: { kind: 'roulette', id: 1, remaining: 2 } })))
    ).not.toBe(base);
    // 同じ id がキュー(playing:false)にある状態ともキーは違う
    expect(fxStockKey(buildFxStock(snap({ roulettes: [{ id: 1, spins: 3 }] })))).not.toBe(base);
    const six = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, rep: 1 }));
    expect(fxStockKey(buildFxStock(snap({ bands: six })))).not.toBe(
      fxStockKey(buildFxStock(snap({ bands: six.slice(0, 5) })))
    );
  });

  it('空は空文字(初期 ref 値と一致し、初回の空 → 空で setState しない)', () => {
    expect(fxStockKey(EMPTY_FX_STOCK)).toBe('');
  });
});

describe('monitor.css との整合(テキスト検査)', () => {
  const css = readFileSync(resolve('src/renderer/styles/monitor.css'), 'utf8').replace(/\r\n/g, '\n');

  it('.fx-stock は右下固定のオーバーレイ(position:absolute + right/bottom)', () => {
    const rule = /\.fx-stock\s*{[^}]*}/.exec(css)?.[0] ?? '';
    expect(rule).toMatch(/position:\s*absolute/);
    expect(rule).toMatch(/right:/);
    expect(rule).toMatch(/bottom:/);
  });

  it('.fxs-row に FLIP の戻り用 transition: transform がある', () => {
    const rule = /\.fxs-row\s*{[^}]*}/.exec(css)?.[0] ?? '';
    expect(rule).toMatch(/transition:\s*transform/);
  });

  it('prefers-reduced-motion で .fxs-row のアニメが止まる', () => {
    const blocks = css.match(/@media \(prefers-reduced-motion: reduce\)\s*{[\s\S]*?\n}/g) ?? [];
    expect(blocks.some((b) => b.includes('.fxs-row'))).toBe(true);
  });

  it("grid-template-areas に 'stock' エリアが残っていない(grid 撤去の回帰網)", () => {
    const areas = css.match(/grid-template-areas:[\s\S]*?;/g) ?? [];
    expect(areas.length).toBeGreaterThan(0);
    for (const a of areas) {
      expect(a).not.toMatch(/'[^']*\bstock\b[^']*'/);
    }
  });

  it('廃止済みスタイル(.fxs-strike* / .fxs-subdot)が残っていない', () => {
    expect(css).not.toMatch(/\.fxs-strike/);
    expect(css).not.toMatch(/\.fxs-subdot/);
  });
});

describe('fx-priority 序列との整合(v0.8.0)', () => {
  it('STOCK_SECTION_ORDER は優先度表から導出される(boost→join→band→roulette)', () => {
    expect(STOCK_SECTION_ORDER).toEqual(['boost', 'join-roulette', 'band', 'roulette']);
  });

  it('初見ルーレットはカットインより上・ギフトルーレットより上に並ぶ', () => {
    const v = buildFxStock(
      snap({
        boosts: [{ id: 1, nickname: 'ぶ' }],
        bands: [{ id: 2, nickname: 'か', rep: 1 }],
        joinRoulettes: [{ id: 3, nickname: 'しょ', spins: 1 }],
        roulettes: [{ id: 4, nickname: 'る', spins: 2 }],
      })
    );
    expect(v.items.map((i) => i.kind)).toEqual(['boost', 'join-roulette', 'band', 'roulette']);
    expect(v.items[1]).toMatchObject({ key: 'join-roulette:3', name: 'しょ' });
  });

  it('再生中の join-roulette も先頭行になれる', () => {
    const v = buildFxStock(
      snap({ playing: { kind: 'join-roulette', id: 9, nickname: '初', remaining: 1 } })
    );
    expect(v.items[0]).toMatchObject({ kind: 'join-roulette', playing: true, key: 'join-roulette:9' });
  });

  it('follow の予告は workerQueue 行として末尾セクションに出る(count 無し = 1)', () => {
    const v = buildFxStock(
      snap({
        bands: [{ id: 1, nickname: 'ば', rep: 1 }],
        workerQueue: [{ id: 4, kind: 'follow', nickname: 'ふ' }],
      })
    );
    expect(v.items.map((it) => it.key)).toEqual(['band:1', 'wq:4']);
    expect(v.items[1]).toEqual({ key: 'wq:4', kind: 'follow', name: 'ふ', count: 1, playing: false });
  });

  it('STOCK_SECTION_ORDER に follow は混ざらない(ref キューが無い種別 — 混ぜると roulettes が二重出力)', () => {
    expect(STOCK_SECTION_ORDER).not.toContain('follow');
  });
});
