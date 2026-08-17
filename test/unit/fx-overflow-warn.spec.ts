import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * モニターのキュー溢れ経路は**必ず fxWarn の痕跡を残す**、のソース不変条件
 * (fx-hold-safety.spec.ts と同じ流儀 — レンダラのテスト環境がこのリポジトリに
 * 無いので、契約はソーステキストで機械的に守る)。
 *
 * 背景: pendingBands(カットイン持ち越し)の満杯だけ else 節が無く、5件目以降の
 * 帯域/全面カットが**無言で**消えていた。worker は fxAllowed 判定で凍結を既に
 * 張っているため「カウンタは止まったのに映像が出ない」という最悪の見え方になり、
 * diag.log にも console にも何も残らない — 網羅監査(2026-08-16)で検出。
 */

const SRC = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8').replace(/\r\n/g, '\n');

describe('キュー溢れの痕跡(fxWarn)', () => {
  it('pendingBands 満杯の else 節に fxWarn がある(無言破棄の再発防止)', () => {
    const m =
      /if \(pendingBands\.current\.length < PENDING_BANDS_MAX\) \{[\s\S]{0,400}?\} else \{[\s\S]{0,600}?fxWarn\(`カットイン持ち越しが上限/.exec(
        SRC
      );
    expect(m, 'pendingBands の満杯分岐に else + fxWarn が無い').not.toBeNull();
  });

  it('4つの溢れ経路すべてに fxWarn が居る(退行防止の点呼)', () => {
    // 文言は表示仕様ではないので「経路ごとに1つ以上」だけを固定する。
    for (const needle of [
      'バナーの順番待ちが上限', // enqueueBanner(BANNER_QUEUE_MAX)
      'カットイン持ち越しが上限', // pendingBands(PENDING_BANDS_MAX)
      'ルーレット: キュー満杯で盤面違い', // rouletteQueue(ROULETTE_QUEUE_MAX)
      'boost-start: 持ち越しキュー満杯', // pendingBoosts(PENDING_BOOSTS_MAX)
    ]) {
      expect(SRC.includes(needle), `溢れ経路の fxWarn が消えている: ${needle}`).toBe(true);
    }
  });
});
