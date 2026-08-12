import type {
  ChallengeConfig,
  ChallengeEffect,
  ChallengeGiftClip,
  ChallengeGiftRule,
  ChallengeLogEntry,
  ChallengeSeSlot,
  ChallengeState,
} from './dto';

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

/**
 * ダッシュボードの履歴ログの上限。worker のリングバッファ(12件)と違い、これは
 * 「配信者があとから振り返る」ための長さ — 数分ぶん遡れれば足りる。
 */
export const CHALLENGE_LOG_MAX = 50;

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
  'gift-t1': 'stamp',
  'gift-t2': 'off',
  'gift-t3': 'off',
  'gift-t4': 'off',
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
  miniFxEnabled: true,
  miniFx: { ...DEFAULT_MINI_FX },
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
    miniFxEnabled: c.miniFxEnabled !== false,
    miniFx: validateMiniFx(c.miniFx),
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
