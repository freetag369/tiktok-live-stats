/**
 * FIFO 上限つき Set。worker の「一度見た ID は二度と数えない」系の集合が
 * 耐久配信でユニーク視聴者数に比例して育つのを止める(worker は単一スレッド +
 * 同期 sqlite なので、ヒープ成長 = GC 停止 = press RPC / 2Hz delta の遅延)。
 *
 * 溢れたら**最古の**要素を追い出す。想定する副作用は「超長時間配信で最初期の
 * 視聴者が cap 人を超えた後に戻ってくると、もう一度 "初回" 扱いになる」だけ —
 * 適用先(入室アラートの抑制・フォロー妨害の1回制限)ではどちらも実害がない。
 *
 * worker/challenge.ts の msgId 重複排除(Set + order 配列)と同じイディオムの
 * クラス化。shared に置くのは live-rows.ts と同じ理由(テストは node 環境のみで
 * renderer/worker 固有コードを import できないため、純粋ロジックはここに集める)。
 */
export class BoundedSet<T> {
  private set = new Set<T>();
  private order: T[] = [];
  /** order の先頭ポインタ。Array#shift の O(n) を避け、まとめて詰め直す。 */
  private head = 0;

  constructor(private readonly cap: number) {
    if (cap <= 0) throw new Error(`BoundedSet: cap must be positive (got ${cap})`);
  }

  has(v: T): boolean {
    return this.set.has(v);
  }

  /** @returns 新規追加なら true(既存なら false のまま何もしない)。 */
  add(v: T): boolean {
    if (this.set.has(v)) return false;
    this.set.add(v);
    this.order.push(v);
    if (this.set.size > this.cap) {
      const oldest = this.order[this.head]!;
      this.head += 1;
      this.set.delete(oldest);
      // 先頭の死んだ領域が半分を超えたら詰め直す(償却 O(1))。
      if (this.head >= 1024 && this.head * 2 >= this.order.length) {
        this.order = this.order.slice(this.head);
        this.head = 0;
      }
    }
    return true;
  }

  clear(): void {
    this.set.clear();
    this.order = [];
    this.head = 0;
  }

  get size(): number {
    return this.set.size;
  }
}
