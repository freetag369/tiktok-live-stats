import type {
  ChallengeCommentRule,
  ChallengeConfig,
  ChallengeEffect,
  ChallengeGiftRule,
  ChallengeLogEntry,
  ChallengeRouletteConfig,
  ChallengeRouletteSegment,
  ChallengeSeSlot,
  ChallengeState,
  FanStampConfig,
  StampTriggerConfig,
  StampTriggerRule,
  TapBoostConfig,
  TapBoostRule,
  TapLockConfig,
  TapLockRule,
  RevolutionConfig,
  RevolutionRule,
  QuizConfig,
  QuizRule,
  FinalGateConfig,
  GiftBandFxConfig,
  GiftFullCutConfig,
  GiftFullCutRule,
  GiftFxBand,
  JoinRouletteConfig,
  RouletteCountView,
  RouletteHotConfig,
  RouletteHotMultCandidate,
  RoulettePattern,
  RouletteSoundConfig,
  RouletteSpinKey,
  RouletteTeaseConfig,
  GiftRepeatFxConfig,
} from './dto';
import {
  ROULETTE_COUNT_VIEWS,
  ROULETTE_PATTERNS,
  ROULETTE_PATTERN_TIER,
  ROULETTE_SELECTABLE_PATTERNS,
} from './dto';
import { WAKE_TIME_RE } from './time';
import {
  FULL_CUT_CLIPS,
  FULL_CUT_CLIPS_V3,
  FULL_CUT_CLIP_IDS,
  type FullCutClipDef,
} from './fx-cut';

/**
 * カウントダウンチャレンジ — 純関数のみ。状態機械は worker/challenge.ts。
 *
 * 「0まで寝ない」型の配信企画: ボタンで数字が減り、フォロー・いいねで増え(妨害)、
 * ギフトは規則表で増減が決まる。既定はギフトも妨害(ダイヤ数ぶん増える)。
 */

/**
 * recentEffects リングバッファの上限。モニターの演出再生分だけあれば足りる。
 *
 * 12 では足りなかった: press は1回1 effect を積むので、ホットキーのキーリピート
 * (~30/s)なら delta の 2Hz tick の間に12件を押し流し、直前に積まれたルーレットが
 * モニターへ配られる前にリングから落ちる(「演出が発生しない」の一因)。
 * ルーレットは「1ギフトメッセージ = 1 effect」(rouletteIndexes)にしたので
 * 連打ぶんの圧力は無くなったが、press 側の余裕としてここを広げてある。
 */
export const CHALLENGE_EFFECTS_MAX = 32;

/** CLEAR リザルト画面の各ランキング(ギフト/イイネ)の表示件数。 */
export const CHALLENGE_RESULT_TOP_N = 5;

/**
 * モニター下部の常時表示ギフトランキングの件数。CLEAR リザルトと同じ runViewers
 * から同じヘルパーで切り出すので、この TOP3 は必ず TOP5 の先頭3件と一致する。
 */
export const CHALLENGE_MONITOR_TOP_N = 3;

/**
 * like 演出の合算窓。like は全メッセージの約9割の高頻度なので、この窓の間は
 * 加算分を積んでおき1件の effect にまとめる(リングバッファを食い潰さない)。
 */
export const LIKE_FX_WINDOW_MS = 1000;

/**
 * ダッシュボードの履歴ログの上限。worker のリングバッファ(12件)と違い、これは
 * 「配信者があとから振り返る」ための長さ — 数分ぶん遡れれば足りる。
 */
export const CHALLENGE_LOG_MAX = 50;

/**
 * ルーレット演出の尺。monitor.css の @keyframes とモニターの据え置き解除タイマーを
 * ここで同期させる — 片方だけ変えると「数字は動いたのにリールが回っている」が起きる。
 * キーフレームは割合で書いてあるのでここだけで効く。
 *
 * 尺はパターンの段位(ROULETTE_PATTERN_TIER)で3段階 — パチンコの信頼度方式で、
 * レアな出目ほど長い段位のパターンが出やすい(抽選は roulette-fx.ts)。
 * 6000ms は light(通常変動)の尺 = 従来の全パターン共通値。段位ごとの走行距離
 * (roulette-fx.ts の RUN_BASE)を尺に比例させているので、序盤のリール速度は
 * 段位に依らずほぼ一定 — 長い焦らしが「初速の遅いスピン」に見えることはない。
 */
export const ROULETTE_SPIN_MS = 6000;
/** mid(中リーチ: kick/overrun/restart/teeter/blackout)の尺。light の 1.25 倍。 */
export const ROULETTE_SPIN_MID_MS = 7500;
/**
 * heavy(激アツ: doublefake/jackstop/jackslip/jackback)の尺。light の 2 倍。
 * ストレッチで打撃が鈍る分は monitor.css 側で非 cue の打撃キーフレームを詰めて
 * 補正している。JOIN_ROULETTE_MIN_GAP_MS はこの値 + 確定見せより長いこと。
 */
export const ROULETTE_SPIN_HEAVY_MS = 12000;
/**
 * 超激アツ(ultra)の振り付け(絶対 ms)。**尺はここから導出する。**
 *
 * ultra は全パターン共通の一本道(カウントダウン式の激アツ)なので、各拍の間合いを
 * 並べたこの表が唯一の権威で、ROULETTE_SPIN_ULTRA_MS はその総和。割合(0..1)への
 * 変換は roulette-fx.ts の ultraTiming()、動きの実体は monitor.css の
 * rl-run-ultra で、百分率はこの表から起こして roulette-css.spec が機械照合する。
 *
 * 流れ:
 *   走り込み → 再加速(3秒で速度2倍) → 効果音① + ドン(出目が ×2 に膨らむ)
 *   → [動画 → 溶暗 → マス移動 → 間 → ドン(×3 → ×4 → ×5) → 間] を3回
 *   → 動画4 → 溶暗 → マス移動(止まりそう) → 間 → マス移動(着地) → 溜め
 *   → ドン + 効果音②(戻り) + 出目が元に戻って確定
 *
 * 倍率は**見せかけ**(リールのマスの表示だけ)で、worker が確定済みの出目も
 * 7セグの据え置きも一切動かさない — RouletteFx.tsx の解説を参照。
 */
export const ROULETTE_ULTRA_BEATS = {
  /** 走り込み(減速)。ここまでは他段位と同じ初速に見える。 */
  runInMs: 5760,
  /**
   * 再加速。走り込みで残した距離をこの3秒で取り返し、**速度が2倍**になってから
   * 制動して当選の5マス手前に着く(マス移動が5回あるため)。走行距離
   * (roulette-fx.ts の RUN_BASE.ultra)は増やさない — 増やすと盤面を広げることになり、
   * リール実幅が伸びて OBS でコマ落ちする。
   */
  accelMs: 3000,
  /**
   * 効果音①+ドン(×2)から動画1が画面を覆うまでの読ませ時間。
   * **0 にすると倍率が見えないまま動画に隠れる** — この演出の主役は数字なので、
   * 覆う前に必ず読ませる。
   */
  leadMs: 900,
  /**
   * 動画4枠の実尺(ms)。素材(assets/fx/rl/<pattern>-<n>.mp4)は 24fps で
   * 93 / 72 / 57 / 52 フレームちょうどにトリムしてあり、この値はその換算
   * (端数は 0.33ms 以内)。**素材を差し替えるときはフレーム数を合わせること** —
   * ズレは半フレーム以内に保つ(roulette-fx.ts の clips の解説)。
   */
  clipMs: [3875, 3000, 2375, 2167],
  /** 動画終端の一撃から溶暗が終わり切るまで(= monitor.css の .rl-clip.out の尺)。 */
  fadeMs: 480,
  /** マス移動1回(行き過ぎ→据え)。 */
  stepMs: 480,
  /** 「間」。ドンの前後に等しく置く(ユーザー仕様の 0.5 秒)。 */
  gapMs: 500,
  /**
   * 着地してから**最後の数字変化(倍率が素へ戻る = 確定)**までの溜め。
   * ここだけ無音で引っぱる。2 秒では戻りが早すぎたのでユーザー指定で 3 秒。
   */
  tailMs: 3000,
} as const;

/**
 * ROULETTE_ULTRA_BEATS の総和 = ultra の尺。
 * 動画ごとに「溶暗 + マス移動」、間はドンの前後に2つずつ。最後の動画だけドンが無く、
 * 代わりに「間 + 5回目のマス移動」が入る。
 */
function ultraSpinMs(b: typeof ROULETTE_ULTRA_BEATS): number {
  const clips = b.clipMs.length;
  return (
    b.runInMs +
    b.accelMs +
    b.leadMs +
    b.clipMs.reduce((s, c) => s + c, 0) +
    clips * (b.fadeMs + b.stepMs) +
    (clips - 1) * 2 * b.gapMs +
    (b.gapMs + b.stepMs) +
    b.tailMs
  );
}

/**
 * ultra(超激アツ)の尺。全画面動画4本とマス移動5回、出目の倍率フェイクで構成される
 * 一本道で、値は ROULETTE_ULTRA_BEATS の総和(= 31,897ms)。他段位のような倍率設計
 * ではない。JOIN_ROULETTE_MIN_GAP_MS はこの値 + 確定見せ(ultra 用)より長いこと。
 */
export const ROULETTE_SPIN_ULTRA_MS = ultraSpinMs(ROULETTE_ULTRA_BEATS);
/**
 * 当選ブロックの発光(確定見せ)の尺。**確定するまで色を出さない**設計にした結果、
 * 色・符号・発光・確定音の全部がこの窓に入るので 600ms では山場が一瞬で終わる。
 */
export const ROULETTE_REVEAL_MS = 900;
/**
 * 超激アツ(ultra)の確定見せ。**膨らんだ出目が素へ戻った直後**という一番の山場なので、
 * 他段位の 900ms では ±N バナーが被さるのが早すぎる(ユーザー指定で 3 秒)。
 * ここを伸ばしても止まっているのは ultra だけ — 他段位の間合いには一切触れない。
 */
export const ROULETTE_REVEAL_ULTRA_MS = 3000;
/** 短縮スピンの確定見せ。短縮する場面では総尺を詰めたいので通常より短くする。 */
export const ROULETTE_REVEAL_FAST_MS = 450;
/**
 * 短縮スピンの尺。**発動条件の権威は roulette-spin.ts の planRouletteSpin** —
 * (a) 連打の ROULETTE_FULL_REELS 本目より後のリール、(b) 凍結明け/キュー満杯の
 * 合算 effect(coalesced ≥ 2)の2本目以降、の2つだけ。
 * キュー消化(別ギフトの並び)は短縮しない — 消化スピンもフル尺で回す。
 * 連打の序盤も短縮しない(2026-08-17 のユーザー決定で廃止 — 抽選パターンを
 * 捨てずに全部見せる)。
 *
 * 【この尺の下限は BANNER_MS】確定バナーは finishRoulette が**無条件 immediate**
 * で出し、バナーは単枠置換(showBannerNow の setFloats([1枚]))なので、
 * 「スピン + 確定見せ」= 確定バナーの再生周期がバナー尺(1600ms)を下回ると、
 * 前のリールの ±N が floatup の途中(旧 900+450=1350ms = 84% 地点 = まさに
 * 浮上区間)で DOM ごと消える。900 のままだと連打16本目以降と合算 effect
 * (coalesced ≥ 2)の2本目以降で**毎回**その早死にが起きていた。
 * 1150 + ROULETTE_REVEAL_FAST_MS(450) = 1600 = BANNER_MS。
 * 不変条件は fx-stage.spec.ts が固定する — **下げるならバナー尺ごと**。
 */
export const ROULETTE_SPIN_FAST_MS = 1150;
/**
 * **別のギフト**のスピンへ移るときの間合い(ms)。
 *
 * 以前はキューを間髪入れず短縮スピンで流していたため、別々の視聴者のハートミーが
 * 6.9秒の窓に重なると「誰の分か読めない高速連鎖」になっていた(実測で3〜6連鎖が
 * 常態)。確定バナーを読める長さをここで確保する。
 * **同じギフト(コンボ)内のスピンには入れない** — 同一人物の連打なので誰の分かを
 * 読み直す必要がなく、17連打が間合いぶん更に伸びるだけになる。
 */
export const ROULETTE_CHAIN_GAP_MS = 600;
/**
 * モニターの連続再生キュー上限。**数えるのはスピン数ではなくギフト件数**
 * (1ギフトメッセージ = 1 effect で、連打ぶんの出目は rouletteIndexes に入る)。
 * 溢れた分は破棄せず末尾の同一盤面 effect へ連結するので、ここは
 * 「盤面違いが何件まで並べるか」の上限として効く。
 */
export const ROULETTE_QUEUE_MAX = 24;
/**
 * 1ギフトメッセージあたりの**抽選回数**のハード上限。
 * 演出用の giftRepeatFx.max とは別物 — あちらで削ると贈られた個数ぶんの値が
 * 消える(v0.5.4 の不具合)。ここは CPU / effect サイズの番人でしかないので、
 * 実在する最大コンボ(実測で repeatCount 100 のギフトがある)より十分大きく取る。
 */
export const ROULETTE_DRAWS_MAX = 200;
/**
 * 1ギフトメッセージあたり実際にリールを回す本数の上限。
 * これを超える連打は残りを合算バナー1枚で締める(**値は抽選回数ぶん全部
 * 適用済み** — 削るのは見た目だけ)。
 */
export const ROULETTE_REELS_MAX = 20;
/**
 * **フル尺で回すリールの本数。** 1〜ROULETTE_FULL_REELS 本目は抽選パターン
 * どおりの尺(rouletteSpinMs = 6/7.5/12/24秒)、それ以降 ROULETTE_REELS_MAX
 * 本目までは fast(1150 + 450ms)、超過は合算バナー1枚。
 * **ROULETTE_REELS_MAX 以下であること**(roulette-spin.spec が凍結)。
 *
 * 尺の予算(既定盤面 30/25/20/15/9/1% での段位分布 light 66.5 / mid 25.3 /
 * heavy 6.6 / ultra 1.6%):
 * - 1本の期待値 ≒ 7.96秒 → **実勢の最悪 ≒ 15×7.96 + 5×1.6 ≒ 2分5秒**
 * - 理論最悪(15本すべて ultra)は 15×34.9 + 5×1.6 ≒ 531秒。到達確率は
 *   0.016^15 ≒ 10^-28 なので設計制約として扱わない
 * - **激熱確定(hot)だけは 100% 発動なので確率の議論が効かない。** 1本は
 *   導入 8 秒 + スピン 31.9 秒 + 確定見せ 3 秒 ≒ **42.9 秒**で、15本回すと
 *   ≒ 10分43秒。専用ギフト行でしか出ないうえ本数はユーザー決定(2026-08-18)なので
 *   ここでは絞らない — **絞るなら ROULETTE_FULL_REELS ではなく激熱専用の定数を足すこと**
 *   (通常のルーレットの本数まで巻き添えにしないため)
 * - **他演出の最大待ちは総尺ではなく「1リールの尺」(通常 最長 34.9秒 /
 *   激熱確定 最長 42.9秒)** —
 *   finishRoulette の §6b(shouldYieldSpinChain)がリール境界ごとに上位序列へ
 *   譲るため。PENDING_BANDS_MAX / BOOST_ARM_MAX_MS の見積りはこちらで読むこと
 *
 * ≤v0.7.7 は「1本目だけ段位の尺・2本目以降は必ず fast」で最悪 50.5秒だった。
 * 2026-08-17 のユーザー決定で本数による歯止めへ置換(抽選済みのパターンを
 * 捨てずに全部見せる)。
 */
export const ROULETTE_FULL_REELS = 15;
/**
 * 据え置きの安全弁。onAnimationEnd が来なくても(タブ非表示等)この時刻で必ず
 * ラッチを解いて worker 値へ収束させる — startStrike の STRIKE_ABORT_MS と同じ役割。
 * 尺は段位で変わるので、定数としては最長(ultra)の最悪値。実際の解除タイマーは
 * rouletteAbortMs(パターン別)で張る。
 */
export const ROULETTE_ABORT_MS = ROULETTE_SPIN_ULTRA_MS + ROULETTE_REVEAL_ULTRA_MS + 1500;

// ── 激熱確定(hot)────────────────────────────────────────────────────────────
//
// 通常の超激アツは出目を ×2→×3→×4→×5 と膨らませてから**元へ戻して**確定する
// (RouletteFx.tsx の mult は見せかけ専用)。激熱確定は同じ振り付けのまま
// **膨らんだ数字がそのまま確定する** — 倍率は worker が値へ適用済みで、
// effect の rouletteHotMult に焼かれる。設定はギフトルーレット行ごと(cfg.roulettes[].hot)。

/**
 * 激熱確定の倍率の下限。**5 未満にしないこと** — ドン(donAts)は 4 発あり、
 * rouletteHotMults は相異なる 4 段の整数を返す必要がある。下限 5 のとき段は
 * ちょうど ×2→×3→×4→×5 = 従来の超激アツと同じ見た目になり、ここが自然な底になる。
 */
export const ROULETTE_HOT_MULT_MIN = 5;
/** 激熱確定の倍率の上限(ユーザー決定 2026-08-18)。 */
export const ROULETTE_HOT_MULT_MAX = 50;
/** 倍率候補(hot.multipliers)の上限件数。盤面(ROULETTE_SEGMENTS_MAX)と同じ形式・同じ上限。 */
export const ROULETTE_HOT_MULT_CANDIDATES_MAX = 12;
/**
 * 激熱確定の導入動画の尺(ms)。**スロットに入る前**に全画面で流す(ユーザー指定 8 秒)。
 * スピン尺(rouletteSpinMs)の外側なので、据え置きの安全弁・ホールド番犬の期限は
 * rouletteHotIntroMs() を足して張ること — 足さないと導入中に番犬が発火して
 * リールが回る前に数字が最終値へ飛ぶ(出目の先漏れ)。
 */
export const ROULETTE_HOT_INTRO_MS = 8000;
/**
 * 激熱確定で使う超激アツパターン(= 導入動画の絵柄)。ユーザー指定の3種:
 * ❶ライオン→獅子 ❷ドラゴンの炎→黄金龍 ❸フェニックス→不死鳥。
 * 導入動画は assets/fx/rl/hot/<pattern>.mp4 で、スピン本体は既存の ultra 素材を流用する。
 * **行の patterns(設定のチェック)は激熱行では見ない** — 3種に固定するのが仕様。
 *
 * **ギフト連動の行はここを見ない**(下の ROULETTE_HOT_GIFT_PATTERNS)。この配列は
 * 「絵柄を指定していない激熱行が抽選で引く候補」であって、激熱の絵柄の全体ではない
 * — 全体が要るところ(素材カタログの突合)は ROULETTE_HOT_INTRO_PATTERNS を使うこと。
 */
export const ROULETTE_HOT_PATTERNS: readonly RoulettePattern[] = ['lion', 'dragon', 'phoenix'];

/**
 * ギフト連動で絵柄が **100% 固定**される激熱行の表。
 *
 * 「DJメガネを投げたら DJメガネの演出」をユーザー設定なしで成立させるためのもの
 * (設定項目を増やさないのがユーザー決定)。ここに載ったギフトの激熱行は、抽選を
 * 通さず必ずその絵柄になる。
 *
 * **giftId が権威**(ライブ経路では canonical が未代入で、giftName は配信の言語設定で
 * 変わる — matchGiftTrigger の解説を参照)。giftName / canonical は「ユーザーが ID を
 * 消して名前トリガーに変えた行」も拾うための保険で、**完全一致でしか当てない**
 * (exactName: true)。部分一致にすると giftName:'a' のような短いトリガーを持つ
 * 無関係な激熱行が DJ の絵柄に化ける。
 */
export const ROULETTE_HOT_GIFT_PATTERNS: readonly {
  /** 固定する絵柄。ROULETTE_HOT_ONLY_PATTERNS(激熱専用)である必要はない。 */
  pattern: RoulettePattern;
  /** 照合に使うギフトの指紋。matchGiftTrigger の g 側に渡す形。 */
  gift: { giftId: string; giftName: string; canonical: string };
  /** 設定画面の説明文に出す名前。 */
  label: string;
}[] = [
  {
    pattern: 'djglasses',
    gift: { giftId: '11583', giftName: 'dj glasses', canonical: 'dj_glasses' },
    label: 'DJメガネ',
  },
  {
    pattern: 'unicorngift',
    // 絵柄のスラッグが 'unicorn' でないのは、そちらが一角獣の通常パターンで埋まっているため。
    // ここは exactName: true で照合するので 'unicorn' でも 'Unicorn Fantasy' は拾わない。
    gift: { giftId: '12453', giftName: 'unicorn', canonical: '' },
    label: 'ユニコーン',
  },
  {
    pattern: 'bunnydj',
    gift: { giftId: '437679', giftName: 'bunny dj', canonical: '' },
    label: 'バニーDJ',
  },
];

/**
 * 激熱行 → 絵柄の候補。**worker の抽選点はこの1本だけを使うこと。**
 *
 * ギフト連動なら**1要素の配列**を返す。呼び出し側は今までどおり drawRoulettePattern に
 * 渡すので、**fxRand の消費はちょうど1回のまま**(「1抽選 = 1消費」は出目の再現性の
 * 前提で、テストが固定している)。早期 return で drawRoulettePattern を飛ばすと
 * 消費数が変わって同じ seed の再生が別物になる。
 *
 * rl が null/undefined(入室ルーレットの試写など、ギフト行が引けない経路)は
 * 従来どおり3種の抽選へ倒す。
 */
export function rouletteHotPatternPool(
  rl: { giftId: string; giftName: string; canonical: string } | null | undefined
): readonly RoulettePattern[] {
  if (rl != null) {
    for (const g of ROULETTE_HOT_GIFT_PATTERNS) {
      if (matchGiftTrigger({ ...rl, exactName: true }, g.gift)) return [g.pattern];
    }
  }
  return ROULETTE_HOT_PATTERNS;
}

/**
 * 激熱で**導入動画が要る絵柄の全体** = 抽選の3種 + ギフト連動の絵柄。
 * assets/fx/rl/hot/<pattern>.mp4 と 1:1 になる(roulette-clip-catalog.spec.ts が突合)。
 * 並びは ROULETTE_PATTERNS の正順。
 */
export const ROULETTE_HOT_INTRO_PATTERNS: readonly RoulettePattern[] = ROULETTE_PATTERNS.filter(
  (p) => ROULETTE_HOT_PATTERNS.includes(p) || ROULETTE_HOT_GIFT_PATTERNS.some((g) => g.pattern === p)
);
/**
 * 激熱確定の専用キュー(モニターの優先度⑧)の上限。1本が導入 8 秒 + スピン 31.9 秒 +
 * 確定見せ 3 秒 ≒ 43 秒なので、8 件で約 5.7 分。溢れは捨てず末尾の同一盤面へ
 * mergeRoulette で連結する(ギフトルーレットと同じ規約)。
 */
export const ROULETTE_HOT_QUEUE_MAX = 8;

/** 激熱確定の既定値。**DEFAULT_ROULETTE には載せない**(キー欠損 = 無効が既定)。 */
export const DEFAULT_ROULETTE_HOT: RouletteHotConfig = { enabled: false, multiplier: 10 };

/**
 * 激熱倍率の clamp。**倍率に触る全経路がこの1本を通ること。**
 *
 * 検証(validateRouletteHot)・worker の適用(rouletteHotMultiplier)・effect からの
 * 復元(rouletteHotMultOf)・段のはしご(rouletteHotMults)が別々の式を持つと、
 * 「worker は ×3 を適用したのにリールは ×5 まで上がる」のような食い違いが生まれ、
 * リールが止まった瞬間に数字が飛ぶ。範囲は ROULETTE_HOT_MULT_MIN..MAX。
 */
export function clampRouletteHotMult(m: number): number {
  const r = Number.isFinite(m) ? Math.round(m) : ROULETTE_HOT_MULT_MIN;
  return Math.min(ROULETTE_HOT_MULT_MAX, Math.max(ROULETTE_HOT_MULT_MIN, r));
}

/**
 * 設定 → 実際に掛ける倍率(**従来形=単一倍率の縮退経路**)。無効・未設定は 1
 * (= 通常のルーレット)。候補列(multipliers)対応の抽選は drawRouletteHotMult —
 * worker の適用点はそちらの1本を使う(内部で従来形はここへ縮退する)。
 */
export function rouletteHotMultiplier(hot: RouletteHotConfig | undefined): number {
  return hot?.enabled ? clampRouletteHotMult(hot.multiplier) : 1;
}

/**
 * 倍率候補の重みの clamp(0..999,999 の整数)。**候補サニタイズと設定UIの入力の
 * 両方がこの1本を通ること** — UI が丸めずに小数・負値を draft へ載せると、
 * 保存時の丸めで「weight>0 の有無」や代表値の序列が変わり、編集した候補行が
 * 保存の瞬間に黙って畳まれる(commit の出力 = validate の正規形、の前提が割れる)。
 */
export function clampRouletteHotWeight(w: number): number {
  const r = Number.isFinite(w) ? Math.round(w) : 0;
  return Math.min(999_999, Math.max(0, r));
}

/**
 * 倍率候補列のサニタイズ(内部)。非配列は null、それ以外は有限数の要素だけ残して
 * clamp した列を返す(0件もありうる)。**「2件以上」ゲートは掛けない** —
 * validateRouletteHot が「ちょうど1件は従来形へ畳む」判定に列の長さを使うため。
 * 仕様は sanitizeRouletteSegments と同型(multiplier は clampRouletteHotMult、
 * weight は clampRouletteHotWeight)。
 */
function sanitizeRouletteHotMultList(raw: unknown): RouletteHotMultCandidate[] | null {
  if (!Array.isArray(raw)) return null;
  return raw
    .filter(
      (c): c is RouletteHotMultCandidate =>
        !!c &&
        typeof c === 'object' &&
        typeof c.multiplier === 'number' &&
        Number.isFinite(c.multiplier) &&
        typeof c.weight === 'number' &&
        Number.isFinite(c.weight)
    )
    .slice(0, ROULETTE_HOT_MULT_CANDIDATES_MAX)
    .map((c) => ({
      multiplier: clampRouletteHotMult(c.multiplier),
      weight: clampRouletteHotWeight(c.weight),
    }));
}

/**
 * hot 設定 → 抽選に使える倍率候補列。**候補サニタイズの唯一の入口** —
 * 検証(validateRouletteHot)と worker の抽選(drawRouletteHotMult)の両方がここを
 * 通るので、検証を迂回した手編集の settings.json でも両者の答えが一致する
 * (direction:'sub' の二重防御と同じ思想)。
 *
 * **null = 従来形(単一 multiplier)で動く**。null になるのは: multipliers キーが
 * 無い / 非配列 / サニタイズ後 2 件未満 / 全 weight 0。「2件以上」を要求するのは
 * 正規形(キー存在 ⇔ 候補2件以上)の抽選側の担保 — 1件の候補列は validate が
 * 従来形へ畳むので、ここで受ける必要がない。全 weight 0 を落とすのは
 * drawRouletteIndex が Σweight<=0 のとき **rand を消費せずに**最終行へ倒れるため —
 * 通すと「候補列があるのに消費0」の経路が生まれ、消費規約(候補列が実在する
 * ときだけちょうど1回)が壊れる。
 */
export function rouletteHotMultCandidates(
  hot: RouletteHotConfig | null | undefined
): RouletteHotMultCandidate[] | null {
  const list = sanitizeRouletteHotMultList(hot?.multipliers);
  if (!list || list.length < 2 || !list.some((c) => c.weight > 0)) return null;
  return list;
}

/**
 * 候補列 → 代表倍率(最大 weight・同率先勝ち)。validateRouletteHot が従来形の
 * multiplier へ焼き直す値と、設定画面の要約表示が共用する。空列は既定倍率
 * (呼び元が空を渡さないのが原則 — クラッシュ源を作らないための保険)。
 */
export function rouletteHotRepresentativeMult(cands: readonly RouletteHotMultCandidate[]): number {
  if (cands.length === 0) return DEFAULT_ROULETTE_HOT.multiplier;
  let best = cands[0]!;
  for (const c of cands) if (c.weight > best.weight) best = c;
  return clampRouletteHotMult(best.multiplier);
}

/**
 * 設定 → 実際に掛ける倍率(**worker の適用点はこの1本だけ**)。
 *
 * 乱数消費の規約: **候補列が実在する(rouletteHotMultCandidates が非 null)とき
 * だけ rand をちょうど1回消費**する。無効・従来形(単一 multiplier)は消費 0 —
 * 既存テストの rand 固定(出目の再現性)を壊さないための境界で、テストが凍結する。
 * 倍率は値に効くので rand は**出目側(this.rand)**を渡すこと(fxRand は演出専用)。
 *
 * 重み抽選の実装は drawRouletteIndex を流用する(二重実装しない)。effect ごとに
 * 高々1回・最大12要素なので載せ替えの割り付けコストは無視できる。
 */
export function drawRouletteHotMult(hot: RouletteHotConfig | undefined, rand: () => number): number {
  if (!hot?.enabled) return 1;
  const cands = rouletteHotMultCandidates(hot);
  if (!cands) return rouletteHotMultiplier(hot);
  const idx = drawRouletteIndex(
    cands.map((c) => ({ amount: c.multiplier, weight: c.weight })),
    rand
  );
  return clampRouletteHotMult(cands[idx]!.multiplier);
}

/**
 * effect → 実際に掛かっている倍率。載っていない/壊れている(0・負・非有限)は 1。
 * **rouletteDraws と RouletteFx の段が同じ天井を見る**ための唯一の入口。
 */
export function rouletteHotMultOf(e: ChallengeEffect): number {
  const m = e.rouletteHotMult;
  if (m == null || !Number.isFinite(m) || Math.round(m) <= 1) return 1;
  return clampRouletteHotMult(m);
}

/**
 * 設定倍率 m → ドン4発ぶんの表示倍率(段のはしご)。
 *
 * 等比 `round(m ** ((i+1)/4))` に「前の段より必ず 1 以上大きい」単調補正を掛け、
 * 最後の段は必ず m ちょうどにする。等比にするのは、どの段でも「上がり幅の体感」が
 * 揃うから — 等差(×13→×25→×38→×50)だと最初の1発で山場が終わってしまう。
 *
 *   m=5  → [2, 3, 4, 5]   (= 従来の超激アツと同じ段)
 *   m=10 → [2, 3, 6, 10]
 *   m=20 → [2, 4, 9, 20]
 *   m=50 → [3, 7, 19, 50]
 *
 * 段数は donAts の長さ(4)と一致していること。**m ≧ ROULETTE_HOT_MULT_MIN(5)が前提** —
 * 単調補正は最悪でも 2,3,4 を作るので、m が 5 以上なら末項が必ず途中の段より大きい。
 */
export const ROULETTE_HOT_DON_STEPS = 4;
export function rouletteHotMults(m: number): number[] {
  const top = clampRouletteHotMult(m);
  const out: number[] = [];
  for (let i = 1; i <= ROULETTE_HOT_DON_STEPS; i++) {
    const prev = out[out.length - 1] ?? 1;
    // 最終段は設定値ちょうど。途中段は等比 → 単調補正(前段 + 1 を下回らせない)。
    const v =
      i === ROULETTE_HOT_DON_STEPS
        ? top
        : Math.max(Math.round(top ** (i / ROULETTE_HOT_DON_STEPS)), prev + 1);
    out.push(v);
  }
  return out;
}

/**
 * effect 1件 → 導入動画の尺(ms)。激熱でなければ 0。
 * **モニターの安全弁・番犬・尺見積りは全部この1本から導くこと**(片方だけ足すと
 * 導入中にホールドが強制解除される)。
 */
export function rouletteHotIntroMs(e: ChallengeEffect): number {
  return e.rouletteHotMult != null ? ROULETTE_HOT_INTRO_MS : 0;
}

/**
 * スピン1本の実尺と安全弁。fast(キュー消化)と通常で尺が違い、通常は更に段位で
 * 4段階 — 片方だけ見て調整すると必ずもう片方が壊れるので、全経路をここに集約する。
 */
export function rouletteSpinMs(key: RouletteSpinKey): number {
  if (key === 'fast') return ROULETTE_SPIN_FAST_MS;
  const tier = ROULETTE_PATTERN_TIER[key];
  return tier === 'ultra'
    ? ROULETTE_SPIN_ULTRA_MS
    : tier === 'heavy'
      ? ROULETTE_SPIN_HEAVY_MS
      : tier === 'mid'
        ? ROULETTE_SPIN_MID_MS
        : ROULETTE_SPIN_MS;
}
/** 確定見せは段位で変えない(尺の緩急は焦らし側で付ける)。fast だけ短縮。 */
export function rouletteRevealMs(key: RouletteSpinKey): number {
  if (key === 'fast') return ROULETTE_REVEAL_FAST_MS;
  // ultra だけ長い — 倍率が素へ戻った直後が山場なので、±N バナーをすぐ被せない。
  return ROULETTE_PATTERN_TIER[key] === 'ultra' ? ROULETTE_REVEAL_ULTRA_MS : ROULETTE_REVEAL_MS;
}
/** 据え置きの安全弁(ms)。実尺 + 確定見せ + 余裕。どのキーでも必ずアニメより後。 */
export function rouletteAbortMs(key: RouletteSpinKey): number {
  return rouletteSpinMs(key) + rouletteRevealMs(key) + 1500;
}

