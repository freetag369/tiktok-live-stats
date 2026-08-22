import { customSoundFileName, isCustomSoundId } from '@shared/challenge';
import bgmBand1Url from '../assets/se/band/bgm-band1.mp3';
import bgmBand2Url from '../assets/se/band/bgm-band2.mp3';
import bgmBand3Url from '../assets/se/band/bgm-band3.mp3';
import bgmBand4Url from '../assets/se/band/bgm-band4.mp3';
import bgmQuizChaseUrl from '../assets/se/quiz/bgm-quiz-chase.mp3';
import bgmQuizThinkUrl from '../assets/se/quiz/bgm-quiz-think.mp3';
import bgmRoulette1Url from '../assets/se/roulette/bgm-roulette1.ogg';
// 回転中BGM枠(bgm-roulette2)とリール回転音枠(spin-slot)の両方で使う同一素材。
// ファイルは1本・カタログのエントリが2つ(BY_ID の都合で id は分ける)。
import slotUrl from '../assets/se/roulette/slot.ogg';
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
  // gain 0.85: bgm-roulette1(mean -13.0dB)と 0.7dB 差しかないので同値でよい。
  { id: 'bgm-roulette2', label: 'スロット — リール回転', url: slotUrl, gain: 0.85 },
  // お題ルーレットの出荷既定2曲(2026-08-22)。区間①と区間⑤の既定で、ここに
  // 置いてあるので回転中BGMの選択肢にも並ぶ(逆は無し — 帯域の select には出ない)。
  // gain 0.6: 素材が -8.9 LUFS と熱く、bgm-roulette1(-12.8 LUFS × gain 0.85 =
  // 実効 -14.2)に並べるには 4.4dB 落とす必要がある(実効 -13.3 LUFS)。
  { id: 'bgm-quiz-chase', label: 'お題 — 追いかけっこ(既定)', url: bgmQuizChaseUrl, gain: 0.6 },
  // gain 1: 素材が小さかったぶんは取り込み時に増幅済み(-14.1 LUFS / peak -1.3dB)。
  // カタログの gain は減衰しかできないので、持ち上げは ffmpeg 側でやる規約
  // (assets/se/CREDITS.md の reel-stop と同じ事情)。
  { id: 'bgm-quiz-think', label: 'お題 — 考え中(既定)', url: bgmQuizThinkUrl, gain: 1 },
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
  // gain 0.3: 既定の spin-reel2(mean -13.9dB)と 0.2dB 差なので同じ値で釣り合う。
  { id: 'spin-slot', label: 'リール回転音(スロット)', url: slotUrl, gain: 0.3 },
];

// id は 'bgm-band*' / 'bgm-roulette*' / 'spin-*' の接頭辞で衝突しない —
// 新カタログを足すときもこの規約を守ること。
const BY_ID = new Map([...BAND_BGM, ...ROULETTE_BGM, ...ROULETTE_SPIN_SE].map((b) => [b.id, b]));

