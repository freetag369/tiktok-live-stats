import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FLOAT_ABORT_MS } from '@shared/challenge';
import {
  BANNER_GIFT_CARD_MS,
  BANNER_LATCH_MAX_AHEAD_MS,
  BANNER_MS,
  BANNER_QUEUE_MAX,
  BANNER_STARVE_MS,
  STAGE_GAP_BANNER_MS,
  STAGE_GAP_CUTIN_MS,
  bannerDurationMs,
  bannerEndAtFor,
  clampBannerEndAt,
  clampStarveServedAt,
  enqueueBanner,
  pickStageNext,
  stageWaitMs,
  type StageNext,
} from '@shared/fx-stage';

/**
 * 舞台(stage)の排他判定。「±N 浮上バナーが消えてから次の演出を始める」の
 * 決定ロジックを、レンダラを起動せずに固定する(fx-drain.spec.ts と同型)。
 */

const CSS = readFileSync(resolve('src/renderer/styles/monitor.css'), 'utf8');

/** 秒/ミリ秒どちらの表記でも ms に正規化する(float-abort.spec.ts と同じ)。 */
function toMs(value: string, unit: string): number {
  return unit === 's' ? Math.round(Number(value) * 1000) : Number(value);
}

describe('バナー尺と monitor.css の同期', () => {
  it('BANNER_MS は .float の floatup と同値', () => {
    const base = [...CSS.matchAll(/\.float\s*\{[^}]*animation:\s*floatup\s+([\d.]+)(m?s)/g)].map((m) =>
      toMs(m[1]!, m[2]!)
    );
    expect(base.length, '.float の基本 animation が見つからない').toBeGreaterThanOrEqual(1);
    // 複数ヒットしても全部同じ尺であること(landscape 上書き等が入ったら気づく)。
    for (const ms of base) expect(ms).toBe(BANNER_MS);
  });

  it('BANNER_GIFT_CARD_MS は .float.gift-card の上書きと同値', () => {
    const overrides = [
      ...CSS.matchAll(/\.float\.([\w-]+)\s*\{[^}]*animation-duration:\s*([\d.]+)(m?s)/g),
    ].map((m) => ({ variant: m[1]!, ms: toMs(m[2]!, m[3]!) }));
    const card = overrides.find((o) => o.variant === 'gift-card');
    expect(card, '.float.gift-card の animation-duration 上書きが見つからない').toBeDefined();
    expect(card!.ms).toBe(BANNER_GIFT_CARD_MS);
    // 尺を上書きする variant が増えたら bannerDurationMs も更新が要る。
    expect(overrides.map((o) => o.variant).sort()).toEqual(['gift-card']);
  });

  it('既存の安全弁 FLOAT_ABORT_MS がラッチ+間合いを飲み込む', () => {
    // ラッチが切れたのにバナーがまだ画面に残っている、が起きない不等式。
    // 間合いを伸ばしたらここが落ちて気づく。
    expect(FLOAT_ABORT_MS).toBeGreaterThanOrEqual(BANNER_GIFT_CARD_MS + STAGE_GAP_CUTIN_MS);
  });

  it('間合いはバナー間 ≦ カットイン間', () => {
    expect(STAGE_GAP_CUTIN_MS).toBeGreaterThanOrEqual(STAGE_GAP_BANNER_MS);
    // .float の立ち上がり(floatup 0%→22% ≒ 350ms)を下回らない。
    expect(STAGE_GAP_BANNER_MS).toBeGreaterThanOrEqual(300);
  });
});

describe('bannerDurationMs', () => {
  it('gift-card だけ長い', () => {
    expect(bannerDurationMs('gift-card t3 bad')).toBe(BANNER_GIFT_CARD_MS);
    expect(bannerDurationMs('bad banner-follow')).toBe(BANNER_MS);
    expect(bannerDurationMs('bad like-float')).toBe(BANNER_MS);
    expect(bannerDurationMs('banner-helper good')).toBe(BANNER_MS);
    expect(bannerDurationMs('')).toBe(BANNER_MS);
  });

  it('トークン境界で判定する(部分一致で誤爆しない)', () => {
    expect(bannerDurationMs('banner-gift-cardish')).toBe(BANNER_MS);
    expect(bannerDurationMs('gift-cards')).toBe(BANNER_MS);
  });
});

