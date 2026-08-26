/**
 * ライオン(Lion 29999💎)の妨害カットシーンのタイムライン決定ロジック。
 *
 * revolution-settle.ts / boost-settle.ts と同じ判断でここに置く — レンダラのテストが
 * node で書けないので、演出の決定ロジックは shared に置いて凍結する。worker も
 * lionCutsceneMs() を凍結の尺と effect の焼き込み(lionCutMs / fxDurationMs)に使うので、
 * 「モニターの段組み == worker が信じている尺」を lion-settle.spec.ts が等式で固定できる。
 *
 * **革命との決定的な違い**: ライオンには窓が無い。値(+ amountEach × steps)は worker が
 * 着弾時に一括で適用済みで、モニターは段①〜⑤の間だけ表示を据え置き(holdValue)、
 * 段⑥(totalAtMs)で解放して7セグを跳ねさせる。したがって arm → cue → commit の
 * 3段(= 窓の原点をモニターの実再生に合わせる仕掛け)は要らない — 帯域カットインと
 * 同じ「worker が即時に値を動かし、モニターが幕の裏で数字を止める」会計になる。
 *
 * 段組み(ユーザー決定 2026-08-26):
 *   ① intro   10.0秒  導入動画(ライオン登場)
 *   ② first    3.0秒  「+29,999」が1枚出現(ペタッ)
 *   ③ kakugo   3.0秒  ②のまま据え置き(「覚悟を…決めましょう」)
 *   ④ burst   12.005秒 「+29,999」が49枚(245ms 間隔・爆発音の連打)
 *   ⑤ blast   10.0秒  全面動画(大爆発)
 *   ⑥ total    5.0秒  「合計 +1,499,950」+ 7セグの解放(爆発2)
 * 既定(steps = 50)の総尺は 43,005ms。
 *
 * **①の素材は 10 秒しかないが、②〜④の 18 秒はその最終フレーム静止で持たせる**
 * (ホルダーに loop も onEnded も付けない = revolution/result.mp4 が演出尺 12 秒を
 * 素材 6 秒の静止で持っているのと同じ契約)。素材の終端は「ライオンが正面を睨んで
 * 静止した決めポーズ」でなければならない。
 */

/** 素材 assets/fx/lion/intro.mp4 の実尺(10 秒 = 24fps で 240 フレームちょうど)。 */
export const LION_INTRO_VIDEO_MS = 10_000;

/** 素材 assets/fx/lion/blast.mp4 の実尺(10 秒 = 24fps で 240 フレームちょうど)。 */
export const LION_BLAST_VIDEO_MS = 10_000;

/** 段① 導入動画の尺。素材実尺(LION_INTRO_VIDEO_MS)と対 — 片方だけ動かさないこと。 */
export const LION_INTRO_MS = 10_000;

/** 段② 1枚目の「+N」を見せる尺。 */
export const LION_FIRST_MS = 3_000;

/** 段③ 1枚目を出したままボイスを聞かせる尺。 */
export const LION_KAKUGO_MS = 3_000;

/**
 * 段④ 連打の間隔(ms)。ユーザー決定「等間隔・約12秒」= 245ms × 49発。
 *
 * ⚠ **`playSe` のプールは音ごとに POOL_SIZE = 4**(renderer/lib/se.ts)。5発目は最古の
 * 要素を currentTime = 0 で巻き戻して使い回すので、**素材長が STEP × 4 を超えると
 * 尻尾が切られる**。だから `lion-blast` の素材は取り込み時に LION_BLAST_SE_MS まで
 * トリムしてある(lion-settle.spec.ts が不等式で凍結)。
 */
export const LION_BURST_STEP_MS = 245;

/** `lion-blast`(爆発音)の素材長。上の不等式 LION_BURST_STEP_MS × 4 ≥ この値 を守ること。 */
export const LION_BLAST_SE_MS = 900;

/** 上の不等式で参照する renderer/lib/se.ts の POOL_SIZE の写し(値の二重管理を spec が検算する)。 */
export const LION_SE_POOL_SIZE = 4;

/** 段⑤ 全面動画の尺。素材実尺(LION_BLAST_VIDEO_MS)と対。 */
export const LION_BLAST_MS = 10_000;

