import bgmBand1Url from '../assets/se/band/bgm-band1.mp3';
import bgmBand2Url from '../assets/se/band/bgm-band2.mp3';
import bgmBand3Url from '../assets/se/band/bgm-band3.mp3';
import bgmBand4Url from '../assets/se/band/bgm-band4.mp3';

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

const BY_ID = new Map(BAND_BGM.map((b) => [b.id, b]));

/** 再生中のBGMのハンドル。stop は何度呼んでも安全(冪等)。 */
export interface BgmHandle {
  /** fadeMs かけて音量を落として止める。0 で即時停止。 */
  stop(fadeMs?: number): void;
}

/** フェードの刻み。荒いと段付きが聞こえ、細かいと timer が無駄に回る。 */
const FADE_STEP_MS = 50;

/**
 * id のBGMをループ再生する。volume は 0-100(cfg.giftBandFx.bgmVolume をそのまま
 * 渡してよい — SEと違いスロット個別音量の掛け算は無い)。
 * 未知の id・volume 0 は何もせず null を返す(30秒ポーリング前の古い設定や
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

  return {
    stop(fadeMs = 400): void {
      if (stopped) return;
      stopped = true;
      if (fadeMs <= 0 || a.paused) {
        kill();
        return;
      }
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
    },
  };
}
