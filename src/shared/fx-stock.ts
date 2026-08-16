/**
 * 演出ストック表示(モニター右下オーバーレイの縦リスト)の組み立てロジック。
 *
 * モニターは演出を直列再生するため、別演出中に届いた演出はレンダラーの
 * ref キュー(rouletteQueue / pendingBands / pendingBoosts / pendingAchieved)で
 * 待つ — この待ち行列を「誰の何が待っているか」の縦リストへ写す純関数。
 *
 * **再生中の演出は先頭行として残す**(ユーザー指定)。キュー時と同じ key
 * (`roulette:${id}` / `band:${id}`)を使うので、FLIP はキュー行→再生中行の遷移を
 * 「同じ行が先頭へ滑る」として見せ、連続ルーレット/連続ギフトの残数(×N)は
 * スピン/ショットを消費するたび同じ行の上で減っていく。
 *
 * 並び順: playing → clear → 以降は **fx-priority.ts の序列**(STOCK_KIND_PRIORITY
 * 経由で導出)→ workerQueue。順序リテラルをここに直書きしない — ドレインの
 * 消化順(fx-drain.ts も同じ表から導出)と表示順が構造的に一致する。
 * workerQueue(ChallengeState.fxQueue — カットイン/ブースト再生中に届き、凍結明けまで
 * recentEffects に載らないイベントの予告)は後段。凍結明けに effect 化されて
 * レンダラーのキューへ移ると key が wq: から effect.id ベースへ変わる(行は入れ替わる)。
 * 保留着弾(pendingStrike — いいね満杯/ストック満杯)は**表示しない**(ユーザー指定)。
 *
 * shared に置くのは fx-drain.ts / fx-stage.ts と同じ理由 — 決定ロジックを
 * 純関数として抽出し node のテストで固定する。
 */

import type { ChallengeFxQueueItem } from './dto';
import { fxRank, type FxPriorityClass } from './fx-priority';

/** メイン行の表示上限(再生中の行を含む)。溢れは "+N" 行1つに畳む。 */
export const FX_STOCK_DISPLAY_MAX = 5;

export type FxStockKind =
  | 'clear' // CLEAR 演出の持ち越し(pendingAchieved)— 序列外(並走再生)なので常に先頭側
  | 'boost' // フィーバー(pendingBoosts)
  | 'band' // ギフトカットイン(pendingBands — 帯/フルカットとも。表示ラベルは「ギフト」)
  | 'join-roulette' // 初見(入室)ルーレット(joinRouletteQueue)
  | 'roulette'; // ギフトルーレット(rouletteQueue)

/**
 * 登録簿4(fx-priority.ts の規約): ストック表示種別 → 優先クラス。
 * FxStockKind に新種別を足すと satisfies が型エラーになる = ここへの登録と
 * ユーザーへの順位確認が強制される。clear は序列外なので載せない。
 */
export const STOCK_KIND_PRIORITY = {
  boost: 'boost',
  band: 'band',
  'join-roulette': 'join-roulette',
  roulette: 'other',
} as const satisfies Record<Exclude<FxStockKind, 'clear'>, FxPriorityClass>;

/** キューセクションの表示順(fx-priority の序列から導出)。 */
export const STOCK_SECTION_ORDER: readonly Exclude<FxStockKind, 'clear'>[] = (
  Object.keys(STOCK_KIND_PRIORITY) as Exclude<FxStockKind, 'clear'>[]
).sort((a, b) => fxRank(STOCK_KIND_PRIORITY[a]) - fxRank(STOCK_KIND_PRIORITY[b]));

/** キュー1件ぶんの識別スナップショット(effect.id + 行為者)。 */
export interface FxStockQueuedRef {
  id: number;
  nickname?: string;
}

export interface FxStockRouletteRef extends FxStockQueuedRef {
  /** スピン本数(rouletteReelPlan(e).reels.length)。 */
  spins: number;
}

export interface FxStockBandRef extends FxStockQueuedRef {
  /** カットインの反復回数(giftFxShots(e).rep)。 */
  rep: number;
}

/** 再生中の演出(先頭行)。remaining はいま回している1本を含む残数。 */
export interface FxStockPlaying {
  kind: 'roulette' | 'join-roulette' | 'band';
  id: number;
  nickname?: string;
  remaining: number;
}

