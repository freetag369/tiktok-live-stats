import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { planRouletteSpin, type RouletteSpinInput } from '@shared/roulette-spin';
import {
  ROULETTE_FULL_REELS,
  ROULETTE_REELS_MAX,
  ROULETTE_REVEAL_FAST_MS,
  ROULETTE_REVEAL_ULTRA_MS,
  ROULETTE_SPIN_FAST_MS,
  ROULETTE_SPIN_ULTRA_MS,
} from '@shared/challenge';

/**
 * 連打ルーレットの尺の割り当て(2026-08-17 のユーザー決定)。
 *
 * 1〜15本目はフル尺、16〜20本目は短縮、21本目以降は合算バナー。境界は
 * **at(0 始まり)と「N 本目」(1 始まり)の変換ミス**が最も起きやすいので、
 * it 名には必ず両方の表記を書く。
 */

/** 既定の入力(単発・非合算・設定オン・キュー空)。上書きしたい欄だけ渡す。 */
function input(over: Partial<RouletteSpinInput> = {}): RouletteSpinInput {
  return {
    at: 0,
    reels: 1,
    coalesced: 1,
    join: false,
    test: false,
    hot: false,
    teaseEnabled: true,
    rush: false,
    queueRest: 0,
    ...over,
  };
}

describe('ROULETTE_FULL_REELS — フル尺の本数予算', () => {
  it('15 本(上限 ROULETTE_REELS_MAX 以下)', () => {
    expect(ROULETTE_FULL_REELS).toBe(15);
    expect(ROULETTE_FULL_REELS).toBeGreaterThanOrEqual(1);
    expect(ROULETTE_FULL_REELS).toBeLessThanOrEqual(ROULETTE_REELS_MAX);
  });

  it('理論最悪の総尺(15本すべて ultra + 残り5本短縮)は 531_455ms', () => {
    // ROULETTE_REELS_MAX の doc に書いた見積りと 1:1。片方だけ動かせないように
    // 数式ごと凍結する(定数を触ったらコメントも直る)。
    // 2026-08-17: 短縮スピン1周期をバナー尺(1600ms)へ揃えたぶん +1.25 秒。
    // 2026-08-18: ultra をカウントダウン式の激熱(24秒 → 31.897秒)+ 確定見せ 3 秒で +150 秒。
    //   実勢はこれより遥かに短い(ultra は 1.6%/スピン)が、**理論最悪が 8 分を超えた**
    //   ことは覚えておくこと — 達成(CLEAR)の打ち切りが効かない経路を作ると刺さる。
    const full = ROULETTE_FULL_REELS * (ROULETTE_SPIN_ULTRA_MS + ROULETTE_REVEAL_ULTRA_MS);
    const fast =
      (ROULETTE_REELS_MAX - ROULETTE_FULL_REELS) * (ROULETTE_SPIN_FAST_MS + ROULETTE_REVEAL_FAST_MS);
    expect(full + fast).toBe(531_455);
  });
});

describe('planRouletteSpin — 短縮の境界(1〜15本目フル尺 / 16〜20本目 短縮)', () => {
  it('at=0(1本目)〜at=14(15本目)はフル尺', () => {
    for (let at = 0; at <= 14; at++) {
      expect(planRouletteSpin(input({ at, reels: 20 })).short, `at=${at}(${at + 1}本目)`).toBe(false);
    }
  });

  it('at=15(16本目)〜at=19(20本目)は短縮', () => {
    for (let at = 15; at <= 19; at++) {
      expect(planRouletteSpin(input({ at, reels: 20 })).short, `at=${at}(${at + 1}本目)`).toBe(true);
    }
  });

  it('切り替わりは定数由来 — at=ROULETTE_FULL_REELS-1 はフル尺、at=ROULETTE_FULL_REELS は短縮', () => {
    const reels = ROULETTE_REELS_MAX;
    expect(planRouletteSpin(input({ at: ROULETTE_FULL_REELS - 1, reels })).short).toBe(false);
    expect(planRouletteSpin(input({ at: ROULETTE_FULL_REELS, reels })).short).toBe(true);
  });

  it('入室ルーレット(join)は at に関係なく常にフル尺', () => {
    for (let at = 0; at <= ROULETTE_REELS_MAX; at++) {
      expect(planRouletteSpin(input({ at, reels: 20, join: true })).short, `at=${at}`).toBe(false);
    }
  });

  it('合算 effect(coalesced ≥ 2)は1本目だけフル尺 — 別人が混ざるので従来どおり', () => {
    expect(planRouletteSpin(input({ at: 0, reels: 20, coalesced: 5 })).short).toBe(false);
    for (let at = 1; at <= 19; at++) {
      expect(planRouletteSpin(input({ at, reels: 20, coalesced: 5 })).short, `at=${at}`).toBe(true);
    }
  });

  it('合算でも入室ルーレットならフル尺のまま(join が優先)', () => {
    expect(planRouletteSpin(input({ at: 3, reels: 20, coalesced: 4, join: true })).short).toBe(false);
  });

  it('§6b の再開で境界がずれない — at は絶対位置なので入口に依存しない', () => {
    // 譲る前に at=14 まで進んだ連鎖は resumeAt=15 で戻る。再開後の1本目が
    // 「そのランの0本目」として数えられるとフル尺に戻ってしまう。
    const resumed = planRouletteSpin(input({ at: 15, reels: 20 }));
    const straight = planRouletteSpin(input({ at: 15, reels: 20 }));
    expect(resumed).toEqual(straight);
    expect(resumed.short).toBe(true);
  });
});

