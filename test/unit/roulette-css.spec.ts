import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RL_CLIP_FADE_MS, ROULETTE_PATTERN_TIMING, ROULETTE_PATTERNS } from '@shared/roulette-fx';
import { ROULETTE_PATTERN_TIER } from '@shared/dto';
import type { RoulettePattern } from '@shared/dto';

/**
 * ルーレット演出の CSS ⇄ TS 結合検査。se-catalog.spec.ts と同じく実ファイルを
 * テキストで読んで突き合わせる(vitest の node 環境で CSS は import できない)。
 *
 * 本丸は cue マーカーの機械照合 — SE を鳴らす時刻(ROULETTE_PATTERN_TIMING)と
 * キーフレームの % は以前は散文コメントの手動同期で、ズレても誰も気付けなかった。
 * monitor.css 側は SE を鳴らす瞬間のキーフレーム行(単一パーセントのセレクタ行に
 * 限る)へ「cue:near」等の CSS コメントを置く規約。ここが落ちたら CSS と
 * テーブルのどちらかだけを動かした、が原因。
 */
const CSS_PATH = join(__dirname, '../../src/renderer/styles/monitor.css');
const css = readFileSync(CSS_PATH, 'utf8');

/** `@keyframes <name> { ... }` のブロック本文を取り出す(入れ子括弧1段まで)。 */
function keyframesBody(name: string): string {
  const re = new RegExp(`@keyframes\\s+${name}\\s*\\{`);
  const m = re.exec(css);
  expect(m, `@keyframes ${name} が monitor.css に無い`).not.toBeNull();
  let depth = 1;
  let i = m!.index + m![0].length;
  const start = i;
  while (i < css.length && depth > 0) {
    const ch = css[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  return css.slice(start, i - 1);
}

/** 通常のルール(`<selector> { ... }`)の本文を取り出す。 */
function ruleBody(selector: string): string {
  const re = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
  const m = re.exec(css);
  expect(m, `${selector} が monitor.css に無い`).not.toBeNull();
  return m![1]!;
}

/** ブロック本文からセレクタ行の cue マーカーを {kind → [X/100]} で集める。 */
function cues(body: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  const line = /(\d+(?:\.\d+)?)%\s*\{((?:\s*\/\*\s*cue:[a-z]+\s*\*\/)+)/g;
  for (let m = line.exec(body); m !== null; m = line.exec(body)) {
    const at = Number(m[1]) / 100;
    const kinds = /cue:([a-z]+)/g;
    for (let k = kinds.exec(m[2]!); k !== null; k = kinds.exec(m[2]!)) {
      out.set(k[1]!, [...(out.get(k[1]!) ?? []), at]);
    }
  }
  return out;
}

/**
 * パターン → 走行キーフレーム名。**超激アツ(ultra)は9パターンとも同じ振り付け**
 * なので `rl-run-ultra` 1本を共有する(違うのは流す動画の絵だけ)。それ以外は
 * 従来どおり1パターン1キーフレーム。
 */
function runName(p: RoulettePattern | 'fast'): string {
  return p !== 'fast' && ROULETTE_PATTERN_TIER[p] === 'ultra' ? 'ultra' : p;
}

/** 実在する走行キーフレーム名の一覧(ultra は畳まれて1本になる)。 */
const RUN_NAMES = [...new Set([...ROULETTE_PATTERNS, 'fast' as const].map(runName))];

describe('monitor.css — パターンごとの走行キーフレームとクラス束縛', () => {
  it('全パターンに @keyframes rl-run-* がある(fast 含む・ultra は共有の1本)', () => {
    for (const n of RUN_NAMES) {
      expect(css, `rl-run-${n}`).toMatch(new RegExp(`@keyframes\\s+rl-run-${n}\\s*\\{`));
    }
  });

  it('全パターンに .rl-p-* → animation-name の束縛がある(fast はリールの既定値)', () => {
    for (const p of ROULETTE_PATTERNS) {
      // ultra はセレクタをまとめて1本に束ねるので、セレクタ列の途中に居ても拾える
      // 書き方にする(`.rl-p-X .roulette-reel` から次の宣言ブロックまでを見る)。
      const re = new RegExp(
        `\\.rl-p-${p}\\s+\\.roulette-reel[^{}]*\\{[^}]*animation-name:\\s*rl-run-${runName(p)};`
      );
      expect(css, `.rl-p-${p} の束縛`).toMatch(re);
    }
    // fast は .roulette-reel の animation ショートハンドが既定として持つ。
    expect(css).toMatch(/\.roulette-reel\s*\{[^}]*animation:\s*rl-run-fast/);
  });

  it('全パターンの 0% は走行距離(--rl-run)から始まり、100% は必ず着地(--rl-shift)', () => {
    for (const p of RUN_NAMES) {
      const body = keyframesBody(`rl-run-${p}`);
      expect(body, `rl-run-${p} の 0%`).toMatch(/0%\s*\{[^}]*var\(--rl-run\)/);
      // 100% の transform が素の translateX(var(--rl-shift)) であること —
      // ここが calc() だと worker の決めた出目からズレて着地する。
      expect(body, `rl-run-${p} の 100%`).toMatch(
        /100%\s*\{\s*(?:\/\*[^*]*\*\/\s*)?transform:\s*translateX\(var\(--rl-shift\)\);/
      );
    }
  });
});

describe('monitor.css — cue マーカーと ROULETTE_PATTERN_TIMING の機械照合', () => {
  for (const p of ROULETTE_PATTERNS) {
    it(`${p}(rl-run-${runName(p)})の cue が TS のテーブルと一致する`, () => {
      const t = ROULETTE_PATTERN_TIMING[p];
      const got = cues(keyframesBody(`rl-run-${runName(p)}`));
      const near = got.get('near') ?? [];
      expect(near, `${p}: cue:near`).toHaveLength(1);
      expect(near[0]!, `${p}: nearAt`).toBeCloseTo(t.nearAt, 3);
      const quiet = got.get('quiet') ?? [];
      expect(quiet, `${p}: cue:quiet`).toHaveLength(1);
      expect(quiet[0]!, `${p}: quietAt`).toBeCloseTo(t.quietAt, 3);
      const kicks = (got.get('kick') ?? []).sort((a, b) => a - b);
      expect(kicks, `${p}: cue:kick`).toHaveLength(t.kickAts.length);
      t.kickAts.forEach((at, i) => expect(kicks[i]!, `${p}: kickAts[${i}]`).toBeCloseTo(at, 3));
      const steps = (got.get('step') ?? []).sort((a, b) => a - b);
      expect(steps, `${p}: cue:step`).toHaveLength(t.stepAts.length);
      t.stepAts.forEach((at, i) => expect(steps[i]!, `${p}: stepAts[${i}]`).toBeCloseTo(at, 3));
      // 超激アツの動画ウィンドウ開始(cue:clip)も同じ規約で機械照合する —
      // 動画とリールの同期は割合の一致だけが頼りなので、ズレの検出をここに寄せる。
      const clips = (got.get('clip') ?? []).sort((a, b) => a - b);
      const wantClips = (t.clips ?? []).map((c) => c.at);
      expect(clips, `${p}: cue:clip`).toHaveLength(wantClips.length);
      wantClips.forEach((at, i) => expect(clips[i]!, `${p}: clips[${i}].at`).toBeCloseTo(at, 3));
      // 「ドン」(出目の倍率が上がる瞬間)も同じ規約で照合する。数字を動かすのは JS だが、
      // **動画に覆われていない隙間に置く**という設計はキーフレーム側の位置で決まるので、
      // 片方だけ動かすと数字が動画の裏で上がって誰にも見えなくなる。
      const dons = (got.get('don') ?? []).sort((a, b) => a - b);
      const wantDons = t.donAts ?? [];
      expect(dons, `${p}: cue:don`).toHaveLength(wantDons.length);
      wantDons.forEach((at, i) => expect(dons[i]!, `${p}: donAts[${i}]`).toBeCloseTo(at, 3));
    });
  }

  it('fast の rl-run-fast には cue が無い(SE は番兵 1 で全部止まっている)', () => {
    expect(cues(keyframesBody('rl-run-fast')).size).toBe(0);
  });
});

describe('monitor.css — 超激アツの倍率表示', () => {
  it('倍率ごとに数字の色(--rl-mult-ink)が定義され、増やす/減らすの両テーマにある', () => {
    for (const n of [2, 3, 4, 5]) {
      expect(ruleBody(`.rl-window.rl-x${n}`), `rl-x${n}`).toMatch(/--rl-mult-ink:/);
      expect(css, `help の rl-x${n}`).toMatch(
        new RegExp(`\\.roulette-panel\\.help\\s+\\.rl-window\\.rl-x${n}\\s*\\{[^}]*--rl-mult-ink:`)
      );
    }
  });

  it('マスの色替えは基底(.roulette-reel .rl-block)より詳細度が高い経路で当てる', () => {
    expect(css).toMatch(/\.rl-window\.rl-x\s+\.roulette-reel\s+\.rl-block\s*\{[^}]*color:\s*var\(--rl-mult-ink\)/);
  });

  it('倍率バッジ rl-mult は animation のみ(transition を混ぜない)で 0%/100% を明示する', () => {
    const badge = ruleBody('.rl-mult');
    expect(badge).toMatch(/animation:\s*rl-mult-pop/);
    expect(badge, 'transition を混ぜるとフェードが死ぬ(.rl-clip と同じ罠)').not.toMatch(
      /transition\s*:/
    );
    const pop = keyframesBody('rl-mult-pop');
    expect(pop, '0% が無い(暗黙キーフレーム禁止)').toMatch(/(^|\s)0%\s*\{/);
    expect(pop, '100% が無い(暗黙キーフレーム禁止)').toMatch(/(^|\s)100%\s*\{/);
  });
});

describe('monitor.css — 暗転とゴーストの部材', () => {
  it('blackout: 暗転レイヤのキーフレームとクラス束縛がある', () => {
    expect(css).toMatch(/@keyframes\s+rl-blackout\s*\{/);
    expect(css).toMatch(/\.rl-p-blackout\s+\.rl-blackout\s*\{/);
  });

  it('超焦らし3種: ゴーストの消灯(rl-jack-fade)が全てに束縛されている', () => {
    expect(css).toMatch(/@keyframes\s+rl-jack-fade\s*\{/);
    for (const p of ['jackstop', 'jackslip', 'jackback']) {
      // まとめてセレクタに並べる書き方を許すので「.rl-p-X .rl-jack」の存在だけ見る。
      expect(css, p).toMatch(new RegExp(`\\.rl-p-${p}\\s+\\.rl-jack\\b`));
    }
    // 消灯の完了は veil-out(答え合わせ)より前 = 100% で opacity 0 のキーフレーム。
    expect(keyframesBody('rl-jack-fade')).toMatch(/100%\s*\{\s*opacity:\s*0;/);
  });
});

/**
 * 超激アツ動画(.rl-clip)の消え際。**この describe は再発防止が主目的**。
 *
 * 初版は `transition: opacity` と `animation: rl-clip-in ... both` を同じ
 * プロパティに併用していた。CSS Transitions は「その property が CSS Animation の
 * 効果下にあるとき transition の値をカスケードに足さない」と定めているため、
 * fill し続ける animation がいる限りフェードは一度も画面に出ない。さらに
 * rl-clip-in が `from` しか持たず暗黙の 100% が「カスケードの計算値」に解決される
 * ので、.out を付けた瞬間に塗り値ごと 0 へ飛ぶ = 1フレームでプツッと消えていた。
 * 下の3本は、その3条件(transition 併用 / 暗黙キーフレーム / 尺のズレ)を封じる。
 */
describe('monitor.css — 超激アツ動画の溶暗(.rl-clip)', () => {
  it('退場の尺が RL_CLIP_FADE_MS と一致する', () => {
    const m = /\.rl-clip\.out\s*\{[^}]*animation:\s*rl-clip-out\s+([\d.]+)(m?s)/.exec(css);
    expect(m, '.rl-clip.out の animation: rl-clip-out が見つからない').not.toBeNull();
    const msVal = m![2] === 's' ? Math.round(Number(m![1]) * 1000) : Number(m![1]);
    expect(msVal).toBe(RL_CLIP_FADE_MS);
  });

  it('入りも消えも animation のみ — transition を混ぜない(フェードが死ぬ)', () => {
    expect(ruleBody('.roulette-screen .rl-clip')).not.toMatch(/transition\s*:/);
    expect(ruleBody('.roulette-screen .rl-clip.out')).not.toMatch(/transition\s*:/);
  });

  it('rl-clip-in / rl-clip-out は 0% と 100% を明示する(暗黙キーフレーム禁止)', () => {
    for (const name of ['rl-clip-in', 'rl-clip-out']) {
      const body = keyframesBody(name);
      expect(body, `${name} の 0%`).toMatch(/0%\s*\{[^}]*opacity:/);
      expect(body, `${name} の 100%`).toMatch(/100%\s*\{[^}]*opacity:/);
    }
  });
});

/**
 * 減らす(応援)= お助けテーマの緑 variant。
 *
 * **variant は変数の差し替えだけ**という規約(基底 .float の解説と同じ)を機械的に
 * 守らせる。ここが崩れると「緑にしたはずが一部だけ金のまま」という、実機を見ないと
 * 気付けない壊れ方をする。幾何・尺・キーフレーム名・cue マーカーは上の describe 群が
 * 見ているので、こちらは**色の面**だけを担当する。
 */
describe('monitor.css — お助けテーマ(.help)の緑 variant', () => {
  /**
   * ルール本文。**行頭に固定する** — ruleBody() は先頭一致なので、素の
   * `.roulette-panel` を渡すと先に出てくる `.roulette-screen .roulette-panel`
   * (拡大用の上書き)を掴んでしまう。
   */
  function ownBody(selector: string): string {
    const re = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`);
    const m = re.exec(css);
    expect(m, `${selector} が monitor.css に無い(行頭のルールとして)`).not.toBeNull();
    return m![1]!;
  }

  /** 宣言された --rl-* の名前一覧(ソート済み)。 */
  function colorVars(selector: string): string[] {
    return [...ownBody(selector).matchAll(/(--rl-[\w-]+):/g)].map((m) => m[1]!).sort();
  }

  it('基底 .roulette-panel が色トークンをまとめて宣言している', () => {
    const base = colorVars('.roulette-panel');
    // 幾何(--rl-w 等)は RouletteFx がインラインで入れるので、ここに出るのは色だけ。
    expect(base.length).toBeGreaterThanOrEqual(28);
    for (const need of ['--rl-lamp', '--rl-glow', '--rl-bg-1', '--rl-bg-2', '--rl-ink', '--rl-disco']) {
      expect(base, need).toContain(need);
    }
  });

  it('.help が基底と**同じトークン集合**を差し替える(塗り残しゼロ)', () => {
    expect(colorVars('.roulette-panel.help')).toEqual(colorVars('.roulette-panel'));
  });

  it('金の直書きが基底へ集約されている — 個別ルールに残っていない', () => {
    // ルーレット節のうち、2つの宣言ブロック**以外**に金のリテラルが残っていたら
    // var 化の取りこぼし(= その部分だけ緑にならない)。
    // 末尾の `.float.banner-*`(確定バナー)は .float の variant 規約の管轄で、
    // 増やす側が金の値を直に持つのが正しいので範囲から外す(下の describe が見る)。
    const from = css.indexOf('.roulette-screen {');
    const to = css.indexOf('.float.banner-roulette', from);
    expect(to, '.float.banner-roulette が見つからない').toBeGreaterThan(from);
    const section = css.slice(from, to);
    const rest = section
      .split(ownBody('.roulette-panel'))
      .join('')
      .split(ownBody('.roulette-panel.help'))
      .join('');
    for (const gold of ['#ffdf7e', '#b8860f', '#6e4a00', '#ffe9a8', 'rgba(255, 214, 90']) {
      expect(rest.includes(gold), `${gold} が var 化されずに残っている`).toBe(false);
    }
  });

  it('ランプ色は必ずフォールバック付きで参照する(未定義だと background ごと落ちる)', () => {
    // radial-gradient() の中の var() が解決できないと gradient が invalid になり、
    // background-image 宣言まるごと落ちて**ランプが無言で消える**。
    const refs = [...css.matchAll(/var\(--rl-lamp([^)]*)\)/g)].map((m) => m[1]!);
    expect(refs.length).toBeGreaterThanOrEqual(4);
    for (const r of refs) {
      expect(r.trim().startsWith(','), `var(--rl-lamp${r}) にフォールバックが無い`).toBe(true);
    }
  });

  it('緑の電飾は色サイクルを絞る — 一周させると赤(妨害の色)を通る', () => {
    expect(ownBody('.roulette-panel.help')).toMatch(/--rl-disco:\s*60deg/);
    expect(ownBody('.roulette-panel')).toMatch(/--rl-disco:\s*360deg/);
  });

  it('マスの数字は緑にしない(回転中に色が付くと答えが見える)', () => {
    expect(ownBody('.roulette-panel.help')).toMatch(/--rl-ink:\s*rgba\(236, 255, 246/);
  });

  it('暗幕の後光は .roulette-screen 側で差し替える(パネルの変数は親に届かない)', () => {
    expect(ruleBody('.roulette-screen.help')).toMatch(/--rl-spot:/);
  });

  it('マスは中身で太らない — ステップ幅が var(--rl-w) からズレると中央に着地しない', () => {
    // flex アイテムの既定 min-width:auto は**中身が flex-basis を押し広げる**。
    // 応援の行は全マスに符号が付くぶん、桁の多い盤面で早く到達する。
    // 実測(静的ハーネス): min-width:0 が無いと出目 10,000 で 138px → 143px に太り、
    // 走行距離と --rl-shift(どちらも 150px 前提の代数)と食い違う。
    const b = ruleBody('.roulette-reel .rl-block');
    expect(b).toMatch(/flex:\s*0\s+0\s+calc\(var\(--rl-w\) - var\(--rl-gap\) \* 2\)/);
    expect(b, 'min-width: 0 が無い').toMatch(/min-width:\s*0;/);
  });
});

/**
 * 盤面 → 確定バナーの色の連続性。リールが止まった直後にバナーが出るので、
 * ここがズレると一番目立つ。**tokens.css の --help-* が唯一の出所**。
 */
describe('お助けの緑は tokens.css の1箇所から来る', () => {
  const tokens = readFileSync(join(__dirname, '../../src/renderer/styles/tokens.css'), 'utf8');

  it('tokens.css が --help-* を持つ', () => {
    for (const t of ['--help-lamp', '--help-glow', '--help-glow-strong', '--help-bg-1', '--help-bg-2']) {
      expect(tokens, t).toContain(`${t}:`);
    }
  });

  it('ファンスタンプのバナー・応援ルーレットのバナー・応援ルーレットの盤面が同じ出所を参照する', () => {
    for (const sel of ['.float.banner-helper', '.float.banner-roulette.help', '.roulette-panel.help']) {
      expect(ruleBody(sel), sel).toContain('var(--help-');
    }
  });

  it('確定バナーは大当たり格の強いグローを使う', () => {
    expect(ruleBody('.float.banner-roulette.help')).toContain('--fl-glow: var(--help-glow-strong)');
  });

  it('バナーの金メッキ枠は差し替えない(.float の variant 規約)', () => {
    expect(ruleBody('.float.banner-roulette.help')).not.toContain('--fl-metal');
  });

  it('ランプのチェイス倍速は向きに関係なく効く(セレクタに .help を足さない)', () => {
    expect(css).toMatch(/\.float\.banner-roulette::before\s*\{\s*animation-duration:\s*480ms;/);
  });
});
