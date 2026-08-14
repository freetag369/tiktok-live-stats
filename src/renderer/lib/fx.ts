import universeUrl from '../assets/fx/gift/universe.mp4';
import universePlusUrl from '../assets/fx/gift/universe_plus.mp4';
import whitePegasusUrl from '../assets/fx/gift/white_pegasus.mp4';
import pegasusUrl from '../assets/fx/gift/pegasus.mp4';
import firePhoenixUrl from '../assets/fx/gift/fire_phoenix.mp4';
import thunderFalconUrl from '../assets/fx/gift/thunder_falcon.mp4';
import dragonUrl from '../assets/fx/gift/dragon.mp4';
import lionUrl from '../assets/fx/gift/lion.mp4';
import lionChargeUrl from '../assets/fx/gift/lion_charge.mp4';
import leonLionUrl from '../assets/fx/gift/leon_lion.mp4';
import palaceUrl from '../assets/fx/gift/palace.mp4';
import whaleMirageUrl from '../assets/fx/gift/whale_mirage.mp4';
import whaleSamUrl from '../assets/fx/gift/whale_sam.mp4';
import sealWhaleUrl from '../assets/fx/gift/seal_whale.mp4';
import tiktokStarsUrl from '../assets/fx/gift/tiktok_stars.mp4';
import adamsDreamUrl from '../assets/fx/gift/adams_dream.mp4';
import giftT1Url from '../assets/fx/gift-t1.mp4';
import giftT2Url from '../assets/fx/gift-t2.mp4';
import giftT3Url from '../assets/fx/gift-t3.mp4';
import giftT4Url from '../assets/fx/gift-t4.mp4';
import giftBand1Url from '../assets/fx/band/gift-band1.mp4';
import giftBand2Url from '../assets/fx/band/gift-band2.mp4';
import giftBand3Url from '../assets/fx/band/gift-band3.mp4';
import giftBand4Url from '../assets/fx/band/gift-band4.mp4';
import { FULL_CUT_CLIPS, FULL_CUT_CLIP_IDS } from '@shared/fx-cut';
import achievedUrl from '../assets/fx/achieved.mp4';
import gaugeFullUrl from '../assets/fx/gauge-full.mp4';
import strikeUrl from '../assets/fx/gauge-strike.mp4';

/**
 * モニターに重ねる演出クリップのカタログ(素材の由来は assets/fx/CREDITS.md)。
 * id の一覧は shared/challenge.ts の CHALLENGE_FX_CLIP_IDS と一致させること
 * (validate がそのリストで設定値を検証する)。achieved は割り当て対象では
 * ないので CHALLENGE_FX_CLIP_IDS には入れず、ここだけに置く。
 *
 * 全クリップは「純黒背景に発光体だけ」で作られており、必ず
 * mix-blend-mode: screen で重ねる前提(monitor.css の .fx-clip)。
 * se.ts と同じくステートレス — 有効/割り当ての状態は持たない。
 */

/**
 * ドロップダウンの区切り。素材の性質(合成方法・音の有無)がそのまま group になる。
 * 66 件を1枚のリストで出すと選べないので、設定画面は optgroup で束ねる。
 */
export type FxClipGroup = 'fullcut' | 'band' | 'gift' | 'generic';

export const FX_CLIP_GROUPS: ReadonlyArray<{ key: FxClipGroup; label: string }> = [
  { key: 'fullcut', label: '全面カット(不透明・音声あり)' },
  { key: 'band', label: 'ダイヤ帯域カットイン(不透明・BGMは別ファイル)' },
  { key: 'gift', label: 'ギフト専用(screen 合成)' },
  { key: 'generic', label: '汎用(ダイヤ段階)' },
];

export interface FxClip {
  id: string;
  /** 設定画面のドロップダウンに出す表示名。 */
  label: string;
  url: string;
  /** ドロップダウンの区切り(optgroup)。 */
  group: FxClipGroup;
}

/**
 * 全面カット素材(assets/fx/cut/*.mp4)。42本を1本ずつ静的 import せず eager glob で
 * まとめて解決し、id(= ファイル名)で引く。id・ラベル・既定トリガーの出所は
 * shared/fx-cut.ts —— shared は renderer を import できないので、依存は必ずこの向き。
 *
 * **0件許容**: 素材が未投入でもビルドは落とさず、その id は単に選択肢から消える
 * (stock-full と同じ流儀)。取りこぼしは test/unit/fx-catalog.spec.ts が検出する。
 */
