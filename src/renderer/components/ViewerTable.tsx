import { memo, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { ViewerSortKey, ViewerTableRow } from '@shared/dto';
import { compact, num } from '@shared/format';
import { relativeDayJa } from '@shared/time';
import { liveRow } from '../state/liveStore';
import { Avatar, Observed, TierBadge } from './common';
import { MemoButton } from './Memo';

const COLS: Array<{ key: ViewerSortKey | null; label: string; title?: string }> = [
  { key: null, label: '' },
  { key: 'nickname', label: 'リスナー' },
  { key: 'visits', label: '来店', title: '来店回数（観測ベース）' },
  { key: 'likesCurrent', label: '今回💗', title: '今回の配信でこの人が押したいいね（観測値）' },
  { key: 'likesLifetime', label: '累計💗', title: '記録開始以降の累計いいね（観測値）' },
  { key: 'diamondsCurrent', label: '今回💎' },
  { key: 'heartMeLifetime', label: 'ハトミー', title: 'ギフト「Heart Me」の累計受領数' },
  { key: null, label: '最終コメント / 前回来店' },
];

export const ViewerTable = memo(function ViewerTable({
  rows,
  sort,
  desc,
  onSort,
  onPick,
  showAvatars,
}: {
  rows: ViewerTableRow[];
  sort: ViewerSortKey;
  desc: boolean;
  onSort: (k: ViewerSortKey) => void;
  onPick: (userId: string) => void;
  showAvatars: boolean;
  /**
   * live delta の世代。値そのものは使わないが、memo を破って可視行だけ再描画
   * させる — 全 5000 行を親で再マップするより桁違いに安い。DB 行は8秒ごとの
   * 再クエリで追いつくので、その間の鮮度は下の liveRow マージが埋める。
   */
  liveTick?: number;
}) {
  const parentRef = useRef<HTMLDivElement>(null);
  const virt = useVirtualizer({
    count: rows.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => 40,
    overscan: 12,
  });

  const items = virt.getVirtualItems();
  const head = useMemo(
    () => (
      <div className="vt-head">
        {COLS.map((c, i) => (
          <div key={i} title={c.title}>
            {c.key ? (
              <button onClick={() => onSort(c.key!)}>
                {c.label}
                {sort === c.key ? (desc ? ' ▾' : ' ▴') : ''}
              </button>
            ) : (
              c.label
            )}
          </div>
        ))}
      </div>
    ),
    [sort, desc, onSort]
  );

  return (
    <>
      {head}
      <div ref={parentRef} className="body">
        <div style={{ height: virt.getTotalSize(), position: 'relative' }}>
          {items.map((vi) => {
            const r = rows[vi.index];
            if (!r) return null;
            // DB 行(8秒ごと更新)に live 集計を重ねて、数字が巻き戻って見える
            // 瞬間を作らない。可視行ぶんだけなので毎 tick でも実質タダ。
            const l = liveRow(r.userId);
            const likesCurrent = l ? Math.max(r.likesCurrent, l.likes) : r.likesCurrent;
            const diamondsCurrent = l ? Math.max(r.diamondsCurrent, l.diamonds) : r.diamondsCurrent;
            const presentNow = r.presentNow || (l != null && l.lastSeenMs > 0);
            return (
              <div
                key={r.userId}
                className={`vt-row${presentNow ? '' : ' absent'}`}
                style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${vi.start}px)` }}
                onClick={() => onPick(r.userId)}
              >
                <Avatar url={r.avatarUrl} name={r.nickname} enabled={showAvatars} />
                <div className="vt-name">
                  <span className="nm">{r.nickname || r.displayId || r.userId}</span>
                  {r.readingKana ? <span className="kana">（{r.readingKana}）</span> : null}
                  {/* Memo without leaving the table — the row click opens the full card. */}
                  <MemoButton
                    viewer={{ userId: r.userId, nickname: r.nickname, note: r.note, readingKana: r.readingKana }}
                  />
                  {r.isFirstEver ? <span className="badge first">初見</span> : null}
                  <TierBadge tier={r.vipTier} />
                  {r.isModerator ? <span className="badge mod">モデ</span> : null}
                  {r.isSubscriber ? <span className="badge sub">サブ</span> : null}
                </div>
                <div className="num">{num(r.visits)}</div>
                <div className="num">{compact(likesCurrent)}</div>
                <div className="num faint">{compact(r.likesLifetime)}</div>
                <div className="num">{diamondsCurrent ? compact(diamondsCurrent) : '—'}</div>
                <div className="num">{r.heartMeLifetime ? num(r.heartMeLifetime) : '—'}</div>
                <div className="vt-sub" title={r.note ? `📝 ${r.note}` : (r.lastComment ?? '')}>
                  {r.note ? <span style={{ color: 'var(--gold)' }}>📝{r.note} · </span> : null}
                  {r.lastComment ? (
                    <>
                      {r.lastComment}
                      {r.prevVisitMs ? <span className="faint"> · 前回 {relativeDayJa(r.prevVisitMs)}</span> : null}
                    </>
                  ) : r.prevVisitMs ? (
                    <span className="faint">前回 {relativeDayJa(r.prevVisitMs)}</span>
                  ) : !r.note ? (
                    <span className="faint">—</span>
                  ) : null}
                </div>
              </div>
            );
          })}
        </div>
        {rows.length === 0 ? <div className="empty">まだ記録がありません。</div> : null}
      </div>
    </>
  );
});

export function ObservedLegend(): React.JSX.Element {
  return (
    <span className="faint" style={{ fontSize: 11 }}>
      来店回数・いいねは観測値
      <Observed />
    </span>
  );
}