/**
 * recentEffects を履歴ログへ取り込む。純関数(テスト可能)。
 *
 * 規約:
 * - lastId より新しい effect だけを古い順に積む(watermark 方式。演出再生と同じ)。
 * - **演出と違い「マウント直後は全件再生済みに倒す」はしない。** ログにストーム
 *   問題は無く、リロード直後に空だと「さっき何が起きたか」が消えてしまう。
 *   同じ理由で「5秒より古い effect はスキップ」もしない。
 * - **watermark は絶対に後退しない。** かつては「lastId > maxId なら worker 再起動」
 *   と見なして 0 へ倒していたが、この判定は**古いスナップショットの後着**でも
 *   成立してしまう(press RPC の返り値は setChallenge が即時適用、delta は rAF
 *   コアレスで遅延 — liveStore.ts 参照)。成立した瞬間にリング内の effect が
 *   丸ごと再取り込みされ、同じギフトの行が二重に積まれていた。
 *   worker 再起動の追従は呼び出し側が lastId=null を渡して行う(workerEpoch)。
 * - 連続する press は1行に畳む。連打で他の行が全部押し流されるのを防ぐ。
 *
 * 戻り値の log は**新しい順**(index 0 が最新)。
 */
export function appendChallengeLog(
  log: readonly ChallengeLogEntry[],
  state: ChallengeState,
  lastId: number | null
): { log: ChallengeLogEntry[]; lastId: number } {
  const effects = state.recentEffects;
  const maxId = effects.reduce((m, e) => Math.max(m, e.id), 0);
  // null(初回・worker 再起動の明示リセット)だけが 0 から取り込み直す。
  const from = lastId ?? 0;
  // test(演出テスト再生)はログに積まない — 値に影響しない偽の行が履歴を汚す。
  // maxId は全件で計算済みなので watermark はテスト分も通過する。
  const fresh = effects.filter((e) => e.id > from && e.test !== true).sort((a, b) => a.id - b.id);
  // 古いスナップショットが後着しても watermark は下げない(max で受ける)。
  if (fresh.length === 0) return { log: log as ChallengeLogEntry[], lastId: Math.max(from, maxId) };

  const out = log.slice();
  for (const e of fresh) {
    const head = out[0];
    // 連続 press の畳み込み。間に他の kind が挟まったら新しい行を立てる。
    // e が凍結ドレインの合算(coalesced)なら、その件数ぶんまとめて数える。
    if (e.kind === 'press' && head?.kind === 'press') {
      out[0] = {
        ...head,
        atMs: e.atMs,
        amount: head.amount + e.amount,
        valueAfter: e.valueAfter,
        count: (head.count ?? 1) + (e.coalesced ?? 1),
      };
      continue;
    }
    out.unshift(entryFor(e, state));
  }
  return { log: out.slice(0, CHALLENGE_LOG_MAX), lastId: Math.max(from, maxId) };
}

/** effect 1件 → ログ行。undefined のフィールドは載せない(JSON 比較を素直に保つ)。 */
function entryFor(e: ChallengeEffect, state: ChallengeState): ChallengeLogEntry {
  const lg = state.likeGauge;
  return {
    id: e.id,
    kind: e.kind,
    atMs: e.atMs,
    amount: e.amount,
    valueAfter: e.valueAfter,
    ...(e.nickname ? { nickname: e.nickname } : {}),
    ...(e.giftName ? { giftName: e.giftName } : {}),
    ...(e.giftCount ? { giftCount: e.giftCount } : {}),
    ...(e.giftIconUrl ? { giftIconUrl: e.giftIconUrl } : {}),
    ...(e.diamonds != null ? { diamonds: e.diamonds } : {}),
    ...(e.rouletteLabel ? { rouletteLabel: e.rouletteLabel } : {}),
    // like 行の「◯件で+N」は取り込み時の設定で固定する — あとで設定を変えても
    // 過去の行が書き換わらないようにするため。
    ...(e.kind === 'like' && lg ? { likeEvery: lg.every, likeStep: lg.step } : {}),
    ...(e.commentKeyword ? { commentKeyword: e.commentKeyword } : {}),
    // ブーストの倍率・タップ数は effect の焼き込み値をそのまま引き継ぐ
    // (表示時に cfg を読むと、設定変更で過去の行が書き換わる — 上と同じ規約)。
    ...(e.boostMultiplier != null ? { boostMultiplier: e.boostMultiplier } : {}),
    ...(e.boostTapCount != null ? { boostTapCount: e.boostTapCount } : {}),
    // お邪魔の尺も同じ規約で焼き込み値を引き継ぐ(設定を変えても過去の行は不変)。
    ...(e.tapLockMs != null ? { tapLockMs: e.tapLockMs } : {}),
    // 革命の倍率・尺も同じ規約(revolution-start/-end の焼き込み値)。
    ...(e.revolutionMultiplier != null ? { revolutionMultiplier: e.revolutionMultiplier } : {}),
    ...(e.revolutionMs != null ? { revolutionMs: e.revolutionMs } : {}),
    // 窓の戦果(revolution-end のみ)。revolutionResultMs は**引き継がない** —
    // あれは演出の尺で履歴の情報ではない(boostResultMs をログに載せないのと同じ)。
    ...(e.revolutionDownTotal != null ? { revolutionDownTotal: e.revolutionDownTotal } : {}),
    ...(e.revolutionTapCount != null ? { revolutionTapCount: e.revolutionTapCount } : {}),
    ...(e.revolutionLikeDown != null ? { revolutionLikeDown: e.revolutionLikeDown } : {}),
    // お題ルーレットの本文・票数も同じ規約(quiz-start/-end の焼き込み値)。
    // quizResultMs は演出の尺なので引き継がない(revolutionResultMs と同じ判断)。
    ...(e.quizPrompt ? { quizPrompt: e.quizPrompt } : {}),
    ...(e.quizGood != null ? { quizGood: e.quizGood } : {}),
    ...(e.quizBad != null ? { quizBad: e.quizBad } : {}),
    // 凍結ドレインの合算件数 → 履歴の「×N」表示(press 畳み込みと同じ概念)。
    ...(e.coalesced != null && e.coalesced > 1 ? { count: e.coalesced } : {}),
  };
}

/** 効果音を割り当てられる演出スロット(設定UIの行順)。 */
export const CHALLENGE_SE_SLOTS: readonly ChallengeSeSlot[] = [
  'press',
  'follow',
  'like',
  'gauge-full',
  'stock-full',
  'comment',
  'gift-t1',
  'gift-t2',
  'gift-t3',
  'gift-t4',
  'helper',
  'roulette',
  'roulette-near',
  'roulette-kick',
  'roulette-hit',
  'roulette-hype',
  'roulette-hype-back',
  'boost-start',
  'boost-end',
  'achieved',
];

/**
 * 同梱している効果音の id 一覧(実ファイルとラベルは renderer/lib/se.ts)。
 * validate はこのリストで割り当てを検証する — 未知の id は既定に戻す。
 * 'off' は「このスロットは鳴らさない」。
 */
export const CHALLENGE_SE_SOUND_IDS: readonly string[] = [
  'click-soft',
  'tick',
  'pop',
  'pluck',
  'bong',
  'question',
  'alert',
  'confirm-1',
  'confirm-2',
  'confirm-3',
  'jingle-hit',
  'jingle-steel',
  'jingle-pizzi',
  'jingle-sax',
  'fanfare-8bit',
  'fanfare-8bit-short',
  'like-jam',
  'follow-jam',
  'reel-stop',
  'reel-confirm',
  // 演出ごとの専用録り(assets/se/CREDITS.md の「作者提供の専用音」)。
  // 'boost-final' だけどのスロットの既定でもない — 手で割り当てる用の選択肢。
  'gauge-burst',
  'stock-burst',
  'helper-stamp',
  'comment-jam',
  'boost-tap',
  'boost-final',
  'boost-hit',
  'reel-kick',
  'reel-hit',
  'clear-fanfare',
  // 超激アツ(ultra)のカウントダウン式演出用のボイス。前4つが開始側(roulette-hype)、
  // 後3つが戻り側(roulette-hype-back)の想定だが、**どのスロットにも割り当てられる** —
  // カタログは1本で、スロットごとの絞り込みはしない(既存の流儀)。
  'hype-kakugo',
  'hype-iyashi',
  'hype-yoroshiku',
  'hype-kiitenaiyo',
  'back-kuh',
  'back-uh',
  'back-ite',
];

/**
 * 演出クリップ(映像)の id 一覧。実ファイルとラベルは renderer/lib/fx.ts。
 * validate はこのリストで割り当てを検証する — 未知の id は 'off' に倒す。
 * 'off' は「この規則ではクリップを出さない」。
 *
 * gift-t1〜t4 は「ダイヤ数の段階」の汎用クリップ。全面カット・帯域の
 * ドロップダウンから選べる(スロット名 gift-t1〜t4 の由来でもある)。
 */
export const CHALLENGE_FX_CLIP_IDS: readonly string[] = [
  'gift-t1',
  'gift-t2',
  'gift-t3',
  'gift-t4',
  'gift-band1',
  'gift-band2',
  'gift-band3',
  'gift-band4',
  // 全面カットの id は shared/fx-cut.ts が唯一の出所。ここに手で足さないこと
  //(足すと renderer/lib/fx.ts のカタログと静かにズレる)。
  ...FULL_CUT_CLIP_IDS,
];

/**
 * 簡易演出(素材を持たない SVG + CSS の軽量アニメ)の id 一覧。
 * 実体は renderer/monitor/MiniFx.tsx、動きは monitor.css の @keyframes。
 * validate はこのリストで割り当てを検証する — 未知の id は 'off' に倒す。
 *
 * 映像クリップ(CHALLENGE_FX_CLIP_IDS)と違い mp4 を持たないので、
 * 高頻度イベント(ハートミー・いいね・フォロー)でも画面が埋まらない。
 *
 * 'panic' だけは例外で写真素材(assets/fx/mini/panic-man.webp ≒ 97KB)を1枚持つ。
 * mp4 のようなデコード待ちが無く、1枚を使い回すので実質 SVG 勢と同じ軽さ。
 */
export const CHALLENGE_MINI_IDS: readonly string[] = ['hammer', 'stamp', 'shock', 'panic'];

/**
 * 演出スロットごとの簡易演出の既定。スロットは効果音と同じ CHALLENGE_SE_SLOTS。
 * press は既定 off — 連打のたびに DOM アニメを積むと重く、canvas のリング波紋で足りる。
 */
export const DEFAULT_MINI_FX: Record<ChallengeSeSlot, string> = {
  press: 'off',
  // フォローは「妨害」— カウントが戻される絶望を写真カットインで受ける。
  follow: 'panic',
  like: 'shock',
  'gauge-full': 'off',
  'stock-full': 'off',
  // 指定コメント妨害は既定 off — 連投されうるので簡易演出まで出すと画面がうるさい。
  comment: 'off',
  'gift-t1': 'stamp',
  'gift-t2': 'off',
  'gift-t3': 'off',
  'gift-t4': 'off',
  // お助け(ファンスタンプ)は専用スロットになる前は gift-t1 を流用していたので、
  // 既定はその 'stamp' のまま — アップデートで見え方を変えない。
  helper: 'stamp',
  // ルーレットはリール自体が主演出なので簡易演出は既定 off。
  roulette: 'off',
  'roulette-near': 'off',
  'roulette-kick': 'off',
  'roulette-hit': 'off',
  // 超激アツは全画面動画とリールが主演出。簡易演出を重ねると幕の上が渋滞する。
  'roulette-hype': 'off',
  'roulette-hype-back': 'off',
  // ブーストはカットイン+カウンタが主演出なので簡易演出は既定 off。
  'boost-start': 'off',
  'boost-end': 'off',
  achieved: 'off',
};

export const DEFAULT_SE_SOUNDS: Record<ChallengeSeSlot, string> = {
  press: 'click-soft',
  // 妨害の2スロットだけ専用音。旧既定(question / pop)は選択肢としてカタログに残る
  // — 既存 settings.json の寄せ替えは migrateChallengeSeSounds が一度だけ行う。
  follow: 'follow-jam',
  like: 'like-jam',
  // 妨害の2つに続いて、演出ごとの専用録りへ差し替えた9スロット。旧既定
  // (jingle-hit / jingle-steel / pop / confirm-1 / bong / reel-confirm /
  //  jingle-steel / fanfare-8bit-short / fanfare-8bit)は選択肢としてカタログに
  // 残る — 保存済み settings.json の寄せ替えは migrateChallengeSeSounds の v5 が行う。
  'gauge-full': 'gauge-burst',
  'stock-full': 'stock-burst',
  comment: 'comment-jam',
  'gift-t1': 'confirm-1',
  'gift-t2': 'confirm-2',
  'gift-t3': 'jingle-hit',
  'gift-t4': 'jingle-steel',
  helper: 'helper-stamp',
  // 回転開始はチクタク感のある tick。
  roulette: 'tick',
  // 「止まりそう」(当選の1つ手前に着いて溜めに入る瞬間)はスイッチのカチッ。
  // ここだけ専用録りが無いので reel-stop のまま。
  'roulette-near': 'reel-stop',
  'roulette-kick': 'reel-kick',
  'roulette-hit': 'reel-hit',
  // 超激アツの再加速が終わった合図 — 「覚悟を決めましょう」で溜めに入る。
  'roulette-hype': 'hype-kakugo',
  // 膨らんだ出目が元に戻る瞬間の悲鳴。3本の中では一番短く歯切れがよい「くっ！」。
  'roulette-hype-back': 'back-kuh',
  'boost-start': 'boost-tap',
  'boost-end': 'boost-hit',
  achieved: 'clear-fanfare',
};

/**
 * スロットごとの相対音量(%)の既定。100 = 全体音量そのまま(= 個別音量を足す前の挙動)。
 * 既存の settings.json には無いフィールドなので、欠損時もここに倒れる必要がある。
 */
export const DEFAULT_SE_VOLUMES: Record<ChallengeSeSlot, number> = {
  press: 100,
  follow: 100,
  like: 100,
  'gauge-full': 100,
  'stock-full': 100,
  comment: 100,
  'gift-t1': 100,
  'gift-t2': 100,
  'gift-t3': 100,
  'gift-t4': 100,
  helper: 100,
  roulette: 100,
  'roulette-near': 100,
  'roulette-kick': 100,
  'roulette-hit': 100,
  'roulette-hype': 100,
  'roulette-hype-back': 100,
  'boost-start': 100,
  'boost-end': 100,
  achieved: 100,
};

/**
 * ギフトルーレットの既定。要件「初期設定はハートミーで起動」に合わせて有効で出荷する。
 * giftId 7934 は実配信で受領確認済み(resources/gift-aliases.default.json 参照)。
 * weight は合計 100 にしてある — 設定UIの確率表示がそのまま % になる。+1000 は 1%。
 */
/**
 * 出荷時に許可する終盤パターン。**オプトインの ultra を除いた全部。**
 *
 * 「パターンを増やしたら黙って全員の配信で出る」を避けるための仕切り。新しい
 * 超激アツは絵と音の好みが分かれるので、既定では出さず設定画面のチェックで
 * 選ばせる(ユーザー決定)。ここが sanitizeRoulettePatterns の**キー欠損時の
 * フォールバック**でもあるので、出荷 JSON(patterns キーを持たない)・
 * DEFAULT_ROULETTE・DEFAULT_JOIN_ROULETTE・「既定に戻す」の**全経路が同じ結論**になる。
 *
 * 保存済み settings.json は既に明示配列を持つので、新パターンはそこにも現れない
 * (= 既存ユーザーの配信も勝手に変わらない)。オプトインを解除して全員に出したく
 * なったら、この配列から除外を外すだけでよい。
 *
 * **激熱確定専用(dto の ROULETTE_HOT_ONLY_PATTERNS)はここに入れないこと。**
 * オプトインは「チェックすれば出る」= 設定画面に**チェックが出る**の意味だが、
 * 激熱専用は一覧そのものに出さない。除外は ROULETTE_SELECTABLE_PATTERNS の側で
 * 済んでおり、DEFAULT_ROULETTE_PATTERNS はその差集合をさらに絞ったもの。
 */
export const ROULETTE_OPT_IN_PATTERNS: readonly RoulettePattern[] = [
  'heartme',
  'hearttouch',
  'heartbday',
  'heartbloom',
];
export const DEFAULT_ROULETTE_PATTERNS: readonly RoulettePattern[] =
  ROULETTE_SELECTABLE_PATTERNS.filter((p) => !ROULETTE_OPT_IN_PATTERNS.includes(p));
export const DEFAULT_ROULETTE: ChallengeRouletteConfig = {
  id: 'rl-heart_me',
  // モニターの見出しは「ハートミー ○○がルーレット」。TikTok から届く実名は
  // 英語 'Heart Me' のことがあるので、日本語表記はここで固定する。
  label: 'ハートミー',
  enabled: true,
  giftId: '7934',
  giftName: 'heart me',
  canonical: 'heart_me',
  segments: [
    { amount: 5, weight: 30 },
    { amount: 10, weight: 25 },
    { amount: 20, weight: 20 },
    { amount: 30, weight: 15 },
    { amount: 100, weight: 9 },
    { amount: 1000, weight: 1 },
  ],
  direction: 'add',
  // 既定は全パターン許可 — 欠損キーの旧 settings.json もここへ倒れる(移行代わり)。
  patterns: [...DEFAULT_ROULETTE_PATTERNS],
};

/**
 * 激熱確定の既定行(DJメガネ / giftId 11583 / 500💎)。**倍率 ×10・盤面は全マス 500**
 * なので、どこに止まっても 500 → **5000** で確定する(ユーザー決定 2026-08-21)。
 *
 * ⚠ **この定数は「validate を通した後」と同じ形でなければならない。**
 * loadSettings / loadChallengeDefault はどちらも validate → migrate の順で走り、
 * **migrate の出力は再検証されない**。patterns キーを落とすと1回目の読込と
 * 保存後の形が食い違い、boot-settings.spec の不動点検査が落ちる。
 * 同じ理由で giftName は小文字・trim 済み、sound キーは持たせない。
 *
 * 絵柄は ROULETTE_HOT_GIFT_PATTERNS により 100% 'djglasses'(設定項目は無い)。
 */
export const DJ_GLASSES_ROULETTE: ChallengeRouletteConfig = {
  id: 'rl-dj_glasses',
  label: 'DJメガネ',
  enabled: true,
  // 指定は giftId が本線。giftName は ID が変わったときの保険で、日本語名
  // 「DJメガネ」は使えない(配信イベントの giftName は英語で届く)。
  giftId: '11583',
  giftName: 'dj glasses',
  // gift-aliases に dj_glasses の名寄せ規則は無いので空のまま(推測で足さない規約)。
  canonical: '',
  // 全マス同額。倍率が本物なので素の出目は動かさず、どこに止まっても同じ額で確定する。
  // weight は合計 100 = そのまま % 表示(全マス同額なので確率表示にしか効かない)。
  segments: [
    { amount: 500, weight: 17 },
    { amount: 500, weight: 17 },
    { amount: 500, weight: 17 },
    { amount: 500, weight: 17 },
    { amount: 500, weight: 16 },
    { amount: 500, weight: 16 },
  ],
  direction: 'add',
  // 激熱行では読まれないキーだが、**省略しない**(上の ⚠ の理由)。
  patterns: [...DEFAULT_ROULETTE_PATTERNS],
  hot: { enabled: true, multiplier: 10 },
};

/**
 * 倍率の候補列(確率抽選)。ユニコーン/バニーDJ の2行が共有する
 * ×5 60% / ×10 30% / ×20 10%。
 *
 * ⚠ **並べ替えは掛からない**(sanitizeRouletteHotMultList は filter→slice→map のみ)ので、
 * ここに書いた順がそのまま validate の出力になる。従来形へ畳まれないよう **2件以上**、
 * かつ少なくとも1件は weight > 0 であること(1件だと validateRouletteHot が
 * multipliers キーごと落として従来形にする)。
 */
const HOT_GIFT_MULTIPLIERS: readonly RouletteHotMultCandidate[] = [
  { multiplier: 5, weight: 60 },
  { multiplier: 10, weight: 30 },
  { multiplier: 20, weight: 10 },
];

/**
 * 激熱確定の既定行(ユニコーン / giftId 12453 / 2499💎)。盤面は**全マス 2499**で、
 * 倍率は確率抽選なので 1個で 12,495 / 24,990 / 49,980 のいずれかに化ける。
 *
 * ⚠ DJ_GLASSES_ROULETTE と同じく **validate を通した後と同じ形**でなければならない
 * (migrate の出力は再検証されない)。`multiplier` には
 * `rouletteHotRepresentativeMult`(最大 weight・同率先勝ち)= **5** を焼いておくこと。
 *
 * ⚠ **giftName は空**。matchGiftTrigger の giftName 段は部分一致(includes)なので
 * 'unicorn' を置くと **'Unicorn Fantasy'(giftId 7237 / 5000💎)まで巻き込む** —
 * そちらは giftRules も giftFullCut も評価されなくなる。指定は giftId 一本で足りる。
 * (ROULETTE_HOT_GIFT_PATTERNS 側の 'unicorn' は exactName: true なので安全。)
 *
 * 絵柄は ROULETTE_HOT_GIFT_PATTERNS により 100% 'unicorngift'(設定項目は無い)。
 */
export const UNICORN_ROULETTE: ChallengeRouletteConfig = {
  id: 'rl-unicorn',
  label: 'ユニコーン',
  enabled: true,
  giftId: '12453',
  giftName: '',
  canonical: '',
  // 全マス同額。倍率が本物なので素の出目は動かさず、どこに止まっても同じ額で確定する。
  segments: [
    { amount: 2499, weight: 17 },
    { amount: 2499, weight: 17 },
    { amount: 2499, weight: 17 },
    { amount: 2499, weight: 17 },
    { amount: 2499, weight: 16 },
    { amount: 2499, weight: 16 },
  ],
  direction: 'add',
  patterns: [...DEFAULT_ROULETTE_PATTERNS],
  hot: { enabled: true, multiplier: 5, multipliers: [...HOT_GIFT_MULTIPLIERS] },
};

/**
 * 激熱確定の既定行(バニーDJ / giftId 437679 / 1200💎)。盤面は**全マス 1200**で、
 * 倍率は確率抽選なので 1個で 6,000 / 12,000 / 24,000 のいずれかに化ける。
 *
 * giftName 'bunny dj' は部分一致でも他のギフトに当たらないことを確認済み
 * (ギフト一覧 666 件中、'bunny' を含むのはこの1件だけ)。
 *
 * 絵柄は ROULETTE_HOT_GIFT_PATTERNS により 100% 'bunnydj'(設定項目は無い)。
 */
export const BUNNY_DJ_ROULETTE: ChallengeRouletteConfig = {
  id: 'rl-bunny_dj',
  label: 'バニーDJ',
  enabled: true,
  giftId: '437679',
  giftName: 'bunny dj',
  canonical: '',
  segments: [
    { amount: 1200, weight: 17 },
    { amount: 1200, weight: 17 },
    { amount: 1200, weight: 17 },
    { amount: 1200, weight: 17 },
    { amount: 1200, weight: 16 },
    { amount: 1200, weight: 16 },
  ],
  direction: 'add',
  patterns: [...DEFAULT_ROULETTE_PATTERNS],
  hot: { enabled: true, multiplier: 5, multipliers: [...HOT_GIFT_MULTIPLIERS] },
};

/**
 * ルーレット群の既定。出荷時はハートミーと激熱確定3件(DJメガネ / ユニコーン /
 * バニーDJ)の計4件 — 設定画面から何件でも足せる。
 * 複数ある場合は**上から順に評価し、最初に一致した1件だけ**が回る(matchRoulette)。
 *
 * **激熱確定の行は必ず末尾へ足す**。先頭に入れるとテストや呼び元の `roulettes[0]` /
 * `DEFAULT_ROULETTES[0]`(= 従来ハートミーを指していた)が別人を掴む。
 */
export const DEFAULT_ROULETTES: readonly ChallengeRouletteConfig[] = [
  DEFAULT_ROULETTE,
  DJ_GLASSES_ROULETTE,
  UNICORN_ROULETTE,
  BUNNY_DJ_ROULETTE,
];

/**
 * 入室ルーレットの既定。**無効で出荷** — 既存ユーザーの配信を勝手に変えない
 * (旧 settings.json の joinRoulette キー欠損も validateJoinRoulette がここへ
 * 倒すので、移行処理は不要)。盤面はギフトルーレットの既定と同じ。
 * label '初見さん' は rouletteBoardKey の衝突回避も兼ねる(空だと同一盤面の
 * ギフトルーレットと畳み込まれうる)。
 */
export const DEFAULT_JOIN_ROULETTE: JoinRouletteConfig = {
  enabled: false,
  target: 'first',
  label: '初見さん',
  segments: DEFAULT_ROULETTE.segments.map((s) => ({ ...s })),
  direction: 'add',
  patterns: [...DEFAULT_ROULETTE_PATTERNS],
};

/**
 * 入室ルーレットの連続発火を抑えるクールダウン(ms)。最長の1スピンの演出尺
 * (ROULETTE_SPIN_ULTRA_MS + ROULETTE_REVEAL_ULTRA_MS ≒ 34.9秒)より長め — レイドや
 * target:'all' の高頻度入室でモニターのキュー(ROULETTE_QUEUE_MAX)と
 * リングバッファを初見ルーレットだけで食い潰さないための安全弁。
 * (heavy 12秒化で 10→15秒、ultra 24秒化で 15→30秒、ultra のカウントダウン式
 *  激アツ化で 30→35秒、確定見せを 3 秒へ伸ばして(34.9秒)35→38秒。test/unit が不等式を固定。)
 * 窓内の入室は値ごと黙って捨てる(演出起点の機能なので値の完全性は要らない)。
 * 設定項目にはしない — UI を増やさず定数で持つ。
 */
export const JOIN_ROULETTE_MIN_GAP_MS = 38_000;

/**
 * 入室ルーレット専用キュー(モニターの優先度⑥)の上限。入室ルーレットは単一設定 =
 * 単一盤面なので、溢れは末尾連結(mergeRoulette)で必ず吸収できる。さらに worker 側の
 * JOIN_ROULETTE_MIN_GAP_MS クールダウンが供給を絞るため、実質溢れない —
 * この値は演出事故(旧 worker 混在等)への安全弁で、設定項目にはしない。
 */
export const JOIN_ROULETTE_QUEUE_MAX = 4;

/**
 * 超焦らし(大当たり寸止め系)の3種。ROULETTE_PATTERNS から段位ではなく名前で
 * 引く — heavy には doublefake も居るので TIER フィルタでは取れない
 * (ROULETTE_ULTRA_PATTERNS と同じ「一覧から filter」の流儀)。
 */
export const ROULETTE_JACK_PATTERNS: readonly RoulettePattern[] = ROULETTE_PATTERNS.filter(
  (p) => p === 'jackstop' || p === 'jackslip' || p === 'jackback'
);

/**
 * 超焦らしのカウント方式の発動間隔の候補。発動のたびに等確率で引き直し、
 * その回数目の「並びの最後のフル尺スピン」で必ず発動する(5回に1回 or 7回に1回)。
 * 設定項目にはしない — UI を増やさず定数で持つ(JOIN_ROULETTE_MIN_GAP_MS と同じ判断)。
 */
export const ROULETTE_TEASE_COUNTS = [5, 7] as const;

/**
 * 超焦らしカウント方式の既定。**有効で出荷** — 「超焦らしは5〜7回に1回だけ」が
 * 新しい標準挙動(旧 settings.json の rouletteTease キー欠損も validateRouletteTease
 * がここへ倒すので、移行処理は不要)。patterns は jack 3種全部。
 */
export const DEFAULT_ROULETTE_TEASE: RouletteTeaseConfig = {
  enabled: true,
  patterns: [...ROULETTE_JACK_PATTERNS],
};

/**
 * ダイヤ帯域カットインの凍結時間の上限(ms)。durationSec の clamp(30秒)より
 * 短くしてある — 凍結はイベント適用を遅らせるので、演出事故(設定ミス等)でも
 * この長さを超えてカウンタが止まらないようにする安全弁。
 */
export const GIFT_FX_FREEZE_MAX_MS = 15_000;
/**
 * クリップ終端フェードと凍結解除の隙間(ms)。モニターの unmount(fxDurationMs)
 * より少し後に worker が解除することで、「数字が動いてからクリップが消える」の
 * 逆順を防ぐ。
 */
export const GIFT_FX_FREEZE_MARGIN_MS = 500;
/**
 * 凍結中の保留オペキューの上限。溢れた分は演出なしで値だけ即時適用する
 * (値の正しさ優先、演出は捨てる — ルーレットキューの溢れ処理と同じ思想)。
 * カットイン反復で凍結が最長 GIFT_FX_FREEZE_MAX_TOTAL_MS まで伸びるため、
 * その間に届くイベントを飲めるだけの深さを持たせてある。
 */
export const GIFT_FX_PENDING_OPS_MAX = 256;
/**
 * 溢れ弁でも即時実行に倒してはいけない「重要 op」(フィーバー発動など、凍結中に
 * 走ると進行中の演出を強制清算した上で凍結を張り直す op)のための追加ヘッドルーム。
 * 上限そのものを上げないのは、高頻度イベント(いいね等)にヘッドルームを食い潰さ
 * せないため。ここも尽きたら重要 op は実行せず破棄する(診断ログに残す)。
 */
export const GIFT_FX_PENDING_OPS_CRITICAL_EXTRA = 32;
/**
 * delta に載せる演出予告(ChallengeState.fxQueue)の上限件数。保留キュー自体は
 * GIFT_FX_PENDING_OPS_MAX まで積めるが、モニターの表示は5行+溢れ表記なので
 * 予告はこの件数で切って 2Hz の delta を太らせない。
 */
export const CHALLENGE_FX_QUEUE_MAX = 8;

// ── 連打ギフトの演出反復(giftRepeatFx) ──────────────────────────────────────

/** 反復回数の絶対上限。設定値(max)はこれで clamp する。 */
export const GIFT_FX_REPEAT_MAX = 10;
/** 反復間隔の既定(ms)。4秒前後のクリップが重なって「連打」に見える速さ。 */
export const GIFT_FX_REPEAT_MS = 700;
export const GIFT_FX_REPEAT_MIN_MS = 200;
export const GIFT_FX_REPEAT_MAX_MS = 2_000;
/** モニターが同時に抱える反復タイマーの上限(多人数の連打が重なったときの保険)。 */
export const GIFT_FX_REPEAT_TIMERS_MAX = 64;
/**
 * カットインを反復したときの**総**凍結時間の上限(ms)。GIFT_FX_FREEZE_MAX_MS が
 * 「1本あたり」の安全弁なのに対し、こちらは「反復ぶん全部」の安全弁。
 * 超えるときは fxDurationMs ではなく**回数側を削る** — 1本の尺はモニターとの契約。
 */
export const GIFT_FX_FREEZE_MAX_TOTAL_MS = 45_000;

/** モニターの演出クリップ連続再生キューの上限(ROULETTE_QUEUE_MAX と同じ思想)。 */
export const CLIP_QUEUE_MAX = 3;
/**
 * 他演出中に届いたカットイン(バンド/全面カット)の持ち越し上限。
 * 連打ルーレットの連鎖そのものは数分に伸びうるが(ROULETTE_FULL_REELS 参照)、
 * カットインは fx-priority で⑦= ルーレット⑧より上位なので **§6b がリール境界で
 * 必ず譲る** — つまり溜まる窓は連鎖の総尺ではなく**1リールの尺**(最長 34.9 秒)。
 * **例外は激熱確定(⑥.5)** — あちらはカットインより上位なので譲ってもらえず、
 * 1本ぶん(導入 8 秒込みで最長 42.9 秒)は丸ごと待つ。4枠はその窓で溜まるぶんを
 * 飲める見積り(帯カットインは1ギフト1枠)。
 * その裏で溜まるぶんを飲めるだけ確保する — 溢れるとそのギフトの演出が丸ごと消える。
 * **上げたら FX_DRAIN_MAX_STEPS の見積もりも更新すること。**
 */
export const PENDING_BANDS_MAX = 4;
/**
 * 他演出中に届いたブースト(boost-start)の持ち越し上限。連打コンボは worker が
 * 1メッセージあたり最大 TAP_BOOST_ACTIVATIONS_MAX 本を直列発動するので、旧上限の
 * 2 では3本目が無言で消えていた。死んだ持ち越しは boost-end 受信時に間引かれる
 * (MonitorView の boost-end ハンドラ)ため、枠が死骸で埋まり続けることはない。
 * **上げたら FX_DRAIN_MAX_STEPS の見積もりも更新すること。**
 */
export const PENDING_BOOSTS_MAX = 4;

/**
 * 他演出中に届いた革命(revolution-start の導入 / revolution-end の結果)の
 * 持ち越し上限(モニター側)。重ねがけは worker が延長へ畳む(activateRevolution)ので、
 * キューに同時に並ぶのは「アーム中の1本 + 稀な再アーム」程度。
 * **結果カットシーン1本ぶんの枠を足して 3**(2 のままだと、他演出で渋滞した瞬間に
 * 窓の締めくくりが無言で捨てられる)。
 */