const cutGlob = import.meta.glob('../assets/fx/cut/*.mp4', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

const CUT_ENTRIES: FxClip[] = FULL_CUT_CLIPS.flatMap((c) => {
  const url = cutGlob[`../assets/fx/cut/${c.id}.mp4`];
  return url ? [{ id: c.id, label: c.label, url, group: 'fullcut' as const }] : [];
});

export const FX_CLIPS: readonly FxClip[] = [
  // 全面カット(音声焼き込み)。並びは shared/fx-cut.ts の定義順。
  ...CUT_ENTRIES,
  { id: 'gift-band1', label: 'びっくりした魚(1〜50💎・6秒)', url: giftBand1Url, group: 'band' },
  { id: 'gift-band2', label: 'ハートポーズ(51〜100💎・6秒)', url: giftBand2Url, group: 'band' },
  { id: 'gift-band3', label: 'マネーガン(101〜600💎・8秒)', url: giftBand3Url, group: 'band' },
  { id: 'gift-band4', label: '銀河(601💎〜・10秒)', url: giftBand4Url, group: 'band' },
  { id: 'universe', label: 'ユニバース(銀河)', url: universeUrl, group: 'gift' },
  { id: 'universe_plus', label: 'ユニバース+(二重銀河)', url: universePlusUrl, group: 'gift' },
  { id: 'tiktok_stars', label: 'スターズ(星の渦)', url: tiktokStarsUrl, group: 'gift' },
  { id: 'white_pegasus', label: 'ホワイトペガサス(銀の天馬)', url: whitePegasusUrl, group: 'gift' },
  { id: 'pegasus', label: 'ペガサス(金の天馬)', url: pegasusUrl, group: 'gift' },
  { id: 'fire_phoenix', label: 'ファイアフェニックス(炎の鳳凰)', url: firePhoenixUrl, group: 'gift' },
  { id: 'thunder_falcon', label: 'サンダーファルコン(雷の隼)', url: thunderFalconUrl, group: 'gift' },
  { id: 'dragon', label: 'ドラゴン(翡翠の龍)', url: dragonUrl, group: 'gift' },
  { id: 'lion', label: 'ライオン(金の獅子)', url: lionUrl, group: 'gift' },
  { id: 'lion_charge', label: '獅子奮迅(炎の獅子頭)', url: lionChargeUrl, group: 'gift' },
  { id: 'leon_lion', label: 'レオンとライオン(2頭の衝突)', url: leonLionUrl, group: 'gift' },
  { id: 'palace', label: '宮殿(黄金の建築)', url: palaceUrl, group: 'gift' },
  { id: 'whale_mirage', label: '鯨と蜃気楼', url: whaleMirageUrl, group: 'gift' },
  { id: 'whale_sam', label: 'クジラのサム', url: whaleSamUrl, group: 'gift' },
  { id: 'seal_whale', label: 'アザラシとクジラ', url: sealWhaleUrl, group: 'gift' },
  { id: 'adams_dream', label: "Adam's Dream(光雲)", url: adamsDreamUrl, group: 'gift' },
  { id: 'gift-t1', label: '小(金の輝き)', url: giftT1Url, group: 'generic' },
  { id: 'gift-t2', label: '中(金のバースト)', url: giftT2Url, group: 'generic' },
  { id: 'gift-t3', label: '大(金の放射光)', url: giftT3Url, group: 'generic' },
  { id: 'gift-t4', label: '特大(花火3連発)', url: giftT4Url, group: 'generic' },
];

/**
 * 不透明フルフレームのカットイン素材(assets/fx/band/*.mp4 と assets/fx/cut/*.mp4)。
 * 他の全クリップと違い「純黒背景に発光体」ではないので、screen 合成ではなく
 * .fx-clip-opaque(mix-blend-mode: normal)で最前面へ重ねる — MonitorView の
 * カットイン演出専用。screen を掛けると中間調が UI と混ざって濁るだけ。
 */
export const BAND_CLIP_IDS: readonly string[] = [
  'gift-band1',
  'gift-band2',
  'gift-band3',
  'gift-band4',
  // 全面カットも同じ不透明素材。出所は shared/fx-cut.ts(手で足さない)。
  ...FULL_CUT_CLIP_IDS,
];

/** 不透明カットイン素材かどうか。screen 合成か normal 合成かの分岐に使う。 */
export function isBandClip(id: string | null | undefined): boolean {
  return id != null && BAND_CLIP_IDS.includes(id);
}

/**
 * 全面カット(assets/fx/cut/*.mp4)の id。band/*.mp4 と同じ不透明素材だが、
 * **音声が焼き込んである**点だけが違う(band は無音で別ファイルの BGM を重ねる)。
 * 設定画面の試写がミュートを外すかどうかの分岐に使う — モニター側は effect の
 * fxFullCut を見るのでこのリストは参照しない(cfg を引き直させない流儀)。
 */
export { FULL_CUT_CLIP_IDS };

/** 全面カット(音声焼き込み)素材かどうか。 */
export function isFullCutClip(id: string | null | undefined): boolean {
  return id != null && FULL_CUT_CLIP_IDS.includes(id);
}

/** 達成(CLEAR)専用。ギフトには割り当てない固定クリップ。 */
export const ACHIEVED_CLIP_URL = achievedUrl;

/**
 * いいねゲージ満タンの瞬間(全画面)。ギフトと同じ単一クリップ枠を使う。
 * ACHIEVED_CLIP_URL と同じ固定クリップ扱いで、CHALLENGE_FX_CLIP_IDS には入れない
 * (ユーザーがギフトへ割り当てる対象ではないため)。
 */
export const GAUGE_FULL_CLIP_URL = gaugeFullUrl;

/** ゲージ満タンの弾が7セグに当たる瞬間。全画面ではなく数字の実位置に重ねる。 */
export const STRIKE_CLIP_URL = strikeUrl;

/**
 * いいねストック満杯の瞬間(全画面・緑の衝撃波)。GAUGE_FULL_CLIP_URL と同じ
 * 固定クリップ扱い。素材(Higgsfield 生成)を差し替え/削除してもビルドが
 * 落ちないよう、静的 import ではなく 0 件許容の glob で拾い、無ければ
 * gauge-full を代用する。
 */
const stockGlob = import.meta.glob('../assets/fx/stock-full.mp4', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
export const STOCK_FULL_CLIP_URL: string = stockGlob['../assets/fx/stock-full.mp4'] ?? gaugeFullUrl;

/**
 * いいねストック満杯の着弾後に流す5秒のフルスクリーンカットイン(不透明・音声焼き込み)。
 * band/*.mp4 と同族の不透明素材なので screen 合成は禁止(.fx-clip-opaque で重ねる)。
 * 無ければ null — モニターは従来のストック着弾(カットインなし)へフォールバックする。
 * gauge-full での代用はしない: screen 前提の黒背景素材を不透明で出すと黒画面5秒になる。
 */
const stockCutinGlob = import.meta.glob('../assets/fx/stock-cutin.mp4', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;
export const STOCK_CUTIN_CLIP_URL: string | null =
  stockCutinGlob['../assets/fx/stock-cutin.mp4'] ?? null;

/**
 * タップブースト(フィーバー)の専用素材(不透明・音声焼き込み)。段ごとに
 * 選択制で、id の一覧とラベルは shared/challenge.ts の TAP_BOOST_*_CLIPS が
 * 唯一の出所(実ファイルは assets/fx/boost/<id>.mp4)。intro-* は
 * TAP_BOOST_INTRO_MS、count-* は TAP_BOOST_COUNT_MS の実尺で揃える —
 * カウントダウンは映像焼き込みなので、ズレるとタップ開始と「1」が合わない。
 * 無ければ null — モニターは暗幕+タップカウンタのみで縮退する
 * (STOCK_CUTIN_CLIP_URL と同じ 0 件許容の流儀。CHALLENGE_FX_CLIP_IDS には
 * 入れない: ユーザーがギフトへ割り当てる対象ではないため)。
 */
const boostGlob = import.meta.glob('../assets/fx/boost/*.mp4', {
  eager: true,
  query: '?url',
  import: 'default',
}) as Record<string, string>;

/** ブーストクリップ id → URL。'off'・未知 id・素材未投入は null。 */
export function boostClipUrl(id: string | null | undefined): string | null {
  if (!id || id === 'off') return null;
  return boostGlob[`../assets/fx/boost/${id}.mp4`] ?? null;
}

const BY_ID = new Map(FX_CLIPS.map((c) => [c.id, c]));

/** クリップ id → URL。未知の id は null(設定が古い/壊れていても落とさない)。 */
export function fxClipUrl(id: string | null | undefined): string | null {
  if (!id) return null;
  return BY_ID.get(id)?.url ?? null;
}

/** 設定画面のプレビュー用。表示名を引く。 */
export function fxClipLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}
