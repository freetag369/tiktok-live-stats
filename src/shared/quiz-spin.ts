/**
 * お題ルーレットの回転演出(全画面テキストの減速差し替え)のタイムライン決定ロジック。
 *
 * 既存ルーレットのリール(roulette-fx.ts — 150px 固定幅ブロックの CSS アニメ)は
 * 使わない — お題は最長 60 文字の文章で、リールの幾何(ROULETTE_BLOCK_W が着地代数の
 * 唯一の出所)に載らない。代わりに「中央の大テキストを差し替え、拍ごとに間隔が
 * 変わって当選お題で止まる」方式にする。
 *
 * revolution-settle.ts / boost-settle.ts と同じ判断でここに置く — レンダラのテストが
 * node で書けないので、演出の決定ロジックは shared に置いて凍結する。
 *
 * **アンチリーク**: worker は当選 index(quizPromptIndex)を effect に焼き込み済みで、
 * ここは「見せ方」を決めるだけ。差し替えの並びは常に当選 index で終わるよう逆算する
 * (rouletteStrip が盤面側を回転させるのと同じ発想 — 途中経過から答えは読めない。
 * ただし数式は決定的で、Math.random は使わない — StrictMode の二重レンダーで
 * 振り直されない、が既存規約)。
 *
 * ── 2026-08-22: 一律 easeIn(二乗)から**拍(QUIZ_SPIN_BEATS)の振り付け**へ ──
 * 尺が 6 秒 → 18 秒(ユーザー指定「今の3倍」)になり、焦らしを入れることになった。
 * 旧実装は `p * p` の一枚写像で「間隔が単調に伸びるだけ」だったが、それでは
 * フェイクストップもニアミスも表現できない。今は拍ごとに**コマの表示時間**を
 * 決め、その累積が atMs になる:
 *
 *   run1(高速) → fake(据え) → run2(高速) → near(据え) → crawl(減速) → tail(当選で静止)
 *
 * フェイクストップは「同じコマを長く表示する」だけで作れるので、
 * 「隣接コマは常に +1」というアンチリークの不変条件を保ったまま焦らせる。
 * 逆回転や飛ばしを入れるとこの不変条件が壊れるので、やらないこと。
 *
 * ── 2026-08-23: **停止位置を当選コマへ**(ユーザー指摘のバグ修正) ──
 * 初版は tail 拍が「当選の1つ手前(ハズレ)」を掴んで引っぱる設計で、当選の初出は
 * 決定パンチだった。実機では「ルーレットが A で止まったのに発表は B」という
 * **不一致にしか見えない**という指摘を受け、`show` 写像を1つずらして
 * **tail 拍にも当選コマを割り当てる**ようにした。あわせて crawl 拍を 5 秒へ伸ばし
 * (`QUIZ_SPIN_BEATS.crawlSpread`)、「決定前に5秒かけてゆっくり停止する」を作る。
 * 最終コマ(atMs >= totalMs)が決定表示に食われて描かれない仕組みは**据え置き**。
 */

import { QUIZ_SPIN_BEATS, QUIZ_SPIN_MS } from './challenge';

/**
 * コマに付く合図。モニターは効果音(既存の ChallengeSeSlot を流用)と
 * CSS クラス(`.qz-fake` / `.qz-near` / `.qz-crawl`)の切り替えに使う。
 * **新しい効果音スロットは作らない** — スロットの追加は既定音・音量・miniFx・
 * 設定画面・validate まで波及する(MonitorView の startQuizFx のコメント参照)。
 */
export type QuizSpinCue = 'fake' | 'near' | 'crawl' | 'settle';

/** 回転の1コマ。atMs は回転開始からのオフセット、show は表示するお題の index。 */
export interface QuizSpinTick {
  atMs: number;
  show: number;
  /**
   * 見た目(CSS クラス)の切り替え。**fake / near / settle は1コマ、crawl は
   * 減速拍の全コマに付く** — 5 秒のあいだ「重そうに沈む」見得を出しっぱなしに
   * するため。効果音は拍の頭で1回だけ鳴らしたいので、モニター側で
   * 「前のコマと cue が変わったコマ」だけ `playSeSlot` を呼ぶこと
   * (`MonitorView` の startQuizFx を参照)。無い場合はキー自体を省く
   * (既存テストの toEqual 対策)。
   */
  cue?: QuizSpinCue;
}

/** 公称尺(QUIZ_SPIN_MS)での「1コマを表示し続ける長さ」。 */
interface QuizSpinFrame {
  ms: number;
  cue?: QuizSpinCue;
}

/** 走行拍(run1 / run2)を等間隔のコマに割る。最低1コマ。 */
function runFrames(totalMs: number, stepMs: number): QuizSpinFrame[] {
  const n = Math.max(1, Math.round(totalMs / Math.max(1, stepMs)));
  const out: QuizSpinFrame[] = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    // 端数は最後のコマで吸収する(合計を拍の尺ちょうどに保つ)。
    const ms = i === n - 1 ? totalMs - used : Math.round(totalMs / n);
    used += ms;
    out.push({ ms });
  }
  return out;
}

/**
 * 減速拍。間隔が `crawlStepMs` から**等差で伸びて**いく — 走行拍の等間隔から
 * 静止(tail)へ橋を架ける区間で、ここが「決定前に5秒かけてゆっくり停止する」の本体。
 * コマ数は「平均間隔が crawlStepMs の `spread` 倍」になる線で決める(伸びしろの分) —
 * **spread が大きいほどコマが少なく1コマが長い = 減速がはっきり見える**。
 *
 * `cue: 'crawl'` は**全コマ**に付ける(見得を出しっぱなしにするため)。
 * 効果音の重複は呼び出し側が「cue の変化点だけ鳴らす」で防ぐ。
 */
