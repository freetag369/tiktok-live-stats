import type { ChallengeConfig, ChallengeGiftClip, ChallengeGiftRule, ChallengeSeSlot } from './dto';

/**
 * カウントダウンチャレンジ — 純関数のみ。状態機械は worker/challenge.ts。
 *
 * 「0まで寝ない」型の配信企画: ボタンで数字が減り、フォロー・いいねで増え(妨害)、
 * ギフトは規則表で増減が決まる。既定はギフトも妨害(ダイヤ数ぶん増える)。
 */

/** recentEffects リングバッファの上限。モニターの演出再生分だけあれば足りる。 */
export const CHALLENGE_EFFECTS_MAX = 12;

/**
 * like 演出の合算窓。like は全メッセージの約9割の高頻度なので、この窓の間は
 * 加算分を積んでおき1件の effect にまとめる(リングバッファを食い潰さない)。
 */
export const LIKE_FX_WINDOW_MS = 1000;

/** 効果音を割り当てられる演出スロット(設定UIの行順)。 */
export const CHALLENGE_SE_SLOTS: readonly ChallengeSeSlot[] = [
  'press',
  'follow',
  'like',
  'gift-t1',
  'gift-t2',
  'gift-t3',
  'gift-t4',
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
];

/**
 * 既定のギフト→クリップ割り当て。canonical は resources/gift-aliases.default.json
 * の nameRules と一致させること — ここに無い canonical のギフトは tier クリップになる。
 * 設定画面から自由に差し替え・追加・削除できる。
 */
export const DEFAULT_GIFT_CLIPS: readonly ChallengeGiftClip[] = [
  { id: 'clip-universe_plus', canonical: 'universe_plus', clip: 'universe_plus' },
  { id: 'clip-universe', canonical: 'universe', clip: 'universe' },
  { id: 'clip-tiktok_stars', canonical: 'tiktok_stars', clip: 'tiktok_stars' },
  { id: 'clip-white_pegasus', canonical: 'white_pegasus', clip: 'white_pegasus' },
  { id: 'clip-pegasus', canonical: 'pegasus', clip: 'pegasus' },
  { id: 'clip-fire_phoenix', canonical: 'fire_phoenix', clip: 'fire_phoenix' },
  { id: 'clip-thunder_falcon', canonical: 'thunder_falcon', clip: 'thunder_falcon' },
  { id: 'clip-dragon', canonical: 'dragon', clip: 'dragon' },
  { id: 'clip-lion_charge', canonical: 'lion_charge', clip: 'lion_charge' },
  { id: 'clip-leon_lion', canonical: 'leon_lion', clip: 'leon_lion' },
  { id: 'clip-lion', canonical: 'lion', clip: 'lion' },
  { id: 'clip-palace', canonical: 'palace', clip: 'palace' },
  { id: 'clip-whale_mirage', canonical: 'whale_mirage', clip: 'whale_mirage' },
  { id: 'clip-whale_sam', canonical: 'whale_sam', clip: 'whale_sam' },
  { id: 'clip-seal_whale', canonical: 'seal_whale', clip: 'seal_whale' },
  { id: 'clip-adams_dream', canonical: 'adams_dream', clip: 'adams_dream' },
];

export const DEFAULT_SE_SOUNDS: Record<ChallengeSeSlot, string> = {
  press: 'click-soft',
  follow: 'question',
  like: 'pop',
  'gift-t1': 'confirm-1',
  'gift-t2': 'confirm-2',
  'gift-t3': 'jingle-hit',
  'gift-t4': 'jingle-steel',
  achieved: 'fanfare-8bit',
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
  giftRules: [],
  // 既定はギフト=妨害: 1ダイヤにつき +1(設定画面で応援方向へ変更できる)。
  giftDefault: { mode: 'perDiamond', amount: 1 },
  flashMinDiamonds: 100,
  hotkey: 'F9',
  monitorDisplayId: null,
  monitorWindowed: false,
  lowThreshold: 10,
  seEnabled: true,
  seVolume: 70,
  seSounds: { ...DEFAULT_SE_SOUNDS },
  fxClipsEnabled: true,
  giftClips: DEFAULT_GIFT_CLIPS.map((c) => ({ ...c })),
};

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
    giftRules,
    giftDefault,
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
    fxClipsEnabled: c.fxClipsEnabled !== false,
    giftClips: validateGiftClips(c.giftClips),
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
    out.push({ id: r.id, canonical: r.canonical.toLowerCase(), clip });
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
