import type { ChallengeConfig, GiftCatalogRow } from '@shared/dto';
import {
  matchFanStamp,
  matchGiftFullCut,
  matchGiftRule,
  matchGiftScale,
  matchQuiz,
  matchRevolution,
  matchUniverse,
  matchLion,
  matchRoulette,
  matchTapBoost,
  matchTapLock,
} from '@shared/challenge';

/**
 * ギフトリスト「現在の用途」列の判定だけを JSX 非依存で切り出した純ロジック
 * (test/renderer/gift-list-usages.spec.ts が直接検証する — challenge-card-view.ts
 * や monitor/gauntlet-ring.ts と同じ分離の理由)。
 */

/** 表示順(worker/challenge.ts の giftOp の評価順)。排他かどうかは usagesOf の blockedBy が決める。 */
export const FEATURES = [
  { key: 'fanStamp', label: 'お助け', hint: 'お助け(ファンスタンプ)' },
  { key: 'tapBoost', label: 'ブースト', hint: 'ブースト(フィーバー)' },
  { key: 'revolution', label: '革命', hint: '革命(いいね反転)' },
  { key: 'universe', label: '一撃クリア', hint: '一撃クリア(TIKTOK UNIVERSE)' },
  { key: 'lion', label: 'ライオン', hint: 'ライオン(カウントを一気に増やす妨害)' },
  { key: 'quiz', label: 'お題', hint: 'お題ルーレット(挑戦+コメント投票)' },
  { key: 'tapLock', label: 'お邪魔', hint: 'お邪魔(タップ封じ)' },
  { key: 'roulette', label: 'ルーレット', hint: 'ギフトルーレット' },
  { key: 'giftRule', label: '増減規則', hint: 'ギフト増減の規則(giftRules)' },
  { key: 'giftScale', label: 'ダイヤ増減', hint: 'ダイヤ数で増減(giftScale)' },
  { key: 'fullCut', label: '全面カット', hint: '全面カット(giftFullCut)' },
] as const;

export type FeatureKey = (typeof FEATURES)[number]['key'];

/**
 * 先勝ちで排他になるのはこの機能群だけ(worker の giftOp はどれかに一致すると
 * 早期 return / fanStamp は増減の写像を丸ごと置き換える)。増減規則・ダイヤ増減・
 * 全面カットはこの排他の**下流で併発する** — giftRule に一致したギフトでも
 * 全面カットは通常どおり評価・再生される(値の適用とカットインが同時に起きる)。
 * ダイヤ増減は排他ではなく giftRules と giftDefault の間のフォールバック層なので、
 * ここには入れない。
 */
const EXCLUSIVE_KEYS: readonly FeatureKey[] = [
  'fanStamp',
  'tapBoost',
  'revolution',
  // 一撃クリアも先勝ちで早期 return する(worker の giftOp)ので排他。入れないと
  // ギフトリストが「増減規則も全面カットも発火する」と嘘を表示する。
  'universe',
  'lion',
  'quiz',
  'tapLock',
  'roulette',
];

export interface Usage {
  key: FeatureKey;
  /** 一致した行の見出し(ラベルが空なら giftId など)。 */
  detail: string;
  /** これに食われて発火しない(undefined = 実際に発火する)。 */
  blockedBy?: FeatureKey;
}

export function hintOf(key: FeatureKey): string {
  return FEATURES.find((f) => f.key === key)?.hint ?? key;
}

export function labelOf(key: FeatureKey): string {
  return FEATURES.find((f) => f.key === key)?.label ?? key;
}

/**
 * このギフトが今の設定でどの機能に当たるか。**評価順のまま**返し、上位に食われて
 * 発火しないものには blockedBy を立てる。排他モデルは worker の giftOp と同じ:
 * - お助け/ブースト/革命/お邪魔/ルーレットは先勝ちで、最初の1件だけが発火する。
 * - 増減規則はその排他5機能のどれかに一致すると発火しない。
 * - 全面カットは排他とは別線 — 食われるのは「上でブースト/革命/お邪魔/ルーレットが
 *   発火したとき」と「お助け一致かつ suppressBandFx が ON のとき」だけで、
 *   増減規則とは**同時に発火する**(ここを取り消し線にすると本番と乖離する)。
 *
 * 判定は shared の match* をそのまま使う(本番と同じ 3段: giftId 完全一致 →
 * canonical 完全一致 → giftName 部分一致/exactName なら完全一致)。canonical は
 * DB の gift_alias 値をそのまま渡す — ライブ経路では乗らない補助段だが、
 * 「設定が canonical で当てている」ことをこの表では見せたい。
 */