export const PENDING_REVOLUTIONS_MAX = 3;

/**
 * 他演出中に届いたお題の結果発表(quiz-end)の持ち越し上限(モニター側)。
 * quiz-start はこのキューを通らない(バリア方式 — armed 監視が唯一の入口)ので、
 * 並ぶのは結果発表だけ。連続発動(予約 FIFO)でも結果は1本ずつしか出ないため 2 で足りる。
 * **上げたら FX_DRAIN_MAX_STEPS の見積もりも更新すること。**
 */
export const PENDING_QUIZZES_MAX = 2;
/**
 * フィーバーの「アーム」(発動予約)を保持する上限(ms)。worker はギフト着弾で
 * 予約するだけで、**モニターが起動カットインを再生し始めた瞬間**(challenge.boostCue)に
 * タップ窓を開く。ここはその合図が来なかったときの安全網。
 *
 * 60 秒の根拠 — 舞台を塞ぐ最悪ケースの合計:
 *  - 反復帯カットインは構造上の最長 **45 秒**(giftFxRepeat が
 *    GIFT_FX_FREEZE_MAX_TOTAL_MS で回数を削るので atMs + fxDurationMs * rep の上限)。
 *    ブーストは fx-priority で④だが「再生中の演出は中断しない」規約なので待つ。
 *  - バナー飢餓弁 DRAIN_STARVE_MS(10 秒)+ delta/ドレインの遅延。
 *  - 別のフィーバーは塞げない(アームが凍結を張るので連打コンボは直列化される)。
 *  - ルーレット連鎖は既に譲る(collectWaitingClasses が 'boost' を積む)。譲りの
 *    粒度は**リール境界**なので、待ちは連鎖の総尺ではなく1リールの尺で有界
 *    (ROULETTE_FULL_REELS の導入で 1.6 秒 → 通常 最長 34.9 秒。到着直後に ultra が
 *    始まった最悪で 34.9 + 確定バナー 1.6 + 間合い 0.5 ≒ 37 秒 < 60 秒。直前が
 *    フィーバー結果バナーだった場合だけ STAGE_GAP_BOOST_RESULT_MS(2 秒)が
 *    上乗せされて ≒ 39 秒)。
 *    **激熱確定(hot)は導入 8 秒ぶん長い** — 42.9 + 1.6 + 0.5 + 2 ≒ **47 秒**。
 *    60 秒には収まるが余裕は約 13 秒まで縮む(通常時は約 21 秒)。ここを削ると
 *    「激熱の最中に撃ったフィーバーの起動カットインが飛ぶ」が再発するので、
 *    **激熱の尺を伸ばすときは必ずこの引き算をやり直すこと**。
 * **短くしてはいけない** — 20〜45 秒だと正当な長尺カットインの最中に期限が切れ、
 * 「起動カットインが飛ばされる」症状がそのまま再発する。
 *
 * 期限切れは破棄ではなく**シネマティックで強制発動**(deadlineMs 起点)。こうすると
 * effect に焼いた boostEndsAtMs がそのまま真になり、遅れて再生を始めたモニターの
 * planBoostStart が整合して最悪でも従来挙動(resume/skip)に着地する。
 *
 * 注意: アーム中の暫定凍結はこの値ぶん伸びるので、総凍結は
 * GIFT_FX_FREEZE_MAX_TOTAL_MS(45 秒)を超えうる。あちらは**帯カットインの反復回数**
 * 専用の天井(giftFxRepeat が唯一の消費者)で、ブーストの凍結は現行でも 31.5 秒あり
 * 元から管轄外 — TAP_BOOST_DURATION_MAX_SEC の doc と同じ判断。
 * 実際にこの値まで凍結が伸びるのは「コミットが永久に来ない」病的ケースだけで、
 * 通常はコミットで commitTime + 前置き + ウィンドウ + 清算まで**短縮**される。
 */
export const BOOST_ARM_MAX_MS = 60_000;
/**
 * コミット合図(startedAtMs)に許す最大の遡り(ms)。モニターと worker は同一マシンの
 * 同じ Date.now() を見るが、RPC は renderer → main → worker の postMessage を挟むので
 * 遅延ぶんだけ過去になる。これを超えて古い値は「時計がおかしい」として今に丸める。
 * 未来側は 0 に丸める(now を超えるとタップ窓が映像より後ろへずれ、開幕の押下を飲む)。
 */
export const BOOST_COMMIT_MAX_LAG_MS = 2_000;
/**
 * クリップの安全弁(ms)。onEnded が来ない素材・遮蔽ウィンドウで再生中フラグが
 * 固着すると、以後クリップが永久に出なくなる(直したいバグより悪い)。
 */
export const CLIP_ABORT_MS = 8_000;
/**
 * 同時に積める浮上バナーの上限。2 段組みで 1 枚 200〜260px あるので、
 * ステージ(縦 960px)に収まるのはこのあたりが限界 — 増やすと下端が
 * .fx-layer の overflow:hidden で切れる。
 */
export const FLOAT_MAX = 3;
/**
 * フロートバナーの安全弁(ms)。最長は .float.gift-card の 2.2 秒なので余裕を見た値。
 * shake / mini / clip と同じ「animationend 単独依存にしない」規約 — 遮蔽ウィンドウでは
 * animationend が届かず、バナーが出たまま固着して FLOAT_MAX の枠を食い潰す。
 * CSS の実尺との整合は test/unit/float-abort.spec.ts が monitor.css を読んで固定する。
 */
export const FLOAT_ABORT_MS = 3_000;
/** 同時に表示する簡易演出の上限(floats/flashes と同じ「積む」層)。 */
export const MINI_MAX = 3;
/** 簡易演出の安全弁(ms)。最長の mini が 880ms(panic)なので余裕を見た値。 */
export const MINI_ABORT_MS = 1_200;
/**
 * いいねゲージの滴下補間で「この tick の setState を省けるか」の判定。
 * 表示に影響するのは (a) 数字 = floor(値) と (b) バー幅 = 値/分母 の2つだけ —
 * どちらも動かない中間値の setState は LikeGauge と全ドットの再レンダーを
 * 積むだけなので捨てる。いいねが流れ続ける配信ではこの補間が実質止まらず、
 * モニター窓(backgroundThrottling 無効で常時フル稼働)の常時数十Hz 再描画が
 * 「長時間でだんだん重い」の主要因だった。
 * バー幅は 0.25% 刻み(1080px 級の縦画面でゲージ幅 ~1000px として ~2.5px)で
 * 十分滑らか。最終ステップ(target 到達)は呼び出し側が無条件で commit する
 * こと — 「必ず DRIP_MS で追いつき、到達値は厳密に target」の契約を守る。
 */
export function dripCommitNeeded(prevShown: number, next: number, every: number): boolean {
  if (Math.floor(next) !== Math.floor(prevShown)) return true;
  if (every <= 0) return false;
  const step = every * 0.0025; // バー幅 0.25% 刻み
  return Math.floor(next / step) !== Math.floor(prevShown / step);
}

/**
 * shake(画面揺れ)の安全弁(ms)。monitor.css の shake(450ms)/
 * shakestrong(900ms)の最長尺 + 余白。遮蔽で animationend が届かず
 * .monitor-root にクラスが固着すると、「同名クラスの連続 shake は再スタート
 * しない」制限と合わさって以後の揺れが全部消える — タイマーで必ず外す。
 * CSS 側の尺を伸ばしたら test/unit/shake-abort.spec.ts が落ちる契約。
 */
export const SHAKE_ABORT_MS = 1_200;

/**
 * カットインBGMの id 一覧。実ファイルとラベルは renderer/lib/bgm.ts。
 * validate はこのリストで割り当てを検証する — 未知の id は既定に戻す。
 * 効果音(CHALLENGE_SE_SOUND_IDS)とは別カタログ: 長尺曲をジングルの
 * 選択肢(SEスロットの select)に混ぜないため。
 */
export const CHALLENGE_BAND_BGM_IDS: readonly string[] = [
  'bgm-band1',
  'bgm-band2',
  'bgm-band3',
  'bgm-band4',
];

/**
 * ルーレット回転中BGMの id 一覧。実ファイルとラベルは renderer/lib/bgm.ts の
 * ROULETTE_BGM。**BAND_BGM の4曲も選択肢に連結する** — 既存曲を回転用に
 * 使い回せるようにするため(逆方向は無し: 帯域の select に回転曲は出さない)。
 */
export const CHALLENGE_ROULETTE_BGM_IDS: readonly string[] = [
  'bgm-roulette1',
  'bgm-roulette2',
  ...CHALLENGE_BAND_BGM_IDS,
];

/** リール回転ループ音の id 一覧。実ファイルは renderer/lib/bgm.ts の ROULETTE_SPIN_SE。 */
export const CHALLENGE_ROULETTE_SPIN_SE_IDS: readonly string[] = [
  'spin-reel2',
  'spin-reel1',
  'spin-slot',
];

/**
 * ユーザー取込みの回転音 id の接頭辞。`custom:<ファイル名>` の形で spinSe に
 * そのまま入る — 別フィールドにしないのは「custom 選択なのにパスが空」という
 * 不整合状態を作らないため(enabled ブールを持たず 'off' で表す規約と同じ発想)。
 * ファイル名は config/sounds/ 内のベース名のみ。パスを持たせないのは、
 * main のプロトコルハンドラ(app-sound://)の「許可ディレクトリ限定」を
 * 設定値の側から破れなくするため。Windows のファイル名に ':' は使えないので、
 * 取込み時にサニタイズされた名前とこの接頭辞が衝突することはない。
 * 既存カタログの接頭辞規約('spin-*' 等、bgm.ts)とも重ならない。
 */
export const CUSTOM_SOUND_PREFIX = 'custom:';

/**
 * カスタム回転音 id の判定。検証(validateRouletteSound)・再生(bgm.ts)・
 * 設定UIの3者が同じ判定を共有する。fs の実在確認は shared では不可能なので
 * しない — 実在の最終防衛線は main 側プロトコルハンドラの containment 検査で、
 * ここでは settings.json 手編集経由のトラバーサル文字列だけを弾く。
 */
export function isCustomSoundId(v: unknown): v is string {
  if (typeof v !== 'string' || !v.startsWith(CUSTOM_SOUND_PREFIX)) return false;
  const name = v.slice(CUSTOM_SOUND_PREFIX.length);
  return (
    name.length > 0 &&
    name.length <= 200 &&
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..')
  );
}

/** カスタム回転音 id からファイル名(config/sounds/ 内のベース名)を取り出す。 */
export function customSoundFileName(id: string): string {
  return id.slice(CUSTOM_SOUND_PREFIX.length);
}

/**
 * ルーレット回転サウンドの既定。回転ループ音は**有効(鳴る)で出荷**、
 * 回転中BGMは**既定オフ** — ループ音のジングルだけで場が持つ構成にしてあり、
 * 曲を重ねると停止まわりの3音(near/kick/hit)が埋もれるため。BGM が欲しい人は
 * 設定画面のドロップダウンから選ぶ(選択肢としてはカタログに残っている)。
 * 音量は giftBandFx.bgmVolume の既定と同じ 70。素材間の音圧差は bgm.ts の gain で吸収する。
 */
export const DEFAULT_ROULETTE_SOUND: RouletteSoundConfig = {
  bgm: 'off',
  bgmVolume: 70,
  spinSe: 'spin-reel2',
  spinSeVolume: 70,
  clipVolume: 70,
};

/**
 * 応援(direction:'sub')のルーレットの回転ループ音。妨害の既定 'spin-reel2'
 * (旋律のあるジングル)に対して、これは旋律の無いクリック列 — **同じカタログの中で
 * 一番音色が遠い**ので、緑のルーレットが回り出した瞬間に音だけでも見分けが付く。
 * 'spin-slot' を使わないのは、BGM の 'bgm-roulette2' と**同一の音声ファイル**
 * (renderer/lib/bgm.ts)で、BGM を併用している人だと差が消えるため。
 */
export const ROULETTE_SUB_SPIN_SE = 'spin-reel1';

/**
 * 応援(sub)共通サウンドの既定。**保存済みの共通からの派生**にするのが要点 —
 * 回転ループ音が出荷既定のままの人にだけ差を付け、自分で選び直している人には
 * その選択をそのまま引き継ぐ(migrateChallengeSeSounds の「旧既定のままの
 * スロットだけ寄せる」と同じ流儀)。差分は**回転ループ音1項目だけ** — BGM を
 * 足すのは変えすぎで、DEFAULT_ROULETTE_SOUND が BGM を切っている理由
 * (停止まわりの3音が埋もれる)にも反する。
 */
export function defaultRouletteSoundSub(common: RouletteSoundConfig): RouletteSoundConfig {
  return {
    ...common,
    spinSe: common.spinSe === DEFAULT_ROULETTE_SOUND.spinSe ? ROULETTE_SUB_SPIN_SE : common.spinSe,
  };
}

/**
 * ダイヤの全面カットの既定。バラ(1💎)とローザ(10💎)に専用のフルスクリーン
 * カットインを割り当てる。**帯域(DEFAULT_GIFT_BAND_FX)より先に評価される**ので、
 * この2つのギフトでは band1(びっくりした魚)は再生されない。
 *
 * トリガーはギフト名(部分一致)を本線にする — ライブ経路では NormalizedEvent の
 * canonical が未代入なため(matchRouletteTrigger / matchFanStamp と同じ制約)。
 * バラには保険で canonical 'rose' も入れてある(gift-aliases.default.json の
 * nameRules に実在する)。ローザは名寄せ規則が無いので canonical は空。
 *
 * giftName は**小文字で保存**する規約(matchGiftTrigger が設定値を小文字前提で
 * 比較する)。日本語なので実質そのままだが、英語名を足すときは小文字にすること。
 */
/**
 * カタログ1行 → 既定行への写像。id は clip id の 'cut-' を 'fullcut-' に差し替えたもの
 * (この対応が決まっているので、validateGiftFullCut の
 *  `d.rules.find(x => x.id === r.id)` フォールバックがそのまま効く)。
 */
export function fullCutRuleFor(c: FullCutClipDef): GiftFullCutRule {
  return {
    id: `fullcut-${c.id.slice('cut-'.length)}`,
    label: c.ruleLabel,
    // giftId はカタログ側が持つ。**実データで確認できたギフトだけ**入っていて、
    // 未確認の行は ''(= giftName の推定だけで当てにいく)。
    // ギフト名は配信クライアントの言語で変わり(日本語UIでも英語名で届く)、
    // さらに同名別IDが実在する(Hand Heart = 5660 ハートポーズ / 8343 ハンドハート)ため、
    // 判明しているものは giftId を最優先で使う。
    giftId: c.giftId,
    giftName: c.giftName,
    canonical: c.canonical,
    exactName: c.exactName,
    clip: c.id,
    durationSec: 5,
    enabled: true,
  };
}

/**
 * 全面カットの既定。42行(v0.5.0 のバラ/ローザ + v0.6.0 の40行)。
 * 内訳と各行のトリガーは shared/fx-cut.ts を見ること — **並び順がそのまま
 * 評価順(上から先勝ち)** になる。
 *
 * 全行 enabled: true / durationSec: 5(素材の尺 5.09 秒 > 5 秒なのでループしない)。
 */
export const DEFAULT_GIFT_FULL_CUT: GiftFullCutConfig = {
  enabled: true,
  volume: 70,
  rules: FULL_CUT_CLIPS.map(fullCutRuleFor),
};

/**
 * ダイヤ帯域カットインの既定バンド。要件どおり 1〜50 / 51〜100 / 101〜600 /
 * 601〜1000(6/6/8/10秒)。1000 超は overflow:'top' で band4 を適用する。
 * bgm は帯域が上がるほど盛り上がるパチンコ風BGM(renderer/lib/bgm.ts)。
 */
export const DEFAULT_GIFT_BAND_FX: GiftBandFxConfig = {
  enabled: true,
  bands: [
    { id: 'band1', min: 1, max: 50, clip: 'gift-band1', durationSec: 6, enabled: true, bgm: 'bgm-band1' },
    { id: 'band2', min: 51, max: 100, clip: 'gift-band2', durationSec: 6, enabled: true, bgm: 'bgm-band2' },
    { id: 'band3', min: 101, max: 600, clip: 'gift-band3', durationSec: 8, enabled: true, bgm: 'bgm-band3' },
    { id: 'band4', min: 601, max: 1000, clip: 'gift-band4', durationSec: 10, enabled: true, bgm: 'bgm-band4' },
  ],
  // ハートミー(1ダイヤ・高頻度)は除外。ライブ経路では canonical が乗らないため
  // giftId で除外する(DEFAULT_ROULETTE と同じ ID)。
  excludeGiftIds: ['7934'],
  overflow: 'top',
  bgmEnabled: true,
  bgmVolume: 70,
};

/**
 * お助け機能(ファンスタンプ)の既定。giftId は空 — クリエイター固有の値なので
 * 既定を置きようがない(設定画面は placeholder で例示する)。トリガーが3つとも
 * 空の設定はどのギフトにも一致しない(matchGiftTrigger)ので、enabled: true でも
 * 既存の settings.json の挙動は変わらない。
 *
 * suppressBandFx の既定が true なのは、ファンスタンプが 1 ダイヤ・高頻度で
 * 既定バンド(1〜50💎 → 6秒カットイン+カウンタ凍結)に素で当たるため。
 */
export const DEFAULT_FAN_STAMP: FanStampConfig = {
  enabled: true,
  giftId: '',
  giftName: '',
  canonical: '',
  amountEach: -1,
  suppressBandFx: true,
  flash: true,
};

/**
 * v0.7.8(SETTINGS_VERSION 8)で出荷したスタンプ行。**この配列は増やさない** —
 * 設定移行(migrateChallengeStampTriggers)が配るのはこの15行だけで、
 * DEFAULT_STAMP_TRIGGERS.rules を参照させると次の世代で既定が増えたときに
 * v8 の段が新しい行まで配って二重適用になる(FULL_CUT_CLIPS_V3 と同じ理由)。
 *
 * 番号は「ようくん☀️🦊ﾒﾀﾙｱｰﾄ / @metafact8」のサブスクエモートの emoteId で、
 * 2026-08-17 に実配信のチャットから取得し画像と照合した実測値(プロジェクト直下の
 * 「ファンスタ番号一覧_metafact8.md」が権威)。**emoteId は配信者ごとに違う**ので、
 * 他の配信者の環境ではこの15行は構造的に一度も一致しない — 設定画面に15行並ぶ
 * だけで誤発火は起きない。それを承知のうえで出荷既定に載せるという判断。
 *
 * 量は全行 -1(お助け)。DEFAULT_FAN_STAMP.amountEach と設定画面の新規行の
 * 既定に揃えてある — 増やしたい人は行ごとに設定画面で変える前提。
 */
export const STAMP_TRIGGER_RULES_V8: readonly StampTriggerRule[] = [
  { id: 'stamp-okaeri', label: 'おかえり', emoteId: '7673028474703203092', amountEach: -1, enabled: true },
  { id: 'stamp-yahho', label: 'やっほー', emoteId: '7673028113942088469', amountEach: -1, enabled: true },
  { id: 'stamp-menlevup', label: 'メンレベUP↗', emoteId: '7672235836915747604', amountEach: -1, enabled: true },
  { id: 'stamp-naigifu', label: 'ナイギフ', emoteId: '7672236083434703637', amountEach: -1, enabled: true },
  { id: 'stamp-welcome', label: 'ようこそ', emoteId: '7671092908083137301', amountEach: -1, enabled: true },
  { id: 'stamp-matane', label: 'またね', emoteId: '7671092908083170069', amountEach: -1, enabled: true },
  { id: 'stamp-ganbare', label: 'がんばれ', emoteId: '7671092908083202837', amountEach: -1, enabled: true },
  { id: 'stamp-pachipachi', label: 'ぱちぱち', emoteId: '7671092908083235605', amountEach: -1, enabled: true },
  { id: 'stamp-warai', label: '笑', emoteId: '7671092908083333909', amountEach: -1, enabled: true },
  { id: 'stamp-omedeto', label: 'おめでとう', emoteId: '7671092908083366677', amountEach: -1, enabled: true },
  { id: 'stamp-e', label: 'え?', emoteId: '7671092908083399445', amountEach: -1, enabled: true },
  { id: 'stamp-iine', label: 'いいね♡', emoteId: '7671092908083432213', amountEach: -1, enabled: true },
  { id: 'stamp-tap', label: 'TAP', emoteId: '7671093685229472533', amountEach: -1, enabled: true },
  { id: 'stamp-good', label: 'グッド(👍)', emoteId: '7671094445665700628', amountEach: -1, enabled: true },
  { id: 'stamp-hightouch', label: 'ハイタッチ(🙌)', emoteId: '7671096936174439188', amountEach: -1, enabled: true },
];

/**
 * チャットスタンプ(サブスクエモート)トリガーの既定。
 *
 * v0.7.7 までは行が空だった(「emoteId はクリエイター固有なので既定を置きようがない」)
 * が、v0.7.8 で STAMP_TRIGGER_RULES_V8 の15行を出荷既定として載せた。既に
 * settings.json を持っているユーザーには既定を直しても届かないので、同じ15行を
 * migrateChallengeStampTriggers(SETTINGS_VERSION 8)が一度だけ配る。
 */
export const DEFAULT_STAMP_TRIGGERS: StampTriggerConfig = {
  enabled: true,
  flash: true,
  // readonly 配列から可変配列を作る(DEFAULT_GIFT_FULL_CUT が
  // FULL_CUT_CLIPS.map(fullCutRuleFor) でやっているのと同じ形)。
  rules: STAMP_TRIGGER_RULES_V8.map((r) => ({ ...r })),
};

/**
 * スタンプトリガーの行数上限。サブスクエモートは1配信者につき十数種が実勢
 * (実測: 15種)なので、その倍を天井にする(TAP_BOOST_RULES_MAX と同じ役割)。
 * v0.7.8 で出荷既定が15行になったため、内訳は「出荷の15 + 利用者の15」。
 * 他の配信者は出荷分を消して自分の番号を入れる想定なので枠は足りる。
 */
export const STAMP_TRIGGER_RULES_MAX = 30;

/** タップブーストの倍率の clamp。1 は「溜めて一括反映」だけ欲しい人向けに許す。 */
export const TAP_BOOST_MULT_MIN = 1;
export const TAP_BOOST_MULT_MAX = 100;
/**
 * タップウィンドウ(秒)の clamp。5〜15 はユーザー要件。前置き演出(起動 5秒+
 * カウントダウン 3秒)と合わせた総凍結は最長 23 秒で、帯域カットインの安全弁
 * GIFT_FX_FREEZE_MAX_MS(15秒)を意図的に超える — あちらは「視聴者がただ待つ
 * 死に時間」の上限だが、ブーストのウィンドウは配信者がタップし続けるゲーム
 * そのものなので同じ天井を課さない(タップは凍結中も数えられている)。
 */
export const TAP_BOOST_DURATION_MIN_SEC = 5;
export const TAP_BOOST_DURATION_MAX_SEC = 15;
/**
 * 起動カットイン(咆哮)クリップの尺(ms)。assets/fx/boost/ の intro-* 素材は
 * すべてこの実尺で揃える(選択制なので、素材ごとに尺が違うとタップ開始が
 * クリップ選択で動いてしまう)。
 */
export const TAP_BOOST_INTRO_MS = 5000;
/**
 * カウントダウン(3・2・1)クリップの尺(ms)。count-* 素材はすべてこの実尺で
 * 揃える — 3・2・1 は映像焼き込みなので、ズレるとタップ開始と「1」が合わない。
 */
export const TAP_BOOST_COUNT_MS = 3000;

/**
 * トリガーギフト1メッセージ(連打コンボ)あたりの発動回数の上限。
 *
 * 連打可能ギフト(giftType 1)は normalize.ts が repeatEnd で1件に畳んで
 * repeatCount を載せてくるため、repeatCount を見ずに発動すると「2個贈ったのに
 * フィーバー1回」になる(ルーレットの rouletteDrawCount と同じ問題)。
 * 一方フィーバー1本は前置き+ウィンドウ+清算で 20〜30 秒あり、17連打を
 * 素直に17本直列すると10分近く占有する — 演出なので値の正しさとは無関係に
 * ここで頭打ちにしてよい(切り捨ては giftDiag に必ず記録する)。
 */
export const TAP_BOOST_ACTIVATIONS_MAX = 3;

/**
 * 封印(お邪魔)中に届いたフィーバーの「封印明け予約」の上限本数。
 *
 * 排他スケジューリング(2026-08-20 ユーザー決定: 封印とフィーバーは決して同時に
 * 生きない)で、封印中に届いたフィーバーは破棄せず封印明けへ繰り越す。封印は
 * 最長 TAP_LOCK_MAX_MS(120 秒)なので、その間に**別メッセージで**届く現実的な
 * 本数をここで頭打ちにする — 超過分は critical キュー溢れと同じ「実行せず破棄」
 * (giftDiag に必ず記録)。連打コンボ内の丸めは従来どおり tapBoostActivationCount
 * (最大 3)が先に効き、こちらは**メッセージをまたぐ**累積の天井。
 */
export const TAP_BOOST_DEFERRED_MAX = 4;

/**
 * このトリガーギフト1メッセージで何回フィーバーを発動するか。
 * ルーレットの rouletteDrawCount と対になるが、こちらは**演出の回数**なので
 * ハード上限で削ってよい(値は動かない — トリガーギフトの規約)。
 */
export function tapBoostActivationCount(repeatCount: number): number {
  return Math.min(TAP_BOOST_ACTIVATIONS_MAX, Math.max(1, Math.round(repeatCount)));
}

/**
 * ブースト演出クリップのカタログ(段ごとの選択肢)。実ファイルは
 * assets/fx/boost/<id>.mp4(renderer/lib/fx.ts の boostClipUrl が解決する)。
 * validate はこのリストで設定値を検証する — 未知の id は既定へ倒す。
 * 素材を増やしたら「ファイル追加 + この行追加」の2点セット。
 */
export interface TapBoostClipDef {
  id: string;
  label: string;
}
export const TAP_BOOST_INTRO_CLIPS: readonly TapBoostClipDef[] = [
  { id: 'intro-panther', label: '黒豹の咆哮(宇宙)' },
  { id: 'intro-corgi', label: 'コーギーの登場(ピンク宇宙)' },
  { id: 'intro-nebaaru', label: 'ねば〜る君の登場(琥珀の宇宙)' },
];
export const TAP_BOOST_COUNT_CLIPS: readonly TapBoostClipDef[] = [
  // 数字はフレーム精度で焼き込み(ジャスト1.000秒刻み — タップ開始と正確に同期)。
  { id: 'count-321', label: '3・2・1(黒豹・ジャスト1秒刻み)' },
  { id: 'count-corgi', label: '3・2・1(コーギー・ジャスト1秒刻み)' },
  { id: 'count-nebaaru', label: '3・2・1(ねば〜る君・ジャスト1秒刻み)' },
];
export const TAP_BOOST_LOOP_CLIPS: readonly TapBoostClipDef[] = [
  // どれもコイン・スロットを含まない(配信規約への配慮 — ユーザー要件)。
  // panther / corgi は横 16:9(Dreamina 生成)、nebaaru は横 16:9(Higgsfield 生成)。
  // loop-pachinko だけ初代の縦 9:16 素材で、横モニターでは大きくクロップされる。
  { id: 'loop-panther', label: '黒豹コズミックFEVER(15秒・コインなし)' },
  { id: 'loop-corgi', label: 'コーギーFEVER(15秒・ピンク宇宙)' },
  { id: 'loop-nebaaru', label: 'ねば〜る君FEVER(16秒・琥珀の宇宙)' },
  { id: 'loop-pachinko', label: 'ゴールドFEVER(初代・縦動画)' },
];
export const TAP_BOOST_RESULT_CLIPS: readonly TapBoostClipDef[] = [
  // 結果カットシーン(タップウィンドウ終了 → 減算発表の前置き)。実尺は
  // TAP_BOOST_RESULT_MS(shared/boost-settle.ts)で固定 — 素材はこの尺で揃える。
  // mp4 が未投入でも boostClipUrl は 0 件許容 glob なので暗幕で同じ尺を待つ。
  { id: 'result-panther', label: '結果発表(黒豹・素材未同梱)' },
  { id: 'result-corgi', label: '結果発表(コーギー)' },
  { id: 'result-nebaaru', label: '結果発表(ねば〜る君)' },
];

/**
 * 登録できるブースト行の上限。ROULETTES_MAX と同じ 8 — 1行が最長23秒の全画面
 * シネマ一式を持つので実用は2〜3行だが、8 なら settings.json も UI も破綻しない。
 * 溢れた行は validate が捨てる。
 */
export const TAP_BOOST_RULES_MAX = 8;

/**
 * ブースト1行の**空行テンプレ**。giftId は空 — これは UI の「ブーストを追加」が
 * structuredClone して増やす雛形で、トリガーが3つとも空の行は**どのギフトにも
 * 一致しない**(matchGiftTrigger)。ここに giftId を焼くと、行を1つ足しただけで
 * 既定行と二重一致して上の行が黙って勝つ。
 *
 * **出荷される既定の1行目はこれではなく NEBAARU_TAP_BOOST_RULE**
 * (= DEFAULT_TAP_BOOST.rules[0])。クリップだけは標準テーマを共有している。
 *
 * DEFAULT_TAP_BOOST.rules[0] とは別に export しているのは、tsconfig の
 * noUncheckedIndexedAccess: true のせいで `DEFAULT_TAP_BOOST.rules[0]` の型が
 * `TapBoostRule | undefined` になり、呼び出し側が全部 `!` を書く羽目になるため。
 */
export const DEFAULT_TAP_BOOST_RULE: TapBoostRule = {
  id: 'boost-1',
  label: '',
  enabled: true,
  giftId: '',
  giftName: '',
  canonical: '',
  exactName: false,
  multiplier: 5,
  durationSec: 5,
  // 標準テーマはねば〜る君 — 4段すべて素材が同梱されているので、UI の
  // 「ブーストを追加」で複製された素の1行がそのまま満尺で再生できる
  // (黒豹は result-* が未同梱で resultClip: 'off' を強いられていた)。
  introClip: 'intro-nebaaru',
  countClip: 'count-nebaaru',
  loopClip: 'loop-nebaaru',
  resultClip: 'result-nebaaru',
  flash: true,
};

/**
 * ねば〜る君(gift 14463 / 10💎)のブースト行。**同梱既定の1行目**で、
 * settingsVersion 9 の移行が「旧既定の黒豹行のまま」の設定を1回だけこの内容へ
 * 寄せ替える実体でもある。黒豹(723500)を既定から降ろしたのは限定ギフトで
 * 実質受け取れず、既定の1行目としては死に枠だったため(ユーザー要件)。
 * 黒豹のクリップはカタログに残るので、設定画面から選び直せば従来どおり使える。
 *
 * 名前一致は使わない(giftId が本線)。実配信の giftName は `nebaarukun` という
 * **ローマ字**で届くので、全面カット側の 'cut-nebaaru' が使っている 'ねば' の
 * 日本語部分一致はそもそも当たらない(diag.log で確認済み)。
 * 倍率・尺は差し替え前の黒豹既定と同じ ×3 / 10秒 から始める。
 */
export const NEBAARU_TAP_BOOST_RULE: TapBoostRule = {
  ...structuredClone(DEFAULT_TAP_BOOST_RULE),
  id: 'boost-1',
  label: 'ねば〜る君',
  giftId: '14463',
  multiplier: 3,
  durationSec: 10,
};

/** タップブースト(フィーバー)の既定。ねば〜る君の1行だけを配る。 */
export const DEFAULT_TAP_BOOST: TapBoostConfig = {
  enabled: true,
  rules: [structuredClone(NEBAARU_TAP_BOOST_RULE)],
};

// ── お邪魔(タップ封じ) ────────────────────────────────────────────────────

/**
 * 封印の長さ(秒)の clamp。既定は 30(ユーザー要件)。
 *
 * 上限 60 は「1本で配信が壊れない」線。累積の天井は別に TAP_LOCK_MAX_MS があり、
 * そちらが安全弁(設定ミス・重ねがけ・時計飛びに耐える最後の壁)で、こちらは設定値
 * そのものの妥当性 — GIFT_FX_FREEZE_MAX_MS と durationSec の関係と同じ二段構え。
 */
export const TAP_LOCK_DURATION_MIN_SEC = 5;
export const TAP_LOCK_DURATION_MAX_SEC = 60;

/**
 * 封印の残り時間のハード上限(ms)。ユーザー決定(2026-08-18)で 120 秒。
 *
 * **これは演出方針ではなく安全弁。** 重ねがけの方針は「延長」なので、天井が無いと
 * 17連打コンボ1件で 8 分半ボタンが死ぬ。ラッチ時にも読み出し時にも効かせる —
 * NTP 巻き戻しやサスペンドで期限が未来に取り残される事故もここで潰す
 * (shared/fx-stage.ts の「時刻ラッチには必ずクランプを付ける」の規約)。
 */
export const TAP_LOCK_MAX_MS = 120_000;

