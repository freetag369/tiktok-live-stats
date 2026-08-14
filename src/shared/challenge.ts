import type {
  ChallengeCommentRule,
  ChallengeConfig,
  ChallengeEffect,
  ChallengeGiftClip,
  ChallengeGiftRule,
  ChallengeLogEntry,
  ChallengeRouletteConfig,
  ChallengeRouletteSegment,
  ChallengeSeSlot,
  ChallengeState,
  FanStampConfig,
  TapBoostConfig,
  GiftBandFxConfig,
  GiftFullCutConfig,
  GiftFullCutRule,
  GiftFxBand,
  RouletteSoundConfig,
  GiftRepeatFxConfig,
} from './dto';
import { WAKE_TIME_RE } from './time';
import {
  FULL_CUT_CLIPS,
  FULL_CUT_CLIPS_V3,
  FULL_CUT_CLIP_IDS,
  type FullCutClipDef,
} from './fx-cut';

/**
 * カウントダウンチャレンジ — 純関数のみ。状態機械は worker/challenge.ts。
 *
 * 「0まで寝ない」型の配信企画: ボタンで数字が減り、フォロー・いいねで増え(妨害)、
 * ギフトは規則表で増減が決まる。既定はギフトも妨害(ダイヤ数ぶん増える)。
 */

/** recentEffects リングバッファの上限。モニターの演出再生分だけあれば足りる。 */
export const CHALLENGE_EFFECTS_MAX = 12;

/** CLEAR リザルト画面の各ランキング(ギフト/イイネ)の表示件数。 */
export const CHALLENGE_RESULT_TOP_N = 5;

/**
 * モニター下部の常時表示ギフトランキングの件数。CLEAR リザルトと同じ runViewers
 * から同じヘルパーで切り出すので、この TOP3 は必ず TOP5 の先頭3件と一致する。
 */
export const CHALLENGE_MONITOR_TOP_N = 3;

/**
 * like 演出の合算窓。like は全メッセージの約9割の高頻度なので、この窓の間は
 * 加算分を積んでおき1件の effect にまとめる(リングバッファを食い潰さない)。
 */
export const LIKE_FX_WINDOW_MS = 1000;

/**
 * ダッシュボードの履歴ログの上限。worker のリングバッファ(12件)と違い、これは
 * 「配信者があとから振り返る」ための長さ — 数分ぶん遡れれば足りる。
 */
export const CHALLENGE_LOG_MAX = 50;

/**
 * ルーレット演出の尺。monitor.css の @keyframes とモニターの据え置き解除タイマーを
 * ここで同期させる — 片方だけ変えると「数字は動いたのにリールが回っている」が起きる。
 * 6000ms は要望値。終盤の段(ゆっくり/ポンポン/キック)を読める長さが要るため、
 * 旧 4300ms から伸ばした。キーフレームは割合で書いてあるのでここだけで効く。
 */
export const ROULETTE_SPIN_MS = 6000;
/**
 * 当選ブロックの発光(確定見せ)の尺。**確定するまで色を出さない**設計にした結果、
 * 色・符号・発光・確定音の全部がこの窓に入るので 600ms では山場が一瞬で終わる。
 */
export const ROULETTE_REVEAL_MS = 900;
/** 短縮スピンの確定見せ。キュー消化中は総尺を詰めたいので通常より短くする。 */
export const ROULETTE_REVEAL_FAST_MS = 450;
/** キュー詰まり時の短縮スピン。連続トリガーでも体感が間延びしない長さ。 */
export const ROULETTE_SPIN_FAST_MS = 900;
/**
 * モニターの連続再生キュー上限。溢れた分は演出スキップ(値は worker が適用済み)。
 * 溢れは「値だけ動いてリールが出ない」= 数字だけ動く最悪の見え方になるので、
 * 連打ギフトの反復スピン(giftFxRouletteSpins)の上限ぶんは飲めるだけ確保する。
 */
export const ROULETTE_QUEUE_MAX = 9;
/**
 * 据え置きの安全弁。onAnimationEnd が来なくても(タブ非表示等)この時刻で必ず
 * ラッチを解いて worker 値へ収束させる — startStrike の STRIKE_ABORT_MS と同じ役割。
 */
export const ROULETTE_ABORT_MS = ROULETTE_SPIN_MS + ROULETTE_REVEAL_MS + 1500;

/**
 * スピン1本の実尺と安全弁。fast(キュー消化)と通常で尺が違うので、片方だけ見て
 * 調整すると必ずもう片方が壊れる — 両経路をこの2関数に集約する。
 */
export function rouletteSpinMs(fast: boolean): number {
  return fast ? ROULETTE_SPIN_FAST_MS : ROULETTE_SPIN_MS;
}
export function rouletteRevealMs(fast: boolean): number {
  return fast ? ROULETTE_REVEAL_FAST_MS : ROULETTE_REVEAL_MS;
}
/** 据え置きの安全弁(ms)。実尺 + 確定見せ + 余裕。fast でも必ずアニメより後。 */
export function rouletteAbortMs(fast: boolean): number {
  return rouletteSpinMs(fast) + rouletteRevealMs(fast) + 1500;
}

/**
 * recentEffects を履歴ログへ取り込む。純関数(テスト可能)。
 *
 * 規約:
 * - lastId より新しい effect だけを古い順に積む(watermark 方式。演出再生と同じ)。
 * - **演出と違い「マウント直後は全件再生済みに倒す」はしない。** ログにストーム
 *   問題は無く、リロード直後に空だと「さっき何が起きたか」が消えてしまう。
 *   同じ理由で「5秒より古い effect はスキップ」もしない。
 * - lastId が最大 id を上回っていたら worker 再起動で id が振り直された合図。
 *   0 に倒して取り込み直す(MonitorView / useChallengeSe と同じ検知)。
 * - 連続する press は1行に畳む。連打で他の行が全部押し流されるのを防ぐ。
 *
 * 戻り値の log は**新しい順**(index 0 が最新)。
 */
export function appendChallengeLog(
  log: readonly ChallengeLogEntry[],
  state: ChallengeState,
  lastId: number | null
): { log: ChallengeLogEntry[]; lastId: number } {
  const effects = state.recentEffects;
  const maxId = effects.reduce((m, e) => Math.max(m, e.id), 0);
  // worker 再起動で id が 1 に戻ると、watermark が天井に残って以後すべて
  // 「取り込み済み」扱いになりログが凍る。巻き戻りを検知したら追従させる。
  const from = lastId === null || lastId > maxId ? 0 : lastId;
  // test(演出テスト再生)はログに積まない — 値に影響しない偽の行が履歴を汚す。
  // maxId は全件で計算済みなので watermark はテスト分も通過する。
  const fresh = effects.filter((e) => e.id > from && e.test !== true).sort((a, b) => a.id - b.id);
  if (fresh.length === 0) return { log: log as ChallengeLogEntry[], lastId: Math.max(from, maxId) };

  const out = log.slice();
  for (const e of fresh) {
    const head = out[0];
    // 連続 press の畳み込み。間に他の kind が挟まったら新しい行を立てる。
    // e が凍結ドレインの合算(coalesced)なら、その件数ぶんまとめて数える。
    if (e.kind === 'press' && head?.kind === 'press') {
      out[0] = {
        ...head,
        atMs: e.atMs,
        amount: head.amount + e.amount,
        valueAfter: e.valueAfter,
        count: (head.count ?? 1) + (e.coalesced ?? 1),
      };
      continue;
    }
    out.unshift(entryFor(e, state));
  }
  return { log: out.slice(0, CHALLENGE_LOG_MAX), lastId: Math.max(from, maxId) };
}

/** effect 1件 → ログ行。undefined のフィールドは載せない(JSON 比較を素直に保つ)。 */
function entryFor(e: ChallengeEffect, state: ChallengeState): ChallengeLogEntry {
  const lg = state.likeGauge;
  return {
    id: e.id,
    kind: e.kind,
    atMs: e.atMs,
    amount: e.amount,
    valueAfter: e.valueAfter,
    ...(e.nickname ? { nickname: e.nickname } : {}),
    ...(e.giftName ? { giftName: e.giftName } : {}),
    ...(e.giftCount ? { giftCount: e.giftCount } : {}),
    ...(e.giftIconUrl ? { giftIconUrl: e.giftIconUrl } : {}),
    ...(e.diamonds != null ? { diamonds: e.diamonds } : {}),
    ...(e.rouletteLabel ? { rouletteLabel: e.rouletteLabel } : {}),
    // like 行の「◯件で+N」は取り込み時の設定で固定する — あとで設定を変えても
    // 過去の行が書き換わらないようにするため。
    ...(e.kind === 'like' && lg ? { likeEvery: lg.every, likeStep: lg.step } : {}),
    ...(e.commentKeyword ? { commentKeyword: e.commentKeyword } : {}),
    // ブーストの倍率・タップ数は effect の焼き込み値をそのまま引き継ぐ
    // (表示時に cfg を読むと、設定変更で過去の行が書き換わる — 上と同じ規約)。
    ...(e.boostMultiplier != null ? { boostMultiplier: e.boostMultiplier } : {}),
    ...(e.boostTapCount != null ? { boostTapCount: e.boostTapCount } : {}),
    // 凍結ドレインの合算件数 → 履歴の「×N」表示(press 畳み込みと同じ概念)。
    ...(e.coalesced != null && e.coalesced > 1 ? { count: e.coalesced } : {}),
  };
}

/** 効果音を割り当てられる演出スロット(設定UIの行順)。 */
export const CHALLENGE_SE_SLOTS: readonly ChallengeSeSlot[] = [
  'press',
  'follow',
  'like',
  'gauge-full',
  'stock-full',
  'comment',
  'gift-t1',
  'gift-t2',
  'gift-t3',
  'gift-t4',
  'helper',
  'roulette',
  'roulette-near',
  'roulette-kick',
  'roulette-hit',
  'boost-start',
  'boost-end',
  'achieved',
];

/**
 * 同梱している効果音の id 一覧(実ファイルとラベルは renderer/lib/se.ts)。
 * validate はこのリストで割り当てを検証する — 未知の id は既定に戻す。
 * 'off' は「このスロットは鳴らさない」。
 */
export const CHALLENGE_SE_SOUND_IDS: readonly string[] = [
  'click-soft',
  'tick',
  'pop',
  'pluck',
  'bong',
  'question',
  'alert',
  'confirm-1',
  'confirm-2',
  'confirm-3',
  'jingle-hit',
  'jingle-steel',
  'jingle-pizzi',
  'jingle-sax',
  'fanfare-8bit',
  'fanfare-8bit-short',
  'like-jam',
  'follow-jam',
  'reel-stop',
  'reel-confirm',
];

/**
 * 演出クリップ(映像)の id 一覧。実ファイルとラベルは renderer/lib/fx.ts。
 * validate はこのリストで割り当てを検証する — 未知の id は 'off' に倒す。
 * 'off' は「この規則ではクリップを出さない」。
 *
 * gift-t1〜t4 は「ダイヤ数の段階で出る汎用クリップ」で、どの canonical にも
 * 一致しなかったギフトのフォールバックにもなる(下の tierClipId)。
 */
