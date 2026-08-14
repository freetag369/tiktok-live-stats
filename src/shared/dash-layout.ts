/**
 * ライブダッシュボードの3カラムの並び。
 *
 * 配信中いちばん目で追う場所は人によって違う — コメントを左に置きたい人、
 * サマリーを左端に固定したい人。並びはユーザーが決め、settings.json に残す。
 *
 * 幅は「位置」ではなく「パネル」に紐づく: 入室&サマリーはどこへ移動しても
 * 310px、視聴者はどこでも広い。中身の設計に合った幅が並び替えで壊れない。
 */
export type DashPaneKey = 'comments' | 'viewers' | 'summary';

export const DEFAULT_DASH_LAYOUT: readonly DashPaneKey[] = ['comments', 'viewers', 'summary'];

/** パネル固有の grid トラック幅。既定順で並べると従来の .dash と1pxも変わらない。 */
export const DASH_TRACK: Record<DashPaneKey, string> = {
  comments: 'minmax(320px, 1fr)',
  viewers: 'minmax(500px, 1.7fr)',
  summary: '310px',
};

function isPaneKey(v: unknown): v is DashPaneKey {
  return v === 'comments' || v === 'viewers' || v === 'summary';
}

/**
 * 手編集・旧バージョン・重複・欠落を吸収して必ず3要素の正しい並びを返す。
 * 壊れた settings.json でダッシュボードが空になる方が、既定順に戻るより遥かに悪い。
 */
export function normalizeDashLayout(raw: unknown): DashPaneKey[] {
  const out: DashPaneKey[] = [];
  if (Array.isArray(raw)) {
    for (const v of raw) if (isPaneKey(v) && !out.includes(v)) out.push(v);
  }
  // 欠けたパネルは既定順のまま末尾へ — 消えるくらいなら位置がずれた方がいい。
  for (const k of DEFAULT_DASH_LAYOUT) if (!out.includes(k)) out.push(k);
  return out;
}

/**
 * from を to の位置へ挿入した新しい並びを返す。
 * 動かない操作(自分自身へのドロップ)では元の配列をそのまま返すので、
 * 呼び出し側は参照比較だけで「保存が要るか」を判定できる。
 */
export function moveDashPane(order: DashPaneKey[], from: DashPaneKey, to: DashPaneKey): DashPaneKey[] {
  const src = order.indexOf(from);
  const dst = order.indexOf(to);
  if (src < 0 || dst < 0 || src === dst) return order;
  const next = order.slice();
  next.splice(src, 1);
  next.splice(dst, 0, from);
  return next;
}

/** grid-template-columns 用のトラック文字列。 */
export function dashTemplate(order: readonly DashPaneKey[]): string {
  return order.map((k) => DASH_TRACK[k]).join(' ');
}
