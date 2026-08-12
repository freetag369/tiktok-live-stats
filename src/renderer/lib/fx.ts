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

export interface FxClip {
  id: string;
  /** 設定画面のドロップダウンに出す表示名。 */
  label: string;
  url: string;
}

export const FX_CLIPS: readonly FxClip[] = [
  { id: 'universe', label: 'ユニバース(銀河)', url: universeUrl },
  { id: 'universe_plus', label: 'ユニバース+(二重銀河)', url: universePlusUrl },
  { id: 'tiktok_stars', label: 'スターズ(星の渦)', url: tiktokStarsUrl },
  { id: 'white_pegasus', label: 'ホワイトペガサス(銀の天馬)', url: whitePegasusUrl },
  { id: 'pegasus', label: 'ペガサス(金の天馬)', url: pegasusUrl },
  { id: 'fire_phoenix', label: 'ファイアフェニックス(炎の鳳凰)', url: firePhoenixUrl },
  { id: 'thunder_falcon', label: 'サンダーファルコン(雷の隼)', url: thunderFalconUrl },
  { id: 'dragon', label: 'ドラゴン(翡翠の龍)', url: dragonUrl },
  { id: 'lion', label: 'ライオン(金の獅子)', url: lionUrl },
  { id: 'lion_charge', label: '獅子奮迅(炎の獅子頭)', url: lionChargeUrl },
  { id: 'leon_lion', label: 'レオンとライオン(2頭の衝突)', url: leonLionUrl },
  { id: 'palace', label: '宮殿(黄金の建築)', url: palaceUrl },
  { id: 'whale_mirage', label: '鯨と蜃気楼', url: whaleMirageUrl },
  { id: 'whale_sam', label: 'クジラのサム', url: whaleSamUrl },
  { id: 'seal_whale', label: 'アザラシとクジラ', url: sealWhaleUrl },
  { id: 'adams_dream', label: "Adam's Dream(光雲)", url: adamsDreamUrl },
  { id: 'gift-t1', label: '汎用: 小(金の輝き)', url: giftT1Url },
  { id: 'gift-t2', label: '汎用: 中(金のバースト)', url: giftT2Url },
  { id: 'gift-t3', label: '汎用: 大(金の放射光)', url: giftT3Url },
  { id: 'gift-t4', label: '汎用: 特大(花火3連発)', url: giftT4Url },
  { id: 'gift-band1', label: 'カットイン: びっくりした魚(1〜50💎・6秒)', url: giftBand1Url },
  { id: 'gift-band2', label: 'カットイン: ハートポーズ(51〜100💎・6秒)', url: giftBand2Url },
  { id: 'gift-band3', label: 'カットイン: マネーガン(101〜600💎・8秒)', url: giftBand3Url },
  { id: 'gift-band4', label: 'カットイン: 銀河(601💎〜・10秒)', url: giftBand4Url },
];

/**
 * 不透明フルフレームのカットイン素材(assets/fx/band/*.mp4)。他の全クリップと
 * 違い「純黒背景に発光体」ではないので、screen 合成ではなく .fx-clip-opaque
 * (mix-blend-mode: normal)で最前面へ重ねる — MonitorView のバンド演出専用。
 */
export const BAND_CLIP_IDS: readonly string[] = ['gift-band1', 'gift-band2', 'gift-band3', 'gift-band4'];

/** バンド(不透明カットイン)素材かどうか。screen 合成か normal 合成かの分岐に使う。 */
export function isBandClip(id: string | null | undefined): boolean {
  return id != null && BAND_CLIP_IDS.includes(id);
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