export const CHALLENGE_FX_CLIP_IDS: readonly string[] = [
  'universe',
  'universe_plus',
  'white_pegasus',
  'pegasus',
  'fire_phoenix',
  'thunder_falcon',
  'dragon',
  'lion',
  'lion_charge',
  'leon_lion',
  'palace',
  'whale_mirage',
  'whale_sam',
  'seal_whale',
  'tiktok_stars',
  'adams_dream',
  'gift-t1',
  'gift-t2',
  'gift-t3',
  'gift-t4',
  'gift-band1',
  'gift-band2',
  'gift-band3',
  'gift-band4',
  // 全面カットの id は shared/fx-cut.ts が唯一の出所。ここに手で足さないこと
  //(足すと renderer/lib/fx.ts のカタログと静かにズレる)。
  ...FULL_CUT_CLIP_IDS,
];

/**
 * 簡易演出(素材を持たない SVG + CSS の軽量アニメ)の id 一覧。
 * 実体は renderer/monitor/MiniFx.tsx、動きは monitor.css の @keyframes。
 * validate はこのリストで割り当てを検証する — 未知の id は 'off' に倒す。
 *
 * 映像クリップ(CHALLENGE_FX_CLIP_IDS)と違い mp4 を持たないので、
 * 高頻度イベント(ハートミー・いいね・フォロー)でも画面が埋まらない。
 *
 * 'panic' だけは例外で写真素材(assets/fx/mini/panic-man.webp ≒ 97KB)を1枚持つ。
 * mp4 のようなデコード待ちが無く、1枚を使い回すので実質 SVG 勢と同じ軽さ。
 */
export const CHALLENGE_MINI_IDS: readonly string[] = ['hammer', 'stamp', 'shock', 'panic'];

/**
 * 演出スロットごとの簡易演出の既定。スロットは効果音と同じ CHALLENGE_SE_SLOTS。
 * press は既定 off — 連打のたびに DOM アニメを積むと重く、canvas のリング波紋で足りる。
 */
export const DEFAULT_MINI_FX: Record<ChallengeSeSlot, string> = {
  press: 'off',
  // フォローは「妨害」— カウントが戻される絶望を写真カットインで受ける。
  follow: 'panic',
  like: 'shock',
  'gauge-full': 'off',
  'stock-full': 'off',
  // 指定コメント妨害は既定 off — 連投されうるので簡易演出まで出すと画面がうるさい。
  comment: 'off',
  'gift-t1': 'stamp',
  'gift-t2': 'off',
  'gift-t3': 'off',
  'gift-t4': 'off',
  // お助け(ファンスタンプ)は専用スロットになる前は gift-t1 を流用していたので、
  // 既定はその 'stamp' のまま — アップデートで見え方を変えない。
  helper: 'stamp',
  // ルーレットはリール自体が主演出なので簡易演出は既定 off。
  roulette: 'off',
  'roulette-near': 'off',
  'roulette-kick': 'off',
  'roulette-hit': 'off',
  // ブーストはカットイン+カウンタが主演出なので簡易演出は既定 off。
  'boost-start': 'off',
  'boost-end': 'off',
  achieved: 'off',
};

/**
 * 既定のギフト→クリップ割り当て。canonical は resources/gift-aliases.default.json
 * の nameRules と一致させること — ここに無い canonical のギフトは tier クリップになる。
 * 設定画面から自由に差し替え・追加・削除できる。
 */
export const DEFAULT_GIFT_CLIPS: readonly ChallengeGiftClip[] = [
  // ハートミーは1ダイヤの高頻度ギフト。映像は tier1 の汎用のまま、叩かれて増える
  // 手触りを簡易演出のハンマーで足す(映像だけ切りたければ clip を 'off' に)。
  { id: 'clip-heart_me', canonical: 'heart_me', clip: 'gift-t1', mini: 'hammer' },
  { id: 'clip-universe_plus', canonical: 'universe_plus', clip: 'universe_plus', mini: 'off' },
  { id: 'clip-universe', canonical: 'universe', clip: 'universe', mini: 'off' },
  { id: 'clip-tiktok_stars', canonical: 'tiktok_stars', clip: 'tiktok_stars', mini: 'off' },
  { id: 'clip-white_pegasus', canonical: 'white_pegasus', clip: 'white_pegasus', mini: 'off' },
  { id: 'clip-pegasus', canonical: 'pegasus', clip: 'pegasus', mini: 'off' },
  { id: 'clip-fire_phoenix', canonical: 'fire_phoenix', clip: 'fire_phoenix', mini: 'off' },
  { id: 'clip-thunder_falcon', canonical: 'thunder_falcon', clip: 'thunder_falcon', mini: 'off' },
  { id: 'clip-dragon', canonical: 'dragon', clip: 'dragon', mini: 'off' },
  { id: 'clip-lion_charge', canonical: 'lion_charge', clip: 'lion_charge', mini: 'off' },
  { id: 'clip-leon_lion', canonical: 'leon_lion', clip: 'leon_lion', mini: 'off' },
  { id: 'clip-lion', canonical: 'lion', clip: 'lion', mini: 'off' },
  { id: 'clip-palace', canonical: 'palace', clip: 'palace', mini: 'off' },
  { id: 'clip-whale_mirage', canonical: 'whale_mirage', clip: 'whale_mirage', mini: 'off' },
  { id: 'clip-whale_sam', canonical: 'whale_sam', clip: 'whale_sam', mini: 'off' },
  { id: 'clip-seal_whale', canonical: 'seal_whale', clip: 'seal_whale', mini: 'off' },
  { id: 'clip-adams_dream', canonical: 'adams_dream', clip: 'adams_dream', mini: 'off' },
];

export const DEFAULT_SE_SOUNDS: Record<ChallengeSeSlot, string> = {
  press: 'click-soft',
  // 妨害の2スロットだけ専用音。旧既定(question / pop)は選択肢としてカタログに残る
  // — 既存 settings.json の寄せ替えは migrateChallengeSeSounds が一度だけ行う。
  follow: 'follow-jam',
  like: 'like-jam',
  'gauge-full': 'jingle-hit',
  'stock-full': 'jingle-steel',
  // 指定コメント妨害は軽いポップ音(旧いいね妨害の既定 — 妨害の専用音化で空いた)。
  // 連投されうるスロットなので、like-jam のような主張の強い音は既定にしない。
  comment: 'pop',
  'gift-t1': 'confirm-1',
  'gift-t2': 'confirm-2',
  'gift-t3': 'jingle-hit',
  'gift-t4': 'jingle-steel',
  // お助けは専用スロットになる前は gift-t1 を流用していたので、既定はその
  // 'confirm-1' のまま — アップデートで鳴る音を変えない(DEFAULT_MINI_FX と同じ理由)。
  helper: 'confirm-1',
  // 回転開始はチクタク感のある tick。
  roulette: 'tick',
  // 「止まりそう」(当選の1つ手前に着いて溜めに入る瞬間)はスイッチのカチッ。
  'roulette-near': 'reel-stop',
  // キック(フェイク停止から蹴り出される一撃)は低い衝撃音。
  'roulette-kick': 'bong',
  // 確定は専用の確認音。
  'roulette-hit': 'reel-confirm',
  // ブースト開始はフィーバー突入のジングル。着弾(boost-end)は短いファンファーレ。
  'boost-start': 'jingle-steel',
  'boost-end': 'fanfare-8bit-short',
  achieved: 'fanfare-8bit',
};

/**
 * スロットごとの相対音量(%)の既定。100 = 全体音量そのまま(= 個別音量を足す前の挙動)。
 * 既存の settings.json には無いフィールドなので、欠損時もここに倒れる必要がある。
 */
export const DEFAULT_SE_VOLUMES: Record<ChallengeSeSlot, number> = {
  press: 100,
  follow: 100,
  like: 100,
  'gauge-full': 100,
  'stock-full': 100,
  comment: 100,
  'gift-t1': 100,
  'gift-t2': 100,
  'gift-t3': 100,
  'gift-t4': 100,
  helper: 100,
  roulette: 100,
  'roulette-near': 100,
  'roulette-kick': 100,
  'roulette-hit': 100,
  'boost-start': 100,
  'boost-end': 100,
  achieved: 100,
};

/**
 * ギフトルーレットの既定。要件「初期設定はハートミーで起動」に合わせて有効で出荷する。
 * giftId 7934 は実配信で受領確認済み(resources/gift-aliases.default.json 参照)。
 * weight は合計 100 にしてある — 設定UIの確率表示がそのまま % になる。+1000 は 1%。
 */
export const DEFAULT_ROULETTE: ChallengeRouletteConfig = {
  id: 'rl-heart_me',
  // モニターの見出しは「ハートミー ○○がルーレット」。TikTok から届く実名は
  // 英語 'Heart Me' のことがあるので、日本語表記はここで固定する。
  label: 'ハートミー',
  enabled: true,
  giftId: '7934',
  giftName: 'heart me',
  canonical: 'heart_me',
  segments: [
    { amount: 5, weight: 30 },
    { amount: 10, weight: 25 },
    { amount: 20, weight: 20 },
    { amount: 30, weight: 15 },
    { amount: 100, weight: 9 },
    { amount: 1000, weight: 1 },
  ],
  direction: 'add',
};

/**
 * ルーレット群の既定。出荷時はハートミー1件 — 設定画面から何件でも足せる。
 * 複数ある場合は**上から順に評価し、最初に一致した1件だけ**が回る(matchRoulette)。
 */
export const DEFAULT_ROULETTES: readonly ChallengeRouletteConfig[] = [DEFAULT_ROULETTE];

/**
 * ダイヤ帯域カットインの凍結時間の上限(ms)。durationSec の clamp(30秒)より
 * 短くしてある — 凍結はイベント適用を遅らせるので、演出事故(設定ミス等)でも
 * この長さを超えてカウンタが止まらないようにする安全弁。
 */
export const GIFT_FX_FREEZE_MAX_MS = 15_000;
/**
 * クリップ終端フェードと凍結解除の隙間(ms)。モニターの unmount(fxDurationMs)
 * より少し後に worker が解除することで、「数字が動いてからクリップが消える」の
 * 逆順を防ぐ。
 */
export const GIFT_FX_FREEZE_MARGIN_MS = 500;
/**
 * 凍結中の保留オペキューの上限。溢れた分は演出なしで値だけ即時適用する
 * (値の正しさ優先、演出は捨てる — ルーレットキューの溢れ処理と同じ思想)。
 * カットイン反復で凍結が最長 GIFT_FX_FREEZE_MAX_TOTAL_MS まで伸びるため、
 * その間に届くイベントを飲めるだけの深さを持たせてある。
 */
export const GIFT_FX_PENDING_OPS_MAX = 256;

