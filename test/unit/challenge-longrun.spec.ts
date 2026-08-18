/**
 * 長期運用(24時間級の耐久配信・スリープ復帰・NTP 時刻補正)の耐性テスト。
 *
 * challenge.spec.ts(状態機械の仕様全般)から独立させたのは、こちらは
 * 「時間・容量の境界でだけ現れる振る舞い」に絞るため — msgId dedup の
 * FIFO 追い出し境界、▶テスト実演の期限切れ、保留 op の例外耐性、
 * (サイクル3で)時計の後方ステップ。ヘルパは challenge.spec.ts の最小コピー。
 */
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CHALLENGE,
  DEFAULT_FAN_STAMP,
  DEFAULT_GIFT_BAND_FX,
  DEFAULT_TAP_BOOST,
  GIFT_FX_FREEZE_MARGIN_MS,
  LIKE_FX_WINDOW_MS,
  TAP_BOOST_COUNT_MS,
  TAP_BOOST_INTRO_MS,
} from '@shared/challenge';
import { FAN_STAMP_FX_WINDOW_MS } from '@shared/fan-stamp';
import type { ChallengeConfig } from '@shared/dto';
import type { GiftEvent, LikeEvent } from '@shared/events';
import { ChallengeEngine } from '@worker/challenge';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function cfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  const base = structuredClone(DEFAULT_CHALLENGE);
  // 既定のカットイン(帯域・全面カット)は凍結を張るので、時間を進めない
  // テストのイベントが保留キューへ乗らないよう無効にする(challenge.spec.ts と同じ)。
  base.giftBandFx.enabled = false;
  base.giftFullCut.enabled = false;
  return { ...base, enabled: true, ...over };
}

function bandCfg(over: Partial<ChallengeConfig> = {}): ChallengeConfig {
  return cfg({ giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX), ...over });
}

let seq = 0;

/** 既定の giftDefault(perDiamond)にだけ一致する素のギフト(ランキングと dedup を通す)。 */
function gift(over: Partial<GiftEvent> = {}): GiftEvent {
  return {
    kind: 'gift',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'g1', nickname: 'gifter' },
    giftId: '999999',
    giftName: 'NoMatch',
    repeatCount: 1,
    diamondEach: 1,
    diamonds: 1,
    isBoxGift: false,
    ...over,
  };
}

function like(count: number, over: Partial<LikeEvent> = {}): LikeEvent {
  return {
    kind: 'like',
    msgId: `m${++seq}`,
    tsMs: NOW,
    tsSource: 'server',
    seq,
    viewer: { userId: 'l1', nickname: 'liker' },
    count,
    ...over,
  };
}

function engine(c: ChallengeConfig = cfg(), now: () => number = () => NOW): ChallengeEngine {
  const e = new ChallengeEngine(() => c, now, Math.random, Math.random, () => undefined);
  e.setMonitorOpen(true);
  e.setFxCaps(true);
  return e;
}

