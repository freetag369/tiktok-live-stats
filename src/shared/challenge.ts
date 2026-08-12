import type {
  ChallengeConfig,
  ChallengeEffect,
  ChallengeGiftClip,
  ChallengeGiftRule,
  ChallengeLogEntry,
  ChallengeRouletteConfig,
  ChallengeRouletteSegment,
  ChallengeSeSlot,
  ChallengeState,
  GiftBandFxConfig,
  GiftFxBand,
} from './dto';

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
 * 4300ms は要望値(「4.3秒で止まる」)。
 */
export const ROULETTE_SPIN_MS = 4300;
/** 当選ブロックの発光(確定見せ)の尺。 */
export const ROULETTE_REVEAL_MS = 600;
/** キュー詰まり時の短縮スピン。連続トリガーでも体感が間延びしない長さ。 */
export const ROULETTE_SPIN_FAST_MS = 900;
/** モニターの連続再生キュー上限。溢れた分は演出スキップ(値は worker が適用済み)。 */
export const ROULETTE_QUEUE_MAX = 3;
/**
 * 据え置きの安全弁。onAnimationEnd が来なくても(タブ非表示等)この時刻で必ず
 * ラッチを解いて worker 値へ収束させる — startStrike の STRIKE_ABORT_MS と同じ役割。
 */
