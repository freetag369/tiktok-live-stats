/**
 * お助け(ファンスタンプ)バナーの合算 — 窓の長さと文言の決定ロジック。
 *
 * お助けはギフト1メッセージ = effect 1件なので、拍手のような 1 ダイヤの
 * カスタムギフトが続けて届くと `−1 ◯◯ がお助け!` のバナーが**別々に**流れる。
 * さらに実運用の設定では同じギフトに全面カットイン(5 秒)が割り当たっており、
 * 凍結明けに保留分が1件ずつ再生される作りなので「5秒カットイン × N 本 + バナー N 枚」
 * になっていた。これを「カットイン1本 + バナー1枚(合算)」に畳むための判断をここに置く。
 *
 * shared に置くのは fx-drain.ts / fx-floats.ts / fx-stage.ts / boost-start.ts と同じ理由 —
 * **レンダラのテスト環境がこのリポジトリに無い**(vitest は node 環境のみ、
 * tsconfig.node.json は src/renderer を含まない)ので、演出の決定ロジックは
 * 純関数として shared へ出し node のテストで固定する。
 *
 * 【値との関係】ここで畳むのは**見た目と音だけ**。値(this.value)・統計・
 * ランキング(touchParticipant)はイベントごとに今までどおり適用される
 * — worker/challenge.ts の fanStampCoalesceOp を参照。
 */

/**
 * 合算窓の**最小**長。`monitor.css` の `.float { animation: floatup 1.6s }` と同値で、
 * 「先頭の1枚が画面に出ているあいだ」を意味する。カットイン付きの場合は
 * 凍結期限(fxFreezeUntilMs)のほうが常に長いので worker が max() でそちらを採る。
 *
 * `shared/fx-stage.ts` の `BANNER_MS` と同値だが**依存しない** — あちらは
 * 「舞台(同時に1枚だけ出す)」の尺で、こちらは「合算する窓」。意味が別なので
 * 片方を変えてももう片方が追従してはいけない。CSS が両者の共通の権威。
 */
export const FAN_STAMP_FX_WINDOW_MS = 1600;

/**
 * バナーに並べる名前の最大人数。残りは「ほかN人」に畳む。
 *
 * 上限が要る理由は幅: `.float` は 260px × `--float-scale`(2) = 520px 固定で、
 * `.f-txt` は 25px × 2 = 50px。全角なら1行あたり約10文字しか入らない。
 */
export const FAN_STAMP_NAMES_MAX = 3;

/** 名前1つの最大表示文字数。超えたら末尾を `…` に詰める。 */
export const FAN_STAMP_NAME_CHARS = 8;

/**
 * 名前を「・」で連ねた総文字数の予算。`FAN_STAMP_NAMES_MAX` を満たしていても
 * これを超えるなら人数を減らす — 長い名前が3人並ぶと `.f-txt` の行クランプで
 * 「がお助け!」ごと**黙って消える**(旧実装が ellipsis で踏んだのと同じ壊れ方)。
 */
export const FAN_STAMP_NAMES_BUDGET = 14;

/** 合算バナーの表示名リストへ1件足す。既出(重複)なら何もしない。 */
export function mergeFanStampName(
  names: string[],
  name: string,
  max: number = FAN_STAMP_NAMES_MAX
): void {
  if (name === '' || names.length >= max || names.includes(name)) return;
  names.push(name);
}

/** バナーの文言を組むのに必要な情報だけを抜いた入力(ChallengeEffect の部分型)。 */
export interface FanStampBannerInput {
  amount: number;
  nickname?: string;
  giftCount?: number;
  fanStampNames?: string[];
  fanStampPeople?: number;
}

export interface FanStampBannerParts {
  /** 合算後の総増減。呼び出し側が符号付きに整形する。 */
  amount: number;
  /** 並べる名前(省略記号適用済み)。**必ず1件以上**。 */
  names: string[];
  /** 「ほかN人」の N。0 なら出さない。 */
  othersCount: number;
  /** 'がお助け!' / 'が妨害!' / 'がファンスタンプ!' */
  what: string;
  /** 総個数(`×N` の N)。1 以下なら出さない。 */
  giftCount: number;
  /** 2人以上ぶんを畳んだバナーか(CSS のレイアウト切り替えに使う)。 */
  multi: boolean;
}

/** 表示名を1つ詰める。`…` を足しても上限を超えないよう本体を1文字削る。 */
function clipName(name: string, max: number = FAN_STAMP_NAME_CHARS): string {
  // サロゲートペア(絵文字ニックネーム)を割らないよう配列化して数える。
  const cp = Array.from(name);
  return cp.length <= max ? name : `${cp.slice(0, Math.max(1, max - 1)).join('')}…`;
}

/**
 * お助けバナーの文言を決める唯一の実装。
 *
 * **1人ぶん(= 従来と同じ状況)では従来と完全に同じ結果を返す**のが最優先の契約 —
 * 合算が効かない設定・古い worker の effect・実演の▶ すべてが今までどおりに見える。
 */
export function fanStampBannerParts(e: FanStampBannerInput): FanStampBannerParts {
  const amount = e.amount;
  const what = amount < 0 ? 'がお助け!' : amount > 0 ? 'が妨害!' : 'がファンスタンプ!';
  const giftCount = Math.max(1, e.giftCount ?? 1);
  const people = Math.max(1, e.fanStampPeople ?? 1);
  const src = e.fanStampNames ?? (e.nickname != null && e.nickname !== '' ? [e.nickname] : []);

  // 1人ぶんは従来どおり(nickname をそのまま出す。長い名前の折り返しは .f-txt 任せ)。
  if (people <= 1 || src.length <= 1) {
    return {
      amount,
      names: [src[0] ?? e.nickname ?? ''],
      othersCount: 0,
      what,
      giftCount,
      multi: false,
    };
  }

  // 人数と文字数の**両方**で切る。予算で0人になっても必ず1人は残す。
  const names: string[] = [];
  let used = 0;
  for (const raw of src.slice(0, FAN_STAMP_NAMES_MAX)) {
    const n = clipName(raw);
    // 2人目以降は区切りの「・」も1文字として数える。
    const cost = Array.from(n).length + (names.length === 0 ? 0 : 1);
    if (names.length > 0 && used + cost > FAN_STAMP_NAMES_BUDGET) break;
    names.push(n);
    used += cost;
  }
  return {
    amount,
    names,
    othersCount: Math.max(0, people - names.length),
    what,
    giftCount,
    multi: true,
  };
}