/**
 * トリガーギフト1メッセージ(連打コンボ)あたりの発動回数の上限。
 * tapBoostActivationCount と同じ問題への同じ答え — 連打可能ギフト(giftType 1)は
 * normalize.ts が repeatCount へ畳んでくるので、素直に掛けると1件で天井へ張り付く。
 * 封印は2本ぶんまで(既定 30 秒 × 2 = 60 秒)。切り捨ては giftDiag に必ず記録する。
 */
export const TAP_LOCK_ACTIVATIONS_MAX = 2;

/** このトリガーギフト1メッセージで封印を何本ぶん重ねるか(tapBoostActivationCount と同型)。 */
export function tapLockActivationCount(repeatCount: number): number {
  return Math.min(TAP_LOCK_ACTIVATIONS_MAX, Math.max(1, Math.round(repeatCount)));
}

/** 登録できるお邪魔行の上限。TAP_BOOST_RULES_MAX と同じ 8。 */
export const TAP_LOCK_RULES_MAX = 8;

/**
 * 発動時に出す導入全面カット(不透明・音声焼き込み)の尺(ms)。
 * 素材は assets/fx/tap-lock/intro.mp4 で、この尺の契約で作る。
 * モニターは onEnded ではなく JS タイマーで打ち切る(REVOLUTION_INTRO_MS と同じ規約)。
 *
 * **封印そのものはこの5秒を待たない。** worker は一致した瞬間に絶対期限をラッチし、
 * 導入が流れている裏で残り時間は普通に減る(fx-priority.ts の④.5 の理由と同じ —
 * 「封印は worker の絶対時刻で走り、モニターが何を再生していようが時間は減る」)。
 * だから導入は封印より長くなってはいけない: モニターの入口ガードは
 * 「実尺(tapLockMs)がこの値以上」を要求する(最小設定 5 秒でちょうど等しい)。
 */
export const TAP_LOCK_INTRO_MS = 5_000;

/**
 * お邪魔1行の既定 = **進撃グローブ**(gift 6007 / 実受信の giftName は `boxing gloves`)。
 *
 * giftId を本線にするのは tapBoost / fanStamp と同じ規約。giftName は ID 変更時の保険で、
 * **ローマ字の実受信名**を入れる — 日本限定ギフトでも giftName はローマ字で届くので
 * (ねば〜る君 = 14463 / `nebaarukun`)、`'進撃'` のような日本語部分一致を置くと**一度も
 * 発火しない**(v0.6.0 で全面カット40行が無言で死んだのと同じ罠)。名前は長く固有なので
 * exactName は false のままでよい(前後の空白ゆれを吸収できる)。
 *
 * 機能スイッチ(DEFAULT_TAP_LOCK.enabled)は false のままなので、この行を配っても
 * 既存の settings.json の挙動は変わらない。
 *
 * DEFAULT_TAP_LOCK.rules[0] とは別に export しているのは DEFAULT_TAP_BOOST_RULE と
 * 同じ理由(noUncheckedIndexedAccess)。
 */
export const DEFAULT_TAP_LOCK_RULE: TapLockRule = {
  id: 'lock-1',
  label: '進撃グローブ',
  enabled: true,
  giftId: '6007',
  giftName: 'boxing gloves',
  canonical: '',
  exactName: false,
  durationSec: 30,
  // トリガーギフト自体は値を動かさない(tapBoost と同じ規約)。カウントも増やしたい
  // 配信者は設定画面で正の数を入れる。
  amountEach: 0,
  flash: true,
};

/**
 * お邪魔(タップ封じ)の既定。**機能そのものは既定で OFF** — 配信者の主操作を止める
 * 機能なので、キー欠損のフォールバックで勝手に有効化されてはならない。行は進撃グローブの
 * 1行だけ配り、配信者が設定画面でスイッチを入れた瞬間から使える状態にしておく。
 */
export const DEFAULT_TAP_LOCK: TapLockConfig = {
  enabled: false,
  rules: [structuredClone(DEFAULT_TAP_LOCK_RULE)],
};

// ── 革命 ─────────────────────────────────────────────────────────────────────

/**
 * 窓の長さ(秒)の clamp。既定は 60(ユーザー要件「制限時間1分」)。
 * tapBoost の 15 秒上限を使わないのは意図的 — あちらはシネマティック凍結の
 * 上限(GIFT_FX_FREEZE_MAX_TOTAL_MS=45s)に縛られるが、革命の窓は凍結を張らない
 * プレーン走行なので tapLock と同じ「配信が壊れない線」で決められる。
 */
export const REVOLUTION_DURATION_MIN_SEC = 10;
export const REVOLUTION_DURATION_MAX_SEC = 120;

/** 窓中のタップ倍率の clamp。既定は 3(ユーザー要件)。TAP_BOOST_MULT と同じ幅。 */
export const REVOLUTION_MULT_MIN = 1;
export const REVOLUTION_MULT_MAX = 100;

/**
 * 導入全面カットの尺(ms)。素材 assets/fx/revolution/intro.mp4 はこの尺の契約で作る
 * (24fps で **192 フレームちょうど**)。モニターは onEnded ではなく JS タイマーで
 * 打ち切る(startBandFx と同じ規約)。
 *
 * **結果カットシーン(REVOLUTION_RESULT_MS = 6秒)とは別の尺**。導入は「戦闘モードに
 * 入る」山場なので長く、結果は戦果を読ませるだけなので短い(2026-08-20 ユーザー決定で
 * 6秒 → 8秒へ変更)。前置き合計は導入8秒 + カウントダウン5秒 = **13秒**。
 */
export const REVOLUTION_INTRO_MS = 8_000;

/** 開始カウントダウン(5..1、DOM の大型数字)の尺(ms)。1秒刻み×5。 */
export const REVOLUTION_COUNT_MS = 5_000;

/**
 * 窓オープンから何ms間、中央上の大きな告知ボックス(.revolution-overlay)を出すか。
 * これを過ぎたら「革命 残りN秒 ×N」の小さなピル(.revolution-timer)へ引き継ぎ、
 * 盤面(タイトル・いいねゲージ)を1分間ふさぎ続けないようにする(2026-08-20 ユーザー決定)。
 * 起点は ChallengeState.revolution.startsAtMs の**絶対時刻**なので、窓の途中で
 * モニターを開き直しても告知は復活しない。
 */
export const REVOLUTION_HUD_INTRO_MS = 5_000;

/**
 * 窓の残り時間のハード上限(ms)。TAP_LOCK_MAX_MS と同じ二段構えの安全弁 —
 * 重ねがけの方針は「延長」なので、天井が無いと連打コンボで数分間ゲーム経済が
 * 変わりっぱなしになる。ラッチ時にも読み出し時(clampFutureMs)にも効かせる。
 */
export const REVOLUTION_MAX_MS = 180_000;

/** 登録できる革命行の上限。TAP_BOOST_RULES_MAX / TAP_LOCK_RULES_MAX と同じ 8。 */
export const REVOLUTION_RULES_MAX = 8;

/**
 * トリガーギフト1メッセージ(連打コンボ)あたりの尺加算の上限本数。
 * tapLockActivationCount と同じ問題への同じ答え — 窓は直列化できないので、
 * 掛けるのは発動回数ではなく尺(既定 60 秒 × 2 = 120 秒 < REVOLUTION_MAX_MS)。
 */
export const REVOLUTION_ACTIVATIONS_MAX = 2;

/** このトリガーギフト1メッセージで窓を何本ぶん重ねるか(tapLockActivationCount と同型)。 */
export function revolutionActivationCount(repeatCount: number): number {
  return Math.min(REVOLUTION_ACTIVATIONS_MAX, Math.max(1, Math.round(repeatCount)));
}

/**
 * 革命1行の既定 = **白鳥(Swan / 699💎)**。
 *
 * giftId が空なのは**未採取**だから — このリポジトリの規約(gift-aliases の
 * _topGifts)どおり、実イベントで確認できていない giftId は推測で焼かない。
 * 初回の実受信を diag.log(`[challenge/gift] 受信 giftId=...`)で確認したら
 * ここへ焼き込む(それまでは giftName の完全一致が本線)。
 *
 * exactName は必ず true — 'swan' は短く、'black swan' 等の別ギフトに部分一致
 * しうる。誤爆すると1分間ゲーム経済が変わるので、tapLock より代償が大きい。
 */
export const DEFAULT_REVOLUTION_RULE: RevolutionRule = {
  id: 'rev-1',
  label: '白鳥',
  enabled: true,
  giftId: '',
  giftName: 'swan',
  canonical: '',
  exactName: true,
  multiplier: 3,
  durationSec: 60,
  flash: true,
};

/**
 * 革命の既定。**機能そのものは既定で OFF**(DEFAULT_TAP_LOCK と同じ判断)—
 * いいね妨害の反転はゲーム経済の意味を変えるので、キー欠損のフォールバックで
 * 勝手に有効化されてはならない。行は白鳥の1行だけ配り、配信者が設定画面で
 * スイッチを入れた瞬間から使える状態にしておく。
 */
export const DEFAULT_REVOLUTION: RevolutionConfig = {
  enabled: false,
  rules: [structuredClone(DEFAULT_REVOLUTION_RULE)],
};

// ── お題ルーレット(quiz) ──────────────────────────────────────────────────

/**
 * 挑戦ウィンドウ(制限時間)の秒数の clamp。既定は 60(ユーザー要件「1分」)。
 * 革命と同じくプレーン走行(凍結を張らない)なので、上限は「配信が壊れない線」。
 */
export const QUIZ_DURATION_MIN_SEC = 10;
export const QUIZ_DURATION_MAX_SEC = 300;

/** 投票タイムの秒数の clamp。既定は 30(ユーザー決定: 終了後に投票タイム)。 */
export const QUIZ_VOTE_MIN_SEC = 5;
export const QUIZ_VOTE_MAX_SEC = 120;

/** 増減幅の clamp。既定は 5000。上限はルーレット出目(sanitizeRouletteSegments)と同じ。 */
export const QUIZ_AMOUNT_MIN = 1;
export const QUIZ_AMOUNT_MAX = 9_999_999;

/** お題リストの上限。1件あたりの文字数はモニターの全画面表示に収まる線。 */
export const QUIZ_PROMPTS_MAX = 50;
export const QUIZ_PROMPT_LEN_MAX = 60;

/** 判定ワードの上限(good/bad 各)。 */
export const QUIZ_WORDS_MAX = 10;
export const QUIZ_WORD_LEN_MAX = 20;

/** 登録できるトリガー行の上限。REVOLUTION_RULES_MAX と同じ 8。 */
export const QUIZ_RULES_MAX = 8;

/**
 * アーム(発動予約)の期限(ms)。モニターが「発動時点で溜まっていた演出キューを
 * 消化し切る」のを待つ仕様なので、BOOST_ARM_MAX_MS(60s)より長い —
 * ultra ルーレット(約32秒)の連鎖が数本残っていても完走を待てる線。
 * 期限が切れたら worker がプレーン強制発動する(commitArmedQuizIfExpired)。
 */
export const QUIZ_ARM_MAX_MS = 120_000;

/**
 * 導入全面カット(introClip)の尺(ms)。**専用素材 `assets/fx/quiz/intro.mp4` の
 * 192 フレーム(8.000 秒)と対**なので、片方だけ動かさないこと
 * (REVOLUTION_INTRO_MS と素材の関係と同じ規約)。
 *
 * 2026-08-22 に 5 秒 → 8 秒。5 秒だったのは「全面カット素材(assets/fx/cut/)を
 * 借りて流す枠」でしかなかった時代の名残で、あちらの契約(giftFullCut の
 * durationSec: 5)に合わせていたもの。専用素材の投入に合わせて革命と同じ
 * 8 秒契約へ寄せた。**cut/*.mp4 を introClip に選ぶと素材(5.06 秒)より長くなる**が、
 * モニターの導入ホルダーは loop も onEnded も持たないので、素材が尽きたあとは
 * 最終フレーム(白金フラッシュ)で静止したまま残り約 3 秒を待つ — 黒画面にも
 * 巻き戻りにもならない。尺の権威は素材ではなくこの定数(JS タイマーが打ち切る)。
 *
 * モニターは onEnded ではなく JS タイマーで打ち切る(既存規約)。
 */
export const QUIZ_INTRO_MS = 8_000;

/**
 * `QuizConfig.introClip` が**専用素材**(`assets/fx/quiz/intro.mp4`)を指すときの値。
 * 他の候補は 'off' か全面カットのカタログ(`FULL_CUT_CLIP_IDS` = すべて `cut-` 始まり)
 * なので、この番兵と衝突しない。URL 解決は renderer の `QUIZ_INTRO_CLIP_URL`
 * (0 件許容 — 素材が無ければ導入だけスキップして回転から始まる)。
 */
export const QUIZ_INTRO_SELF = 'quiz';

/**
 * お題回転の拍(2026-08-22 ユーザー決定「回転は今の3倍・焦らしをたっぷり」)。
 * `ROULETTE_ULTRA_BEATS` と同じ流儀 — **尺の権威はこの表**で `QUIZ_SPIN_MS` は総和。
 *
 * 振り付け: 幕開け → 高速回転① → フェイクストップ① → 再加速② → ニアミス →
 * よろよろ → 最後の溜め →(決定パンチ `QUIZ_REVEAL_MS` へ)。
 *
 * ★ **`tailMs` の意味は `ROULETTE_ULTRA_BEATS` と逆**。ultra の tailMs は「当選が
 *   見えてからの溜め」だが、こちらは**ハズレ(当選の1つ手前)を掴んだまま
 *   引っぱる最後の間**。お題の当選は決定パンチで初めて出る — 回転の最終コマと
 *   決定表示は同時刻に予約され、同期スコープで先に登録された決定表示が勝つので、
 *   当選コマは回転中に一度も描かれない(2026-08-21 の実装からの挙動)。
 *   この形にしてあるおかげで `quizSpinTicks` の契約(最終コマは show === winner・
 *   atMs >= totalMs)を変えずに焦らしが載る。**逆の意味で使わないこと。**
 *
 * `runStepMs` / `crawlStepMs` は「目標のコマ間隔」で、コマ数はここから導出する
 * (`QUIZ_SPIN_STEPS`)。**下限は OBS 30fps の2フレーム ≒ 66ms** — これより細かく
 * 刻んでも再描画が間に合わず、`MonitorView` の全体再レンダーがコマ落ちするだけ
 * (`ROULETTE_ULTRA_BEATS` の走行距離に同じ配慮がある)。
 */
export const QUIZ_SPIN_BEATS = {
  /**
   * 幕開け。緞帳が開き切るまでの時間で、**`run1Ms` の内側**にある(総和には足さない)。
   * この間もリールは回っている — 幕が開いた瞬間にはもう飛んでいるほうが勢いが出るので、
   * 「幕の裏で1コマ据える」形にはしない。CSS の `.qz-curtain` のアニメ尺はこの値の
   * 内側に収めること(`test/renderer/quiz-fx.spec.ts` が機械照合する)。
   */
  openMs: 1_200,
  /** 高速回転①(頭の `openMs` は緞帳の裏)。 */
  run1Ms: 5_400,
  /** フェイクストップ①。ハズレを掴んで止まる(cue: 'fake')。 */
  fake1Ms: 1_400,
  /** 再加速②。 */
  run2Ms: 3_200,
  /** ニアミス。当選の1つ手前で長く止まる(cue: 'near')。 */
  nearMs: 1_600,
  /** よろよろ。1コマずつ間隔が伸びる(cue: 'crawl')。 */
  crawlMs: 2_600,
  /** 最後の溜め。**ハズレを掴んだまま**引っぱる(上の ★ を参照)。 */
  tailMs: 3_800,
  /**
   * 走行拍(run1 / run2)の目標コマ間隔。差し替えのたびに `MonitorView` が丸ごと
   * 再レンダーされるので、下げすぎると OBS でコマ落ちする。80ms ≒ 12.5 コマ/秒。
   */
  runStepMs: 80,
  /** よろよろの入りのコマ間隔(ここから tail に向けて伸びる)。 */
  crawlStepMs: 260,
} as const;

/**
 * `QUIZ_SPIN_BEATS` の総和 = 回転の尺。export しない(ultra と同じ)。
 * **`openMs` は `run1Ms` の内側なので足さない。**
 */
function quizSpinTotalMs(b: typeof QUIZ_SPIN_BEATS): number {
  return b.run1Ms + b.fake1Ms + b.run2Ms + b.nearMs + b.crawlMs + b.tailMs;
}

/**
 * お題回転演出(全画面テキストの減速差し替え)の尺(ms)= `QUIZ_SPIN_BEATS` の総和。
 *
 * 2026-08-22 に 6,000 → **18,000**(ユーザー指定「今の3倍」)。
 * **「お題は読ませる必要があるので焦らしはしない」という旧方針はここで撤回された** —
 * 読ませるのは決定パンチ以降(発表 → 準備 → 制限時間のあいだ、めくりが出っぱなし)が
 * 受け持ち、回転そのものは寄席の見世物として引っぱる。
 */
export const QUIZ_SPIN_MS = quizSpinTotalMs(QUIZ_SPIN_BEATS);

/**
 * お題決定の全面パンチ表示の尺(ms)。この後「お題発表準備」へ引き継ぐ。
 * 2026-08-22 に 2,500 → **4,000** — 回転を3倍に伸ばした山場の着地なので、
 * 座布団が積み上がり切る(CSS の `.qz-zabuton` は 300ms 遅延 + 420ms)前に
 * 幕が変わってしまわない長さが要る。
 */
export const QUIZ_REVEAL_MS = 4_000;

/**
 * 「お題発表準備」(発表 → 制限時間の間の仕度時間)の秒数の範囲。
 * **0 でこの区間ごとスキップ**(2026-08-22 以前とまったく同じ進行に戻る)ので
 * 下限は 0 — durationSec/voteSec のように「短すぎると企画が成立しない」性質が無い。
 */
export const QUIZ_PREP_MIN_SEC = 0;
export const QUIZ_PREP_MAX_SEC = 60;

/**
 * 「終了後BGM」(投票締切から鳴らし続ける尺)の秒数の範囲。0 で無効。
 * 上限が QUIZ_VOTE_MAX_SEC と同じ 120 なのは、結果発表(6秒)の後に
 * フリートークを乗せる用途を想定した線。
 */
export const QUIZ_OUTRO_MIN_SEC = 0;
export const QUIZ_OUTRO_MAX_SEC = 120;

/**
 * 区間BGM スロットの番兵「**前の区間の曲を鳴らし続ける**」。
 *
 * これが要るのは後方互換のため — 新スロットの既定を 'off' にすると、保存済み
 * settings.json のユーザーは決定表示の瞬間に曲が止まる(退行)。既定を 'keep' に
 * すれば「発動から清算まで1曲」という 2026-08-22 以前の挙動と完全に一致する。
 *
 * bgm.ts の id 接頭辞規約('bgm-*' / 'spin-*' / 'custom:')と衝突しない
 * (先例は QUIZ_INTRO_SELF)。**先頭区間の `bgm` だけは受け付けない** —
 * 継続元が無いので、validateQuiz の既存分岐が未知 id として既定へ倒す。
 */
export const QUIZ_BGM_KEEP = 'keep';

/**
 * 区間をまたぐ BGM 切替のクロスフェード尺(ms)。前の曲を fade-out させながら
 * 次の曲を fade-in で重ねる。短いのは「区間が変わった」ことを聞かせるのが目的で、
 * 曲を混ぜたいわけではないため。
 */
export const QUIZ_BGM_XFADE_MS = 400;

/**
 * 結果発表カットシーン(票数→判定→±のロールアップ)の尺(ms)。
 * REVOLUTION_RESULT_MS と同じ 6 秒(全画面 DOM のみ・動画素材なし)。
 */
export const QUIZ_RESULT_MS = 6_000;

/**
 * バリア(発動〜清算に届いたイベントの後回し)で溜められる op の上限。
 * pendingOps の GIFT_FX_PENDING_OPS_MAX(256)より大きいのは、窓+投票の
 * 90 秒超を跨ぐため。溢れたら演出なしで値だけ即時適用(既存の溢れ弁哲学)。
 */
export const QUIZ_DEFERRED_OPS_MAX = 512;

/**
 * 判定ワードの既定。**先頭が投票画面の表示語**(goodLabel/badLabel)になる。
 * 部分一致・大文字小文字無視なので表記ゆれはある程度この3語で拾える。
 */
export const DEFAULT_QUIZ_GOOD_WORDS: readonly string[] = ['よかった', '良かった', 'ヨカッタ'];
export const DEFAULT_QUIZ_BAD_WORDS: readonly string[] = ['だめ', 'ダメ', '駄目'];

/**
 * お題ルーレット1行の既定。giftId / giftName が空なのは**未採取**だから —
 * どのギフトを割り当てるかは企画ごとに違うので、既定では何にも一致しない行を
 * 1行だけ配り、配信者が設定画面で埋めた瞬間から使える状態にしておく
 * (DEFAULT_REVOLUTION_RULE の白鳥と同じ「実 giftId は推測で焼かない」規約)。
 */
export const DEFAULT_QUIZ_RULE: QuizRule = {
  id: 'quiz-1',
  label: 'お題ルーレット',
  enabled: true,
  giftId: '',
  giftName: '',
  canonical: '',
  exactName: false,
  flash: true,
};

/**
 * v0.13.0(SETTINGS_VERSION 11)まで出荷していた「例」のお題1件。
 * migrateChallengeQuizPrompts が「配信者がまだ触っていないか」を判定するためだけの
 * 定数で、既定リストからは外れている(カタカナ表記の『誰もやったことないモノマネ』が
 * 実質の後継)。**この文字列は書き換えない** — 変えると v12 の移行が誰にも一致しなくなる。
 */
export const QUIZ_PROMPT_SHIPPED_V11 = '誰もやったことないものまね';

/**
 * v0.14.0(SETTINGS_VERSION 12)の出荷既定お題28件(2026-08-22 ユーザー提供)。
 *
 * **この配列は増やさない** — 移行(migrateChallengeQuizPrompts)が配るのはこの28件だけで、
 * DEFAULT_QUIZ.prompts を参照させると次の世代で既定が増えたときに v12 の段が新しい行まで
 * 配って二重適用になる(STAMP_TRIGGER_RULES_V8 / FULL_CUT_CLIPS_V3 と同じ理由)。お題を
 * 増やすときは DEFAULT_QUIZ.prompts 側に別の配列を継ぎ足し、既存ユーザーへ届けたいなら
 * 新しい世代の移行を書くこと。
 *
 * 全件が QUIZ_PROMPT_LEN_MAX(60)以内・前後空白なし・重複なしで、件数も QUIZ_PROMPTS_MAX
 * (50)以内 = **sanitizeStringList の不動点**。ここが崩れると validateQuiz の出力が既定と
 * 食い違い、boot-settings.spec の冪等検査まで落ちる(壊れ方の詳細は
 * test/unit/quiz-prompts-default.spec.ts の冒頭)。
 */
export const QUIZ_PROMPTS_V12: readonly string[] = [
  '底辺YouTubeのキャッチコピー挨拶',
  '近くにあるものと本気で喧嘩',
  '誰もやったことないモノマネ',
  '悲しい話を満面の笑顔で話す',
  'カメラに向かってエア告白',
  'コンビニの商品になりきって自己紹介',
  '誰もやったことない必殺技を本気で披露',
  '最弱のヒーローになって自分の能力を自慢する',
  '未来から来た人として重大発表',
  '自分の動作を全部実況しながら過ごす',
  'ゲームのNPCになって同じセリフしか言えない',
  '能力披露「ちょっとだけ風を起こせる」',
  '世界一どうでもいいギネス記録に挑戦',
  '絶対に流行らない新しい挨拶',
  '新しいじゃんけんを発明する',
  '絶対に売れないアイドルのキャッチコピー',
  '世界一怖い「おやすみ」',
  'ボタンに相談する',
  '「あ」だけで感情を5種類表現',
  '自分の長所を全部デメリットぽく紹介',
  '自分の短所を超能力みたいに紹介',
  '突然YouTuberになって物をレビュー',
  '自分の右手と左手を別人格にして喧嘩させる',
  '架空の都道府県を紹介する',
  '突然記憶を失った人を演じる',
  '普通の出来事を武勇伝として語る',
  '空気を食べて食レポする',
  '宇宙一くだらない発明をプレゼンする',
];

/**
 * お題ルーレットの既定。**機能そのものは既定で OFF**(DEFAULT_REVOLUTION と同じ
 * 判断)— 全アクション停止+投票で±5000 はゲーム経済の大技なので、キー欠損の
 * フォールバックで勝手に有効化されてはならない。旧 settings.json にこのキーは
 * 無いので、**欠損時のフォールバックが移行の代わり**になる(SETTINGS_VERSION は
 * 上げない)。お題は QUIZ_PROMPTS_V12 の28件を配る — 空のままだと enabled にしても不発で、
 * 初回の動作確認(▶実演)すらできないため。**リストの中身**の方は既定を直しても保存済みの
 * settings.json には届かない(prompts キーは v0.13.0 以降どの設定も持っている)ので、
 * migrateChallengeQuizPrompts(SETTINGS_VERSION 12)が別途一度だけ配る。
 */
export const DEFAULT_QUIZ: QuizConfig = {
  enabled: false,
  rules: [structuredClone(DEFAULT_QUIZ_RULE)],
  prompts: [...QUIZ_PROMPTS_V12],
  durationSec: 60,
  voteSec: 30,
  amount: 5000,
  goodWords: [...DEFAULT_QUIZ_GOOD_WORDS],
  badWords: [...DEFAULT_QUIZ_BAD_WORDS],
  // 発動の瞬間に BGM が変わること自体が「お題モードが来る」予告(ユーザー決定)
  // なので、既定から実曲を割り当てる(DEFAULT_ROULETTE_SOUND の bgm:'off' とは
  // 逆向きの判断 — こちらは曲が鳴らないと仕様が成立しない)。
  bgm: 'bgm-roulette1',
  bgmVolume: 70,
  // ── 区間別BGM(2026-08-22)。**既定はすべて 'keep'** = 前の区間の曲を続ける。
  // これで設定を触っていないユーザーの挙動は「発動から清算まで1曲」のまま
  // 1ミリも変わらない(欠損フォールバックが移行の代わりになる条件でもある)。
  revealBgm: QUIZ_BGM_KEEP,
  revealBgmVolume: 70,
  // お題発表準備の尺。既定 5 秒(2026-08-22 ユーザー決定)。0 で区間ごとスキップ。
  prepSec: 5,
  prepBgm: QUIZ_BGM_KEEP,
  prepBgmVolume: 70,
  thinkBgm: QUIZ_BGM_KEEP,
  thinkBgmVolume: 70,
  voteBgm: QUIZ_BGM_KEEP,
  voteBgmVolume: 70,
  // ── 終了後BGM。尺の既定は 20 秒だが、曲の既定は **'off'** —
  // 出荷 v0.13.0 は投票締切で無音になる仕様だったので、'keep' にすると
  // 「勝手に 20 秒鳴り続けるようになった」という驚きを配ることになる。
  // 鳴らしたい人が選ぶ('off' 以外にする)まで従来どおり無音。
  outroSec: 20,
  outroDownBgm: 'off',
  outroDownBgmVolume: 70,
  outroUpBgm: 'off',
  outroUpBgmVolume: 70,
  // 導入全面カットは**専用素材が既定**(2026-08-22)。出荷 v0.13.0 の 'off' は
  // 「導入は要らない」ではなく「専用素材がまだ無い」という意味だったので、
  // 素材の投入に合わせて既定を引き上げ、保存済み設定には
  // migrateChallengeQuizIntro(settingsVersion 11)が一度だけ届ける。
  introClip: QUIZ_INTRO_SELF,
};

/**
 * 最終ゲートの必要タップ数の範囲。下限 2 — taps: 1 は通常挙動と実質同じで
 * 無意味(1タップで1減算)なので、設定として許さない。
 */
export const FINAL_GATE_TAPS_MIN = 2;
export const FINAL_GATE_TAPS_MAX = 999;

/**
 * 最終ゲート(ラスト◯◯モード)の既定。enabled: true — 「ラスト10は連打で削り切る」
 * 演出を出荷時から動かす決定(2026-08-19 ユーザー決定)。保存済み settings.json に
 * このキーは無いが、欠損が既定へ倒れること自体が移行の代わりになる。
 * 閾値は独立キーを持たず lowThreshold(既定10)に連動する。
 */
export const DEFAULT_FINAL_GATE: FinalGateConfig = {
  enabled: true,
  taps: 30,
};

/**
 * コーギー(gift 6267 / 299💎)のブースト行。settingsVersion 7 の移行が
 * 「まだ無ければ1回だけ」追加する実体で、同梱既定の追加行でもある。
 * 倍率・尺は黒豹と同じ(×3 / 10秒)から始める — ユーザーが設定画面で調整する前提。
 */
export const CORGI_TAP_BOOST_RULE: TapBoostRule = {
  ...structuredClone(DEFAULT_TAP_BOOST_RULE),
  id: 'boost-corgi',
  label: 'コーギー',
  giftId: '6267',
  // 名前一致は使わない(giftId が本線)。立てるだけなら実害は無いが、
  // 'corgi' は実カタログで Corgi 1件だけなので部分一致でも衝突しない。
  giftName: '',
  multiplier: 3,
  durationSec: 10,
  introClip: 'intro-corgi',
  countClip: 'count-corgi',
  loopClip: 'loop-corgi',
  // コーギーだけは result 素材が同梱されているので既定で出す。
  resultClip: 'result-corgi',
};

/**
 * 連打ギフトの演出反復の既定。enabled: true — これは新機能ではなく「同じ人が同じ
 * ギフトを連打しても演出が1回しか出ない」の修正なので、オプトインにはしない。
 * bandEnabled / rouletteEnabled も既定 true(利用者の明示選択)。カットインは
 * 6秒×5=30秒カウンタが止まるので、重ければ設定画面で回数を下げるか外す。
 */
export const DEFAULT_GIFT_REPEAT_FX: GiftRepeatFxConfig = {
  enabled: true,
  max: 5,
  intervalMs: GIFT_FX_REPEAT_MS,
  bandEnabled: true,
  rouletteEnabled: true,
};

export const DEFAULT_CHALLENGE: ChallengeConfig = {
  enabled: false,
  title: '0まで寝ない',
  initialValue: 1000,
  pressStep: 1,
  followStep: 10,
  // いいね妨害は既定で無効(likeEvery: 0)— like は高頻度なので明示オプトイン。
  likeEvery: 0,
  likeStep: 1,
  // ストックも既定で無効(likeStockCount: 0)— ゲージ満タンの従属機能なので同じくオプトイン。
  likeStockCount: 0,
  likeStockStep: 25,
  // カットイン動画の焼き込み音声。giftFullCut.volume と同じ 70 に揃える —
  // 「全面カットの音量は既定 70」を2箇所で食い違わせないため。
  stockCutinVolume: 70,
  // 指定コメント妨害は既定で規則なし(= オフ)— キーワードは企画ごとに違うので
  // 既定を置きようがない(fanStamp の giftId と同じ判断)。
  commentRules: [],
  giftRules: [],
  // 既定はギフト=妨害: 1ダイヤにつき +1(設定画面で応援方向へ変更できる)。
  giftDefault: { mode: 'perDiamond', amount: 1 },
  roulettes: structuredClone(DEFAULT_ROULETTES) as ChallengeRouletteConfig[],
  joinRoulette: structuredClone(DEFAULT_JOIN_ROULETTE),
  rouletteSound: { ...DEFAULT_ROULETTE_SOUND },
  rouletteSoundSub: defaultRouletteSoundSub(DEFAULT_ROULETTE_SOUND),
  rouletteTease: structuredClone(DEFAULT_ROULETTE_TEASE),
  // モニターのリールは確定済みの出目の遅延再生なので、伏せないとログが
  // 常にリールより先に答えを出す。既定でネタバレを止める。
  hideRouletteResultInLog: true,
  flashMinDiamonds: 100,
  hotkey: 'F9',
  monitorDisplayId: null,
  monitorWindowed: false,
  // 「何時起き」は既定でオフ(全員がやる企画ではない)。時刻はライブ画面で入れる。
  wakeEnabled: false,
  wakeTime: null,
  lowThreshold: 10,
  // ルーレット中の「残り」小窓。既定は 'small' — 暗幕と ultra の全画面動画で
  // 最長 31 秒ほど7セグが読めなくなるので、出すほうを既定に倒す。
  rouletteCountView: 'small',
  seEnabled: true,
  seVolume: 70,
  seSounds: { ...DEFAULT_SE_SOUNDS },
  seVolumes: { ...DEFAULT_SE_VOLUMES },
  fxClipsEnabled: true,
  miniFxEnabled: true,
  miniFx: { ...DEFAULT_MINI_FX },
  giftFullCut: structuredClone(DEFAULT_GIFT_FULL_CUT),
  giftBandFx: structuredClone(DEFAULT_GIFT_BAND_FX),
  giftRepeatFx: structuredClone(DEFAULT_GIFT_REPEAT_FX),
  fanStamp: structuredClone(DEFAULT_FAN_STAMP),
  stampTriggers: structuredClone(DEFAULT_STAMP_TRIGGERS),
  tapBoost: structuredClone(DEFAULT_TAP_BOOST),
  tapLock: structuredClone(DEFAULT_TAP_LOCK),
  revolution: structuredClone(DEFAULT_REVOLUTION),
  quiz: structuredClone(DEFAULT_QUIZ),
  finalGate: { ...DEFAULT_FINAL_GATE },
};

