/**
 * 「舞台(stage)」= モニターで同時に1つだけ許される演出の枠。
 *
 * これまで排他プロトコルを持っていたのは cutin クラス(ルーレット / 帯域カットイン /
 * 全面カット / ストック満杯 / ブースト)と着弾チェーンだけで、**±N 浮上バナー
 * (`.float`)には開始プロトコルが一切無かった** — 届いた瞬間に無条件で描画され、
 * `FLOAT_MAX` 枚まで縦に積まれ(= 連続フォローで「2列」になる)、しかもバナーが
 * 生きている最中に次の演出が始まって重なっていた。
 *
 * ここはその判定だけを純関数として持つ。**レンダラのテスト環境がこのリポジトリに
 * 無い**(vitest は node 環境のみ、tsconfig.node.json は src/renderer を含まない)ので、
 * 演出の決定ロジックは shared に出して node のテストで固定する —
 * fx-drain.ts / fx-floats.ts / boost-start.ts / boost-settle.ts と同じ理由。
 *
 * 【設計の核】舞台の占有は **boolean ではなく絶対時刻(時刻ラッチ)**で持つ。
 * boolean のフラグは、mac のウィンドウ遮蔽で setTimeout が 1Hz 以下に絞られたり
 * animationend が届かなかったりすると立ちっぱなしになり、**以後すべての演出が
 * 永久にキューされる = モニターの全死**を意味する。時刻なら「今」が過ぎれば
 * 誰も何もしなくても自然に解放される(worker の fxFreezeUntilMs と同じ流儀)。
 */

/**
 * `.float` の浮上アニメーションの尺。**monitor.css:1666 の `floatup 1.6s` と同値**
 * でなければならない(fx-stage.spec.ts が CSS を読んで固定する)。
 */
export const BANNER_MS = 1600;

/**
 * `.float.gift-card` だけは `animation-duration: 2.2s`(monitor.css:1898)で上書き
 * されている。ギフトカードは行数が多く読むのに時間がかかるため。
 */
export const BANNER_GIFT_CARD_MS = 2200;

/**
 * バナー → 次のバナーの間合い。`.float` の立ち上がり(floatup の 0%→22%)は約
 * 350ms なので、これを下回ると次のバナーが前の消え際に生えて「2枚が同時に出た」
 * ように見える — 1件ずつ出す意味が失われる。
 */
export const STAGE_GAP_BANNER_MS = 350;

/**
 * バナー → カットイン(ルーレット / 帯域 / 全面カット / ストック / ブースト /
 * 着弾チェーン)の間合い。バナー間より長いのは、暗幕や不透明動画が立ち上がる
 * 演出のほうが「前の残り火」と混ざったときの違和感が大きいため。
 */
export const STAGE_GAP_CUTIN_MS = 500;

/**
 * **フィーバー結果バナー(boost-result)のあとだけ**に置く追加の間合い。
 * 2026-08-17 ユーザー決定 —「N 浮上後、次のキュー開始まで2秒待機(ブースト演出のみ)」。
 *
 * 清算発表(ロールアップ → 発射 → 着弾)の直後に出る「フィーバー! タップ×N」は
 * その配信回の山場の締めなので、他のバナーと同じ 500ms で次の演出へ流すと読む前に
 * 次の絵が始まる。**ここだけ**を伸ばすのが要件で、ルーレット確定・カットイン・
 * 着弾のあとの間合いは STAGE_GAP_CUTIN_MS(500ms)のまま — 全体を伸ばすと
 * バナーの排出速度が落ちて順番待ちが渋滞する側へ倒れる。
 *
 * 乗るのは **'cutin'(= 演出の開始)だけ**。順番待ちバナー同士の間合い
 * (STAGE_GAP_BANNER_MS)には乗せない。
 */
export const STAGE_GAP_BOOST_RESULT_MS = 2000;

/**
 * 順番待ちの上限。ユーザー決定は「渋滞しても1件も捨てない・尺は常に一定」だが、
 * 上限のない FIFO はメモリと遅延が無限に伸びる(いいね祭り+フォロー連打で
 * 「2分前のフォロー通知が今出る」になる)。到達しない想定の暴走止めとして置く —
 * 1件あたり約 1.95 秒なので 64 件 ≒ 2 分ぶん。溢れたら**最古から**捨てる。
 */