describe('bannerEndAtFor', () => {
  it('必ず max で伸びる — 短いバナーでラッチが縮まない', () => {
    const gift = bannerEndAtFor(0, 1_000, 'gift-card bad'); // 3200
    expect(gift).toBe(1_000 + BANNER_GIFT_CARD_MS);
    // ギフトカードの最中に 1.6s のバナーが差し込まれても縮まない。
    expect(bannerEndAtFor(gift, 1_500, 'bad banner-follow')).toBe(gift);
  });

  it('ラッチが過去なら now 起点で張り直す', () => {
    expect(bannerEndAtFor(500, 10_000, 'bad')).toBe(10_000 + BANNER_MS);
  });
});

describe('stageWaitMs', () => {
  it('初期値 0(遥か過去)は常に待ち 0', () => {
    expect(stageWaitMs(0, 1_000_000, 'banner')).toBe(0);
    expect(stageWaitMs(0, 1_000_000, 'cutin')).toBe(0);
  });

  it('表示中は「消えるまで + 間合い」を返す', () => {
    const end = 5_000;
    expect(stageWaitMs(end, 4_000, 'banner')).toBe(1_000 + STAGE_GAP_BANNER_MS);
    expect(stageWaitMs(end, 4_000, 'cutin')).toBe(1_000 + STAGE_GAP_CUTIN_MS);
  });

  it('消えた直後は間合いだけ、経過後は 0(負値を返さない)', () => {
    expect(stageWaitMs(5_000, 5_000, 'banner')).toBe(STAGE_GAP_BANNER_MS);
    expect(stageWaitMs(5_000, 5_000 + STAGE_GAP_BANNER_MS, 'banner')).toBe(0);
    expect(stageWaitMs(5_000, 999_999, 'banner')).toBe(0);
    expect(stageWaitMs(5_000, 999_999, 'cutin')).toBe(0);
  });

  it('同じ状態でカットインの待ちはバナーの待ち以上', () => {
    for (const now of [0, 1_000, 4_999, 5_000, 5_400, 9_000]) {
      expect(stageWaitMs(5_000, now, 'cutin')).toBeGreaterThanOrEqual(
        stageWaitMs(5_000, now, 'banner')
      );
    }
  });

  it('【固着しないことの証明】時刻を進めれば必ず 0 になる', () => {
    for (const end of [0, 1, 5_000, 1_700_000_000_000]) {
      expect(stageWaitMs(end, end + STAGE_GAP_CUTIN_MS, 'cutin')).toBe(0);
    }
  });
});

describe('pickStageNext', () => {
  // lastStarveServeMs: 0 = 未発火(遥か過去)= 弁は武装済み。
  const base = {
    hasDrain: false,
    queuedCount: 0,
    oldestQueuedAtMs: null,
    nowMs: 10_000,
    lastStarveServeMs: 0,
  };

  it('真理値表', () => {
    expect(pickStageNext(base)).toBe('idle');
    expect(pickStageNext({ ...base, queuedCount: 2, oldestQueuedAtMs: 9_900 })).toBe('banner');
    expect(pickStageNext({ ...base, hasDrain: true })).toBe('drain');
    // 既定はカットイン優先。
    expect(
      pickStageNext({ ...base, hasDrain: true, queuedCount: 2, oldestQueuedAtMs: 9_900 })
    ).toBe('drain');
  });

  it('飢餓弁: 最古が BANNER_STARVE_MS 待ったらバナーが割り込む(境界含む)', () => {
    const now = 100_000;
    const just = {
      hasDrain: true,
      queuedCount: 1,
      oldestQueuedAtMs: now - BANNER_STARVE_MS,
      nowMs: now,
      lastStarveServeMs: 0,
    };
    expect(pickStageNext(just)).toBe('banner');
    expect(pickStageNext({ ...just, oldestQueuedAtMs: now - BANNER_STARVE_MS + 1 })).toBe('drain');
  });

  it('oldestQueuedAtMs が null なら飢餓弁は働かない(防御)', () => {
    expect(pickStageNext({ ...base, hasDrain: true, queuedCount: 3, oldestQueuedAtMs: null })).toBe(
      'drain'
    );
  });
});

