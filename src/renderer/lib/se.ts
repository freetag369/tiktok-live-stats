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
import likeJamUrl from '../assets/se/like-jam.mp3';
import followJamUrl from '../assets/se/follow-jam.mp3';
import reelStopUrl from '../assets/se/reel-stop.ogg';
import reelConfirmUrl from '../assets/se/reel-confirm.ogg';
import gaugeBurstUrl from '../assets/se/gauge-burst.mp3';
import stockBurstUrl from '../assets/se/stock-burst.mp3';
import helperStampUrl from '../assets/se/helper-stamp.mp3';
import commentJamUrl from '../assets/se/comment-jam.mp3';
import boostTapUrl from '../assets/se/boost-tap.mp3';
import boostFinalUrl from '../assets/se/boost-final.mp3';
import boostHitUrl from '../assets/se/boost-hit.mp3';
import reelKickUrl from '../assets/se/reel-kick.mp3';
import reelHitUrl from '../assets/se/reel-hit.mp3';
import clearFanfareUrl from '../assets/se/clear-fanfare.mp3';
import hypeKakugoUrl from '../assets/se/hype-kakugo.mp3';
import hypeIyashiUrl from '../assets/se/hype-iyashi.mp3';
import hypeYoroshikuUrl from '../assets/se/hype-yoroshiku.mp3';
import hypeKiitenaiyoUrl from '../assets/se/hype-kiitenaiyo.mp3';
import backKuhUrl from '../assets/se/back-kuh.mp3';
import backUhUrl from '../assets/se/back-uh.mp3';
import backIteUrl from '../assets/se/back-ite.mp3';

