import { useEffect, useRef } from 'react';
import type { ChallengeEffect, ChallengeSeSlot, ChallengeState } from '@shared/dto';
import { DEFAULT_SE_SOUNDS, effectiveSeVolume, tierForDiamonds } from '@shared/challenge';
import { playSe } from './se';

/** null = effect 到着時には鳴らさない(着弾の瞬間にモニターが直接鳴らすスロット)。 */
function slotFor(e: ChallengeEffect): ChallengeSeSlot | null {
  switch (e.kind) {
    case 'press':
      return 'press';
    case 'follow':
      return 'follow';
    case 'like':
      return 'like';
    // 'stock-full' の音は2段目着弾の瞬間にモニターが直接鳴らす(impactStock —
    // roulette-hit と同型)。ここで鳴らすと着弾より約1秒早く鳴ってしまう。
    case 'stock-full':
      return null;
    case 'gift':
      // ダイヤ帯域カットイン付きのギフトはジングルを鳴らさない — カットインの
      // BGM(MonitorView の playBandBgm)が主役で、重ねると音が濁る。
      // ダッシュボード側(モニター閉時)はBGMを持たないが、カットインの視覚も
      // 出ないので無音で整合する。
      if (e.fxBandClip != null) return null;
      return `gift-t${tierForDiamonds(e.diamonds ?? 0)}`;
    // 到着時 = 回転開始音。確定音('roulette-hit')はモニターがリール停止の瞬間に
    // 直接鳴らす(gauge-full の impactStrike と同型)。
    case 'roulette':
      return 'roulette';
    case 'achieved':
      return 'achieved';
  }
}

/**
 * recentEffects を watermark 方式で監視し、新規演出の効果音を鳴らす。
 * MonitorView の視覚再生(playEffect)と同じ規約の独立した watermark を持つ:
 * マウント直後は全件再生済みに倒す / id 巻き戻り(worker 再起動)を検知したら
 * 追従 / 5秒より古い演出は無音でスキップ。
 *
 * active=false でも watermark は進め続ける — モニター閉→ダッシュボード切替の
 * 瞬間に過去演出が一斉に鳴る事故を防ぐ(二重再生防止の要)。
 */
export function useChallengeSe(
  challenge: ChallengeState | null,
  opts: {
    active: boolean;
    enabled: boolean;
    volume: number;
    /** スロット→音 id('off' で無音)。未指定は既定割り当て。 */
    sounds?: Record<ChallengeSeSlot, string>;
    /** スロット→個別音量 0-100(%)。未指定・欠損スロットは 100(= volume そのまま)。 */
    volumes?: Record<ChallengeSeSlot, number>;
  }
): void {
  const lastPlayed = useRef<number | null>(null);
  // opts は毎レンダー新オブジェクトなので ref に逃がし、effect の依存を
  // recentEffects だけにする(視覚側の useEffect と同じ形)。
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!challenge) return;
    const effects = challenge.recentEffects;
    const maxId = effects.reduce((m, e) => Math.max(m, e.id), 0);
    if (lastPlayed.current === null) {
      lastPlayed.current = maxId;
      return;
    }
    if (lastPlayed.current > maxId) lastPlayed.current = 0;
    const fresh = effects.filter((e) => e.id > lastPlayed.current!).sort((a, b) => a.id - b.id);
    const o = optsRef.current;
    const sounds = o.sounds ?? DEFAULT_SE_SOUNDS;
    for (const e of fresh) {
      lastPlayed.current = Math.max(lastPlayed.current, e.id);
      if (Date.now() - e.atMs > 5000) continue;
      if (!o.active || !o.enabled) continue; // watermark は進めるが音は出さない
      const slot = slotFor(e);
      if (slot === null) continue; // 着弾側(モニター)が直接鳴らすスロット
      playSe(sounds[slot], effectiveSeVolume(o.volume, o.volumes?.[slot])); // 'off' は playSe 側で無音
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.recentEffects]);
}