describe('pickStageNext — 飢餓弁の再発火抑制(1発 / BANNER_STARVE_MS)', () => {
  const now = 100_000_000;

  it('発火直後は閉じる: 最古が十分古くても drain', () => {
    expect(
      pickStageNext({
        hasDrain: true,
        queuedCount: 1,
        oldestQueuedAtMs: now - 60_000,
        nowMs: now,
        lastStarveServeMs: now - 1,
      })
    ).toBe('drain');
  });

  it('窓が明けたら再発火する(境界含む)', () => {
    const old = { hasDrain: true, queuedCount: 1, oldestQueuedAtMs: now - 60_000, nowMs: now };
    expect(pickStageNext({ ...old, lastStarveServeMs: now - BANNER_STARVE_MS })).toBe('banner');
    expect(pickStageNext({ ...old, lastStarveServeMs: now - BANNER_STARVE_MS + 1 })).toBe('drain');
  });

  it('hasDrain が無ければ弁は無関係 — バナーは即時', () => {
    expect(
      pickStageNext({
        hasDrain: false,
        queuedCount: 1,
        oldestQueuedAtMs: now - 10,
        nowMs: now,
        lastStarveServeMs: now - 1,
      })
    ).toBe('banner');
  });
});

describe('clampStarveServedAt — 時計の後方ステップからの回復', () => {
  const NOW = 1_700_000_000_000;

  it('正常運転(発火時刻は常に過去)では恒等', () => {
    expect(clampStarveServedAt(0, NOW)).toBe(0);
    expect(clampStarveServedAt(NOW - 1, NOW)).toBe(NOW - 1);
    expect(clampStarveServedAt(NOW, NOW)).toBe(NOW);
  });

  it('未来固着を now まで引き戻し、弁は最長 BANNER_STARVE_MS で再武装する', () => {
    const clamped = clampStarveServedAt(NOW + 600_000, NOW); // 時計が10分巻き戻った直後
    expect(clamped).toBe(NOW);
    expect(
      pickStageNext({
        hasDrain: true,
        queuedCount: 1,
        oldestQueuedAtMs: NOW - 60_000,
        nowMs: NOW + BANNER_STARVE_MS,
        lastStarveServeMs: clamped,
      })
    ).toBe('banner');
  });
});