describe('msgId dedup — FIFO 上限の境界(BoundedSet 化の互換)', () => {
  it('like: 同一 msgId の再送は適用されず、cap(1024)超過で最古だけが再受理される', () => {
    const e = engine(cfg({ initialValue: 1000, likeEvery: 1, likeStep: 1 }));
    e.start();
    const first = like(1);
    const second = like(1);
    expect(e.handleEvent(first)).toBe(true);
    expect(e.handleEvent(second)).toBe(true);
    expect(e.get().value).toBe(1002);
    // 再送は弾かれる(値もランキングも動かない)
    expect(e.handleEvent(first)).toBe(false);
    expect(e.get().value).toBe(1002);
    // first/second を含め 1024 件が埋まるまで新規を流し、さらに1件で first だけ追い出す
    for (let i = 0; i < 1023; i++) e.handleEvent(like(1));
    expect(e.get().value).toBe(2025); // 2 + 1023 適用
    // second はまだ生きている(先に確認する — first の再受理は再登録なので、
    // その時点で次の最古 = second が追い出される)。
    expect(e.handleEvent(second)).toBe(false);
    expect(e.get().value).toBe(2025);
    // 最古(first)は追い出された = もう一度適用される。
    expect(e.handleEvent(first)).toBe(true);
    expect(e.get().value).toBe(2026);
  });

  it('gift: 同一 msgId の再送はランキングに二重計上されず、cap(512)超過で最古だけが再受理される', () => {
    const e = engine();
    e.start();
    const first = gift({ diamonds: 5 });
    expect(e.handleEvent(first)).toBe(true);
    expect(e.handleEvent(gift({ msgId: first.msgId, diamonds: 5 }))).toBe(false); // 同一 msgId の再送
    const top = (): number => (e.get().runRank ?? []).find((r) => r.userId === 'g1')?.diamonds ?? 0;
    expect(top()).toBe(5);
    // 別ユーザーで 512 件流して first を追い出す(g1 のランキングは動かさない)
    for (let i = 0; i < 512; i++) e.handleEvent(gift({ viewer: { userId: `x${i}` }, diamonds: 1 }));
    expect(e.handleEvent(first)).toBe(true); // 追い出し済みなので再受理される
    expect(top()).toBe(10); // g1 に 5💎 が積み直される
  });

  it('start() を跨いでも dedup は生きている(再開直後の再配信を新ランに数えない)', () => {
    const e = engine(cfg({ initialValue: 1000, likeEvery: 1, likeStep: 1 }));
    e.start();
    const ev = like(1);
    expect(e.handleEvent(ev)).toBe(true);
    expect(e.get().value).toBe(1001);
    e.start(); // 新ラン(value は initialValue へ)
    expect(e.get().value).toBe(1000);
    expect(e.handleEvent(ev)).toBe(false); // 再配信は弾く
    expect(e.get().value).toBe(1000);
  });
});

describe('▶テスト実演(tapBoost)の期限切れ', () => {
  it('press が来なくても 2Hz tick(drainIfChanged)が期限切れを配信する', () => {
    let t = NOW;
    const e = engine(cfg(), () => t);
    // 既定行: 起動 5s + カウント 3s + ウィンドウ(既定の durationSec)。
    // ウィンドウ秒は既定を差し替えるたびに動くので**ハードコードしない**。
    e.testEffect({ kind: 'tapBoost' });
    const WINDOW_MS = DEFAULT_TAP_BOOST.rules[0]!.durationSec * 1000;
    const startMs = NOW + TAP_BOOST_INTRO_MS + TAP_BOOST_COUNT_MS;
    e.drainIfChanged(); // testEffect の dirty を消費
    // ウィンドウ内のタップはカウントされ、state に boost が載る
    t = startMs + 1;
    const pressed = e.press();
    expect(pressed.boost).toMatchObject({ tapCount: 1, endsAtMs: startMs + WINDOW_MS });
    e.drainIfChanged();
    // 期限到来 — press 無しでも tick が dirty を立て、boost 無しの state を配る
    t = startMs + WINDOW_MS;
    const drained = e.drainIfChanged();
    expect(drained).not.toBeNull();
    expect(drained!.boost).toBeUndefined();
  });
});

