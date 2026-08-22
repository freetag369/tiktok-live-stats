import {
  ACHIEVED_CLIP_URL,
  GAUGE_FULL_CLIP_URL,
  QUIZ_INTRO_CLIP_URL,
  QUIZ_RESULT_CLIP_URL,
  REVOLUTION_INTRO_CLIP_URL,
  REVOLUTION_RESULT_CLIP_URL,
  STOCK_CUTIN_CLIP_URL,
  STOCK_FULL_CLIP_URL,
  STRIKE_CLIP_URL,
  TAP_LOCK_INTRO_CLIP_URL,
  fxClipUrl,
} from './fx';
import { prewarmSe } from './se';
import { rpc } from '../ipc/client';
import { dedupeSeIds, normalizePrewarmTargets, type PrewarmTarget } from './media-prewarm-core';

/**
 * メディア資産の起動時予熱(2026-08-22・モニター窓専用)。
 *
 * これまで演出動画(計200MB超)・毛筆フォント(8.4MB TTF)・効果音に予熱は
 * 一切なく、**各素材の初回再生は必ず demux+デコーダ初期化+初回デコード待ち**
 * だった(「演出が始まった瞬間に一瞬固まる」の主要因のひとつ)。ここで起動の
 * アイドル時間に、頻度の高い素材を1本ずつ順番に温める。
 *
 * 効くメカニズム(本番は asar 内 file:// なので renderer の fetch() は使えない):
 *  (1) OS ページキャッシュ — asar の該当領域が読まれ、初回 demux のディスク待ちが消える。
 *  (2) GPU プロセスの動画デコードスタックの初回起動(D3D11/DXVA)が先に済む。
 *  (3) フォントは document.fonts.load で fetch+パース(数百ms)を前払い。
 *  (4) SE はプールの1本目を先に作る(lib/se.ts の prewarmSe)。
 *
 * 規律:
 *  - <video> ホルダーの構造(key 再マウント+armVideoPlay の解放手順 —
 *    fx-video-pool.spec.ts が凍結)には一切触れない。予熱要素は **DOM に入れない**
 *    一時要素で、armVideoPlay の cleanup と同一の解放三点セット
 *    (pause → removeAttribute('src') → load)で即時返却する。同時使用は常に+1本。
 *  - 起動直後の負荷スパイクを作らない: 開始は起動8秒後、1本ずつ直列、
 *    本物の演出(<video> が DOM にいる間)は待避。
 *  - メモリ常駐が増えるのはフォント(+15〜25MB — quiz を1回でも使えばどのみち
 *    発生する分の前借り)と SE(数MB)だけ。動画はページキャッシュ(reclaimable)
 *    なので OBS 併用環境の working set をほぼ押し上げない。
 */

const START_DELAY_MS = 8_000;
/** 動画1本ごとの休止(直列でもデコーダ・IO を占有し続けない)。 */
const GAP_MS = 1_500;
/** 実演出中の待避の再確認間隔。 */
const BUSY_RECHECK_MS = 3_000;
/** 1本あたりの安全弁(壊れた素材・デコーダ確保失敗で永久に待たない)。 */
const WARM_TIMEOUT_MS = 5_000;
/** 予熱セッション全体の上限(演出が続く配信では諦める — 害はない)。 */
const MAX_TOTAL_MS = 5 * 60_000;

/**
 * 予熱対象(頻度の高い軽量素材から。大物は後ろ)。cfg に依存する素材
 * (ブースト段別クリップ・超激アツ rl/*)は選定が設定次第で外れやすく
 * 容量も大きい(rl は31MB/本)ので対象外 — 固定カタログだけで
 * 着弾・ゲージ・汎用ギフト・帯域・導入/結果カットの初回を温められる。
 */
