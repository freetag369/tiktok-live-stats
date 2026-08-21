import { useMemo, useState } from 'react';
import type { ChallengeConfig } from '@shared/dto';
import { useQuery } from '../ipc/client';
import { toast } from '../state/uiStore';
import { hintOf, labelOf, usagesOf, type Usage } from './gift-list-usages';

/**
 * 【ギフトリスト】受信済み全ギフトの giftId ↔ ギフト名 対応表。
 *
 * 置き場所がカウントダウンチャレンジ設定の**最後尾のタブ**なのは、ここが表の
 * 唯一の使い道だから — giftFullCut / roulettes / tapBoost / tapLock / fanStamp /
 * revolution / giftRules はどれも giftId 完全一致が本線で、その giftId を
 * 「実際に受け取った実績」から引くための表になる。
 *
 * **出所は DB(gift_catalog)で、作業ディレクトリの Markdown の写しではない。**
 * 手書きの表は書いた瞬間から古くなる(2026-08-20 の 218 種 → 翌日 221 種)。
 * ギフトは受信のたびに gift_catalog へ自動記録されるので、ここを DB 直結に
 * しておけば「内容の更新」という作業そのものが消える。
 *
 * 「現在の用途」列は**設定の実物**(この画面の下書き cfg)を shared の
 * match* にそのまま食わせて出す — 目視の突き合わせをやめるため。判定を
 * ここで書き直すと本番と乖離するので、必ず shared の関数を経由すること。
 */

/** 1 は連打(コンボ)あり。2・4 は単発系。未受信で不明なら空。 */
function typeLabel(t: number | null): string {
  if (t == null) return '';
  return t === 1 ? '1 連打' : String(t);
}