/**
 * playSe に渡す実効音量(0-100)。全体音量 × スロットごとの相対音量(%)。
 * slotPct が欠損なら 100(= 全体音量そのまま)として扱う — モニター窓は設定を
 * 120秒ポーリング(CFG_POLL_MS)で拾うので、個別音量を持たない古い設定が渡ってくることがある。
 */
export function effectiveSeVolume(master: number, slotPct: number | undefined): number {
  const m = Math.min(100, Math.max(0, master));
  const p = Math.min(100, Math.max(0, slotPct ?? 100));
  return (m * p) / 100;
}

/** ギフト演出の段階。1=小さなお礼〜4=全画面のお祭り。 */
export function tierForDiamonds(diamonds: number): 1 | 2 | 3 | 4 {
  if (diamonds >= 5000) return 4;
  if (diamonds >= 1000) return 3;
  if (diamonds >= 100) return 2;
  return 1;
}

/**
 * ギフト → 簡易演出 id の写像。ダイヤ数の tier スロット(gift-t1〜t4)で解決する
 * — スロット側を変えればその段階のギフト全体に効く。戻り null は「出さない」。
 */
export function matchGiftMini(cfg: ChallengeConfig, g: { diamonds: number }): string | null {
  if (!cfg.miniFxEnabled) return null;
  return miniForSlot(cfg, `gift-t${tierForDiamonds(g.diamonds)}` as ChallengeSeSlot);
}

/**
 * ギフト → 全面カットの写像。**上から順に評価し、最初に一致した1行だけ**を返す
 * (giftRules / roulettes と同じ先勝ち)。戻り null は「全面カットは出さない」=
 * 従来のダイヤ帯域カットイン(matchGiftBand)へ落ちる。
 *
 * **matchGiftBand より先に呼ぶこと**が唯一の優先度の担保 — 全面カットが一致したら
 * 帯域は評価しない(worker/challenge.ts の giftOp)。帯域と違いダイヤ数を見ないので、
 * 1ダイヤのギフトでも高額ギフトでも同じカットインが出る。
 *
 * fxClipsEnabled(演出クリップ全体のスイッチ)を尊重するのは matchGiftBand と同じ。
 */
export function matchGiftFullCut(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): GiftFullCutRule | null {
  const fc = cfg.giftFullCut;
  if (!fc.enabled || !cfg.fxClipsEnabled) return null;
  for (const r of fc.rules) {
    if (!r.enabled || r.clip === 'off') continue;
    if (matchGiftTrigger(r, g)) return r;
  }
  return null;
}

/**
 * ギフト → ダイヤ帯域カットインの写像。一致した帯域を返す(クリップ 'off' や
 * 除外・無効は null)。
 *
 * 除外は giftId が本線 — ライブ経路では NormalizedEvent.canonical が未代入
 * (matchRouletteTrigger と同じ制約)。canonical 'heart_me' は保険で常に除外。
 * 帯域は上から順に評価し、どの帯域にも入らない diamonds が最上位バンドの max を
 * 超えていたら overflow に従う('top' = 最上位の有効バンドを適用)。
 */
export function matchGiftBand(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; diamonds: number }
): GiftFxBand | null {
  const bf = cfg.giftBandFx;
  if (!bf.enabled || !cfg.fxClipsEnabled) return null;
  if (g.diamonds <= 0) return null;
  if (bf.excludeGiftIds.includes(g.giftId)) return null;
  if (g.canonical != null && g.canonical.toLowerCase() === 'heart_me') return null;
  const usable = (b: GiftFxBand): boolean => b.enabled && b.clip !== 'off';
  for (const b of bf.bands) {
    if (usable(b) && g.diamonds >= b.min && g.diamonds <= b.max) return b;
  }
  if (bf.overflow === 'top') {
    // 「最上位」= max が最大の有効バンド。並び替えに依存しない。
    let top: GiftFxBand | null = null;
    for (const b of bf.bands) {
      if (usable(b) && (top === null || b.max > top.max)) top = b;
    }
    if (top && g.diamonds > top.max) return top;
  }
  return null;
}

// ── 連打ギフトの演出反復 ─────────────────────────────────────────────────────
//
// 規約: **反復するのは見た目だけ。値・統計・ランキング・履歴ログは1件のまま。**
// worker が回数を決めて effect に焼き込み(fxRepeat/fxRepeatIntervalMs)、モニターは
// それを読むだけ — cfg は120秒ポーリング(CFG_POLL_MS)で古くなりうるので再判定させない
// (fxBandClip / rouletteSegments と同じ「effect 1件で自己完結」の流儀)。

/**
 * ギフト1件に対して演出を何回撃つか。worker 側の唯一の判断点。
 *
 * banded(カットイン一致)のときは間隔ではなく尺ぶんの直列再生になるため、
 * 総凍結が GIFT_FX_FREEZE_MAX_TOTAL_MS を超えないよう**回数側**を削る
 * (fxDurationMs は削らない — 1本の尺はモニターとの契約)。
 */
export function giftFxRepeat(
  cfg: ChallengeConfig,
  repeatCount: number,
  opts: { banded: boolean; fxDurationMs: number }
): number {
  const rf = cfg.giftRepeatFx;
  if (!rf.enabled) return 1;
  const cap = Math.min(GIFT_FX_REPEAT_MAX, Math.max(1, Math.round(rf.max)));
  let rep = Math.min(cap, Math.max(1, Math.round(repeatCount)));
  if (rep <= 1) return 1;
  if (opts.banded) {
    if (!rf.bandEnabled || opts.fxDurationMs <= 0) return 1;
    rep = Math.min(rep, Math.max(1, Math.floor(GIFT_FX_FREEZE_MAX_TOTAL_MS / opts.fxDurationMs)));
  }
  return rep;
}

// ── ルーレットの抽選回数と演出本数 ───────────────────────────────────────────
//
// 規約: **抽選回数は贈られた個数そのもの。演出の設定では絶対に削らない。**
// ルーレットは抽選なので、連打ぶんを表すには出目を N 回引くしかなく、他の演出と
// 違って**値の増減も回数ぶんになる**。v0.5.4 まではここに演出用の
// giftRepeatFx.max(既定 5)が掛かっており、バラ17連打が5回ぶんしか値に反映
// されなかった(視聴者が贈った12個ぶんが消える)。回数と見た目をここで分離する。

/**
 * このギフト1メッセージで何回抽選するか。**値・統計はこの回数ぶん動く。**
 * 上限はハードリミット(ROULETTE_DRAWS_MAX)だけ — 設定では削らない。
 */
export function rouletteDrawCount(repeatCount: number): number {
  return Math.min(ROULETTE_DRAWS_MAX, Math.max(1, Math.round(repeatCount)));
}

/**
 * そのうち実際にリールを回す本数。**見た目だけの clamp** で、値には影響しない
 * (超過分はモニターが合算バナー1枚で締める)。
 * giftRepeatFx.rouletteEnabled が false なら 1本 — 「連打でも演出は1回でいい」
 * という設定の意味はここに残す(値は個数ぶんのまま)。
 */
export function rouletteReelCount(cfg: ChallengeConfig, draws: number): number {
  const n = Math.max(1, Math.round(draws));
  const rf = cfg.giftRepeatFx;
  if (!rf.enabled || !rf.rouletteEnabled) return 1;
  return Math.min(ROULETTE_REELS_MAX, n);
}

/**
 * effect 1件 → スピンごとの {index, pattern, amount}。
 *
 * **MonitorView とテストがこれを共有する唯一の実装。** レンダラのテスト環境が
 * このリポジトリに無いので、決定ロジックを純関数としてここへ置く
 * (fx-drain.ts / appendChallengeLog と同じ流儀)。
 *
 * amount は effect 全体の合計なので符号を引けない — 1回ぶんの増減は
 * `rouletteSegments[index] × (rouletteDirection === 'sub' ? -1 : 1) × (rouletteHotMult ?? 1)`
 * で復元する。rouletteIndexes を持たない古い effect(worker 混在)は単発として扱う。
 *
 * **激熱確定(rouletteHotMult)の倍率をここで掛けるのが唯一の実装。** worker は既に
 * 倍率込みの値を適用しているので、ここで掛け忘れるとモニターの据え置き会計
 * (rouletteRemainingAmount → heldValueFor)が worker とズレて、リールが止まった
 * 瞬間に数字が飛ぶ/巻き戻る。
 */
export function rouletteDraws(
  e: ChallengeEffect
): Array<{ index: number; pattern: RoulettePattern; amount: number }> {
  const segs = e.rouletteSegments ?? [];
  if (segs.length === 0) return [];
  const idxs = e.rouletteIndexes ?? (e.rouletteIndex != null ? [e.rouletteIndex] : []);
  const pats = e.roulettePatterns ?? [];
  // 残量クランプ発生時だけ worker が焼く実適用量(dto の rouletteAmounts 参照)。
  // あれば名目式より**優先** — 名目のままだと据え置き会計が worker とズレて
  // リール再生待ちの間の 7 セグが水増しされる。
  const amts = e.rouletteAmounts;
  // 激熱確定の実倍率。載っていなければ 1 = 従来と 1 バイトも変わらない。
  // clamp は worker/検証/段のはしごと**同じ1本**(rouletteHotMultOf → clampRouletteHotMult)。
  const sign = (e.rouletteDirection === 'sub' ? -1 : 1) * rouletteHotMultOf(e);
  const out: Array<{ index: number; pattern: RoulettePattern; amount: number }> = [];
  for (let i = 0; i < idxs.length; i++) {
    // 盤面外の index は捨てる(盤面を編集した直後の古い effect への保険)。
    const index = idxs[i]!;
    if (index < 0 || index >= segs.length) continue;
    out.push({
      index,
      pattern: pats[i] ?? e.roulettePattern ?? 'slow',
      amount: amts?.[i] ?? segs[index]! * sign,
    });
  }
  return out;
}

/**
 * ルーレット effect の「盤面の同一性」キー。
 *
 * 出目 index は盤面に対する位置なので、**盤面が違う effect の出目は連結できない**
 * (ハートミーの 3 番目とバラの 3 番目は別の額)。worker の凍結ドレイン畳み込みと
 * モニターのキュー連結が同じ規約を使うための唯一の実装。
 *
 * **rouletteId(行の同一性)は入れない。** ここは「出目 index の意味が同じか」=
 * 正しさの判定で、行ごとの回転サウンドのような演出の都合を混ぜるとキーの意味が
 * 二重になる。入れると、表示名・出目・向きが全一致するだけの別行が畳めなくなり、
 * モニターのキュー満杯時に「盤面違いで連結できない → バナーのみでリールが出ない」
 * 経路(playFx の分岐が明示的に忌避している最悪の見え方)へ落ちる頻度が上がる。
 * 畳まれた 1 本をどの行の音で鳴らすかは mergeRoulette / finishDrain が
 * **先頭 a に固定**して決着させる(nickname と同じ規約)。
 *
 * **rouletteOrigin(由来印)は入れる。** rouletteId と違って由来は「出目 index の
 * 意味」の一部 — 入室とギフトは再生キューが別(入室は優先度⑥の専用キュー)なので、
 * 表示名・盤面が全一致しても畳んでしまうと片方のキューへ吸われて他方が消える。
 * label('初見さん')による衝突回避はユーザー編集で破れる(ギフト行に同名を
 * 付けられる)ため、構造で分離する。
 *
 * **激熱確定の倍率(rouletteHotMult)も入れる。** rouletteOrigin と同じ理由 —
 * 倍率が違えば同じ index が別の額を意味するので、表示名・盤面・向きが全一致する
 * 激熱行と通常行を畳むと rouletteDraws の復元が壊れる(値が 50 倍ズレる)。
 * worker の finishDrain のグループキーもモニターのキュー連結もこの1本を共有するので、
 * ここに入れるだけで両方の経路が同時に守られる。
 */
export function rouletteBoardKey(e: ChallengeEffect): string {
  return `${e.rouletteOrigin ?? ''}|${e.rouletteLabel ?? ''}|${e.rouletteDirection ?? 'add'}|${e.rouletteHotMult ?? ''}|${(e.rouletteSegments ?? []).join(',')}`;
}

/** 同じ盤面か(rouletteBoardKey の等値)。 */
export function sameRouletteBoard(a: ChallengeEffect, b: ChallengeEffect): boolean {
  return rouletteBoardKey(a) === rouletteBoardKey(b);
}

/**
 * 同じ盤面のルーレット effect 2件を1件へ連結する(a が先、b が後)。
 *
 * 呼ぶ前に sameRouletteBoard で確かめること。値・統計は既に worker が両方ぶん
 * 適用済みなので、ここで畳むのは**見た目と1行の履歴**だけ(finishDrain の規約と同じ)。
 * 見出し(nickname)は先頭 a のものを残す — 連結後の1本目が誰の分かと揃える。
 *
 * `cfg` は連結後のリール本数を引き直すための設定。**worker の finishDrain が
 * `rouletteReelCount(this.getConfig(), idxs.length)` を使うのと同じ規約に揃える** —
 * 渡さないと `giftRepeatFx.rouletteEnabled = false`(「連打でもリールは1本」)で
 * worker が 1 本に絞った effect が、モニターのキュー満杯連結で最大
 * ROULETTE_REELS_MAX 本に化ける。未指定は従来動作(上限 clamp のみ)。
 */
export function mergeRoulette(
  a: ChallengeEffect,
  b: ChallengeEffect,
  cfg?: ChallengeConfig | null
): ChallengeEffect {
  const rawIdxs = [...(a.rouletteIndexes ?? []), ...(b.rouletteIndexes ?? [])];
  const idxs = rawIdxs.slice(0, ROULETTE_DRAWS_MAX);
  const pats = [...(a.roulettePatterns ?? []), ...(b.roulettePatterns ?? [])].slice(0, ROULETTE_DRAWS_MAX);
  // 出目ごとの実適用量(位置は rouletteIndexes と対応)。片方でも rouletteAmounts を
  // 持てば連結後も持ち越す必要があるので、持たない側は名目式で並びを補完する。
  const hasAmts = a.rouletteAmounts != null || b.rouletteAmounts != null;
  const amtsOf = (e: ChallengeEffect): number[] => {
    const eIdxs = e.rouletteIndexes ?? [];
    const segs = e.rouletteSegments ?? [];
    const sign = (e.rouletteDirection === 'sub' ? -1 : 1) * rouletteHotMultOf(e);
    return eIdxs.map((ix, i) => e.rouletteAmounts?.[i] ?? (segs[ix] ?? 0) * sign);
  };
  const rawAmts = [...amtsOf(a), ...amtsOf(b)];
  // 切り詰め(ROULETTE_DRAWS_MAX 超過)で出目列から落ちる抽選ぶん。**値は worker が
  // 全抽選ぶん適用済み**なので、amount(満額合算)と出目列の差をここで運ばないと、
  // 超過分が据え置き会計(rouletteReelPlan の rest)から漏れてリール再生前に数字
  // だけ動く(出目の先漏れ)。連結の連鎖(a か b が既に切り詰め済み)も引き継ぐ。
  const cut = rawAmts.slice(ROULETTE_DRAWS_MAX);
  const truncatedAmount =
    (a.rouletteTruncatedAmount ?? 0) + (b.rouletteTruncatedAmount ?? 0) + cut.reduce((s, v) => s + v, 0);
  const truncatedCount =
    (a.rouletteTruncatedCount ?? 0) + (b.rouletteTruncatedCount ?? 0) + cut.length;
  const merged: ChallengeEffect = {
    ...b,
    id: Math.max(a.id, b.id),
    nickname: a.nickname,
    amount: a.amount + b.amount,
    // 到着順に適用済みなので、後発 b の valueAfter が現在値。
    valueAfter: b.valueAfter,
    coalesced: (a.coalesced ?? 1) + (b.coalesced ?? 1),
    giftCount: (a.giftCount ?? 1) + (b.giftCount ?? 1),
    diamonds: (a.diamonds ?? 0) + (b.diamonds ?? 0),
    rouletteIndexes: idxs,
    roulettePatterns: pats,
    rouletteIndex: idxs[0] ?? a.rouletteIndex,
    roulettePattern: pats[0] ?? a.roulettePattern,
    // 連結後の本数で引き直す(元の rouletteReels は合計にならない)。
    rouletteReels: cfg ? rouletteReelCount(cfg, idxs.length) : Math.min(ROULETTE_REELS_MAX, idxs.length),
  };
  // 行の同一性(= 回転サウンドの持ち主)は先頭 a に合わせる。nickname と同じ規約で、
  // 連結後に実際に鳴るのは 1 本目の音だから — `{...b}` 任せにすると「a の音で
  // 鳴っているのに effect には b の行が載っている」がキューの畳み込みで生まれる。
  // undefined 値のキーを残さず delete するのは、effect は「載せないフィールドは
  // キーごと出さない」流儀で作られているため(JSON 比較を素直に保つ)。
  if (a.rouletteId != null) merged.rouletteId = a.rouletteId;
  else delete merged.rouletteId;
  // 実適用量と切り詰め補償。`{...b}` ベースに b の古い値が残らないよう、無ければ
  // キーごと落とす(rouletteId と同じ「載せないフィールドはキーごと出さない」流儀)。
  if (hasAmts) merged.rouletteAmounts = rawAmts.slice(0, ROULETTE_DRAWS_MAX);
  else delete merged.rouletteAmounts;
  if (truncatedCount > 0) {
    merged.rouletteTruncatedAmount = truncatedAmount;
    merged.rouletteTruncatedCount = truncatedCount;
  } else {
    delete merged.rouletteTruncatedAmount;
    delete merged.rouletteTruncatedCount;
  }
  return merged;
}

/**
 * effect 1件 → **実際に鳴らす回転サウンド**。モニターとテストが共有する唯一の実装
 * (rouletteDraws / rouletteBoardKey と同じ「判断を shared の純関数に閉じる」流儀 —
 * レンダラのテスト環境が無いので、音の決定ロジックはここに置いてテストする)。
 *
 * 解決順:
 *   1. e.rouletteId が cfg.roulettes に**居れば** → その行の sound ?? 共通
 *   2. e.rouletteJoin → cfg.joinRoulette.sound ?? 共通
 *   3. それ以外(id 欠損 / 行を削除した / id を変えた)→ 共通
 *
 * 「共通」は**出目の方向で2組に分かれる**(rouletteCommonSound)。行の sound 上書きは
 * 方向より強い — 「この行だけ上書きする」は明示的なユーザー意思で、方向別共通が
 * それを覆すと**チェックしても何も変わらない死んだコントロール**になる。
 *
 * rouletteId を先に見るのは、畳み込み(mergeRoulette / finishDrain)が音の持ち主を
 * 先頭 a に固定するのと足並みを揃えるため。実効の effect ではギフト行(rouletteId)と
 * 入室(rouletteJoin)は排他なので、通常はどちらを先に見ても同値。
 *
 * 行が見つからないとき**既定(DEFAULT_ROULETTE_SOUND)へ倒さない**のが要点 —
 * 共通こそがこの機能以前の全ルーレットの音で、行が消えただけで無音や別の音に
 * なるのは劣化。enabled は見ない(設定UIの ▶ 試写が enabled を見ないのと同じ)。
 *
 * **cfg 未取得(null/undefined)は null = 無音**を返す。既定を返してはいけない —
 * cfg.get が返る前のスピンで回転音だけ先に鳴り始める(現行の
 * `cfg?.challenge.rouletteSound` → undefined → playBandBgm(undefined) → null で
 * 無音、という縮退と 1:1 に保つ)。
 */
export function rouletteCommonSound(
  cfg: ChallengeConfig,
  direction: 'add' | 'sub'
): RouletteSoundConfig {
  return direction === 'sub' ? cfg.rouletteSoundSub : cfg.rouletteSound;
}

/** @see rouletteCommonSound — 解説は上のコメントブロック。 */
export function resolveRouletteSound(
  cfg: ChallengeConfig | null | undefined,
  e: ChallengeEffect
): RouletteSoundConfig | null {
  if (!cfg) return null;
  // 方向の権威は **effect の焼き込み**(e.rouletteDirection)であって cfg の行の
  // direction ではない。行を消した/ id を変えた場合(下の 3.)でも正しい向きの共通へ
  // 倒れ、モニターの 120 秒ポーリング(CFG_POLL_MS)で古い cfg を読んでも
  // 「過去のスピンの音が後から変わる」が起きない。
  const common = rouletteCommonSound(cfg, e.rouletteDirection === 'sub' ? 'sub' : 'add');
  if (e.rouletteId != null && e.rouletteId !== '') {
    const rl = cfg.roulettes.find((r) => r.id === e.rouletteId);
    if (rl) return rl.sound ?? common;
  }
  if (e.rouletteJoin) return cfg.joinRoulette.sound ?? common;
  return common;
}

/**
 * 設定UI「回転中のサウンドをこの行だけ上書きする」チェックの切り替え → 行の
 * sound 値。オンは**そのときの共通の丸ごとコピー**を種にする — チェックした瞬間に
 * 鳴る音を変えないため。DEFAULT_ROULETTE_SOUND を種にしないこと(共通を編集済みの
 * ユーザーでは、チェックした途端に既定の音へ戻る)。オフは undefined — 保存時に
 * validateRouletteSoundOverride がキーごと落とし、行は共通へ復帰する(以後の
 * 共通の変更にも再び追従する)。ギフト行(ChallengeRouletteConfig)と入室
 * (JoinRouletteConfig)の両方がこの1実装を使う。
 */
export function rouletteSoundOverrideToggle(
  on: boolean,
  common: RouletteSoundConfig
): RouletteSoundConfig | undefined {
  return on ? { ...common } : undefined;
}

/**
 * effect 1件 → モニターの再生計画。**renderer 側の唯一の clamp 点**
 * (giftFxShots と同じ役割)。
 *
 * reels = 実際にリールを回すぶん、rest = 尺の都合で回さないぶんの合算。
 * 値は全部適用済みなので、rest があるときはモニターが合算バナー1枚で締めて
 * 「数字だけ黙って動く」を避ける。
 */
export function rouletteReelPlan(e: ChallengeEffect): {
  reels: Array<{ index: number; pattern: RoulettePattern; amount: number }>;
  restAmount: number;
  restCount: number;
} {
  const all = rouletteDraws(e);
  // 欠損(旧 worker 混在)は全部回す。上限は念のためここでも掛ける。
  const n = Math.min(all.length, ROULETTE_REELS_MAX, Math.max(1, Math.round(e.rouletteReels ?? all.length)));
  const reels = all.slice(0, n);
  const rest = all.slice(n);
  // 連結の切り詰め(ROULETTE_DRAWS_MAX)で出目列から落ちた超過分も rest に合算する
  // (dto の rouletteTruncatedAmount 参照)。ここに足せば据え置き会計
  // (rouletteRemainingAmount)・合算バナー・演出ストックの ×N が全部いっぺんに
  // 整合する — 値は worker 適用済みなので、漏らすとその分が先漏れする。
  return {
    reels,
    restAmount: rest.reduce((s, d) => s + d.amount, 0) + (e.rouletteTruncatedAmount ?? 0),
    restCount: rest.length + (e.rouletteTruncatedCount ?? 0),
  };
}

/**
 * resumeAt 本目以降の「まだ見せていない」増減量の合計(回さない rest ぶん込み)。
 *
 * モニターの据え置き会計の**唯一のスライス権威** — startRoulette の据え置きと
 * pendingStageAmount(舞台待ちの持ち越し合算)の両方がこれを使う。計算を呼び出し
 * 側に散らすと、連鎖の譲り合い(§6b)でキューへ戻した残りリールを片方だけ
 * 全リール直和で数え、再開時に数字が巻き戻る。
 * resumeAt が reels.length 以上なら rest のみ(最終リール後 = restAmount)。
 */
export function rouletteRemainingAmount(e: ChallengeEffect, resumeAt: number): number {
  const plan = rouletteReelPlan(e);
  return plan.reels.slice(resumeAt).reduce((s, d) => s + d.amount, 0) + plan.restAmount;
}

/**
 * resumeAt 本目以降の「まだ見せていない**回数**」(回さない rest ぶん込み)。
 * rouletteRemainingAmount の対称形で、スライス位置の規約は完全に同じ —
 * 額と回数を別々の式で書くと片方だけ rest を数え忘れる(演出ストックの ×N が
 * ROULETTE_REELS_MAX(20) で頭打ちになっていたのがまさにそれ)。
 *
 * `rouletteRemainingCount(e, 0) === rouletteDraws(e).length` = **実際の抽選回数**。
 * ROULETTE_REELS_MAX は「回すリールの本数」の上限であって回数の上限ではない
 * (回数の上限は ROULETTE_DRAWS_MAX)。
 */
export function rouletteRemainingCount(e: ChallengeEffect, resumeAt: number): number {
  const plan = rouletteReelPlan(e);
  return Math.max(0, plan.reels.length - resumeAt) + plan.restCount;
}

/**
 * 演出ストック表示(モニター右下の縦リスト)の ×N。at 本目以降の残数。
 *
 * **ギフトルーレットは実際の抽選回数**(rest 込み)。47連打なら ×47 から始まり、
 * リールが止まるたび1ずつ減って、最後は rest ぶん(= 合算バナー「残りN回ぶん」の
 * N + 1)へ着地する。ストックの数字と締めのバナーの数字が地続きなのは、両方が
 * rouletteRemainingCount から出ているから。
 *
 * **rest を数えるのは「連打を連打として回す」effect だけ**(ユーザー決定)。
 * reels === 1 になるのは (a) 入室ルーレット (b)「連打でもリールは1本」設定
 * (giftRepeatFx.rouletteEnabled = false) (c) 単発ギフト の3つで、(a)(b) は
 * 「あと何本の演出が舞台を占有するか」の指標として本数のままにする — 設定画面が
 * 「変えるのはリールを何本見せるかだけ」と約束しているため。(c) は rest が無いので
 * どちらの式でも同値。**cfg は見ない** — effect 自己完結(rouletteSegments と同じ理由。
 * モニターの cfg は CFG_POLL_MS の 120秒ポーリングで古くなりうる)。
 *
 * 入室の判定を reels === 1 に任せず rouletteOrigin も見るのは、キュー満杯の
 * 末尾連結(mergeRoulette)で入室が2件以上畳まれると reels が 1 を超えうるため。
 */
export function rouletteStockCount(e: ChallengeEffect, at: number): number {
  const plan = rouletteReelPlan(e);
  const spins = Math.max(0, plan.reels.length - at);
  if (e.rouletteOrigin === 'join' || plan.reels.length === 1) return spins;
  return spins + plan.restCount;
}

/**
 * effect から反復の再生パラメータを取り出す。renderer 側の唯一の clamp 点。
 * **MonitorView と useChallengeSe の両方がこれを呼ぶこと** — 音と映像の回数が
 * ずれない担保はこの関数を共有していることだけ。
 */
export function giftFxShots(e: ChallengeEffect): { rep: number; gap: number } {
  const rep = Math.min(GIFT_FX_REPEAT_MAX, Math.max(1, Math.round(e.fxRepeat ?? 1)));
  const raw = e.fxRepeatIntervalMs ?? GIFT_FX_REPEAT_MS;
  const gap = Math.min(GIFT_FX_REPEAT_MAX_MS, Math.max(GIFT_FX_REPEAT_MIN_MS, Math.round(raw)));
  return { rep, gap };
}

/** スロット(press/follow/like/achieved 等)の簡易演出。off/無効なら null。 */
export function miniForSlot(cfg: ChallengeConfig, slot: ChallengeSeSlot): string | null {
  if (!cfg.miniFxEnabled) return null;
  const id = cfg.miniFx[slot];
  return id && id !== 'off' ? id : null;
}

// ── 演出 watermark ───────────────────────────────────────────────────────────

/** 取りこぼしの古い演出をスキップする鮮度ゲート。復帰直後の演出ストーム防止。 */
export const EFFECT_FRESH_MS = 5000;
/**
 * テスト再生(effect.test)だけの緩い鮮度ゲート。設定画面の「▶ モニター」は
 * モニターウィンドウの生成+マウントを待ってから再生されるため、5秒では
 * ウィンドウ生成が遅い環境(別ディスプレイのフルスクリーン化等)で無言で落ちる。
 */
export const TEST_EFFECT_FRESH_MS = 15_000;

/**
 * 演出1件の鮮度判定。freshChallengeEffects の内部ゲートと、MonitorView の
 * 「未再生カットインに据え置きを譲るか」(yieldToCutin)が**同じ規約**を共有する
 * ための唯一の実装 — 別々に持つと test 演出(15秒ゲート)だけ「譲らないのに
 * 再生はする」ズレが生まれ、飛行中の着弾チェーンが打ち切られる。
 */
export function isChallengeEffectFresh(e: ChallengeEffect, nowMs: number): boolean {
  return nowMs - e.atMs <= (e.test === true ? TEST_EFFECT_FRESH_MS : EFFECT_FRESH_MS);
}

/**
 * recentEffects の watermark 進行を1箇所に集約する(MonitorView の視覚再生と
 * useChallengeSe の効果音が同じ規約を共有する唯一の担保)。
 *
 * - lastPlayed === null(マウント直後)は全件を再生済みに倒す — リロード/再接続の
 *   たびに過去演出が一斉再生される事故を防ぐ。ただし mountPlaysTest のときは
 *   test 演出(▶ 実演再生)だけ鮮度ゲート内なら再生対象に含める — モニターの
 *   マウントが実演の push より遅れると、最初のスナップショットに含まれた実演が
 *   無言で「再生済み」扱いになり consumed される(「▶ を押しても何も起きない、
 *   2回目は出る」の原因)。
 * - **watermark は絶対に後退しない(next >= lastPlayed)。** かつては
 *   「lastPlayed > maxId なら worker 再起動で id が振り直された」と見なして 0 へ
 *   倒していたが、この判定は**古いスナップショットの後着**でも成立する:
 *   press RPC の返り値は setChallenge が即時適用、delta は rAF コアレスで遅延反映
 *   なので(liveStore.ts)、押下のたびに逆転が起きうる。成立するとリング内の
 *   鮮度ゲート内 effect が丸ごと再生され直し、さらに watermark 自体が後退して
 *   次の delta でもう一度再生される — 「ルーレット/ギフトが贈られた個数を超えて
 *   何回も再生される」の原因はこれだった。
 *   worker 再起動の追従は**呼び出し側が lastPlayed=null を渡して**行う
 *   (liveStore の workerEpoch が 'restarting|dead → ready' で合図する)。
 * - 鮮度ゲートを過ぎた演出は無言でスキップ(watermark は進める)。
 *
 * 戻り値: next = 新しい watermark、play = 再生すべき演出(id 昇順)。
 */
export function freshChallengeEffects(
  effects: readonly ChallengeEffect[],
  lastPlayed: number | null,
  nowMs: number,
  opts?: { mountPlaysTest?: boolean }
): { next: number; play: ChallengeEffect[] } {
  const maxId = effects.reduce((m, e) => Math.max(m, e.id), 0);
  const freshEnough = (e: ChallengeEffect): boolean => isChallengeEffectFresh(e, nowMs);
  if (lastPlayed === null) {
    const play = opts?.mountPlaysTest
      ? effects.filter((e) => e.test === true && freshEnough(e)).sort((a, b) => a.id - b.id)
      : [];
    return { next: maxId, play };
  }
  const play = effects
    .filter((e) => e.id > lastPlayed && freshEnough(e))
    .sort((a, b) => a.id - b.id);
  return { next: Math.max(lastPlayed, maxId), play };
}

/**
 * 取り込もうとしているスナップショットが**古い**(effect ストリームが後退して
 * いる)か。true なら recentEffects / fxQueue を差し替えてはいけない。
 *
 * delta は rAF コアレスで遅延反映、RPC(challenge.press / challenge.get)の返り値は
 * 即時適用され、`ChallengeState` に seq も version も無いので順序を比較する材料が
 * これしか無い。`nextEffectId` は worker の生存中は厳密に単調(start/stop/reset で
 * リセットされない)なので、max(recentEffects.id) がそのまま世代印になる。
 *
 * ラン境界(start/reset は recentEffects を空にする)と worker 再起動は**呼び出し側**
 * が seen を 0 へ戻して吸収する(前者は startedMs の変化、後者は workerEpoch)。
 * 戻したあとは seen=0 なのでどんなスナップショットも「古くない」になり、空リングの
 * 取り込みも素通りする。逆に**戻していないのに空リングが来たら後退扱いでよい** —
 * 採用すると演出の入力(recentEffects)が消えるだけだから。
 */
export function isStaleChallengeSnapshot(seenMaxEffectId: number, state: ChallengeState): boolean {
  return challengeSnapshotMaxEffectId(state) < seenMaxEffectId;
}

/** スナップショットの effect 世代印(max(recentEffects.id)、空なら 0)。 */
export function challengeSnapshotMaxEffectId(state: ChallengeState): number {
  return state.recentEffects.reduce((m, e) => Math.max(m, e.id), 0);
}