describe('planRouletteSpin — 超焦らしゲート', () => {
  it('リール2本以上(連打)は at に関係なくカウントを通さない', () => {
    for (let reels = 2; reels <= ROULETTE_REELS_MAX; reels++) {
      for (let at = 0; at < reels; at++) {
        expect(planRouletteSpin(input({ at, reels })).tease, `reels=${reels} at=${at}`).toBeNull();
      }
    }
  });

  it('リール1本の単発はカウントを通す。lastOne はキューが空のときだけ真', () => {
    expect(planRouletteSpin(input({ queueRest: 0 })).tease).toEqual({ lastOne: true });
    expect(planRouletteSpin(input({ queueRest: 1 })).tease).toEqual({ lastOne: false });
    expect(planRouletteSpin(input({ queueRest: 7 })).tease).toEqual({ lastOne: false });
  });

  it('入室ルーレット(join)は素通し', () => {
    expect(planRouletteSpin(input({ join: true })).tease).toBeNull();
  });

  it('▶ 試写(test)は素通し — 通すとパターン別の jack が doublefake に化ける', () => {
    expect(planRouletteSpin(input({ test: true })).tease).toBeNull();
  });

  it('設定オフ(teaseEnabled=false)は素通し', () => {
    expect(planRouletteSpin(input({ teaseEnabled: false })).tease).toBeNull();
  });

  it('短縮スピンは素通し — 段が無いのでゴーストを出せない', () => {
    // reels=1 で短縮になるのは合算(coalesced≥2)は作れないので、20本の 16本目で見る。
    const p = planRouletteSpin(input({ at: 16, reels: 20 }));
    expect(p.short).toBe(true);
    expect(p.tease).toBeNull();
  });
});

describe('planRouletteSpin — 全入力の総当り不変条件', () => {
  interface RouletteSpinPlanCase {
    s: RouletteSpinInput;
    label: string;
  }
  const all: RouletteSpinPlanCase[] = [];
  for (let at = 0; at <= ROULETTE_REELS_MAX; at++) {
    for (const reels of [1, 2, 15, 16, ROULETTE_REELS_MAX]) {
      for (const coalesced of [1, 2, 9]) {
        for (const join of [false, true]) {
          for (const test of [false, true]) {
            for (const hot of [false, true]) {
              for (const teaseEnabled of [false, true]) {
                for (const rush of [false, true]) {
                  for (const queueRest of [0, 1, 5]) {
                    const s = { at, reels, coalesced, join, test, hot, teaseEnabled, rush, queueRest };
                    all.push({ s, label: JSON.stringify(s) });
                  }
                }
              }
            }
          }
        }
      }
    }
  }

  it('short と tease は同時に立たない', () => {
    for (const { s, label } of all) {
      const p = planRouletteSpin(s);
      if (p.short) expect(p.tease, label).toBeNull();
    }
  });

  it('join なら決して short にならない', () => {
    for (const { s, label } of all) {
      if (s.join) expect(planRouletteSpin(s).short, label).toBe(false);
    }
  });

  it('reels > 1 なら決して tease を通さない', () => {
    for (const { s, label } of all) {
      if (s.reels > 1) expect(planRouletteSpin(s).tease, label).toBeNull();
    }
  });

  it('tease を通すのは「単発・非 join・非 test・設定オン・フル尺」だけ', () => {
    for (const { s, label } of all) {
      const p = planRouletteSpin(s);
      if (p.tease !== null) {
        expect(s.reels, label).toBe(1);
        expect(s.join, label).toBe(false);
        expect(s.test, label).toBe(false);
        expect(s.teaseEnabled, label).toBe(true);
        expect(p.short, label).toBe(false);
        // rush 中の単発は short になる(= skip)ので、tease が通るのは rush オフのときだけ。
        expect(s.rush, label).toBe(false);
      }
    }
  });

  it('rush=false は従来の式と完全一致(後方互換の凍結)', () => {
    for (const { s, label } of all) {
      if (s.rush) continue;
      const legacy = !s.join && !s.hot && s.at >= (s.coalesced > 1 ? 1 : ROULETTE_FULL_REELS);
      expect(planRouletteSpin(s).short, label).toBe(legacy);
    }
  });
});

