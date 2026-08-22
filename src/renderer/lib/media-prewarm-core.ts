/**
 * メディア予熱(media-prewarm.ts)の純関数部。素材 URL の import を持たない —
 * vitest(node)から asset パイプラインなしでテストするための分離。
 */

export interface PrewarmTarget {
  /** diag.log で識別するラベル。 */
  label: string;
  url: string;
}

/**
 * 予熱対象の正規化: 未投入(null)を除き、URL で重複排除し、app-sound:// を
 * 除外する。重複排除が要るのは素材のフォールバック連鎖のため —
 * STOCK_FULL は未投入だと gauge-full と同じ URL、REVOLUTION_INTRO は
 * rl/hot/dragon → gift-band1 へ落ちる(renderer/lib/fx.ts)。
 * app-sound:// は main の protocol.handle が Range ストリームで配る特別経路で、
 * 予熱で触ると回転ループ音の実再生と読み合いになる(過去に Range 罠を踏んだ
 * 経路 — 対象外と明記)。
 */
export function normalizePrewarmTargets(
  raw: ReadonlyArray<{ label: string; url: string | null }>
): PrewarmTarget[] {
  const seen = new Set<string>();
  const out: PrewarmTarget[] = [];
  for (const t of raw) {
    if (t.url == null) continue;
    if (t.url.startsWith('app-sound:')) continue;
    if (seen.has(t.url)) continue;
    seen.add(t.url);
    out.push({ label: t.label, url: t.url });
  }
  return out;
}

/**
 * 設定の効果音割り当て(seSounds の値)から予熱すべき id 列を作る。
 * 'off' を除いて重複排除 — 37音全部ではなく**実際に鳴る音だけ**を温める。
 */
export function dedupeSeIds(ids: readonly string[]): string[] {
  return [...new Set(ids)].filter((id) => id !== 'off');
}