// ── 連打ギフトの演出反復(giftRepeatFx) ──────────────────────────────────────

/** 反復回数の絶対上限。設定値(max)はこれで clamp する。 */
export const GIFT_FX_REPEAT_MAX = 10;
/** 反復間隔の既定(ms)。4秒前後のクリップが重なって「連打」に見える速さ。 */
export const GIFT_FX_REPEAT_MS = 700;
export const GIFT_FX_REPEAT_MIN_MS = 200;
export const GIFT_FX_REPEAT_MAX_MS = 2_000;
/** モニターが同時に抱える反復タイマーの上限(多人数の連打が重なったときの保険)。 */
export const GIFT_FX_REPEAT_TIMERS_MAX = 64;
/**
 * カットインを反復したときの**総**凍結時間の上限(ms)。GIFT_FX_FREEZE_MAX_MS が
 * 「1本あたり」の安全弁なのに対し、こちらは「反復ぶん全部」の安全弁。
 * 超えるときは fxDurationMs ではなく**回数側を削る** — 1本の尺はモニターとの契約。
 */
export const GIFT_FX_FREEZE_MAX_TOTAL_MS = 45_000;

/** モニターの演出クリップ連続再生キューの上限(ROULETTE_QUEUE_MAX と同じ思想)。 */
export const CLIP_QUEUE_MAX = 3;
/**
 * クリップの安全弁(ms)。onEnded が来ない素材・遮蔽ウィンドウで再生中フラグが
 * 固着すると、以後クリップが永久に出なくなる(直したいバグより悪い)。
 */
export const CLIP_ABORT_MS = 8_000;
/**
 * 同時に積める浮上バナーの上限。2 段組みで 1 枚 200〜260px あるので、
 * ステージ(縦 960px)に収まるのはこのあたりが限界 — 増やすと下端が
 * .fx-layer の overflow:hidden で切れる。
 */
export const FLOAT_MAX = 3;
/** 同時に表示する簡易演出の上限(floats/flashes と同じ「積む」層)。 */
export const MINI_MAX = 3;
/** 簡易演出の安全弁(ms)。最長の mini が 880ms(panic)なので余裕を見た値。 */
export const MINI_ABORT_MS = 1_200;
/**
 * shake(画面揺れ)の安全弁(ms)。monitor.css の shake(450ms)/
 * shakestrong(900ms)の最長尺 + 余白。遮蔽で animationend が届かず
 * .monitor-root にクラスが固着すると、「同名クラスの連続 shake は再スタート
 * しない」制限と合わさって以後の揺れが全部消える — タイマーで必ず外す。
 * CSS 側の尺を伸ばしたら test/unit/shake-abort.spec.ts が落ちる契約。
 */
export const SHAKE_ABORT_MS = 1_200;

/**
 * カットインBGMの id 一覧。実ファイルとラベルは renderer/lib/bgm.ts。
 * validate はこのリストで割り当てを検証する — 未知の id は既定に戻す。
 * 効果音(CHALLENGE_SE_SOUND_IDS)とは別カタログ: 長尺曲をジングルの
 * 選択肢(SEスロットの select)に混ぜないため。
 */
export const CHALLENGE_BAND_BGM_IDS: readonly string[] = [
  'bgm-band1',
  'bgm-band2',
  'bgm-band3',
  'bgm-band4',
];

/**
 * ルーレット回転中BGMの id 一覧。実ファイルとラベルは renderer/lib/bgm.ts の
 * ROULETTE_BGM。**BAND_BGM の4曲も選択肢に連結する** — 既存曲を回転用に
 * 使い回せるようにするため(逆方向は無し: 帯域の select に回転曲は出さない)。
 */
export const CHALLENGE_ROULETTE_BGM_IDS: readonly string[] = [
  'bgm-roulette1',
  ...CHALLENGE_BAND_BGM_IDS,
];

/** リール回転ループ音の id 一覧。実ファイルは renderer/lib/bgm.ts の ROULETTE_SPIN_SE。 */
export const CHALLENGE_ROULETTE_SPIN_SE_IDS: readonly string[] = ['spin-reel2', 'spin-reel1'];

/**
 * ルーレット回転サウンドの既定。回転ループ音は**有効(鳴る)で出荷**、
 * 回転中BGMは**既定オフ** — ループ音のジングルだけで場が持つ構成にしてあり、
 * 曲を重ねると停止まわりの3音(near/kick/hit)が埋もれるため。BGM が欲しい人は
 * 設定画面のドロップダウンから選ぶ(選択肢としてはカタログに残っている)。
 * 音量は giftBandFx.bgmVolume の既定と同じ 70。素材間の音圧差は bgm.ts の gain で吸収する。
 */
export const DEFAULT_ROULETTE_SOUND: RouletteSoundConfig = {
  bgm: 'off',
  bgmVolume: 70,
  spinSe: 'spin-reel2',
  spinSeVolume: 70,
};

/**
 * ダイヤの全面カットの既定。バラ(1💎)とローザ(10💎)に専用のフルスクリーン
 * カットインを割り当てる。**帯域(DEFAULT_GIFT_BAND_FX)より先に評価される**ので、
 * この2つのギフトでは band1(びっくりした魚)は再生されない。
 *
 * トリガーはギフト名(部分一致)を本線にする — ライブ経路では NormalizedEvent の
 * canonical が未代入なため(matchRouletteTrigger / matchFanStamp と同じ制約)。
 * バラには保険で canonical 'rose' も入れてある(gift-aliases.default.json の
 * nameRules に実在する)。ローザは名寄せ規則が無いので canonical は空。
 *
 * giftName は**小文字で保存**する規約(matchGiftTrigger が設定値を小文字前提で
 * 比較する)。日本語なので実質そのままだが、英語名を足すときは小文字にすること。
 */
/**
 * カタログ1行 → 既定行への写像。id は clip id の 'cut-' を 'fullcut-' に差し替えたもの
 * (この対応が決まっているので、validateGiftFullCut の
 *  `d.rules.find(x => x.id === r.id)` フォールバックがそのまま効く)。
 */
export function fullCutRuleFor(c: FullCutClipDef): GiftFullCutRule {
  return {
    id: `fullcut-${c.id.slice('cut-'.length)}`,
    label: c.ruleLabel,
    // giftId はカタログ側が持つ。**実データで確認できたギフトだけ**入っていて、
    // 未確認の行は ''(= giftName の推定だけで当てにいく)。
    // ギフト名は配信クライアントの言語で変わり(日本語UIでも英語名で届く)、
    // さらに同名別IDが実在する(Hand Heart = 5660 ハートポーズ / 8343 ハンドハート)ため、
    // 判明しているものは giftId を最優先で使う。
    giftId: c.giftId,
    giftName: c.giftName,
    canonical: c.canonical,
    exactName: c.exactName,
    clip: c.id,
    durationSec: 5,
    enabled: true,
  };
}

/**
 * 全面カットの既定。42行(v0.5.0 のバラ/ローザ + v0.6.0 の40行)。
 * 内訳と各行のトリガーは shared/fx-cut.ts を見ること — **並び順がそのまま
 * 評価順(上から先勝ち)** になる。
 *
 * 全行 enabled: true / durationSec: 5(素材の尺 5.09 秒 > 5 秒なのでループしない)。
 */
export const DEFAULT_GIFT_FULL_CUT: GiftFullCutConfig = {
  enabled: true,
  volume: 70,
  rules: FULL_CUT_CLIPS.map(fullCutRuleFor),
};

/**
 * ダイヤ帯域カットインの既定バンド。要件どおり 1〜50 / 51〜100 / 101〜600 /
 * 601〜1000(6/6/8/10秒)。1000 超は overflow:'top' で band4 を適用する。
 * bgm は帯域が上がるほど盛り上がるパチンコ風BGM(renderer/lib/bgm.ts)。
 */
export const DEFAULT_GIFT_BAND_FX: GiftBandFxConfig = {
  enabled: true,
  bands: [
    { id: 'band1', min: 1, max: 50, clip: 'gift-band1', durationSec: 6, enabled: true, bgm: 'bgm-band1' },
    { id: 'band2', min: 51, max: 100, clip: 'gift-band2', durationSec: 6, enabled: true, bgm: 'bgm-band2' },
    { id: 'band3', min: 101, max: 600, clip: 'gift-band3', durationSec: 8, enabled: true, bgm: 'bgm-band3' },
    { id: 'band4', min: 601, max: 1000, clip: 'gift-band4', durationSec: 10, enabled: true, bgm: 'bgm-band4' },
  ],
  // ハートミー(1ダイヤ・高頻度)は除外。ライブ経路では canonical が乗らないため
  // giftId で除外する(DEFAULT_ROULETTE と同じ ID)。
  excludeGiftIds: ['7934'],
  overflow: 'top',
  bgmEnabled: true,
  bgmVolume: 70,
};

/**
 * お助け機能(ファンスタンプ)の既定。giftId は空 — クリエイター固有の値なので
 * 既定を置きようがない(設定画面は placeholder で例示する)。トリガーが3つとも
 * 空の設定はどのギフトにも一致しない(matchGiftTrigger)ので、enabled: true でも
 * 既存の settings.json の挙動は変わらない。
 *
 * suppressBandFx の既定が true なのは、ファンスタンプが 1 ダイヤ・高頻度で
 * 既定バンド(1〜50💎 → 6秒カットイン+カウンタ凍結)に素で当たるため。
 */
export const DEFAULT_FAN_STAMP: FanStampConfig = {
  enabled: true,
  giftId: '',
  giftName: '',
  canonical: '',
  amountEach: -1,
  suppressBandFx: true,
  flash: true,
};

/** タップブーストの倍率の clamp。1 は「溜めて一括反映」だけ欲しい人向けに許す。 */
export const TAP_BOOST_MULT_MIN = 1;
export const TAP_BOOST_MULT_MAX = 100;
/**
 * タップウィンドウ(秒)の clamp。5〜15 はユーザー要件。前置き演出(起動 5秒+
 * カウントダウン 3秒)と合わせた総凍結は最長 23 秒で、帯域カットインの安全弁
 * GIFT_FX_FREEZE_MAX_MS(15秒)を意図的に超える — あちらは「視聴者がただ待つ
 * 死に時間」の上限だが、ブーストのウィンドウは配信者がタップし続けるゲーム
 * そのものなので同じ天井を課さない(タップは凍結中も数えられている)。
 */
export const TAP_BOOST_DURATION_MIN_SEC = 5;
export const TAP_BOOST_DURATION_MAX_SEC = 15;
/**
 * 起動カットイン(咆哮)クリップの尺(ms)。assets/fx/boost/ の intro-* 素材は
 * すべてこの実尺で揃える(選択制なので、素材ごとに尺が違うとタップ開始が
 * クリップ選択で動いてしまう)。
 */
export const TAP_BOOST_INTRO_MS = 5000;
/**
 * カウントダウン(3・2・1)クリップの尺(ms)。count-* 素材はすべてこの実尺で
 * 揃える — 3・2・1 は映像焼き込みなので、ズレるとタップ開始と「1」が合わない。
 */
