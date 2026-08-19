import type { ChallengeState } from '@shared/dto';

/**
 * 最終ゲート(ラスト◯◯モード)の進捗リングの表示模型。seg-class.ts と同じ分担 —
 * 規則(いつ・何を出すか)はこの純関数で単体テストし、MonitorView には配線だけを
 * 残してソース検査(test/renderer/gauntlet-ring.spec.ts)で固定する。
 *
 * リングは `.countdown` の**兄弟**として同じグリッドセルに重ねる(.countdown の
 * className / 構造には触らない — punch-* の classList リプレイ規約を壊さないため)。
 */
export interface GauntletRingModel {
  /** リングの総目盛り数(= 1減算に必要なタップ数)。 */
  ticks: number;
  /** 点灯している目盛り数(= 現ゲートの蓄積タップ)。 */
  lit: number;
}

/**
 * null = リング非表示。gauntlet キーの有無が権威(worker が「アクティブ中だけ載せる」
 * 規約で組む — ブーストウィンドウ中・非走行・圏外はキーごと無い)。status も見るのは
 * 停止直後のスナップショット遅延で古い gauntlet が残っていても出さないための防御。
 */
export function gauntletRing(
  challenge: Pick<ChallengeState, 'status' | 'gauntlet'> | null | undefined,
): GauntletRingModel | null {
  if (!challenge || challenge.status !== 'running') return null;
  const g = challenge.gauntlet;
  if (!g || g.needed < 2) return null;
  return {
    ticks: g.needed,
    // 蓄積は 0..needed-1 の契約だが、設定の taps を下げた直後の1フレームは
    // 超えうる — 表示は満タンでクランプする(負も防御)。
    lit: Math.max(0, Math.min(g.taps, g.needed)),
  };
}