export function usagesOf(cfg: ChallengeConfig, r: GiftCatalogRow): Usage[] {
  const g = { canonical: r.canonical ?? undefined, giftId: r.giftId, giftName: r.name };
  const out: Usage[] = [];
  // FanStampConfig は単一設定でラベルを持たない — 増減量をそのまま見出しにする。
  const fs = matchFanStamp(cfg, g);
  if (fs) out.push({ key: 'fanStamp', detail: `1回 ${fs.amountEach}` });
  const tb = matchTapBoost(cfg, g);
  if (tb) out.push({ key: 'tapBoost', detail: tb.label || `×${tb.multiplier}` });
  const rv = matchRevolution(cfg, g);
  if (rv) out.push({ key: 'revolution', detail: rv.label || '革命' });
  // push 順が表示順なので位置に意味がある(revolution の次・quiz より先)。
  const un = matchUniverse(cfg, g);
  if (un) out.push({ key: 'universe', detail: un.label || '一撃クリア' });
  const ln = matchLion(cfg, g);
  if (ln) out.push({ key: 'lion', detail: ln.label || 'ライオン' });
  const qz = matchQuiz(cfg, g);
  if (qz) out.push({ key: 'quiz', detail: qz.label || 'お題ルーレット' });
  const tl = matchTapLock(cfg, g);
  if (tl) out.push({ key: 'tapLock', detail: tl.label || `${tl.durationSec}秒` });
  const rl = matchRoulette(cfg, g);
  if (rl) out.push({ key: 'roulette', detail: rl.label || rl.giftName || rl.giftId });
  // 増減規則は名前を見ない(canonical / giftId / minDiamonds のみ)。giftDefault は
  // 「どの規則にも当たらない全ギフト」に効く既定なので、行ごとの用途には出さない。
  const gr = cfg.giftRules.length > 0 ? matchGiftRule(cfg, { ...g, diamonds: r.diamonds }) : null;
  if (gr) out.push({ key: 'giftRule', detail: `${gr.amount > 0 ? '+' : ''}${gr.amount}` });
  // ダイヤ増減は giftRules の**後ろ**(matchGiftRule の実際の評価順と揃える) —
  // 手動行があればそちらが勝つので、ここは「手動行に食われる」側として並べる。
  const gs = matchGiftScale(cfg, { ...g, diamonds: r.diamonds });
  if (gs) out.push({ key: 'giftScale', detail: `${gs.amount > 0 ? '+' : ''}${gs.amount}` });
  const fc = matchGiftFullCut(cfg, g);
  if (fc) out.push({ key: 'fullCut', detail: fc.label || fc.clip });

  // 発火可否の注釈。排他5機能は最初の1件だけが生き、増減規則はその1件に食われる。
  // 全面カットの生死は worker の分岐(fs?.suppressBandFx === true ? null : matchGiftFullCut)
  // をそのまま写す — お助けが勝ったギフトでも suppressBandFx が OFF なら再生される。
  const firstExclusive = out.find((u) => EXCLUSIVE_KEYS.includes(u.key))?.key ?? null;
  for (const u of out) {
    if (u.key === firstExclusive) continue;
    if (EXCLUSIVE_KEYS.includes(u.key) || u.key === 'giftRule') {
      if (firstExclusive) u.blockedBy = firstExclusive;
    } else if (u.key === 'giftScale') {
      // 排他5機能に食われるのは giftRule と同じ。加えて**手動行(giftRules)が
      // 一致していればそちらが勝つ**(matchGiftRule の評価順 = ユーザー決定)。
      if (firstExclusive) u.blockedBy = firstExclusive;
      else if (gr) u.blockedBy = 'giftRule';
    } else if (u.key === 'fullCut' && firstExclusive) {
      if (firstExclusive === 'fanStamp') {
        if (fs?.suppressBandFx === true) u.blockedBy = 'fanStamp';
      } else {
        u.blockedBy = firstExclusive;
      }
    }
  }
  return out;
}