/** 再生中のBGMのハンドル。stop は何度呼んでも安全(冪等)。 */
export interface BgmHandle {
  /** fadeMs かけて音量を落として止める。0 で即時停止。 */
  stop(fadeMs?: number): void;
  /**
   * 音量(0-100)を差し替える。お題の区間別BGM で「同じ曲を続けたまま区間ごとの
   * 音量へ寄せる」ために足した(頭出しに戻さないため鳴らし直しはしない)。
   * フェード中(stop 済み)は無視する — 消えかけの曲を生き返らせない。
   */
  setVolume(volume: number): void;
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
 *
 * fadeInMs > 0 で無音から立ち上げる(お題の区間別BGM のクロスフェード用 —
 * 前の曲の stop(fadeMs) と重ねて呼ぶ)。省略時 0 = 従来どおり即フル音量。
 */
export function playBandBgm(
  id: string | null | undefined,
  volume: number,
  fadeInMs = 0
): BgmHandle | null {
  if (!id) return null;
  let url: string;
  let gain: number;
  if (isCustomSoundId(id)) {
    // ユーザー取込みの回転音(custom:<ファイル名>)。実体は config/sounds/ で、
    // main の app-sound:// プロトコル経由で読む(CSP の media-src が許可)。
    // gain 1: カタログの gain は素材間の音圧差を測って詰めた値で、未知の
    // ユーザー素材に当てられる基準が無い — 音量スライダーに全権を渡す。
    url = `app-sound:///${encodeURIComponent(customSoundFileName(id))}`;
    gain = 1;
  } else {
    const s = BY_ID.get(id);
    if (!s) return null;
    url = s.url;
    gain = s.gain;
  }
  const v = Math.min(1, Math.max(0, volume / 100)) * gain;
  if (v <= 0) return null;

  // 目標音量。setVolume で動く(フェードイン中はこの値へ向かって上がる)。
  let target = Math.min(1, v);

  const a = new Audio(url);
  a.loop = true; // 曲がカットインより短くても途切れない(尺はタイマーが権威)
  a.volume = fadeInMs > 0 ? 0 : target;

  // 取り壊し済みの印 = 下の error リスナーの偽陽性除け。
  //
  // Electron 43 で実測した限り、kill() の `pause() → removeAttribute('src') →
  // load()` が出すのは abort と emptied だけで error は出ない(a.error は null)。
  // **ただし `src = ''` にする書き方だと error(code 4)が出る**し、どちらになるかは
  // 取り壊しの書き方と Chromium のバージョン次第で変わる。取り壊した後に届く error は
  // 定義上どのみち対処できないので、ここで無条件に落とす — 正常停止のたびに
  // 全ループ音が「読込に失敗」を吐いて diag.log の本物の欠損報告を埋める、という
  // 壊れ方(fx-video-pool の「play() が拒否された」偽陽性と同型)を構造的に防ぐ。
  // 本物の欠損(ファイルが無い)は読み込み時 = kill より前に出るので握り潰さない。
  let killed = false;
  // ファイル欠損(config/sounds/ を手で掃除した等)は無音のまま進める —
  // 既定音へのフォールバックは「選んだ覚えのない音が本番で鳴る」事故のほうが重い。
  // console.warn は attachConsoleCapture 経由で diag.log に残る(事後診断用)。
  a.addEventListener('error', () => {
    if (killed) return;
    console.warn(`[bgm] 音声の読込に失敗: ${id}(ファイルが移動・削除された可能性)`);
  });
  // デコード失敗等で reject し得る — 演出は視覚が主なので握りつぶす(playSe と同じ)。
  void a.play().catch(() => {});

  let stopped = false;
  let fadeTimer: number | null = null;
  // 現在フェードの終了予定時刻。stop の再入で「より短いフェード」だけを受け付ける
  // 判定に使う(長くする再入を許すと、先行の stop(0) 即断が後続の stop(400) で
  // 生き返ったように見える)。
  let fadeEndsAt = 0;

  // フェードイン(クロスフェードの立ち上がり側)。stop のフェードとは別 timer で
  // 持ち、beginFade / kill の入口で必ず畳む — 両方が同時に a.volume を書くと
  // 「消えかけているのに上がり続ける」が起きる。
  let fadeInTimer: number | null = null;
  const clearFadeIn = (): void => {
    if (fadeInTimer !== null) {
      window.clearInterval(fadeInTimer);
      fadeInTimer = null;
    }
  };

  const kill = (): void => {
    clearFadeIn();
    if (fadeTimer !== null) {
      window.clearInterval(fadeTimer);
      fadeTimer = null;
    }
    // src を外す前に立てる — 空 src の error を「欠損の報告」と取り違えない。
    killed = true;
    a.pause();
    // src を空にしてバッファを解放(Audio 要素はどこにも参照が残らない)。
    a.removeAttribute('src');
    a.load();
  };

  const beginFade = (fadeMs: number): void => {
    clearFadeIn();
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

  if (fadeInMs > 0) {
    const steps = Math.max(1, Math.round(fadeInMs / FADE_STEP_MS));
    let i = 0;
    fadeInTimer = window.setInterval(() => {
      i++;
      if (i >= steps) {
        a.volume = target;
        clearFadeIn();
        return;
      }
      // target を毎回読むので、立ち上がり中に setVolume されても追従する。
      a.volume = Math.max(0, Math.min(1, target * (i / steps)));
    }, FADE_STEP_MS);
  }

  return {
    setVolume(nextVolume: number): void {
      target = Math.min(1, Math.max(0, nextVolume / 100) * gain);
      // 停止処理に入った後は触らない(消えかけの曲を生き返らせない)。
      if (stopped) return;
      // フェードイン中は interval が target へ向かうので、ここでは書かない
      // (書くと立ち上がりが一瞬で終わったように聞こえる)。
      if (fadeInTimer === null) a.volume = target;
    },
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
