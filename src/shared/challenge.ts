import type { ChallengeConfig, ChallengeGiftRule } from './dto';

/**
 * カウントダウンチャレンジ — 純関数のみ。状態機械は worker/challenge.ts。
 *
 * 「0まで寝ない」型の配信企画: ボタンで数字が減り、フォローで増え(妨害)、
 * ギフトは規則表で増減が決まる。既定はギフトも妨害(ダイヤ数ぶん増える)。
 */

/** recentEffects リングバッファの上限。モニターの演出再生分だけあれば足りる。 */
export const CHALLENGE_EFFECTS_MAX = 12;

export const DEFAULT_CHALLENGE: ChallengeConfig = {
  enabled: false,
  title: '0まで寝ない',
  initialValue: 1000,
  pressStep: 1,
  followStep: 10,
  giftRules: [],
  // 既定はギフト=妨害: 1ダイヤにつき +1(設定画面で応援方向へ変更できる)。
  giftDefault: { mode: 'perDiamond', amount: 1 },
  flashMinDiamonds: 100,
  hotkey: 'F9',
  monitorDisplayId: null,
  lowThreshold: 10,
};

/** ギフト演出の段階。1=小さなお礼〜4=全画面のお祭り。 */
export function tierForDiamonds(diamonds: number): 1 | 2 | 3 | 4 {
  if (diamonds >= 5000) return 4;
  if (diamonds >= 1000) return 3;
  if (diamonds >= 100) return 2;
  return 1;
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
    giftRules,
    giftDefault,
    flashMinDiamonds:
      c.flashMinDiamonds === null ? null : num(c.flashMinDiamonds, d.flashMinDiamonds ?? 100, 1, 9_999_999),
    hotkey: str(c.hotkey, d.hotkey),
    monitorDisplayId:
      typeof c.monitorDisplayId === 'number' && Number.isFinite(c.monitorDisplayId)
        ? c.monitorDisplayId
        : null,
    lowThreshold: num(c.lowThreshold, d.lowThreshold, 0, 9_999_999),
  };
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