/**
 * 段⑥ 「合計」を見せる尺。ここで据え置きを解放するので、7セグが跳ねたあと
 * 視聴者が新しい残り数を読むための時間でもある。
 */
export const LION_TOTAL_DISPLAY_MS = 5_000;

/** 幕引きのフェード。.fx-clip-opaque の CSS transition と一致させること。 */
export const LION_FADE_MS = 400;

/** 1発あたりの加算額の既定(TikTok ギフト Lion = 29999💎 に合わせた額)。 */
export const LION_AMOUNT_EACH_DEFAULT = 29_999;

/** 発数の既定。1枚目 + 連打 49 発 = 50。合計 29,999 × 50 = 1,499,950。 */
export const LION_STEPS_DEFAULT = 50;

export const LION_AMOUNT_EACH_MIN = 1;
export const LION_AMOUNT_EACH_MAX = 999_999;

/**
 * 発数の上限。連打は `steps - 1` 本の setTimeout になるので、既存の
 * GIFT_FX_REPEAT_TIMERS_MAX(64)と同じ桁に収める。80 発で段④は 19.4 秒、
 * 総尺は 50.4 秒。
 */
export const LION_STEPS_MIN = 2;
export const LION_STEPS_MAX = 80;

/**
 * アーム期限(モニターが「発動時点で溜まっていたキュー」を消化し切るのを待つ上限)。
 * `UNIVERSE_ARM_MAX_MS` と同じ 120 秒 — 理由も同じで、バリア方式は溜まっていた
 * カットインを全部流し終えるまで待つため `BOOST_ARM_MAX_MS`(60秒)では足りない。
 */
export const LION_ARM_MAX_MS = 120_000;

/**
 * バリアで清算待ちにできる op の上限。`UNIVERSE_DEFERRED_OPS_MAX` と同じ 512
 * (43 秒のあいだ**全 op**を止めるので、革命の「fx 付きだけ」より溜まる量が多い)。
 */
export const LION_DEFERRED_OPS_MAX = 512;

/** 発数 → 連打の本数(1枚目は段②で出るので連打は steps − 1 本)。 */
export function lionBurstCount(steps: number): number {
  return Math.max(0, clampSteps(steps) - 1);
}

/**
 * 発数 → カットシーンの総尺(ms)。**worker と renderer の唯一の出所**。
 * worker はこれを effect の lionCutMs / fxDurationMs と凍結の尺に焼き込み、
 * モニターは planLionCut() を通して同じ値を段組みに使う。
 */
export function lionCutsceneMs(steps: number): number {
  return (
    LION_INTRO_MS +
    LION_FIRST_MS +
    LION_KAKUGO_MS +
    lionBurstCount(steps) * LION_BURST_STEP_MS +
    LION_BLAST_MS +
    LION_TOTAL_DISPLAY_MS
  );
}

/**
 * 発数 → **worker が値を動かす時刻**(カットシーン開始からの絶対オフセット)。
 * = 段⑥「合計」の頭。ここが `lionUntilMs`(清算)になる。
 *
 * universe が「演出の終端 == 清算」なのに対し、ライオンは**清算のあとに 5 秒の
 * 発表が残る**のが唯一の構造差 — 数字が動く瞬間を視聴者に見せるための段なので、
 * 清算を末尾に置くと「合計を読ませてから数字が動く」順序になってしまう。
 * worker の凍結はこの 5 秒ぶんを足して張ること。
 */
export function lionSettleAtMs(steps: number): number {
  return lionCutsceneMs(steps) - LION_TOTAL_DISPLAY_MS;
}

/**
 * `clampFutureMs` の上限(時計飛び・NTP 巻き戻しの安全弁)。演出は一発きりで
 * 延長も重ねがけも無いので、**発数が上限のときの清算時刻**そのもの。
 */
export const LION_MAX_MS = lionSettleAtMs(LION_STEPS_MAX);