describe('pickStageNext — 渋滞シーケンス(v0.7.2 回帰: 満タン/ストック演出の消失)', () => {
  const SERVICE_MS = BANNER_MS + STAGE_GAP_BANNER_MS; // バナー1枚の実効尺 ≒ 1.95s

  /**
   * タイマー無しの純シミュレーション。毎秒バナーが到着し(排出 0.51 件/秒を
   * 常に上回る = diag.log の渋滞状況)、持ち越しキューは常に非空(hasDrain 固定
   * true)。'banner' なら shift + 呼び出し側のスタンプ規約どおり lastServe を刻み、
   * 'drain' なら演出1本ぶん時間を進める。
   */
  function simulate(drainMs: number, totalMs: number): StageNext[] {
    let t = 0;
    let lastServe = 0;
    let nextArrival = 0;
    const queue: number[] = []; // 各要素 = atMs
    const picks: StageNext[] = [];
    while (t < totalMs) {
      while (nextArrival <= t) {
        queue.push(nextArrival);
        nextArrival += 1_000;
      }
      const pick = pickStageNext({
        hasDrain: true,
        queuedCount: queue.length,
        oldestQueuedAtMs: queue.length > 0 ? queue[0]! : null,
        nowMs: t,
        lastStarveServeMs: lastServe,
      });
      picks.push(pick);
      if (pick === 'banner') {
        queue.shift();
        lastServe = t;
        t += SERVICE_MS;
      } else {
        t += drainMs;
      }
    }
    return picks;
  }

  for (const drainMs of [2_000, 10_000]) {
    it(`回帰: 渋滞60秒でも drain が飢餓しない(演出1本 ${drainMs}ms)`, () => {
      const picks = simulate(drainMs, 60_000);
      // 旧実装(無状態の年齢判定)は最初の飢餓以降オール 'banner' になり、
      // ここが落ちる = 満タン/ストック演出の消失バグの再発防止。
      for (let i = 0; i < picks.length - 1; i++) {
        if (picks[i] === 'banner') expect(picks[i + 1]).toBe('drain');
      }
      expect(picks.filter((p) => p === 'drain').length).toBeGreaterThanOrEqual(5);
    });

    it(`渋滞60秒でもバナーは窓ごとに1枚は流れる(演出1本 ${drainMs}ms)`, () => {
      const picks = simulate(drainMs, 60_000);
      expect(picks.filter((p) => p === 'banner').length).toBeGreaterThanOrEqual(5);
    });
  }

  it('単発の古株は1回だけ追い越し、直ちにドレインへ番を返す', () => {
    const now = 1_000_000;
    // 8秒待った古株が1枚 → 追い越し発火。
    expect(
      pickStageNext({
        hasDrain: true,
        queuedCount: 1,
        oldestQueuedAtMs: now - BANNER_STARVE_MS,
        nowMs: now,
        lastStarveServeMs: 0,
      })
    ).toBe('banner');
    // 供給+スタンプ後に新しいバナーが並んでも、窓が明けるまでは drain が番を持つ。
    for (const dt of [SERVICE_MS, 4_000, BANNER_STARVE_MS - 1]) {
      expect(
        pickStageNext({
          hasDrain: true,
          queuedCount: 1,
          oldestQueuedAtMs: now + 100, // 発火直後に積まれた新顔
          nowMs: now + dt,
          lastStarveServeMs: now,
        })
      ).toBe('drain');
    }
    // 窓明け+新顔も8秒待ったら次の1枚。
    expect(
      pickStageNext({
        hasDrain: true,
        queuedCount: 1,
        oldestQueuedAtMs: now + 100,
        nowMs: now + 100 + BANNER_STARVE_MS,
        lastStarveServeMs: now,
      })
    ).toBe('banner');
  });
});

