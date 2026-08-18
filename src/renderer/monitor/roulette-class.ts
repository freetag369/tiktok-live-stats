/**
 * ルーレット演出の「向き(増やす/減らす)で変わる見た目」を決める純関数。
 * MonitorView / RouletteFx から切り出してある。
 *
 * 切り出す理由は seg-class.ts と同じ — vitest は `environment: 'node'` で
 * include が `.spec.ts` のみ = **.tsx を実行できない**ので、コンポーネントを
 * 描画して見た目を検証することができない。規則そのものをここで単体テストし、
 * 配線(コンポーネントが実際にこれを呼んでいること)だけをソース検査に残す。
 *
 * ── 向きの権威は `ChallengeEffect.rouletteDirection` ──────────────────────
 * cfg の行を引き直さない(モニターの cfg は 120 秒ポーリングで古くなりうる)。
 * effect には worker が焼き込み済みで、行を消した後でも正しい向きが残る。
 *
 * ── 「減らす」を回転中から見せてよい理由(アンチリーク) ────────────────────
 * direction は**行ごとの属性**で当選 index に依存しない。さらに出目は
 * sanitizeRouletteSegments が 1 以上へ clamp するので、'sub' の行では
 * **全マスが必ず負**。緑にしても全マスに `-` を付けても、どのマスが当たりかは
 * 一切漏れない(RouletteFx.tsx のアンチリーク節を参照)。
 */

export type RouletteDirection = 'add' | 'sub';

/** 応援(減らす)向きか。`rouletteDirection` は 'add' のときキーごと省かれる。 */
export function isHelpRoulette(direction: RouletteDirection | undefined): boolean {
  return direction === 'sub';
}

/**
 * 回転パネル `.roulette-panel` のクラス。
 *
 * **`bad`/`good` は従来どおり amount の符号で付ける** — `.hit.good .rl-block.win`
 * (当選マスの緑)が依存している既存契約なので置き換えない。`help` を足すだけ。
 * 出目 >= 1 の clamp があるので sub では amount < 0 が必ず成立し、両者は一致する。
 *
 * `hot`(激熱確定)は金色のオーラ。**向きとは独立のトークン** — 激熱は検証が
 * 'add' の行にしか許さないので実際には常に `bad` と同居するが、`help` と排他だと
 * 決めてしまうと将来 sub 側を解禁したときに静かに壊れる。
 */
export function roulettePanelClass(a: {
  direction?: RouletteDirection;
  amount: number;
  hit: boolean;
  hot?: boolean;
}): string {
  const bad = a.amount >= 0;
  return `roulette-panel ${bad ? 'bad' : 'good'}${isHelpRoulette(a.direction) ? ' help' : ''}${
    a.hot ? ' hot' : ''
  }${a.hit ? ' hit' : ''}`;
}

/**
 * 全面暗幕 `.roulette-screen` のクラス。暗幕中央の後光(--rl-spot)は
 * **パネルの親要素**の背景なので、パネル側の変数では届かない。
 */
export function rouletteScreenClass(direction?: RouletteDirection, hot?: boolean): string {
  return `roulette-screen${isHelpRoulette(direction) ? ' help' : ''}${hot ? ' hot' : ''}`;
}

/**
 * 確定バナー(±N 浮上)のクラス。pushFloat の cls は空白区切りのトークン列で、
 * `bannerDurationMs` が `gift-card` トークンだけを見る(= `help` を足しても 1600ms)。
 */
export function rouletteBannerClass(a: {
  direction?: RouletteDirection;
  amount: number;
  hot?: boolean;
}): string {
  return `${a.amount < 0 ? 'good' : 'bad'} banner-roulette${
    isHelpRoulette(a.direction) ? ' help' : ''
  }${a.hot ? ' hot' : ''}`;
}

/**
 * リールのマスに出す符号。**null = 出さない**(従来どおり、確定した当選マスだけが
 * `.rl-sign` を持つ)。'sub' のときだけ全マスに `-` を出す — 盤面の数字は絶対値で
 * 届く(effect.rouletteSegments)ので、これが無いと応援なのに `+` に見える。
 */
export function rouletteBlockSign(direction?: RouletteDirection): '-' | null {
  return isHelpRoulette(direction) ? '-' : null;
}