/** カットシーンの各段(すべてカットシーン開始からの絶対オフセット ms)。 */
export interface LionCutPlan {
  /** 演出尺。0 = カットシーンを丸ごとスキップ(呼び出し側はバナーだけ出す)。 */
  totalMs: number;
  /** 1発あたりの加算額。 */
  amountEach: number;
  /** 発数(1枚目 + 連打)。 */
  steps: number;
  /** 加算合計 = amountEach × steps。段⑥で発表する数字。 */
  total: number;
  /** 段② 1枚目の「+N」が出る時刻。 */
  firstAtMs: number;
  /** 段③ ボイスが鳴る時刻(絵は②のまま)。 */
  kakugoAtMs: number;
  /** 段④ 連打の1発目の時刻。i 発目は burstAtMs + i × burstStepMs。 */
  burstAtMs: number;
  /** 連打の間隔。 */
  burstStepMs: number;
  /** 連打の本数(= steps − 1)。 */
  burstCount: number;
  /** 段⑤ 全面動画へ差し替える時刻(= 連打の終わり)。 */
  blastAtMs: number;
  /**
   * 段⑥ 「合計」発表の時刻。**ここが据え置き(holdValue)の解放点**でもある —
   * 7セグはこの瞬間まで発動前の値(押下ぶんだけ減る)を見せ、ここで跳ねる。
   */
  totalAtMs: number;
  /** 合計のカウントアップ尺(0 → total の easeOutCubic)。 */
  countupMs: number;
  /** 幕引きのフェードを始める時刻。 */
  fadeAtMs: number;
}

const EMPTY: LionCutPlan = {
  totalMs: 0,
  amountEach: 0,
  steps: 0,
  total: 0,
  firstAtMs: 0,
  kakugoAtMs: 0,
  burstAtMs: 0,
  burstStepMs: 0,
  burstCount: 0,
  blastAtMs: 0,
  totalAtMs: 0,
  countupMs: 0,
  fadeAtMs: 0,
};

function clampSteps(steps: number): number {
  if (!Number.isFinite(steps)) return LION_STEPS_DEFAULT;
  return Math.min(LION_STEPS_MAX, Math.max(LION_STEPS_MIN, Math.floor(steps)));
}

function clampAmountEach(amount: number): number {
  if (!Number.isFinite(amount)) return LION_AMOUNT_EACH_DEFAULT;
  return Math.min(LION_AMOUNT_EACH_MAX, Math.max(LION_AMOUNT_EACH_MIN, Math.floor(amount)));
}

/**
 * カットシーンのタイムラインを決める。
 *
 * `cutMs` は worker が焼き込んだ演出尺(0 = プレーン発動 / モニター不在 /
 * reduced-motion)。**段の時刻は cutMs からではなく steps から導出する** —
 * worker も lionCutsceneMs(steps) で焼くので両者は一致し、その等式は
 * lion-settle.spec.ts が凍結する。cutMs は「出すか出さないか」の合図として使う。
 */
export function planLionCut(input: {
  /** 1発あたりの加算額。 */
  amountEach: number;
  /** 発数(1枚目 + 連打)。 */
  steps: number;
  /** worker が焼き込んだ演出尺。0 以下ならカットシーンなし。 */
  cutMs: number;
}): LionCutPlan {
  if (!(input.cutMs > 0)) return EMPTY;
  const steps = clampSteps(input.steps);
  const amountEach = clampAmountEach(input.amountEach);
  const burstCount = lionBurstCount(steps);
  const firstAtMs = LION_INTRO_MS;
  const kakugoAtMs = firstAtMs + LION_FIRST_MS;
  const burstAtMs = kakugoAtMs + LION_KAKUGO_MS;
  const blastAtMs = burstAtMs + burstCount * LION_BURST_STEP_MS;
  const totalAtMs = blastAtMs + LION_BLAST_MS;
  const totalMs = totalAtMs + LION_TOTAL_DISPLAY_MS;
  return {
    totalMs,
    amountEach,
    steps,
    total: amountEach * steps,
    firstAtMs,
    kakugoAtMs,
    burstAtMs,
    burstStepMs: LION_BURST_STEP_MS,
    burstCount,
    blastAtMs,
    totalAtMs,
    // 合計は段⑥の中で読み切らせる。フェードに食い込ませない。
    countupMs: Math.max(0, LION_TOTAL_DISPLAY_MS - LION_FADE_MS * 2),
    fadeAtMs: Math.max(0, totalMs - LION_FADE_MS),
  };
}
