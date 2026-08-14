# 演出クリップの出典

カウントダウンチャレンジのモニター演出用に **AI 生成した映像素材**。

| 項目 | 値 |
|---|---|
| 生成サービス | Higgsfield (https://higgsfield.ai) |
| モデル | `seedance_2_5` (Seedance 2.5 / Bytedance)、mode = `t2v`(参照画像なし) |
| 生成日 | 2026-08-11 |
| 出力 | 1280×720 (16:9) / 24fps / H.264 / **音声トラック無し**(`generate_audio: false`) |
| 尺 | 4.04 秒(`achieved.mp4` のみ 6.04 秒) |

加工内容: **無し**。Higgsfield が返した mp4 をそのまま用途名へリネームして格納している。

> `gauge-strike.mp4` だけ諸元が違う(**2026-08-12 生成 / 1:1 の 960×960 / 4.04 秒 / 音声なし**)。
> これは全画面ではなく **7セグの実位置に正方形で重ねる**唯一のクリップだから。
> 縦ステージ(540×960)と横ステージ(1280×720)で数字の位置もゲージとの位置関係も
> 変わるため、16:9 の全画面素材だと `object-fit: cover` のクロップで当たった場所に
> 光が来ない。「ゲージから飛んで数字に当たる」の**飛翔部分は canvas エンジンが
> 実 DOM 座標で描き**(`monitor/fx/engine.ts` の `strike()`)、映像は中心で炸裂する
> 着弾だけを担当する。

> ライセンス: Higgsfield の生成物の利用条件は同サービスの利用規約(生成時のプラン: Plus)に従う。
> 本リポジトリは AGPL で配布されるため、**再配布前に規約上の再配布可否を必ず確認すること**。
> 同梱の効果音(`../se/`)は CC0 だが、こちらは CC0 ではない。

## 用途と対応スロット

演出スロット名は `src/shared/challenge.ts` の `CHALLENGE_SE_SLOTS` と揃えてある
(`gauge-full` だけは効果音スロットが無い、いいねゲージ満タン専用)。

| ファイル | スロット | 内容 | 基準色 |
|---|---|---|---|
| `press.mp4` | `press` | シアンの衝撃波リング + 小さな火花 | `--mon-blue` `#37b6ff` |
| `follow.mp4` | `follow` | 赤い警告バースト(フォロー妨害) | `#ff3b3b` |
| `like.mp4` | `like` | ピンクのハートが下から上へ吸い上がる | `--mon-pink` `#ff4fa0` |
| `gift-t1.mp4` | `gift-t1` | 小さく淡い金の輝き(控えめ) | `--gold` `#ffc542` |
| `gift-t2.mp4` | `gift-t2` | 金の中規模バースト + 金粉の降り | `--gold` `#ffc542` |
| `gift-t3.mp4` | `gift-t3` | 画面いっぱいの金の放射光条 | `--gold` `#ffc542` |
| `gift-t4.mp4` | `gift-t4` | 金の花火3連発 + 光条 + 金粉の豪雨 | `#ffc542` / `#fff3d0` |
| `achieved.mp4` | `achieved` | 白閃光 → 金の大輪が多段で炸裂(CLEAR 用・6秒) | `#fff3d0` / `#ffc542` |
| `gauge-full.mp4` | (いいねゲージ満タン) | マゼンタの衝撃波 + ハートの飛散 | `#ff4fa0` |
| `gauge-strike.mp4` | (着弾) | 白熱コア + マゼンタ衝撃波 + 放射クラック + ハートの破片 | `#ff4fa0` |
| `stock-full.mp4` | `stock-full`(いいねストック満杯) | エメラルドグリーンの衝撃波リング + 緑の火花の放射 | `#3dff9c` |

> `stock-full.mp4` は後日追加(**2026-08-12 生成** / 1280×720 / 4.04 秒 / 音声なし / `seedance_2_5` t2v)。
> ドットUI(`monitor.css` の `.lgs-dot`、`#3dff9c`)と canvas の2発目の弾(hue 140)に
> 色を合わせた緑版。`lib/fx.ts` は 0 件許容の glob で拾うため、このファイルを
> 削除してもビルドは壊れず `gauge-full.mp4` が代用される。

色は `styles/tokens.css` / `styles/monitor.css` の実値と、`monitor/fx/engine.ts` が使う
色相(press=200 / follow=0 / like=338 / gift=45 / gauge=330)に合わせてプロンプトで指定した。

## 使い方 — 必ず `mix-blend-mode: screen` で重ねる

Seedance 2.5 の出力は**アルファチャンネルを持たない**。そのため全クリップを
**純黒(#000000)背景に発光体だけ**という構成で生成してある。黒地に加算的に重ねれば黒が抜ける。
(例外: `band/*.mp4`・`cut/*.mp4`・`stock-cutin.mp4` は不透明フルフレーム素材 — screen 禁止で
`.fx-clip-opaque` を使う。各セクションの注意書きを参照。)

```css
.fx-clip {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  mix-blend-mode: screen; /* 必須 — 付けないと黒い矩形が UI を覆う */
}
```

これは canvas エンジンの光り物パスが `globalCompositeOperation: 'lighter'`
(`monitor/fx/engine.ts`)を使っているのと同じ理屈で、モニターの地色が `#000`
(`styles/monitor.css` の `body` / `.stage-viewport`)だから成立する。

検証済みの実測値: 各クリップ最終フレームの RGB 輝度は平均 0.0〜2.7 / 255。
黒はほぼ完全に抜ける。

### 既知の癖

- `gift-t2` / `gift-t4` / `like` は終端まで完全には減衰しきらず、最後に残光がある
  (最終フレームの最大輝度 98 / 198 / 116)。再生末尾で唐突に切れるのが気になる場合は、
  `<video>` に 0.3 秒ほどの CSS フェードアウトを掛ける。
- 実尺は 4.04 秒(`achieved` は 6.04 秒)だが、アプリ側の演出は 0.4〜1.6 秒。
  クリップは開始直後に発火して以降は黒なので、途中で `remove()` しても破綻しない。

## 生成プロンプト(全文)

再生成・調整のための記録。共通の末尾ガード(カメラ固定・文字/人物/透かしの禁止・
純黒背景・終端で黒へ戻る)は全プロンプトに付けてある。

### press.mp4
> Abstract VFX element. A single thin cyan-blue (#37B6FF) shockwave ring snaps outward from the exact center of the frame, expanding fast and thinning as it grows, with about a dozen tiny cyan sparks flicking outward alongside it and winking out. Crisp, quick, electric — a UI button-press impact. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The effect fires once near the start and fully decays — the frame returns to pure black and stays completely black.

### follow.mp4
> Abstract VFX element. A hard red (#FF3B3B) alarm burst detonates at the center of the frame: a bright red flash bloom, a fast expanding red shockwave ring, and about thirty red-hot sparks thrown radially outward that arc downward under gravity and burn out. Aggressive warning-siren energy, a hostile interference hit. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The effect fires once near the start and fully decays — the frame returns to pure black and stays completely black.

### like.mp4
> Abstract VFX element. A stream of glowing hot-pink (#FF4FA0) heart-shaped light particles rises from the lower center of the frame, swirling upward and converging toward the middle, each heart trailing a soft magenta glow and twinkling as it travels. Gentle and continuous flow rather than an explosion, like affection being poured in. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The effect fires once near the start and fully decays — the frame returns to pure black and stays completely black.

### gift-t1.mp4
初回生成は「小さなお礼」にならず本格的な花火になったため、花火を明示的に禁止して再生成した。

> Abstract VFX element, extremely small and subtle. A tiny puff of warm gold (#FFC542) pixie dust glints into existence at the exact center of the frame — just eight or ten individual fine sparkle points that twinkle, drift outward only a very short distance, and wink out. Think a single flick of a sparkler or a small dusting of glitter, occupying only the central twenty percent of the frame; the outer edges of the frame stay completely black the entire time. Absolutely NOT a firework: no explosion, no detonation, no radial spray of streaks, no expanding sphere of sparks, no shockwave, no burst. Minimal, quiet, delicate. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The sparkle appears near the start and fades out — the frame returns to pure black and stays completely black.

### gift-t2.mp4
> Abstract VFX element. A medium golden burst at the center of the frame: a warm gold (#FFC542) light flare blooms, about forty gold sparks fly radially outward with soft motion-blur trails and arc downward under gravity, and a handful of glowing gold foil flecks catch the light and drift down after them. Warm and rewarding. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The effect fires once near the start and fully decays — the frame returns to pure black and stays completely black.

### gift-t3.mp4
> Abstract VFX element. Twelve long golden (#FFC542) light rays sweep outward from the center of the frame like a starburst, rotating slowly, while a dense burst of gold sparks explodes through them and glowing gold foil confetti begins raining down through the frame. Rich and celebratory, filling most of the frame. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The effect fires once near the start and fully decays — the frame returns to pure black and stays completely black.

### gift-t4.mp4
> Abstract VFX element. A volley of three golden fireworks detonates in sequence — first at the center, then upper-left, then upper-right — each a white-hot core flashing into a wide sphere of gold (#FFC542) sparks with twinkling crackle trails, while a heavy shower of glowing gold foil confetti pours down through the whole frame and long warm-white (#FFF3D0) light rays sweep out from behind the bursts. Maximum spectacle, edge to edge. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The effect fires once near the start and fully decays — the frame returns to pure black and stays completely black.

### achieved.mp4
> Abstract VFX element, a grand victory finale. A blinding warm-white (#FFF3D0) flash blooms from the center of the frame into a huge golden starburst of long slowly rotating light rays, then three waves of golden fireworks detonate across the frame in sequence, each throwing thousands of twinkling gold (#FFC542) sparks, while dense glowing gold foil confetti and shimmering ribbon streamers rain down through the entire frame from top to bottom. Triumphant, maximum celebration, edge to edge. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The celebration peaks early, the confetti falls out of frame, and by the end the frame returns to pure black and stays completely black.

### gauge-full.mp4
> Abstract VFX element. A magenta-pink (#FF4FA0) energy burst detonates at the center of the frame: a bright pink shockwave ring snaps outward, about thirty hot-pink sparks fly radially with glowing trails, and ten glowing pink heart-shaped particles pop upward and arc back down. Punchy and sweet, a meter-full reward pop. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The effect fires once near the start and fully decays — the frame returns to pure black and stays completely black.

### stock-full.mp4

> VFX overlay element on a pure black background: a bright emerald green (#3dff9c) energy shockwave ring bursts outward from the center of the frame, with glowing green sparks and small light particles scattering radially, subtle green lens flare streaks, luminous neon glow, high contrast, only glowing light elements on solid black background, no text, no objects, no people, designed for screen blend mode compositing, fast punchy burst that decays smoothly

### gauge-strike.mp4

いいねゲージ満タンの弾が7セグに当たる瞬間。**下に本物の数字が透けている**ので、
文字・数字を出さない指定が他のクリップ以上に効いてくる。アプリ側のビートは 0.75 秒
なので「最初の1秒で減衰しきる」を明示した(素材の実尺は 4.04 秒だが、
`MonitorView` が 0.75 秒で `.out` を付けてフェードさせる)。

> Abstract VFX element. A single violent impact detonates at the exact center of the frame, as if something heavy slammed into that spot: a blinding white-hot core flashes, a hard magenta-pink (#FF4FA0) shockwave ring snaps outward and thins rapidly as it expands, a second fainter ring chases it, jagged radial cracks of hot-pink light shoot out from the point of impact, and about twenty glowing pink heart-shaped shards are thrown outward and tumble away, burning out as they fly. Violent, punchy, a direct hit landing. Locked-off static camera, no camera movement, centered composition. Additive glow on a pure black (#000000) background, high contrast, nothing else in frame: no text, no letters, no numbers, no logos, no watermark, no people, no objects, no background scenery. The effect fires once immediately at the very start and fully decays within the first second — the frame returns to pure black and stays completely black.

実測: 発光は 0〜1.1 秒でほぼ終わり、1.25 秒以降は最終フレームまで YMAX=18/255。
黒はほぼ完全に抜ける。音声トラック無し。

---

# ギフト別演出クリップ(`gift/` サブフォルダ)

最上位ギフト16種に、それぞれ専用の演出クリップを割り当てるための素材。
`tierForDiamonds` は 5000ダイヤ以上を一律 tier 4 に落とすため、
これらは放っておくと全部が同じ `gift-t4.mp4` を共有してしまう。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | Higgsfield / `seedance_2_5`(mode `t2v`、参照画像なし) |
| 生成日 | 2026-08-11 |
| 出力 | 1280×720 (16:9) / 24fps / H.264 / **音声トラック無し** / 各 5.04 秒 |

加工内容: **無し**(返却された mp4 をそのままリネームして格納)。

> ## ⚠️ 著作権について — 必ず読むこと
>
> これらは **TikTok 本家のギフト演出の再現ではない**。本家の演出は ByteDance の著作物であり、
> それを模倣・再現した映像は本リポジトリには一切含めていない。
>
> ここにあるのは各ギフトの**題材(龍・鳳凰・天馬・獅子・宮殿・鯨・銀河など)に合わせて
> 新規に生成した完全オリジナルの演出**。題材そのものは誰の独占物でもない。
> 将来クリップを差し替える場合も、本家演出を参照・模倣しないこと。
>
> 生成物の利用条件は Higgsfield の利用規約(生成時のプラン: Plus)に従う。CC0 ではない。
> AGPL でのソースzip再配布前に規約上の再配布可否を必ず確認すること。

## 対応表

ファイル名は名寄せ用の canonical と一致させてある。

| ファイル | ギフト | 演出 | 発光色 |
|---|---|---|---|
| `universe.mp4` | TikTok Universe | 白の特異点が渦巻銀河へ展開 | 紫 / シアン / 白 |
| `white_pegasus.mp4` | ホワイトペガサス | 銀白の天馬が翼を広げる | 銀白 / 淡青 |
| `fire_phoenix.mp4` | ファイアフェニックス | 炎の鳳凰が舞い上がり翼を開く | 赤 / 橙 / 金 |
| `whale_mirage.mp4` | 鯨と蜃気楼 | 鯨が横切り背後に金の蜃気楼 | 青緑 / 淡金 |
| `thunder_falcon.mp4` | サンダーファルコン | 稲妻の隼が翼を広げ放電 | 電光青 / 白 |
| `tiktok_stars.mp4` | TikTok Stars | 星形の光が渦を巻いて飛散 | シアン / マゼンタ |
| `seal_whale.mp4` | アザラシとクジラ | 2頭が並んで泳ぎ光の渦を曳く | 水色 / 白 |
| `adams_dream.mp4` | Adam's Dream | 光雲がひらき金の光芒が降りる | 金 / ラベンダー |
| `universe_plus.mp4` | TikTok Universe+ | 二重螺旋銀河(∞字)が全画面へ | 紫 / 金 / 白 |
| `lion_charge.mp4` | 獅子奮迅 | 炎の獅子頭が正面へ咆哮 | 金 / 橙 |
| `leon_lion.mp4` | レオンとライオン | 2頭の獅子が左右から跳んで衝突 | 金 / 琥珀 |
| `whale_sam.mp4` | クジラのサム | 鯨が跳ねて潮を吹き潜る | シアン / 白 |
| `lion.mp4` | ライオン | 金の獅子が咆哮、鬣が放射状に光る | 金 |
| `pegasus.mp4` | ペガサス | 金の天馬が前脚を上げ翼を打つ | 暖金 / 琥珀 |
| `palace.mp4` | 宮殿 | 光の線で宮殿が組み上がり黄金光を放つ | 金(線画光) |
| `dragon.mp4` | ドラゴン | 翡翠と金の龍が蛇行し金の火花を吐く | 翡翠緑 / 金 |

## 使い方

上の9本とまったく同じ。**`mix-blend-mode: screen` 必須**。

> ### 配置の制約(踏みやすい罠)
>
> `mix-blend-mode` は **最も近い祖先のスタッキングコンテキストの中でしか合成されない**。
> そのため `<video class="fx-clip">` は `.monitor-root` の直下に、**z-index を付けずに**置く。
>
> - `z-index:50` を持つ `.fx-layer` の内側に入れると、合成が `.fx-layer` 内で閉じて
>   **黒が抜けず UI が黒い矩形で覆われる**(実装時に一度踏んだ)。
> - `.monitor-root` に `z-index` / `opacity` / `filter` / `isolation` / `transform` を
>   足しても同じ理由で壊れる。`monitor.css` の `.monitor-root` に警告コメントあり。
>
> 現状は `.stage-scale`(`transform` でコンテキストを作る)が合成の境界になり、
> クリップはその配下の UI 全体と screen 合成される。
被写体は全て「自己発光する光で象られた姿」として生成しており、不透明な面や暗部を持たないので、
screen 合成しても幽霊のように透けず、演出中もカウントダウンの数字が下に見えたままになる。

検証済みの実測値: 各クリップ最終フレームの RGB 輝度は平均 0.0〜2.6 / 255。

### 既知の癖

- `lion_charge` / `whale_mirage` / `lion` / `pegasus` / `white_pegasus` / `universe_plus` /
  `fire_phoenix` / `seal_whale` は終端に残光がある(最終フレーム最大輝度 27〜249)。
  末尾で唐突に切れるのが気になる場合は `<video>` に 0.3 秒の CSS フェードアウトを掛ける。
- `adams_dream` は16本中もっとも拡散的で、中間調の光雲が画面中央下を広く覆う。
  他が「はっきりした被写体」なのに対しこれだけ雰囲気もの。差し替えるならここ。
- `seal_whale` の小さい方はアザラシというより仔鯨に見える。

## 名寄せ(組み込み時)

`resources/gift-aliases.default.json` の `nameRules` に canonical を追加する。
照合は **小文字化 → 完全一致 or 部分一致、先頭ルール勝ち**(`worker/store/apply.ts`)なので、
**具体的なルールほど先に置く**こと:

- `universe_plus` → `universe`(「TikTok Universe+」は「tiktok universe」を含む)
- `white_pegasus` → `pegasus`(「ホワイトペガサス」は「ペガサス」を含む)
- `leon_lion` → `lion`(「レオンとライオン」は「ライオン」を含む)
- 上記すべて → 既存の汎用 `tiktok` ルール(「TikTok Universe」「TikTok Stars」を飲み込む)

**英語名・他言語名は未確認**。獅子奮迅 / 鯨と蜃気楼 / アザラシとクジラ / クジラのサム の
他言語名は推測で書かず、実イベントの `gift_catalog` を見てから `match` に足すこと
(同ファイルの `_note` が「ギフト名は言語設定で変わる」と警告している)。

16種に当たらない高額ギフトは従来どおり `../gift-t4.mp4` がフォールバックとして残る。

## 生成プロンプト(全文)

全16本に共通の末尾ガード。**「不透明な面・暗部・陰影を作らせない」指定が screen 合成の肝**:

```
Locked-off static camera, no camera movement, centered composition. Everything is made of
self-luminous light on a pure black (#000000) background — no solid opaque surfaces, no dark or
mid-tone body, no shading, no rim lighting on a solid form: the shape is drawn entirely by
glowing particles, embers, filaments and light trails, so the black around and inside it stays
absolutely black. High contrast, nothing else in frame: no text, no letters, no numbers, no
logos, no watermark, no people, no real objects, no background scenery. The effect builds near
the start, peaks, and fully decays — the frame returns to pure black and stays completely black.
```

以下は各クリップ固有の前半部分(上のガードが後に続く)。

- **universe.mp4** — A vast cosmic event made purely of light. A brilliant white singularity flares at the center of the frame and blooms outward into a sweeping spiral galaxy of violet, cyan and white star-particles, trailing nebula filaments of light and showering thousands of twinkling stars across the frame.
- **white_pegasus.mp4** — A winged horse formed entirely from silver-white light particles gallops upward through the center of the frame and spreads its enormous glowing wings wide, each feather drawn as a streak of cold white and pale-blue light, scattering silver sparks from its hooves and wingtips.
- **fire_phoenix.mp4** — A phoenix formed entirely from fire rises through the center of the frame and unfurls vast burning wings, its body and every feather drawn as red, orange and gold flame filaments and flying embers, trailing a storm of glowing sparks that swirl upward.
- **whale_mirage.mp4** — An enormous whale formed from flowing aqua and teal light glides slowly across the frame from left to right, its silhouette drawn by drifting luminous particles and long ribbon-like light trails, while behind it a shimmering pale-gold mirage of rippling heat-haze light blooms and wavers.
- **thunder_falcon.mp4** — A falcon formed entirely from crackling electric-blue lightning dives through the center of the frame with its wings swept wide, its outline drawn by branching bolts and white-hot arcs, discharging jagged lightning and blue sparks outward in every direction.
- **tiktok_stars.mp4** — A dense cascade of cyan, magenta and white five-pointed star-shaped light particles bursts from the center of the frame and swirls outward in a wide spiral, each star twinkling and trailing a bright comet-like streak, filling the frame with sweeping arcs of starlight.
- **seal_whale.mp4** — A seal and a whale, both formed from soft aqua and white light particles, swim together in a gentle arc across the frame as if through water, trailing streams of luminous bubbles and rippling ribbons of pale blue light.
- **adams_dream.mp4** — A dreamlike bloom of warm gold and lavender light unfurls at the center of the frame: soft luminous clouds swell outward, a broad shaft of golden light descends through them, and thousands of tiny glowing motes drift slowly upward like a rising dream.
- **universe_plus.mp4** — The grandest cosmic finale made purely of light. A blinding white flash at the center collapses inward, then explodes into a colossal double-spiral galaxy of violet, gold and white star-particles that fills the entire frame edge to edge, with sweeping nebula light-rays, rings of orbiting stars, and an endless downpour of twinkling starlight.
- **lion_charge.mp4** — A lion's head formed entirely from roaring golden fire erupts toward the viewer at the center of the frame and roars, its mane drawn as hundreds of whipping flame filaments and flying embers that lash violently outward, radiating shockwaves of gold and orange light. Fierce and explosive.
- **leon_lion.mp4** — Two lions formed from golden and amber light leap toward each other from the left and right edges of the frame and meet at the center in a burst of light, their manes drawn as swirling luminous filaments and streaming sparks, throwing a wide spray of gold light outward on impact.
- **whale_sam.mp4** — A large friendly whale formed from bright cyan and white light particles rises gently from the bottom of the frame, arcs across the center and dives back down, trailing a long ribbon of luminous bubbles and blowing a tall spout of glittering white light from its blowhole.
- **lion.mp4** — A lion formed entirely from golden light strides forward at the center of the frame and roars, its mane drawn as radiating filaments of gold light that flare outward like a sunburst, scattering warm golden sparks in a wide halo around it. Noble and powerful.
- **pegasus.mp4** — A winged horse formed from warm gold light rears up at the center of the frame and beats its huge glowing wings, each feather a streak of amber and gold light, trailing golden sparks and a swirling cloud of luminous dust from its hooves.
- **palace.mp4** — A vast palace drawn purely in glowing golden line-light rises up from the bottom of the frame and assembles itself at the center — towers, arches, staircases and domes traced by bright filaments of gold light like a luminous blueprint drawing itself in the air — then flares and radiates a burst of golden rays and sparkles outward.
- **dragon.mp4** — An enormous eastern dragon formed entirely from jade-green and gold light coils through the frame in a long serpentine arc, its body drawn by flowing luminous filaments and flying embers, its whiskers and mane streaming light behind it, breathing a torrent of golden sparks toward the viewer.

> `palace.mp4` は初回投入時に Higgsfield からプリセット「IN THE DARK」を推薦されて弾かれた。
> `declined_preset_id` にそのプリセット id を渡して再投入すると通る。

---

# ダイヤ帯域カットイン(`band/` サブフォルダ)

ダイヤ数の帯域(1〜50 / 51〜100 / 101〜600 / 601〜1000+)で発火する
**パチンコ大当たり風の全画面カットイン**。再生中は worker がカウンタを凍結する
(`ChallengeEngine` の fxFreeze)。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | Higgsfield / `seedance_2_5`(mode `omni_reference`、参照画像あり) |
| 生成日 | 2026-08-12 |
| 出力 | 1280×720 (16:9) / 24fps / H.264 / **音声トラック無し** |
| 参照画像 | `IMAGE/IMG1〜4.jpg`(TikTok ギフト一覧のアイコン部分のスクリーンショット) |

| ファイル | 帯域 | モチーフ | 尺 |
|---|---|---|---|
| `gift-band1.mp4` | 1〜50💎 | びっくりした魚 | 6.04 秒 |
| `gift-band2.mp4` | 51〜100💎 | ハートポーズ | 6.04 秒 |
| `gift-band3.mp4` | 101〜600💎 | マネーガン | 8.04 秒 |
| `gift-band4.mp4` | 601💎〜 | 銀河 | 10.04 秒 |

加工内容: **無し**(返却された mp4 をそのままリネームして格納)。

> ## ⚠️ 他の全クリップと合成方法が違う — screen 禁止・`.fx-clip-opaque` 必須
>
> このフォルダの4本だけは**不透明フルフレーム**(黒背景発光体ではない)。
> 「画面全体に映す・パチンコのように派手」という要件のため、あえて画面を
> 覆う映像として生成してある。`mix-blend-mode: screen` を掛けると中間調が
> UI と混ざって濁るだけなので、`monitor.css` の `.fx-clip-opaque`
> (`mix-blend-mode: normal`)で重ねること。配置の制約(`.monitor-root` 直下・
> z-index なし)は `.fx-clip` と同じ。
>
> 尺の権威は素材ではなく設定(`giftBandFx.bands[].durationSec`)。`MonitorView` は
> `loop` を付けてタイマー(`fxDurationMs`)で打ち切るので、素材尺と設定秒数が
> 多少ズレても破綻しない。
>
> 著作権の注意は `gift/` と同じ — TikTok 本家のギフト演出の再現ではなく、
> アイコンの題材(魚・ハート・マネーガン・銀河)を参照した完全オリジナル。
> 生成物の利用条件は Higgsfield の利用規約に従う。CC0 ではない。

## 生成プロンプト(全文)

共通ガード: パチンコ大当たり風 / 冒頭は一瞬暗く立ち上げ / 終端は白金フラッシュ /
被写体は中央縦 1/3 に維持(縦ステージの `object-fit: cover` クロップ対策)/
文字・ロゴ禁止。各プロンプトは `omni_reference` でアイコン画像を参照している。

- **gift-band1.mp4** — Pachinko jackpot cut-in animation, opaque full-frame. The cute cartoon startled fish character from the reference image bursts into the center of the screen. Golden radial light rays, spark showers, and blue water splash particles swirling around the fish, comic speed lines, gold and cyan strobe edges. Ends with a bright white-gold flash.
- **gift-band2.mp4** — 同上のハートポーズ版(pink and gold radial rays, floating heart particles, confetti, rotating lens flares)。
- **gift-band3.mp4** — 同上のマネーガン版(explosive storm of golden banknotes and coins toward the camera, fireworks, camera shake, gold and green strobe edges)。
- **gift-band4.mp4** — 同上の銀河版・最高レア(swirling nebula arms, storms of golden shooting stars, massive firework volleys, lightning bolts, rotating god-rays, rainbow-and-gold strobe edges, multiple escalating explosion waves)。

# ストック着弾カットイン(`stock-cutin.mp4`)

いいねストック満杯の2発目(緑の弾)が7セグに**着弾した瞬間**から流す、
パチンコ大当たり風の5秒フルスクリーンカットイン。再生中はモニターが数字を
据え置き、終端で `revealStock`(ボーナス反映)が走る(`MonitorView.tsx` の
`STOCK_CUTIN_MS` 一式)。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | Higgsfield / `seedance_2_0`(mode `std`、参照画像あり `image_references`) |
| 生成日 | 2026-08-13 |
| 出力 | 1280×720 (16:9) / 24fps / H.264 / **AAC 音声トラックあり**(`generate_audio: true`) |
| 尺 | 5.06 秒(アプリ側は `STOCK_CUTIN_MS = 5000` のタイマーで打ち切り) |
| 参照画像 | ユーザー提供のフェニックスのイラスト(TikTok ギフト一覧アイコンのスクリーンショット) |

加工内容: **無し**(返却された mp4 をそのままリネームして格納)。

> 配色はストックUI(`monitor.css` の `.lgs-dot` `#3dff9c`、canvas 2発目の弾 hue 140)に
> 合わせた**エメラルドグリーン**。初回生成は参照画像そのままの赤で、ユーザー指示で
> 緑に再生成した(赤→緑の指定だけだと人型の天使に化けたため、プロンプトで
> 「strictly a bird / no humanoid」と鳥の解剖を明示している — 再生成時は必ず残すこと)。

> ## ⚠️ band/*.mp4 と同族 — screen 禁止・`.fx-clip-opaque` 必須・音声あり
>
> 不透明フルフレーム素材(黒背景発光体ではない)なので `mix-blend-mode: screen` 禁止。
> `.fx-clip-opaque` で重ねる。配置の制約(`.monitor-root` 直下・z-index なし)は同じ。
>
> **このクリップだけは音声を焼き込んである**(他は全部無音)。`MonitorView` は
> この `<video>` に限り muted を外し、音量を `seVolumes['stock-full']` に連動させる。
> 音声は終端 0.4 秒で無音まで減衰する構成(実測 RMS -47dB→-80dB)— 映像の
> `.out` フェード(`STOCK_CUTIN_FADE_MS = 400`)と揃えてある。
>
> このファイルを削除してもビルドは壊れない(`lib/fx.ts` の 0 件許容 glob)。
> 無ければモニターは従来のストック着弾(カットインなし)へフォールバックする。
>
> 著作権の注意は `gift/` / `band/` と同じ — TikTok 本家のギフト演出の再現ではなく、
> 題材(炎の鳳凰)を参照した完全オリジナル。生成物の利用条件は Higgsfield の
> 利用規約(生成時のプラン: Plus)に従う。CC0 ではない。

## 生成プロンプト(全文)

> A majestic phoenix BIRD made of roaring emerald-green fire, keeping exactly the same bird anatomy and silhouette as the creature in the reference image — a bird with a crested bird head and beak, two vast spread wings, and long flowing ribbon-like tail feathers — but recolored: every feather and flame burns in vivid emerald green (#3DFF9C), mint-green and white-hot green tones instead of red. Strictly a bird: no human, no humanoid figure, no angel, no woman, no face, no arms, no legs. The green fire phoenix bursts upward through the center of the frame and unfurls its vast burning wings in a triumphant pachinko-jackpot cut-in. Behind it, long pale-green and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of emerald and teal flame ripple outward to the edges of the frame, and thousands of glowing green embers and white-green sparks storm upward around the phoenix. The phoenix rears its bird head, wings fully spread at the climax, feathers drawn as emerald, mint and white-green flame filaments trailing green fire, its long tail feathers streaming below. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, action starting immediately from the first frame. The phoenix and the main action stay in the horizontal center of the frame (safe for a vertical center crop). Dynamic but centered composition, slight dramatic push-in. No text, no letters, no numbers, no logos, no watermark, no people. Audio: a dramatic rising orchestral jackpot fanfare with taiko-style impact hits as the wings spread, sizzling fire roar underneath, ending with the music and flames decaying toward silence in the final half second.

---

# mini/panic-man.webp — 簡易演出「絶望カットイン」の写真素材

このディレクトリで**唯一の写真素材**であり、唯一の映像でない素材。
簡易演出(`CHALLENGE_MINI_IDS` の `'panic'`、フォロー妨害の既定)で使う。

| 項目 | 値 |
|---|---|
| 元ファイル | `IMAGE/c4bf9a41-f05e-4160-b87f-3263de3c13a0.png`(リポジトリ外・ユーザー提供) |
| 元の諸元 | 1536×1024 / PNG / RGBA(アルファ未使用)/ 約 1.9MB |
| 格納形式 | 1024×682 / WebP q88(アルファあり)/ 約 97KB |
| 格納日 | 2026-08-13 |

加工内容:

1. `(190, 10)-(1350, 783)` で切り出し(顔と両手を主役にし、下の胴と外側の肘を落とす)。
   結果は 1160×773 ≒ 3:2 で、素材と箱の縦横比が一致する。
2. Lanczos で 1024×682 へ縮小。表示は最大でも 281 ステージpx 幅、
   4K モニターの拡大込みでも実ピクセル 850px 程度なので、これで頭打ち。
3. **楕円のアルファを焼き込み**(smoothstep + ガウスぼかし 12px)。
   元写真は「黒背景」ではなく「黒へ落ちるハロー」で、左右と下の辺に光が残っている。
   黒ステージにそのまま置くと矩形の切り口が見えるため、素材側で縁を溶かしてある。
   **CSS 側で `mask` や `border` を重ねないこと** — 二重にフェードして芯まで薄くなる。
4. WebP へ再エンコード。写真に PNG は不向き(1024px でも 1MB 超)で、
   アルファが要るので JPEG も使えない。`img-src 'self'` は WebP も同じく通る。

> ⚠️ **ライセンス未確認 — 再配布前に必ず出典と再配布可否を確認すること。**
> この写真は AI 生成物ではなく、**実在人物が写った写真**で、
> スタジオ撮影のストックフォトの特徴(均一なハロー・胴の切れ方・メタデータ無し)がある。
> 本リポジトリは AGPL で配布され、`scripts/make-source-archive.mjs` が
> ソース一式を同梱して配布する。ストックフォトのライセンスは
> **ソース同梱のような再配布を禁じているものが多い**。
> 出典と許諾が確認できるまで、この素材を含むビルドを配布しないこと。
> 差し替える場合は、同じパス・同じ 3:2・同じ縁のアルファ処理を施した WebP を置けば
> コード側の変更は不要。

---

# ダイヤの全面カット(`cut/` サブフォルダ)

**ギフトそのもの**(ギフト名 / giftId / canonical)で発火する、パチンコ大当たり風の
全画面カットイン。**ダイヤ数帯(`band/*.mp4`)より先に評価され、一致したら帯域は
再生しない**(`shared/challenge.ts` の `matchGiftFullCut` → `worker/challenge.ts` の
`giftOp`)。再生中は帯域と同じく worker がカウンタを凍結する(fxFreeze)。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | Higgsfield / `seedance_2_0`(mode `std`、参照画像あり `image_references`) |
| 生成日 | 2026-08-13 |
| 出力 | 1280×720 (16:9) / 24fps / H.264 / **AAC 音声トラックあり**(`generate_audio: true`) |
| 尺 | 各 5.06 秒(アプリ側は設定の `giftFullCut.rules[].durationSec` = 既定 5 秒で打ち切る) |
| 参照画像 | `IMAGE/daiya/S__108380176_0.jpg`(バラ)/ `S__108380177_0.jpg`(ローザ)— TikTok ギフト一覧アイコンのスクリーンショット |

| ファイル | 既定のトリガー | モチーフ | 尺 |
|---|---|---|---|
| `cut-rose.mp4` | giftId `5655` / giftName `rose` / canonical `rose` | 光沢のある3Dのバラ(ポップ・可愛い系) | 5.06 秒 |
| `cut-rosa.mp4` | giftId `8913` / giftName `rosa` | 深紅のベルベットのバラ(重厚・最高レア系) | 5.06 秒 |

> トリガーは初版で「バラ」「ローザ」という**日本語名**だったが、配信イベントの
> `giftName` は表示言語に関係なく英語で届くため実データへ寄せ直した(`settingsVersion` 4)。
> 詳細は下の「第2弾」の節を参照。バラだけは canonical `rose` を持っていたため
> 初版でも発火していた。

加工内容: **無し**(返却された mp4 をそのままリネームして格納)。

> ## ⚠️ band/*.mp4・stock-cutin.mp4 と同族 — screen 禁止・`.fx-clip-opaque` 必須・音声あり
>
> 不透明フルフレーム素材(黒背景発光体ではない)なので `mix-blend-mode: screen` 禁止。
> `.fx-clip-opaque` で重ねる。配置の制約(`.monitor-root` 直下・z-index なし)は同じ。
>
> **この2本は band/*.mp4 と同じ `<video>` 枠(`bandClip`)で再生されるが、音声だけが
> 違う。** band は無音素材で `assets/se/band/bgm-band*.mp3` を別に重ねるのに対し、
> こちらは音声を焼き込んである。分岐点は **`ChallengeEffect.fxFullCut`** ただ1つ:
> worker がこの印を載せ、`MonitorView` はその印があるときだけ `<video>` の `muted` を
> 外して音量を `giftFullCut.volume` に合わせる。**worker 側は `fxFullCut` の effect に
> `fxBandBgm` を載せない**(載せると mp4 の音と BGM が二重に鳴る)。
>
> 尺の権威は素材ではなく設定(`giftFullCut.rules[].durationSec`)。`MonitorView` は
> `loop` を付けてタイマーで打ち切る。**既定 5 秒 < 素材 5.06 秒なのでループはしない** —
> 設定で 6 秒以上にすると頭から再生し直すので、音楽も途中で鳴り直す点に注意。
>
> 著作権の注意は `gift/` / `band/` と同じ — TikTok 本家のギフト演出の再現ではなく、
> アイコンの題材(バラ)を参照した完全オリジナル。生成物の利用条件は Higgsfield の
> 利用規約(生成時のプラン: Plus)に従う。CC0 ではない。

## 生成プロンプト(全文)

共通ガード(`band/*.mp4` と同じ): パチンコ大当たり風 / 冒頭から即アクション /
終端は白金フラッシュ / 被写体は横方向の中央に維持 / 文字・ロゴ・人物禁止 /
末尾 0.5 秒で音楽を無音へ減衰(映像の `.out` フェード 400ms と揃えるため)。

- **cut-rose.mp4** — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. A glossy 3D cartoon rose exactly matching the reference image — a rounded spiral pink-and-crimson rose bloom with a smooth candy-like glossy surface, a green stem and two bright green leaves — bursts up into the center of the screen and blooms open in triumph, scaling up with a punchy elastic pop. Behind it, long pink and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of rose-pink and magenta light ripple outward to the edges of the frame; thousands of glowing pink petals, heart-shaped sparkles and white-gold spark particles storm upward and toward the camera around the rose. Comic speed lines, rotating lens flares, gold and pink strobe edges framing the screen. The rose spins slowly and catches specular highlights at the climax. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The rose and the main action stay in the horizontal center of the frame (safe for a vertical center crop). Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a bright cheerful jingling jackpot fanfare with sparkling bell arpeggios and a soft taiko impact hit as the rose blooms, celebratory and cute, ending with the music decaying toward silence in the final half second.
- **cut-rosa.mp4** — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame, top-rarity grade. A lush deep-red velvet rose exactly matching the reference image — a richly layered realistic crimson rose bloom with many soft ruffled petals and dark green leaves — erupts into the center of the screen and unfurls its petals in a slow majestic bloom, far more luxurious and premium than an ordinary rose. Behind it, enormous golden god-rays sweep and rotate radially from the center like a slot-machine grand-prize starburst; a storm of crimson and scarlet rose petals swirls outward filling the whole frame and streaming toward the camera; showers of golden sparks, glittering embers and white-hot light motes rise around the bloom. Multiple escalating explosion waves, firework volleys of red and gold, rotating lens flares, deep red and gold strobe edges framing the screen, subtle camera shake on each impact. Rich velvet texture and deep specular highlights on the petals at the climax. Maximum spectacle, screen-filling, overwhelming grand-prize energy, slow dramatic push-in. The rose and the main action stay in the horizontal center of the frame (safe for a vertical center crop). Ends with a brilliant white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a dramatic rising orchestral jackpot fanfare with brass swells, taiko-style impact hits as the petals burst, shimmering orchestral bells over the top, grand and luxurious, ending with the music decaying toward silence in the final half second.

> Higgsfield の罠(`band/` のときと同じ): `generate_video_batch` は最初の投入で
> **プリセット推奨("IN THE DARK")が返ってジョブが作られない**ことがある。
> 返ってきた `declined_preset_id` を同じ params に足して再投入すれば通る。

# ダイヤの全面カット・第2弾(`cut/` サブフォルダ・40本)

TikTok のギフト一覧40種に、それぞれ専用のフルスクリーンカットインを用意したもの。
判定とカタログの出所は `src/shared/fx-cut.ts` の `FULL_CUT_CLIPS_V3` ただ一つ。
第1弾の2本と合わせて42行が `DEFAULT_GIFT_FULL_CUT.rules` になる。

> ## ⚠️ トリガーは **giftId と英語のギフト名**。日本語名では発火しない
>
> TikTok の配信イベントが載せてくる `giftName` は、**視聴側・配信側の表示言語に
> 関係なく英語**で届く(`Rose` / `Genius` / `Clap Clap`)。日本限定ギフト
>(ねば〜る君・ふっかちゃん・うどん脳など)だけが日本語で届く。
> 初版(`settingsVersion` 3)はスクリーンショットの表示名をそのまま日本語で
> 入れてしまい、**42行中40行が一度も発火しなかった**。
>
> さらに **同名で別IDのギフトが実在する** — `Hand Heart` は `5660`(ハートポーズ)と
> `8343`(ハンドハート)の2つあり、名前では区別できない。だから giftId が要る。
>
> 下表の giftId は**実データ(`gift_catalog` / `gift_alias` と受信履歴)で確認した 20 行**。
> 「—」の行はこのアカウントで未受領のため未確認で、英語名の推定だけで当てにいっている。
> 実際に受け取ったら giftId を埋めること。
>
> canonical は原則使わない。`gift_alias` は Finger Heart と Hand Heart を
> どちらも `heart` に畳んでしまうなど粒度が粗く、別々のクリップに割れないため。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | Higgsfield / `seedance_2_0_mini`(720p・参照画像 `image_references`) |
| 生成日 | 2026-08-14 |
| 出力(生成時) | 1280×720 (16:9) / 24fps / H.264 / **AAC 音声トラックあり**(`generate_audio: true`) |
| 参照画像 | `IMAGE/20260814/WS0005xx.JPG`(TikTok ギフト一覧のスクリーンショット) |
| 尺 | 各 5.09 秒(アプリ側は `giftFullCut.rules[].durationSec` = 5 秒で打ち切る) |

**加工内容: ffmpeg で再エンコード(第1弾の2本と違い無加工ではない)。**
40本を無加工で入れると約180MB 増え、`app.asar` と AGPL ソース zip の**両方**に載るため
インストーラが約2倍太る。次の設定で約1/3に圧縮した(SSIM 0.970 / PSNR 37.8dB・
実フレーム比較で劣化を確認できず):

```
ffmpeg -i raw.mp4 -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -profile:v high   -movflags +faststart -c:a aac -b:a 128k -ac 2 -ar 48000 out.mp4
```

- `yuv420p` — 生成物が 4:4:4 で返ることがあり、Chromium が再生を拒む場合があるため明示。
- `+faststart` — moov atom を先頭へ。`app.asar` 内からの `preload="auto"` が全読みせずに始まる。
- 音声も再エンコード(`-c:a copy` にしない)— 40本の音圧がバラつくと、
  `giftFullCut.volume` 一つで音量を決めるこの経路では耳に付くため。

| ファイル | ギフト | giftId | giftName | 尺 | サイズ |
|---|---|---|---|---|---|
| `cut-subarashii.mp4` | 素晴らしい | `15232` | `awesome` | 5.09 秒 | 1.08 MB |
| `cut-mini-hanabi.mp4` | ミニ花火 | — | `mini fireworks` | 5.09 秒 | 1.63 MB |
| `cut-neko-ashi.mp4` | 猫の足 | — | `cat paw` | 5.09 秒 | 0.98 MB |
| `cut-tiktok.mp4` | TikTok | `5269` | `tiktok`(完全一致) | 5.09 秒 | 1.23 MB |
| `cut-gg.mp4` | GG | `6064` | `gg`(完全一致) | 5.09 秒 | 1.31 MB |
| `cut-shoken.mp4` | 初見です | `12202` | `nice to meet u` | 5.09 秒 | 1.07 MB |
| `cut-hakushu.mp4` | 拍手 | `231956` | `clap clap` | 5.09 秒 | 1.11 MB |
| `cut-daisuki.mp4` | 大好き | `15231` | `love you so much` | 5.09 秒 | 1.25 MB |
| `cut-soft-cream.mp4` | ソフトクリーム | — | `ice cream cone` | 5.09 秒 | 0.92 MB |
| `cut-uchiwa.mp4` | うちわ | `15563` | `fan`(完全一致) | 5.09 秒 | 1.39 MB |
| `cut-yakyu.mp4` | 野球 | `7897` | `baseball` | 5.09 秒 | 0.76 MB |
| `cut-love-letter.mp4` | ラブレター | `14113` | `love letter` | 5.09 秒 | 0.91 MB |
| `cut-ai-no-kaori.mp4` | 愛の香り | `919386` | `love in scent` | 5.09 秒 | 1.08 MB |
| `cut-finger-heart.mp4` | フィンガーハート | `5487` | `finger heart` | 5.09 秒 | 1.30 MB |
| `cut-nyao.mp4` | ニャオ | — | `nyao` | 5.09 秒 | 1.34 MB |
| `cut-yell.mp4` | エール | `12238` | `support` | 5.09 秒 | 0.95 MB |
| `cut-honki.mp4` | 本気 | `13521` | `seriously` | 5.09 秒 | 1.49 MB |
| `cut-omamori.mp4` | おまもり | — | `omamori` | 5.09 秒 | 1.37 MB |
| `cut-nebaaru.mp4` | ねば〜る君 | — | `ねば` | 5.09 秒 | 1.17 MB |
| `cut-fukka.mp4` | ふっかちゃん | — | `ふっか` | 5.09 秒 | 1.33 MB |
| `cut-udon-no.mp4` | うどん脳 | — | `うどん脳` | 5.09 秒 | 1.11 MB |
| `cut-ice-bar.mp4` | アイスバー | — | `ice bar` | 5.09 秒 | 1.11 MB |
| `cut-journey-pass.mp4` | ジャーニーパス | — | `journey pass` | 5.09 秒 | 1.51 MB |
| `cut-oshi-shosan.mp4` | 推しへの称賛 | — | `applause` | 5.09 秒 | 1.55 MB |
| `cut-kosui.mp4` | 香水 | `5658` | `perfume` | 5.09 秒 | 1.12 MB |
| `cut-goat-busker.mp4` | G.O.A.T.バスカー | — | `busker` | 5.09 秒 | 1.07 MB |
| `cut-donut.mp4` | ドーナッツ | `5879` | `doughnut` | 5.09 秒 | 1.06 MB |
| `cut-tensai.mp4` | 天才 | `13523` | `genius` | 5.09 秒 | 1.54 MB |
| `cut-boshi-hige.mp4` | 帽子と口ひげ | — | `hat and moustache` | 5.09 秒 | 1.03 MB |
| `cut-utau-kinoko.mp4` | 歌うキノコ | `170506` | `singing mushroom` | 5.09 秒 | 1.40 MB |
| `cut-pearl-chime.mp4` | パールチャイム | — | `pearl chime` | 5.09 秒 | 1.19 MB |
| `cut-flower-melody.mp4` | フラワーメロディ | — | `flower melody` | 5.09 秒 | 1.26 MB |
| `cut-groove-guitar.mp4` | グルーヴギター | — | `groove guitar` | 5.09 秒 | 1.17 MB |
| `cut-fiesta-accordion.mp4` | フィエスタアコーディオン | — | `fiesta accordion` | 5.09 秒 | 1.44 MB |
| `cut-heart-pose.mp4` | ハートポーズ | `5660` | — | 5.09 秒 | 1.28 MB |
| `cut-hand-heart.mp4` | ハンドハート | `8343` | — | 5.09 秒 | 0.92 MB |
| `cut-mischka-bear.mp4` | ミシカベア | — | `mischka` | 5.09 秒 | 1.13 MB |
| `cut-cracker.mp4` | クラッカー | — | `party popper` | 5.09 秒 | 1.66 MB |
| `cut-koi-megane.mp4` | 恋のメガネ | `19168` | `love glasses` | 5.09 秒 | 1.05 MB |
| `cut-tempo-flute.mp4` | テンポフルート | — | `tempo flute` | 5.09 秒 | 1.21 MB |

合計 **48.5 MB**。

> ## ⚠️ band/*.mp4・stock-cutin.mp4 と同族 — screen 禁止・`.fx-clip-opaque` 必須・音声あり
>
> 不透明フルフレーム素材なので `mix-blend-mode: screen` は禁止。配置の制約
>(`.monitor-root` 直下・z-index なし)も同じ。音声の有無の分岐は
> `ChallengeEffect.fxFullCut` ただ一つで、worker はこの印が付く effect に
> `fxBandBgm` を**載せない**(載せると mp4 の音と BGM が二重に鳴る)。
>
> **既定 5 秒 < 素材 5.09 秒なのでループしない。** 設定で 6 秒以上にすると
> 頭から再生し直すので音楽も鳴り直す。
>
> 素材を差し替え・削除しても `lib/fx.ts` は 0 件許容の glob なのでビルドは落ちないが、
> `test/unit/fx-catalog.spec.ts` の「素材ファイルと id が一対一」が赤くなる(意図的)。

## Higgsfield の実務メモ(この40本で踏んだもの)

- **同時実行は約3本**。超えると `Out of credits on plus (monthly) plan` という
  **クレジット残高とは無関係の誤った文言**で `submission_failed` になる。残高があるなら
  ただの同時実行制限なので、空きができてから再投入すればよい。
- 生成自体も体感 1/4 で `failed` になる。**失敗は課金されない**ので再投入で足りる。
- `generate_video_batch` は初回投入でプリセット推奨が返りジョブが作られないことがある。
  返却された `declined_preset_id` を同じ params に足して再投入する。
- **`cut-heart-pose` / `cut-hand-heart` は末尾の禁止句を変えてある。** 定型の「no hands」は
  被写体が手であるこの2本と矛盾するので `no faces, no full human figure` に差し替えた。
- **`cut-soft-cream.mp4` / `cut-hand-heart.mp4` はプロンプトが他と違う。** house style の定型文だと3回連続で
  `failed` になったため、平易な言い回しに書き換えたものが通った(下記に実際の文を載せる)。

## 生成プロンプト(全文)

共通ガード(`band/*.mp4` と同じ): パチンコ大当たり風 / 冒頭から即アクション /
不透明フルフレーム / 被写体は横方向の中央に維持 / 終端は白金フラッシュ /
文字・ロゴ・人物・手 禁止 / 末尾 0.5 秒で音楽を無音へ減衰(映像の `.out` フェード 400ms と対)。
アイコン自体が文字の行(TikTok / GG / 初見です / 本気 / 天才 / エール / おまもり)だけは
「参照どおりに保ち、他の文字は足すな」に差し替えている。

- **cut-subarashii.mp4**(素晴らしい) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The chubby cartoon 3D cat from the reference image — a cream-and-orange tabby kitten with big round eyes giving an enthusiastic thumbs-up — pops up into the center of the screen with a bouncy elastic scale-up and beams with pride. Behind it, long warm orange and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of warm orange and gold light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, warm orange and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a bright cheerful jingling jackpot fanfare with sparkling bell arpeggios and a proud trumpet flourish, ending with the music decaying toward silence in the final half second.
- **cut-mini-hanabi.mp4**(ミニ花火) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The radial firework burst from the reference image — a symmetrical starburst of slender pastel rainbow spokes tipped with sparks — detonates in the center of the screen and blooms outward again and again in escalating volleys. Behind it, long pastel rainbow and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of pastel rainbow and gold light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, pastel rainbow and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: crackling firework whistles and pops over a bright celebratory jackpot fanfare with bell arpeggios, ending with the music decaying toward silence in the final half second.
- **cut-neko-ashi.mp4**(猫の足) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The fluffy white cat paw from the reference image — a soft round plush paw pad with pink toe beans — bounces up into the center of the screen with a squishy elastic pop, pressing toward the camera as if booping the viewer. Behind it, long soft pink and cream light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of soft pink and cream light ripple outward to the edges of the frame; a storm of glowing pink hearts, paw-print sparkles and fluffy white feathers storms upward and toward the camera. Comic speed lines, rotating lens flares, soft pink and cream strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands, no full cat body. Audio: a bright cheerful jingling jackpot fanfare with sparkling bell arpeggios, a cute soft boop and a light taiko impact hit, ending with the music decaying toward silence in the final half second.
- **cut-tiktok.mp4**(TikTok) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The glossy 3D music-note emblem from the reference image — a thick beveled note in white with cyan and magenta chromatic edges, exactly as it appears in the reference — spins into the center of the screen and slams to a stop with a heavy metallic impact. Behind it, long cyan and magenta light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of cyan and magenta light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, cyan and magenta strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. Keep the emblem exactly as in the reference and add no other text: no extra letters, no numbers, no logos, no watermark, no people, no hands. Audio: a punchy electronic jackpot fanfare with a rising synth riser, glitchy stutters and a deep bass impact hit, ending with the music decaying toward silence in the final half second.
- **cut-gg.mp4**(GG) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The chunky pixel-art emblem from the reference image — blocky 8-bit letterforms with a pink-to-yellow gradient and hard chromatic fringing, exactly as it appears in the reference — slams into the center of the screen with a retro pixel shatter and scales up. Behind it, long hot pink, yellow and cyan light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of hot pink, yellow and cyan light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, hot pink, yellow and cyan strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. Keep the emblem exactly as in the reference and add no other text: no extra letters, no numbers, no logos, no watermark, no people, no hands. Audio: a triumphant 8-bit chiptune victory fanfare with arcade coin blips and a deep bass impact hit, ending with the music decaying toward silence in the final half second.
- **cut-shoken.mp4**(初見です) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The glossy pink bubble-lettering emblem with a small red heart from the reference image, exactly as it appears in the reference, pops into the center of the screen with a bouncy elastic scale-up and a candy-gloss shine sweep. Behind it, long hot pink and white light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of hot pink and white light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, hot pink and white strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. Keep the emblem exactly as in the reference and add no other text: no extra letters, no numbers, no logos, no watermark, no people, no hands. Audio: a bright bubbly jackpot jingle with sparkling bell arpeggios and a cute pop impact, ending with the music decaying toward silence in the final half second.
- **cut-hakushu.mp4**(拍手) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The pair of cartoon clapping hands from the reference image — warm yellow-orange 3D hands mid-clap with green motion accents — claps hard in the center of the screen, sending a shockwave out on each impact. Behind it, long golden yellow and green light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of golden yellow and green light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, golden yellow and green strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a roaring crowd applause swell over a bright brass jackpot fanfare with sharp clap impacts, ending with the music decaying toward silence in the final half second.
- **cut-daisuki.mp4**(大好き) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The smiling yellow emoji face hugging a big red heart from the reference image — rosy cheeks, closed happy eyes, stubby arms wrapped around the heart — bounces up into the center of the screen and squeezes the heart, which pulses with each beat. Behind it, long red, pink and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of red, pink and gold light ripple outward to the edges of the frame; a storm of floating red and pink hearts storms upward and toward the camera. Comic speed lines, rotating lens flares, red, pink and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a warm romantic jackpot fanfare with sparkling bells, a soft heartbeat thump and a cheerful brass swell, ending with the music decaying toward silence in the final half second.
- **cut-soft-cream.mp4**(ソフトクリーム) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The pink-and-cream swirled soft-serve ice cream cone from the reference image rises into the center of the screen, its glossy swirl turning slowly and catching sugary specular highlights. Behind it, long strawberry pink and cream light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of strawberry pink and cream light ripple outward to the edges of the frame; a storm of sprinkles, sugar crystals and pastel confetti storms upward and toward the camera. Comic speed lines, rotating lens flares, strawberry pink and cream strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a sweet twinkling jackpot jingle with glockenspiel arpeggios and a soft marimba flourish, ending with the music decaying toward silence in the final half second.
- **cut-uchiwa.mp4**(うちわ) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The round paper fan from the reference image — a navy fan face printed with a colorful firework night sky, on a slim handle — sweeps into the center of the screen and fans toward the camera, its printed fireworks igniting into real light. Behind it, long deep blue and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of deep blue and gold light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, deep blue and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a festive Japanese matsuri jackpot fanfare with taiko drums, shinobue flute and firework pops, ending with the music decaying toward silence in the final half second.
- **cut-yakyu.mp4**(野球) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The white leather baseball with red stitching from the reference image screams toward the camera in the center of the screen, spinning fast, then freezes at the moment of impact. Behind it, long stadium white and green light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of stadium white and green light ripple outward to the edges of the frame; a burst of grass fragments, chalk dust and golden sparks storms upward and toward the camera. Comic speed lines, rotating lens flares, stadium white and green strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a sharp bat crack, a roaring stadium crowd and a triumphant brass jackpot fanfare with organ stabs, ending with the music decaying toward silence in the final half second.
- **cut-love-letter.mp4**(ラブレター) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The cream envelope sealed with a glossy pink heart from the reference image floats into the center of the screen, then bursts open, releasing a torrent of light from inside. Behind it, long blush pink and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of blush pink and gold light ripple outward to the edges of the frame; a storm of floating hearts, rose petals and paper confetti storms upward and toward the camera. Comic speed lines, rotating lens flares, blush pink and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a tender music-box jackpot melody blooming into a warm romantic orchestral fanfare with sparkling bells, ending with the music decaying toward silence in the final half second.
- **cut-ai-no-kaori.mp4**(愛の香り) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The heart-shaped pink perfume bottle with a golden star cap from the reference image rises into the center of the screen and releases a shimmering burst of glowing perfume mist. Behind it, long rose pink and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of rose pink and gold light ripple outward to the edges of the frame; swirling ribbons of luminous mist, floating hearts and golden sparkles storms upward and toward the camera. Comic speed lines, rotating lens flares, rose pink and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a silky glamorous jackpot fanfare with harp glissandos, shimmering bells and a warm string swell, ending with the music decaying toward silence in the final half second.
- **cut-finger-heart.mp4**(フィンガーハート) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The cartoon hand making a finger-heart gesture from the reference image, with a small glowing red heart popping above the crossed fingertips, snaps into the center of the screen and the heart detonates into light. Behind it, long red, pink and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of red, pink and gold light ripple outward to the edges of the frame; a storm of small glowing hearts storms upward and toward the camera. Comic speed lines, rotating lens flares, red, pink and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a cute K-pop style jackpot fanfare with bright synth stabs, sparkling bells and a snappy impact hit, ending with the music decaying toward silence in the final half second.
- **cut-nyao.mp4**(ニャオ) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The sleek black cat with bright yellow-green eyes from the reference image, holding a glowing gold coin in its paw, leaps into the center of the screen and flips the coin toward the camera. Behind it, long gold and emerald green light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of gold and emerald green light ripple outward to the edges of the frame; a fountain of spinning gold coins and sparks storms upward and toward the camera. Comic speed lines, rotating lens flares, gold and emerald green strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a playful jazzy jackpot fanfare with pizzicato strings, a cat meow accent and cascading coin chimes, ending with the music decaying toward silence in the final half second.
- **cut-yell.mp4**(エール) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The black cheering fan-board from the reference image, hand-lettered in glowing neon chalk with a small star and hearts exactly as in the reference, swings into the center of the screen and its neon lettering ignites brightly. Behind it, long cyan, pink and yellow neon light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of cyan, pink and yellow neon light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, cyan, pink and yellow neon strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. Keep the emblem exactly as in the reference and add no other text: no extra letters, no numbers, no logos, no watermark, no people, no hands. Audio: an energetic idol-concert jackpot fanfare with synth brass, crowd cheers and rhythmic clap stomps, ending with the music decaying toward silence in the final half second.
- **cut-honki.mp4**(本気) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The bold 3D emblem from the reference image — thick beveled glossy lettering with a pink-to-purple gradient and a hard drop shadow, exactly as it appears in the reference — slams into the center of the screen with a heavy impact and a screen-shaking thud. Behind it, long magenta and deep purple light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of magenta and deep purple light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, magenta and deep purple strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. Keep the emblem exactly as in the reference and add no other text: no extra letters, no numbers, no logos, no watermark, no people, no hands. Audio: an aggressive rising jackpot fanfare with distorted brass, taiko impact hits and a deep bass drop, ending with the music decaying toward silence in the final half second.
- **cut-omamori.mp4**(おまもり) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The red brocade Japanese omamori charm pouch from the reference image, patterned with white and gold flowers and tied with a braided cord exactly as in the reference, floats into the center of the screen and radiates a protective golden glow. Behind it, long crimson and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of crimson and gold light ripple outward to the edges of the frame; drifting cherry blossom petals and golden talisman sparks storms upward and toward the camera. Comic speed lines, rotating lens flares, crimson and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. Keep the emblem exactly as in the reference and add no other text: no extra letters, no numbers, no logos, no watermark, no people, no hands. Audio: a serene Japanese shrine jackpot fanfare with koto plucks, suzu bell shakes and a deep temple drum, ending with the music decaying toward silence in the final half second.
- **cut-nebaaru.mp4**(ねば〜る君) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The brown gooey cartoon mascot character from the reference image — a rounded sticky-looking figure with a swirl pattern, big eyes and an open smiling mouth — stretches up tall into the center of the screen with an elastic gooey wobble and springs back. Behind it, long amber brown and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of amber brown and gold light ripple outward to the edges of the frame; stretchy glossy goo strands and golden sparks storms upward and toward the camera. Comic speed lines, rotating lens flares, amber brown and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a goofy bouncy jackpot fanfare with slide whistles, springy boings, tuba blats and a bright bell finish, ending with the music decaying toward silence in the final half second.
- **cut-fukka.mp4**(ふっかちゃん) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The white mascot character from the reference image — a round-faced creature with a green leafy hat, rosy cheeks and green antler-like sprouts — jumps into the center of the screen with both arms raised in a cheerful pose. Behind it, long fresh green and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of fresh green and gold light ripple outward to the edges of the frame; a storm of green leaves, flower petals and golden sparkles storms upward and toward the camera. Comic speed lines, rotating lens flares, fresh green and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a cheerful festival mascot jackpot fanfare with marching brass, glockenspiel and a bouncy bass drum, ending with the music decaying toward silence in the final half second.
- **cut-udon-no.mp4**(うどん脳) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The white cartoon mascot from the reference image — a simple round figure whose head is a coiled nest of udon noodles — slurps noodles from a bowl in the center of the screen, noodles flying dramatically. Behind it, long warm cream and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of warm cream and gold light ripple outward to the edges of the frame; flying noodle strands, steam wisps and golden sparks storms upward and toward the camera. Comic speed lines, rotating lens flares, warm cream and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a comedic jackpot fanfare with slurping accents, woodblock hits, playful flute runs and a bright bell finish, ending with the music decaying toward silence in the final half second.
- **cut-ice-bar.mp4**(アイスバー) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The pink popsicle ice bar from the reference image, glazed with white icing and rainbow sprinkles on a wooden stick, rises into the center of the screen glistening with frost. Behind it, long icy cyan and strawberry pink light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of icy cyan and strawberry pink light ripple outward to the edges of the frame; a burst of frost crystals, cold vapor and sprinkles storms upward and toward the camera. Comic speed lines, rotating lens flares, icy cyan and strawberry pink strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a crisp refreshing jackpot jingle with icy glass bell chimes, a crunchy bite accent and a bright synth swell, ending with the music decaying toward silence in the final half second.
- **cut-journey-pass.mp4**(ジャーニーパス) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The pair of blue racing tickets printed with a yellow formula race car and a checkered flag pattern from the reference image fan out into the center of the screen and blast forward toward the camera. Behind it, long racing blue and yellow light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of racing blue and yellow light ripple outward to the edges of the frame; speed streaks, checkered-flag confetti and tyre smoke storms upward and toward the camera. Comic speed lines, rotating lens flares, racing blue and yellow strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a high-energy motorsport jackpot fanfare with revving engines, a starting-grid beep sequence and driving brass, ending with the music decaying toward silence in the final half second.
- **cut-oshi-shosan.mp4**(推しへの称賛) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The open violin case lined with red velvet from the reference image, with glowing golden musical notes floating out of it, opens wide in the center of the screen and pours out a river of luminous notes. Behind it, long deep red and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of deep red and gold light ripple outward to the edges of the frame; a swirling stream of glowing musical notes and golden sparks storms upward and toward the camera. Comic speed lines, rotating lens flares, deep red and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a lush orchestral jackpot fanfare with soaring strings, harp glissandos and a grand brass climax, ending with the music decaying toward silence in the final half second.
- **cut-kosui.mp4**(香水) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The hot-pink glass perfume bottle with a gold ribbon cap from the reference image rises into the center of the screen and sprays a brilliant shimmering burst of glowing mist toward the camera. Behind it, long magenta and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of magenta and gold light ripple outward to the edges of the frame; luminous mist ribbons, glitter and floating light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, magenta and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a glamorous luxury jackpot fanfare with shimmering harp, silky strings and a sparkling bell cascade, ending with the music decaying toward silence in the final half second.
- **cut-goat-busker.mp4**(G.O.A.T.バスカー) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The fluffy white cartoon lamb wearing a striped beanie from the reference image, singing passionately into a silver microphone with eyes closed, belts out a note in the center of the screen. Behind it, long stage purple and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of stage purple and gold light ripple outward to the edges of the frame; stage spotlight beams, floating musical notes and golden confetti storms upward and toward the camera. Comic speed lines, rotating lens flares, stage purple and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a soulful busking jackpot fanfare with acoustic guitar strums, a crowd cheer and a triumphant brass finish, ending with the music decaying toward silence in the final half second.
- **cut-donut.mp4**(ドーナッツ) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The pastel rainbow-glazed doughnut with colorful sprinkles from the reference image spins into the center of the screen and slams flat toward the camera, glaze glistening. Behind it, long pastel rainbow and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of pastel rainbow and gold light ripple outward to the edges of the frame; a storm of sprinkles, sugar dust and pastel confetti storms upward and toward the camera. Comic speed lines, rotating lens flares, pastel rainbow and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a sugary upbeat jackpot fanfare with bubbly synth plucks, glockenspiel and a cheerful brass hit, ending with the music decaying toward silence in the final half second.
- **cut-tensai.mp4**(天才) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The ornate golden-and-purple award emblem plaque from the reference image — a thick beveled gold-outlined badge with a small crown and star accents, exactly as it appears in the reference — slams into the center of the screen and scales up with a heavy impact, glinting with metallic specular sweeps. Behind it, long gold and royal violet light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of gold and royal violet light ripple outward to the edges of the frame; a storm of glittering sparks and white-gold light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, gold and royal violet strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. Keep the emblem exactly as in the reference and add no other text: no extra letters, no numbers, no logos, no watermark, no people, no hands. Audio: a dramatic rising orchestral jackpot fanfare with brass swells, taiko impact hits and shimmering orchestral bells, ending with the music decaying toward silence in the final half second.
- **cut-boshi-hige.mp4**(帽子と口ひげ) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The tan wide-brimmed cowboy hat with a curled brown moustache floating beneath it from the reference image tips into the center of the screen with a dapper flourish and settles with a confident bounce. Behind it, long desert amber and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of desert amber and gold light ripple outward to the edges of the frame; swirling dust motes, golden sparks and drifting straw wisps storms upward and toward the camera. Comic speed lines, rotating lens flares, desert amber and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a swaggering western jackpot fanfare with twanging guitar, whip-crack accents, harmonica and a bold brass finish, ending with the music decaying toward silence in the final half second.
- **cut-utau-kinoko.mp4**(歌うキノコ) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The smiling cartoon mushroom from the reference image — a red cap with white spots over a cheerful pale face — bounces into the center of the screen singing with its mouth wide open, tiny mushrooms sprouting around it. Behind it, long red, white and rainbow light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of red, white and rainbow light ripple outward to the edges of the frame; a storm of colorful floating musical notes and spore sparkles storms upward and toward the camera. Comic speed lines, rotating lens flares, red, white and rainbow strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a whimsical storybook jackpot fanfare with pizzicato strings, playful woodwinds, a choral sting and bright bells, ending with the music decaying toward silence in the final half second.
- **cut-pearl-chime.mp4**(パールチャイム) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The iridescent pearl chime ornament from the reference image — a luminous pearlescent shell dome with dangling beaded strands tipped in pearls — descends into the center of the screen and its strands swing and ring, each pearl flaring with light. Behind it, long iridescent pearl, lilac and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of iridescent pearl, lilac and gold light ripple outward to the edges of the frame; floating bubbles, pearl beads and soft prismatic light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, iridescent pearl, lilac and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a delicate shimmering jackpot chime cascade with crystal bells, harp glissandos and a soft orchestral swell, ending with the music decaying toward silence in the final half second.
- **cut-flower-melody.mp4**(フラワーメロディ) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The smiling pink cartoon flower in a purple pot from the reference image sways into the center of the screen singing happily, its petals fanning wide as musical notes spin around it. Behind it, long pink, green and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of pink, green and gold light ripple outward to the edges of the frame; a storm of flower petals and floating blue musical notes storms upward and toward the camera. Comic speed lines, rotating lens flares, pink, green and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a sunny whimsical jackpot fanfare with music-box melody, playful woodwinds and a bright bell finish, ending with the music decaying toward silence in the final half second.
- **cut-groove-guitar.mp4**(グルーヴギター) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The warm-wood acoustic guitar wreathed in green vines and small flowers from the reference image, with a little blue bird perched on it, swings into the center of the screen and its strings flare with light as it is strummed. Behind it, long honey amber and leafy green light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of honey amber and leafy green light ripple outward to the edges of the frame; drifting leaves, flower petals and golden musical notes storms upward and toward the camera. Comic speed lines, rotating lens flares, honey amber and leafy green strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a groovy acoustic jackpot fanfare with a bright guitar strum riff, hand claps, shaker and a warm brass finish, ending with the music decaying toward silence in the final half second.
- **cut-fiesta-accordion.mp4**(フィエスタアコーディオン) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The red-and-gold accordion from the reference image squeezes and expands dramatically in the center of the screen, its bellows pumping as light bursts from between the folds. Behind it, long fiesta red, gold and orange light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of fiesta red, gold and orange light ripple outward to the edges of the frame; papel picado confetti, swirling ribbons and golden sparks storms upward and toward the camera. Comic speed lines, rotating lens flares, fiesta red, gold and orange strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a festive latin fiesta jackpot fanfare with accordion riffs, trumpet blasts, hand claps and a lively percussion break, ending with the music decaying toward silence in the final half second.
- **cut-heart-pose.mp4**(ハートポーズ) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The pair of open cupped hands cradling a glowing iridescent crystal heart from the reference image lifts into the center of the screen and the heart flares brilliantly, pulsing with rainbow light. Behind it, long iridescent rainbow and pink light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of iridescent rainbow and pink light ripple outward to the edges of the frame; a storm of glowing hearts and prismatic light motes storms upward and toward the camera. Comic speed lines, rotating lens flares, iridescent rainbow and pink strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a dreamy uplifting jackpot fanfare with shimmering synth pads, crystal bells and a soaring string swell, ending with the music decaying toward silence in the final half second.
- **cut-hand-heart.mp4**(ハンドハート) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The pair of hands forming a heart shape from the reference image, framing a glowing violet heart of light between the thumbs and fingers, pushes toward the camera in the center of the screen and the heart detonates into light. Behind it, long violet, magenta and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of violet, magenta and gold light ripple outward to the edges of the frame; a storm of glowing hearts and sparkling motes storms upward and toward the camera. Comic speed lines, rotating lens flares, violet, magenta and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a warm romantic jackpot fanfare with sparkling bells, a soft heartbeat thump and a rising string swell, ending with the music decaying toward silence in the final half second.
- **cut-mischka-bear.mp4**(ミシカベア) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The plush brown teddy bear hugging a big red heart from the reference image waddles into the center of the screen and squeezes the heart tight, which pulses and glows brighter with each squeeze. Behind it, long warm brown, red and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of warm brown, red and gold light ripple outward to the edges of the frame; a storm of floating hearts and soft plush fluff storms upward and toward the camera. Comic speed lines, rotating lens flares, warm brown, red and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a cozy music-box jackpot melody blooming into a warm orchestral fanfare with sparkling bells, ending with the music decaying toward silence in the final half second.
- **cut-cracker.mp4**(クラッカー) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The colorful party popper cone from the reference image, wrapped in blue and purple with a gold star, fires straight at the camera in the center of the screen, erupting with streamers. Behind it, long multicolour party and gold light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of multicolour party and gold light ripple outward to the edges of the frame; an explosion of curling streamers, confetti and star sparkles storms upward and toward the camera. Comic speed lines, rotating lens flares, multicolour party and gold strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a party popper bang followed by a jubilant celebration jackpot fanfare with kazoo, brass and cheering crowd, ending with the music decaying toward silence in the final half second.
- **cut-koi-megane.mp4**(恋のメガネ) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The pair of heart-shaped sunglasses with rosy lenses from the reference image spins into the center of the screen and settles toward the camera as if being worn by the viewer, lenses flaring with a bright reflective glint. Behind it, long rose red and pink light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of rose red and pink light ripple outward to the edges of the frame; a storm of rose petals and floating hearts storms upward and toward the camera. Comic speed lines, rotating lens flares, rose red and pink strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a flirty retro jackpot fanfare with surf guitar twang, finger snaps, bright bells and a smooth brass finish, ending with the music decaying toward silence in the final half second.
- **cut-tempo-flute.mp4**(テンポフルート) — Pachinko jackpot cut-in animation, opaque full-frame, action starting immediately from the very first frame. The slender bamboo flute decorated with a small blossom from the reference image floats into the center of the screen as golden origami paper cranes fold out of the air and circle around it. Behind it, long gold, cream and soft pink light rays sweep and rotate radially from the center like a slot-machine victory starburst; waves of gold, cream and soft pink light ripple outward to the edges of the frame; flying origami cranes, cherry blossom petals and golden sparks storms upward and toward the camera. Comic speed lines, rotating lens flares, gold, cream and soft pink strobe edges framing the screen, subtle camera shake on each impact. Maximum spectacle, screen-filling, loud and celebratory jackpot energy, slight dramatic push-in. The subject and the main action stay in the horizontal center of the frame. Ends with a bright white-gold flash filling the frame. No text, no letters, no numbers, no logos, no watermark, no people, no hands. Audio: a graceful Japanese jackpot fanfare with shinobue flute melody, koto plucks, suzu bells and a soft taiko finish, ending with the music decaying toward silence in the final half second.

> 著作権の注意は `gift/` / `band/` と同じ — TikTok 本家のギフト演出の再現ではなく、
> アイコンの題材を参照した完全オリジナル。生成物の利用条件は Higgsfield の
> 利用規約(生成時のプラン: Plus)に従う。CC0 ではない。
