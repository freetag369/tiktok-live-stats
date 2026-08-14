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
   * 既定行の giftId(完全一致)。**実データで確認できた行だけ入れる。**
   * ギフト名はクライアントの言語で変わる(日本語UIでも配信イベントは英語名で届く)うえ、
   * **同名で別IDのギフトが実在する**(Hand Heart は 5660=ハートポーズ と 8343=ハンドハート の2つ)。
   * giftId だけがその2つを区別できるので、判明しているものは必ずここを埋める。
   * '' は「このアカウントで未受領のため未確認」— giftName の推定だけで当てにいく。
   */
  giftId: string;
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
  { id: 'cut-rose', label: 'バラ', ruleLabel: 'バラ', giftId: '5655', giftName: 'rose', canonical: 'rose', exactName: false },
  { id: 'cut-rosa', label: 'ローザ', ruleLabel: 'ローザ', giftId: '8913', giftName: 'rosa', canonical: '', exactName: false },
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
  { id: 'cut-subarashii', label: '素晴らしい', ruleLabel: '素晴らしい', giftId: '15232', giftName: 'awesome', canonical: '', exactName: false },
  // ⚠ 実受信で確認: giftId 134531 / 名前は 'Firework'(**単数形・"mini" は付かない**)。
  //   v3〜v5 の推定 'mini fireworks' は一度も一致しなかった。部分一致に戻すと
  //   「Fireworks Show」(5783, 1099💎)に誤爆するので完全一致必須。
  { id: 'cut-mini-hanabi', label: 'ミニ花火', ruleLabel: 'ミニ花火', giftId: '134531', giftName: 'firework', canonical: '', exactName: true },
  { id: 'cut-neko-ashi', label: '猫の足', ruleLabel: '猫の足', giftId: '', giftName: 'cat paw', canonical: '', exactName: false },
  // ⚠ 'tiktok' は「TikTok Universe」「TikTok Stars」の部分文字列。完全一致必須。
  { id: 'cut-tiktok', label: 'TikTok', ruleLabel: 'TikTok', giftId: '5269', giftName: 'tiktok', canonical: '', exactName: true },
  // ⚠ 2文字の英字は将来のギフト名に埋もれやすいので予防的に完全一致。
  { id: 'cut-gg', label: 'GG', ruleLabel: 'GG', giftId: '6064', giftName: 'gg', canonical: '', exactName: true },
  { id: 'cut-shoken', label: '初見です', ruleLabel: '初見です', giftId: '12202', giftName: 'nice to meet u', canonical: '', exactName: false },
  { id: 'cut-hakushu', label: '拍手', ruleLabel: '拍手', giftId: '231956', giftName: 'clap clap', canonical: '', exactName: false },
  { id: 'cut-daisuki', label: '大好き', ruleLabel: '大好き', giftId: '15231', giftName: 'love you so much', canonical: '', exactName: false },
  { id: 'cut-soft-cream', label: 'ソフトクリーム', ruleLabel: 'ソフトクリーム', giftId: '', giftName: 'ice cream cone', canonical: '', exactName: false },
  { id: 'cut-uchiwa', label: 'うちわ', ruleLabel: 'うちわ', giftId: '15563', giftName: 'fan', canonical: '', exactName: true },
  { id: 'cut-yakyu', label: '野球', ruleLabel: '野球', giftId: '7897', giftName: 'baseball', canonical: '', exactName: false },
  { id: 'cut-love-letter', label: 'ラブレター', ruleLabel: 'ラブレター', giftId: '14113', giftName: 'love letter', canonical: '', exactName: false },
  { id: 'cut-ai-no-kaori', label: '愛の香り', ruleLabel: '愛の香り', giftId: '919386', giftName: 'love in scent', canonical: '', exactName: false },
  { id: 'cut-finger-heart', label: 'フィンガーハート', ruleLabel: 'フィンガーハート', giftId: '5487', giftName: 'finger heart', canonical: '', exactName: false },
  { id: 'cut-nyao', label: 'ニャオ', ruleLabel: 'ニャオ', giftId: '', giftName: 'nyao', canonical: '', exactName: false },
  { id: 'cut-yell', label: 'エール', ruleLabel: 'エール', giftId: '12238', giftName: 'support', canonical: '', exactName: false },
  { id: 'cut-honki', label: '本気', ruleLabel: '本気', giftId: '13521', giftName: 'seriously', canonical: '', exactName: false },
  { id: 'cut-omamori', label: 'おまもり', ruleLabel: 'おまもり', giftId: '', giftName: 'omamori', canonical: '', exactName: false },
  // ⚠ 「ねば〜る君」の「〜」は波ダッシュ/全角チルダの表記ゆれがあるので短く取る。
  { id: 'cut-nebaaru', label: 'ねば〜る君', ruleLabel: 'ねば〜る君', giftId: '', giftName: 'ねば', canonical: '', exactName: false },
  { id: 'cut-fukka', label: 'ふっかちゃん', ruleLabel: 'ふっかちゃん', giftId: '', giftName: 'ふっか', canonical: '', exactName: false },
  { id: 'cut-udon-no', label: 'うどん脳', ruleLabel: 'うどん脳', giftId: '', giftName: 'うどん脳', canonical: '', exactName: false },
  { id: 'cut-ice-bar', label: 'アイスバー', ruleLabel: 'アイスバー', giftId: '', giftName: 'ice bar', canonical: '', exactName: false },
  { id: 'cut-journey-pass', label: 'ジャーニーパス', ruleLabel: 'ジャーニーパス', giftId: '', giftName: 'journey pass', canonical: '', exactName: false },
  { id: 'cut-oshi-shosan', label: '推しへの称賛', ruleLabel: '推しへの称賛', giftId: '', giftName: 'applause', canonical: '', exactName: false },
  { id: 'cut-kosui', label: '香水', ruleLabel: '香水', giftId: '5658', giftName: 'perfume', canonical: 'perfume', exactName: false },
  // ⚠ 「G.O.A.T.バスカー」はドットの有無が揺れうるので後半だけ取る。
  { id: 'cut-goat-busker', label: 'G.O.A.T.バスカー', ruleLabel: 'G.O.A.T.バスカー', giftId: '', giftName: 'busker', canonical: '', exactName: false },
  { id: 'cut-donut', label: 'ドーナッツ', ruleLabel: 'ドーナッツ', giftId: '5879', giftName: 'doughnut', canonical: '', exactName: false },
  { id: 'cut-tensai', label: '天才', ruleLabel: '天才', giftId: '13523', giftName: 'genius', canonical: '', exactName: false },
  { id: 'cut-boshi-hige', label: '帽子と口ひげ', ruleLabel: '帽子と口ひげ', giftId: '', giftName: 'hat and moustache', canonical: '', exactName: false },
  { id: 'cut-utau-kinoko', label: '歌うキノコ', ruleLabel: '歌うキノコ', giftId: '170506', giftName: 'singing mushroom', canonical: '', exactName: false },
  { id: 'cut-pearl-chime', label: 'パールチャイム', ruleLabel: 'パールチャイム', giftId: '', giftName: 'pearl chime', canonical: '', exactName: false },
  { id: 'cut-flower-melody', label: 'フラワーメロディ', ruleLabel: 'フラワーメロディ', giftId: '', giftName: 'flower melody', canonical: '', exactName: false },
  { id: 'cut-groove-guitar', label: 'グルーヴギター', ruleLabel: 'グルーヴギター', giftId: '', giftName: 'groove guitar', canonical: '', exactName: false },
  // ⚠ スクショで名前が省略されていた(「フィエスタアコーディ…」)ので短く取る。
  { id: 'cut-fiesta-accordion', label: 'フィエスタアコーディオン', ruleLabel: 'フィエスタアコーディオン', giftId: '', giftName: 'fiesta accordion', canonical: '', exactName: false },
  { id: 'cut-heart-pose', label: 'ハートポーズ', ruleLabel: 'ハートポーズ', giftId: '5660', giftName: '', canonical: '', exactName: false },
  { id: 'cut-hand-heart', label: 'ハンドハート', ruleLabel: 'ハンドハート', giftId: '8343', giftName: '', canonical: '', exactName: false },
  // ⚠ 「ミシカ ベア」は空白の有無が揺れうるので前半だけ取る。
  { id: 'cut-mischka-bear', label: 'ミシカベア', ruleLabel: 'ミシカベア', giftId: '', giftName: 'mischka', canonical: '', exactName: false },
  { id: 'cut-cracker', label: 'クラッカー', ruleLabel: 'クラッカー', giftId: '', giftName: 'party popper', canonical: '', exactName: false },
  { id: 'cut-koi-megane', label: '恋のメガネ', ruleLabel: '恋のメガネ', giftId: '19168', giftName: 'love glasses', canonical: '', exactName: false },
  { id: 'cut-tempo-flute', label: 'テンポフルート', ruleLabel: 'テンポフルート', giftId: '', giftName: 'tempo flute', canonical: '', exactName: false },
];

/** 全42行。並び順がそのまま既定行の評価順(上から先勝ち)になる。 */
export const FULL_CUT_CLIPS: readonly FullCutClipDef[] = [...FULL_CUT_CLIPS_V1, ...FULL_CUT_CLIPS_V3];

/** 全面カットのクリップ id 一覧。CHALLENGE_FX_CLIP_IDS と BAND_CLIP_IDS の両方が spread する。 */
export const FULL_CUT_CLIP_IDS: readonly string[] = FULL_CUT_CLIPS.map((c) => c.id);
