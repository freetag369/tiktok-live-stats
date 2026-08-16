import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RL_CLIP_FADE_MS, ROULETTE_PATTERN_TIMING, ROULETTE_PATTERNS } from '@shared/roulette-fx';

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

describe('monitor.css — パターンごとの走行キーフレームとクラス束縛', () => {
  it('全パターンに @keyframes rl-run-* がある(fast 含む)', () => {
    for (const p of [...ROULETTE_PATTERNS, 'fast']) {
      expect(css, `rl-run-${p}`).toMatch(new RegExp(`@keyframes\\s+rl-run-${p}\\s*\\{`));
    }
  });

  it('全パターンに .rl-p-* → animation-name の束縛がある(fast はリールの既定値)', () => {
    for (const p of ROULETTE_PATTERNS) {
      const re = new RegExp(
        `\\.rl-p-${p}\\s+\\.roulette-reel\\s*\\{\\s*animation-name:\\s*rl-run-${p};`
      );
      expect(css, `.rl-p-${p} の束縛`).toMatch(re);
    }
    // fast は .roulette-reel の animation ショートハンドが既定として持つ。
    expect(css).toMatch(/\.roulette-reel\s*\{[^}]*animation:\s*rl-run-fast/);
  });

  it('全パターンの 0% は走行距離(--rl-run)から始まり、100% は必ず着地(--rl-shift)', () => {
    for (const p of [...ROULETTE_PATTERNS, 'fast']) {
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
    it(`rl-run-${p} の cue が TS のテーブルと一致する`, () => {
      const t = ROULETTE_PATTERN_TIMING[p];
      const got = cues(keyframesBody(`rl-run-${p}`));
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
    });
  }

  it('fast の rl-run-fast には cue が無い(SE は番兵 1 で全部止まっている)', () => {
    expect(cues(keyframesBody('rl-run-fast')).size).toBe(0);
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
