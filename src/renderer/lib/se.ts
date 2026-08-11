import clickSoftUrl from '../assets/se/click-soft.ogg';
import tickUrl from '../assets/se/tick.ogg';
import popUrl from '../assets/se/pop.ogg';
import pluckUrl from '../assets/se/pluck.ogg';
import bongUrl from '../assets/se/bong.ogg';
import questionUrl from '../assets/se/question.ogg';
import alertUrl from '../assets/se/alert.ogg';
import confirm1Url from '../assets/se/confirm-1.ogg';
import confirm2Url from '../assets/se/confirm-2.ogg';
import confirm3Url from '../assets/se/confirm-3.ogg';
import jingleHitUrl from '../assets/se/jingle-hit.ogg';
import jingleSteelUrl from '../assets/se/jingle-steel.ogg';
import jinglePizziUrl from '../assets/se/jingle-pizzi.ogg';
import jingleSaxUrl from '../assets/se/jingle-sax.ogg';
import fanfare8bitUrl from '../assets/se/fanfare-8bit.ogg';
import fanfare8bitShortUrl from '../assets/se/fanfare-8bit-short.ogg';

/**
 * チャレンジ演出の効果音カタログ(素材の由来は assets/se/CREDITS.md、すべて CC0)。
 * id の一覧は shared/challenge.ts の CHALLENGE_SE_SOUND_IDS と一致させること
 * (validate がそのリストで設定値を検証する)。
 *
 * ステートレス — 有効/音量の状態は持たず呼び出し側が毎回渡す。メイン窓と
 * モニター窓は別々の JS コンテキストなので、モジュールに状態を持たせても
 * 共有されず齟齬の元になるだけ。
 */

export interface SeSound {
  id: string;
  /** 設定画面のドロップダウンに出す表示名。 */
  label: string;
  url: string;
  /** 素材ごとのラウドネス差を吸収する相対ゲイン。連発される音は控えめに。 */
  gain: number;
}

export const SE_SOUNDS: readonly SeSound[] = [
  { id: 'click-soft', label: 'クリック', url: clickSoftUrl, gain: 0.5 },
  { id: 'tick', label: 'チッ(小)', url: tickUrl, gain: 0.5 },
  { id: 'pop', label: 'ポップ', url: popUrl, gain: 0.6 },
  { id: 'pluck', label: 'はじく音', url: pluckUrl, gain: 0.6 },
  { id: 'bong', label: 'ボン(低め)', url: bongUrl, gain: 0.7 },
  { id: 'question', label: '問いかけ', url: questionUrl, gain: 0.9 },
  { id: 'alert', label: '警告', url: alertUrl, gain: 0.9 },
  { id: 'confirm-1', label: '決定(小)', url: confirm1Url, gain: 0.8 },
  { id: 'confirm-2', label: '決定(中)', url: confirm2Url, gain: 0.9 },
  { id: 'confirm-3', label: '決定(大)', url: confirm3Url, gain: 0.9 },
  { id: 'jingle-hit', label: 'ジングル(ヒット)', url: jingleHitUrl, gain: 1 },
  { id: 'jingle-steel', label: 'ジングル(スチールドラム)', url: jingleSteelUrl, gain: 1 },
  { id: 'jingle-pizzi', label: 'ジングル(ピチカート)', url: jinglePizziUrl, gain: 1 },
  { id: 'jingle-sax', label: 'ジングル(サックス)', url: jingleSaxUrl, gain: 1 },
  { id: 'fanfare-8bit', label: 'ファンファーレ(8bit)', url: fanfare8bitUrl, gain: 1 },
  { id: 'fanfare-8bit-short', label: 'ファンファーレ(8bit・短)', url: fanfare8bitShortUrl, gain: 1 },
];

const BY_ID = new Map(SE_SOUNDS.map((s) => [s.id, s]));

/** 事前ロード済みのベース要素(遅延生成)。再生時は clone するので同時再生できる。 */
const base = new Map<string, HTMLAudioElement>();

function baseFor(s: SeSound): HTMLAudioElement {
  let a = base.get(s.id);
  if (!a) {
    a = new Audio(s.url);
    a.preload = 'auto';
    base.set(s.id, a);
  }
  return a;
}

/**
 * id の音を鳴らす。volume は 0-100(ChallengeConfig.seVolume をそのまま渡す)。
 * 'off' や未知の id は無音(validate 済み設定なら既定に矯正されているが、
 * 30秒ポーリング前の古い設定が来ても落ちないように)。
 */
export function playSe(id: string, volume: number): void {
  const s = BY_ID.get(id);
  if (!s) return;
  const v = Math.min(1, Math.max(0, volume / 100)) * s.gain;
  if (v <= 0) return;
  // clone は同一URLがキャッシュに載っているため実質コストゼロで、直前の音を切らない。
  const a = baseFor(s).cloneNode(true) as HTMLAudioElement;
  a.volume = Math.min(1, v);
  // デコード失敗や autoplay ポリシー変更で reject し得る — 演出は視覚が主なので握りつぶす。
  void a.play().catch(() => {});
}
