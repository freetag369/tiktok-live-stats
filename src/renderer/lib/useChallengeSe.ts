import { useEffect, useRef } from 'react';
import type { ChallengeEffect, ChallengeSeSlot, ChallengeState } from '@shared/dto';
import {
  DEFAULT_SE_SOUNDS,
  GIFT_FX_REPEAT_TIMERS_MAX,
  effectiveSeVolume,
  freshChallengeEffects,
  giftFxShots,
  tierForDiamonds,
} from '@shared/challenge';
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
    // 'gauge-full'(実演専用)の音は着弾の瞬間にモニターが直接鳴らす(impactStrikeVisuals)。
    case 'gauge-full':
      return null;
    // 'stock-full' の音は2段目着弾の瞬間にモニターが直接鳴らす(impactStock —
    // roulette-hit と同型)。ここで鳴らすと着弾より約1秒早く鳴ってしまう。
    case 'stock-full':
      return null;
    case 'comment':
      return 'comment';
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
    /**
     * マウント直後の最初のスナップショットに含まれる test 演出(▶ 実演再生)を
     * 鳴らす。モニターだけ true — 実演がモニターのマウントより先に push されると
     * 無言で「再生済み」扱いになるため。ダッシュボードは false のまま(画面切替の
     * 直後に直前の実演ジングルが鳴り直る事故を避ける)。
     */
    mountPlaysTest?: boolean;
  }
): void {
  const lastPlayed = useRef<number | null>(null);
  /**
   * 連打ギフトの反復ジングルの予約。**ここで鳴らすのが正しい** — モニターを閉じて
   * いる間はダッシュボード側がこのフックを active で回している(モニターへ寄せると
   * 閉時に反復が消える)。二重再生は下の active ガードが防ぐ。
   */
  const repeatTimers = useRef<number[]>([]);
  // opts は毎レンダー新オブジェクトなので ref に逃がし、effect の依存を
  // recentEffects だけにする(視覚側の useEffect と同じ形)。
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    if (!challenge) return;
    const o = optsRef.current;
    // watermark の進行規約(マウント倒し / id 巻き戻り追従 / 鮮度ゲート)は
    // shared の freshChallengeEffects に集約 — MonitorView の視覚再生と同じ実装。
    const { next, play } = freshChallengeEffects(
      challenge.recentEffects,
      lastPlayed.current,
      Date.now(),
      { mountPlaysTest: o.mountPlaysTest ?? false }
    );
    lastPlayed.current = next;
    const sounds = o.sounds ?? DEFAULT_SE_SOUNDS;
    for (const e of play) {
      if (!o.active || !o.enabled) continue; // watermark は進めるが音は出さない
      const slot = slotFor(e);
      if (slot === null) continue; // 着弾側(モニター)が直接鳴らすスロット
      // 音量は arm 時に確定させる — 連打の途中でスライダを触っても、予約済みの
      // 2発目以降だけ音量が変わる、という不整合を作らない(entryFor と同じ流儀)。
      const vol = effectiveSeVolume(o.volume, o.volumes?.[slot]);
      playSe(sounds[slot], vol); // 'off' は playSe 側で無音
      // 連打ギフトの反復。映像(MonitorView の playGiftVisual)と **同じ giftFxShots**
      // を共有しているのが、音と映像の回数・間隔がずれない唯一の担保。
      if (e.kind === 'gift' && repeatTimers.current.length < GIFT_FX_REPEAT_TIMERS_MAX) {
        const { rep, gap } = giftFxShots(e);
        for (let i = 1; i < rep; i++) {
          // 発火時に自分の id を配列から抜く — 抜かないと発火済み id が上限
          // ガードに積もり、1回のチャレンジで累計64発を超えた時点で以降の
          // 反復ジングルが無音のまま止まる。
          const id = window.setTimeout(() => {
            const a = repeatTimers.current;
            const at = a.indexOf(id);
            if (at !== -1) a.splice(at, 1);
            playSe(sounds[slot], vol);
          }, gap * i);
          repeatTimers.current.push(id);
        }
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [challenge?.recentEffects]);

  // active が飛行中に反転(モニターの開閉)したら予約済みの反復を捨てる。
  // 残すと、鳴らす担当が入れ替わった瞬間に両ウィンドウが同じコンボを鳴らす。
  useEffect(() => {
    if (opts.active) return;
    for (const t of repeatTimers.current) window.clearTimeout(t);
    repeatTimers.current = [];
  }, [opts.active]);

  // 停止/リセット(idle)で予約済みの反復ジングルを捨てる — モニター視覚側の
  // 「idle でのみ演出を打ち切る」(MonitorView の status effect)と対称。
  // achieved では止めない: CLEAR 直前のコンボ音は鳴り切ってよい。
  useEffect(() => {
    if (challenge?.status !== 'idle') return;
    for (const t of repeatTimers.current) window.clearTimeout(t);
    repeatTimers.current = [];
  }, [challenge?.status]);

  useEffect(
    () => () => {
      for (const t of repeatTimers.current) window.clearTimeout(t);
      repeatTimers.current = [];
    },
    []
  );
}
