import type { DatabaseSync } from 'node:sqlite';
import type { GiftCatalogRow } from '@shared/dto';

/**
 * 受信済み全ギフトの一覧(giftId ↔ ギフト名の対応表)。
 *
 * gift_catalog は**受信のたびに自動で育つ実測テーブル**で、giftId→💎 の表を
 * ハードコードしないための土台(001_init.sql のコメント参照)。ここはそれに
 * gift_event の実測(受信回数・最大連打・累計💎)と gift_alias の canonical を
 * 貼り合わせて、設定画面の「ギフトリスト」タブが1回で引ける形にする。
 *
 * **ページングしない**のは、この表が「全部を一望して目的の giftId を探す」ための
 * ものだから — 絞り込みと並べ替えは受け取った側(レンダラ)でやる。総数は
 * 「その配信者がこれまでに受け取った種類数」なので数百のオーダーで頭打ちになる。
 *
 * コスト: gift_event 全走査の GROUP BY 1回。gift_id の索引は無い(索引は
 * gift_user / gift_session)ので行数に比例する — 実測 11,563 行で 4〜7ms。
 * worker は単一スレッドで、走っている間は `challenge.press` が**配送すらされない**
 * (rpc-server.ts の RPC_SLOW_MS のコメント)。そのため呼び出し側はタブを開いた
 * ときと「更新」を押したときだけ叩き、delta のたびに引き直してはいけない。
 * 数百万行まで育って 250ms 警告が出るようになったら、gift_event(gift_id) の
 * 被覆索引を足すのが素直な次の一手。
 */
export function listGiftCatalog(db: DatabaseSync): GiftCatalogRow[] {
  const rows = db
    .prepare(
      `SELECT gc.gift_id       AS giftId,
              gc.name          AS name,
              gc.diamond_count AS diamonds,
              gc.gift_type     AS giftType,
              gc.icon_url      AS iconUrl,
              ga.canonical     AS canonical,
              COALESCE(e.cnt, 0)     AS cnt,
              COALESCE(e.max_rep, 0) AS maxRep,
              COALESCE(e.dia_sum, 0) AS diaSum,
              gc.first_seen_ms AS firstSeenMs,
              gc.last_seen_ms  AS lastSeenMs
         FROM gift_catalog gc
         LEFT JOIN gift_alias ga ON ga.gift_id = gc.gift_id
         LEFT JOIN (SELECT gift_id,
                           COUNT(*)           AS cnt,
                           MAX(repeat_count)  AS max_rep,
                           SUM(diamonds)      AS dia_sum
                      FROM gift_event
                     GROUP BY gift_id) e ON e.gift_id = gc.gift_id
        -- **エイリアスの種蒔き行を外す。** Store.open は idAliases の id を
        -- gift_catalog へ先に流し込む(FK の都合。index.ts の「Seed the alias hints」)。
        -- あれは名前も単価も型も無い**未検証の当て推量**で、受け取った実績ではない。
        -- 一覧に出すと存在しない giftId を設定へ書かせることになるので、名前・単価・
        -- 受信のどれか1つでも実測がある行だけを残す。
        WHERE (gc.name IS NOT NULL AND gc.name <> '')
           OR gc.diamond_count IS NOT NULL
           OR COALESCE(e.cnt, 0) > 0
        -- giftId は数値だが TEXT 列。CAST しないと '10715' が '5655' より前に来る。
        ORDER BY CAST(gc.gift_id AS INTEGER), gc.gift_id`
    )
    .all() as unknown as Array<{
    giftId: string;
    name: string | null;
    diamonds: number | null;
    giftType: number | null;
    iconUrl: string | null;
    canonical: string | null;
    cnt: number;
    maxRep: number;
    diaSum: number;
    firstSeenMs: number | null;
    lastSeenMs: number | null;
  }>;

  return rows.map((r) => ({
    giftId: String(r.giftId),
    // 名前は**受信原文ママ**(前後スペースを含む行がある)。trim すると
    // exactName 一致の検証に使えなくなるので、ここでは整形しない。
    name: r.name ?? '',
    diamonds: Number(r.diamonds ?? 0),
    giftType: r.giftType == null ? null : Number(r.giftType),
    iconUrl: r.iconUrl ?? null,
    canonical: r.canonical ?? null,
    count: Number(r.cnt),
    maxRepeat: Number(r.maxRep),
    totalDiamonds: Number(r.diaSum),
    firstSeenMs: r.firstSeenMs == null ? null : Number(r.firstSeenMs),
    lastSeenMs: r.lastSeenMs == null ? null : Number(r.lastSeenMs),
  }));
}