export const TAP_BOOST_COUNT_MS = 3000;

/**
 * ブースト演出クリップのカタログ(段ごとの選択肢)。実ファイルは
 * assets/fx/boost/<id>.mp4(renderer/lib/fx.ts の boostClipUrl が解決する)。
 * validate はこのリストで設定値を検証する — 未知の id は既定へ倒す。
 * 素材を増やしたら「ファイル追加 + この行追加」の2点セット。
 */
export interface TapBoostClipDef {
  id: string;
  label: string;
}
export const TAP_BOOST_INTRO_CLIPS: readonly TapBoostClipDef[] = [
  { id: 'intro-panther', label: '黒豹の咆哮(宇宙)' },
];
export const TAP_BOOST_COUNT_CLIPS: readonly TapBoostClipDef[] = [
  // 数字はフレーム精度で焼き込み(ジャスト1.000秒刻み — タップ開始と正確に同期)。
  { id: 'count-321', label: '3・2・1(黒豹・ジャスト1秒刻み)' },
];
export const TAP_BOOST_LOOP_CLIPS: readonly TapBoostClipDef[] = [
  // 既定はコイン・スロットを含まない黒豹版(配信規約への配慮 — ユーザー要件)。
  // intro/count/loop-panther は横 16:9(Dreamina 生成)。loop-pachinko だけ
  // 初代の縦 9:16 素材で、横モニターでは大きくクロップされる。
  { id: 'loop-panther', label: '黒豹コズミックFEVER(15秒・コインなし)' },
  { id: 'loop-pachinko', label: 'ゴールドFEVER(初代・縦動画)' },
];

/**
 * タップブースト(フィーバー)の既定。giftId は空 — クリエイター固有の値なので
 * 既定を置きようがない(fanStamp と同じ判断)。トリガーが3つとも空の設定は
 * どのギフトにも一致しない(matchGiftTrigger)ので、enabled: true で配っても
 * 既存の settings.json の挙動は変わらない。
 */
export const DEFAULT_TAP_BOOST: TapBoostConfig = {
  enabled: true,
  giftId: '',
  giftName: '',
  canonical: '',
  multiplier: 5,
  durationSec: 5,
  introClip: 'intro-panther',
  countClip: 'count-321',
  loopClip: 'loop-panther',
  flash: true,
};

/**
 * 連打ギフトの演出反復の既定。enabled: true — これは新機能ではなく「同じ人が同じ
 * ギフトを連打しても演出が1回しか出ない」の修正なので、オプトインにはしない。
 * bandEnabled / rouletteEnabled も既定 true(利用者の明示選択)。カットインは
 * 6秒×5=30秒カウンタが止まるので、重ければ設定画面で回数を下げるか外す。
 */
export const DEFAULT_GIFT_REPEAT_FX: GiftRepeatFxConfig = {
  enabled: true,
  max: 5,
  intervalMs: GIFT_FX_REPEAT_MS,
  bandEnabled: true,
  rouletteEnabled: true,
};

export const DEFAULT_CHALLENGE: ChallengeConfig = {
  enabled: false,
  title: '0まで寝ない',
  initialValue: 1000,
  pressStep: 1,
  followStep: 10,
  // いいね妨害は既定で無効(likeEvery: 0)— like は高頻度なので明示オプトイン。
  likeEvery: 0,
  likeStep: 1,
  // ストックも既定で無効(likeStockCount: 0)— ゲージ満タンの従属機能なので同じくオプトイン。
  likeStockCount: 0,
  likeStockStep: 25,
  // 指定コメント妨害は既定で規則なし(= オフ)— キーワードは企画ごとに違うので
  // 既定を置きようがない(fanStamp の giftId と同じ判断)。
  commentRules: [],
  giftRules: [],
  // 既定はギフト=妨害: 1ダイヤにつき +1(設定画面で応援方向へ変更できる)。
  giftDefault: { mode: 'perDiamond', amount: 1 },
  roulettes: structuredClone(DEFAULT_ROULETTES) as ChallengeRouletteConfig[],
  rouletteSound: { ...DEFAULT_ROULETTE_SOUND },
  flashMinDiamonds: 100,
  hotkey: 'F9',
  monitorDisplayId: null,
  monitorWindowed: false,
  // 「何時起き」は既定でオフ(全員がやる企画ではない)。時刻はライブ画面で入れる。
  wakeEnabled: false,
  wakeTime: null,
  lowThreshold: 10,
  seEnabled: true,
  seVolume: 70,
  seSounds: { ...DEFAULT_SE_SOUNDS },
  seVolumes: { ...DEFAULT_SE_VOLUMES },
  fxClipsEnabled: true,
  giftClips: DEFAULT_GIFT_CLIPS.map((c) => ({ ...c })),
  miniFxEnabled: true,
  miniFx: { ...DEFAULT_MINI_FX },
  giftFullCut: structuredClone(DEFAULT_GIFT_FULL_CUT),
  giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX),
  giftRepeatFx: structuredClone(DEFAULT_GIFT_REPEAT_FX),
  fanStamp: structuredClone(DEFAULT_FAN_STAMP),
  tapBoost: structuredClone(DEFAULT_TAP_BOOST),
};

/**
 * playSe に渡す実効音量(0-100)。全体音量 × スロットごとの相対音量(%)。
 * slotPct が欠損なら 100(= 全体音量そのまま)として扱う — モニター窓は設定を
 * 30秒ポーリングで拾うので、個別音量を持たない古い設定が渡ってくることがある。
 */
export function effectiveSeVolume(master: number, slotPct: number | undefined): number {
  const m = Math.min(100, Math.max(0, master));
  const p = Math.min(100, Math.max(0, slotPct ?? 100));
  return (m * p) / 100;
}

/** ギフト演出の段階。1=小さなお礼〜4=全画面のお祭り。 */
export function tierForDiamonds(diamonds: number): 1 | 2 | 3 | 4 {
  if (diamonds >= 5000) return 4;
  if (diamonds >= 1000) return 3;
  if (diamonds >= 100) return 2;
  return 1;
}

/** tier に対応する汎用クリップ id。canonical の割り当てが無いギフトのフォールバック。 */
export function tierClipId(tier: 1 | 2 | 3 | 4): string {
  return `gift-t${tier}`;
}

/**
 * ギフト → 演出クリップ id の写像。canonical 一致を上から探し、無ければ tier
 * クリップへ落ちる。戻り null は「クリップを出さない」('off' 指定 or 無効時)。
 *
 * matchGiftRule と違い canonical しか見ない — 増減量の規則(giftRules)と
 * 見た目の規則(giftClips)は別物として設定できるようにするため。
 */
export function matchGiftClip(
  cfg: ChallengeConfig,
  g: { canonical?: string; diamonds: number }
): string | null {
  if (!cfg.fxClipsEnabled) return null;
  if (g.canonical) {
    for (const c of cfg.giftClips) {
      if (c.canonical !== g.canonical) continue;
      return c.clip === 'off' ? null : c.clip;
    }
  }
  return tierClipId(tierForDiamonds(g.diamonds));
}

/**
 * ギフト → 簡易演出 id の写像。matchGiftClip と対だが、フォールバック先が固定 id では
 * なく miniFx の tier スロット — スロット側を変えれば未割り当てのギフト全体に効く。
 * 戻り null は「簡易演出を出さない」。
 */
export function matchGiftMini(
  cfg: ChallengeConfig,
  g: { canonical?: string; diamonds: number }
): string | null {
  if (!cfg.miniFxEnabled) return null;
  if (g.canonical) {
    for (const c of cfg.giftClips) {
      if (c.canonical !== g.canonical) continue;
      return c.mini === 'off' ? null : c.mini;
    }
  }
  return miniForSlot(cfg, `gift-t${tierForDiamonds(g.diamonds)}` as ChallengeSeSlot);
}

/**
 * ギフト → 全面カットの写像。**上から順に評価し、最初に一致した1行だけ**を返す
 * (giftRules / roulettes と同じ先勝ち)。戻り null は「全面カットは出さない」=
 * 従来のダイヤ帯域カットイン(matchGiftBand)へ落ちる。
 *
 * **matchGiftBand より先に呼ぶこと**が唯一の優先度の担保 — 全面カットが一致したら
 * 帯域は評価しない(worker/challenge.ts の giftOp)。帯域と違いダイヤ数を見ないので、
 * 1ダイヤのギフトでも高額ギフトでも同じカットインが出る。
 *
 * fxClipsEnabled(演出クリップ全体のスイッチ)を尊重するのは matchGiftBand と同じ。
 */
export function matchGiftFullCut(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): GiftFullCutRule | null {
  const fc = cfg.giftFullCut;
  if (!fc.enabled || !cfg.fxClipsEnabled) return null;
  for (const r of fc.rules) {
    if (!r.enabled || r.clip === 'off') continue;
    if (matchGiftTrigger(r, g)) return r;
  }
  return null;
}

/**
 * ギフト → ダイヤ帯域カットインの写像。一致した帯域を返す(クリップ 'off' や
 * 除外・無効は null)。giftClips(canonical別クリップ)より優先して評価する。
 *
 * 除外は giftId が本線 — ライブ経路では NormalizedEvent.canonical が未代入
 * (matchRouletteTrigger と同じ制約)。canonical 'heart_me' は保険で常に除外。
 * 帯域は上から順に評価し、どの帯域にも入らない diamonds が最上位バンドの max を
 * 超えていたら overflow に従う('top' = 最上位の有効バンドを適用)。
 */
export function matchGiftBand(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; diamonds: number }
): GiftFxBand | null {
  const bf = cfg.giftBandFx;
  if (!bf.enabled || !cfg.fxClipsEnabled) return null;
  if (g.diamonds <= 0) return null;
  if (bf.excludeGiftIds.includes(g.giftId)) return null;
  if (g.canonical != null && g.canonical.toLowerCase() === 'heart_me') return null;
  const usable = (b: GiftFxBand): boolean => b.enabled && b.clip !== 'off';
  for (const b of bf.bands) {
    if (usable(b) && g.diamonds >= b.min && g.diamonds <= b.max) return b;
  }
  if (bf.overflow === 'top') {
    // 「最上位」= max が最大の有効バンド。並び替えに依存しない。
    let top: GiftFxBand | null = null;
    for (const b of bf.bands) {
      if (usable(b) && (top === null || b.max > top.max)) top = b;
    }
    if (top && g.diamonds > top.max) return top;
  }
  return null;
}

// ── 連打ギフトの演出反復 ─────────────────────────────────────────────────────
//
// 規約: **反復するのは見た目だけ。値・統計・ランキング・履歴ログは1件のまま。**
// worker が回数を決めて effect に焼き込み(fxRepeat/fxRepeatIntervalMs)、モニターは
// それを読むだけ — cfg は30秒ポーリングで古くなりうるので再判定させない
// (fxBandClip / rouletteSegments と同じ「effect 1件で自己完結」の流儀)。

