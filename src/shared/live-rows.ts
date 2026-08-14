import type { UserId } from '@shared/events';

/**
 * live 集計行(liveStore の rows)の剪定。
 *
 * この Map は「配信中に動きのあった視聴者」を貯め続けるだけで上限が無く、破棄は
 * 配信開始の瞬間(resetLive)しか無かった。耐久配信ではユニーク視聴者数に比例して
 * 単調増加し、しかも更新のたびに `{ ...r }` で作り直すのでGCの餌にもなる。
 *
 * 消してよい根拠: この行の唯一の役割は「8秒ごとのDBクエリの隙間を埋める」こと
 * (ViewerTable と フィードの Record 表示)。しばらく動きの無い人はDB側の値で
 * 十分で、実際に消費側は liveRow() が undefined を返せばDB値にフォールバックする。
 *
 * worker 側の pruneLikeSeen と同じ流儀(TTL + 呼び出しついでの償却実行)に揃えてある。
 * **shared に置いてあるのは意図的** — レンダラーのテスト環境(jsdom)がこの
 * リポジトリに無く、tsconfig.node.json も src/renderer を含まないので、
 * src/renderer 配下に置くと test/ から import できない(appendChallengeLog が
 * shared/challenge.ts にあるのと同じ理由)。
 *
 * @returns 削除した件数
 */
export function pruneLiveRows<T extends { lastSeenMs: number }>(
  rows: Map<UserId, T>,
  nowMs: number,
  ttlMs: number,
  hardCap: number
): number {
  let removed = 0;
  const cutoff = nowMs - ttlMs;
  for (const [id, r] of rows) {
    if (r.lastSeenMs < cutoff) {
      rows.delete(id);
      removed += 1;
    }
  }
  if (rows.size <= hardCap) return removed;

  // TTL だけでは足りない場合(短時間に大量のユニークが来たレイド等)の保険。
  // lastSeenMs の古い順に、上限ちょうどまで落とす。
  const byAge = [...rows.entries()].sort((a, b) => a[1].lastSeenMs - b[1].lastSeenMs);
  const excess = rows.size - hardCap;
  for (let i = 0; i < excess; i += 1) {
    rows.delete(byAge[i]![0]);
    removed += 1;
  }
  return removed;
}