export const BANNER_QUEUE_MAX = 64;

/**
 * 飢餓弁。舞台が空いたとき既定ではカットイン(持ち越しキュー)を優先するが、
 * 45 秒級の全面カットが連続すると順番待ちのバナーが延々と後回しになる。
 * 最古がこれ以上待っていたら、その1枚だけ先に出す。
 *
 * 「その1枚だけ」は `lastStarveServeMs`(前回発火の時刻ラッチ)で担保する。
 * ≤v0.7.2 は無状態の年齢判定だけだったため、バナー流入が排出速度
 * (約 0.51 件/秒)を超えると先頭が常に 8 秒超えになり **毎回 'banner' に
 * ラッチして drain が全死**した — 満タン/ストック着弾(pendingStrike)は
 * drain の最下位フォールスルーでしか消化されないので、渋滞中の配信では
 * 「ゲージは溜まるのに演出が一切出ない」となる(diag.log の
 * 「バナーの順番待ちが渋滞」がその足跡)。発火はこの窓につき1回まで。
 */
export const BANNER_STARVE_MS = 8000;

/** 舞台が空いたときに次へ出すもの。 */
export type StageNext = 'drain' | 'banner' | 'idle';

/**
 * ドレイン側の飢餓弁。序列①⑤(フォロー/お助け)のバナーはランク比較で
 * ドレインの⑥⑦⑧に勝ち続けられるため、お助け連打が band/boost キュー(各4)を
 * 溢れさせて「値だけ動いて演出が出ない」最悪形に落ちうる — バナー飢餓弁
 * (BANNER_STARVE_MS)の対称形として、ドレイン最古がこれ以上待ったら
 * ランク比較を跳ばして1件流す。
 */
export const DRAIN_STARVE_MS = 10_000;

/**
 * バナーの実尺をクラス文字列から引く。`pushFloat(node, cls)` の cls は
 * `'gift-card t3 bad'` のような空白区切りなので、**トークン一致**で見る
 * (`includes` だと `banner-gift-cardish` のような将来のクラスで誤爆する)。
 */
export function bannerDurationMs(cls: string): number {
  return cls.split(/\s+/).includes('gift-card') ? BANNER_GIFT_CARD_MS : BANNER_MS;
}

/**
 * 舞台ラッチの押し出し。**必ず max で伸ばす** — 代入にすると、ギフトカード
 * (2.2s)の最中に短いバナー(1.6s)が差し込まれたときにラッチが縮み、まだ
 * 画面に残っているバナーの上へ次の演出が生える(直そうとしている症状そのもの)。
 */
export function bannerEndAtFor(curEndAt: number, nowMs: number, cls: string): number {
  return Math.max(curEndAt, nowMs + bannerDurationMs(cls));
}

/**
 * 次に `kind` を出せるまでの待ち(ms)。0 = 今すぐ出せる。
 *
 * `bannerEndAt` は「今出ているバナーが消える絶対時刻」。初期値 0 は遥か過去として
 * 自然に機能する。**負値は返さない**ので、呼び出し側は `> 0` で待ちを判定できる。
 */
export function stageWaitMs(
  bannerEndAt: number,
  nowMs: number,
  kind: 'banner' | 'cutin'
): number {
  const gap = kind === 'cutin' ? STAGE_GAP_CUTIN_MS : STAGE_GAP_BANNER_MS;
  return Math.max(0, bannerEndAt + gap - nowMs);
}

/**
 * 舞台ラッチの正当な最大先行幅。`bannerEndAtFor` は `max(cur, now + 尺)` でしか
 * 前進せず、尺の最大は BANNER_GIFT_CARD_MS — つまり**時計が単調なら
 * `bannerEndAt ≤ now + BANNER_GIFT_CARD_MS` が不変条件**。これを超える先行は
 * 時計の後方ステップ(NTP 巻き戻し・サスペンド/レジューム)でしか作れない。
 */
export const BANNER_LATCH_MAX_AHEAD_MS = BANNER_GIFT_CARD_MS;