/**
 * ギフト1件に対して演出を何回撃つか。worker 側の唯一の判断点。
 *
 * banded(カットイン一致)のときは間隔ではなく尺ぶんの直列再生になるため、
 * 総凍結が GIFT_FX_FREEZE_MAX_TOTAL_MS を超えないよう**回数側**を削る
 * (fxDurationMs は削らない — 1本の尺はモニターとの契約)。
 */
export function giftFxRepeat(
  cfg: ChallengeConfig,
  repeatCount: number,
  opts: { banded: boolean; fxDurationMs: number }
): number {
  const rf = cfg.giftRepeatFx;
  if (!rf.enabled) return 1;
  const cap = Math.min(GIFT_FX_REPEAT_MAX, Math.max(1, Math.round(rf.max)));
  let rep = Math.min(cap, Math.max(1, Math.round(repeatCount)));
  if (rep <= 1) return 1;
  if (opts.banded) {
    if (!rf.bandEnabled || opts.fxDurationMs <= 0) return 1;
    rep = Math.min(rep, Math.max(1, Math.floor(GIFT_FX_FREEZE_MAX_TOTAL_MS / opts.fxDurationMs)));
  }
  return rep;
}

/**
 * 連打ギフトでルーレットを何回まわすか。**これだけは値の増減も回数ぶんになる** —
 * ルーレットは抽選なので、反復するには出目を N 回引くしかないため。
 * モニターのキューに乗り切る数で頭打ちにする(溢れると「値だけ動いてリールが
 * 出ない」= 数字だけ動く最悪の見え方になる)。
 */
export function giftFxRouletteSpins(cfg: ChallengeConfig, repeatCount: number): number {
  const rf = cfg.giftRepeatFx;
  if (!rf.enabled || !rf.rouletteEnabled) return 1;
  const cap = Math.min(GIFT_FX_REPEAT_MAX, Math.max(1, Math.round(rf.max)));
  const rep = Math.min(cap, Math.max(1, Math.round(repeatCount)));
  return Math.min(rep, ROULETTE_QUEUE_MAX + 1);
}

/**
 * effect から反復の再生パラメータを取り出す。renderer 側の唯一の clamp 点。
 * **MonitorView と useChallengeSe の両方がこれを呼ぶこと** — 音と映像の回数が
 * ずれない担保はこの関数を共有していることだけ。
 */
export function giftFxShots(e: ChallengeEffect): { rep: number; gap: number } {
  const rep = Math.min(GIFT_FX_REPEAT_MAX, Math.max(1, Math.round(e.fxRepeat ?? 1)));
  const raw = e.fxRepeatIntervalMs ?? GIFT_FX_REPEAT_MS;
  const gap = Math.min(GIFT_FX_REPEAT_MAX_MS, Math.max(GIFT_FX_REPEAT_MIN_MS, Math.round(raw)));
  return { rep, gap };
}

/** スロット(press/follow/like/achieved 等)の簡易演出。off/無効なら null。 */
export function miniForSlot(cfg: ChallengeConfig, slot: ChallengeSeSlot): string | null {
  if (!cfg.miniFxEnabled) return null;
  const id = cfg.miniFx[slot];
  return id && id !== 'off' ? id : null;
}

// ── 演出 watermark ───────────────────────────────────────────────────────────

/** 取りこぼしの古い演出をスキップする鮮度ゲート。復帰直後の演出ストーム防止。 */
export const EFFECT_FRESH_MS = 5000;
/**
 * テスト再生(effect.test)だけの緩い鮮度ゲート。設定画面の「▶ モニター」は
 * モニターウィンドウの生成+マウントを待ってから再生されるため、5秒では
 * ウィンドウ生成が遅い環境(別ディスプレイのフルスクリーン化等)で無言で落ちる。
 */
export const TEST_EFFECT_FRESH_MS = 15_000;

/**
 * 演出1件の鮮度判定。freshChallengeEffects の内部ゲートと、MonitorView の
 * 「未再生カットインに据え置きを譲るか」(yieldToCutin)が**同じ規約**を共有する
 * ための唯一の実装 — 別々に持つと test 演出(15秒ゲート)だけ「譲らないのに
 * 再生はする」ズレが生まれ、飛行中の着弾チェーンが打ち切られる。
 */
export function isChallengeEffectFresh(e: ChallengeEffect, nowMs: number): boolean {
  return nowMs - e.atMs <= (e.test === true ? TEST_EFFECT_FRESH_MS : EFFECT_FRESH_MS);
}

/**
 * recentEffects の watermark 進行を1箇所に集約する(MonitorView の視覚再生と
 * useChallengeSe の効果音が同じ規約を共有する唯一の担保)。
 *
 * - lastPlayed === null(マウント直後)は全件を再生済みに倒す — リロード/再接続の
 *   たびに過去演出が一斉再生される事故を防ぐ。ただし mountPlaysTest のときは
 *   test 演出(▶ 実演再生)だけ鮮度ゲート内なら再生対象に含める — モニターの
 *   マウントが実演の push より遅れると、最初のスナップショットに含まれた実演が
 *   無言で「再生済み」扱いになり consumed される(「▶ を押しても何も起きない、
 *   2回目は出る」の原因)。
 * - lastPlayed > maxId は worker 再起動で id が振り直された合図。0 に倒して追従する。
 * - 鮮度ゲートを過ぎた演出は無言でスキップ(watermark は進める)。
 *
 * 戻り値: next = 新しい watermark、play = 再生すべき演出(id 昇順)。
 */
export function freshChallengeEffects(
  effects: readonly ChallengeEffect[],
  lastPlayed: number | null,
  nowMs: number,
  opts?: { mountPlaysTest?: boolean }
): { next: number; play: ChallengeEffect[] } {
  const maxId = effects.reduce((m, e) => Math.max(m, e.id), 0);
  const freshEnough = (e: ChallengeEffect): boolean => isChallengeEffectFresh(e, nowMs);
  if (lastPlayed === null) {
    const play = opts?.mountPlaysTest
      ? effects.filter((e) => e.test === true && freshEnough(e)).sort((a, b) => a.id - b.id)
      : [];
    return { next: maxId, play };
  }
  const from = lastPlayed > maxId ? 0 : lastPlayed;
  const play = effects
    .filter((e) => e.id > from && freshEnough(e))
    .sort((a, b) => a.id - b.id);
  return { next: Math.max(from, maxId), play };
}

/**
 * 旧既定のまま保存されている音の割り当てを、新しい既定へ一度だけ寄せる。
 * settingsVersion(dto.ts の SETTINGS_VERSION)が各世代より古い settings.json にだけ効く。
 *
 * 「旧既定と同じ値のときだけ」書き換えるのが要点 — 自分で旧既定以外を選んでいる人の
 * 設定は触らない。validateChallengeConfig の中に入れてはいけない(あちらは UI からの
 * cfg.set も通るので、後から旧既定を選び直した瞬間に上書きし返す)。
 *
 * 新しい世代を足すときは**段を積む**こと(if で早期 return しない) — v0 の
 * settings.json は v1 と v2 の両方を順に通る必要がある。
 */
/**
 * 全面カットの既定行が増えた世代を、保存済み settings.json へ一度だけ配る。
 * **追加しかしない** — 既存行の順序も内容も enabled も触らず、まだ持っていない id を
 * 末尾へ足すだけ(先勝ちなので、ユーザーが自分で並べた優先度を壊さない)。
 *
 * ⚠ validateGiftFullCut / validateChallengeConfig の中に入れてはいけない。あちらは
 *   UI の cfg.set も通るので、ユーザーが削除した行がその場で復活する。世代は
 *   sanitize の前に raw から読む(main/boot-settings.ts の `from`)。
 * ⚠ 配るのは FULL_CUT_CLIPS_V3 に固定する。DEFAULT_GIFT_FULL_CUT.rules を参照すると、
 *   次の世代で既定が増えたとき v3 の段が新しい行まで配ってしまい二重適用になる。
 * ⚠ v3 より前に存在しなかった id しか足さないので、「消したのに復活する」は
 *   構造的に起きない(消せるようになったのが v3 以降だから)。
 */
export function migrateChallengeGiftFullCut(cfg: ChallengeConfig, fromVersion: number): ChallengeConfig {
  if (fromVersion >= 3) return cfg;
  const have = new Set(cfg.giftFullCut.rules.map((r) => r.id));
  const add = FULL_CUT_CLIPS_V3.map(fullCutRuleFor).filter((r) => !have.has(r.id));
  if (add.length === 0) return cfg;
  return {
    ...cfg,
    giftFullCut: { ...cfg.giftFullCut, rules: [...cfg.giftFullCut.rules, ...add] },
  };
}

/**
 * 世代移行の入口。**段は fromVersion の小さい順に積む**(世代0の設定は v1→v2→v3 を
 * 全部通る)。boot-settings.ts の loadSettings からだけ呼ぶこと。
 */
export function migrateChallengeConfig(cfg: ChallengeConfig, fromVersion: number): ChallengeConfig {
  return migrateChallengeGiftFullCut(migrateChallengeSeSounds(cfg, fromVersion), fromVersion);
}

export function migrateChallengeSeSounds(cfg: ChallengeConfig, fromVersion: number): ChallengeConfig {
  let out = cfg;

  // v1: 妨害スロットの効果音を専用音へ。
  if (fromVersion < 1) {
    const s = out.seSounds;
    if (s.like === 'pop' || s.follow === 'question') {
      out = {
        ...out,
        seSounds: {
          ...s,
          like: s.like === 'pop' ? 'like-jam' : s.like,
          follow: s.follow === 'question' ? 'follow-jam' : s.follow,
        },
      };
    }
  }

  // v2: ルーレットの回転サウンド刷新。回転中BGMを既定オフ・回転ループ音を
  // ジングルへ・確定音を専用の確認音へ。'roulette-near' は旧ファイルにキー自体が
  // 無く validateSeSounds が既定で埋めるので、ここで触る必要はない。
  if (fromVersion < 2) {
    const s = out.seSounds;
    if (s['roulette-hit'] === 'jingle-hit') {
      out = { ...out, seSounds: { ...s, 'roulette-hit': 'reel-confirm' } };
    }
    const r = out.rouletteSound;
    if (r.bgm === 'bgm-roulette1' || r.spinSe === 'spin-reel1') {
      out = {
        ...out,
        rouletteSound: {
          ...r,
          bgm: r.bgm === 'bgm-roulette1' ? 'off' : r.bgm,
          spinSe: r.spinSe === 'spin-reel1' ? 'spin-reel2' : r.spinSe,
        },
      };
    }
  }

  return out;
}

/**
 * 壊れた settings.json でもアプリを止めない — validateScoringConfig と同じく
 * throw せずサニタイズする。数値は clamp、不正な規則は捨てる。
 */
