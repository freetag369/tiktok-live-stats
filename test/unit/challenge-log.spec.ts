import { describe, expect, it } from 'vitest';
import { CHALLENGE_LOG_MAX, appendChallengeLog } from '@shared/challenge';
import type { ChallengeEffect, ChallengeLogEntry, ChallengeState } from '@shared/dto';

const NOW = Date.UTC(2026, 7, 1, 12, 0, 0);

function fx(over: Partial<ChallengeEffect> & { id: number }): ChallengeEffect {
  return {
    kind: 'press',
    amount: -1,
    valueAfter: 100,
    atMs: NOW,
    ...over,
  };
}

/** recentEffects は新しい順(worker の unshift と同じ)。 */
function state(effects: ChallengeEffect[], over: Partial<ChallengeState> = {}): ChallengeState {
  return {
    status: 'running',
    value: effects[0]?.valueAfter ?? 100,
    initialValue: 100,
    title: 'テスト',
    startedMs: NOW,
    achievedMs: null,
    stats: { presses: 0, follows: 0, giftDown: 0, giftUp: 0, likeUp: 0, likeStockUp: 0, commentUp: 0, joinDown: 0, joinUp: 0, rouletteSpins: 0 },
    recentEffects: effects,
    likeGauge: null,
    result: null,
    ...over,
  };
}

