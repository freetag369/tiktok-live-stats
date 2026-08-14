/**
 * 全面カット素材のカタログ — **id / ラベル / 既定トリガーの唯一の出所**。
 *
 * ここ1箇所から次の4つが派生する。手で二重管理しないこと:
 *   - `CHALLENGE_FX_CLIP_IDS` の cut-* の並び(shared/challenge.ts)
 *   - `DEFAULT_GIFT_FULL_CUT.rules`(同上、`fullCutRuleFor` 経由)
 *   - `FX_CLIPS` の全面カット項目と `BAND_CLIP_IDS`(renderer/lib/fx.ts)
 *   - 設定移行が配る行(`migrateChallengeGiftFullCut`)
 *
 * このファイルは **素材を import しない**(URL 解決は renderer 側の責務)。
 * shared は node 環境の vitest と worker からも読まれるので、DOM も Vite の
 * import.meta.glob も使えない — 依存の向きは必ず renderer → shared に保つ。
 */

/** 全面カット素材1件。id はそのままファイル名(`assets/fx/cut/<id>.mp4`)。 */
export interface FullCutClipDef {
  /** クリップ id 兼ファイル名。`cut-` + ASCII スラッグ(`^cut-[a-z0-9-]+$`)。 */
  id: string;
  /** 設定画面のドロップダウン表示名。 */
  label: string;
  /** 既定行の表示名(日本語・原文のまま。小文字化しない)。 */
  ruleLabel: string;
  /**
   * 既定行の giftName(部分一致)。**小文字で書くこと** — matchGiftTrigger が
   * 設定値を小文字前提で比較する。日本語は toLowerCase が恒等なのでそのまま。
   *
   * 表記ゆれ・省略の恐れがあるギフト名は**短い部分文字列**にしてある
   * (例: ねば〜る君 → 'ねば'。「〜」は波ダッシュと全角チルダの2種があり、
   *  完全一致にすると環境によって外れる)。
   */
  giftName: string;
  /** 既定行の canonical(gift-aliases.default.json の名寄せ結果)。無ければ ''。 */
  canonical: string;
  /**
   * 既定行の exactName。**ギフト名が短く、他ギフトの部分文字列になりうる行だけ true**。
   * 例: 'tiktok' は「TikTok Universe」(44,999💎)にも部分一致してしまうので必須。
   */
  exactName: boolean;
}

/**
 * v0.5.0 で出荷した2行。**この配列は増やさない** — 設定移行の世代の印になっている。
 * exactName を false のままにしているのは出荷済みの挙動(「赤いバラの花束」にも当たる)を
 * 変えないため。
 */
export const FULL_CUT_CLIPS_V1: readonly FullCutClipDef[] = [
  { id: 'cut-rose', label: 'バラ', ruleLabel: 'バラ', giftName: 'バラ', canonical: 'rose', exactName: false },
  { id: 'cut-rosa', label: 'ローザ', ruleLabel: 'ローザ', giftName: 'ローザ', canonical: '', exactName: false },
];

/**
 * v0.6.0(SETTINGS_VERSION 3)で追加した40行。**設定移行が配るのはこの配列だけ** —
 * `DEFAULT_GIFT_FULL_CUT.rules` を参照すると、次の世代で既定が増えたときに
 * v3 の段が新しい行まで配ってしまい二重適用になる。
 *
 * 参照画像は `IMAGE/20260814/WS0005xx.JPG`(TikTok ギフト一覧のスクリーンショット)。
 * 40行 × 既存上位ギフト名で部分一致の全対全衝突を検査済み — 衝突は tiktok の1件だけで、
 * それは exactName で塞いである(回帰テスト: test/unit/fx-catalog.spec.ts)。
 */