describe('topRank キャッシュ — 非キャッシュ経路との等価性', () => {
  /** 決定的な混合イベント列(gift/like、4,500 ユニーク = prune を跨ぐ)。 */
  function mixedEvents(): (GiftEvent | LikeEvent)[] {
    const evs: (GiftEvent | LikeEvent)[] = [];
    for (let i = 0; i < 4500; i++) {
      // 同数タイブレーク(先着勝ち)のケースを大量に含む(diamonds は 97 で巡回)
      evs.push(gift({ viewer: { userId: `u${i}`, nickname: `名前${i}` }, diamonds: (i * 7) % 97 }));
      if (i % 3 === 0) evs.push(like(2, { viewer: { userId: `u${i}` } }));
    }
    return evs;
  }

  it('毎イベント get() する側と最後に1回だけ get() する側で結果が一致する', () => {
    const evs = mixedEvents();
    const hot = engine(); // 毎イベント後に get() = キャッシュを温めながら進む
    const cold = engine(); // 最後に1回だけ get() = 常に素の再計算
    hot.start();
    cold.start();
    hot.toggleRank();
    cold.toggleRank();
    for (const ev of evs) {
      hot.handleEvent(structuredClone(ev));
      hot.get();
      cold.handleEvent(structuredClone(ev));
    }
    const a = hot.get();
    const b = cold.get();
    expect(a.runRank).toEqual(b.runRank);
    expect(a.rankBoard?.gifts).toEqual(b.rankBoard?.gifts);
    expect(a.rankBoard?.likes).toEqual(b.rankBoard?.likes);
    expect(a.rankBoard?.participants).toBe(b.rankBoard?.participants);
  });

  it('press はランキングを動かさず、ギフト到着・表示名の更新・reset は即反映される', () => {
    const e = engine();
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'a', nickname: 'A' }, diamonds: 10 }));
    e.handleEvent(gift({ viewer: { userId: 'b', nickname: 'B' }, diamonds: 5 }));
    const before = e.get().runRank;
    expect(before?.map((r) => r.userId)).toEqual(['a', 'b']);
    // press 1000回(材料に触れない)— ランキング不変
    for (let i = 0; i < 1000; i++) e.press();
    expect(e.get().runRank).toEqual(before);
    // ギフト到着で順位が動く
    e.handleEvent(gift({ viewer: { userId: 'b' }, diamonds: 6 }));
    expect(e.get().runRank?.map((r) => r.userId)).toEqual(['b', 'a']);
    // 表示名だけの更新(like 経由の touchParticipant)も行に反映される
    e.handleEvent(like(1, { viewer: { userId: 'a', nickname: 'A改' } }));
    expect(e.get().runRank?.find((r) => r.userId === 'a')?.nickname).toBe('A改');
    // reset で空へ
    e.reset();
    expect(e.get().runRank).toBeUndefined();
  });

  it('同数は先着勝ちの並びがキャッシュ経由でも保たれる', () => {
    const e = engine();
    e.start();
    e.handleEvent(gift({ viewer: { userId: 'first' }, diamonds: 10 }));
    e.handleEvent(gift({ viewer: { userId: 'second' }, diamonds: 10 }));
    e.get(); // キャッシュを温める
    expect(e.get().runRank?.map((r) => r.userId)).toEqual(['first', 'second']);
  });
});

describe('参加者数 — counter + 有界 dedup の精度', () => {
  it('剪定(4000超)を跨いだ再訪でも二重計上されない(cap 内は厳密)', () => {
    const e = engine();
    e.start();
    e.toggleRank();
    for (let i = 0; i < 5000; i++) e.handleEvent(like(1, { viewer: { userId: `p${i}` } }));
    expect(e.get().rankBoard?.participants).toBe(5000);
    // 同じ 5000 人が再訪(prune で runViewers からは大半が消えている)
    for (let i = 0; i < 5000; i++) e.handleEvent(like(1, { viewer: { userId: `p${i}` } }));
    expect(e.get().rankBoard?.participants).toBe(5000);
    // 新規はきちんと増える(単調増加)
    e.handleEvent(like(1, { viewer: { userId: 'newcomer' } }));
    expect(e.get().rankBoard?.participants).toBe(5001);
  });
});