function crawlFrames(totalMs: number, stepMs: number, spread: number): QuizSpinFrame[] {
  const step = Math.max(1, stepMs);
  const k = spread > 0 ? spread : 1.4;
  const n = Math.max(2, Math.round(totalMs / (step * k)));
  // d0 = step から公差 inc で n 個。合計が totalMs ちょうどになる inc を解く。
  // n*d0 + inc*(0+1+...+(n-1)) = totalMs
  const tri = (n * (n - 1)) / 2;
  const inc = tri > 0 ? (totalMs - n * step) / tri : 0;
  const out: QuizSpinFrame[] = [];
  let used = 0;
  for (let i = 0; i < n; i++) {
    const ms = i === n - 1 ? totalMs - used : Math.max(1, Math.round(step + inc * i));
    used += ms;
    out.push({ ms, cue: 'crawl' });
  }
  return out;
}

/**
 * 公称尺でのコマ列。**QUIZ_SPIN_STEPS の出所**なので、拍表を触ると
 * コマ数も自動で追従する(定数リテラルは書かない)。
 * 返るのは「最後の当選コマを除いた」フレーム列 — 当選コマは atMs = totalMs に
 * 別途1つ足す(下の quizSpinTicks を参照)。
 */
function nominalFrames(b: typeof QUIZ_SPIN_BEATS): QuizSpinFrame[] {
  return [
    ...runFrames(b.run1Ms, b.runStepMs),
    { ms: b.fake1Ms, cue: 'fake' },
    ...runFrames(b.run2Ms, b.runStepMs),
    { ms: b.nearMs, cue: 'near' },
    ...crawlFrames(b.crawlMs, b.crawlStepMs, b.crawlSpread),
    // 当選を掴んだままの静止。**効果音は鳴らさない**(無音で引っぱるのがこの拍の
    // 役目 — 1.4 秒後の決定パンチが roulette-hit を鳴らす)。cue は見得だけのため。
    { ms: b.tailMs, cue: 'settle' },
  ];
}

const FRAMES: readonly QuizSpinFrame[] = nominalFrames(QUIZ_SPIN_BEATS);

/**
 * 差し替えの回数(= コマ数)。拍表からの**導出値**で、直接いじらないこと。
 * QUIZ_PROMPTS_MAX(50)より十分大きいので、盤面のお題は必ず全件が流れる。
 */
export const QUIZ_SPIN_STEPS = FRAMES.length + 1;

/**
 * 回転のコマ列を決める。
 *
 * - `atMs` は公称の並び(FRAMES の累積)を `totalMs / QUIZ_SPIN_MS` で伸縮したもの。
 *   丸めで同時刻に潰れたコマは1msずらす(setTimeout の発火順をコードの並びに
 *   依存させない)。**フェイクストップを「同じ atMs を2回」で表現してはいけない** —
 *   単調増加の凍結が落ちるうえ、実際の再生でも順序が実装依存になる。
 * - 最後のコマは必ず `show === winnerIndex` かつ `atMs >= totalMs`。ただし
 *   **このコマは実際には描かれない** — モニターは同時刻に決定パンチを同期予約して
 *   おり、そちらが先に登録されているので先に発火して回転 state を畳む。
 * - **その1つ手前(tail 拍の頭)も `show === winnerIndex`**。つまり視聴者が最後に
 *   見て「止まった」と認識するお題と、決定パンチで発表されるお題は必ず一致する
 *   (2026-08-23 のバグ修正 — 以前はここが当選の1つ手前だった)。
 * - 表示列は winnerIndex から逆算した連番の巡回。**隣接コマは常に +1** で、
 *   同じコマが 2 回続くのは最後の 1 組(tail と描かれない最終コマ)だけ。
 *   そこは既に当選が出ている位置なので、途中経過から答えは読めないまま。
 */
export function quizSpinTicks(
  promptCount: number,
  winnerIndex: number,
  totalMs: number = QUIZ_SPIN_MS
): QuizSpinTick[] {
  const count = Math.max(1, Math.floor(promptCount));
  const winner = Math.min(count - 1, Math.max(0, Math.floor(winnerIndex)));
  if (count === 1) return [{ atMs: Math.max(0, Math.floor(totalMs)), show: winner }];
  const n = QUIZ_SPIN_STEPS;
  const scale = QUIZ_SPIN_MS > 0 ? totalMs / QUIZ_SPIN_MS : 1;
  const out: QuizSpinTick[] = [];
  let prev = -1;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    // i 番目のコマが始まる時刻 = それより前のコマの表示時間の累積。
    const atMs = Math.max(prev + 1, Math.round(acc * scale));
    prev = atMs;
    if (i < FRAMES.length) acc += FRAMES[i]!.ms;
    // 当選から何コマ手前か。**最後の2コマ(tail と描かれない最終コマ)は 0** =
    // どちらも当選コマ。ここを `n - 1 - i` に戻すと tail がハズレを掴む
    // 2026-08-22 版の挙動になり、「止まったお題と発表が違う」に逆戻りする。
    const back = Math.max(0, n - 2 - i);
    const show = (((winner - back) % count) + count) % count;
    const cue = i < FRAMES.length ? FRAMES[i]!.cue : undefined;
    // cue は**条件付きスプレッド**で載せる(常に undefined を持たせると
    // 既存テストの toEqual 比較が壊れる)。
    out.push({ atMs, show, ...(cue ? { cue } : {}) });
  }
  // 丸め・単調化で最後のコマが totalMs を下回らないよう締め直す(show は winner のまま)。
  const last = out[out.length - 1]!;
  last.atMs = Math.max(last.atMs, Math.floor(totalMs));
  return out;
}