export const FULL_CUT_CLIPS_V3: readonly FullCutClipDef[] = [
  { id: 'cut-subarashii', label: '素晴らしい', ruleLabel: '素晴らしい', giftName: '素晴らしい', canonical: '', exactName: false },
  { id: 'cut-mini-hanabi', label: 'ミニ花火', ruleLabel: 'ミニ花火', giftName: 'ミニ花火', canonical: '', exactName: false },
  { id: 'cut-neko-ashi', label: '猫の足', ruleLabel: '猫の足', giftName: '猫の足', canonical: '', exactName: false },
  // ⚠ 'tiktok' は「TikTok Universe」「TikTok Stars」の部分文字列。完全一致必須。
  { id: 'cut-tiktok', label: 'TikTok', ruleLabel: 'TikTok', giftName: 'tiktok', canonical: '', exactName: true },
  // ⚠ 2文字の英字は将来のギフト名に埋もれやすいので予防的に完全一致。
  { id: 'cut-gg', label: 'GG', ruleLabel: 'GG', giftName: 'gg', canonical: '', exactName: true },
  { id: 'cut-shoken', label: '初見です', ruleLabel: '初見です', giftName: '初見', canonical: '', exactName: false },
  { id: 'cut-hakushu', label: '拍手', ruleLabel: '拍手', giftName: '拍手', canonical: '', exactName: false },
  { id: 'cut-daisuki', label: '大好き', ruleLabel: '大好き', giftName: '大好き', canonical: '', exactName: false },
  { id: 'cut-soft-cream', label: 'ソフトクリーム', ruleLabel: 'ソフトクリーム', giftName: 'ソフトクリーム', canonical: '', exactName: false },
  { id: 'cut-uchiwa', label: 'うちわ', ruleLabel: 'うちわ', giftName: 'うちわ', canonical: '', exactName: false },
  { id: 'cut-yakyu', label: '野球', ruleLabel: '野球', giftName: '野球', canonical: '', exactName: false },
  { id: 'cut-love-letter', label: 'ラブレター', ruleLabel: 'ラブレター', giftName: 'ラブレター', canonical: '', exactName: false },
  { id: 'cut-ai-no-kaori', label: '愛の香り', ruleLabel: '愛の香り', giftName: '愛の香り', canonical: '', exactName: false },
  { id: 'cut-finger-heart', label: 'フィンガーハート', ruleLabel: 'フィンガーハート', giftName: 'フィンガーハート', canonical: 'finger_heart', exactName: false },
  { id: 'cut-nyao', label: 'ニャオ', ruleLabel: 'ニャオ', giftName: 'ニャオ', canonical: '', exactName: false },
  { id: 'cut-yell', label: 'エール', ruleLabel: 'エール', giftName: 'エール', canonical: '', exactName: false },
  { id: 'cut-honki', label: '本気', ruleLabel: '本気', giftName: '本気', canonical: '', exactName: false },
  { id: 'cut-omamori', label: 'おまもり', ruleLabel: 'おまもり', giftName: 'おまもり', canonical: '', exactName: false },
  // ⚠ 「ねば〜る君」の「〜」は波ダッシュ/全角チルダの表記ゆれがあるので短く取る。
  { id: 'cut-nebaaru', label: 'ねば〜る君', ruleLabel: 'ねば〜る君', giftName: 'ねば', canonical: '', exactName: false },
  { id: 'cut-fukka', label: 'ふっかちゃん', ruleLabel: 'ふっかちゃん', giftName: 'ふっか', canonical: '', exactName: false },
  { id: 'cut-udon-no', label: 'うどん脳', ruleLabel: 'うどん脳', giftName: 'うどん脳', canonical: '', exactName: false },
  { id: 'cut-ice-bar', label: 'アイスバー', ruleLabel: 'アイスバー', giftName: 'アイスバー', canonical: '', exactName: false },
  { id: 'cut-journey-pass', label: 'ジャーニーパス', ruleLabel: 'ジャーニーパス', giftName: 'ジャーニーパス', canonical: '', exactName: false },
  { id: 'cut-oshi-shosan', label: '推しへの称賛', ruleLabel: '推しへの称賛', giftName: '推しへの称賛', canonical: '', exactName: false },
  { id: 'cut-kosui', label: '香水', ruleLabel: '香水', giftName: '香水', canonical: 'perfume', exactName: false },
  // ⚠ 「G.O.A.T.バスカー」はドットの有無が揺れうるので後半だけ取る。
  { id: 'cut-goat-busker', label: 'G.O.A.T.バスカー', ruleLabel: 'G.O.A.T.バスカー', giftName: 'バスカー', canonical: '', exactName: false },
  { id: 'cut-donut', label: 'ドーナッツ', ruleLabel: 'ドーナッツ', giftName: 'ドーナッツ', canonical: '', exactName: false },
  { id: 'cut-tensai', label: '天才', ruleLabel: '天才', giftName: '天才', canonical: '', exactName: false },
  { id: 'cut-boshi-hige', label: '帽子と口ひげ', ruleLabel: '帽子と口ひげ', giftName: '帽子と口ひげ', canonical: '', exactName: false },
  { id: 'cut-utau-kinoko', label: '歌うキノコ', ruleLabel: '歌うキノコ', giftName: '歌うキノコ', canonical: '', exactName: false },
  { id: 'cut-pearl-chime', label: 'パールチャイム', ruleLabel: 'パールチャイム', giftName: 'パールチャイム', canonical: '', exactName: false },
  { id: 'cut-flower-melody', label: 'フラワーメロディ', ruleLabel: 'フラワーメロディ', giftName: 'フラワーメロディ', canonical: '', exactName: false },
  { id: 'cut-groove-guitar', label: 'グルーヴギター', ruleLabel: 'グルーヴギター', giftName: 'グルーヴギター', canonical: '', exactName: false },
  // ⚠ スクショで名前が省略されていた(「フィエスタアコーディ…」)ので短く取る。
  { id: 'cut-fiesta-accordion', label: 'フィエスタアコーディオン', ruleLabel: 'フィエスタアコーディオン', giftName: 'フィエスタアコーディ', canonical: '', exactName: false },
  { id: 'cut-heart-pose', label: 'ハートポーズ', ruleLabel: 'ハートポーズ', giftName: 'ハートポーズ', canonical: '', exactName: false },
  { id: 'cut-hand-heart', label: 'ハンドハート', ruleLabel: 'ハンドハート', giftName: 'ハンドハート', canonical: 'hand_hearts', exactName: false },
  // ⚠ 「ミシカ ベア」は空白の有無が揺れうるので前半だけ取る。
  { id: 'cut-mischka-bear', label: 'ミシカベア', ruleLabel: 'ミシカベア', giftName: 'ミシカ', canonical: '', exactName: false },
  { id: 'cut-cracker', label: 'クラッカー', ruleLabel: 'クラッカー', giftName: 'クラッカー', canonical: '', exactName: false },
  { id: 'cut-koi-megane', label: '恋のメガネ', ruleLabel: '恋のメガネ', giftName: '恋のメガネ', canonical: '', exactName: false },
  { id: 'cut-tempo-flute', label: 'テンポフルート', ruleLabel: 'テンポフルート', giftName: 'テンポフルート', canonical: '', exactName: false },
];

/** 全42行。並び順がそのまま既定行の評価順(上から先勝ち)になる。 */
export const FULL_CUT_CLIPS: readonly FullCutClipDef[] = [...FULL_CUT_CLIPS_V1, ...FULL_CUT_CLIPS_V3];

/** 全面カットのクリップ id 一覧。CHALLENGE_FX_CLIP_IDS と BAND_CLIP_IDS の両方が spread する。 */
export const FULL_CUT_CLIP_IDS: readonly string[] = FULL_CUT_CLIPS.map((c) => c.id);