describe('時計の後方ステップ(NTP 巻き戻し・サスペンド復帰)からの回復', () => {
  it('like 演出: 巻き戻り後も最大 LIKE_FX_WINDOW_MS で再開し、値と統計は無事', () => {
    let t = NOW;
    const e = engine(cfg({ initialValue: 1000, likeEvery: 1, likeStep: 1 }), () => t);
    e.start();
    e.handleEvent(like(1)); // 窓の先頭 → 即時 effect、likeFxLastMs = NOW
    const fired = e.get().recentEffects.filter((x) => x.kind === 'like');
    expect(fired).toHaveLength(1);
    // 10分の後方ステップ。以前は likeFxLastMs が未来に残り、演出が10分抑止された。
    t = NOW - 600_000;
    e.handleEvent(like(1)); // 合算窓内扱い(クランプで lastMs = 今)
    expect(e.get().value).toBe(1002); // 値は巻き戻りに関係なく即時適用
    t = NOW - 600_000 + LIKE_FX_WINDOW_MS;
    e.drainIfChanged(); // flushLikeFx が新しい時計基準の窓明けで出す
    const after = e.get().recentEffects.filter((x) => x.kind === 'like');
    expect(after).toHaveLength(2);
    expect(after[0]!.amount).toBe(1);
    // effect id の単調性(watermark 冪等再生の生命線)は巻き戻りを跨いで保たれる
    const ids = e.get().recentEffects.map((x) => x.id);
    for (let i = 1; i < ids.length; i++) expect(ids[i - 1]!).toBeGreaterThan(ids[i]!);
  });

  it('お助け(fanStamp)合算窓: 巻き戻り後も最大 FAN_STAMP_FX_WINDOW_MS で再開する', () => {
    let t = NOW;
    const c = cfg({ fanStamp: { ...structuredClone(DEFAULT_FAN_STAMP), giftId: '76637' } });
    const e = engine(c, () => t);
    e.start();
    const fs = (userId: string): GiftEvent =>
      gift({ giftId: '76637', giftName: 'おやすみトッポ', giftType: 1, viewer: { userId, nickname: userId } });
    e.handleEvent(fs('a')); // 先頭 → 即時バナー、窓 = NOW + FAN_STAMP_FX_WINDOW_MS
    const banners = (): number =>
      e.get().recentEffects.filter((x) => x.kind === 'gift' && x.fanStamp === true).length;
    expect(banners()).toBe(1);
    // 10分の後方ステップ → 窓が未来に固着し、以前は合算が10分吐かれなかった。
    t = NOW - 600_000;
    e.handleEvent(fs('b')); // 窓内扱い → 合算へ
    expect(banners()).toBe(1);
    t = NOW - 600_000 + FAN_STAMP_FX_WINDOW_MS;
    e.drainIfChanged(); // クランプ後の窓明けで合算バナーが出る
    expect(banners()).toBe(2);
  });
});

describe('凍結ドレイン中の例外耐性', () => {
  it('保留 op が throw しても残りの op は適用され、例外は呼び出し元へ抜けない', () => {
    let t = NOW;
    let boom = false;
    // 押下はもう保留キューを使わない(凍結を素通しして即時に効く)ので、保留 op は
    // 視聴者由来のイベントで作る。ルーレットは**適用時に**乱数を引くので、そこを
    // throw させれば「ドレイン中の1件だけが死ぬ」状況を素直に作れる。
    const c = bandCfg({ initialValue: 1000 });
    const e = new ChallengeEngine(
      () => c,
      () => t,
      () => {
        if (boom) {
          boom = false;
          throw new Error('boom');
        }
        return 0; // 出目は常に先頭(+5)
      },
      Math.random,
      () => undefined
    );
    e.setMonitorOpen(true);
    e.setFxCaps(true);
    e.start();
    e.handleEvent(gift({ diamonds: 30 })); // band1: 6秒凍結
    const heartMe = (): GiftEvent => gift({ giftId: '7934', giftName: 'Heart Me', diamonds: 1 });
    e.handleEvent(heartMe()); // 保留 op 1(適用時に rand を引く)
    e.handleEvent(heartMe()); // 保留 op 2
    expect(e.get().value).toBe(1030); // トリガー自身は即時適用、ルーレットは保留
    t = NOW + 6000 + GIFT_FX_FREEZE_MARGIN_MS;
    boom = true; // 次の rand = op1 の適用時に throw
    const drained = e.drainIfChanged();
    expect(drained).not.toBeNull();
    // op1 は死んだが op2 は適用された(従来は例外が伝播し op2 も孤児化していた)
    expect(drained!.stats.rouletteSpins).toBe(1);
    expect(drained!.value).toBe(1035);
    expect(drained!.fxFreezeUntilMs).toBeNull();
  });
});