describe('planRouletteSpin — rush(焦らし短縮のライブトグル)', () => {
  it('rush=true なら at=0(1本目)から短縮(単発・連打・合算とも)', () => {
    expect(planRouletteSpin(input({ rush: true })).short).toBe(true);
    for (let at = 0; at <= 19; at++) {
      expect(planRouletteSpin(input({ at, reels: 20, rush: true })).short, `at=${at}`).toBe(true);
    }
    expect(planRouletteSpin(input({ at: 0, reels: 20, coalesced: 5, rush: true })).short).toBe(true);
  });

  it('join / hot は rush でも常にフル尺(免除は rush より強い)', () => {
    for (let at = 0; at <= ROULETTE_REELS_MAX; at++) {
      expect(planRouletteSpin(input({ at, reels: 20, join: true, rush: true })).short, `join at=${at}`).toBe(false);
      // hot はフル尺だが超焦らしも素通し(倍率の段 donAts を消さない)。
      const p = planRouletteSpin(input({ at, reels: 20, hot: true, rush: true }));
      expect(p.short, `hot at=${at}`).toBe(false);
      expect(p.tease, `hot at=${at}`).toBeNull();
    }
  });

  it('▶ 試写(test)は rush 単独では短縮されない — 抽選パターンをそのまま見せる', () => {
    const p = planRouletteSpin(input({ test: true, rush: true }));
    expect(p.short).toBe(false);
    expect(p.tease).toBeNull();
    // 既存の本数境界側は test を見ない(従来挙動の凍結)。
    expect(planRouletteSpin(input({ at: 15, reels: 20, test: true, rush: true })).short).toBe(true);
  });

  it('rush 中は超焦らしカウントを通さない(short 経由の素通し)', () => {
    const p = planRouletteSpin(input({ rush: true, teaseEnabled: true }));
    expect(p.short).toBe(true);
    expect(p.tease).toBeNull();
  });
});

describe('MonitorView の配線(ソース不変条件)', () => {
  const SRC = readFileSync(resolve('src/renderer/monitor/MonitorView.tsx'), 'utf8').replace(/\r\n/g, '\n');

  function fnBody(name: string): string {
    const m = SRC.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n {2}\\}`));
    expect(m, `${name} が見つからない`).toBeTruthy();
    return m![0];
  }

  it('startRoulette は planRouletteSpin を通す(判断の再発明を検出)', () => {
    expect(fnBody('startRoulette')).toContain('planRouletteSpin(');
  });

  it('startRoulette は rush を ref 経由で読む(setTimeout 越しのステールクロージャ対策)', () => {
    expect(fnBody('startRoulette')).toContain('rouletteRushRef');
  });

  it('旧述語(fast || at > 0)がソースに残っていない', () => {
    expect(SRC).not.toMatch(/fast \|\| at > 0/);
  });

  it('startRoulette の呼び出しは新シグネチャ(第2引数は at)', () => {
    // includes の真偽だけを見る — toContain(SRC) は失敗時に 4600 行を吐く。
    for (const old of ['startRoulette(e, false', 'startRoulette(e, true', 'startRoulette(w.e, false']) {
      expect(SRC.includes(old), `旧シグネチャが残っている: ${old}`).toBe(false);
    }
  });
});