/**
 * 旧既定のまま保存されている音の割り当てを、新しい既定へ一度だけ寄せる。
 * settingsVersion(dto.ts の SETTINGS_VERSION)が各世代より古い settings.json にだけ効く。
 *
 * 「旧既定と同じ値のときだけ」書き換えるのが要点 — 自分で旧既定以外を選んでいる人の
 * 設定は触らない。validateChallengeConfig の中に入れてはいけない(あちらは UI からの
 * cfg.set も通るので、後から旧既定を選び直した瞬間に上書きし返す)。
 *
 * 新しい世代を足すときは**段を積む**こと(if で早期 return しない) — v0 の
 * settings.json は v1 と v2 の両方を順に通る必要がある。
 */
/**
 * v3 で配ってしまった**壊れたトリガー**の実値。修復対象かどうかの判定にだけ使う。
 *
 * v3 の既定はギフト名を日本語(スクリーンショットの表示名)で入れていたが、
 * 配信イベントの `giftName` は**クライアントの表示言語に関係なく英語で届く**
 * (日本限定ギフトだけは日本語)。そのため42行中40行が一度も発火しなかった。
 * 発火していたのは canonical を持つ 2 行(バラ / 香水)だけ。
 *
 * ⚠ この表は**凍結する**。「今の既定」ではなく「v3 が書き込んだ値」なので、
 *   FULL_CUT_CLIPS から生成し直してはいけない(生成し直すと新旧が同値になり修復が空振る)。
 */
const OLD_FULL_CUT_TRIGGERS_V3: Readonly<
  Record<string, { giftId: string; giftName: string; canonical: string; exactName: boolean }>
> = {
  'fullcut-rose': { giftId: '', giftName: 'バラ', canonical: 'rose', exactName: false },
  'fullcut-rosa': { giftId: '', giftName: 'ローザ', canonical: '', exactName: false },
  'fullcut-subarashii': { giftId: '', giftName: '素晴らしい', canonical: '', exactName: false },
  'fullcut-mini-hanabi': { giftId: '', giftName: 'ミニ花火', canonical: '', exactName: false },
  'fullcut-neko-ashi': { giftId: '', giftName: '猫の足', canonical: '', exactName: false },
  'fullcut-tiktok': { giftId: '', giftName: 'tiktok', canonical: '', exactName: true },
  'fullcut-gg': { giftId: '', giftName: 'gg', canonical: '', exactName: true },
  'fullcut-shoken': { giftId: '', giftName: '初見', canonical: '', exactName: false },
  'fullcut-hakushu': { giftId: '', giftName: '拍手', canonical: '', exactName: false },
  'fullcut-daisuki': { giftId: '', giftName: '大好き', canonical: '', exactName: false },
  'fullcut-soft-cream': { giftId: '', giftName: 'ソフトクリーム', canonical: '', exactName: false },
  'fullcut-uchiwa': { giftId: '', giftName: 'うちわ', canonical: '', exactName: false },
  'fullcut-yakyu': { giftId: '', giftName: '野球', canonical: '', exactName: false },
  'fullcut-love-letter': { giftId: '', giftName: 'ラブレター', canonical: '', exactName: false },
  'fullcut-ai-no-kaori': { giftId: '', giftName: '愛の香り', canonical: '', exactName: false },
  'fullcut-finger-heart': { giftId: '', giftName: 'フィンガーハート', canonical: 'finger_heart', exactName: false },
  'fullcut-nyao': { giftId: '', giftName: 'ニャオ', canonical: '', exactName: false },
  'fullcut-yell': { giftId: '', giftName: 'エール', canonical: '', exactName: false },
  'fullcut-honki': { giftId: '', giftName: '本気', canonical: '', exactName: false },
  'fullcut-omamori': { giftId: '', giftName: 'おまもり', canonical: '', exactName: false },
  'fullcut-nebaaru': { giftId: '', giftName: 'ねば', canonical: '', exactName: false },
  'fullcut-fukka': { giftId: '', giftName: 'ふっか', canonical: '', exactName: false },
  'fullcut-udon-no': { giftId: '', giftName: 'うどん脳', canonical: '', exactName: false },
  'fullcut-ice-bar': { giftId: '', giftName: 'アイスバー', canonical: '', exactName: false },
  'fullcut-journey-pass': { giftId: '', giftName: 'ジャーニーパス', canonical: '', exactName: false },
  'fullcut-oshi-shosan': { giftId: '', giftName: '推しへの称賛', canonical: '', exactName: false },
  'fullcut-kosui': { giftId: '', giftName: '香水', canonical: 'perfume', exactName: false },
  'fullcut-goat-busker': { giftId: '', giftName: 'バスカー', canonical: '', exactName: false },
  'fullcut-donut': { giftId: '', giftName: 'ドーナッツ', canonical: '', exactName: false },
  'fullcut-tensai': { giftId: '', giftName: '天才', canonical: '', exactName: false },
  'fullcut-boshi-hige': { giftId: '', giftName: '帽子と口ひげ', canonical: '', exactName: false },
  'fullcut-utau-kinoko': { giftId: '', giftName: '歌うキノコ', canonical: '', exactName: false },
  'fullcut-pearl-chime': { giftId: '', giftName: 'パールチャイム', canonical: '', exactName: false },
  'fullcut-flower-melody': { giftId: '', giftName: 'フラワーメロディ', canonical: '', exactName: false },
  'fullcut-groove-guitar': { giftId: '', giftName: 'グルーヴギター', canonical: '', exactName: false },
  'fullcut-fiesta-accordion': { giftId: '', giftName: 'フィエスタアコーディ', canonical: '', exactName: false },
  'fullcut-heart-pose': { giftId: '', giftName: 'ハートポーズ', canonical: '', exactName: false },
  'fullcut-hand-heart': { giftId: '', giftName: 'ハンドハート', canonical: 'hand_hearts', exactName: false },
  'fullcut-mischka-bear': { giftId: '', giftName: 'ミシカ', canonical: '', exactName: false },
  'fullcut-cracker': { giftId: '', giftName: 'クラッカー', canonical: '', exactName: false },
  'fullcut-koi-megane': { giftId: '', giftName: '恋のメガネ', canonical: '', exactName: false },
  'fullcut-tempo-flute': { giftId: '', giftName: 'テンポフルート', canonical: '', exactName: false },
};

/**
 * v3 が配った壊れたトリガーを、実データで確認した giftId / 英語ギフト名へ寄せ直す。
 *
 * **旧既定と完全に同じ行だけ**書き換える — トリガーを自分で書き換えた人の設定は触らない
 * (migrateChallengeSeSounds と同じ方針)。書き換えるのは判定に使う4つ
 * (giftId / giftName / canonical / exactName)だけで、enabled・durationSec・clip・
 * 並び順・label には触れない。
 *
 * ⚠ validateChallengeConfig の中に入れてはいけない — UI の cfg.set も通るので、
 *   ユーザーが旧値を選び直した瞬間に上書きし返してしまう。
 */
export function migrateChallengeGiftFullCutTriggers(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 4) return cfg;
  const fresh = new Map(FULL_CUT_CLIPS.map((c) => [`fullcut-${c.id.slice('cut-'.length)}`, c]));
  let touched = 0;
  const rules = cfg.giftFullCut.rules.map((r) => {
    const old = OLD_FULL_CUT_TRIGGERS_V3[r.id];
    const c = fresh.get(r.id);
    if (old == null || c == null) return r;
    if (
      r.giftId !== old.giftId ||
      r.giftName !== old.giftName ||
      r.canonical !== old.canonical ||
      (r.exactName === true) !== old.exactName
    ) {
      return r; // 手を入れてある行 — 尊重する
    }
    touched++;
    return { ...r, giftId: c.giftId, giftName: c.giftName, canonical: c.canonical, exactName: c.exactName };
  });
  if (touched === 0) return cfg;
  return { ...cfg, giftFullCut: { ...cfg.giftFullCut, rules } };
}

/**
 * v5 まで配っていた**推定のまま外れていたトリガー**の実値。修復対象かの判定にだけ使う。
 *
 * v4 の修復で日本語名は英語名に寄せたが、giftId が '' の行は「未受領ゆえ英語名の推定」
 * のままだった。ミニ花火は実受信で `giftId 134531` / `giftName 'Firework'`(単数形)と
 * 判明 — 推定値 'mini fireworks' は部分一致でも一度も当たらなかった。
 *
 * ⚠ この表は**凍結する**。OLD_FULL_CUT_TRIGGERS_V3 と同じ理由で、FULL_CUT_CLIPS から
 *   生成し直してはいけない(新旧が同値になり修復が空振る)。
 */
const OLD_FULL_CUT_TRIGGERS_V5: Readonly<
  Record<string, { giftId: string; giftName: string; canonical: string; exactName: boolean }>
> = {
  'fullcut-mini-hanabi': { giftId: '', giftName: 'mini fireworks', canonical: '', exactName: false },
};

/**
 * v5 までの外れた推定トリガーを、実受信で確認できた値へ寄せ直す。
 * 判定も注意点も migrateChallengeGiftFullCutTriggers と同一 — **旧既定と完全に同じ行だけ**
 * 書き換え、書き換えるのは giftId / giftName / canonical / exactName の4つだけ。
 */
export function migrateChallengeGiftFullCutTriggersV5(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 6) return cfg;
  const fresh = new Map(FULL_CUT_CLIPS.map((c) => [`fullcut-${c.id.slice('cut-'.length)}`, c]));
  let touched = 0;
  const rules = cfg.giftFullCut.rules.map((r) => {
    const old = OLD_FULL_CUT_TRIGGERS_V5[r.id];
    const c = fresh.get(r.id);
    if (old == null || c == null) return r;
    if (
      r.giftId !== old.giftId ||
      r.giftName !== old.giftName ||
      r.canonical !== old.canonical ||
      (r.exactName === true) !== old.exactName
    ) {
      return r; // 手を入れてある行 — 尊重する
    }
    touched++;
    return { ...r, giftId: c.giftId, giftName: c.giftName, canonical: c.canonical, exactName: c.exactName };
  });
  if (touched === 0) return cfg;
  return { ...cfg, giftFullCut: { ...cfg.giftFullCut, rules } };
}

/**
 * 全面カットの既定行が増えた世代を、保存済み settings.json へ一度だけ配る。
 * **追加しかしない** — 既存行の順序も内容も enabled も触らず、まだ持っていない id を
 * 末尾へ足すだけ(先勝ちなので、ユーザーが自分で並べた優先度を壊さない)。
 *
 * ⚠ validateGiftFullCut / validateChallengeConfig の中に入れてはいけない。あちらは
 *   UI の cfg.set も通るので、ユーザーが削除した行がその場で復活する。世代は
 *   sanitize の前に raw から読む(main/boot-settings.ts の `from`)。
 * ⚠ 配るのは FULL_CUT_CLIPS_V3 に固定する。DEFAULT_GIFT_FULL_CUT.rules を参照すると、
 *   次の世代で既定が増えたとき v3 の段が新しい行まで配ってしまい二重適用になる。
 * ⚠ v3 より前に存在しなかった id しか足さないので、「消したのに復活する」は
 *   構造的に起きない(消せるようになったのが v3 以降だから)。
 */
export function migrateChallengeGiftFullCut(cfg: ChallengeConfig, fromVersion: number): ChallengeConfig {
  if (fromVersion >= 3) return cfg;
  const have = new Set(cfg.giftFullCut.rules.map((r) => r.id));
  const add = FULL_CUT_CLIPS_V3.map(fullCutRuleFor).filter((r) => !have.has(r.id));
  if (add.length === 0) return cfg;
  return {
    ...cfg,
    giftFullCut: { ...cfg.giftFullCut, rules: [...cfg.giftFullCut.rules, ...add] },
  };
}

/**
 * 世代移行の入口。**段は fromVersion の小さい順に積む**(世代0の設定は v1→v2→v3 を
 * 全部通る)。boot-settings.ts の loadSettings からだけ呼ぶこと。
 */
export function migrateChallengeConfig(cfg: ChallengeConfig, fromVersion: number): ChallengeConfig {
  return migrateChallengeRouletteHotGifts(
    migrateChallengeQuizPrompts(
      migrateChallengeQuizIntro(
        migrateChallengeRouletteDjGlasses(
          migrateChallengeTapBoostNebaaru(
            migrateChallengeStampTriggers(
              migrateChallengeTapBoostCorgi(
                migrateChallengeGiftFullCutTriggersV5(
                  migrateChallengeGiftFullCutTriggers(
                    migrateChallengeGiftFullCut(
                      migrateChallengeSeSounds(cfg, fromVersion),
                      fromVersion
                    ),
                    fromVersion
                  ),
                  fromVersion
                ),
                fromVersion
              ),
              fromVersion
            ),
            fromVersion
          ),
          fromVersion
        ),
        fromVersion
      ),
      fromVersion
    ),
    fromVersion
  );
}

/**
 * v13: 激熱確定のユニコーン行(gift 12453)とバニーDJ行(gift 437679)を
 * **まだ無ければ1回だけ**足す。migrateChallengeRouletteDjGlasses(v10)と同型。
 *
 * roulettes キーは保存済み設定が必ず持っているので、既定(DEFAULT_ROULETTES /
 * 同梱 challenge-default.json)を直しても既存ユーザーには一生届かない — 足す移行が要る。
 *
 * ⚠ validateChallengeConfig の中に入れてはいけない。あちらは UI の cfg.set も通るので、
 *   ユーザーが消した行がその場で復活する。
 *
 * ⚠ **上限は行ごとに確認する。** 1回だけ見て2行 push すると ROULETTES_MAX を超える。
 *   1行目で上限に達したら2行目は足さない(reduce ではなく逐次 push なのはこのため)。
 *
 * - giftId 一致で「自分でその行を作っていた人」に二重に配らない。
 * - id 一致も見る: 同梱 resources/challenge-default.json には明示行が入っているので、
 *   そこから来た行でユーザーが giftId を空にしていても足さない(足すと id が重複して
 *   validateRoulettes の振り直しで 'rl-unicorn-N' に化ける)。
 * - **末尾へ append**。matchRoulette は先勝ちなので、ユーザーが並べた優先度を壊さない。
 * - 行を消した人には二度と配らない(世代印が上がるのは1回だけ)。
 */
export function migrateChallengeRouletteHotGifts(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 13) return cfg;
  const roulettes = [...cfg.roulettes];
  let added = 0;
  for (const row of [UNICORN_ROULETTE, BUNNY_DJ_ROULETTE]) {
    if (roulettes.some((r) => r.giftId === row.giftId || r.id === row.id)) continue;
    // 残数は毎回見る — 1行足したぶんだけ上限に近づく。
    if (roulettes.length >= ROULETTES_MAX) break;
    roulettes.push(structuredClone(row));
    added += 1;
  }
  return added === 0 ? cfg : { ...cfg, roulettes };
}

/**
 * v10: 激熱確定の DJメガネ行(gift 11583)を**まだ無ければ1回だけ**足す。
 * migrateChallengeTapBoostCorgi と同型。
 *
 * roulettes キーは保存済み設定が必ず持っている(旧単数 roulette も validateRoulettes が
 * 配列へ包み直す)ので、**既定を直しても既存ユーザーには一生届かない** — 足す移行が要る。
 *
 * ⚠ validateChallengeConfig の中に入れてはいけない。あちらは UI の cfg.set も通るので、
 *   ユーザーが消した DJメガネ行がその場で復活する(giftFullCut / コーギーと同じ理由)。
 *
 * - giftId 一致で「自分で 11583 の行を作っていた人」に二重に配らない。
 * - id 一致も見る: 同梱 resources/challenge-default.json には明示行が入っているので、
 *   そこから来た行でユーザーが giftId を空にしていても足さない(足すと id が重複して
 *   validateRoulettes の振り直しで 'rl-dj_glasses-1' に化ける)。
 * - 上限 ROULETTES_MAX に達している設定には足さない。
 * - **末尾へ append**。matchRoulette は先勝ちなので、ユーザーが並べた優先度を壊さない。
 * - 行を消した人には二度と配らない(世代印が上がるのは1回だけ)。
 */
export function migrateChallengeRouletteDjGlasses(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 10) return cfg;
  const has = cfg.roulettes.some(
    (r) => r.giftId === DJ_GLASSES_ROULETTE.giftId || r.id === DJ_GLASSES_ROULETTE.id
  );
  if (has) return cfg;
  if (cfg.roulettes.length >= ROULETTES_MAX) return cfg;
  return { ...cfg, roulettes: [...cfg.roulettes, structuredClone(DJ_GLASSES_ROULETTE)] };
}

/**
 * v11: お題ルーレットの導入を専用素材(`assets/fx/quiz/intro.mp4`)へ引き上げる。
 *
 * v0.13.0(settingsVersion 10)が配った `introClip: 'off'` は「導入は要らない」
 * ではなく「**専用素材がまだ無い**」という意味だった(当時は他機能の全面カットを
 * 借りる枠しか無く、既定で他人の絵を流すわけにいかなかった)。素材を投入した
 * 2026-08-22 に既定を `QUIZ_INTRO_SELF` へ変えたが、**既定を直しても保存済みの
 * settings.json には一生届かない**ので、足す移行が要る。
 *
 * - **`'off'` ちょうどのときだけ**書き換える。`cut-*` を自分で選んでいた人の
 *   選択は尊重する(そちらは「素材が無い」ではなく明確な指名だから)。
 * - 世代印が上がるのは1回だけなので、移行後に自分で `'off'` へ戻した人には
 *   二度と配らない。
 *
 * ⚠ validateQuiz の中に入れてはいけない。あちらは UI の `cfg.set` も通るので、
 * ユーザーが選んだ `'off'` がその場で戻る(giftFullCut / コーギーと同じ理由)。
 */
export function migrateChallengeQuizIntro(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 11) return cfg;
  if (cfg.quiz.introClip !== 'off') return cfg;
  return { ...cfg, quiz: { ...cfg.quiz, introClip: QUIZ_INTRO_SELF } };
}

/**
 * v12: お題リストを実運用の28件(QUIZ_PROMPTS_V12)へ**寄せ替える**。足す移行ではない。
 *
 * v0.13.0 が配った prompts は「誰もやったことないものまね」1件だけで、これは実運用の
 * お題ではなく「空だと enabled にしても不発で ▶実演 すらできない」ための**例**だった。
 * 2026-08-22 に実運用の28件を出荷既定にしたが、prompts キーは v0.13.0 以降どの保存済み
 * 設定も持っているので validateQuiz の欠損フォールバックを通らず、**既定を直しても
 * 既存ユーザーには一生届かない** — 足す/寄せ替えの移行だけが唯一の経路。
 *
 * ⚠ validateQuiz の中に入れてはいけない。あちらは UI の `cfg.set` も通るので、
 * ユーザーが消したお題がその場で復活する(migrateChallengeQuizIntro と同じ理由)。
 *
 * **出荷既定の「例」1件ちょうどのときだけ**書き換える(migrateChallengeTapBoostNebaaru の
 * 方針)。`length !== 1` を先に見るので:
 * - `[]`(全部消した人)には配らない。sanitizeStringList が明示的な空配列を空のまま通す
 *   のと同じ判断で、「お題を使わない」という意思を尊重する。
 * - 1件でも別の文字列に書き換えている人、2件以上に育てている人には触らない。
 * - 世代印が上がるのは1回だけなので、移行後に自分で1件へ戻した人には二度と配らない。
 *
 * この1段で3経路すべてに効く(migrateChallengeTapBoostNebaaru と同じ):
 *  (1) settings.json(保存済み)
 *  (2) ユーザーのデフォ保存 config/challenge-default.json
 *  (3) 同梱の公開デフォ resources/challenge-default.json(quiz キーを持たないので
 *      validateChallengeConfig が DEFAULT_QUIZ = 28件へ倒し、この段は素通りする)
 */
export function migrateChallengeQuizPrompts(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 12) return cfg;
  const p = cfg.quiz.prompts;
  if (p.length !== 1 || p[0] !== QUIZ_PROMPT_SHIPPED_V11) return cfg;
  return { ...cfg, quiz: { ...cfg.quiz, prompts: [...QUIZ_PROMPTS_V12] } };
}

/**
 * v7: コーギー(gift 6267)のブースト行を**まだ無ければ1回だけ**足す。
 *
 * ⚠ validateTapBoost の中に入れてはいけない。あちらは UI の `cfg.set` も通るので、
 * ユーザーが消した行がその場で復活する(migrateChallengeGiftFullCut と同じ理由)。
 * 逆に「単一→配列」の構造変換の方は validate 側にある — あれは**現に在るデータの
 * 詰め替え**で、移行では手遅れ(validate が先に走って旧キーを落とす)だから。
 *
 * giftId 一致で既存判定するので、ユーザーが自分でコーギー行を作っていれば二重に
 * 増えない。行を消した人には二度と配らない(世代印が上がるのは1回だけ)。
 * 上限に達している設定には足さない。
 */
export function migrateChallengeTapBoostCorgi(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 7) return cfg;
  const rules = cfg.tapBoost.rules;
  if (rules.some((r) => r.giftId === CORGI_TAP_BOOST_RULE.giftId)) return cfg;
  if (rules.length >= TAP_BOOST_RULES_MAX) return cfg;
  return {
    ...cfg,
    tapBoost: { ...cfg.tapBoost, rules: [...rules, structuredClone(CORGI_TAP_BOOST_RULE)] },
  };
}

/**
 * v9 の照合に使う**旧・既定の黒豹ブースト行の指紋**。「今の既定」ではなく
 * 「v0.7.8 までが配っていた値」なので、⚠ この表は凍結する
 * (OLD_FULL_CUT_TRIGGERS_V3 と同じ理由 — 今の定数から作り直すと新旧が同値になり
 * 判定が空振る)。
 *
 * giftName を指紋に入れないのは、同じ「出荷されたままの行」でも経路で2値を取るため:
 * 同梱の公開デフォ経由は '黒豹(限定ギフト)'、旧・単一設定の包み直し経由は ''。
 * multiplier / durationSec も入れない(現場で詰める値で、既定のままとは限らない)。
 */
const OLD_PANTHER_BOOST_ROW_V8 = {
  id: 'boost-1',
  giftId: '723500',
  introClip: 'intro-panther',
  countClip: 'count-321',
  loopClip: 'loop-panther',
} as const;

/**
 * v9: 既定のブースト行を黒豹 → ねば〜る君へ**置き換える**(足す移行ではない)。
 *
 * ⚠ validateTapBoost の中に入れてはいけない。あちらは UI の `cfg.set` も通るので、
 * ユーザーが黒豹を選び直した瞬間に上書きし返してしまう
 * (migrateChallengeTapBoostCorgi / migrateChallengeGiftFullCut と同じ理由)。
 *
 * **旧既定と完全に同じ行だけ**を寄せ替える(migrateChallengeGiftFullCutTriggers の
 * 方針)。クリップを選び直した人・自分で別 id の黒豹行を作った人の設定には触らない。
 * 行を消した人には何も配らない(足す移行ではないので、消えたものは復活しない)。
 *
 * 書き換えるのは**判定に使う4つ + 4段のクリップ + label** だけ。
 * enabled / multiplier / durationSec / flash / 並び順には触れない — 倍率と
 * ウィンドウ秒は現場で詰める値なので、テーマ差し替えで巻き戻してはいけない。
 * giftName を空にするのは必須 — 残すと '黒豹(限定ギフト)' が部分一致トリガー
 * として生き残る(同梱の公開デフォ経由の行が実際にこれを持つ)。
 *
 * この1段で3経路すべてに効く:
 *  (1) settings.json(保存済み)
 *  (2) ユーザーのデフォ保存 config/challenge-default.json(loadChallengeDefault も
 *      migrateChallengeConfig を通す。こちらが同梱より優先されるので、
 *      resources/ を直すだけでは絶対に届かない)
 *  (3) 同梱の公開デフォ resources/challenge-default.json
 */
export function migrateChallengeTapBoostNebaaru(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 9) return cfg;
  const o = OLD_PANTHER_BOOST_ROW_V8;
  const n = NEBAARU_TAP_BOOST_RULE;
  // 自分で 14463 の行を作っている人には触らない(二重一致を作らない)。
  if (cfg.tapBoost.rules.some((r) => r.giftId === n.giftId)) return cfg;
  let touched = 0;
  const rules = cfg.tapBoost.rules.map((r) => {
    if (
      r.id !== o.id ||
      r.giftId !== o.giftId ||
      r.introClip !== o.introClip ||
      r.countClip !== o.countClip ||
      r.loopClip !== o.loopClip
    ) {
      return r; // 手を入れてある行 / 別の行 — 尊重する
    }
    touched++;
    return {
      ...r,
      label: n.label,
      giftId: n.giftId,
      giftName: n.giftName,
      canonical: n.canonical,
      exactName: n.exactName,
      introClip: n.introClip,
      countClip: n.countClip,
      loopClip: n.loopClip,
      resultClip: n.resultClip,
    };
  });
  if (touched === 0) return cfg;
  return { ...cfg, tapBoost: { ...cfg.tapBoost, rules } };
}

/**
 * v8: お助けのスタンプ行(STAMP_TRIGGER_RULES_V8 の15件)を、**まだ持っていない
 * 番号だけ**1回だけ足す。v0.7.7 までの既定は空配列だったので、既定を直しただけでは
 * 保存済みの settings.json(stampTriggers キーを持っている)には届かない。
 *
 * ⚠ validateStampTriggers の中に入れてはいけない。あちらは UI の `cfg.set` も通るので、
 * ユーザーが消した行がその場で復活する(migrateChallengeGiftFullCut と同じ理由)。
 *
 * 既存判定は id ではなく **emoteId 一致** — 自分で同じ番号の行を作っている人に
 * 二重に配らないため(migrateChallengeTapBoostCorgi の giftId 照合と同型)。
 * id の重複も避ける: validateStampTriggers は validateTapBoost と違って id を振り直さない
 * ので、同じ id が2行並ぶと設定画面の `key={r.id}` が壊れる(手編集の設定への保険。
 * UI が作る id は `stamp-<base36>-<n>` なので実際にはぶつからない)。
 * 上限に達している設定には足さない・残り枠ぶんだけ足す。
 *
 * 行を消した人に世代印経由で配り直すことは無い(上がるのは1回だけ)。ただし
 * 「チャレンジ設定をすべて既定に戻す」「同梱デフォで更新」は既定を読み直すので、
 * そこからは15行が戻る — 世代とは無関係の、既定に戻すボタン本来の挙動。
 */
export function migrateChallengeStampTriggers(
  cfg: ChallengeConfig,
  fromVersion: number
): ChallengeConfig {
  if (fromVersion >= 8) return cfg;
  const rules = cfg.stampTriggers.rules;
  const room = STAMP_TRIGGER_RULES_MAX - rules.length;
  if (room <= 0) return cfg;
  const have = new Set(rules.map((r) => r.emoteId));
  const usedIds = new Set(rules.map((r) => r.id));
  const add = STAMP_TRIGGER_RULES_V8.filter(
    (r) => !have.has(r.emoteId) && !usedIds.has(r.id)
  ).slice(0, room);
  if (add.length === 0) return cfg;
  return {
    ...cfg,
    stampTriggers: { ...cfg.stampTriggers, rules: [...rules, ...add.map((r) => ({ ...r }))] },
  };
}

export function migrateChallengeSeSounds(cfg: ChallengeConfig, fromVersion: number): ChallengeConfig {
  let out = cfg;

  // v1: 妨害スロットの効果音を専用音へ。
  if (fromVersion < 1) {
    const s = out.seSounds;
    if (s.like === 'pop' || s.follow === 'question') {
      out = {
        ...out,
        seSounds: {
          ...s,
          like: s.like === 'pop' ? 'like-jam' : s.like,
          follow: s.follow === 'question' ? 'follow-jam' : s.follow,
        },
      };
    }
  }

  // v2: ルーレットの回転サウンド刷新。回転中BGMを既定オフ・回転ループ音を
  // ジングルへ・確定音を専用の確認音へ。'roulette-near' は旧ファイルにキー自体が
  // 無く validateSeSounds が既定で埋めるので、ここで触る必要はない。
  if (fromVersion < 2) {
    const s = out.seSounds;
    if (s['roulette-hit'] === 'jingle-hit') {
      out = { ...out, seSounds: { ...s, 'roulette-hit': 'reel-confirm' } };
    }
    const r = out.rouletteSound;
    if (r.bgm === 'bgm-roulette1' || r.spinSe === 'spin-reel1') {
      out = {
        ...out,
        rouletteSound: {
          ...r,
          bgm: r.bgm === 'bgm-roulette1' ? 'off' : r.bgm,
          spinSe: r.spinSe === 'spin-reel1' ? 'spin-reel2' : r.spinSe,
        },
      };
    }
  }

  // v5: 演出ごとの専用録りへ差し替え(素材は assets/se/CREDITS.md)。**旧既定のまま
  // だったスロットだけ**寄せる。自分で別の音を選んでいる設定は触らない。
  // 段の順序に意味がある: 'roulette-hit' は上の v2 が jingle-hit → reel-confirm に
  // 寄せた **後** の値を見るので、世代0の設定は jingle-hit → reel-confirm → reel-hit と
  // 2段通る(out を積み上げているのがその担保)。
  // 既定音を自分で選び直していた人は旧既定と区別できず寄ってしまう — v1/v2 から続く
  // この方式の構造的な限界で、今回も同じ扱いにする。
  if (fromVersion < 5) {
    const s = out.seSounds;
    const swap: ReadonlyArray<readonly [ChallengeSeSlot, string, string]> = [
      ['gauge-full', 'jingle-hit', 'gauge-burst'],
      ['stock-full', 'jingle-steel', 'stock-burst'],
      ['comment', 'pop', 'comment-jam'],
      ['helper', 'confirm-1', 'helper-stamp'],
      ['roulette-kick', 'bong', 'reel-kick'],
      ['roulette-hit', 'reel-confirm', 'reel-hit'],
      ['boost-start', 'jingle-steel', 'boost-tap'],
      ['boost-end', 'fanfare-8bit-short', 'boost-hit'],
      ['achieved', 'fanfare-8bit', 'clear-fanfare'],
    ];
    const hit = swap.filter(([slot, was]) => s[slot] === was);
    // 1件も該当しなければ同一参照のまま返す(上の段と同じ「無加工 = toBe で見える」流儀)。
    if (hit.length > 0) {
      const next = { ...s };
      for (const [slot, , now] of hit) next[slot] = now;
      out = { ...out, seSounds: next };
    }
  }

  return out;
}

/**
 * 壊れた settings.json でもアプリを止めない — validateScoringConfig と同じく
 * throw せずサニタイズする。数値は clamp、不正な規則は捨てる。
 */