/**
 * チャレンジ演出の効果音カタログ(素材の由来は assets/se/CREDITS.md)。Kenney の CC0 と
 * 妨害演出用の作者自作 mp3 が混在する — 追加時は CREDITS.md の該当セクションに書くこと。
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
  // 妨害演出の専用音。ピークが -0.4dB と熱いので gain で既存素材の体感に寄せる
  // (mean は like-jam -22.4dB / follow-jam -12.6dB。pop -19.8dB=0.6 / question -10.0dB=0.9 が比較対象)。
  { id: 'like-jam', label: 'いいね妨害(専用)', url: likeJamUrl, gain: 0.9 },
  { id: 'follow-jam', label: 'フォロー妨害(専用)', url: followJamUrl, gain: 0.85 },
  // ルーレットの停止まわりの専用音(元は作者提供の mp3 — 前後の無音を落として ogg 化)。
  // reel-stop は素材のピークが低かったので取り込み時に +10.9dB してある(bong と同じ
  // ピーク -1.5dB 前後)。gain は like-jam と同じ考え方でピークの熱さぶんを引く。
  { id: 'reel-stop', label: 'リール停止(スイッチ)', url: reelStopUrl, gain: 0.9 },
  { id: 'reel-confirm', label: 'ルーレット確定(確認音)', url: reelConfirmUrl, gain: 0.85 },
  // 演出ごとの専用録り(作者提供)。取り込み時に末尾の無音を落としてピークを -1.5dB へ
  // 揃えてある(素材のままでは既存音より 6〜8dB 小さく、gain は ≤1 なので後から
  // 取り戻せない — reel-stop を +10.9dB したのと同じ理由)。揃えた結果の位置づけは
  // reel-stop / like-jam と同じなので gain も同じ 0.9。
  { id: 'gauge-burst', label: 'ゲージ満タン(専用)', url: gaugeBurstUrl, gain: 0.9 },
  { id: 'stock-burst', label: 'ストック満杯(専用)', url: stockBurstUrl, gain: 0.9 },
  { id: 'helper-stamp', label: 'お助け(専用)', url: helperStampUrl, gain: 0.9 },
  { id: 'comment-jam', label: 'コメント妨害(専用)', url: commentJamUrl, gain: 0.9 },
  { id: 'boost-tap', label: 'ブースト タップ開始(専用)', url: boostTapUrl, gain: 0.9 },
  // どのスロットの既定でもない選択肢 — 清算の締めなど、好みの位置に手で割り当てる用。
  { id: 'boost-final', label: 'ブースト 締め(専用)', url: boostFinalUrl, gain: 0.9 },
  { id: 'boost-hit', label: 'ブースト着弾(専用)', url: boostHitUrl, gain: 0.9 },
  { id: 'reel-kick', label: 'ルーレット キック(専用)', url: reelKickUrl, gain: 0.9 },
  { id: 'reel-hit', label: 'ルーレット確定(専用)', url: reelHitUrl, gain: 0.9 },
  { id: 'clear-fanfare', label: '達成(専用)', url: clearFanfareUrl, gain: 0.9 },
  // 超激アツ(ultra)のカウントダウン式演出のボイス(作者提供)。上のバッチと違い
  // **ピークではなく RMS を -17dB に揃えて**取り込んである — 素材の RMS が 7.6dB
  // ばらついていて、ピーク合わせだけでは体感音量が合わなかった(短い叫びほど
  // 波高が立つので、ピークを揃えると逆に小さく聞こえる)。結果は7本とも
  // RMS -15.7〜-15.8dB・ピーク -2.1〜-6.5dB で、既存音の分布のほぼ中央。
  // **既に揃っているので gain は引かない(1.0)。**
  { id: 'hype-kakugo', label: '激熱ボイス「覚悟を決めましょう」', url: hypeKakugoUrl, gain: 1 },
  { id: 'hype-iyashi', label: '激熱ボイス「癒しの力よ」', url: hypeIyashiUrl, gain: 1 },
  {
    id: 'hype-yoroshiku',
    label: '激熱ボイス「よろしくお願いします」',
    url: hypeYoroshikuUrl,
    gain: 1,
  },
  {
    id: 'hype-kiitenaiyo',
    label: '激熱ボイス「こんなの聞いてないよ！？」',
    url: hypeKiitenaiyoUrl,
    gain: 1,
  },
  { id: 'back-kuh', label: '戻りボイス「くっ！」', url: backKuhUrl, gain: 1 },
  { id: 'back-uh', label: '戻りボイス「うっ！」', url: backUhUrl, gain: 1 },
  { id: 'back-ite', label: '戻りボイス「いてっ！」', url: backIteUrl, gain: 1 },
];

const BY_ID = new Map(SE_SOUNDS.map((s) => [s.id, s]));

/**
 * 音ごとの再生プール。以前は再生のたびに cloneNode で新しい HTMLAudioElement を
 * 作り捨てていた — 連打ギフトの多い長時間配信では毎時数千要素の GC 餌になる。
 * 同じ音の同時再生は POOL_SIZE 発まで(それ以上は最古の発音を巻き戻して使い回す)。
 */
const POOL_SIZE = 4;
const pools = new Map<string, { els: HTMLAudioElement[]; next: number }>();

/**
 * id の音を鳴らす。volume は 0-100 の実効音量 — 全体音量とスロットごとの個別音量を
 * 掛け合わせた値なので、呼び出し側は shared/challenge.ts の effectiveSeVolume() を
 * 通した結果を渡すこと(seVolume を素で渡すと個別音量が効かない)。小数可。
 * 'off' や未知の id は無音(validate 済み設定なら既定に矯正されているが、
 * ポーリング前の古い設定が来ても落ちないように)。
 */
export function playSe(id: string, volume: number): void {
  const s = BY_ID.get(id);
  if (!s) return;
  const v = Math.min(1, Math.max(0, volume / 100)) * s.gain;
  if (v <= 0) return;
  let p = pools.get(s.id);
  if (!p) {
    p = { els: [], next: 0 };
    pools.set(s.id, p);
  }
  let a: HTMLAudioElement;
  if (p.els.length < POOL_SIZE) {
    a = new Audio(s.url);
    a.preload = 'auto';
    p.els.push(a);
  } else {
    a = p.els[p.next]!;
    p.next = (p.next + 1) % POOL_SIZE;
    try {
      a.currentTime = 0;
    } catch {
      /* ロード前の seek 失敗は無視 — play() が先頭から鳴らす */
    }
  }
  a.volume = Math.min(1, v);
  // デコード失敗や autoplay ポリシー変更で reject し得る — 演出は視覚が主なので握りつぶす。
  void a.play().catch(() => {});
}
