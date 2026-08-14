import bgmBand1Url from '../assets/se/band/bgm-band1.mp3';
import bgmBand2Url from '../assets/se/band/bgm-band2.mp3';
import bgmBand3Url from '../assets/se/band/bgm-band3.mp3';
import bgmBand4Url from '../assets/se/band/bgm-band4.mp3';
import bgmRoulette1Url from '../assets/se/roulette/bgm-roulette1.ogg';
import spinReel1Url from '../assets/se/roulette/spin-reel1.ogg';
import spinReel2Url from '../assets/se/roulette/spin-reel2.ogg';

/**
 * カットインBGMのカタログと再生API(素材の由来は assets/se/CREDITS.md)。
 * id の一覧は shared/challenge.ts の CHALLENGE_BAND_BGM_IDS と一致させること
 * (validate がそのリストで設定値を検証する)。
 *
 * playSe(lib/se.ts)と別モジュールなのは意図的:
 * - playSe はステートレスな短音専用で、停止・ループ・フェードのAPIを持たない
 *   (clone して撃ちっぱなし)。BGMは「カットインの尺だけ流して止める」ので
 *   再生中の Audio 要素へのハンドルが必要。
 * - SE_SOUNDS に長尺曲を混ぜると、効果音スロットの select 全部に BGM が
 *   選択肢として現れてしまう。
 */

export interface BandBgm {
  id: string;
  /** 設定画面のドロップダウンに出す表示名。 */
  label: string;
  url: string;
  /** 素材ごとのラウドネス差を吸収する相対ゲイン(se.ts と同じ考え方)。 */
  gain: number;
}

export const BAND_BGM: readonly BandBgm[] = [
  { id: 'bgm-band1', label: '当たり(小)— チップチューン', url: bgmBand1Url, gain: 1 },
  { id: 'bgm-band2', label: '当たり(中)— ファンファーレ', url: bgmBand2Url, gain: 1 },
  { id: 'bgm-band3', label: '大当たり — ユーロビート', url: bgmBand3Url, gain: 1 },
  { id: 'bgm-band4', label: '超大当たり — フィーバー', url: bgmBand4Url, gain: 1 },
];

/**
 * ルーレット回転中BGMのカタログ。id の一覧は shared/challenge.ts の
 * CHALLENGE_ROULETTE_BGM_IDS と一致させること(あちらは BAND_BGM の id も
 * 選択肢として連結する — サスペンス曲以外に既存の当たり曲も選べる仕様)。
 * BAND_BGM と別配列なのは意図的: 帯域カットインの select はこの配列を見ないので、
 * 回転用の曲が帯域の選択肢に混ざらない(SE_SOUNDS と分けたのと同じ理由)。
 */
export const ROULETTE_BGM: readonly BandBgm[] = [
  { id: 'bgm-roulette1', label: 'サスペンス — ドラムロール', url: bgmRoulette1Url, gain: 0.85 },
];

/**
 * リール回転ループ音のカタログ。「効果音」だが se.ts ではなくここに置く —
 * 回転の間ずっとループし、リール停止で止める必要があるので、撃ちっぱなしの
 * playSe では扱えない(このモジュールの冒頭コメントの分掌どおり)。
 * gain 低め: 素材のクリックはピークが鋭いので、背景のカラカラに沈める。
 */
export const ROULETTE_SPIN_SE: readonly BandBgm[] = [
  // 既定。回転中BGMを既定オフにしたぶん、回転音だけで場が持つジングル素材にしてある。
  // gain 0.3: 素材が spin-reel1 より約 10dB 熱い(mean -13.9dB / spin-reel1 -24.0dB)。
  // 実効 -24.5dB 相当 = 旧構成(BGM + カチカチ)の回転音より 4dB ほど前に出る値。
  { id: 'spin-reel2', label: 'リール回転音(ジングル)', url: spinReel2Url, gain: 0.3 },
  { id: 'spin-reel1', label: 'リール回転音(カチカチ)', url: spinReel1Url, gain: 0.6 },
];