describe('MonitorView のソース不変条件(レンダラのテスト環境が無いための機械的な担保)', () => {
  const SRC = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8');

  it('舞台の占有は時刻ラッチで持つ(boolean 固着 = モニターの全死)', () => {
    expect(SRC).toContain('bannerEndAt');
    // ラッチを true/false のフラグに退化させていない。
    expect(SRC).not.toMatch(/bannerEndAt\.current\s*=\s*(true|false)\b/);
  });

  it('バナーは常に1枚へ置き換える(積むと `.floats` が縦に並んで「2列」になる)', () => {
    const fn = SRC.match(/function showBannerNow\([\s\S]*?\n {2}\}/)?.[0];
    expect(fn, 'showBannerNow が見つからない').toBeDefined();
    expect(fn!).toContain('setFloats([{');
  });

  it('pumpStage は runDrain の前に予約を落とす(再入で二度走らせない)', () => {
    const fn = SRC.match(/function pumpStage\([\s\S]*?\n {2}\}/)?.[0];
    expect(fn, 'pumpStage が見つからない').toBeDefined();
    const clearAt = fn!.indexOf('pendingDrain.current = null;');
    const callAt = fn!.indexOf('runDrain(');
    expect(clearAt).toBeGreaterThanOrEqual(0);
    expect(callAt).toBeGreaterThanOrEqual(0);
    expect(clearAt).toBeLessThan(callAt);
  });

  it('finish* は runDrain を直接呼ばない(必ず間合いを挟む scheduleDrain 経由)', () => {
    // 唯一の直接呼び出しは pumpStage の中の1箇所。ここが増えると、その経路だけ
    // 「バナーが消える前に演出が始まる」に戻る。
    expect([...SRC.matchAll(/(?<!function )\brunDrain\(/g)].length).toBe(1);
  });

  it('バナーは据え置き(heldValue)の持ち主にならない', () => {
    const fn = SRC.match(/function showBannerNow\([\s\S]*?\n {2}\}/)?.[0];
    expect(fn!).not.toContain('setHeldValue');
  });

  it('飢餓弁の発火記録は3箇所だけが書く(スタンプ / clamp / idle リセット)', () => {
    // 書き込み点が増えると「1発/窓」の契約が崩れる(勝手に閉じる・開く)。
    expect([...SRC.matchAll(/lastStarveServeAt\.current\s*=/g)].length).toBe(3);
    // now を刻むスタンプは pumpStage の実供給点の1箇所だけ — pick 時に刻むと
    // wait>0 のタイマー再アーム周回が窓を空費して先頭が最長2窓待つ。
    const fn = SRC.match(/function pumpStage\([\s\S]*?\n {2}\}/)?.[0];
    expect(fn, 'pumpStage が見つからない').toBeDefined();
    expect([...fn!.matchAll(/lastStarveServeAt\.current\s*=\s*now;/g)].length).toBe(1);
    // bannerEndAt と同じ律: boolean へ退化させない(固着 = 弁の死)。
    expect(SRC).not.toMatch(/lastStarveServeAt\.current\s*=\s*(true|false)\b/);
  });
});

describe('enqueueBanner', () => {
  it('上限まで積める', () => {
    const q: number[] = [];
    for (let i = 0; i < BANNER_QUEUE_MAX; i++) expect(enqueueBanner(q, i).dropped).toBe(0);
    expect(q.length).toBe(BANNER_QUEUE_MAX);
  });

  it('溢れは最古から1件だけ落ちる', () => {
    const q = [1, 2, 3];
    expect(enqueueBanner(q, 4, 3)).toEqual({ dropped: 1 });
    expect(q).toEqual([2, 3, 4]);
  });

  it('max=0 でも例外にならない', () => {
    const q: number[] = [];
    expect(enqueueBanner(q, 1, 0)).toEqual({ dropped: 1 });
    expect(q).toEqual([]);
  });
});

describe('clampBannerEndAt — 時計の後方ステップからの回復', () => {
  const NOW = 1_700_000_000_000;

  it('正常運転(不変条件の範囲内)では恒等', () => {
    expect(clampBannerEndAt(0, NOW)).toBe(0); // 空き(遥か過去)はそのまま
    expect(clampBannerEndAt(NOW + BANNER_MS, NOW)).toBe(NOW + BANNER_MS);
    expect(clampBannerEndAt(NOW + BANNER_GIFT_CARD_MS, NOW)).toBe(NOW + BANNER_GIFT_CARD_MS);
  });

  it('後方ステップで未来に固着したラッチを上限まで引き戻す', () => {
    const stuck = NOW + 600_000; // 時計が10分巻き戻った直後の見え方
    expect(clampBannerEndAt(stuck, NOW)).toBe(NOW + BANNER_LATCH_MAX_AHEAD_MS);
  });

  it('引き戻し後の stageWaitMs は有限(舞台が必ず回復する)', () => {
    const stuck = NOW + 600_000;
    const wait = stageWaitMs(clampBannerEndAt(stuck, NOW), NOW, 'cutin');
    expect(wait).toBeLessThanOrEqual(BANNER_LATCH_MAX_AHEAD_MS + STAGE_GAP_CUTIN_MS);
  });

  it('bannerEndAtFor → clamp の合成が不変条件を回復する(max で伸ばす契約とは干渉しない)', () => {
    // 巻き戻り前に張られたラッチ(未来に固着)へ新バナーが max で重なっても、
    // clamp を通せば「now + 最大尺」以内に戻る。
    const stuck = NOW + 600_000;
    const extended = bannerEndAtFor(stuck, NOW, 'gift-card t3');
    expect(extended).toBe(stuck); // max なので縮まない(既存契約)
    expect(clampBannerEndAt(extended, NOW)).toBe(NOW + BANNER_LATCH_MAX_AHEAD_MS);
  });

  it('上限は最長バナー尺と同値(これより短いと正常なギフトカードを切り詰める)', () => {
    expect(BANNER_LATCH_MAX_AHEAD_MS).toBe(BANNER_GIFT_CARD_MS);
  });
});
