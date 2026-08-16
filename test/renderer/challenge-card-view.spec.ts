import { describe, expect, it } from 'vitest';
import { DEFAULT_CHALLENGE } from '@shared/challenge';
import type { ChallengeState } from '@shared/dto';
import { challengeCardView } from '../../src/renderer/screens/challenge-card-view';

/**
 * 操作カードの表示条件。「PUSH を押せるか」「開始で確認を出すか」
 * 「モニター未表示の警告を出すか」は配信事故に直結するのに、
 * これまで単体で検証できなかった。
 */
const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);
const CFG = { ...structuredClone(DEFAULT_CHALLENGE), title: '設定のタイトル', initialValue: 1000 };

function state(over: Partial<ChallengeState> = {}): ChallengeState {
  return {
    status: 'idle',
    value: 1000,
    initialValue: 1000,
    title: 'ランのタイトル',
    startedMs: null,
    achievedMs: null,
    stats: {
      presses: 0,
      follows: 0,
      giftDown: 0,
      giftUp: 0,
      likeUp: 0,
      likeStockUp: 0,
      commentUp: 0,
      joinDown: 0,
      joinUp: 0,
      rouletteSpins: 0,
    },
    recentEffects: [],
    likeGauge: null,
    result: null,
    ...over,
  } as ChallengeState;
}

describe('challengeCardView — バッジと状態', () => {
  it('未接続(challenge が null)では設定値で「停止中」を出す', () => {
    const v = challengeCardView(null, CFG, false, NOW);
    expect(v.badge).toBe('停止中');
    expect(v.title).toBe('設定のタイトル');
    expect(v.value).toBe(1000);
    expect(v.elapsedMs).toBeNull();
    expect(v.pushEnabled).toBe(false);
  });

  it('走行中は「進行中」で PUSH が押せる', () => {
    const v = challengeCardView(state({ status: 'running', startedMs: NOW - 5000 }), CFG, true, NOW);
    expect(v.badge).toBe('進行中');
    expect(v.pushEnabled).toBe(true);
    expect(v.elapsedMs).toBe(5000);
  });

  it('達成すると「達成!」で PUSH は押せない', () => {
    const v = challengeCardView(
      state({ status: 'achieved', value: 0, startedMs: NOW - 9000, achievedMs: NOW - 1000 }),
      CFG,
      true,
      NOW
    );
    expect(v.badge).toBe('達成!');
    expect(v.pushEnabled).toBe(false);
    // 経過時間は達成時刻で止まる(今の時刻で伸び続けない)。
    expect(v.elapsedMs).toBe(8000);
  });

  it('一時停止は「一時停止中」— 値を残した idle', () => {
    const v = challengeCardView(state({ status: 'idle', value: 400, startedMs: NOW - 3000 }), CFG, true, NOW);
    expect(v.badge).toBe('一時停止中');
    expect(v.hasRun).toBe(true);
    expect(v.pushEnabled).toBe(false);
  });

  it('リセット後は「停止中」に戻る(startedMs が消えるのが唯一の判定)', () => {
    const v = challengeCardView(state({ status: 'idle', value: 1000, startedMs: null }), CFG, true, NOW);
    expect(v.badge).toBe('停止中');
    expect(v.hasRun).toBe(false);
  });
});

describe('challengeCardView — モニター未表示の警告', () => {
  it('走行中にモニターが閉じていれば警告を出す', () => {
    const v = challengeCardView(state({ status: 'running', startedMs: NOW }), CFG, false, NOW);
    expect(v.warnMonitorClosed).toBe(true);
  });

  it('モニターが開いていれば出さない', () => {
    const v = challengeCardView(state({ status: 'running', startedMs: NOW }), CFG, true, NOW);
    expect(v.warnMonitorClosed).toBe(false);
  });

  it('停止中は閉じていても出さない(まだ演出が要らない)', () => {
    expect(challengeCardView(state(), CFG, false, NOW).warnMonitorClosed).toBe(false);
    expect(
      challengeCardView(state({ status: 'achieved', achievedMs: NOW }), CFG, false, NOW).warnMonitorClosed
    ).toBe(false);
  });
});

describe('challengeCardView — 進捗とランキング', () => {
  it('done は初期値からの差、妨害で初期値を超えても負にしない', () => {
    expect(challengeCardView(state({ value: 400 }), CFG, true, NOW).done).toBe(600);
    // 妨害で初期値を超えた状態。バーが逆流しない。
    expect(challengeCardView(state({ value: 1200 }), CFG, true, NOW).done).toBe(0);
  });

  it('rankShown は rankBoard キーの有無がそのまま', () => {
    expect(challengeCardView(state(), CFG, true, NOW).rankShown).toBe(false);
    const shown = state({
      rankBoard: { atMs: NOW, startedMs: NOW, participants: 0, gifts: [], likes: [] },
    });
    expect(challengeCardView(shown, CFG, true, NOW).rankShown).toBe(true);
  });

  it('ランのタイトルと初期値は設定より優先される(走行中の設定変更で表示が飛ばない)', () => {
    const v = challengeCardView(
      state({ status: 'running', title: 'ランのタイトル', initialValue: 500, value: 200, startedMs: NOW }),
      CFG,
      true,
      NOW
    );
    expect(v.title).toBe('ランのタイトル');
    expect(v.initial).toBe(500);
    expect(v.done).toBe(300);
  });
});
