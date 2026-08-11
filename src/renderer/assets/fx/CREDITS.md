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

色は `styles/tokens.css` / `styles/monitor.css` の実値と、`monitor/fx/engine.ts` が使う
色相(press=200 / follow=0 / like=338 / gift=45 / gauge=330)に合わせてプロンプトで指定した。

## 使い方 — 必ず `mix-blend-mode: screen` で重ねる

Seedance 2.5 の出力は**アルファチャンネルを持たない**。そのため全クリップを
**純黒(#000000)背景に発光体だけ**という構成で生成してある。黒地に加算的に重ねれば黒が抜ける。

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