// id は 'bgm-band*' / 'bgm-roulette*' / 'spin-*' の接頭辞で衝突しない —
// 新カタログを足すときもこの規約を守ること。
const BY_ID = new Map([...BAND_BGM, ...ROULETTE_BGM, ...ROULETTE_SPIN_SE].map((b) => [b.id, b]));

/** 再生中のBGMのハンドル。stop は何度呼んでも安全(冪等)。 */
export interface BgmHandle {
  /** fadeMs かけて音量を落として止める。0 で即時停止。 */
  stop(fadeMs?: number): void;
}

/** フェードの刻み。荒いと段付きが聞こえ、細かいと timer が無駄に回る。 */
const FADE_STEP_MS = 50;

/**
 * id のBGM/ループ音を再生する(カットイン・ルーレット共用)。volume は 0-100(cfg の値をそのまま
 * 渡してよい — SEと違いスロット個別音量の掛け算は無い)。
 * 未知の id・volume 0 は何もせず null を返す(120秒ポーリング(CFG_POLL_MS)前の古い設定や
 * 旧 worker からの effect でも落ちない)。
 *
 * 呼び出し側の規約: 返ったハンドルは必ず stop すること。カットインの終端フェード・
 * finishBandFx/abortBandFx・unmount cleanup のすべての出口で stop を呼ぶ
 * (stop は冪等なので重複して呼んでよい)。
 */
export function playBandBgm(id: string | null | undefined, volume: number): BgmHandle | null {
  if (!id) return null;
  const s = BY_ID.get(id);
  if (!s) return null;
  const v = Math.min(1, Math.max(0, volume / 100)) * s.gain;
  if (v <= 0) return null;

  const a = new Audio(s.url);
  a.loop = true; // 曲がカットインより短くても途切れない(尺はタイマーが権威)
  a.volume = Math.min(1, v);
  // デコード失敗等で reject し得る — 演出は視覚が主なので握りつぶす(playSe と同じ)。
  void a.play().catch(() => {});

  let stopped = false;
  let fadeTimer: number | null = null;
  // 現在フェードの終了予定時刻。stop の再入で「より短いフェード」だけを受け付ける
  // 判定に使う(長くする再入を許すと、先行の stop(0) 即断が後続の stop(400) で
  // 生き返ったように見える)。
  let fadeEndsAt = 0;

  const kill = (): void => {
    if (fadeTimer !== null) {
      window.clearInterval(fadeTimer);
      fadeTimer = null;
    }
    a.pause();
    // src を空にしてバッファを解放(Audio 要素はどこにも参照が残らない)。
    a.removeAttribute('src');
    a.load();
  };

  const beginFade = (fadeMs: number): void => {
    if (fadeTimer !== null) window.clearInterval(fadeTimer);
    fadeEndsAt = performance.now() + fadeMs;
    const startVol = a.volume;
    const steps = Math.max(1, Math.round(fadeMs / FADE_STEP_MS));
    let i = 0;
    fadeTimer = window.setInterval(() => {
      i++;
      if (i >= steps) {
        kill();
        return;
      }
      a.volume = Math.max(0, startVol * (1 - i / steps));
    }, FADE_STEP_MS);
  };

  return {
    stop(fadeMs = 400): void {
      // 再入対応: 「フェード中に stop(0) で即断する」を必ず通す。
      // 以前は stopped フラグで2回目以降が丸ごと no-op になり、finishBandFx の
      // stop(0) やアンマウント時の停止が効かず、BGM とフェード interval が
      // 最大 400ms 残留していた。
      if (stopped) {
        if (fadeTimer === null) return; // kill 済み
        if (fadeMs <= 0) {
          kill();
          return;
        }
        // 現在のフェードより長くする再入は無視(冪等な重複呼び出しがこれ)。
        if (performance.now() + fadeMs >= fadeEndsAt) return;
        beginFade(fadeMs); // 現在音量から短く畳み直す
        return;
      }
      stopped = true;
      if (fadeMs <= 0 || a.paused) {
        kill();
        return;
      }
      beginFade(fadeMs);
    },
  };
}
