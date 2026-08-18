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

/**
 * null = effect 到着時には鳴らさない(着弾の瞬間にモニターが直接鳴らすスロット)。
 *
 * @param stageSynced モニターが「舞台(stage)」で演出を1件ずつ直列化している。
 *   ±N 浮上バナーは順番待ちで最大数秒遅れて出るので、到着時に鳴らすと音だけが
 *   先走る。true のとき follow / comment / roulette も null にして、モニター側の
 *   実際の再生点(showBannerNow / startRoulette)へ寄せる。
 *   **モニターを閉じているときは false** — ダッシュボードが従来どおり到着時に
 *   鳴らす(LiveDashboard は active: enabled && !monitorOpen なので二重にならない)。
 */
function slotFor(e: ChallengeEffect, stageSynced: boolean): ChallengeSeSlot | null {
  switch (e.kind) {
    case 'press':
      return 'press';
    // 舞台の直列化中は、±N 浮上バナーが実際に出る瞬間にモニターが鳴らす。
    case 'follow':
      return stageSynced ? null : 'follow';
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
      return stageSynced ? null : 'comment';
    case 'gift':
      // ダイヤ帯域カットイン付きのギフトはジングルを鳴らさない — カットインの
      // BGM(MonitorView の playBandBgm)が主役で、重ねると音が濁る。
      // ダッシュボード側(モニター閉時)はBGMを持たないが、カットインの視覚も
      // 出ないので無音で整合する。
      if (e.fxBandClip != null) return null;
      // お助け(ファンスタンプ)は専用スロット。1ダイヤなので tier では gift-t1 と
      // 区別できない。判定は cfg ではなく effect の焼き込み(worker が付ける印)を
      // 見る — モニターの 120 秒ポーリング(CFG_POLL_MS)で古い設定を読む事故を避ける規約。
      // カットイン判定より後に置くこと: suppressBandFx をオフにした設定で
      // カットインが出るとき、BGM とジングルを重ねない既存規約を守る。
      if (e.fanStamp) return 'helper';
      return `gift-t${tierForDiamonds(e.diamonds ?? 0)}`;
    // 到着時 = 回転開始音。確定音('roulette-hit')はモニターがリール停止の瞬間に
    // 直接鳴らす(gauge-full の impactStrike と同型)。
    // **ギフト1件につき1回**で正しい — 連打(1 effect に N 本のリール)でも
    // ここは1回。リールごとの回転ループ音と確定音はモニターが1本ずつ鳴らす。
    case 'roulette':
      // 舞台の直列化中はリールが実際に回り出す瞬間(startRoulette の at===0)。
      return stageSynced ? null : 'roulette';
    // ブーストの音はモニターが直接鳴らす: 起動カットインは音声焼き込み動画、
    // 'boost-start' スロットはタップウィンドウ開始の合図として window 入りの瞬間、
    // 'boost-end' スロットは着弾の瞬間(stock-full と同型)。ここで鳴らすと
    // 動画音声と二重になる。モニター閉時(プレーンモード)は press 音が個々に
    // 鳴るので無音で整合する。
    // お邪魔(タップ封じ)の告知は妨害系の専用音を使う。新しい ChallengeSeSlot は
    // 作らない — スロットを増やすと DEFAULT_SE_SOUNDS / 音量 / miniFx / 設定画面の
    // 音グリッドまで波及するのに対し、既存の妨害音('comment' = コメント妨害)で
    // 十分に「やられた」音になる。舞台の直列化中はバナーが出る瞬間にモニターが鳴らす。
    case 'tap-lock':
      return stageSynced ? null : 'comment';
    case 'boost-start':
      return null;
    case 'boost-end':
      return null;
    case 'achieved':
      return 'achieved';
  }
}

/**
 * recentEffects を watermark 方式で監視し、新規演出の効果音を鳴らす。
 * MonitorView の視覚再生(playEffect)と同じ規約の独立した watermark を持つ:
 * マウント直後は全件再生済みに倒す / worker 再起動(opts.epoch の変化)で白紙に
 * 戻す / 5秒より古い演出は無音でスキップ。
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
     * モニターが演出を1件ずつ直列化している(舞台)。true にすると follow /
     * comment / roulette の音を鳴らさず、モニター側の実際の再生点へ委ねる。
     * モニターだけ true — ダッシュボードは従来どおり到着時に鳴らす。
     */
    stageSynced?: boolean;
    /**
     * マウント直後の最初のスナップショットに含まれる test 演出(▶ 実演再生)を
     * 鳴らす。モニターだけ true — 実演がモニターのマウントより先に push されると
     * 無言で「再生済み」扱いになるため。ダッシュボードは false のまま(画面切替の
     * 直後に直前の実演ジングルが鳴り直る事故を避ける)。
     */
    mountPlaysTest?: boolean;
    /**
     * worker の世代(liveStore の workerEpoch)。変化したら watermark を白紙へ
     * 戻す — 再起動で effect の id が 1 から振り直されるため。**視覚側
     * (MonitorView)と同じ信号で戻すこと**、片方だけ残ると音と映像がずれる。
     * 未指定なら戻さない(ダッシュボード等、再起動追従が要らない呼び出し向け)。
     */
    epoch?: number;
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
      const slot = slotFor(e, o.stageSynced === true);
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

  // worker 再起動(epoch の変化)で watermark を白紙へ戻す。視覚側の同名の
  // effect(MonitorView)と対。初回マウントでは lastPlayed が既に null なので no-op。
  useEffect(() => {
    lastPlayed.current = null;
  }, [opts.epoch]);

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
