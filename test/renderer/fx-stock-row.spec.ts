import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FxStockRow } from '../../src/renderer/monitor/FxStockRow';
import { buildFxStock, type FxStockSnapshot, type FxStockView } from '@shared/fx-stock';

/**
 * 演出ストック(モニター右下の縦リスト)の実レンダー。
 *
 * 検査の主眼は「buildFxStock が出した count / 溢れが**そのまま画面の文字**に
 * なるか」— ×N が 20 で頭打ちだった不具合は shared 側の式の問題だったが、
 * 表示側にも `count >= 2` ゲートと溢れ行の文言という独自の判断がある。
 *
 * seven-seg.spec.ts と同じ流儀で jsdom を使わない。renderToStaticMarkup は
 * node でそのまま動く。useLayoutEffect(FLIP)は SSR では走らないが、ここで
 * 見たいのは props → マークアップの部分なので影響しない。
 */

function snap(over: Partial<FxStockSnapshot> = {}): FxStockSnapshot {
  return {
    playing: null,
    achievedPending: false,
    boosts: [],
    bands: [],
    joinRoulettes: [],
    hotRoulettes: [],
    roulettes: [],
    workerQueue: [],
    ...over,
  };
}

function render(stock: FxStockView): string {
  return renderToStaticMarkup(createElement(FxStockRow, { stock }));
}

describe('FxStockRow — 演出ストックの実レンダー', () => {
  it('20を超える連打の ×N がそのまま出る(頭打ちしない)', () => {
    const html = render(buildFxStock(snap({ roulettes: [{ id: 1, nickname: 'たろう', count: 47 }] })));
    expect(html).toContain('<span class="fxs-mult">×47</span>');
    expect(html).toContain('<span class="fxs-name">たろう</span>');
    expect(html).toContain('data-k="roulette:1"');
  });

  it('1回のときは ×N の span ごと出さない(「×1」を並べない)', () => {
    const html = render(buildFxStock(snap({ roulettes: [{ id: 1, nickname: 'たろう', count: 1 }] })));
    expect(html).not.toContain('fxs-mult');
  });

  it('再生中の行は playing クラスが付き、残数が ×N になる', () => {
    const html = render(
      buildFxStock(snap({ playing: { kind: 'roulette', id: 9, nickname: 'いま', remaining: 28 } }))
    );
    expect(html).toContain('class="fxs-row fxs-roulette playing"');
    expect(html).toContain('×28');
  });

  it('溢れ行は「ほか N 件 計 N 回」— 連打が沈んでいるときだけ回数が付く', () => {
    const combo = buildFxStock(
      snap({
        roulettes: [
          { id: 1, count: 1 },
          { id: 2, count: 1 },
          { id: 3, count: 1 },
          { id: 4, count: 1 },
          { id: 5, count: 1 },
          { id: 6, count: 30 },
          { id: 7, count: 12 },
        ],
      })
    );
    const html = render(combo);
    expect(html).toContain('data-k="more"');
    expect(html).toContain('ほか2件 計42回');

    // 溢れが全部単発なら件数だけ(「ほか2件 計2回」と二度言わない)。
    const singles = buildFxStock(
      snap({ roulettes: [1, 2, 3, 4, 5, 6, 7].map((id) => ({ id, count: 1 })) })
    );
    expect(render(singles)).toContain('ほか2件</div>');
  });

  it('溢れが無ければ溢れ行を出さない', () => {
    expect(render(buildFxStock(snap({ roulettes: [{ id: 1, count: 3 }] })))).not.toContain('fxs-more');
  });
});