export function selectPrewarmTargets(): PrewarmTarget[] {
  return normalizePrewarmTargets([
    { label: 'gauge-strike', url: STRIKE_CLIP_URL },
    { label: 'gift-t1', url: fxClipUrl('gift-t1') },
    { label: 'gift-t2', url: fxClipUrl('gift-t2') },
    { label: 'gift-t3', url: fxClipUrl('gift-t3') },
    { label: 'gift-t4', url: fxClipUrl('gift-t4') },
    { label: 'gauge-full', url: GAUGE_FULL_CLIP_URL },
    { label: 'stock-full', url: STOCK_FULL_CLIP_URL },
    { label: 'gift-band1', url: fxClipUrl('gift-band1') },
    { label: 'gift-band2', url: fxClipUrl('gift-band2') },
    { label: 'gift-band3', url: fxClipUrl('gift-band3') },
    { label: 'stock-cutin', url: STOCK_CUTIN_CLIP_URL },
    { label: 'tap-lock-intro', url: TAP_LOCK_INTRO_CLIP_URL },
    { label: 'gift-band4', url: fxClipUrl('gift-band4') },
    { label: 'revolution-intro', url: REVOLUTION_INTRO_CLIP_URL },
    { label: 'revolution-result', url: REVOLUTION_RESULT_CLIP_URL },
    { label: 'quiz-intro', url: QUIZ_INTRO_CLIP_URL },
    { label: 'quiz-result', url: QUIZ_RESULT_CLIP_URL },
    { label: 'achieved', url: ACHIEVED_CLIP_URL },
  ]);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

/**
 * 動画1本を温める。DOM 非接続の一時 <video> で最初のフレームが出るまで
 * (playing / timeupdate の先着)再生し、armVideoPlay と同一の解放三点セットで
 * 即返す。失敗(error / 拒否 / タイムアウト)は握って次へ — 予熱は保険であって
 * 演出の正しさに関与しない。
 */
function warmVideo(url: string): Promise<void> {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      window.clearTimeout(killer);
      v.pause();
      v.removeAttribute('src');
      v.load();
      resolve();
    };
    const killer = window.setTimeout(finish, WARM_TIMEOUT_MS);
    v.muted = true;
    v.preload = 'auto';
    v.addEventListener('playing', finish, { once: true });
    v.addEventListener('timeupdate', finish, { once: true });
    v.addEventListener('error', finish, { once: true });
    v.src = url;
    v.play().catch(finish);
  });
}

async function run(): Promise<void> {
  await sleep(START_DELAY_MS);
  // 1) フォント: quiz 初回の 8.4MB フェッチ+数百ms のパース+書体スワップを前払い。
  //    @font-face(monitor.css)宣言済みフォントは fonts.load で読み込みが走る。
  try {
    await document.fonts.load("400 64px 'Yuji Syuku'", 'あ');
  } catch {
    // 未対応・素材欠損は無視(従来どおり初回使用時に読む)。
  }
  // 2) SE: 実際に割り当たっている音だけ(既定構成で20本弱・計1MB級)。
  //    効果音オフ(seEnabled=false)なら温めない — playSe は鳴らない設定では
  //    warmed を一切引き取らないので、積むだけ純増の常駐になる。
  try {
    const cfg = await rpc('cfg.get', undefined);
    if (cfg.challenge.seEnabled) {
      prewarmSe(dedupeSeIds(Object.values(cfg.challenge.seSounds)));
    }
  } catch {
    // cfg が引けなくても動画・フォントの予熱は既に進んでいる。
  }
  // 3) 動画: 1本ずつ直列。実演出(<video> が DOM にいる間)は待避 —
  //    予熱要素は DOM 非接続なので自分自身には引っかからない。
  const deadline = Date.now() + MAX_TOTAL_MS;
  for (const t of selectPrewarmTargets()) {
    while (document.querySelector('video') !== null) {
      if (Date.now() > deadline) return;
      await sleep(BUSY_RECHECK_MS);
    }
    if (Date.now() > deadline) return;
    await warmVideo(t.url);
    await sleep(GAP_MS);
  }
}

let scheduled = false;

/** モニター窓のエントリ(monitor.tsx)から1回だけ呼ぶ。 */
export function schedulePrewarm(): void {
  if (scheduled) return;
  scheduled = true;
  void run();
}