export function validateChallengeConfig(raw: unknown): ChallengeConfig {
  const c = raw as Partial<ChallengeConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(DEFAULT_CHALLENGE);
  const d = DEFAULT_CHALLENGE;
  const num = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  const str = (v: unknown, fb: string): string => (typeof v === 'string' ? v : fb);

  const giftRules: ChallengeGiftRule[] = Array.isArray(c.giftRules)
    ? c.giftRules.filter(isValidRule).map((r) => ({
        id: r.id,
        ...(typeof r.canonical === 'string' && r.canonical !== '' ? { canonical: r.canonical } : {}),
        ...(typeof r.giftId === 'string' && r.giftId !== '' ? { giftId: r.giftId } : {}),
        ...(typeof r.minDiamonds === 'number' && Number.isFinite(r.minDiamonds)
          ? { minDiamonds: Math.max(0, Math.round(r.minDiamonds)) }
          : {}),
        mode: r.mode,
        amount: Math.round(r.amount),
        ...(r.flash === true ? { flash: true } : {}),
      }))
    : [];

  // 応援側の既定は**検証済みの共通からの派生**なので、先にローカルへ取り出す。
  const rouletteSound = validateRouletteSound(c.rouletteSound);

  const gd = c.giftDefault;
  const giftDefault =
    gd && typeof gd === 'object' && (gd.mode === 'fixed' || gd.mode === 'perDiamond') &&
    typeof gd.amount === 'number' && Number.isFinite(gd.amount)
      ? { mode: gd.mode, amount: Math.round(gd.amount) }
      : gd === null
        ? null
        : d.giftDefault;

  return {
    enabled: c.enabled === true,
    title: str(c.title, d.title),
    initialValue: num(c.initialValue, d.initialValue, 1, 9_999_999),
    pressStep: num(c.pressStep, d.pressStep, 1, 999_999),
    followStep: num(c.followStep, d.followStep, 0, 999_999),
    likeEvery: num(c.likeEvery, d.likeEvery, 0, 999_999),
    likeStep: num(c.likeStep, d.likeStep, 0, 999_999),
    // count の上限 99 はドットUIの現実的上限(実用は 3〜10 想定)。
    likeStockCount: num(c.likeStockCount, d.likeStockCount, 0, 99),
    likeStockStep: num(c.likeStockStep, d.likeStockStep, 0, 999_999),
    // 保存済み settings.json には無いフィールド。**欠損が既定(70)へ倒れること
    // 自体が移行の代わり** — v0.5.3 までカットイン動画は seVolumes['stock-full']
    // (配布デフォ 16%)を流用していたので、キーを足すだけで既存ユーザーも
    // 11% → 70% になる。既定値の書き換えでは保存済みファイルに届かない。
    stockCutinVolume: num(c.stockCutinVolume, d.stockCutinVolume, 0, 100),
    commentRules: validateCommentRules(c.commentRules),
    giftRules,
    giftDefault,
    roulettes: validateRoulettes(raw),
    joinRoulette: validateJoinRoulette(c.joinRoulette),
    rouletteSound,
    // 保存済み settings.json にこのキーは無い。**欠損が既定へ倒れること自体が
    // 移行の代わり**(stockCutinVolume / rouletteTease と同じ手口)。検証は行別上書きと
    // 同じ validateRouletteSoundOverride を流用する — あれは null / 非オブジェクト /
    // 配列をまとめて undefined にするので、**欠損も型崩れも同じ既定へ倒れる**。
    rouletteSoundSub: validateRouletteSoundOverride(c.rouletteSoundSub) ?? defaultRouletteSoundSub(rouletteSound),
    rouletteTease: validateRouletteTease(c.rouletteTease),
    // 既定 true なので `!== false`(seEnabled と同じ向き。`=== true` にすると
    // 既定が反転する)。保存済み settings.json にこのキーは無いが、
    // **欠損が true へ倒れること自体が移行の代わり**になる
    // (stockCutinVolume と同じ手口 — 既定値の書き換えは保存済みファイルに届かない)。
    hideRouletteResultInLog: c.hideRouletteResultInLog !== false,
    flashMinDiamonds:
      c.flashMinDiamonds === null ? null : num(c.flashMinDiamonds, d.flashMinDiamonds ?? 100, 1, 9_999_999),
    hotkey: str(c.hotkey, d.hotkey),
    monitorDisplayId:
      typeof c.monitorDisplayId === 'number' && Number.isFinite(c.monitorDisplayId)
        ? c.monitorDisplayId
        : null,
    monitorWindowed: c.monitorWindowed === true,
    wakeEnabled: c.wakeEnabled === true,
    // 書式が崩れた値は null(未設定)へ倒す — 表示側で NaN 時刻を作らせない。
    wakeTime: typeof c.wakeTime === 'string' && WAKE_TIME_RE.test(c.wakeTime) ? c.wakeTime : null,
    lowThreshold: num(c.lowThreshold, d.lowThreshold, 0, 9_999_999),
    // 保存済み settings.json にはこのキーが無い。既定値を直しても届かないので、
    // **この欠損フォールバックが移行そのもの**(fxClipsEnabled と同じ流儀)。
    rouletteCountView: ROULETTE_COUNT_VIEWS.includes(c.rouletteCountView as RouletteCountView)
      ? (c.rouletteCountView as RouletteCountView)
      : d.rouletteCountView,
    // 既定 true なので `!== false`(enabled/monitorWindowed の `=== true` とは逆向き)。
    seEnabled: c.seEnabled !== false,
    seVolume: num(c.seVolume, d.seVolume, 0, 100),
    seSounds: validateSeSounds(c.seSounds),
    seVolumes: validateSeVolumes(c.seVolumes),
    fxClipsEnabled: c.fxClipsEnabled !== false,
    miniFxEnabled: c.miniFxEnabled !== false,
    miniFx: validateMiniFx(c.miniFx),
    giftFullCut: validateGiftFullCut(c.giftFullCut),
    giftBandFx: validateGiftBandFx(c.giftBandFx),
    giftRepeatFx: validateGiftRepeatFx(c.giftRepeatFx),
    fanStamp: validateFanStamp(c.fanStamp),
    stampTriggers: validateStampTriggers(c.stampTriggers),
    tapBoost: validateTapBoost(c.tapBoost),
    tapLock: validateTapLock(c.tapLock),
    revolution: validateRevolution(c.revolution),
    quiz: validateQuiz(c.quiz),
    finalGate: validateFinalGate(c.finalGate),
  };
}

/**
 * 最終ゲート設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(finalGate キー無し)は既定(**有効**・30タップ)へ倒す —
 * **欠損が既定へ倒れること自体が移行の代わり**(stockCutinVolume と同じ手口)。
 * 既定 true なので `!== false`(seEnabled と同じ向き。`=== true` にすると既定が反転する)。
 */
function validateFinalGate(raw: unknown): FinalGateConfig {
  const d = DEFAULT_FINAL_GATE;
  const c = raw as Partial<FinalGateConfig> | null | undefined;
  if (!c || typeof c !== 'object') return { ...d };
  const n = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  return {
    enabled: c.enabled !== false,
    taps: n(c.taps, d.taps, FINAL_GATE_TAPS_MIN, FINAL_GATE_TAPS_MAX),
  };
}

/**
 * 連打ギフトの演出反復設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(giftRepeatFx キー無し)は既定へ倒す。
 * 真偽値の向きは既定に合わせること — 既定 true は `!== false`、既定 false は
 * `=== true`。逆にすると既定が反転する(この関数群で一番踏みやすい罠)。
 */
function validateGiftRepeatFx(raw: unknown): GiftRepeatFxConfig {
  const d = DEFAULT_GIFT_REPEAT_FX;
  const c = raw as Partial<GiftRepeatFxConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  const n = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  return {
    enabled: c.enabled !== false,
    max: n(c.max, d.max, 1, GIFT_FX_REPEAT_MAX),
    intervalMs: n(c.intervalMs, d.intervalMs, GIFT_FX_REPEAT_MIN_MS, GIFT_FX_REPEAT_MAX_MS),
    bandEnabled: c.bandEnabled !== false,
    rouletteEnabled: c.rouletteEnabled !== false,
  };
}

/**
 * ダイヤ帯域カットイン設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(giftBandFx キー無し)は既定(有効・4バンド)に倒す。
 * min>max の行は捨てる。未知のクリップ id は同じ id の既定バンドのクリップ、
 * それも無ければ 'off' に倒す。
 */
/**
 * ルーレット回転サウンドの検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(rouletteSound キー無し)は既定へ倒す(回転音は鳴る・BGM はオフ)。
 * 未知の id は**既定の id** へ — 回転ループ音は既定が実在の音なので鳴り続け、
 * BGM は既定が 'off' なので無音になる(どちらも既定の挙動に一致する)。
 */
function validateRouletteSound(raw: unknown): RouletteSoundConfig {
  const d = DEFAULT_ROULETTE_SOUND;
  const c = raw as Partial<RouletteSoundConfig> | null | undefined;
  if (!c || typeof c !== 'object') return { ...d };
  const vol = (v: unknown, fb: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, Math.round(v))) : fb;
  const id = (v: unknown, list: readonly string[], fb: string): string =>
    typeof v === 'string' && (v === 'off' || list.includes(v)) ? v : fb;
  return {
    // bgm はカタログのみ — custom を許すのは今回は spinSe だけ(将来 bgm を
    // 対応させるときも同じ `custom:` 規約で isCustomSoundId を足すだけの形)。
    bgm: id(c.bgm, CHALLENGE_ROULETTE_BGM_IDS, d.bgm),
    bgmVolume: vol(c.bgmVolume, d.bgmVolume),
    // 取込み済みカスタム音(custom:<ファイル名>)は素通し。不正な custom
    // (空名・トラバーサル文字列)は未知 id と同じく既定へ — ファイルの実在は
    // ここでは見ない(消えていた場合は再生側が無音+警告ログで扱う)。
    spinSe: isCustomSoundId(c.spinSe) ? c.spinSe : id(c.spinSe, CHALLENGE_ROULETTE_SPIN_SE_IDS, d.spinSe),
    spinSeVolume: vol(c.spinSeVolume, d.spinSeVolume),
    // 旧 settings.json にはキーが無い(超激アツ動画より前の世代)— 欠損が
    // 既定へ倒れること自体が移行の代わり(rouletteTease と同じ手口)。
    clipVolume: vol(c.clipVolume, d.clipVolume),
  };
}

/**
 * 行ごとの回転サウンド上書きの検証。**継承(キー無し)を潰さない**のが上の
 * validateRouletteSound との唯一の違い — あちらは非オブジェクトを既定へ倒すので、
 * そのまま呼ぶと「共通に従う」が「既定値で明示的に上書き」に化け、共通側の変更が
 * 行に届かなくなる(この機能で一番踏みやすい罠)。中身のサニタイズは共通と同一の
 * 関数へ委譲する — id 許可リストと音量 clamp を 2 実装に分裂させない。
 *
 * 配列を明示的に弾くのが要点。`typeof [] === 'object'` なので、これが無いと
 * 手編集の `sound: []` が「全項目が既定の上書き」に化ける(validateRouletteSound は
 * [] を既定オブジェクトへ倒す仕様で、共通側のテストがそれを固定している)。
 */
function validateRouletteSoundOverride(raw: unknown): RouletteSoundConfig | undefined {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  return validateRouletteSound(raw);
}

/**
 * 超焦らしカウント方式の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(rouletteTease キー無し)は既定(有効・jack 3種)へ倒す —
 * **欠損が既定へ倒れること自体が移行の代わり**(stockCutinVolume と同じ手口)。
 * patterns は jack 3種との積集合、空・欠損は既定(3種全部)へ — 発動回に
 * 引くものが無い状態を作らない(validateRoulette が patterns の空を許さないのと
 * 同じ理由)。
 */
function validateRouletteTease(raw: unknown): RouletteTeaseConfig {
  const d = DEFAULT_ROULETTE_TEASE;
  const c = raw as Partial<RouletteTeaseConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  const patterns = Array.isArray(c.patterns)
    ? ROULETTE_JACK_PATTERNS.filter((p) => (c.patterns as RoulettePattern[]).includes(p))
    : [];
  return {
    // 既定 true なので `!== false`(hideRouletteResultInLog と同じ向き —
    // `=== true` にすると既定が反転する。この関数群で一番踏みやすい罠)。
    enabled: c.enabled !== false,
    patterns: patterns.length > 0 ? patterns : [...d.patterns],
  };
}

/**
 * 全面カット設定の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(giftFullCut キー無し)は既定(有効・バラ/ローザの2行)へ倒す。
 *
 * giftName / canonical は**小文字化して保存**する — matchGiftTrigger が設定値を
 * 小文字前提で比較するため(validateFanStamp / validateRoulettes と同じ規約)。
 * label だけは小文字化しない(日本語の表示名を原文のまま出す)。
 * 未知のクリップ id は同じ id の既定行のクリップ、それも無ければ 'off' に倒す。
 */
function validateGiftFullCut(raw: unknown): GiftFullCutConfig {
  const d = DEFAULT_GIFT_FULL_CUT;
  const c = raw as Partial<GiftFullCutConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  const rules: GiftFullCutRule[] = [];
  if (Array.isArray(c.rules)) {
    for (const r of c.rules as Array<Partial<GiftFullCutRule>>) {
      if (typeof r.id !== 'string' || r.id === '') continue;
      const fallback = d.rules.find((x) => x.id === r.id);
      const clip =
        typeof r.clip === 'string' && (r.clip === 'off' || CHALLENGE_FX_CLIP_IDS.includes(r.clip))
          ? r.clip
          : (fallback?.clip ?? 'off');
      const durationSec =
        typeof r.durationSec === 'number' && Number.isFinite(r.durationSec)
          ? Math.min(30, Math.max(1, Math.round(r.durationSec)))
          : (fallback?.durationSec ?? 5);
      const low = (v: unknown, fb: string): string =>
        typeof v === 'string' ? v.trim().toLowerCase() : fb;
      rules.push({
        id: r.id,
        label: typeof r.label === 'string' ? r.label.trim() : (fallback?.label ?? ''),
        giftId: typeof r.giftId === 'string' ? r.giftId.trim() : (fallback?.giftId ?? ''),
        giftName: low(r.giftName, fallback?.giftName ?? ''),
        canonical: low(r.canonical, fallback?.canonical ?? ''),
        // 既定 false。ただしこの関数の流儀(同じ id の既定行へ倒す)に合わせ、
        // **キー自体が無い**旧 settings.json は既定行の値を継ぐ — 素の `=== true` に
        // すると、出荷時に完全一致で配った行が旧設定のユーザーだけ部分一致に
        // 化けて上位ギフトを奪う。明示的な false(チェックを外した意思)は
        // typeof ガードでそのまま尊重される。
        exactName:
          typeof r.exactName === 'boolean' ? r.exactName : (fallback?.exactName ?? false),
        clip,
        durationSec,
        enabled: r.enabled !== false,
      });
    }
  } else {
    rules.push(...structuredClone(d.rules));
  }
  return {
    enabled: c.enabled !== false,
    volume:
      typeof c.volume === 'number' && Number.isFinite(c.volume)
        ? Math.min(100, Math.max(0, Math.round(c.volume)))
        : d.volume,
    rules,
  };
}

function validateGiftBandFx(raw: unknown): GiftBandFxConfig {
  const d = DEFAULT_GIFT_BAND_FX;
  const c = raw as Partial<GiftBandFxConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);

  const bands: GiftFxBand[] = [];
  if (Array.isArray(c.bands)) {
    for (const b of c.bands as Array<Partial<GiftFxBand>>) {
      if (!b || typeof b !== 'object' || typeof b.id !== 'string') continue;
      if (typeof b.min !== 'number' || !Number.isFinite(b.min)) continue;
      if (typeof b.max !== 'number' || !Number.isFinite(b.max)) continue;
      const min = Math.min(9_999_999, Math.max(1, Math.round(b.min)));
      const max = Math.min(9_999_999, Math.max(1, Math.round(b.max)));
      if (min > max) continue;
      const fallback = d.bands.find((x) => x.id === b.id)?.clip ?? 'off';
      const clip =
        typeof b.clip === 'string' && (b.clip === 'off' || CHALLENGE_FX_CLIP_IDS.includes(b.clip))
          ? b.clip
          : fallback;
      const durationSec =
        typeof b.durationSec === 'number' && Number.isFinite(b.durationSec)
          ? Math.min(30, Math.max(1, Math.round(b.durationSec)))
          : (d.bands.find((x) => x.id === b.id)?.durationSec ?? 6);
      // bgm はあとから足したフィールド。前バージョンの settings.json には無いので
      // 欠損・未知 id は同じ id の既定バンドの bgm(なければ 'off')に倒す。
      const bgmFallback = d.bands.find((x) => x.id === b.id)?.bgm ?? 'off';
      const bgm =
        typeof b.bgm === 'string' && (b.bgm === 'off' || CHALLENGE_BAND_BGM_IDS.includes(b.bgm))
          ? b.bgm
          : bgmFallback;
      bands.push({ id: b.id, min, max, clip, durationSec, enabled: b.enabled !== false, bgm });
    }
  } else {
    bands.push(...structuredClone(d.bands));
  }

  const excludeGiftIds = Array.isArray(c.excludeGiftIds)
    ? c.excludeGiftIds.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim())
    : [...d.excludeGiftIds];

  return {
    // 既定 true なので `!== false`(fxClipsEnabled と同じ向き)。
    enabled: c.enabled !== false,
    bands,
    excludeGiftIds,
    overflow: c.overflow === 'off' ? 'off' : 'top',
    bgmEnabled: c.bgmEnabled !== false,
    bgmVolume:
      typeof c.bgmVolume === 'number' && Number.isFinite(c.bgmVolume)
        ? Math.min(100, Math.max(0, Math.round(c.bgmVolume)))
        : d.bgmVolume,
  };
}

/**
 * お助け機能(ファンスタンプ)の検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(fanStamp キー無し)は既定へ。giftName/canonical は小文字化して
 * 保存する — マッチ側(matchGiftTrigger)が設定値を小文字前提で比較するため
 * (validateRoulette と同じ規約)。
 */
function validateFanStamp(raw: unknown): FanStampConfig {
  const d = DEFAULT_FAN_STAMP;
  const c = raw as Partial<FanStampConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  return {
    // 既定 true なので `!== false`(seEnabled / validateRoulette と同じ向き)。
    // giftId/giftName/canonical が3つとも空なら matchGiftTrigger が構造的に
    // 一致しないので、enabled のまま既定を配っても既存の挙動は変わらない。
    enabled: c.enabled !== false,
    giftId: typeof c.giftId === 'string' ? c.giftId.trim() : d.giftId,
    giftName: typeof c.giftName === 'string' ? c.giftName.trim().toLowerCase() : d.giftName,
    canonical: typeof c.canonical === 'string' ? c.canonical.trim().toLowerCase() : d.canonical,
    // 負数を許すので Math.max(0, ...) はしない(応援方向が本命)。
    amountEach:
      typeof c.amountEach === 'number' && Number.isFinite(c.amountEach)
        ? Math.min(999_999, Math.max(-999_999, Math.round(c.amountEach)))
        : d.amountEach,
    suppressBandFx: c.suppressBandFx !== false,
    flash: c.flash !== false,
  };
}

/**
 * チャットスタンプ(サブスクエモート)トリガーの検証。既存流儀どおり throw せず
 * サニタイズする。旧 settings.json(stampTriggers キー無し)は既定 = 出荷の15行へ倒れる
 * ので、**キーを持たない設定にはこの欠損フォールバックが移行を兼ねる**。キーを持っていて
 * rules が空配列の設定(v0.7.7 の保存済み)にはここは効かない — そちらは
 * migrateChallengeStampTriggers(SETTINGS_VERSION 8)だけが配れる。
 * emoteId は数字の ID 文字列なので小文字化はしない(trim のみ)。id の無い行は捨てる
 * (validateGiftFullCut と同じ規約 — UI の key と行の同一性が立たないため)。
 */
function validateStampTriggers(raw: unknown): StampTriggerConfig {
  const d = DEFAULT_STAMP_TRIGGERS;
  const c = raw as Partial<StampTriggerConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  const rules: StampTriggerRule[] = [];
  if (Array.isArray(c.rules)) {
    for (const r of c.rules as Array<Partial<StampTriggerRule>>) {
      if (rules.length >= STAMP_TRIGGER_RULES_MAX) break;
      if (typeof r.id !== 'string' || r.id === '') continue;
      rules.push({
        id: r.id,
        label: typeof r.label === 'string' ? r.label.trim() : '',
        emoteId: typeof r.emoteId === 'string' ? r.emoteId.trim() : '',
        // 負数を許すので Math.max(0, ...) はしない(fanStamp.amountEach と同じ clamp)。
        amountEach:
          typeof r.amountEach === 'number' && Number.isFinite(r.amountEach)
            ? Math.min(999_999, Math.max(-999_999, Math.round(r.amountEach)))
            : 0,
        enabled: r.enabled !== false,
      });
    }
  }
  return { enabled: c.enabled !== false, flash: c.flash !== false, rules };
}

/** 旧・単一 tapBoost の形。**export しない** — 読むのは validateTapBoost だけ。 */
interface LegacyTapBoost {
  giftId: string;
  giftName: string;
  canonical: string;
  multiplier: number;
  durationSec: number;
  introClip: string;
  countClip: string;
  loopClip: string;
  resultClip: string;
  flash: boolean;
}

/**
 * タップブーストの検証。既存流儀どおり throw せずサニタイズする。
 * 旧 settings.json(tapBoost キー無し)は既定へ。giftName/canonical の小文字化と
 * 真偽値の向き(既定 true は `!== false`)は validateFanStamp と同じ規約。
 *
 * **旧・単一設定の引き継ぎ**: giftId/multiplier/クリップをこの階層に直接持つ形は
 * rules[0] へ包み直す。**移行(migrate*)ではなく validate に置く**のは、
 * migrateChallengeConfig が validateChallengeConfig の**後**に走るため
 * (boot-settings.ts)— あちらは明示リテラル return なので、migrate の時点では
 * 旧キーはもう消えている。validateRoulettes の legacy `roulette` と同型。
 * 変換は冪等(rules が配列なら旧キーは見ない)で、settings.json / ユーザーの
 * challenge-default.json / 同梱 resources/challenge-default.json の3経路すべてに
 * 1箇所で効く — どのファイルも手で書き換える必要は無い。
 */
function validateTapBoost(raw: unknown): TapBoostConfig {
  const d = DEFAULT_TAP_BOOST;
  const c = raw as (Partial<TapBoostConfig> & Partial<LegacyTapBoost>) | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);

  // 旧形式の判定: rules が無く、旧キーが1つでもあれば単一設定とみなす。
  const legacy =
    !Array.isArray(c.rules) &&
    (typeof c.giftId === 'string' ||
      typeof c.multiplier === 'number' ||
      typeof c.introClip === 'string');
  const src: unknown[] | null = Array.isArray(c.rules) ? c.rules : legacy ? [c] : null;
  // rules も旧キーも無い = 触られていない設定。既定の1行を配る。
  if (src === null) return { enabled: c.enabled !== false, rules: structuredClone(d.rules) };

  const out: TapBoostRule[] = [];
  const seen = new Set<string>();
  for (const r of src.slice(0, TAP_BOOST_RULES_MAX)) {
    const v = validateTapBoostRule(r, legacy);
    // 重複・欠損 id は振り直す — UI の key と行ごとの実演の対象特定がぶれるため
    // (validateRoulettes と同じ理由・同じ式)。
    const id =
      v.id !== '' && !seen.has(v.id) ? v.id : v.id !== '' ? `${v.id}-${out.length}` : `boost-${out.length}`;
    seen.add(id);
    out.push({ ...v, id });
  }
  // 明示的な空配列は空のまま通す(全行消したユーザーの意思を尊重する)。
  return { enabled: c.enabled !== false, rules: out };
}

/**
 * ブースト1行の検証。未知のクリップ id は既定へ('off' は「この段を出さない」の
 * 明示選択として通す)。legacy=true の行は id/label/exactName を持たないので既定を
 * 与える — **exactName は必ず false**(旧挙動は部分一致。true にすると出荷済みの
 * トリガーが一致しなくなる)。
 */
function validateTapBoostRule(raw: unknown, legacy: boolean): TapBoostRule {
  const dr = DEFAULT_TAP_BOOST_RULE;
  const r = raw as Partial<TapBoostRule> | null | undefined;
  if (!r || typeof r !== 'object') return structuredClone(dr);
  const n = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  const clip = (v: unknown, list: readonly TapBoostClipDef[], fb: string): string =>
    typeof v === 'string' && (v === 'off' || list.some((x) => x.id === v)) ? v : fb;
  return {
    id: typeof r.id === 'string' ? r.id.trim() : legacy ? dr.id : '',
    label: typeof r.label === 'string' ? r.label.trim() : '',
    enabled: r.enabled !== false,
    giftId: typeof r.giftId === 'string' ? r.giftId.trim() : dr.giftId,
    giftName: typeof r.giftName === 'string' ? r.giftName.trim().toLowerCase() : dr.giftName,
    canonical: typeof r.canonical === 'string' ? r.canonical.trim().toLowerCase() : dr.canonical,
    // 旧設定は完全一致の概念を持たないので必ず false = 従来どおりの部分一致。
    exactName: !legacy && typeof r.exactName === 'boolean' ? r.exactName : false,
    multiplier: n(r.multiplier, dr.multiplier, TAP_BOOST_MULT_MIN, TAP_BOOST_MULT_MAX),
    durationSec: n(r.durationSec, dr.durationSec, TAP_BOOST_DURATION_MIN_SEC, TAP_BOOST_DURATION_MAX_SEC),
    introClip: clip(r.introClip, TAP_BOOST_INTRO_CLIPS, dr.introClip),
    countClip: clip(r.countClip, TAP_BOOST_COUNT_CLIPS, dr.countClip),
    loopClip: clip(r.loopClip, TAP_BOOST_LOOP_CLIPS, dr.loopClip),
    resultClip: clip(r.resultClip, TAP_BOOST_RESULT_CLIPS, dr.resultClip),
    flash: r.flash !== false,
  };
}

/**
 * お邪魔(タップ封じ)の検証。validateTapBoost の複製から旧形式(LegacyTapBoost)の
 * 展開とクリップ検証を落としたもの — この機能には出荷済みの旧形式が存在しない。
 *
 * **キー欠損は既定へ倒れるだけで移行(migrate*)は要らない。** 既定の行は空トリガーで
 * どのギフトにも一致せず、機能 enabled も false なので、既存の settings.json へ何も
 * 配らなくても挙動は 1 ミリも変わらない(stockCutinVolume と同じ前例)。
 */
function validateTapLock(raw: unknown): TapLockConfig {
  const d = DEFAULT_TAP_LOCK;
  const c = raw as Partial<TapLockConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  // 既定が false の真偽値なので `=== true` で読む(既定 true の `!== false` の逆)。
  const enabled = c.enabled === true;
  if (!Array.isArray(c.rules)) return { enabled, rules: structuredClone(d.rules) };

  const out: TapLockRule[] = [];
  const seen = new Set<string>();
  for (const r of c.rules.slice(0, TAP_LOCK_RULES_MAX)) {
    const v = validateTapLockRule(r);
    // 重複・欠損 id は振り直す(validateTapBoost と同じ理由・同じ式)。
    const id =
      v.id !== '' && !seen.has(v.id) ? v.id : v.id !== '' ? `${v.id}-${out.length}` : `lock-${out.length}`;
    seen.add(id);
    out.push({ ...v, id });
  }
  // 明示的な空配列は空のまま通す(全行消したユーザーの意思を尊重する)。
  return { enabled, rules: out };
}

/** お邪魔1行の検証。秒数は clamp、増減量は既存の amountEach 系と同じ整数丸め。 */
function validateTapLockRule(raw: unknown): TapLockRule {
  const dr = DEFAULT_TAP_LOCK_RULE;
  const r = raw as Partial<TapLockRule> | null | undefined;
  if (!r || typeof r !== 'object') return structuredClone(dr);
  const n = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  return {
    id: typeof r.id === 'string' ? r.id.trim() : '',
    label: typeof r.label === 'string' ? r.label.trim() : '',
    enabled: r.enabled !== false,
    giftId: typeof r.giftId === 'string' ? r.giftId.trim() : dr.giftId,
    giftName: typeof r.giftName === 'string' ? r.giftName.trim().toLowerCase() : dr.giftName,
    canonical: typeof r.canonical === 'string' ? r.canonical.trim().toLowerCase() : dr.canonical,
    exactName: typeof r.exactName === 'boolean' ? r.exactName : false,
    durationSec: n(r.durationSec, dr.durationSec, TAP_LOCK_DURATION_MIN_SEC, TAP_LOCK_DURATION_MAX_SEC),
    amountEach: n(r.amountEach, dr.amountEach, -999_999, 999_999),
    flash: r.flash !== false,
  };
}

/**
 * 革命の検証。validateTapLock の鏡像 — この機能にも出荷済みの旧形式は存在しない。
 *
 * **キー欠損は既定へ倒れるだけで移行(migrate*)は要らない。** 既定の行は giftId が
 * 空で giftName の完全一致だけ、機能 enabled も false なので、既存の settings.json へ
 * 何も配らなくても挙動は 1 ミリも変わらない(tapLock / stockCutinVolume と同じ前例)。
 */
function validateRevolution(raw: unknown): RevolutionConfig {
  const d = DEFAULT_REVOLUTION;
  const c = raw as Partial<RevolutionConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  // 既定が false の真偽値なので `=== true` で読む(tapLock と同じ向き)。
  const enabled = c.enabled === true;
  if (!Array.isArray(c.rules)) return { enabled, rules: structuredClone(d.rules) };

  const out: RevolutionRule[] = [];
  const seen = new Set<string>();
  for (const r of c.rules.slice(0, REVOLUTION_RULES_MAX)) {
    const v = validateRevolutionRule(r);
    // 重複・欠損 id は振り直す(validateTapLock と同じ理由・同じ式)。
    const id =
      v.id !== '' && !seen.has(v.id) ? v.id : v.id !== '' ? `${v.id}-${out.length}` : `rev-${out.length}`;
    seen.add(id);
    out.push({ ...v, id });
  }
  // 明示的な空配列は空のまま通す(全行消したユーザーの意思を尊重する)。
  return { enabled, rules: out };
}

/** 革命1行の検証。validateTapLockRule と同じ clamp の流儀。 */
function validateRevolutionRule(raw: unknown): RevolutionRule {
  const dr = DEFAULT_REVOLUTION_RULE;
  const r = raw as Partial<RevolutionRule> | null | undefined;
  if (!r || typeof r !== 'object') return structuredClone(dr);
  const n = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  return {
    id: typeof r.id === 'string' ? r.id.trim() : '',
    label: typeof r.label === 'string' ? r.label.trim() : '',
    enabled: r.enabled !== false,
    giftId: typeof r.giftId === 'string' ? r.giftId.trim() : dr.giftId,
    giftName: typeof r.giftName === 'string' ? r.giftName.trim().toLowerCase() : dr.giftName,
    canonical: typeof r.canonical === 'string' ? r.canonical.trim().toLowerCase() : dr.canonical,
    // 既定行が exactName: true なのは意図(短い 'swan' の誤爆ガード)だが、検証の
    // フォールバックは他の rule 系と同じ false — ユーザーが明示的に外した意思を
    // boolean 以外の壊れた値から復元はしない。
    exactName: typeof r.exactName === 'boolean' ? r.exactName : false,
    multiplier: n(r.multiplier, dr.multiplier, REVOLUTION_MULT_MIN, REVOLUTION_MULT_MAX),
    durationSec: n(r.durationSec, dr.durationSec, REVOLUTION_DURATION_MIN_SEC, REVOLUTION_DURATION_MAX_SEC),
    flash: r.flash !== false,
  };
}

/**
 * 文字列配列(お題・判定ワード)の検証。trim して空行を除去し、件数と長さを
 * clamp する。validateCommentRules と同じ「throw せずサニタイズ」の流儀。
 */
function sanitizeStringList(raw: unknown, max: number, lenMax: number, fb: readonly string[]): string[] {
  if (!Array.isArray(raw)) return [...fb];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const s = v.trim().slice(0, lenMax);
    if (s !== '') out.push(s);
    if (out.length >= max) break;
  }
  // 明示的な空配列は空のまま通す(全行消したユーザーの意思を尊重 — rules と同じ)。
  return out;
}

/**
 * お題ルーレットの検証。validateRevolution の鏡像 — この機能にも出荷済みの
 * 旧形式は存在しない。
 *
 * **キー欠損は既定へ倒れるだけで移行(migrate*)は要らない。** 既定の行は
 * giftId / giftName とも空でどのギフトにも一致せず、機能 enabled も false なので、
 * 既存の settings.json へ何も配らなくても挙動は 1 ミリも変わらない
 * (revolution / tapLock / stockCutinVolume と同じ前例)。
 */
export function validateQuiz(raw: unknown): QuizConfig {
  const d = DEFAULT_QUIZ;
  const c = raw as Partial<QuizConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);
  const n = (v: unknown, fb: number, min: number, max: number): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, Math.round(v))) : fb;
  // BGM スロットの検証。'off' / カタログ id / custom: の3分岐は既存の bgm と同じで、
  // 区間スロットだけ番兵 'keep'(前の区間の曲を続ける)を上乗せする。
  // **先頭区間の bgm には keep を渡さない** — 継続元が無いので既定へ倒すのが正しい。
  const bgmId = (v: unknown, fb: string, keep: boolean): string =>
    v === 'off' ||
    (keep && v === QUIZ_BGM_KEEP) ||
    (typeof v === 'string' && CHALLENGE_ROULETTE_BGM_IDS.includes(v)) ||
    isCustomSoundId(v)
      ? (v as string)
      : fb;
  // 既定が false の真偽値なので `=== true` で読む(revolution と同じ向き)。
  const enabled = c.enabled === true;

  let rules: QuizRule[];
  if (!Array.isArray(c.rules)) {
    rules = structuredClone(d.rules);
  } else {
    rules = [];
    const seen = new Set<string>();
    for (const r of c.rules.slice(0, QUIZ_RULES_MAX)) {
      const v = validateQuizRule(r);
      // 重複・欠損 id は振り直す(validateRevolution と同じ理由・同じ式)。
      const id =
        v.id !== '' && !seen.has(v.id)
          ? v.id
          : v.id !== ''
            ? `${v.id}-${rules.length}`
            : `quiz-${rules.length}`;
      seen.add(id);
      rules.push({ ...v, id });
    }
  }

  return {
    enabled,
    rules,
    // お題は欠損時だけ既定(QUIZ_PROMPTS_V12 の28件)へ倒す。明示的な空配列は空のまま —
    // 空だと発動しない(worker 側が不発 + giftDiag)ので破綻はしない。
    prompts: sanitizeStringList(c.prompts, QUIZ_PROMPTS_MAX, QUIZ_PROMPT_LEN_MAX, d.prompts),
    durationSec: n(c.durationSec, d.durationSec, QUIZ_DURATION_MIN_SEC, QUIZ_DURATION_MAX_SEC),
    voteSec: n(c.voteSec, d.voteSec, QUIZ_VOTE_MIN_SEC, QUIZ_VOTE_MAX_SEC),
    amount: n(c.amount, d.amount, QUIZ_AMOUNT_MIN, QUIZ_AMOUNT_MAX),
    // 判定ワードが両方空だと全票が無効になるだけ(±0 で終わる)なので許す。
    goodWords: sanitizeStringList(c.goodWords, QUIZ_WORDS_MAX, QUIZ_WORD_LEN_MAX, d.goodWords),
    badWords: sanitizeStringList(c.badWords, QUIZ_WORDS_MAX, QUIZ_WORD_LEN_MAX, d.badWords),
    // BGM はルーレットと同じカタログ(+custom:)。未知の id は既定へ戻す。
    // 区間①(発動〜導入カット〜回転)の曲 — ここだけ 'keep' を受け付けない。
    bgm: bgmId(c.bgm, d.bgm, false),
    bgmVolume: n(c.bgmVolume, d.bgmVolume, 0, 100),
    // ── 区間②〜④の曲。既定 'keep' なので、キー欠損 = 従来どおり1曲通し。
    revealBgm: bgmId(c.revealBgm, d.revealBgm, true),
    revealBgmVolume: n(c.revealBgmVolume, d.revealBgmVolume, 0, 100),
    prepSec: n(c.prepSec, d.prepSec, QUIZ_PREP_MIN_SEC, QUIZ_PREP_MAX_SEC),
    prepBgm: bgmId(c.prepBgm, d.prepBgm, true),
    prepBgmVolume: n(c.prepBgmVolume, d.prepBgmVolume, 0, 100),
    thinkBgm: bgmId(c.thinkBgm, d.thinkBgm, true),
    thinkBgmVolume: n(c.thinkBgmVolume, d.thinkBgmVolume, 0, 100),
    voteBgm: bgmId(c.voteBgm, d.voteBgm, true),
    voteBgmVolume: n(c.voteBgmVolume, d.voteBgmVolume, 0, 100),
    // ── 区間⑤(終了後)。減算/増加で別の曲・±0 は無音(2026-08-22 ユーザー決定)。
    outroSec: n(c.outroSec, d.outroSec, QUIZ_OUTRO_MIN_SEC, QUIZ_OUTRO_MAX_SEC),
    outroDownBgm: bgmId(c.outroDownBgm, d.outroDownBgm, true),
    outroDownBgmVolume: n(c.outroDownBgmVolume, d.outroDownBgmVolume, 0, 100),
    outroUpBgm: bgmId(c.outroUpBgm, d.outroUpBgm, true),
    outroUpBgmVolume: n(c.outroUpBgmVolume, d.outroUpBgmVolume, 0, 100),
    // 'off' / 専用素材の番兵 / 全面カットのカタログ。未知の id は既定へ戻す。
    introClip:
      c.introClip === 'off' ||
      c.introClip === QUIZ_INTRO_SELF ||
      (typeof c.introClip === 'string' && FULL_CUT_CLIP_IDS.includes(c.introClip))
        ? c.introClip
        : d.introClip,
  };
}