describe('appendChallengeLog — watermark', () => {
  it('初回は手元の effect を全部取り込む(演出と違い「再生済みに倒す」はしない)', () => {
    // press どうしは畳まれるので、行数を見る検査では別の kind を混ぜる。
    const r = appendChallengeLog(
      [],
      state([fx({ id: 2, kind: 'follow', amount: 10 }), fx({ id: 1, kind: 'gift', amount: 5 })]),
      null
    );
    expect(r.log.map((e) => e.id)).toEqual([2, 1]);
    expect(r.lastId).toBe(2);
  });

  it('stock-full は1行になり、press とは畳まれない', () => {
    const r = appendChallengeLog(
      [],
      state([
        fx({ id: 3 }), // press
        fx({ id: 2, kind: 'stock-full', amount: 25, valueAfter: 140 }),
        fx({ id: 1 }), // press
      ]),
      null
    );
    expect(r.log.map((e) => e.kind)).toEqual(['press', 'stock-full', 'press']);
    expect(r.log[1]).toMatchObject({ amount: 25, valueAfter: 140 });
  });

  it('roulette はギフト情報ごと1行になり、press とは畳まれない', () => {
    const r = appendChallengeLog(
      [],
      state([
        fx({ id: 3 }), // press
        fx({ id: 2, kind: 'roulette', amount: 100, giftName: 'Heart Me', nickname: 'HM', diamonds: 1 }),
        fx({ id: 1 }), // press
      ]),
      null
    );
    expect(r.log.map((e) => e.kind)).toEqual(['press', 'roulette', 'press']);
    expect(r.log[1]).toMatchObject({ amount: 100, giftName: 'Heart Me', nickname: 'HM' });
  });

  it('取り込み済みの id は二度入らない(同じ state を二度受けても冪等)', () => {
    const s = state([fx({ id: 2, kind: 'follow', amount: 10 }), fx({ id: 1, kind: 'gift', amount: 5 })]);
    const a = appendChallengeLog([], s, null);
    const b = appendChallengeLog(a.log, s, a.lastId);
    expect(b.log).toBe(a.log);
    expect(b.log.map((e) => e.id)).toEqual([2, 1]);
  });

  it('新しい effect だけを古い順に積む(新しい順の配列になる)', () => {
    const a = appendChallengeLog([], state([fx({ id: 1, kind: 'follow', amount: 10 })]), null);
    const b = appendChallengeLog(
      a.log,
      state([fx({ id: 3, kind: 'gift', amount: 5 }), fx({ id: 2, kind: 'follow', amount: 10 })]),
      a.lastId
    );
    expect(b.log.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it('worker 再起動で id が 1 に戻っても凍らない(呼び出し側が lastId=null で再開する)', () => {
    const a = appendChallengeLog([], state([fx({ id: 40 })]), null);
    expect(a.lastId).toBe(40);
    // worker が作り直され id が振り直された。追従は liveStore の workerEpoch が
    // watermark を白紙(null)に戻すことで行う — 関数側で id の大小から推測しない。
    const b = appendChallengeLog([], state([fx({ id: 2, kind: 'follow', amount: 10 })]), null);
    expect(b.log[0]).toMatchObject({ id: 2, kind: 'follow' });
    expect(b.lastId).toBe(2);
  });

  it('古いスナップショットが後着しても行を重複させず watermark も下げない', () => {
    // delta は rAF コアレスで遅延反映、press RPC の返り値は即時反映なので逆転する。
    // かつては「lastId > maxId = worker 再起動」と誤検知して 0 に倒し、同じギフトの
    // 行が二度積まれていた(演出の二重再生と同じ根)。
    const a = appendChallengeLog(
      [],
      state([fx({ id: 12, kind: 'gift', amount: 5 }), fx({ id: 11, kind: 'follow', amount: 10 })]),
      null
    );
    expect(a.log.map((e) => e.id)).toEqual([12, 11]);
    const stale = appendChallengeLog(a.log, state([fx({ id: 11, kind: 'follow', amount: 10 })]), a.lastId);
    expect(stale.log).toBe(a.log); // 参照ごと据え置き = 1行も足さない
    expect(stale.lastId).toBe(12);
  });

  it(`${CHALLENGE_LOG_MAX} 件を超えたら古い行から捨てる`, () => {
    let log: ChallengeLogEntry[] = [];
    let last: number | null = null;
    for (let i = 1; i <= CHALLENGE_LOG_MAX + 10; i++) {
      // press が連続すると畳まれてしまうので kind を交互にする
      const r = appendChallengeLog(
        log,
        state([fx({ id: i, kind: i % 2 ? 'follow' : 'gift', amount: 1, valueAfter: i })]),
        last
      );
      log = r.log;
      last = r.lastId;
    }
    expect(log).toHaveLength(CHALLENGE_LOG_MAX);
    expect(log[0]!.id).toBe(CHALLENGE_LOG_MAX + 10);
  });
});

describe('appendChallengeLog — PUSH の畳み込み', () => {
  it('連続する press は1行にまとまり、回数と合計と最新の残数を持つ', () => {
    const r = appendChallengeLog(
      [],
      state([
        fx({ id: 3, amount: -1, valueAfter: 97, atMs: NOW + 2000 }),
        fx({ id: 2, amount: -1, valueAfter: 98, atMs: NOW + 1000 }),
        fx({ id: 1, amount: -1, valueAfter: 99, atMs: NOW }),
      ]),
      null
    );
    expect(r.log).toHaveLength(1);
    expect(r.log[0]).toMatchObject({
      id: 1, // 先頭 effect の id を保つ = React が行を作り直さない
      kind: 'press',
      count: 3,
      amount: -3,
      valueAfter: 97,
      atMs: NOW + 2000,
    });
  });

  it('間に別の kind が挟まると畳み込みを打ち切る', () => {
    const r = appendChallengeLog(
      [],
      state([
        fx({ id: 4, amount: -1, valueAfter: 108 }),
        fx({ id: 3, kind: 'follow', amount: 10, valueAfter: 109, nickname: 'はなこ' }),
        fx({ id: 2, amount: -1, valueAfter: 99 }),
        fx({ id: 1, amount: -1, valueAfter: 100 }),
      ]),
      null
    );
    expect(r.log.map((e) => [e.kind, e.count])).toEqual([
      ['press', undefined],
      ['follow', undefined],
      ['press', 2],
    ]);
  });

  it('別の delta で届いた press も直前の行に畳まれる', () => {
    const a = appendChallengeLog([], state([fx({ id: 1, amount: -1, valueAfter: 99 })]), null);
    const b = appendChallengeLog(a.log, state([fx({ id: 2, amount: -1, valueAfter: 98 })]), a.lastId);
    expect(b.log).toHaveLength(1);
    expect(b.log[0]).toMatchObject({ id: 1, count: 2, amount: -2, valueAfter: 98 });
  });
});

describe('appendChallengeLog — 行の中身', () => {
  it('ギフトは名前・連打数・ダイヤ・アイコンを持ち越す', () => {
    const r = appendChallengeLog(
      [],
      state([
        fx({
          id: 1,
          kind: 'gift',
          amount: 5000,
          valueAfter: 6240,
          nickname: 'たろう',
          giftName: 'ぎんが',
          giftCount: 3,
          diamonds: 5000,
          giftIconUrl: 'https://example.invalid/g.png',
        }),
      ]),
      null
    );
    expect(r.log[0]).toMatchObject({
      kind: 'gift',
      nickname: 'たろう',
      giftName: 'ぎんが',
      giftCount: 3,
      diamonds: 5000,
      giftIconUrl: 'https://example.invalid/g.png',
      valueAfter: 6240,
    });
  });

  it('いいねは取り込み時点の every/step を焼き付ける(あとで設定を変えても行が化けない)', () => {
    const s = state([fx({ id: 1, kind: 'like', amount: 3, valueAfter: 103 })], {
      likeGauge: { counter: 5, every: 100, step: 3, fills: 1, stock: null },
    });
    const r = appendChallengeLog([], s, null);
    expect(r.log[0]).toMatchObject({ kind: 'like', likeEvery: 100, likeStep: 3 });
  });

  it('いいね以外に likeEvery は付かない', () => {
    const s = state([fx({ id: 1, kind: 'follow', amount: 10 })], {
      likeGauge: { counter: 5, every: 100, step: 3, fills: 1, stock: null },
    });
    expect(appendChallengeLog([], s, null).log[0]).not.toHaveProperty('likeEvery');
  });
});
