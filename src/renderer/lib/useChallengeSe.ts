import { useEffect, useRef } from 'react';
import type { ChallengeEffect, ChallengeSeSlot, ChallengeState } from '@shared/dto';
import { DEFAULT_SE_SOUNDS, tierForDiamonds } from '@shared/challenge';
import { playSe } from './se';

function slotFor(e: ChallengeEffect): ChallengeSeSlot {
  switch (e.kind) {
    case 'press':
      return 'press';
    case 'follow':
      return 'follow';
    case 'like':
      return 'like';
    case 'gift':
      return `gift-t${tierForDiamonds(e.diamonds ?? 0)}`;
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
      playSe(sounds[slotFor(e)], o.volume); // 'off' は playSe 側で無音
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.recentEffects]);
}
