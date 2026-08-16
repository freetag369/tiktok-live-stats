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
   * 実際にバナーを供給した瞬間だけ now を書き、後方ステップは
   * clampStarveServedAt で引き戻すこと。
   */
  lastStarveServeMs: number;
}

/**
 * 舞台が空いた瞬間に何を出すか。**既定はカットイン優先** — 持ち越しキューは
 * 浅く(PENDING_BANDS_MAX=4 / pendingBoosts 2)、溢れると「値だけ動いて演出が
 * 出ない」最悪の見え方になるので、待たせる実害が大きいのはこちら。
 * バナー側は飢餓弁でしか割り込ませず、発火は BANNER_STARVE_MS の窓につき
 * 1回まで(前回発火からの経過も同じ定数で判定)— 渋滞が続いても drain と
 * バナーが交互に番を得る。
 */
export function pickStageNext(s: StagePick): StageNext {
  const queued = s.queuedCount > 0;
  if (!s.hasDrain) return queued ? 'banner' : 'idle';
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
 * 上限つきの enqueue(in-place)。溢れたぶんは**最古から**落として件数を返す。
 * 新しい通知のほうが配信の「今」に近いので、落とすなら古いほうという判断。
 */
export function enqueueBanner<T>(q: T[], item: T, max: number = BANNER_QUEUE_MAX): { dropped: number } {
  q.push(item);
  const limit = Math.max(0, Math.floor(max));
  let dropped = 0;
  while (q.length > limit) {
    q.shift();
    dropped++;
  }
  return { dropped };
}