/**
 * 後方ステップで未来に固着したラッチを不変条件の上限まで引き戻す(短縮方向のみ —
 * 時計が単調な限りは恒等関数)。これが無いと、ステップ後は新バナーが出ない →
 * animationend も来ない → `stageWaitMs` がステップ幅ぶん正の待ちを返し続け、
 * **舞台が全死する**(時刻ラッチ設計の唯一の穴)。worker の armFreezeTimer の
 * 巻き戻り対策(challenge.ts)のレンダラ側対応。
 */
export function clampBannerEndAt(curEndAt: number, nowMs: number): number {
  return Math.min(curEndAt, nowMs + BANNER_LATCH_MAX_AHEAD_MS);
}

/**
 * 飢餓弁の発火時刻の後方ステップ対策(clampBannerEndAt と同型・短縮方向のみ —
 * 時計が単調な限りは恒等関数)。発火時刻は「now を書く」だけなので正当な値は
 * 常に過去 — 未来に居るのは時計の後方ステップだけで、放置すると弁がステップ幅
 * ぶん閉じ続ける(= 渋滞中のバナーがその間1枚も流れない)。
 */
export function clampStarveServedAt(curMs: number, nowMs: number): number {
  return Math.min(curMs, nowMs);
}

/**
 * フィーバー結果バナーを出した瞬間に張る「演出を始めてよい時刻」。
 * = そのバナーが消える時刻(bannerEndAt)+ STAGE_GAP_BOOST_RESULT_MS。
 * 舞台ラッチと同じ**絶対時刻**で持つので、タイマーが遮蔽で失われても
 * 「今」が過ぎれば誰も何もしなくても自然に解放される。
 */
export function boostGapUntilFor(bannerEndAt: number): number {
  return bannerEndAt + STAGE_GAP_BOOST_RESULT_MS;
}

/** boostGapUntil の正当な最大先行幅(clampBannerEndAt と同じ導出)。 */
export const BOOST_GAP_LATCH_MAX_AHEAD_MS = BANNER_GIFT_CARD_MS + STAGE_GAP_BOOST_RESULT_MS;

/**
 * 後方ステップ(NTP 巻き戻し・サスペンド/レジューム)で未来に固着した
 * boostGapUntil を不変条件の上限まで引き戻す(短縮方向のみ — 時計が単調な限りは
 * 恒等関数)。clampBannerEndAt と同型で、**時刻ラッチには必ずクランプを付ける**
 * という規律に従う。これが無いとステップ後に演出が全死する。
 */
export function clampBoostGapUntil(curMs: number, nowMs: number): number {
  return Math.min(curMs, nowMs + BOOST_GAP_LATCH_MAX_AHEAD_MS);
}

/** pickStageNext の入力。 */
export interface StagePick {
  /** 持ち越しキュー(達成 / ブースト / 帯域 / ルーレット / 着弾)に中身があるか。 */
  hasDrain: boolean;
  /** 順番待ちのバナー件数。 */
  queuedCount: number;
  /** 順番待ちの最古が積まれた時刻。空なら null。 */
  oldestQueuedAtMs: number | null;
  nowMs: number;
  /**
   * 飢餓弁が最後にバナーを通した時刻。0 = 未発火(遥か過去)。呼び出し側は
   * **飢餓弁で**バナーを供給した瞬間だけ now を書き(ランク勝ちの供給では
   * 刻まない — bannerWinsByRank で判別)、後方ステップは clampStarveServedAt で
   * 引き戻すこと。
   */
  lastStarveServeMs: number;
  /**
   * 待機ドレインの最高ランク(fx-drain の bestDrainRank)。null/省略 =
   * ランク比較をしない(予約のみ・旧経路互換)。ランクの権威は fx-priority.ts。
   */
  drainBestRank?: number | null;
  /** 順番待ちバナーの最高ランク。null/省略 = ランク比較をしない。 */
  bannerBestRank?: number | null;
  /**
   * ドレイン最古の待機開始時刻(キューが空→非空になった瞬間)。null/省略 =
   * ドレイン側飢餓弁を使わない。
   */
  oldestDrainWaitingSinceMs?: number | null;
}

/**
 * バナーがランク比較でドレインに勝つか。**同ランクは drain 勝ち** — 持ち越し
 * キューは浅く(各4件)、溢れの実害が大きいのはドレイン側という既存判断を
 * タイブレークとして残す。呼び出し側はこれが false のバナー供給(= 飢餓弁 or
 * ドレイン不在)のときだけ lastStarveServeMs を刻む。
 */