export const ROULETTE_ABORT_MS = ROULETTE_SPIN_MS + ROULETTE_REVEAL_MS + 1500;

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
  const fresh = effects.filter((e) => e.id > from).sort((a, b) => a.id - b.id);
  if (fresh.length === 0) return { log: log as ChallengeLogEntry[], lastId: Math.max(from, maxId) };

  const out = log.slice();
  for (const e of fresh) {
    const head = out[0];
    // 連続 press の畳み込み。間に他の kind が挟まったら新しい行を立てる。
    if (e.kind === 'press' && head?.kind === 'press') {
      out[0] = {
        ...head,
        atMs: e.atMs,
        amount: head.amount + e.amount,
        valueAfter: e.valueAfter,
        count: (head.count ?? 1) + 1,
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
    // like 行の「◯件で+N」は取り込み時の設定で固定する — あとで設定を変えても
    // 過去の行が書き換わらないようにするため。
    ...(e.kind === 'like' && lg ? { likeEvery: lg.every, likeStep: lg.step } : {}),
  };
}

/** 効果音を割り当てられる演出スロット(設定UIの行順)。 */
export const CHALLENGE_SE_SLOTS: readonly ChallengeSeSlot[] = [
  'press',
  'follow',
  'like',
  'gauge-full',
  'stock-full',
  'gift-t1',
  'gift-t2',
  'gift-t3',
  'gift-t4',
  'roulette',
  'roulette-hit',
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
];

/**
 * 簡易演出(素材を持たない SVG + CSS の軽量アニメ)の id 一覧。
 * 実体は renderer/monitor/MiniFx.tsx、動きは monitor.css の @keyframes。
 * validate はこのリストで割り当てを検証する — 未知の id は 'off' に倒す。
 *
 * 映像クリップ(CHALLENGE_FX_CLIP_IDS)と違い mp4 を持たないので、
 * 高頻度イベント(ハートミー・いいね・フォロー)でも画面が埋まらない。
 */
export const CHALLENGE_MINI_IDS: readonly string[] = ['hammer', 'stamp', 'shock'];

/**
 * 演出スロットごとの簡易演出の既定。スロットは効果音と同じ CHALLENGE_SE_SLOTS。
 * press は既定 off — 連打のたびに DOM アニメを積むと重く、canvas のリング波紋で足りる。
 */
export const DEFAULT_MINI_FX: Record<ChallengeSeSlot, string> = {
  press: 'off',
  follow: 'hammer',
  like: 'shock',
  'gauge-full': 'off',
  'stock-full': 'off',
  'gift-t1': 'stamp',
  'gift-t2': 'off',
  'gift-t3': 'off',
  'gift-t4': 'off',
  // ルーレットはリール自体が主演出なので簡易演出は既定 off。
  roulette: 'off',
  'roulette-hit': 'off',
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
  follow: 'question',
  like: 'pop',
  'gauge-full': 'jingle-hit',
  'stock-full': 'jingle-steel',
  'gift-t1': 'confirm-1',
  'gift-t2': 'confirm-2',
  'gift-t3': 'jingle-hit',
  'gift-t4': 'jingle-steel',
  // 回転開始はチクタク感のある tick、確定はゲージ満タンと同じ当たり音。
  roulette: 'tick',
  'roulette-hit': 'jingle-hit',
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
  'gift-t1': 100,
  'gift-t2': 100,
  'gift-t3': 100,
  'gift-t4': 100,
  roulette: 100,
  'roulette-hit': 100,
  achieved: 100,
};

/**
 * ギフトルーレットの既定。要件「初期設定はハートミーで起動」に合わせて有効で出荷する。
 * giftId 7934 は実配信で受領確認済み(resources/gift-aliases.default.json 参照)。
 * weight は合計 100 にしてある — 設定UIの確率表示がそのまま % になる。+1000 は 1%。
 */
export const DEFAULT_ROULETTE: ChallengeRouletteConfig = {
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
 */
export const GIFT_FX_PENDING_OPS_MAX = 64;

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
  giftRules: [],
  // 既定はギフト=妨害: 1ダイヤにつき +1(設定画面で応援方向へ変更できる)。
  giftDefault: { mode: 'perDiamond', amount: 1 },
  roulette: structuredClone(DEFAULT_ROULETTE),
  flashMinDiamonds: 100,
  hotkey: 'F9',
  monitorDisplayId: null,
  monitorWindowed: false,
  lowThreshold: 10,
  seEnabled: true,
  seVolume: 70,
  seSounds: { ...DEFAULT_SE_SOUNDS },
  seVolumes: { ...DEFAULT_SE_VOLUMES },
  fxClipsEnabled: true,
  giftClips: DEFAULT_GIFT_CLIPS.map((c) => ({ ...c })),
  miniFxEnabled: true,
  miniFx: { ...DEFAULT_MINI_FX },
  giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX),
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

/** スロット(press/follow/like/achieved 等)の簡易演出。off/無効なら null。 */
export function miniForSlot(cfg: ChallengeConfig, slot: ChallengeSeSlot): string | null {
  if (!cfg.miniFxEnabled) return null;
  const id = cfg.miniFx[slot];
  return id && id !== 'off' ? id : null;
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
    giftRules,
    giftDefault,
    roulette: validateRoulette(c.roulette),
    flashMinDiamonds:
      c.flashMinDiamonds === null ? null : num(c.flashMinDiamonds, d.flashMinDiamonds ?? 100, 1, 9_999_999),
    hotkey: str(c.hotkey, d.hotkey),
    monitorDisplayId:
      typeof c.monitorDisplayId === 'number' && Number.isFinite(c.monitorDisplayId)
        ? c.monitorDisplayId
        : null,
    monitorWindowed: c.monitorWindowed === true,
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
    giftBandFx: validateGiftBandFx(c.giftBandFx),
  };
}

/**
 * ダイヤ帯域カットイン設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(giftBandFx キー無し)は既定(有効・4バンド)に倒す。
 * min>max の行は捨てる。未知のクリップ id は同じ id の既定バンドのクリップ、
 * それも無ければ 'off' に倒す。
 */
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

/** ルーレット盤面の上限行数。UI とリール演出が破綻しない範囲で余裕を持たせる。 */
export const ROULETTE_SEGMENTS_MAX = 12;

/**
 * ギフトルーレット設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(roulette キー無し)は既定(有効・ハートミー)に倒す。
 * 有効な出目が 1 件も残らない/全 weight が 0 の盤面は抽選不能なので既定 segments に戻す。
 */
function validateRoulette(raw: unknown): ChallengeRouletteConfig {
  const d = DEFAULT_ROULETTE;
  const c = raw as Partial<ChallengeRouletteConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);

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
  if (rl.giftId !== '' && rl.giftId === g.giftId) return true;
  if (rl.canonical !== '' && g.canonical != null && rl.canonical === g.canonical.toLowerCase()) return true;
  if (rl.giftName !== '' && g.giftName != null && g.giftName.toLowerCase().includes(rl.giftName)) return true;
  return false;
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