export function validateChallengeConfig(raw: unknown): ChallengeConfig {
  const c = raw as Partial<ChallengeConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(DEFAULT_CHALLENGE);
  const d = DEFAULT_CHALLENGE;
  const num = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  const str = (v: unknown, fb: string): string => (typeof v === 'string' ? v : fb);

  const giftRules: ChallengeGiftRule[] = Array.isArray(c.giftRules)
    ? c.giftRules.filter(isValidRule).map((r) => ({
        id: r.id,
        ...(typeof r.canonical === 'string' && r.canonical !== '' ? { canonical: r.canonical } : {}),
        ...(typeof r.giftId === 'string' && r.giftId !== '' ? { giftId: r.giftId } : {}),
        ...(typeof r.minDiamonds === 'number' && Number.isFinite(r.minDiamonds)
          ? { minDiamonds: Math.max(0, Math.round(r.minDiamonds)) }
          : {}),
        mode: r.mode,
        amount: Math.round(r.amount),
        ...(r.flash === true ? { flash: true } : {}),
      }))
    : [];

  const gd = c.giftDefault;
  const giftDefault =
    gd && typeof gd === 'object' && (gd.mode === 'fixed' || gd.mode === 'perDiamond') &&
    typeof gd.amount === 'number' && Number.isFinite(gd.amount)
      ? { mode: gd.mode, amount: Math.round(gd.amount) }
      : gd === null
        ? null
        : d.giftDefault;

  return {
    enabled: c.enabled === true,
    title: str(c.title, d.title),
    initialValue: num(c.initialValue, d.initialValue, 1, 9_999_999),
    pressStep: num(c.pressStep, d.pressStep, 1, 999_999),
    followStep: num(c.followStep, d.followStep, 0, 999_999),
    likeEvery: num(c.likeEvery, d.likeEvery, 0, 999_999),
    likeStep: num(c.likeStep, d.likeStep, 0, 999_999),
    // count の上限 99 はドットUIの現実的上限(実用は 3〜10 想定)。
    likeStockCount: num(c.likeStockCount, d.likeStockCount, 0, 99),
    likeStockStep: num(c.likeStockStep, d.likeStockStep, 0, 999_999),
    commentRules: validateCommentRules(c.commentRules),
    giftRules,
    giftDefault,
    roulettes: validateRoulettes(raw),
    rouletteSound: validateRouletteSound(c.rouletteSound),
    flashMinDiamonds:
      c.flashMinDiamonds === null ? null : num(c.flashMinDiamonds, d.flashMinDiamonds ?? 100, 1, 9_999_999),
    hotkey: str(c.hotkey, d.hotkey),
    monitorDisplayId:
      typeof c.monitorDisplayId === 'number' && Number.isFinite(c.monitorDisplayId)
        ? c.monitorDisplayId
        : null,
    monitorWindowed: c.monitorWindowed === true,
    wakeEnabled: c.wakeEnabled === true,
    // 書式が崩れた値は null(未設定)へ倒す — 表示側で NaN 時刻を作らせない。
    wakeTime: typeof c.wakeTime === 'string' && WAKE_TIME_RE.test(c.wakeTime) ? c.wakeTime : null,
    lowThreshold: num(c.lowThreshold, d.lowThreshold, 0, 9_999_999),
    // 既定 true なので `!== false`(enabled/monitorWindowed の `=== true` とは逆向き)。
    seEnabled: c.seEnabled !== false,
    seVolume: num(c.seVolume, d.seVolume, 0, 100),
    seSounds: validateSeSounds(c.seSounds),
    seVolumes: validateSeVolumes(c.seVolumes),
    fxClipsEnabled: c.fxClipsEnabled !== false,
    giftClips: validateGiftClips(c.giftClips),
    miniFxEnabled: c.miniFxEnabled !== false,
    miniFx: validateMiniFx(c.miniFx),
    giftFullCut: validateGiftFullCut(c.giftFullCut),
    giftBandFx: validateGiftBandFx(c.giftBandFx),
    giftRepeatFx: validateGiftRepeatFx(c.giftRepeatFx),
    fanStamp: validateFanStamp(c.fanStamp),
    tapBoost: validateTapBoost(c.tapBoost),
  };
}

/**
 * 連打ギフトの演出反復設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(giftRepeatFx キー無し)は既定へ倒す。
 * 真偽値の向きは既定に合わせること — 既定 true は `!== false`、既定 false は
 * `=== true`。逆にすると既定が反転する(この関数群で一番踏みやすい罠)。
 */
function validateGiftRepeatFx(raw: unknown): GiftRepeatFxConfig {
  const d = DEFAULT_GIFT_REPEAT_FX;
  const c = raw as Partial<GiftRepeatFxConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  const n = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  return {
    enabled: c.enabled !== false,
    max: n(c.max, d.max, 1, GIFT_FX_REPEAT_MAX),
    intervalMs: n(c.intervalMs, d.intervalMs, GIFT_FX_REPEAT_MIN_MS, GIFT_FX_REPEAT_MAX_MS),
    bandEnabled: c.bandEnabled !== false,
    rouletteEnabled: c.rouletteEnabled !== false,
  };
}

/**
 * ダイヤ帯域カットイン設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(giftBandFx キー無し)は既定(有効・4バンド)に倒す。
 * min>max の行は捨てる。未知のクリップ id は同じ id の既定バンドのクリップ、
 * それも無ければ 'off' に倒す。
 */
/**
 * ルーレット回転サウンドの検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(rouletteSound キー無し)は既定へ倒す(回転音は鳴る・BGM はオフ)。
 * 未知の id は**既定の id** へ — 回転ループ音は既定が実在の音なので鳴り続け、
 * BGM は既定が 'off' なので無音になる(どちらも既定の挙動に一致する)。
 */
function validateRouletteSound(raw: unknown): RouletteSoundConfig {
  const d = DEFAULT_ROULETTE_SOUND;
  const c = raw as Partial<RouletteSoundConfig> | null | undefined;
  if (!c || typeof c !== 'object') return { ...d };
  const vol = (v: unknown, fb: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : fb;
  const id = (v: unknown, list: readonly string[], fb: string): string =>
    typeof v === 'string' && (v === 'off' || list.includes(v)) ? v : fb;
  return {
    bgm: id(c.bgm, CHALLENGE_ROULETTE_BGM_IDS, d.bgm),
    bgmVolume: vol(c.bgmVolume, d.bgmVolume),
    spinSe: id(c.spinSe, CHALLENGE_ROULETTE_SPIN_SE_IDS, d.spinSe),
    spinSeVolume: vol(c.spinSeVolume, d.spinSeVolume),
  };
}

/**
 * 全面カット設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(giftFullCut キー無し)は既定(有効・バラ/ローザの2行)へ倒す。
 *
 * giftName / canonical は**小文字化して保存**する — matchGiftTrigger が設定値を
 * 小文字前提で比較するため(validateFanStamp / validateRoulettes と同じ規約)。
 * label だけは小文字化しない(日本語の表示名を原文のまま出す)。
 * 未知のクリップ id は同じ id の既定行のクリップ、それも無ければ 'off' に倒す。
 */
function validateGiftFullCut(raw: unknown): GiftFullCutConfig {
  const d = DEFAULT_GIFT_FULL_CUT;
  const c = raw as Partial<GiftFullCutConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  const rules: GiftFullCutRule[] = [];
  if (Array.isArray(c.rules)) {
    for (const r of c.rules as Array<Partial<GiftFullCutRule>>) {
      if (typeof r.id !== 'string' || r.id === '') continue;
      const fallback = d.rules.find((x) => x.id === r.id);
      const clip =
        typeof r.clip === 'string' && (r.clip === 'off' || CHALLENGE_FX_CLIP_IDS.includes(r.clip))
          ? r.clip
          : (fallback?.clip ?? 'off');
      const durationSec =
        typeof r.durationSec === 'number' && Number.isFinite(r.durationSec)
          ? Math.min(30, Math.max(1, Math.round(r.durationSec)))
          : (fallback?.durationSec ?? 5);
      const low = (v: unknown, fb: string): string =>
        typeof v === 'string' ? v.trim().toLowerCase() : fb;
      rules.push({
        id: r.id,
        label: typeof r.label === 'string' ? r.label.trim() : (fallback?.label ?? ''),
        giftId: typeof r.giftId === 'string' ? r.giftId.trim() : (fallback?.giftId ?? ''),
        giftName: low(r.giftName, fallback?.giftName ?? ''),
        canonical: low(r.canonical, fallback?.canonical ?? ''),
        // 既定 false。ただしこの関数の流儀(同じ id の既定行へ倒す)に合わせ、
        // **キー自体が無い**旧 settings.json は既定行の値を継ぐ — 素の `=== true` に
        // すると、出荷時に完全一致で配った行が旧設定のユーザーだけ部分一致に
        // 化けて上位ギフトを奪う。明示的な false(チェックを外した意思)は
        // typeof ガードでそのまま尊重される。
        exactName:
          typeof r.exactName === 'boolean' ? r.exactName : (fallback?.exactName ?? false),
        clip,
        durationSec,
        enabled: r.enabled !== false,
      });
    }
  } else {
    rules.push(...structuredClone(d.rules));
  }
  return {
    enabled: c.enabled !== false,
    volume:
      typeof c.volume === 'number' && Number.isFinite(c.volume)
        ? Math.min(100, Math.max(0, Math.round(c.volume)))
        : d.volume,
    rules,
  };
}

function validateGiftBandFx(raw: unknown): GiftBandFxConfig {
  const d = DEFAULT_GIFT_BAND_FX;
  const c = raw as Partial<GiftBandFxConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);

  const bands: GiftFxBand[] = [];
  if (Array.isArray(c.bands)) {
    for (const b of c.bands as Array<Partial<GiftFxBand>>) {
      if (!b || typeof b !== 'object' || typeof b.id !== 'string') continue;
      if (typeof b.min !== 'number' || !Number.isFinite(b.min)) continue;
      if (typeof b.max !== 'number' || !Number.isFinite(b.max)) continue;
      const min = Math.min(9_999_999, Math.max(1, Math.round(b.min)));
      const max = Math.min(9_999_999, Math.max(1, Math.round(b.max)));
      if (min > max) continue;
      const fallback = d.bands.find((x) => x.id === b.id)?.clip ?? 'off';
      const clip =
        typeof b.clip === 'string' && (b.clip === 'off' || CHALLENGE_FX_CLIP_IDS.includes(b.clip))
          ? b.clip
          : fallback;
      const durationSec =
        typeof b.durationSec === 'number' && Number.isFinite(b.durationSec)
          ? Math.min(30, Math.max(1, Math.round(b.durationSec)))
          : (d.bands.find((x) => x.id === b.id)?.durationSec ?? 6);
      // bgm はあとから足したフィールド。前バージョンの settings.json には無いので
      // 欠損・未知 id は同じ id の既定バンドの bgm(なければ 'off')に倒す。
      const bgmFallback = d.bands.find((x) => x.id === b.id)?.bgm ?? 'off';
      const bgm =
        typeof b.bgm === 'string' && (b.bgm === 'off' || CHALLENGE_BAND_BGM_IDS.includes(b.bgm))
          ? b.bgm
          : bgmFallback;
      bands.push({ id: b.id, min, max, clip, durationSec, enabled: b.enabled !== false, bgm });
    }
  } else {
    bands.push(...structuredClone(d.bands));
  }

  const excludeGiftIds = Array.isArray(c.excludeGiftIds)
    ? c.excludeGiftIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
    : [...d.excludeGiftIds];

  return {
    // 既定 true なので `!== false`(fxClipsEnabled と同じ向き)。
    enabled: c.enabled !== false,
    bands,
    excludeGiftIds,
    overflow: c.overflow === 'off' ? 'off' : 'top',
    bgmEnabled: c.bgmEnabled !== false,
    bgmVolume:
      typeof c.bgmVolume === 'number' && Number.isFinite(c.bgmVolume)
        ? Math.min(100, Math.max(0, Math.round(c.bgmVolume)))
        : d.bgmVolume,
  };
}