/** お題ルーレット1行の検証。validateRevolutionRule と同じ流儀(数値項目なし)。 */
function validateQuizRule(raw: unknown): QuizRule {
  const dr = DEFAULT_QUIZ_RULE;
  const r = raw as Partial<QuizRule> | null | undefined;
  if (!r || typeof r !== 'object') return structuredClone(dr);
  return {
    id: typeof r.id === 'string' ? r.id.trim() : '',
    label: typeof r.label === 'string' ? r.label.trim().slice(0, ROULETTE_LABEL_MAX) : '',
    enabled: r.enabled !== false,
    giftId: typeof r.giftId === 'string' ? r.giftId.trim() : dr.giftId,
    giftName: typeof r.giftName === 'string' ? r.giftName.trim().toLowerCase() : dr.giftName,
    canonical: typeof r.canonical === 'string' ? r.canonical.trim().toLowerCase() : dr.canonical,
    exactName: typeof r.exactName === 'boolean' ? r.exactName : false,
    flash: r.flash !== false,
  };
}

/** ルーレット盤面の上限行数。UI とリール演出が破綻しない範囲で余裕を持たせる。 */
export const ROULETTE_SEGMENTS_MAX = 12;

/** 登録できるルーレットの上限件数。設定UIと settings.json の現実的な上限。 */
export const ROULETTES_MAX = 8;

/** ルーレット表示名の最大長。モニターの見出し1行に収まる範囲。 */
export const ROULETTE_LABEL_MAX = 24;

/**
 * ルーレット群の検証。既存流儀どおり throw せずサニタイズする。
 *
 * 移行: 旧 settings.json は単一の `roulette` キーを持つ。`roulettes` が無く
 * `roulette` があればそれを1件の配列へ包んで引き継ぐ — ユーザーが調整した盤面を
 * 「既定に戻す」で踏み潰さないため。どちらも無ければ既定(ハートミー1件)。
 *
 * 明示的な空配列は空のまま通す — 全部消した
 * ユーザーの意思を尊重する。ルーレット0件は「どのギフトでも回らない」で破綻しない。
 */
function validateRoulettes(raw: unknown): ChallengeRouletteConfig[] {
  const c = raw as { roulettes?: unknown; roulette?: unknown } | null | undefined;
  const legacy = !Array.isArray(c?.roulettes) && c?.roulette != null && typeof c.roulette === 'object';
  const src = Array.isArray(c?.roulettes) ? c.roulettes : legacy ? [c!.roulette] : null;
  if (src === null) return structuredClone(DEFAULT_ROULETTES) as ChallengeRouletteConfig[];

  // 旧形式には id/label が無い。移行分だけは既定(ハートミー)の名前を継がせる —
  // そうしないと表示が TikTok の実名 'Heart Me' に落ちて要望の日本語表記が出ない。
  // 新形式の行では欠損 label を '' のまま通す(giftName へフォールバックせよの意思)。
  const fb = legacy
    ? { id: DEFAULT_ROULETTE.id, label: DEFAULT_ROULETTE.label }
    : { id: '', label: '' };

  const out: ChallengeRouletteConfig[] = [];
  const seen = new Set<string>();
  for (const r of src.slice(0, ROULETTES_MAX)) {
    const v = validateRoulette(r, fb);
    // 重複・欠損 id は振り直す — UI の key と行ごとのテスト再生の対象特定がぶれるため。
    const id = v.id !== '' && !seen.has(v.id) ? v.id : v.id !== '' ? `${v.id}-${out.length}` : `rl-${out.length}`;
    seen.add(id);
    out.push({ ...v, id });
  }
  return out;
}

/**
 * 焦らしパターンの許可リストの検証。ROULETTE_PATTERNS を正としてフィルタする —
 * 正順への正規化・未知値除去・重複除去が1本で済む。非配列(欠損キーの旧
 * settings.json を含む)と全滅(全部外した/未知値だけ)は全パターンへ倒す —
 * 抽選(drawRoulettePattern)が空で止まらないための二重防御の保存側。
 */
function sanitizeRoulettePatterns(raw: unknown): RoulettePattern[] {
  // 欠損・全滅は **DEFAULT_ROULETTE_PATTERNS**(オプトインの ultra を除く)へ倒す。
  // ROULETTE_PATTERNS へ倒すと、patterns キーを持たない出荷 JSON でオプトインが
  // 勝手に有効になる(= 既定オフの意味が無くなる)。
  if (!Array.isArray(raw)) return [...DEFAULT_ROULETTE_PATTERNS];
  // 明示配列にオプトインが入っていれば尊重する — ユーザーが選んだものは通す。
  // ただし激熱確定専用(ROULETTE_HOT_ONLY_PATTERNS)は SELECTABLE に居ないので、
  // 手編集の settings.json で紛れ込んでいてもここで必ず落ちる。
  const out = ROULETTE_SELECTABLE_PATTERNS.filter((p) => raw.includes(p));
  return out.length > 0 ? out : [...DEFAULT_ROULETTE_PATTERNS];
}

/**
 * 盤面(segments)の検証。**抽選不能な盤面は null を返す** — 非配列(欠損キー)、
 * 有効な出目が 1 件も残らない、全 weight が 0、のいずれも呼び元が自分の既定
 * segments へ倒す(ギフト・入室で既定が同じでも、フォールバック先の所有は呼び元)。
 */
function sanitizeRouletteSegments(raw: unknown): ChallengeRouletteSegment[] | null {
  if (!Array.isArray(raw)) return null;
  const segments = raw
    .filter(
      (s): s is ChallengeRouletteSegment =>
        !!s &&
        typeof s === 'object' &&
        typeof s.amount === 'number' &&
        Number.isFinite(s.amount) &&
        typeof s.weight === 'number' &&
        Number.isFinite(s.weight)
    )
    .slice(0, ROULETTE_SEGMENTS_MAX)
    .map((s) => ({
      amount: Math.min(9_999_999, Math.max(1, Math.round(s.amount))),
      weight: Math.min(999_999, Math.max(0, Math.round(s.weight))),
    }));
  const usable = segments.length > 0 && segments.some((s) => s.weight > 0);
  return usable ? segments : null;
}

/**
 * 激熱確定の検証。**無効なら undefined を返してキーごと落とす**(sound の上書きと
 * 同じ規約 — 保存済み settings.json に無意味な既定値を生やさない)。
 *
 * 落とす条件は3つ:
 *   1. 非オブジェクト(キー欠損の旧 settings.json)= 移行の代わり
 *   2. enabled が true でない — 既定は無効なので `=== true`(validateJoinRoulette と同じ向き)
 *   3. direction が 'sub' — 応援側で一気に 50 倍減らすのは別の企画。**UI のチェックが
 *      残ったまま効かない「死んだコントロール」を作らない**ため、向きを引数で受けて
 *      ここで構造的に落とす
 */
function validateRouletteHot(raw: unknown, direction: 'add' | 'sub'): RouletteHotConfig | undefined {
  if (direction === 'sub') return undefined;
  const c = raw as Partial<RouletteHotConfig> | null | undefined;
  if (!c || typeof c !== 'object' || c.enabled !== true) return undefined;
  // 候補列(確率抽選)。**正規形はキー存在 ⇔ 候補2件以上** — 抽選側
  // (rouletteHotMultCandidates)と同じゲートを通し、通ったときだけキーを出す。
  // multiplier には代表値を焼き直す(旧バージョンで読んだときの縮退先)。
  const cands = rouletteHotMultCandidates(c as RouletteHotConfig);
  if (cands) {
    return { enabled: true, multiplier: rouletteHotRepresentativeMult(cands), multipliers: cands };
  }
  // ちょうど1件だけ生き残った候補列は従来形へ**畳む**(キーを出さない)。UI も
  // 1行のときは従来形を書くので、保存→読み直しの往復で形が揺れない。2件以上
  // あるのに全 weight 0 で cands が null になった列も、代表値(先頭)へ畳む —
  // どちらも2回目の validate ではキー欠損の従来経路に入るので冪等。
  const list = sanitizeRouletteHotMultList(c.multipliers);
  if (list && list.length > 0) {
    return { enabled: true, multiplier: rouletteHotRepresentativeMult(list) };
  }
  // 従来形(キー欠損の旧 settings.json を含む)。multipliers を**生やさない** —
  // 出荷既定(DJ_GLASSES_ROULETTE)の validate 不動点を守る(migrate の出力は
  // 再検証されないので、ここで形が変わると不動点検査が落ちる)。
  const m = typeof c.multiplier === 'number' && Number.isFinite(c.multiplier) ? c.multiplier : NaN;
  return {
    enabled: true,
    multiplier: Number.isNaN(m) ? DEFAULT_ROULETTE_HOT.multiplier : clampRouletteHotMult(m),
  };
}

/**
 * ルーレット1件ぶんの検証。既存流儀どおり throw せずサニタイズする。
 * 有効な出目が 1 件も残らない/全 weight が 0 の盤面は抽選不能なので既定 segments に戻す。
 */
function validateRoulette(raw: unknown, fb: { id: string; label: string }): ChallengeRouletteConfig {
  const d = DEFAULT_ROULETTE;
  const c = raw as Partial<ChallengeRouletteConfig> | null | undefined;
  if (!c || typeof c !== 'object') return { ...structuredClone(d), ...fb };

  const segments = sanitizeRouletteSegments(c.segments);
  const sound = validateRouletteSoundOverride(c.sound);
  // 向きは下の direction と**同じ式**で先に決める(激熱は 'add' の行だけ)。
  const direction: 'add' | 'sub' = c.direction === 'sub' ? 'sub' : 'add';
  const hot = validateRouletteHot(c.hot, direction);

  return {
    // 欠損・重複 id は呼び元(validateRoulettes)が振り直すので、ここは fb のまま通す。
    id: typeof c.id === 'string' ? c.id.trim() : fb.id,
    // giftName/canonical と違い小文字化しない — 日本語の表示名を原文のまま出す。
    // `|| fb.label` にしないこと: ユーザーが意図して空にした label を既定名で潰さない。
    label: typeof c.label === 'string' ? c.label.trim().slice(0, ROULETTE_LABEL_MAX) : fb.label,
    // enabled の既定は true なので `!== false`(seEnabled と同じ向き)。
    enabled: c.enabled !== false,
    giftId: typeof c.giftId === 'string' ? c.giftId.trim() : d.giftId,
    giftName: typeof c.giftName === 'string' ? c.giftName.trim().toLowerCase() : d.giftName,
    canonical: typeof c.canonical === 'string' ? c.canonical.trim().toLowerCase() : d.canonical,
    segments: segments ?? structuredClone(d.segments),
    direction,
    patterns: sanitizeRoulettePatterns(c.patterns),
    // 上書きが無いときは**キーごと出さない**(direction:'sub' と同じ条件付き
    // スプレッドの流儀)。常に sound を出すと DEFAULT_ROULETTE(キー無し)と形が
    // ずれ、保存済み settings.json の全行に無意味な既定値が生える。
    ...(sound ? { sound } : {}),
    // 激熱確定も同じ規約 — 無効ならキーごと出さない(欠損が既定 = 移行の代わり)。
    ...(hot ? { hot } : {}),
  };
}

/**
 * 入室ルーレットの検証。既存流儀どおり throw せずサニタイズする。
 * キー欠損・非オブジェクト(旧 settings.json)は既定(enabled:false)へ倒す —
 * これが移行の代わり(validateRoulettes の legacy 処理と同じ思想)。
 * label は空を許さない — rouletteBoardKey('' だと同一盤面のギフトルーレットと
 * 畳み込まれる)と履歴ログの見出しの両方が壊れるため、空は既定名へ倒す。
 */
function validateJoinRoulette(raw: unknown): JoinRouletteConfig {
  const d = DEFAULT_JOIN_ROULETTE;
  const c = raw as Partial<JoinRouletteConfig> | null | undefined;
  if (!c || typeof c !== 'object') return structuredClone(d);

  const label = typeof c.label === 'string' ? c.label.trim().slice(0, ROULETTE_LABEL_MAX) : '';
  const sound = validateRouletteSoundOverride(c.sound);
  return {
    // enabled の既定は false なので `=== true`(validateRoulette の `!== false` と逆向き)。
    enabled: c.enabled === true,
    target: c.target === 'all' ? 'all' : 'first',
    label: label !== '' ? label : d.label,
    segments: sanitizeRouletteSegments(c.segments) ?? structuredClone(d.segments),
    direction: c.direction === 'sub' ? 'sub' : 'add',
    patterns: sanitizeRoulettePatterns(c.patterns),
    // 上書きが無ければキーごと出さない(validateRoulette と同じ規約)。
    ...(sound ? { sound } : {}),
  };
}

/** 登録できる指定コメント規則の上限件数。設定UIと settings.json の現実的な上限。 */
export const COMMENT_RULES_MAX = 20;

/**
 * 指定コメント妨害規則の検証。既存流儀どおり throw せずサニタイズする。
 * 非配列(旧 settings.json のキー無し含む)は空 = 機能オフへ。keyword は trim して
 * 原文のまま保存する(小文字化しない — 日本語の表示をそのまま出す。比較は
 * matchCommentRule が toLowerCase で行う)。amount 0 以下・非有限の行は捨てる —
 * 「一致しても何も起きない行」を残すと設定画面で無反応の原因が見えなくなる。
 */
function validateCommentRules(raw: unknown): ChallengeCommentRule[] {
  if (!Array.isArray(raw)) return [];
  const out: ChallengeCommentRule[] = [];
  for (const r of raw.slice(0, COMMENT_RULES_MAX) as Array<Partial<ChallengeCommentRule>>) {
    if (!r || typeof r !== 'object' || typeof r.id !== 'string') continue;
    if (typeof r.keyword !== 'string') continue;
    if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) continue;
    const amount = Math.min(999_999, Math.round(r.amount));
    if (amount <= 0) continue;
    out.push({ id: r.id, keyword: r.keyword.trim(), amount });
  }
  return out;
}

/**
 * コメント → 妨害規則の写像。**部分一致・上から先勝ち**(giftRules と同じ規約)。
 * 大文字小文字は無視する(英字キーワード用 — 日本語には影響しない)。
 * 戻り null は「このコメントでは何も起きない」。
 *
 * ⚠ `keyword !== ''` は外さないこと。`''.includes()` は常に true なので、空欄の
 * 規則が全コメントを拾ってしまう(matchGiftTrigger と同じ罠)。
 */
export function matchCommentRule(cfg: ChallengeConfig, content: string): ChallengeCommentRule | null {
  const t = content.toLowerCase();
  for (const r of cfg.commentRules) {
    if (r.keyword !== '' && t.includes(r.keyword.toLowerCase())) return r;
  }
  return null;
}

/** スロットごとに既知の簡易演出 id か 'off' だけを通し、それ以外は既定に戻す。 */
function validateMiniFx(raw: unknown): Record<ChallengeSeSlot, string> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_MINI_FX };
  for (const slot of CHALLENGE_SE_SLOTS) {
    const v = src[slot];
    if (typeof v === 'string' && (v === 'off' || CHALLENGE_MINI_IDS.includes(v))) out[slot] = v;
  }
  return out;
}

/** スロットごとに既知の音 id か 'off' だけを通し、それ以外は既定に戻す。 */
function validateSeSounds(raw: unknown): Record<ChallengeSeSlot, string> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SE_SOUNDS };
  for (const slot of CHALLENGE_SE_SLOTS) {
    const v = src[slot];
    if (typeof v === 'string' && (v === 'off' || CHALLENGE_SE_SOUND_IDS.includes(v))) {
      out[slot] = v;
    }
  }
  return out;
}

/** スロットごとに 0-100 の数値だけを通す。欠損・非数値・範囲外は既定(100)へ。 */
function validateSeVolumes(raw: unknown): Record<ChallengeSeSlot, number> {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SE_VOLUMES };
  for (const slot of CHALLENGE_SE_SLOTS) {
    const v = src[slot];
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[slot] = Math.min(100, Math.max(0, Math.round(v)));
    }
  }
  return out;
}

function isValidRule(r: unknown): r is ChallengeGiftRule {
  const x = r as Partial<ChallengeGiftRule> | null | undefined;
  return (
    !!x &&
    typeof x === 'object' &&
    typeof x.id === 'string' &&
    (x.mode === 'fixed' || x.mode === 'perDiamond') &&
    typeof x.amount === 'number' &&
    Number.isFinite(x.amount)
  );
}

/**
 * ギフト → 増減量の写像。diamonds は normalize.ts が一度だけ計算した値を
 * そのまま使う(再計算禁止の全体規約)。戻り null は「このギフトは無視」。
 */
export function matchGiftRule(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; diamonds: number }
): { amount: number; flash: boolean } | null {
  const overFlash = cfg.flashMinDiamonds != null && g.diamonds >= cfg.flashMinDiamonds;
  for (const r of cfg.giftRules) {
    const hit =
      (r.canonical != null && r.canonical === g.canonical) ||
      (r.giftId != null && r.giftId === g.giftId) ||
      (r.canonical == null && r.giftId == null && r.minDiamonds != null && g.diamonds >= r.minDiamonds);
    if (!hit) continue;
    const amount = r.mode === 'perDiamond' ? Math.round(g.diamonds * r.amount) : r.amount;
    return { amount, flash: r.flash === true || overFlash };
  }
  if (cfg.giftDefault) {
    const amount =
      cfg.giftDefault.mode === 'perDiamond'
        ? Math.round(g.diamonds * cfg.giftDefault.amount)
        : cfg.giftDefault.amount;
    if (amount === 0 && !overFlash) return null;
    return { amount, flash: overFlash };
  }
  // 規則が空でも高額ギフトの照明だけは出す。
  return overFlash ? { amount: 0, flash: true } : null;
}

/**
 * ルーレットのトリガーギフト判定。
 *
 * ⚠ ライブ経路では NormalizedEvent.canonical が未代入(normalize.ts は名寄せ結果を
 * イベントに載せない)なので **giftId 一致が本線**。giftName の部分一致は TikTok 側の
 * ID 変更への保険、canonical 一致はリプレイ/テスト経路用の補助。
 */
export function matchRouletteTrigger(
  rl: ChallengeRouletteConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): boolean {
  return matchGiftTrigger(rl, g);
}

/**
 * giftId / giftName / canonical の3段マッチ。ルーレットのトリガー判定と
 * ファンスタンプ(お助け)の判定で共有する唯一の出所。
 *
 * ⚠ 3つとも '' の設定は**どのギフトにも一致しない**。''.includes() が常に true に
 * なる罠(空欄の設定が全ギフトを拾う)を塞ぐガードなので、各行の `!== ''` は外さない。
 *
 * `exactName` は giftName の段にだけ効く追加規約(既定 = 省略 = 従来の部分一致)。
 * **これを持つのは giftFullCut の行だけ**で、ルーレット(ChallengeRouletteConfig)と
 * ファンスタンプ(FanStampConfig)の型にはこのキーが無い。つまり両者では常に
 * undefined となり部分一致のまま — 構造的に巻き込み事故が起きない。
 * 名前判定をここに集約したままにするのが肝で、matchGiftFullCut 側に別実装を
 * 生やすと 3段の評価順と `!== ''` ガードが2箇所に分裂する(この関数が「唯一の
 * 出所」である理由そのもの)。
 */
export function matchGiftTrigger(
  t: { giftId: string; giftName: string; canonical: string; exactName?: boolean },
  g: { canonical?: string; giftId: string; giftName?: string }
): boolean {
  if (t.giftId !== '' && t.giftId === g.giftId) return true;
  if (t.canonical !== '' && g.canonical != null && t.canonical === g.canonical.toLowerCase()) return true;
  if (t.giftName !== '' && g.giftName != null) {
    const name = g.giftName.toLowerCase();
    // trim は完全一致の段だけ。設定値は validate で trim+小文字化済みなので、
    // 部分一致(includes)の結果はこの分岐を足しても1ビットも変わらない。
    if (t.exactName === true ? name.trim() === t.giftName : name.includes(t.giftName)) return true;
  }
  return false;
}

/**
 * ギフト → ルーレット行の写像。**上から順に評価し、最初に一致した1件だけ**を返す
 * (giftRules と同じ先勝ち)。enabled でない行は飛ばす。
 * 戻り null は「このギフトではルーレットを回さない」= 通常のギフト規則へ落ちる。
 */
export function matchRoulette(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): ChallengeRouletteConfig | null {
  for (const rl of cfg.roulettes) {
    if (!rl.enabled) continue;
    if (matchGiftTrigger(rl, g)) return rl;
  }
  return null;
}

/**
 * ギフト → ファンスタンプ(お助け)行の写像。**ルーレット・giftRules・giftDefault の
 * どれよりも先に評価し、一致したらそれらを一切評価しない**(二重適用防止 —
 * matchRoulette がルーレットで果たしているのと同じ役割)。
 * 戻り null は「このギフトはお助けではない」= 従来のギフト経路へ落ちる。
 *
 * 単一設定だが戻り値を boolean にしない — 将来 fanStamp を配列化しても
 * 呼び出し側(worker/challenge.ts)のコードが変わらないようにするため。
 */
export function matchFanStamp(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): FanStampConfig | null {
  const fs = cfg.fanStamp;
  if (!fs.enabled) return null;
  return matchGiftTrigger(fs, g) ? fs : null;
}

/**
 * ギフト → タップブースト行の写像。**上から順に評価し、最初に一致した1行だけ**を
 * 返す(giftFullCut / roulettes と同じ先勝ち)。**fanStamp の次・ルーレットより先**に
 * 評価し、一致したら増減規則(roulettes/giftRules/giftDefault)を一切評価しない。
 * 同じ giftId を fanStamp と両方に登録した誤設定では fanStamp が勝つ
 * (呼び出し側が fs 一致時は評価しない)。
 *
 * 無効な行は飛ばすだけで**下の行の評価は続ける** — 上の行を一時的に切って
 * 下の行を試す、が設定画面の自然な操作なので。クリップが全部 'off' の行は
 * 飛ばさない(暗幕+カウンタだけのフィーバーは正当な設定)。
 */
export function matchTapBoost(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): TapBoostRule | null {
  const tb = cfg.tapBoost;
  if (!tb.enabled) return null;
  for (const r of tb.rules) {
    if (!r.enabled) continue;
    if (matchGiftTrigger(r, g)) return r;
  }
  return null;
}

/**
 * ギフト → お邪魔(タップ封じ)行の写像。**上から順に評価し、最初に一致した1行だけ**を
 * 返す(tapBoost / giftFullCut / roulettes と同じ先勝ち)。**fanStamp・tapBoost の次・
 * ルーレットより先**に評価し、一致したら増減規則(roulettes/giftRules/giftDefault)を
 * 一切評価しない。
 *
 * tapBoost より後ろなのは意図的 — 同じ giftId を両方に登録した誤設定では「ブーストが
 * 勝つ」ほうが安全側だから(封印が勝つと配信者のボタンが死ぬ)。
 *
 * 無効な行は飛ばすだけで**下の行の評価は続ける**(matchTapBoost と同じ)。
 */
export function matchTapLock(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): TapLockRule | null {
  const tl = cfg.tapLock;
  if (!tl.enabled) return null;
  for (const r of tl.rules) {
    if (!r.enabled) continue;
    if (matchGiftTrigger(r, g)) return r;
  }
  return null;
}

/**
 * ギフト → 革命行の写像。**上から順に評価し、最初に一致した1行だけ**を返す
 * (tapBoost / tapLock と同じ先勝ち)。**fanStamp・tapBoost の次・tapLock より先**に
 * 評価し、一致したら増減規則(roulettes/giftRules/giftDefault)を一切評価しない。
 *
 * tapBoost より後ろなのは matchTapLock と同じ理由 — 同じ giftId を両方に登録した
 * 誤設定では「フィーバーが勝つ」ほうが分かりやすい(どちらもタップ倍率系で、
 * フィーバーの方が大きな山場)。tapLock より先なのは、同時登録の誤設定で
 * 「お助けが封印に食われる」のを避けるため(お助けが勝つほうが配信者に優しい)。
 *
 * **これは「どちらの機能が発動するか」の話**で、走行中のタップの扱いとは別軸。
 * 発動後に封印が掛かった場合は**封じが勝つ**(2026-08-20 ユーザー決定 —
 * press() の革命窓分岐が tapLock 分岐より下に居る)。
 *
 * 無効な行は飛ばすだけで**下の行の評価は続ける**(matchTapBoost と同じ)。
 */
export function matchRevolution(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): RevolutionRule | null {
  const rv = cfg.revolution;
  if (!rv.enabled) return null;
  for (const r of rv.rules) {
    if (!r.enabled) continue;
    if (matchGiftTrigger(r, g)) return r;
  }
  return null;
}

/**
 * お題ルーレットのトリガー判定。matchRevolution と同じ先勝ち。評価順は
 * **revolution の次・tapLock より先**(worker の gift 分岐)— 同じ giftId を
 * 両方に登録した誤設定では革命が勝つ(先に登録された大技を尊重)。
 * お題は空(prompts 0件)でも一致は返す — 不発の診断は worker 側(giftDiag)で
 * 出す(ここで握りつぶすと「設定したのに無反応」の原因が追えない)。
 */
export function matchQuiz(
  cfg: ChallengeConfig,
  g: { canonical?: string; giftId: string; giftName?: string }
): QuizRule | null {
  const q = cfg.quiz;
  if (!q.enabled) return null;
  for (const r of q.rules) {
    if (!r.enabled) continue;
    if (matchGiftTrigger(r, g)) return r;
  }
  return null;
}

/**
 * 投票コメントの判定。matchCommentRule と同じ「小文字化して部分一致」。
 * **good/bad の両方に一致したら無効票(null)** — 「よかったけどだめ」のような
 * 曖昧票を数えないための設計判断。どちらにも一致しなければ null(投票ではない
 * 通常コメントとして下流へ流す)。
 */
export function judgeQuizVote(
  goodWords: readonly string[],
  badWords: readonly string[],
  content: string
): 'good' | 'bad' | null {
  const c = content.toLowerCase();
  // 空文字ワードは何にでも一致する(''.includes 罠)ので弾く — validate 側でも
  // 除去しているが、判定の唯一の実装として自衛する。
  const good = goodWords.some((w) => w !== '' && c.includes(w.toLowerCase()));
  const bad = badWords.some((w) => w !== '' && c.includes(w.toLowerCase()));
  if (good && bad) return null;
  return good ? 'good' : bad ? 'bad' : null;
}

/** matchStampTriggers の結果。1メッセージ内の一致スタンプを合算した値。 */
export interface StampTriggerMatch {
  /** 一致した全スタンプの増減合計(符号込み)。 */
  amount: number;
  /** 一致したスタンプの個数(バナーの ×N)。 */
  count: number;
  /** StampTriggerConfig.flash(一致が1つでもあれば設定値をそのまま)。 */
  flash: boolean;
}

/**
 * チャットスタンプ(サブスクエモート)の判定。1メッセージに複数スタンプが載るので
 * boolean ではなく**合算結果**を返す — 同じスタンプ2連打(emoteIds に同じ id が
 * 2回)は2個ぶん数える。行は emoteId 完全一致・上から先勝ち(同じ emoteId を
 * 2行に書いた誤設定では上の行の量が勝つ)。一致ゼロは null。
 */
export function matchStampTriggers(
  cfg: ChallengeConfig,
  emoteIds: readonly string[] | undefined
): StampTriggerMatch | null {
  const c = cfg.stampTriggers;
  if (!c.enabled || c.rules.length === 0) return null;
  if (!emoteIds || emoteIds.length === 0) return null;
  let amount = 0;
  let count = 0;
  for (const id of emoteIds) {
    if (id === '') continue;
    const r = c.rules.find((x) => x.enabled && x.emoteId !== '' && x.emoteId === id);
    if (!r) continue;
    amount += r.amountEach;
    count += 1;
  }
  return count === 0 ? null : { amount, count, flash: c.flash };
}

/**
 * ルーレット見出しの文言。回転パネル(RouletteFx)・確定バナー・盤面なしの
 * フォールバックバナーの3箇所で同じ文にするための唯一の出所。
 *
 * 「ハートミー ○○がルーレット」— 前置きは設定側の label。TikTok から届く実名は
 * 'Heart Me' のような英語のことがあり、それでは日本語表記にならないため label が主。
 * label が空なら実名(giftName)、それも無ければ前置きなしで「○○がルーレット」。
 *
 * &lt;b&gt; でニックネームを括る都合で1本の文字列にはできないので、前後の2片で返す。
 * prefix は末尾に区切りの空白を含む(suffix は先頭空白なし)。
 */
export function rouletteHeadline(e: {
  rouletteLabel?: string;
  giftName?: string;
  // ChallengeEffect は 'add' をキーごと省くが、設定画面や RouletteFx は明示的に
  // 'add' を持つので両方受ける。判定は 'sub' の一致だけなので意味は変わらない。
  rouletteDirection?: 'add' | 'sub';
}): {
  prefix: string;
  suffix: string;
} {
  const name = (e.rouletteLabel ?? '').trim() || (e.giftName ?? '').trim();
  return {
    prefix: name !== '' ? `${name} ` : '',
    // 減らす(応援)の行は「お助け」を名乗る。**結果は漏れない** — 出目は
    // sanitizeRouletteSegments が 1 以上へ clamp するので sub の行では全マスが
    // 必ず負で、どのマスが当たりかとは無関係(RouletteFx.tsx のアンチリーク節参照)。
    suffix: e.rouletteDirection === 'sub' ? 'がルーレットでお助け!' : 'がルーレット',
  };
}

/**
 * 重み付き抽選。rand は 0 <= r < 1(テストでは固定値を注入)。
 * weight 0 の行は選ばれない。全 weight 0 は validateRoulette が既定に戻すので
 * ここでは想定外だが、念のため最後の行へ倒す(-1 を返してクラッシュ源を作らない)。
 */
export function drawRouletteIndex(segments: readonly ChallengeRouletteSegment[], rand: () => number): number {
  const total = segments.reduce((s, x) => s + Math.max(0, x.weight), 0);
  if (total <= 0) return segments.length - 1;
  let r = rand() * total;
  for (let i = 0; i < segments.length; i++) {
    const w = Math.max(0, segments[i]!.weight);
    if (w === 0) continue;
    r -= w;
    if (r < 0) return i;
  }
  // 浮動小数の端(r がちょうど 0 まで減り切らない)は weight > 0 の最後の行へ。
  for (let i = segments.length - 1; i >= 0; i--) if (segments[i]!.weight > 0) return i;
  return segments.length - 1;
}

/**
 * 当選 index の出現確率(0..1)。drawRouletteIndex と同じクランプ(負の weight は 0)。
 * パターン抽選の信頼度条件付け(roulette-fx.ts の drawRoulettePattern)に渡す。
 * 盤面が全滅(Σ<=0)なら 1 を返す — drawRouletteIndex の最終行フォールバックに
 * 偽の激アツ(rare 帯)を付けない。
 */
export function rouletteRarity(segments: readonly ChallengeRouletteSegment[], index: number): number {
  const total = segments.reduce((s, x) => s + Math.max(0, x.weight), 0);
  if (total <= 0) return 1;
  return Math.max(0, segments[index]?.weight ?? 0) / total;
}