function ymd(ms: number | null): string {
  if (ms == null) return '';
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())}`;
}

/**
 * giftId をクリップボードへ。Electron のレンダラは file:// で読み込まれると
 * secure context にならず navigator.clipboard が生えないことがあるので、
 * 旧 API へ落ちる道を残す(コピーは設定作業の主動線なので黙って失敗させない)。
 */
function copyGiftId(giftId: string): void {
  const ok = (): void => toast({ level: 'info', msgJa: `giftId ${giftId} をコピーしました` });
  const fallback = (): void => {
    const ta = document.createElement('textarea');
    ta.value = giftId;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const done = document.execCommand('copy');
    document.body.removeChild(ta);
    if (done) ok();
    else toast({ level: 'error', msgJa: `コピーできませんでした(giftId ${giftId})` });
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(giftId).then(ok, fallback);
    return;
  }
  fallback();
}

type SortKey = 'giftId' | 'diamonds' | 'count' | 'lastSeen' | 'name';

const SORTS: Array<[SortKey, string]> = [
  ['giftId', 'giftId 昇順'],
  ['diamonds', '💎単価が高い順'],
  ['count', '受信回数が多い順'],
  ['lastSeen', '最近受け取った順'],
  ['name', 'ギフト名順'],
];

export function GiftListSection({ cfg }: { cfg: ChallengeConfig }): React.JSX.Element {
  // タブを開いたときの1回だけ。gift_event の全走査を含むので delta では引き直さない
  // (走っている間 worker は press を配送できない — queries/gifts.ts のコメント)。
  const { data, error, loading, reload } = useQuery('q.giftCatalog', undefined, []);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('giftId');
  const [usedOnly, setUsedOnly] = useState(false);

  const rows = useMemo(() => data ?? [], [data]);

  // 用途は設定が変わるたびに引き直す(下書きを編集した結果がそのまま出る)。
  const usage = useMemo(() => {
    const m = new Map<string, Usage[]>();
    for (const r of rows) m.set(r.giftId, usagesOf(cfg, r));
    return m;
  }, [rows, cfg]);

  const view = useMemo(() => {
    const needle = q.trim().toLowerCase();
    let list = rows;
    if (needle) list = list.filter((r) => r.name.toLowerCase().includes(needle) || r.giftId.includes(needle));
    if (usedOnly) list = list.filter((r) => (usage.get(r.giftId)?.length ?? 0) > 0);
    const sorted = [...list];
    sorted.sort((a, b) => {
      switch (sort) {
        case 'diamonds':
          return b.diamonds - a.diamonds || Number(a.giftId) - Number(b.giftId);
        case 'count':
          return b.count - a.count || Number(a.giftId) - Number(b.giftId);
        case 'lastSeen':
          return (b.lastSeenMs ?? 0) - (a.lastSeenMs ?? 0);
        case 'name':
          return a.name.trim().localeCompare(b.name.trim(), 'ja') || Number(a.giftId) - Number(b.giftId);
        default:
          return Number(a.giftId) - Number(b.giftId);
      }
    });
    return sorted;
  }, [rows, q, sort, usedOnly, usage]);

  const usedCount = useMemo(() => rows.filter((r) => (usage.get(r.giftId)?.length ?? 0) > 0).length, [rows, usage]);

  return (
    <>
      <h4 style={{ margin: '0 0 6px' }}>ギフトリスト(受信済み全ギフトの giftId ↔ ギフト名)</h4>
      <div className="faint" style={{ fontSize: 11, marginBottom: 10, lineHeight: 1.6 }}>
        この配信に<b>実際に届いたギフト</b>だけが並びます(受信のたびにデータベースへ自動記録されるので、
        新しいギフトを1回もらえば翌回からここに出ます)。
        <br />
        設定は<b>必ず giftId で</b>行ってください。ギフト名は<b>同名別ID</b>(<code>Hand Heart</code> は4つ)・
        <b>前後スペース</b>・綴り揺れがあり、名前では特定できません。giftId をクリックするとコピーできます。
      </div>

      <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
        <input
          type="search"
          value={q}
          placeholder="ギフト名 / giftId で絞り込み"
          onChange={(e) => setQ(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
          {SORTS.map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </select>
        <label className="row" style={{ gap: 4, cursor: 'pointer', fontSize: 12 }}>
          <input type="checkbox" checked={usedOnly} onChange={(e) => setUsedOnly(e.target.checked)} />
          <span>設定で使用中のみ({usedCount})</span>
        </label>
        <button type="button" onClick={reload} disabled={loading}>
          {loading ? '読み込み中…' : '更新'}
        </button>
        <span className="faint" style={{ fontSize: 11 }}>
          全 {rows.length} 種{view.length !== rows.length ? ` / 表示 ${view.length} 種` : ''}
        </span>
      </div>

      {error ? (
        <div className="notice" style={{ marginBottom: 8 }}>
          ギフトリストを読めませんでした: {error}
        </div>
      ) : null}

      {rows.length === 0 && !loading && !error ? (
        <div className="empty">
          まだ1件もギフトを受け取っていません。配信に接続してギフトが届くと、ここに giftId 付きで並びます。
        </div>
      ) : (
        <div style={{ maxHeight: 560, overflow: 'auto' }}>
          <table className="data">
            <thead>
              <tr>
                <th style={{ width: 30 }} />
                <th>ギフト名(受信原文)</th>
                <th>giftId</th>
                <th className="n">💎単価</th>
                <th className="n">type</th>
                <th className="n">最大連打</th>
                <th className="n">受信回数</th>
                <th className="n">累計💎</th>
                <th>最終受信</th>
                <th>現在の用途</th>
              </tr>
            </thead>
            <tbody>
              {view.map((r) => {
                const u = usage.get(r.giftId) ?? [];
                // 前後スペース入りの名前は名前一致の設定で外す事故のもと。目印を出す。
                const padded = r.name !== r.name.trim();
                return (
                  <tr key={r.giftId}>
                    <td style={{ padding: '3px 4px' }}>
                      {r.iconUrl ? (
                        <img src={r.iconUrl} alt="" width={22} height={22} style={{ display: 'block' }} />
                      ) : null}
                    </td>
                    <td>
                      <code>{r.name}</code>
                      {padded ? (
                        <span className="faint" title="ギフト名に前後スペースが含まれます(名前一致は要注意)">
                          {' '}
                          ␣
                        </span>
                      ) : null}
                      {r.canonical ? (
                        <span
                          className="faint"
                          style={{ fontSize: 10.5 }}
                          title="canonical(名寄せ名)。粒度が粗いので個別指定には使わないこと"
                        >
                          {' '}
                          {r.canonical}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <button
                        type="button"
                        title="クリックでコピー"
                        onClick={() => copyGiftId(r.giftId)}
                        style={{ fontFamily: 'var(--mono)', fontSize: 11.5, padding: '1px 6px' }}
                      >
                        {r.giftId}
                      </button>
                    </td>
                    <td className="n">{r.diamonds.toLocaleString()}</td>
                    <td className="n" style={{ fontSize: 11 }}>
                      {typeLabel(r.giftType)}
                    </td>
                    <td className="n">{r.maxRepeat || ''}</td>
                    <td className="n">{r.count.toLocaleString()}</td>
                    <td className="n">{r.totalDiamonds.toLocaleString()}</td>
                    <td style={{ fontSize: 11 }}>{ymd(r.lastSeenMs)}</td>
                    <td>
                      {u.map((x) => (
                        <span
                          key={x.key}
                          className="badge"
                          style={{
                            marginRight: 4,
                            // blockedBy 付きは上位に食われて**発火しない**。同じ見た目で
                            // 並べると「登録したのに出ない」の原因が読めないので落とす。
                            // (発火するものが2つ並ぶことはある — 増減規則と全面カットは併発。)
                            opacity: x.blockedBy == null ? 1 : 0.42,
                            textDecoration: x.blockedBy == null ? 'none' : 'line-through',
                          }}
                          title={
                            x.blockedBy == null
                              ? `${hintOf(x.key)}: ${x.detail}`
                              : `${hintOf(x.key)}: ${x.detail} — ${labelOf(x.blockedBy)}が先に一致するため発火しません`
                          }
                        >
                          {labelOf(x.key)}
                        </span>
                      ))}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="faint" style={{ fontSize: 11, marginTop: 10, lineHeight: 1.6 }}>
        <b>「現在の用途」の読み方</b> — いまの設定(この画面の未保存の変更を含む)にそのまま当てた結果です。
        <b>先勝ちの排他</b>は
        <span style={{ whiteSpace: 'nowrap' }}>お助け → ブースト → 革命 → お邪魔 → ルーレット</span>
        の5機能だけで、最初に一致した1つが発火します。<b>増減規則</b>はこの5機能のどれかに食われますが、
        <b>全面カットは増減規則と同時に出ます</b>(値の増減とカットインが両方起きる。
        全面カットが死ぬのはブースト/革命/お邪魔/ルーレットが勝ったときと、
        お助け一致かつ「カットイン抑止」ONのときだけ。帯域カットインは全面カットに食われます)。
        <b>取り消し線の付いたバッジは食われていて発火しません</b>(「登録したのに出ない」の主犯です)。
        <br />
        判定は ① giftId 完全一致 → ② canonical 完全一致 → ③ ギフト名の小文字部分一致(
        <code>exactName</code> 指定時のみ完全一致)。③ が生きていると
        <code>baseball</code> のような短い名前が高額ギフトまで巻き込みます。
        <br />
        <b>type</b> は 1 = 連打(コンボ)あり、2・4 = 単発系。<b>最大連打</b>はこの配信での実測値です。
        <b>💎単価</b>は1個あたり(履歴ログの 💎 は単価×連打の総額)。
      </div>
    </>
  );
}