/**
 * お助け機能(ファンスタンプ)の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(fanStamp キー無し)は既定へ。giftName/canonical は小文字化して
 * 保存する — マッチ側(matchGiftTrigger)が設定値を小文字前提で比較するため
 * (validateRoulette と同じ規約)。
 */
function validateFanStamp(raw: unknown): FanStampConfig {
  const d = DEFAULT_FAN_STAMP;
  const c = raw as Partial<FanStampConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  return {
    // 既定 true なので `!== false`(seEnabled / validateRoulette と同じ向き)。
    // giftId/giftName/canonical が3つとも空なら matchGiftTrigger が構造的に
    // 一致しないので、enabled のまま既定を配っても既存の挙動は変わらない。
    enabled: c.enabled !== false,
    giftId: typeof c.giftId === 'string' ? c.giftId.trim() : d.giftId,
    giftName: typeof c.giftName === 'string' ? c.giftName.trim().toLowerCase() : d.giftName,
    canonical: typeof c.canonical === 'string' ? c.canonical.trim().toLowerCase() : d.canonical,
    // 負数を許すので Math.max(0, ...) はしない(応援方向が本命)。
    amountEach:
      typeof c.amountEach === 'number' && Number.isFinite(c.amountEach)
        ? Math.min(999_999, Math.max(-999_999, Math.round(c.amountEach)))
        : d.amountEach,
    suppressBandFx: c.suppressBandFx !== false,
    flash: c.flash !== false,
  };
}

/**
 * タップブーストの検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(tapBoost キー無し)は既定へ。giftName/canonical の小文字化と
 * 真偽値の向き(既定 true は `!== false`)は validateFanStamp と同じ規約。
 */
function validateTapBoost(raw: unknown): TapBoostConfig {
  const d = DEFAULT_TAP_BOOST;
  const c = raw as Partial<TapBoostConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  const n = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  // 未知の id は既定へ('off' は「この段を出さない」の明示選択として通す)。
  const clip = (v: unknown, list: readonly TapBoostClipDef[], fb: string): string =>
    typeof v === 'string' && (v === 'off' || list.some((x) => x.id === v)) ? v : fb;
  return {
    enabled: c.enabled !== false,
    giftId: typeof c.giftId === 'string' ? c.giftId.trim() : d.giftId,
    giftName: typeof c.giftName === 'string' ? c.giftName.trim().toLowerCase() : d.giftName,
    canonical: typeof c.canonical === 'string' ? c.canonical.trim().toLowerCase() : d.canonical,
    multiplier: n(c.multiplier, d.multiplier, TAP_BOOST_MULT_MIN, TAP_BOOST_MULT_MAX),
    durationSec: n(c.durationSec, d.durationSec, TAP_BOOST_DURATION_MIN_SEC, TAP_BOOST_DURATION_MAX_SEC),
    introClip: clip(c.introClip, TAP_BOOST_INTRO_CLIPS, d.introClip),
    countClip: clip(c.countClip, TAP_BOOST_COUNT_CLIPS, d.countClip),
    loopClip: clip(c.loopClip, TAP_BOOST_LOOP_CLIPS, d.loopClip),
    flash: c.flash !== false,
  };
}

/** ルーレット盤面の上限行数。UI とリール演出が破綻しない範囲で余裕を持たせる。 */
export const ROULETTE_SEGMENTS_MAX = 12;

/** 登録できるルーレットの上限件数。設定UIと settings.json の現実的な上限。 */
export const ROULETTES_MAX = 8;

/** ルーレット表示名の最大長。モニターの見出し1行に収まる範囲。 */
export const ROULETTE_LABEL_MAX = 24;

/**
 * ルーレット群の検証。既存流儀どおり throw せずサニタイズする。
 *
 * 移行: 旧 settings.json は単一の `roulette` キーを持つ。`roulettes` が無く
 * `roulette` があればそれを1件の配列へ包んで引き継ぐ — ユーザーが調整した盤面を
 * 「既定に戻す」で踏み潰さないため。どちらも無ければ既定(ハートミー1件)。
 *
 * 明示的な空配列は空のまま通す(validateGiftClips と同じ判断)— 全部消した
 * ユーザーの意思を尊重する。ルーレット0件は「どのギフトでも回らない」で破綻しない。
 */
function validateRoulettes(raw: unknown): ChallengeRouletteConfig[] {
  const c = raw as { roulettes?: unknown; roulette?: unknown } | null | undefined;
  const legacy = !Array.isArray(c?.roulettes) && c?.roulette != null && typeof c.roulette === 'object';
  const src = Array.isArray(c?.roulettes) ? c.roulettes : legacy ? [c!.roulette] : null;
  if (src === null) return structuredClone(DEFAULT_ROULETTES) as ChallengeRouletteConfig[];

  // 旧形式には id/label が無い。移行分だけは既定(ハートミー)の名前を継がせる —
  // そうしないと表示が TikTok の実名 'Heart Me' に落ちて要望の日本語表記が出ない。
  // 新形式の行では欠損 label を '' のまま通す(giftName へフォールバックせよの意思)。
  const fb = legacy
    ? { id: DEFAULT_ROULETTE.id, label: DEFAULT_ROULETTE.label }
    : { id: '', label: '' };

  const out: ChallengeRouletteConfig[] = [];
  const seen = new Set<string>();
  for (const r of src.slice(0, ROULETTES_MAX)) {
    const v = validateRoulette(r, fb);
    // 重複・欠損 id は振り直す — UI の key と行ごとのテスト再生の対象特定がぶれるため。
    const id = v.id !== '' && !seen.has(v.id) ? v.id : v.id !== '' ? `${v.id}-${out.length}` : `rl-${out.length}`;
    seen.add(id);
    out.push({ ...v, id });
  }
  return out;
}

/**
 * ルーレット1件ぶんの検証。既存流儀どおり throw せずサニタイズする。
 * 有効な出目が 1 件も残らない/全 weight が 0 の盤面は抽選不能なので既定 segments に戻す。
 */
function validateRoulette(raw: unknown, fb: { id: string; label: string }): ChallengeRouletteConfig {
  const d = DEFAULT_ROULETTE;
  const c = raw as Partial<ChallengeRouletteConfig> | null | undefined;
  if (!c || typeof c !== 'object') return { ...structuredClone(d), ...fb };

  const segments: ChallengeRouletteSegment[] = Array.isArray(c.segments)
    ? c.segments
        .filter(
          (s): s is ChallengeRouletteSegment =>
            !!s &&
            typeof s === 'object' &&
            typeof s.amount === 'number' &&
            Number.isFinite(s.amount) &&
            typeof s.weight === 'number' &&
            Number.isFinite(s.weight)
        )
        .slice(0, ROULETTE_SEGMENTS_MAX)
        .map((s) => ({
          amount: Math.min(9_999_999, Math.max(1, Math.round(s.amount))),
          weight: Math.min(999_999, Math.max(0, Math.round(s.weight))),
        }))
    : structuredClone(d.segments);
  const usable = segments.length > 0 && segments.some((s) => s.weight > 0);

  return {
    // 欠損・重複 id は呼び元(validateRoulettes)が振り直すので、ここは fb のまま通す。
    id: typeof c.id === 'string' ? c.id.trim() : fb.id,
    // giftName/canonical と違い小文字化しない — 日本語の表示名を原文のまま出す。
    // `|| fb.label` にしないこと: ユーザーが意図して空にした label を既定名で潰さない。
    label: typeof c.label === 'string' ? c.label.trim().slice(0, ROULETTE_LABEL_MAX) : fb.label,
    // enabled の既定は true なので `!== false`(seEnabled と同じ向き)。
    enabled: c.enabled !== false,
    giftId: typeof c.giftId === 'string' ? c.giftId.trim() : d.giftId,
    giftName: typeof c.giftName === 'string' ? c.giftName.trim().toLowerCase() : d.giftName,
    canonical: typeof c.canonical === 'string' ? c.canonical.trim().toLowerCase() : d.canonical,
    segments: usable ? segments : structuredClone(d.segments),
    direction: c.direction === 'sub' ? 'sub' : 'add',
  };
}

/**
 * ギフト→クリップ割り当ての検証。giftRules と同じく throw せずサニタイズする。
 * 未設定(undefined)は既定を配る一方、明示的な空配列は空のまま通す — 全部の
 * 割り当てを消したユーザーの意思を「既定に戻す」で踏み潰さないため。
 */
function validateGiftClips(raw: unknown): ChallengeGiftClip[] {
  if (raw === undefined || raw === null) return DEFAULT_GIFT_CLIPS.map((c) => ({ ...c }));
  if (!Array.isArray(raw)) return DEFAULT_GIFT_CLIPS.map((c) => ({ ...c }));
  const out: ChallengeGiftClip[] = [];
  for (const r of raw as Array<Partial<ChallengeGiftClip>>) {
    if (!r || typeof r !== 'object') continue;
    if (typeof r.id !== 'string' || typeof r.canonical !== 'string' || r.canonical === '') continue;
    const clip = typeof r.clip === 'string' && CHALLENGE_FX_CLIP_IDS.includes(r.clip) ? r.clip : 'off';
    // mini は後から足したフィールド。既存 settings.json には無いので欠損は 'off'。
    const mini = typeof r.mini === 'string' && CHALLENGE_MINI_IDS.includes(r.mini) ? r.mini : 'off';
    out.push({ id: r.id, canonical: r.canonical.toLowerCase(), clip, mini });
  }
  return out;
}

/** 登録できる指定コメント規則の上限件数。設定UIと settings.json の現実的な上限。 */
export const COMMENT_RULES_MAX = 20;