export function bannerWinsByRank(s: StagePick): boolean {
  return s.bannerBestRank != null && s.drainBestRank != null && s.bannerBestRank < s.drainBestRank;
}

/**
 * 舞台が空いた瞬間に何を出すか。判定は3段:
 * 1. **ドレイン側飢餓弁**(DRAIN_STARVE_MS)— 上位バナーの連流でも最古の
 *    ドレインが待ちすぎたら先に流す(キュー溢れ=演出消失の防止が最優先)。
 * 2. **ランク比較**(fx-priority の序列)— フォロー(①)・お助け(⑤)の
 *    バナーは、それより下位のドレイン(⑥初見/⑦カットイン/⑧ギフトルーレット)
 *    より先に出る。同ランクは drain 勝ち(bannerWinsByRank)。
 * 3. **従来のバナー飢餓弁** — ⑧のバナー(ギフトカード等)は既定でカットイン
 *    優先のまま、最古が BANNER_STARVE_MS 待ったら窓につき1回だけ割り込む。
 * ランク欄(drainBestRank / bannerBestRank)を省略した呼び出しは従来挙動
 * (drain 優先+バナー飢餓弁のみ)に一致する。
 */
export function pickStageNext(s: StagePick): StageNext {
  const queued = s.queuedCount > 0;
  if (!s.hasDrain) return queued ? 'banner' : 'idle';
  if (
    queued &&
    s.oldestDrainWaitingSinceMs != null &&
    s.nowMs - s.oldestDrainWaitingSinceMs >= DRAIN_STARVE_MS
  ) {
    return 'drain'; // ドレイン側飢餓弁 — ランク比較より先(キュー溢れの防止が最優先)
  }
  if (queued && bannerWinsByRank(s)) return 'banner';
  if (
    s.nowMs - s.lastStarveServeMs >= BANNER_STARVE_MS && // 弁の再発火窓(1発/窓)
    queued &&
    s.oldestQueuedAtMs != null &&
    s.nowMs - s.oldestQueuedAtMs >= BANNER_STARVE_MS
  ) {
    return 'banner';
  }
  return 'drain';
}

/**
 * 順番待ちから「最高ランク・同ランク内は最古(FIFO)」の1枚を取り出す
 * (in-place splice)。ランクは fx-priority の bannerRank を rankOf として注入 —
 * fx-stage は数値しか見ない(層の分離)。
 */
export function takeNextBanner<T>(q: T[], rankOf: (t: T) => number): T | undefined {
  if (q.length === 0) return undefined;
  let best = 0;
  for (let i = 1; i < q.length; i++) {
    if (rankOf(q[i]!) < rankOf(q[best]!)) best = i; // 厳密な < なので同ランクは先着が勝つ
  }
  return q.splice(best, 1)[0];
}

/** 順番待ちの最高ランク(最小値)。空なら null。 */
export function bestQueuedRank<T>(q: readonly T[], rankOf: (t: T) => number): number | null {
  let best: number | null = null;
  for (const item of q) {
    const r = rankOf(item);
    if (best === null || r < best) best = r;
  }
  return best;
}

/**
 * 上限つきの enqueue(in-place)。溢れたぶんは落として件数を返す。
 * - rankOf 省略時(旧経路互換): **最古から**落とす — 新しい通知のほうが配信の
 *   「今」に近い。
 * - rankOf 指定時: **最低ランクの中の最古**から落とす — フォロー(①)や
 *   お助け(⑤)を like-float(⑧)より先に失わないため。
 */
export function enqueueBanner<T>(
  q: T[],
  item: T,
  max: number = BANNER_QUEUE_MAX,
  rankOf?: (t: T) => number
): { dropped: number } {
  q.push(item);
  const limit = Math.max(0, Math.floor(max));
  let dropped = 0;
  while (q.length > limit) {
    if (rankOf === undefined) {
      q.shift();
    } else {
      let worst = 0;
      for (let i = 1; i < q.length; i++) {
        if (rankOf(q[i]!) > rankOf(q[worst]!)) worst = i; // 厳密な > なので同ランクは最古が落ちる
      }
      q.splice(worst, 1);
    }
    dropped++;
  }
  return { dropped };
}