export interface FxStockItem {
  /**
   * React key 兼 消費スライドアニメ(FLIP)の同一性。effect.id ベースなので
   * 先頭消費を跨いでも残った行の key は不変 = 下の行が上へ滑る。再生中の行も
   * キュー時と同じ key を使う(キュー→再生の遷移が同じ行の移動として見える)。
   * 例外: ルーレットの満杯マージ(mergeRoulette は新しい方の id を採用)で
   * 末尾行の key が変わり再マウント → 入場アニメが再生される(意図的に許容)。
   */
  key: string;
  kind: FxStockKind;
  /** 行為者。clear は個人データを持たないので '' = ラベルのみ行。 */
  name: string;
  /** 総回数(連続ルーレットのスピン数/連続ギフトの反復数)。表示は 2 以上で「×N」。 */
  count: number;
  /** 再生中の先頭行(スタイル強調用)。 */
  playing: boolean;
}

export interface FxStockView {
  /** 表示するメイン行(≤ FX_STOCK_DISPLAY_MAX、再生中の行を含む)。 */
  items: FxStockItem[];
  /** 表示しきれなかったメイン行数(+N)。0 = 溢れなし。 */
  overflow: number;
}

export interface FxStockSnapshot {
  /** 再生中の演出(null = 何も再生していない)。 */
  playing: FxStockPlaying | null;
  achievedPending: boolean;
  /** pendingBoosts(積む側上限 PENDING_BOOSTS_MAX)。 */
  boosts: FxStockQueuedRef[];
  /** pendingBands(積む側上限 PENDING_BANDS_MAX)。 */
  bands: FxStockBandRef[];
  /** joinRouletteQueue(積む側上限 JOIN_ROULETTE_QUEUE_MAX)。 */
  joinRoulettes: FxStockRouletteRef[];
  /** rouletteQueue(積む側上限 ROULETTE_QUEUE_MAX)。 */
  roulettes: FxStockRouletteRef[];
  /** ワーカー凍結キューの予告(ChallengeState.fxQueue、到着順)。 */
  workerQueue: ChallengeFxQueueItem[];
}

export const EMPTY_FX_STOCK: FxStockView = { items: [], overflow: 0 };

export function buildFxStock(s: FxStockSnapshot): FxStockView {
  const all: FxStockItem[] = [];
  if (s.playing !== null) {
    all.push({
      key: `${s.playing.kind}:${s.playing.id}`,
      kind: s.playing.kind,
      name: s.playing.nickname ?? '',
      count: Math.max(1, s.playing.remaining),
      playing: true,
    });
  }
  if (s.achievedPending) all.push({ key: 'clear', kind: 'clear', name: '', count: 1, playing: false });
  // キューセクションは fx-priority の序列順(STOCK_SECTION_ORDER)で並べる —
  // 実際のドレイン消化順と表示順が常に一致する。
  for (const kind of STOCK_SECTION_ORDER) {
    if (kind === 'boost') {
      for (const b of s.boosts) {
        all.push({ key: `boost:${b.id}`, kind, name: b.nickname ?? '', count: 1, playing: false });
      }
    } else if (kind === 'band') {
      for (const b of s.bands) {
        all.push({
          key: `band:${b.id}`,
          kind,
          name: b.nickname ?? '',
          count: Math.max(1, b.rep),
          playing: false,
        });
      }
    } else {
      const refs = kind === 'join-roulette' ? s.joinRoulettes : s.roulettes;
      for (const r of refs) {
        all.push({
          key: `${kind}:${r.id}`,
          kind,
          name: r.nickname ?? '',
          count: Math.max(1, r.spins),
          playing: false,
        });
      }
    }
  }
  for (const w of s.workerQueue) {
    all.push({
      key: `wq:${w.id}`,
      kind: w.kind,
      name: w.nickname ?? '',
      count: Math.max(1, w.count ?? 1),
      playing: false,
    });
  }
  if (all.length === 0) return EMPTY_FX_STOCK;
  const items = all.slice(0, FX_STOCK_DISPLAY_MAX);
  return { items, overflow: all.length - items.length };
}

/**
 * setState の等値ガード用の合成キー。ref キューの変異は再レンダーを起こさない
 * ので、チョークポイントで組み直したビューをこのキーで比べ、変化したときだけ
 * state へ写す。count(×N の減算)と playing も含める — スピン消費のたびに
 * 必ず再レンダーさせるため。
 * 空ビューは ''(useRef('') の初期値と一致し、初回の空→空で setState しない)。
 * 区切り文字(~ / |)がニックネームに含まれても等値ガード用途では無害。
 */
export function fxStockKey(v: FxStockView): string {
  const parts = v.items.map((it) => `${it.key}~${it.name}~${it.count}~${it.playing ? 1 : 0}`);
  if (v.overflow > 0) parts.push(`+${v.overflow}`);
  return parts.join('|');
}