/**
 * 指定コメント妨害規則の検証。既存流儀どおり throw せずサニタイズする。
 * 非配列(旧 settings.json のキー無し含む)は空 = 機能オフへ。keyword は trim して
 * 原文のまま保存する(小文字化しない — 日本語の表示をそのまま出す。比較は
 * matchCommentRule が toLowerCase で行う)。amount 0 以下・非有限の行は捨てる —
 * 「一致しても何も起きない行」を残すと設定画面で無反応の原因が見えなくなる。
 */
function validateCommentRules(raw: unknown): ChallengeCommentRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ChallengeCommentRule[] = [];
  for (const r of raw.slice(0, COMMENT_RULES_MAX) as Array<Partial<ChallengeCommentRule>>) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
    if (typeof r.keyword !== 'string') continue;
    if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) continue;
    const amount = Math.min(999_999, Math.round(r.amount));
    if (amount <= 0) continue;
    out.push({ id: r.id, keyword: r.keyword.trim(), amount });
  }
  return out;
}

/**
 * コメント → 妨害規則の写像。**部分一致・上から先勝ち**(giftRules と同じ規約)。
 * 大文字小文字は無視する(英字キーワード用 — 日本語には影響しない)。
 * 戻り null は「このコメントでは何も起きない」。
 *
 * ⚠ `keyword !== ''` は外さないこと。`''.includes()` は常に true なので、空欄の
 * 規則が全コメントを拾ってしまう(matchGiftTrigger と同じ罠)。
 */
export function matchCommentRule(cfg: ChallengeConfig, content: string): ChallengeCommentRule | null {
  const t = content.toLowerCase();
  for (const r of cfg.commentRules) {
    if (r.keyword !== '' && t.includes(r.keyword.toLowerCase())) return r;
  }
  return null;
}

/** スロットごとに既知の簡易演出 id か 'off' だけを通し、それ以外は既定に戻す。 */
function validateMiniFx(raw: unknown): Record<ChallengeSeSlot, string> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_MINI_FX };
  for (const slot of CHALLENGE_SE_SLOTS) {
    const v = src[slot];
    if (typeof v === 'string' && (v === 'off' || CHALLENGE_MINI_IDS.includes(v))) out[slot] = v;
  }
  return out;
}

/** スロットごとに既知の音 id か 'off' だけを通し、それ以外は既定に戻す。 */
function validateSeSounds(raw: unknown): Record<ChallengeSeSlot, string> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SE_SOUNDS };
  for (const slot of CHALLENGE_SE_SLOTS) {
    const v = src[slot];
    if (typeof v === 'string' && (v === 'off' || CHALLENGE_SE_SOUND_IDS.includes(v))) {
      out[slot] = v;
    }
  }
  return out;
}

/** スロットごとに 0-100 の数値だけを通す。欠損・非数値・範囲外は既定(100)へ。 */
function validateSeVolumes(raw: unknown): Record<ChallengeSeSlot, number> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SE_VOLUMES };
  for (const slot of CHALLENGE_SE_SLOTS) {
    const v = src[slot];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[slot] = Math.min(100, Math.max(0, Math.round(v)));
    }
  }
  return out;
}

function isValidRule(r: unknown): r is ChallengeGiftRule {
  const x = r as Partial<ChallengeGiftRule> | null | undefined;
  return (
    !!x &&
    typeof x === 'object' &&
    typeof x.id === 'string' &&
    (x.mode === 'fixed' || x.mode === 'perDiamond') &&
    typeof x.amount === 'number' &&
    Number.isFinite(x.amount)
  );
}

/**
 * ギフト → 増減量の写像。diamonds は normalize.ts が一度だけ計算した値を
 * そのまま使う(再計算禁止の全体規約)。戻り null は「このギフトは無視」。
 */
export function matchGiftRule(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; diamonds: number }
): { amount: number; flash: boolean } | null {
  const overFlash = cfg.flashMinDiamonds != null && g.diamonds >= cfg.flashMinDiamonds;
  for (const r of cfg.giftRules) {
    const hit =
      (r.canonical != null && r.canonical === g.canonical) ||
      (r.giftId != null && r.giftId === g.giftId) ||
      (r.canonical == null && r.giftId == null && r.minDiamonds != null && g.diamonds >= r.minDiamonds);
    if (!hit) continue;
    const amount = r.mode === 'perDiamond' ? Math.round(g.diamonds * r.amount) : r.amount;
    return { amount, flash: r.flash === true || overFlash };
  }
  if (cfg.giftDefault) {
    const amount =
      cfg.giftDefault.mode === 'perDiamond'
        ? Math.round(g.diamonds * cfg.giftDefault.amount)
        : cfg.giftDefault.amount;
    if (amount === 0 && !overFlash) return null;
    return { amount, flash: overFlash };
  }
  // 規則が空でも高額ギフトの照明だけは出す。
  return overFlash ? { amount: 0, flash: true } : null;
}

/**
 * ルーレットのトリガーギフト判定。
 *
 * ⚠ ライブ経路では NormalizedEvent.canonical が未代入(normalize.ts は名寄せ結果を
 * イベントに載せない)なので **giftId 一致が本線**。giftName の部分一致は TikTok 側の
 * ID 変更への保険、canonical 一致はリプレイ/テスト経路用の補助。
 */
export function matchRouletteTrigger(
  rl: ChallengeRouletteConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): boolean {
  return matchGiftTrigger(rl, g);
}

/**
 * giftId / giftName / canonical の3段マッチ。ルーレットのトリガー判定と
 * ファンスタンプ(お助け)の判定で共有する唯一の出所。
 *
 * ⚠ 3つとも '' の設定は**どのギフトにも一致しない**。''.includes() が常に true に
 * なる罠(空欄の設定が全ギフトを拾う)を塞ぐガードなので、各行の `!== ''` は外さない。
 *
 * `exactName` は giftName の段にだけ効く追加規約(既定 = 省略 = 従来の部分一致)。
 * **これを持つのは giftFullCut の行だけ**で、ルーレット(ChallengeRouletteConfig)と
 * ファンスタンプ(FanStampConfig)の型にはこのキーが無い。つまり両者では常に
 * undefined となり部分一致のまま — 構造的に巻き込み事故が起きない。
 * 名前判定をここに集約したままにするのが肝で、matchGiftFullCut 側に別実装を
 * 生やすと 3段の評価順と `!== ''` ガードが2箇所に分裂する(この関数が「唯一の
 * 出所」である理由そのもの)。
 */
export function matchGiftTrigger(
  t: { giftId: string; giftName: string; canonical: string; exactName?: boolean },
  g: { canonical?: string; giftId: string; giftName?: string }
): boolean {
  if (t.giftId !== '' && t.giftId === g.giftId) return true;
  if (t.canonical !== '' && g.canonical != null && t.canonical === g.canonical.toLowerCase()) return true;
  if (t.giftName !== '' && g.giftName != null) {
    const name = g.giftName.toLowerCase();
    // trim は完全一致の段だけ。設定値は validate で trim+小文字化済みなので、
    // 部分一致(includes)の結果はこの分岐を足しても1ビットも変わらない。
    if (t.exactName === true ? name.trim() === t.giftName : name.includes(t.giftName)) return true;
  }
  return false;
}

/**
 * ギフト → ルーレット行の写像。**上から順に評価し、最初に一致した1件だけ**を返す
 * (giftRules / giftClips と同じ先勝ち)。enabled でない行は飛ばす。
 * 戻り null は「このギフトではルーレットを回さない」= 通常のギフト規則へ落ちる。
 */
export function matchRoulette(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): ChallengeRouletteConfig | null {
  for (const rl of cfg.roulettes) {
    if (!rl.enabled) continue;
    if (matchGiftTrigger(rl, g)) return rl;
  }
  return null;
}

/**
 * ギフト → ファンスタンプ(お助け)行の写像。**ルーレット・giftRules・giftDefault の
 * どれよりも先に評価し、一致したらそれらを一切評価しない**(二重適用防止 —
 * matchRoulette がルーレットで果たしているのと同じ役割)。
 * 戻り null は「このギフトはお助けではない」= 従来のギフト経路へ落ちる。
 *
 * 単一設定だが戻り値を boolean にしない — 将来 fanStamp を配列化しても
 * 呼び出し側(worker/challenge.ts)のコードが変わらないようにするため。
 */
export function matchFanStamp(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): FanStampConfig | null {
  const fs = cfg.fanStamp;
  if (!fs.enabled) return null;
  return matchGiftTrigger(fs, g) ? fs : null;
}

/**
 * ギフト → タップブースト行の写像。**fanStamp の次・ルーレットより先**に評価し、
 * 一致したら増減規則(roulettes/giftRules/giftDefault)を一切評価しない —
 * matchFanStamp と同じ「先勝ち」規約。同じ giftId を fanStamp と両方に登録した
 * 誤設定では fanStamp が勝つ(呼び出し側が fs 一致時は評価しない)。
 *
 * 単一設定だが戻り値を boolean にしない(matchFanStamp と同じ将来配列化への備え)。
 */
export function matchTapBoost(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): TapBoostConfig | null {
  const tb = cfg.tapBoost;
  if (!tb.enabled) return null;
  return matchGiftTrigger(tb, g) ? tb : null;
}

/**
 * ルーレット見出しの文言。回転パネル(RouletteFx)・確定バナー・盤面なしの
 * フォールバックバナーの3箇所で同じ文にするための唯一の出所。
 *
 * 「ハートミー ○○がルーレット」— 前置きは設定側の label。TikTok から届く実名は
 * 'Heart Me' のような英語のことがあり、それでは日本語表記にならないため label が主。
 * label が空なら実名(giftName)、それも無ければ前置きなしで「○○がルーレット」。
 *
 * &lt;b&gt; でニックネームを括る都合で1本の文字列にはできないので、前後の2片で返す。
 * prefix は末尾に区切りの空白を含む(suffix は先頭空白なし)。
 */
export function rouletteHeadline(e: { rouletteLabel?: string; giftName?: string }): {
  prefix: string;
  suffix: string;
} {
  const name = (e.rouletteLabel ?? '').trim() || (e.giftName ?? '').trim();
  return { prefix: name !== '' ? `${name} ` : '', suffix: 'がルーレット' };
}

/**
 * 重み付き抽選。rand は 0 <= r < 1(テストでは固定値を注入)。
 * weight 0 の行は選ばれない。全 weight 0 は validateRoulette が既定に戻すので
 * ここでは想定外だが、念のため最後の行へ倒す(-1 を返してクラッシュ源を作らない)。
 */
export function drawRouletteIndex(segments: readonly ChallengeRouletteSegment[], rand: () => number): number {
  const total = segments.reduce((s, x) => s + Math.max(0, x.weight), 0);
  if (total <= 0) return segments.length - 1;
  let r = rand() * total;
  for (let i = 0; i < segments.length; i++) {
    const w = Math.max(0, segments[i]!.weight);
    if (w === 0) continue;
    r -= w;
    if (r < 0) return i;
  }
  // 浮動小数の端(r がちょうど 0 まで減り切らない)は weight > 0 の最後の行へ。
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i]!.weight > 0) return i;
  return segments.length - 1;
}
