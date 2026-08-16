import { useLayoutEffect, useRef } from 'react';
import type { FxStockItem, FxStockKind, FxStockView } from '@shared/fx-stock';

/**
 * 演出ストック(再生中+待機中の演出)の縦リスト — ステージ右下のオーバーレイ。
 * fx-layer 内・DOM 順でルーレットの後に置かれるので、スピン中の暗幕・ultra 全面
 * 動画・不透明カットインの上にも常に見える(ユーザー要件)。
 *
 * 各行は buildFxStock(@shared/fx-stock)が組んだ「種別 + 行為者名 + ×N」。
 * 先頭は再生中の演出(playing)で、連続ルーレットのスピン/連続ギフトの
 * ショットを消費するたび ×N が同じ行の上で減っていく。key は effect.id ベース
 * (item.key)で安定しているので、先頭が消えると残った行が同じ DOM のまま
 * 上の座席へ移る — その移動を FLIP(旧位置との差分を transform に入れてから
 * 0 へ transition)でスライドとして見せる。
 */

/** MonitorView / LikeGauge の同名関数と同じ(import すると循環するため複製)。 */
function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

const LABELS: Record<FxStockKind, string> = {
  clear: 'CLEAR',
  boost: 'ブースト',
  // 内部名は band(帯/フルカットのカットイン)だが、視聴者向けには「ギフト」(ユーザー指定)。
  band: 'ギフト',
  'join-roulette': '初見ルーレット',
  roulette: 'ルーレット',
  // 凍結中の予告(workerQueue)のみ — フォローはレンダラー側キューを持たない。
  follow: 'フォロー',
};

function Row({ item }: { item: FxStockItem }): React.JSX.Element {
  return (
    <div className={`fxs-row fxs-${item.kind}${item.playing ? ' playing' : ''}`} data-k={item.key}>
      <span className="fxs-kind">{LABELS[item.kind]}</span>
      {item.name !== '' ? <span className="fxs-name">{item.name}</span> : null}
      {item.count >= 2 ? <span className="fxs-mult">×{item.count}</span> : null}
    </div>
  );
}

export function FxStockRow({ stock }: { stock: FxStockView }): React.JSX.Element {
  const listRef = useRef<HTMLDivElement | null>(null);
  /** 前回コミット時の行位置(data-k → offsetTop)。null = 初回(アニメしない)。 */
  const prevTops = useRef<Map<string, number> | null>(null);

  // FLIP: 残った行の旧位置との差分を transform に入れ、リフローで確定してから
  // インラインを外す — スタイルシートの transition が 0 へ戻す = スライド。
  // callback-ref の簿記を持たず children を走査するので、StrictMode の
  // 二重実行でも安全(1回目が種まき、2回目は prev == next で無動作)。
  // インラインは同じエフェクト内で同期的に外すため transform の固着は起きない。
  // offsetTop の基準(offsetParent)は絶対配置の .fx-stock 自身 — コンテナは
  // 右下に固定で動かないので、差分は常に行の座席移動そのものになる。
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const rows = Array.from(list.children).filter((el): el is HTMLElement => el instanceof HTMLElement);
    const next = new Map<string, number>();
    for (const el of rows) {
      if (el.dataset.k !== undefined) next.set(el.dataset.k, el.offsetTop);
    }
    const prev = prevTops.current;
    prevTops.current = next;
    if (prev === null || prefersReducedMotion()) return;
    const moved: Array<{ el: HTMLElement; dy: number }> = [];
    for (const el of rows) {
      const k = el.dataset.k;
      if (k === undefined) continue;
      const p = prev.get(k);
      const n = next.get(k);
      if (p !== undefined && n !== undefined && p !== n) moved.push({ el, dy: p - n });
    }
    if (moved.length === 0) return;
    for (const m of moved) {
      m.el.style.transition = 'none';
      m.el.style.transform = `translateY(${m.dy}px)`;
    }
    void list.offsetWidth; // リフローで反転位置を確定させる(punch 再生と同じイディオム)
    for (const m of moved) {
      m.el.style.transition = '';
      m.el.style.transform = '';
    }
  }, [stock]);

  return (
    <div className="fx-stock" aria-hidden="true" ref={listRef}>
      {stock.items.map((it) => (
        <Row key={it.key} item={it} />
      ))}
      {stock.overflow > 0 ? (
        <div className="fxs-row fxs-more" data-k="more">
          +{stock.overflow}
        </div>
      ) : null}
    </div>
  );
}
