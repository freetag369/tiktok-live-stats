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

加工内容: **音声のみ定数ゲイン +2.2 dB**(2026-08-14)。映像は `-c:v copy` で無劣化。

```
ffmpeg -i stock-cutin.orig.mp4 -c:v copy -af "volume=2.2dB" -c:a aac -b:a 160k -movflags +faststart stock-cutin.mp4
```

| 実測(ffmpeg `ebur128=peak=true`) | 加工前 | 加工後 |
|---|---|---|
| Integrated | -17.1 LUFS | **-15.0 LUFS** |
| True Peak | -3.2 dBFS | **-0.9 dBFS** |
| 終端 0.4 秒の RMS | -44.5 dB | -42.3 dB |

`loudnorm` は使っていない — **定数ゲインなので終端 0.4 秒の減衰カーブがそのまま保たれる**
(実測どおり全区間が一律 +2.2 dB)。dynamic 正規化のリミッタを通すと、映像の `.out`
フェードと揃えてあるこの減衰と、パチンコ大当たり風の立ち上がりの両方が潰れる。
真ピークは -0.9 dBFS なので、これ以上の定数ゲインはクリップする — さらに上げたい場合は
素材ではなく設定側(`stockCutinVolume`、既定 70 → 最大 100)で稼ぐこと。

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
> この `<video>` に限り muted を外し、音量は**専用設定 `stockCutinVolume`**(既定 70・
> 設定画面の「演出」タブ)で鳴らす。`cut/*.mp4` の `giftFullCut.volume` と同じ絶対値で、
> 全体音量(`seVolume`)は掛からない。
>
> ⚠ v0.5.3 までは `seVolumes['stock-full']` に連動させていた。あのスロットは同じ瞬間に
> 鳴る効果音 `stock-burst` と共用で、配布デフォが 16% に絞ってあるため動画の音が
> 70×16% ≒ **11%** まで潰れていた(「音が小さい」の原因はこれで、素材側ではなかった)。
> **戻さないこと** — 効果音の音量を下げると動画の音まで下がる構造に戻る。
>
> 音声は終端 0.4 秒で無音まで減衰する構成 — 映像の
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

# ルーレット超激アツ動画(`rl/` サブフォルダ・40本)

ギフトルーレットの超激アツ(ultra)10パターン用。**動画とリールのマス移動が交互に進み、
動画終端の「一撃」がリールを1マス押す**演出文法で作ってある — 各クリップは
最後の約1秒にカメラ/画面へ向かう一撃(尾撃ち・火炎・角の突き・飛び掛かり等)で終わる。
id ⇄ ウィンドウの対応は `src/shared/roulette-fx.ts` の `ROULETTE_PATTERN_TIMING.clips`
(ファイルは `<pattern>-<n>.mp4`、n はウィンドウ順)。突合は
`test/unit/roulette-clip-catalog.spec.ts`。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | Dreamina (dreamina.capcut.com) / `Dreamina Seedance 2.0`(t2v・参照なし)。**ハート系4パターン12本だけ Higgsfield 製** — 後述の別ブロック |
| 生成日 | 2026-08-16 |
| 出力(生成時) | 1280×720 (16:9) / **60fps を名乗る容器に 121 フレーム(実効24fps)** / H.264 / AAC 音声あり |
| 尺(生成時) | 各 5.06 秒 |
| 本数 | dragon 3 / unicorn 2 / whale 4 / phoenix 4 / lion 3 = 16(+ ハート系12本は別ブロック) |

**加工内容: ffmpeg でウィンドウ実尺へトリム(尾側を残す)+ 再エンコード + 音声の正規化。**
一撃が末尾に来るよう頭を切り落とし、各ファイルの実尺を `clips[].at→out` の
ウィンドウ長にフレーム単位で一致させてある(誤差は最大 ±20ms = 半フレーム未満)。
アプリ側は loop せず、動画が尽きたら一撃ポーズの最終フレームで静止し、
そこへ `.rl-clip.out` の溶暗(`RL_CLIP_FADE_MS` 480ms)が被る。

> ## ⚠️ `-ss` を使ってはいけない(初版が踏んだ罠)
>
> 素材は `r_frame_rate=60/1` を名乗る容器に 24fps の中身(121フレーム)が入っている。
> 初版は `-ss <5.06-窓長> -i raw.mp4 -t <窓長>` の**入力シーク**でトリムしたが、
> この容器ではシークが破綻し、**16本中7本が窓長より 358〜478ms 短くなった**。
> その結果「最終フレームで静止したまま全不透明で放置 → 消える」という
> 不自然な間ができていた。**フレーム番号でトリムすること**(`trim=start_frame=`)—
> シーク・キーフレーム・インデックスに一切依存せず決定的に切れる。
>
> あわせて **`fps=24` フィルタも使わない**。素材のPTSは 60fps 容器の 3-2-3-2 tick 刻みで
> ±1/120 秒揺れており、`fps` は最終スロットを範囲外と判断して**毎回きっちり1フレーム
> 落とす**(全16本で確認)。代わりに **`settb=1/24,setpts=N`** でタイムベースごと
> 1/24 に固定し、PTS をフレーム番号から作る — 入力フレームを1枚も落とさずに CFR 24fps。
> `setpts=N/24/TB` は**不可**(TB が入力の 1/60 のままなので 60fps へ 2.5 倍に
> 重複展開される。これも実際に踏んだ)。

```
# id ごとに start_frame S = 121 - N、N = round(窓ms × 24 / 1000)
ffmpeg -y -i raw.mp4 -filter_complex \
 "[0:v]trim=start_frame=<S>,settb=1/24,setpts=N[v];\
  [0:a]atrim=start=<S/24>,asetpts=PTS-STARTPTS,<loudnorm 2パス>,afade=t=out:st=<N/24-0.15>:d=0.15,aresample=48000[a]" \
 -map "[v]" -map "[a]" -map_metadata -1 \
 -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -profile:v high -fps_mode cfr -r 24 \
 -c:a aac -b:a 128k -ac 2 -ar 48000 -movflags +faststart out.mp4
```

> ## 2026-08-18: 窓は**全パターン共通の4枠**になった(カウントダウン式の激熱化)
>
> ultra 10パターンが同じ振り付け(`shared/challenge.ts` の `ROULETTE_ULTRA_BEATS`)を
> 共有するようになったので、窓の長さもパターンに依らず 4枠で固定:
>
> | 枠 | フレーム N | 窓ms | 用途 |
> |---|---|---|---|
> | 1 | 93 | 3875 | 激熱の合図(出目 ×2)の直後 |
> | 2 | 72 | 3000 | ドン ×3 の直後 |
> | 3 | 57 | 2375 | ドン ×4 の直後 |
> | 4 | 52 | 2167 | ドン ×5 の直後(最後の一撃) |
>
> **既存28本は原本から枠へ切り直した**(`S = 元フレーム数 - N`。頭を切るので一撃は残る)。
> 切り幅は0〜27フレームが大半だが、**`hearttouch-2` と `unicorn-2` だけ 48フレーム**
> (5.0秒 → 3.0秒)— この2パターンは手持ちが2本しかなく、2本目を枠2へ詰めたため。
> 新規8本は Higgsfield が 121 フレームで返すので `S = 121 - N`(枠3 = 64、枠4 = 69)。

- **音声は素材の焼き込みをそのまま使う**(初版は `-an` で捨てていた)。音量は
  設定の `rouletteSound.clipVolume`(既定70)で、効果音オフなら動画ごと無音。
  回転ループ音は最初のウィンドウ(`quietAt`)で閉じるので鳴りは被らない。
- **2パス loudnorm で -16 LUFS に揃える**(`linear=true`)。実測は -10.7〜-30.2 LUFS と
  19.5 LU もばらついており、音量スライダー1本で決めるこの経路では耳に付くため
  (全面カット40本で音圧を再エンコードした理由と同じ)。
- 末尾 150ms だけ `afade` — 音の「プツッ」を防ぐ。一撃の音そのものは削らない長さ。
- `rl/` 全40本の合計は ≒ **27MB**(DJメガネ4本 +2.1MB)(`app.asar` と AGPL ソース zip の両方に載る)。
  枠へ切り直して短くなったぶんと、本数が 28 → 36 に増えたぶんがほぼ相殺している。
  **`-crf 28 -preset slow` は落とさないこと** — crf 23 で焼き直したら 28.7MB まで膨れた。
- 検証(再トリムのたびに回すこと): 全36本で `nb_read_frames == N` / `r_frame_rate == 24/1` /
  音声ストリームあり / 実尺と窓長の差が ±21ms(半フレーム)以内 / **末尾フレームが
  元素材の末尾と一致**(`reverse,trim=end_frame=1` の PSNR — 実測 38〜56dB)。
  最後の1つは「一撃が切り落とされていない」ことの担保で、これが落ちたら
  トリムが末尾からずれている。
- プロンプトは英語・全本共通のスタイル接尾辞
  「glossy 3D render in the style of a TikTok live gift animation, centered composition,
  subject inside the middle third, safe for a vertical center crop, …」+
  終端一撃の指定「in the final second it strikes toward the camera(尾撃ち/火炎/角/
  羽ばたき/飛び掛かりのテーマ別バリエーション)」。全文は各生成の Dreamina 履歴
  (アセット)に残っている。
- ライセンス: Dreamina(CapCut)の利用規約に従う。CC0 ではない。
  本リポジトリは AGPL で配布されるため、**再配布前に規約上の再配布可否を必ず確認すること**。


## 激熱確定の導入動画6本 — `rl/hot/` ・2026-08-18 追加(ギフト連動3種は 2026-08-21〜22)

激熱確定(hot)ルーレットが**スロットに入る前**に流す 8 秒の全画面動画。
1本流し切ってから、同じ絵柄の超激アツスピン(既存素材)へつながる。

| ファイル | 絵柄 | 続くスピンのパターン | 選ばれ方 |
|---|---|---|---|
| `rl/hot/lion.mp4` | ライオン → 獅子の激熱 | `lion` | 抽選(3種) |
| `rl/hot/dragon.mp4` | ドラゴンの炎 → 黄金龍の激熱 | `dragon` | 抽選(3種) |
| `rl/hot/phoenix.mp4` | フェニックス → 不死鳥の激熱 | `phoenix` | 抽選(3種) |
| `rl/hot/djglasses.mp4` | DJメガネ → ネオンDJの激熱 | `djglasses` | **ギフト連動(100%)** |
| `rl/hot/unicorngift.mp4` | ユニコーン → 虹の角の激熱 | `unicorngift` | **ギフト連動(100%)** |
| `rl/hot/bunnydj.mp4` | バニーDJ → うさ耳DJの激熱 | `bunnydj` | **ギフト連動(100%)** |

**絵柄は2通りの選ばれ方がある。** 既定は `ROULETTE_HOT_PATTERNS` の3種からの抽選だが、
`ROULETTE_HOT_GIFT_PATTERNS`(`shared/challenge.ts`)に載ったギフトの激熱行は
**抽選を通さず必ずその絵柄**になる(DJメガネ = giftId 11583 → `djglasses`、
ユニコーン = giftId 12453 → `unicorngift`、バニーDJ = giftId 437679 → `bunnydj`)。
**`unicorn` は一角獣の通常パターンで埋まっている**ので、ギフト連動側のスラッグは
`unicorngift` にしてある(同名にすると通常抽選の絵柄と衝突する)。
実装は `rouletteHotPatternPool()` の1本で、**候補が1件の配列**になるだけ —
呼び元は今までどおり `drawRoulettePattern` を通すので **fxRand の消費は1回のまま**。
早期 return で飛ばすと同じ seed の再生が別物になる。

素材カタログ(`roulette-clip-catalog.spec.ts`)の突合先は
**`ROULETTE_HOT_INTRO_PATTERNS`**(抽選の3種 ∪ ギフト連動の絵柄)。`ROULETTE_HOT_PATTERNS`
で突き合わせると `djglasses.mp4` が孤児として弾かれる。

**置き場所は `rl/` 直下ではなくサブディレクトリ `rl/hot/`。** 直下に置くと
`test/unit/roulette-clip-catalog.spec.ts` の「id ⇄ ファイルが 1:1」が孤児として弾く
(あちらは `rl/` を非再帰に読む)。読み込みも専用 glob
(`renderer/lib/fx.ts` の `rouletteHotIntroUrl`)で分けてある。

| 項目 | 値 |
|---|---|
| 解像度 | 1280×720(既存 `rl/*.mp4` と同じ) |
| フレームレート | **真の 24fps**(`fps=24` フィルタで水増ししない) |
| 尺 | **192 フレームちょうど = 8.000 秒**(`ROULETTE_HOT_INTRO_MS`) |
| トリム | `trim=start_frame=` でフレーム指定。**`-ss` は使わない**(キーフレーム丸めで尺がズレる) |
| 音声 | 素材に焼き込み。loudnorm で −16 LUFS(音量は `rouletteSound.clipVolume`) |
| エンコード | `-crf 28 -preset slow`、`+faststart` |
| 構図 | 被写体は中央寄せ(縦ステージでは cover の中央クロップになる) |
| 終端 | 次のスピンへつながるので、**最後は静止ポーズで終える**(暗転で締めない) |

### 生成の実績(2026-08-18)

| 項目 | 値 |
|---|---|
| 生成 | Higgsfield / **Seedance 2.5**(`mode: t2v`・`duration: 8`・`resolution: 720p`・`aspect_ratio: 16:9`・`generate_audio: true`) |
| 素の出力 | 1280×720 / 24fps / **193 フレーム(8.064秒)** / 音声 AAC 32kHz |
| 後処理 | 192 フレームへ切り詰め + 音声を 48kHz へリサンプル + loudnorm −16 LUFS + h264 crf28 preset slow + `+faststart` |
| コスト | 52 クレジット × 4本(dragon は撮り直し1回)= 208 クレジット |

プロンプトは3本とも同じ骨格で、絵柄だけ差し替えてある:

> Cinematic fantasy game intro, **strictly centered symmetrical composition, subject always
> in the middle of frame.** In darkness, 〈素材ごとの立ち上がり〉. Slow steady push-in.
> **In the final second the 〈主役〉 FREEZES in a held pose, facing the viewer head-on,
> filling the center of the frame, and holds perfectly still.** Pure black background with
> drifting embers. Audio: rising orchestral tension building to one huge brass hit and
> 〈鳴き声〉. Ultra detailed 3D rendered game cinematic, volumetric god rays, high contrast.
> **No text, no letters, no numbers, no logos, no watermark, no subtitles, no UI, no people.**

- **「中央・正面・終端で静止」を毎回書くこと。** 縦ステージでは cover の中央クロップに
  なるので中央から外れると主役が切れ、終端が動いていると直後のリールへの繋ぎが濁る。
- **文字を明示的に禁止する。** 生成モデルは放っておくと崩れた英字を焼き込む。
- **終端の静止は「最後の N 秒は完全な静止画」と、動かないものを列挙して書くと効く。**
  初回の dragon は「FREEZES in a held pose」だけで炎が揺れ続けた(終端フレーム間差分
  5.99)。撮り直しで
  「THE LAST THREE SECONDS ARE A COMPLETELY FROZEN STILL IMAGE: absolutely no motion of
  any kind, the fire stops moving, no flickering, no embers drifting, no camera movement,
  ... exactly like a paused freeze-frame」
  と書いたら **0.013** まで落ちた(構図も正面向き・中央寄りに改善した)。
  実測の終端フレーム間差分(平均輝度)は lion 0.89 / phoenix 0.59 / dragon 0.013。

**尺を変えるときは `ROULETTE_HOT_INTRO_MS` と両方を動かすこと。** モニターの安全弁と
ホールド番犬の期限がこの定数から出ており、素材のほうが長いとリールが出る前に
番犬が発火して数字が先漏れする。

**素材を消しても壊れない** — `rouletteHotIntroUrl` が null を返し、`startRoulette` が
`introMs = 0` で即リールへ入る(値も尺の安全弁もそのぶん正しく短くなる)。

### DJメガネ 5本(導入1 + スピン4)— Dreamina(Seedance 2.0)製・2026-08-21 追加

TikTok ギフト **DJメガネ**(giftId `11583` / `DJ Glasses` / 500💎)専用の激熱確定。
**このギフトの激熱行だけは抽選を通さず 100% この絵柄**になる(上の表)。
導入 8 秒 → 同じ絵柄の超激アツスピン(専用の4本)→ ×10 で確定、が一続きになっている。

| ファイル | 枠 | モチーフ | 契約 | S | 実測音量 | サイズ |
|---|---|---|---|---|---|---|
| `rl/hot/djglasses.mp4` | 導入 | 暗闇 → バイザー点灯・ミラーボール・レーザー → ドロップの衝撃波 | 192f / 8.000s | 1 | -16.00 LUFS / -5.96 dBTP | 0.87 MB |
| `rl/djglasses-1.mp4` | 1 | ターンテーブルにレコードが落ちて回り、肉球でスクラッチ → レンズへ叩き付け | 93f / 3875ms | 28 | -16.15 LUFS / -4.20 dBTP | 0.47 MB |
| `rl/djglasses-2.mp4` | 2 | ミラーボールが割れ、光線が束になってレンズを撃つ | 72f / 3000ms | 49 | -16.16 LUFS / -5.16 dBTP | 0.56 MB |
| `rl/djglasses-3.mp4` | 3 | バイザーのイコライザーが振り切れ、音の衝撃波がレンズへ抜ける | 57f / 2375ms | 64 | -16.10 LUFS / -5.11 dBTP | 0.37 MB |
| `rl/djglasses-4.mp4` | 4 | スピーカーのコーンがキャビネットを突き破ってレンズへ | 52f / 2167ms | 69 | -16.01 LUFS / -6.44 dBTP | 0.63 MB |

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | **Dreamina (CapCut)** / `Dreamina Seedance 2.0`(モード **オムニリファレンス**・参照画像あり) |
| 生成日 | 2026-08-21 |
| 参照画像 | TikTok ギフト「DJメガネ」のサムネ(278×328)から**下端のギフト名+コインの帯を切り落とし**(上 210px)、Lanczos で 1668×1260 へ拡大 + `unsharp` |
| 生成パラメータ | `16:9` / `720P` / 導入 `8s`・スピン `5s` / 音声は `Audio:` 句から自動で焼き込み |
| 素の出力 | 1280×720 / **60fps を名乗る容器に真の 24fps・(尺×24+1) フレーム**(導入 193f / スピン 121f)/ H.264 / AAC 44.1kHz |
| コスト | ✦192(8秒)+ ✦120×4(5秒)= **✦672** |
| ウォーターマーク | 左上に "AI" の焼き込みあり(既存の Dreamina 製素材と同じくそのまま出荷) |

加工は `rl/` 共通レシピ(`trim=start_frame=S,settb=1/24,setpts=N` + 2パス loudnorm −16 LUFS
+ 末尾 150ms `afade` + 48kHz + `-crf 28 -preset slow` + `+faststart`)。
**S はすべて頭側**(`S = 素のフレーム数 − 契約フレーム数`)— 見せ場が末尾にあるので詰めるのは頭。

> ## ⚠️ 導入とスピンで**終わり方の要件が逆**
> - **導入**は次のリールへ繋ぐので **終端が完全な静止画**でなければならない。
>   実測の終端フレーム間差分は **0.024**(合格実績 dragon 0.013 / phoenix 0.59 / lion 0.89)。
>   末尾フレーム輝度 59.4 は目安(70〜230)をわずかに下回るが、暗いネオンの絵なので意図どおり
>   (`revolution/result.mp4` の 68.85 と同じ扱い)。
> - **スピン4本**は逆で、**最後の約1秒がカメラへ向かう一撃**で終わる(その一撃がリールを
>   1マス押す既存の演出文法)。動画が尽きたら一撃ポーズの最終フレームで静止し、そこへ
>   `.rl-clip.out` の溶暗が被る。だから終端フレーム間差分が大きくても正しい
>   (実測 3.49 / 32.05 / 0.02 / 9.93)。

プロンプトは5本とも同じ骨格で、被写体の固定句と禁止句を共有している:

> 〈本ごとのモチーフ〉. A glossy 3D cat-like DJ character **exactly matching the reference
> image**, a deep lavender cat-shaped head with glowing cyan neon-outlined cat ears,
> oversized neon cyan and green visor sunglasses with scrolling equalizer scan-lines,
> a violet and blue DJ headphone over one ear. 〈導入は「最後の3秒は完全な静止画」/
> スピンは「IN THE FINAL SECOND … STRAIGHT TOWARD THE CAMERA」〉.
> **Ignore the flat dark grey backdrop of the reference image; it is not part of the character.**
> Pure black background with drifting light motes. Glossy 3D render in the style of a TikTok
> live gift animation, centered composition with the subject inside the middle third of the
> frame, safe for a vertical center crop, high contrast, vivid saturated neon colors.
> Audio: 〈本ごとの音〉.
> **No text, no letters, no numbers, no logos, no watermark, no subtitles, no UI, no people.**

> 著作権の注意は `cut/` / `boost/` / `revolution/` と同じ — TikTok 本家のギフト演出の
> 再現ではなく、ギフトアイコンの題材を参照した完全オリジナル。生成物の利用条件は
> Dreamina (CapCut) の利用規約に従う(**CC0 ではない**)。**再配布可否は未了**。
> 再エンコードにより生成サービスの C2PA コンテンツ来歴ボックスは落ちている。

### ユニコーン / バニーDJ 各5本(導入1 + スピン4)— Dreamina(Seedance 2.0)製・2026-08-22 追加

TikTok ギフト **ユニコーン**(giftId `12453` / `Unicorn` / 2499💎)と
**バニーDJ**(giftId `437679` / `Bunny DJ` / 1200💎)専用の激熱確定。
**このギフトの激熱行だけは抽選を通さず 100% この絵柄**になる(上の表)。
DJメガネ(2026-08-21)と**同じレシピ・同じ契約**で、骨格は一切変えていない。

> ⚠ **スラッグが `unicorn` ではなく `unicorngift`**。`unicorn` は一角獣の
> **通常パターン**(`rl/unicorn-1..4.mp4`)で既に埋まっていて、同名にすると
> `ROULETTE_PATTERNS` が衝突する。`.rl-p-unicorn` と `.rl-p-unicorngift` は別のクラス。

| ファイル | 枠 | モチーフ | 契約 | S | 実測音量 | サイズ |
|---|---|---|---|---|---|---|
| `rl/hot/unicorngift.mp4` | 導入 | 暗闇 → 虹の角が灯りプリズムの光条が開く → 正面で静止 | 192f / 8.000s | 1 | -16.04 LUFS / -2.28 dBTP | 0.73 MB |
| `rl/unicorngift-1.mp4` | 1 | 虹の星雲が裂けて疾走 → 角をレンズへ突き出す | 93f / 3875ms | 28 | -15.48 LUFS / -1.42 dBTP | 0.72 MB |
| `rl/unicorngift-2.mp4` | 2 | 角にプリズムの環が収束 → 虹の閃光がレンズを撃つ | 72f / 3000ms | 49 | -15.92 LUFS / -1.49 dBTP | 0.44 MB |
| `rl/unicorngift-3.mp4` | 3 | 棹立ち → 虹の衝撃波と結晶片が飛ぶ | 57f / 2375ms | 64 | -16.51 LUFS / -1.68 dBTP | 0.78 MB |
| `rl/unicorngift-4.mp4` | 4 | たてがみが虹のリボンの渦になり頭突き | 52f / 2167ms | 69 | -16.07 LUFS / -3.63 dBTP | 0.58 MB |
| `rl/hot/bunnydj.mp4` | 導入 | 暗闇 → バイザーとネオンリングが点灯 → 正面で静止 | 192f / 8.000s | 1 | -16.05 LUFS / -3.48 dBTP | 0.54 MB |
| `rl/bunnydj-1.mp4` | 1 | ターンテーブルにレコードが落ちる → バイザーがレンズへ | 93f / 3875ms | 28 | -16.09 LUFS / -6.60 dBTP | 0.46 MB |
| `rl/bunnydj-2.mp4` | 2 | ミラーボールが割れ、光線が束になってレンズを撃つ | 72f / 3000ms | 49 | -16.31 LUFS / -4.70 dBTP | 0.67 MB |
| `rl/bunnydj-3.mp4` | 3 | バイザーのイコライザーが振り切れ衝撃波が抜ける | 57f / 2375ms | 64 | -16.06 LUFS / -9.12 dBTP | 0.44 MB |
| `rl/bunnydj-4.mp4` | 4 | スピーカーの壁が破れ、うさ耳ごとレンズへ | 52f / 2167ms | 69 | -16.01 LUFS / -7.11 dBTP | 0.35 MB |

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | **Dreamina (CapCut)** / `Dreamina Seedance 2.0`(モード **オムニリファレンス**・参照画像あり) |
| 生成日 | 2026-08-22 |
| 参照画像 | TikTok ギフトのサムネから**下端のギフト名+コインの帯を切り落とし**、Lanczos で拡大 + `unsharp`。ユニコーン 284×296 → 上 200px → 1704×1200 / バニーDJ 279×346 → 上 212px → 1674×1272 |
| 生成パラメータ | `16:9` / `720P` / 導入 `8s`・スピン `5s` / 音声は `Audio:` 句から自動で焼き込み |
| 素の出力 | 1280×720 / **60fps を名乗る容器に真の 24fps・(尺×24+1) フレーム**(導入 193f / スピン 121f)/ H.264 / AAC |
| コスト | (✦192 + ✦120×4) × 2 = **✦1344** |
| ウォーターマーク | 左上に "AI" の焼き込みあり(既存の Dreamina 製素材と同じくそのまま出荷) |

加工は `rl/` 共通レシピ(`trim=start_frame=S,settb=1/24,setpts=N` + 2パス loudnorm −16 LUFS
+ 末尾 150ms `afade` + 48kHz + `-crf 28 -preset slow` + `+faststart`)。
**S はすべて頭側**(`S = 素のフレーム数 − 契約フレーム数`)で、DJメガネと同じ 1 / 28 / 49 / 64 / 69。

> **2パス loudnorm の落とし穴**: 測定パスを `ffmpeg -v error` で回すと
> `print_format=json` の出力(info レベル)ごと消えて `measured_I=` が空になり、
> 2パス目が `Unable to parse option value ""` で落ちる。測定は `-v info` で回すこと。
> また `while read` ループの中で ffmpeg を回すなら **`-nostdin` が必須**
> (ffmpeg がループの stdin を食ってジョブ表が壊れる)。

**終わり方の要件は導入とスピンで逆**(DJメガネの節の ⚠ を参照)。実測値:

- 導入の終端フレーム間差分は **unicorngift 0.002 / bunnydj 0.003** —
  合格実績(djglasses 0.024 / dragon 0.013)より更に静止している。
  プロンプトに「THE LAST THREE SECONDS ARE A COMPLETELY FROZEN STILL IMAGE」+
  動かないものの列挙を入れたのが効いている。
- スピン8本の終端差分は **1.34〜35.63** で、これは**大きくて正しい**
  (最後の約1秒がカメラへの一撃)。
- 末尾フレーム輝度は導入が 55.7 / 32.4。目安(70〜230)は下回るが、暗い背景に
  発光体という絵なので意図どおり(`djglasses` 59.4 / `revolution/result.mp4` 68.85 と同じ扱い)。
- `unicorngift-4` だけ背景が純黒でなく暗いチャコール(参照画像の灰色地の影響)。
  **`.rl-clip` は不透明合成**(`background:#000` / `mix-blend-mode` なし)なので
  合成は壊れない ─ 見た目だけの差で、終端の一撃では被写体が全画面を覆うので実害なし。

プロンプトは10本とも同じ骨格で、被写体の固定句と禁止句を共有している:

> 〈本ごとのモチーフ〉. 〈被写体を `exactly matching the reference image` として列挙:
> ユニコーンは「pure white glossy head / a long smooth spiralling horn glowing in a rainbow
> gradient from golden yellow through green and cyan to violet / a thick voluminous flowing
> mane in candy pink, magenta and violet」、バニーDJは「a pearlescent white headphone
> headband with tall pink-and-white bunny ears / chunky earcups glowing with cyan and violet
> neon rings / a smoked purple visor with a glowing blue-violet lens」〉.
> 〈導入は「THE LAST THREE SECONDS ARE A COMPLETELY FROZEN STILL IMAGE …」/
> スピンは「IN THE FINAL SECOND … STRAIGHT TOWARD THE CAMERA」〉.
> **Ignore the flat dark grey backdrop of the reference image; it is not part of the character.**
> Pure black background with drifting light motes. Glossy 3D render in the style of a TikTok
> live gift animation, centered composition with the subject inside the middle third of the
> frame, safe for a vertical center crop, high contrast, vivid saturated neon colors.
> Audio: 〈本ごとの音〉.
> **No text, no letters, no numbers, no logos, no watermark, no subtitles, no UI, no people.**

> 著作権の注意は DJメガネの節と同じ — TikTok 本家のギフト演出の再現ではなく、
> ギフトアイコンの題材を参照した完全オリジナル。生成物の利用条件は
> Dreamina (CapCut) の利用規約に従う(**CC0 ではない**)。**再配布可否は未了**。
> 再エンコードにより生成サービスの C2PA コンテンツ来歴ボックスは落ちている。

## ハート系4パターン12本 — Higgsfield 製・2026-08-17 追加

ギフト4種をテーマにした**独立した超激アツ4パターン**。パターンごとに動画が2〜4本で、
24秒のスピン中に「動画 → マス移動」を交互に繰り返す既存の文法どおり。

**振り付け(clips の窓・拍・走行キーフレーム)は既存 ultra から1つずつ借りている。**
新規設計をしないので、ウィンドウの不変条件(`roulette-fx.spec.ts`)と cue マーカーの
機械照合(`roulette-css.spec.ts`)が**定義上満たされる**。借り元を動かすときは
借りた側も同じだけ動かすこと。

| パターン | 設定画面のラベル | 借り元の振り付け | 本数 | ウィンドウ長 |
|---|---|---|---|---|
| `heartme` | ハートミー | `phoenix`(rl-run-heartme は rl-run-phoenix の改名コピー) | 4 | 3960 / 3000 / 2400 / 2400ms |
| `hearttouch` | ハートタッチ | `unicorn`(rl-run-hearttouch は rl-run-unicorn の改名コピー) | 2 | 4992 / 4992ms |
| `heartbday` | ハートの誕生日 | `dragon`(rl-run-heartbday は rl-run-dragon の改名コピー) | 3 | 4920 / 3480 / 2520ms |
| `heartbloom` | 花咲ハート | `lion`(rl-run-heartbloom は rl-run-lion の改名コピー) | 3 | 4800 / 3480 / 2496ms |

**4パターンとも既定では出ない(オプトイン)。** `ROULETTE_OPT_IN_PATTERNS`(`shared/challenge.ts`)に
4つとも載っており、`DEFAULT_ROULETTE_PATTERNS` がそれを除いた一覧になる。これが出荷 JSON
(patterns キーを持たない)・`DEFAULT_ROULETTE`・`DEFAULT_JOIN_ROULETTE`・「既定に戻す」・
`sanitizeRoulettePatterns` の欠損フォールバックの**全経路の結論**。出すには設定画面
「ルーレット」タブの焦らしパターンで該当のチェックを入れる。

> **`djglasses` はオプトインではない。** あちらは「チェックすれば出る」= 設定画面に
> チェックが**出る**の意味だが、`djglasses` は**激熱確定専用でギフト連動**なので
> 一覧そのものに出さない。締め出しは dto の `ROULETTE_HOT_ONLY_PATTERNS` →
> `ROULETTE_SELECTABLE_PATTERNS` の差集合1本で、①既定の導出 ②`sanitizeRoulettePatterns`
> の保存時除去 ③設定画面の一覧 ④`drawRoulettePattern` の空フォールバック、の4箇所が
> そこから導かれる。`ROULETTE_OPT_IN_PATTERNS` に入れると (b) チェックが出てしまう。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | **Higgsfield (higgsfield.ai)** / `seedance_2_0`(`mode: std`・t2v・参照画像なし) |
| 生成日 | 2026-08-17 |
| 出力(生成時) | 1280×720 (16:9) / **真の 24fps・121 フレーム** / H.264 / AAC 44.1kHz 音声あり |
| 尺(生成時) | 各 5.04 秒(121f ÷ 24fps) |
| 生成パラメータ | `aspect_ratio: 16:9` / `resolution: 720p` / `duration: 5` / `generate_audio: true` |
| 本数 | heartme 4 / hearttouch 2 / heartbday 3 / heartbloom 3 = 12 |

| ファイル | パターン | モチーフ | 窓ms | N | S | 実尺 | 出力音量 | サイズ |
|---|---|---|---|---|---|---|---|---|
| `heartme-1.mp4` | ハートミー | ロケットが浮上して開く | 3960 | 95 | 26 | 3958ms | -15.97 LUFS / -3.27 dBTP | 1.00 MB |
| `heartme-2.mp4` | ハートミー | 開いたロケットが小さなハートを撃ち出す | 3000 | 72 | 49 | 3000ms | -16.31 LUFS / -4.37 dBTP | 0.70 MB |
| `heartme-3.mp4` | ハートミー | 無数のハートが集まって一つに圧縮される | 2400 | 58 | 63 | 2417ms | -16.06 LUFS / -2.19 dBTP | 0.58 MB |
| `heartme-4.mp4` | ハートミー | 核が爆ぜてハート型の衝撃波 | 2400 | 58 | 63 | 2417ms | -16.02 LUFS / -5.04 dBTP | 1.03 MB |
| `hearttouch-1.mp4` | ハートタッチ | 2つのハートが近づいて触れ合う | 4992 | 120 | 1 | 5000ms | -16.05 LUFS / -2.93 dBTP | 0.91 MB |
| `hearttouch-2.mp4` | ハートタッチ | 互いを回りながら何度も打ち合い融合する | 4992 | 120 | 1 | 5000ms | -16.12 LUFS / -4.19 dBTP | 1.17 MB |
| `heartbday-1.mp4` | ハートの誕生日 | ハート型ケーキのロウソクが順に点く | 4920 | 118 | 3 | 4917ms | -16.98 LUFS / -1.64 dBTP | 1.05 MB |
| `heartbday-2.mp4` | ハートの誕生日 | 炎がハートに編み上がりクラッカーが吹く | 3480 | 84 | 37 | 3500ms | -16.14 LUFS / -2.44 dBTP | 0.92 MB |
| `heartbday-3.mp4` | ハートの誕生日 | ケーキが破裂して衝撃波 | 2520 | 60 | 61 | 2500ms | -15.84 LUFS / -2.88 dBTP | 0.69 MB |
| `heartbloom-1.mp4` | 花咲ハート | ハート型のつぼみが満開に開く | 4800 | 115 | 6 | 4792ms | -17.16 LUFS / -2.48 dBTP | 1.02 MB |
| `heartbloom-2.mp4` | 花咲ハート | つぼみが連鎖して次々に咲く | 3480 | 84 | 37 | 3500ms | -16.41 LUFS / -2.48 dBTP | 1.05 MB |
| `heartbloom-3.mp4` | 花咲ハート | 一輪が閉じてから爆ぜるように開く | 2496 | 60 | 61 | 2500ms | -16.20 LUFS / -2.05 dBTP | 1.10 MB |

## 2026-08-18 追加の8本(Higgsfield 製) — 全パターンを4枠に揃えるため

カウントダウン式の激熱化で **ultra 全パターンが動画4本を要求する**ようになり、
手持ちが足りない5パターンぶんを追加生成した。

| ファイル | パターン | モチーフ | 枠 | 実測 |
|---|---|---|---|---|
| `dragon-4.mp4` | 黄金龍 | 龍の顔が炎を割ってレンズへ | 4 | -15.83 LUFS / -4.49 dBTP |
| `lion-4.mp4` | 獅子 | 獅子が飛び掛かり前脚を叩き付ける | 4 | -16.03 LUFS / -1.80 dBTP |
| `unicorn-3.mp4` | 一角獣 | 角に紫電が充填されて突き出される | 3 | -16.10 LUFS / -1.34 dBTP |
| `unicorn-4.mp4` | 一角獣 | 角がレンズを砕いて紫水晶が飛散 | 4 | -16.09 LUFS / -1.70 dBTP |
| `hearttouch-3.mp4` | ハートタッチ | 融合したハートが脈打って膨張 | 3 | -17.32 LUFS / -1.57 dBTP |
| `hearttouch-4.mp4` | ハートタッチ | ハートが爆ぜて新しい一つが迫る | 4 | -17.47 LUFS / -1.51 dBTP |
| `heartbday-4.mp4` | ハートの誕生日 | フロスティングがハートに固まって迫る | 4 | -16.02 LUFS / -1.91 dBTP |
| `heartbloom-4.mp4` | 花咲ハート | 花芯から光のハートが射出される | 4 | -16.63 LUFS / -1.63 dBTP |

- 生成: Higgsfield `seedance_2_5`(t2v・参照なし)/ 5秒 / 1280×720 / **121フレーム @ 24fps**
  (ハート系12本と同じ)/ 32.5 クレジット×8 = 260。生成日 2026-08-18。
- プロンプトは既存12本と同じ骨格(即アクション / 中央1/3 / 文字・人物禁止 /
  `in the final second it strikes toward the camera` / `CRITICAL FINAL FRAME` 句)。
  **ハート系4本はピンク〜マゼンタ〜金に限定**(緑は応援ルーレットの意味を持つ)。
  龍・獅子は金〜琥珀、一角獣は紫〜金。
- 末尾フレームの検品(罠2の手順)は全8本合格: YAVG 109〜129、被写体がレンズいっぱいで
  質感あり(龍の鱗と眼 / 獅子の鬣と牙 / 角の螺旋 / ハートの光沢と金縁)。
- **`hearttouch-3` と `hearttouch-4` だけ -17.3 / -17.5 LUFS で目標に 1.3〜1.5 LU 届かない。**
  素材のクレスト比が高く、前段ゲインを +8dB まで上げてもリミッタが食うだけで
  整合ラウドネスが上がらなかった(罠3の手当てが効かない側の例)。既存素材も
  -15.84〜-17.16 LUFS の幅があるので、**過剰に潰さずこの値で確定**した。
- ライセンス: **Higgsfield の利用規約に従う(生成時のプラン: Plus)。CC0 ではない。**
  ハート系12本と同じ扱い(2026-08-17 に所有者が再配布「可」と判断済み)。

合計 **11.24MB**。素材はソース zip と `app.asar` の両方に載るので
インストーラは約 +22MB。`-crf 28 -preset slow` は落とさないこと。

**加工内容: 上の Dreamina 16本と同一のレシピ**(`trim=start_frame=<S>,settb=1/24,setpts=N`、
`-crf 28 -preset slow -pix_fmt yuv420p -profile:v high -fps_mode cfr -r 24`、AAC 128k/48kHz/2ch、
`+faststart`、末尾 150ms の `afade`)。`-ss` 禁止・`fps=` 禁止の罠も同じ。
偶然だが **Higgsfield も 121 フレームで返す**ので `S = 121 - N` の式がそのまま使える。

> ## ⚠️ 生成で踏んだ罠3つ(再生成するなら必ず読む)
>
> ### 1. 「終端で画面に向かって一撃」だけ指定すると**真っ白に飛んで終わる**
>
> 初回生成は最終フレームが**ほぼ純白**(輝度 YAVG 252/255)になった。アプリは loop せず
> **最終フレームで静止したまま `.rl-clip.out` の溶暗(480ms)が被る**ので、白い板が
> 0.5 秒出てリールを隠す。既存16本の末尾は YAVG 82〜228 で、明るくても炎・獅子の顔・
> 飛沫といった**質感が必ず残っている**。
> → プロンプトに **`CRITICAL: the last frame must still show ... do NOT end on a white flash,`**
> **`a blown-out white screen, or a fade to white`** を入れる。
>
> ### 2. 白飛び以外にも「静止に耐えない末尾」が3種類ある
>
> 12本を作る過程で、**暗すぎ**(爆発が散った後・YAVG 30)/ **モーションブラーで被写体不明** /
> **平坦な単色の面**(白飛びの色違い)の3本が出た。いずれも0.5秒静止すると破綻する。
> → 効いた書き方は「**最終フレームは被写体がレンズに押し付けられて画面いっぱい**」を
> 具体的に指定し、否定形を並べること:
> `CRITICAL FINAL FRAME: the last frame is completely FILLED by <subject> pressed right`
> `against the lens, sharply focused, brightly lit, with crisp <detail> visible.`
> `The final frame must NOT be dark, NOT empty space with scattered debris,`
> `NOT motion-blurred, NOT a white flash and NOT a flat single-colour field.`
> **再生成のたびに `reverse,trim=end_frame=1` で末尾フレームを抜き、輝度(YAVG 70〜230 が目安)と
> 質感を必ず目視すること。** 数値だけでは平坦な単色を見逃す。
>
> ### 3. 2パス `loudnorm` の `linear=true` だけでは -16 LUFS に届かない本がある
>
> ある素材は真ピークが **-0.20 dBTP** で天井に張り付いており、-16 へ上げるとピーク超過に
> なる。loudnorm はピークを守る側に倒すのでゲインを諦め、**-20.8 LUFS**(目標より 5 LU 小)で
> 出てきた。同じパターンの中で後半の動画だけ音が小さいのは致命的。
> → **必要ゲインがピーク余裕を超える本だけ**、`volume=<必要ゲイン>dB,alimiter=...` を前段に
> 挟んでから正規化する。余裕がある本は従来どおり `linear=true` の2パス loudnorm のまま
> = 既存16本と同じ扱い。
> `alimiter` は**サンプルピーク基準でインターサンプルピークを見ない**ので、天井は目標 TP より
> **1dB 低く**取る(-1.5 狙いなら `limit` は -2.5dBFS 相当の 0.7499)。素の -1.5dBFS で切ったら
> 実測の真ピークが -0.68 dBTP まで出た(既存の最大は -1.21)。

- ライセンス: **Higgsfield の利用規約に従う(生成時のプラン: Plus)。CC0 ではない。**
  **再配布可否は 2026-08-17 にリポジトリ所有者が「可」と判断済み** — AGPL の
  Corresponding Source zip 同梱と `app.asar` 同梱の両方を含む。よってこの12本については
  再確認なしで配布してよい。
  **ただしプランや規約が変わったら判断はやり直しになる**(判断の根拠が Higgsfield の
  規約そのものなので)。上のハート系12本以外は下記のとおり別扱い:
  - `band/` `stock-cutin.mp4` `cut/`(Higgsfield 製・この節より上)と `rl/` の
    Dreamina 製16本・`boost/`(Dreamina 製)は**この判断の対象外**。それぞれの
    ライセンス行に書いてある「再配布前に確認」は**未了のまま**なので、混同しないこと。

## 生成プロンプト(全文の骨格)

共通ガード(全12本): 冒頭から即アクション / 被写体を中央 1/3 に維持(縦ステージで中央
クロップされるため)/ **ピンク〜マゼンタ〜金で統一**(緑は応援ルーレットの意味を持つので
使わない)/ 文字・数字・ロゴ・人物 禁止 / 末尾に `Audio:` 句 /
`in the final second it strikes toward the camera` /
`glossy 3D render in the style of a TikTok live gift animation, centered composition,`
`subject inside the middle third, safe for a vertical center crop` /
そして上の罠1・2の `CRITICAL` 句。

各本のモチーフは上のファイル一覧表の「モチーフ」列がそのまま英語プロンプトの主文に
対応する(例: `heartbday-3` = ハート型ケーキが破裂して、ピンクのフロスティングと金の
スプリンクルのハート型衝撃波が広がり、最後にフロスティングのハートがレンズへ迫る)。
全文は Higgsfield の生成履歴に残っている。

> ## ⚠️ ギフト名は絵のモチーフでしかない
>
> 「ハートタッチ」「ハートの誕生日」「花咲ハート」は**実データ(gift_catalog 153件)・
> git 全履歴・出荷 JSON のどこにも存在しない**(2026-08-17 に横断検索して確認)。
> 実体があるのは「ハートミー」だけ(giftId `7934` / `Heart Me` / 1💎 / gift_type 4)。
> ただし ultra パターンは**行ごとの許可リストで選ぶもので、ギフト一致では発火しない**ため
> giftId は不要。既存の dragon/lion なども実在ギフトの再現ではないのと同じ扱い。
> ギフト単位で出し分けたくなった時に初めて giftId の特定が必要になる。
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

---

# タップブースト(フィーバー)クリップ(`boost/` サブフォルダ)

タップブーストのトリガーギフトが届いたときに再生される、段組みのフルスクリーン演出。
**起動カットイン(5秒)→ カウントダウン(3秒)→ タップウィンドウ(5〜15秒・ループ)→
結果カットシーン(4秒)** の4段で、段ごとに素材を選べる(`shared/challenge.ts` の
`TAP_BOOST_*_CLIPS`)。再生中は worker がカウンタを凍結する(fxFreeze)。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | 黒豹・コーギー: **Dreamina (CapCut)** / `Dreamina Seedance 2.5`(モード **オムニリファレンス**・参照画像あり)<br>ねば〜る君: **Higgsfield** / `seedance_2_5`(`mode: omni_reference`・`image_references`) — **同じ Seedance 2.5 の同じモード**なので絵づくりが揃う |
| 生成日 | 黒豹セット 2026-08-14 / コーギーセット 2026-08-15 / **ねば〜る君セット 2026-08-18** |
| 出力 | 1280×720 (16:9) / 720P / H.264 / **AAC 音声トラックあり**(生成サービスが焼き込む) |
| 参照画像 | 黒豹: TikTok ギフト「黒豹(限定ギフト)」アイコン / コーギー: `IMAGE/2026081402/S__108421123.jpg`(ギフト「コーギー」アイコン。キャプション帯を切り落として5倍に拡大したものを投入) / ねば〜る君: `IMAGE/S__108527621.jpg`(ギフト「ねば〜る君」アイコン 194×193。`hqdn3d` で JPEG ブロックを均してから5倍 lanczos + 軽い `unsharp`) |

| ファイル | 段 | モチーフ | 尺 |
|---|---|---|---|
| `intro-panther.mp4` | 起動カットイン | 宇宙の霧から黒豹が現れて咆哮 | 5.000 秒 |
| `count-321.mp4` | カウントダウン | 黒豹＋星雲に金の数字 3・2・1 | 3.000 秒 |
| `loop-panther.mp4` | タップウィンドウ | 金の「FEVER」＋黒豹＋紫金の星雲 | 15.07 秒 |
| `loop-pachinko.mp4` | タップウィンドウ | ゴールドFEVER(初代・**縦 9:16**) | 10.10 秒 |
| `intro-corgi.mp4` | 起動カットイン | ピンクの星雲からコーギーが現れて吠える | 5.000 秒 |
| `count-corgi.mp4` | カウントダウン | コーギー＋ピンク星雲に金の数字 3・2・1 | 3.000 秒 |
| `loop-corgi.mp4` | タップウィンドウ | 金の「FEVER」＋コーギー＋ピンク星雲 | 15.07 秒 |
| `result-corgi.mp4` | 結果カットシーン | コーギーが着地して決めポーズ→暗く収束 | 4.000 秒 |
| `intro-nebaaru.mp4` | 起動カットイン | 琥珀の星雲からねば〜る君が伸び上がって叫ぶ | 5.000 秒 |
| `count-nebaaru.mp4` | カウントダウン | ねば〜る君＋琥珀星雲に金の数字 3・2・1 | 3.000 秒 |
| `loop-nebaaru.mp4` | タップウィンドウ | 金の「FEVER」＋ねば〜る君＋金のネバネバ糸 | 16.06 秒 |
| `result-nebaaru.mp4` | 結果カットシーン | 着地でネバっと潰れ→決めポーズ→暗く収束 | 4.000 秒 |

加工内容:
- `loop-*.mp4` は**無加工**(Dreamina の書き出しをそのままリネームして格納)。
- `intro-*` / `result-*` は**尺を契約値ちょうどに詰めるためだけに再エンコード**した
  (Dreamina の出力は 5.056 / 4.064 秒。**頭を詰める** — 見せ場の白金フラッシュ・
  暗転が末尾にあるため)。`-c:v libx264 -crf 18 -pix_fmt yuv420p -r 30 -fps_mode cfr`、
  音声は `-c:a aac -b:a 192k -ar 44100 -ac 2`。
- **ねば〜る君セット(Higgsfield)は 24fps。** Higgsfield は `duration` 秒の注文に対し
  **`duration×24+1` フレーム @ 24fps** で返す(`rl/` の8本と同じ挙動)。24fps は
  5.000 / 4.000 / 3.000 秒を全部割り切るので、**フレーム単位で契約尺ちょうどに切れる**:
  - `intro-nebaaru` — 5秒注文 → 121f。頭1フレームを落として **120f = 5.000 秒**
  - `result-nebaaru` — 4秒注文 → 97f。頭1フレームを落として **96f = 4.000 秒**
  - `count-nebaaru` — モデル下限の4秒注文 → 97f。`start_frame=24:end_frame=96` で
    **頭をちょうど 1.000 秒**落として **72f = 3.000 秒**(単純に 25f 落とすと 1.0417 秒
    ズレて、プロンプトで指定した「1秒に1発のパルス」が整数秒から外れる)
  - `loop-nebaaru` — 16秒注文 → 385f = **16.064 秒**。映像は**ストリームコピー(無加工)**、
    音声だけ 32kHz → 44.1kHz へ焼き直した。窓上限 15 秒に対し **1.06 秒の余裕**がある
    (`seedance_2_5` だけ duration 上限が 30 秒なので 16 秒を注文できる。上限 15 秒の
    モデルだと 15.042 秒 = 余裕 42ms しか取れない)
  切り出しは `-ss` ではなく `trim=start_frame=` + `settb=1/24,setpts=N`。
- `count-*.mp4` は**背景だけを生成し、数字 3・2・1 は ffmpeg で後から合成**した。
  AI 動画はフレーム精度の数字を描けないため。数字は PIL で作った RGBA の PNG
  (Segoe UI Black・字高385px・縦グラデ `#FFEAB2`→`#FFB941`・輪郭 `#784900` 11px・
  画面中央 640,360)を `overlay` + `enable='lt(t,1)'` / `'gte(t,1)*lt(t,2)'` / `'gte(t,2)'`
  で焼いたもの。**`between(t,a,b)` は両端を含むので境界フレームが二重描画になる** —
  使ってはいけない。

> ## ⚠️ 不透明フルフレーム — screen 禁止・`.fx-clip-opaque`・音声は素材のもの
>
> `cut/*.mp4` と同族。黒背景発光体ではないので `mix-blend-mode: screen` 禁止、
> `.fx-clip-opaque` で重ねる(配置は `.monitor-root` 直下・z-index なし)。
>
> **段の長さは素材ではなく定数が決める。** `TAP_BOOST_INTRO_MS`(5000)/
> `TAP_BOOST_COUNT_MS`(3000)/ `TAP_BOOST_RESULT_MS`(4000、`shared/boost-settle.ts`)。
> 素材の実尺がこれとズレると、映像だけ先に終わる/途中で切れる。
> **`count-*` は 3・2・1 が映像焼き込みで、`1` の表示開始がタップ開始と同期する契約**
> なので、数字の切り替わりは 1.000 / 2.000 秒ちょうどに載せること
> (検算: `tblend=all_mode=difference` + `signalstats` の YAVG スパイクが `pts_time:1` と
> `pts_time:2` に立つ)。
>
> **タップウィンドウ用の `loop-*` だけは 15 秒以上にする。** タップ窓の上限が
> `TAP_BOOST_DURATION_MAX_SEC`(15秒)なので、15.07 秒あれば**実運用ではループが
> 一周しない** = 継ぎ目が見えない(`loop-panther` / `loop-corgi` はどちらも先頭と末尾が
> 一致していないが、これで実害が出ない)。
>
> 音声は**素材に焼き込まれたもの**をそのまま鳴らす(別 BGM は無い)。モニターは
> `seEnabled` のとき `muted` を外し、音量は
> `effectiveSeVolume(seVolume, seVolumes['boost-start'])` を当てる。
>
> 左上に Dreamina の **"AI" ウォーターマーク**が焼き込まれている(**Dreamina 製の8本のみ** —
> 黒豹4本 + コーギー4本)。Web UI に非表示オプションが見当たらないためそのまま出荷している。
> **ねば〜る君の4本は Higgsfield 製でウォーターマークが無い**(四隅を 64 フレーム時間平均して
> 静止物を浮かせる検査で確認済み。`crop=320:110:0:0,format=gray,tmix=frames=64`)。
> 消す/足すのどちらもせず、混在を許容している — 段はブースト行ごとに選べるので、
> そもそもテーマを跨いだ組み合わせは起こりうる。

## 生成プロンプト(全文)

共通ガード: widescreen 16:9 / 参照画像の被写体を `exactly matching the reference image` で固定 /
`Pure cinematic motion graphics` / 文字・数字・ロゴ・人物 禁止(**loop だけは例外で
「FEVER」の金文字を出す**)/ 末尾に `Audio:` 句で音を指定。

- **intro-panther.mp4**(黒豹の咆哮) — Epic cinematic space fantasy animation, widescreen 16:9. Deep space background with swirling dark violet and gold nebula, stars and galaxies. A majestic black panther with glowing amber eyes exactly matching the reference image emerges from cosmic smoke, fills the frame, then opens its jaws and roars powerfully toward the camera. The roar sends a golden shockwave rippling through space with camera shake and scattering stardust, energy building until the final frame ends on a bright golden flare. Pure cinematic motion graphics, no people, no logos, no text, no numbers, no captions. Audio: deep cosmic rumble, one powerful big-cat roar, escalating synth riser.
- **count-321.mp4**(3・2・1・黒豹) — Cosmic FEVER countdown background, widescreen 16:9. A majestic black panther face with glowing amber eyes exactly matching the reference image looms large in the center of the frame, radiating power, surrounded by swirling golden and deep violet nebula energy, golden lightning arcs and rising sparks, intensity charging up like the last seconds before an explosion. The center of the frame stays clear and dark enough for a large overlay. Strictly NO text, NO numbers, NO letters, NO captions, no people, no coins, no slot machines. Constant escalating energy from first frame to last. Audio: tense escalating riser with deep pulsing heartbeat booms, one pulse per second.
- **loop-panther.mp4**(黒豹コズミックFEVER) — High-energy FEVER TIME celebration loop animation, widescreen 16:9, cosmic black panther theme: a majestic black panther face with glowing amber eyes exactly matching the reference image looming large in the background radiating power, swirling golden and deep violet nebula energy, golden lightning arcs, rotating golden light rays, continuous bursts of golden sparks and confetti, and a huge glowing pulsing golden word FEVER at the top of the frame. No coins, no slot machines, no casino imagery, no people. Constant intensity from the first frame to the last frame so it loops seamlessly, no fade in, no fade out, no ending climax. Pure motion graphics. Audio: fast upbeat electronic festival music with taiko drums and bright bells, constant energy suitable for seamless looping, no ending cadence.
- **intro-corgi.mp4**(コーギーの登場) — Epic cinematic space fantasy animation, widescreen 16:9. Deep space background with swirling hot pink, magenta and gold nebula, stars and galaxies. An adorable glossy 3D cartoon corgi with a big pale pink heart-shaped rear exactly matching the reference image emerges from cosmic pink smoke, fills the frame, then opens its mouth and barks joyfully toward the camera. The bark sends a pink and golden shockwave rippling through space with camera shake and scattering heart-shaped stardust, energy building until the final frame ends on a bright golden flare. Pure cinematic motion graphics, no people, no logos, no text, no numbers, no captions. Audio: deep cosmic rumble, one cheerful puppy bark, escalating synth riser.
- **count-corgi.mp4**(3・2・1・コーギー / 背景のみ生成) — Cosmic FEVER countdown background, widescreen 16:9. An adorable glossy 3D cartoon corgi with a big pale pink heart-shaped rear exactly matching the reference image looms large in the center of the frame, radiating power, surrounded by swirling hot pink, magenta and golden nebula energy, golden lightning arcs and rising heart-shaped sparks, intensity charging up like the last seconds before an explosion. The center of the frame stays clear and dark enough for a large overlay. Strictly NO text, NO numbers, NO letters, NO captions, no people, no coins, no slot machines. Constant escalating energy from first frame to last. Audio: tense escalating riser with deep pulsing heartbeat booms, one pulse per second.
- **loop-corgi.mp4**(コーギーFEVER) — High-energy FEVER TIME celebration loop animation, widescreen 16:9, cosmic corgi theme: an adorable glossy 3D cartoon corgi with a big pale pink heart-shaped rear exactly matching the reference image looming large in the background radiating power, swirling hot pink magenta and golden nebula energy, golden lightning arcs, rotating golden light rays, continuous bursts of golden sparks and heart-shaped confetti, and a huge glowing pulsing golden word FEVER at the top of the frame. No coins, no slot machines, no casino imagery, no people. Constant intensity from the first frame to the last frame so it loops seamlessly, no fade in, no fade out, no ending climax. Pure motion graphics. Audio: fast upbeat electronic festival music with taiko drums and bright bells, constant energy suitable for seamless looping, no ending cadence.
- **result-corgi.mp4**(結果発表・コーギー) — Epic cinematic victory result animation, widescreen 16:9. An adorable glossy 3D cartoon corgi with a big pale pink heart-shaped rear exactly matching the reference image lands in the center of the frame out of a bright golden flash and strikes a proud triumphant pose. A single huge burst of pink and golden god rays sweeps out radially behind it, a dense shower of glowing pink hearts and golden confetti erupts upward and rains down through the frame, two shockwave rings snap outward. The spectacle peaks in the first half, then over the last second the confetti falls away, the rays dim and the frame settles into a calm deep magenta and gold glow with the corgi held proud in the center, ending dark and quiet rather than bright. Pure cinematic motion graphics, no people, no logos, no text, no numbers, no captions. Audio: triumphant fanfare with taiko drum impact and bright bells, decaying to silence in the final half second.

- **intro-nebaaru.mp4**(ねば〜る君の登場) — Epic cinematic space fantasy animation, widescreen 16:9. Deep space background with swirling molten amber, honey gold and caramel orange nebula over a near-black indigo sky, stars and galaxies. A chubby glossy 3D cartoon mascot exactly matching the reference image — a rounded egg-shaped glossy brown body, a tiny stubby stem sprouting from the top of its head, two huge round black eyes with bright white highlights, a small red heart-shaped mouth with a little pink tongue sticking out, a golden-yellow spiral swirl painted on each cheek, two tiny stubby arms at its sides, and a cream-and-white vertically striped lower half with a small blank white label patch on its belly — emerges from a churning cloud of glowing amber goo, stretches upward tall and elastic, snaps back with a squash-and-stretch bounce, fills the frame, then opens its mouth and cries out joyfully toward the camera. The cry sends a golden amber shockwave rippling through space with camera shake, and glowing sticky golden threads stretch outward from its body, twang and snap into showers of honey-gold droplets and sparks, energy building until the final frame ends on a bright golden flare. The label patch on its belly stays completely blank with no writing on it. Ignore the flat grey backdrop of the reference image; it is not part of the character. Pure cinematic motion graphics, no people, no logos, no text, no numbers, no captions. Audio: deep cosmic rumble, one bright comical mascot yell, springy stretching goo sounds, escalating synth riser.
- **count-nebaaru.mp4**(3・2・1・ねば〜る君 / 背景のみ生成) — Cosmic FEVER countdown background, widescreen 16:9. A chubby glossy 3D cartoon mascot exactly matching the reference image — a rounded egg-shaped glossy brown body, a tiny stubby stem sprouting from the top of its head, two huge round black eyes with bright white highlights, a small red heart-shaped mouth with a little pink tongue sticking out, a golden-yellow spiral swirl painted on each cheek, and a cream-and-white vertically striped lower half — looms large in the center of the frame, radiating power, surrounded by swirling molten amber, honey gold and caramel orange nebula energy over a near-black indigo sky, golden lightning arcs, rising sparks and long glowing sticky golden threads stretching and snapping around it, intensity charging up like the last seconds before an explosion. The mascot is lit only from the rim and from behind so the very middle of the frame stays deep, dark and uncluttered — keep all the bright amber energy pushed out toward the edges of the frame, because a large bright overlay will be composited over the exact center. Strictly NO text, NO numbers, NO letters, NO captions, no people, no coins, no slot machines. Ignore the flat grey backdrop of the reference image; it is not part of the character. Constant escalating energy from first frame to last. Audio: tense escalating riser with deep pulsing heartbeat booms, one pulse per second, springy goo stretch sounds underneath.
- **loop-nebaaru.mp4**(ねば〜る君FEVER) — High-energy FEVER TIME celebration loop animation, widescreen 16:9, cosmic sticky-gold mascot theme: a chubby glossy 3D cartoon mascot exactly matching the reference image — a rounded egg-shaped glossy brown body, a tiny stubby stem sprouting from the top of its head, two huge round black eyes with bright white highlights, a small red heart-shaped mouth with a little pink tongue sticking out, a golden-yellow spiral swirl painted on each cheek, and a cream-and-white vertically striped lower half — looming large in the background radiating power, swirling molten amber, honey gold and caramel orange nebula energy over a near-black indigo sky, golden lightning arcs, rotating golden light rays, long glowing sticky golden threads stretching and snapping across the frame, continuous bursts of golden sparks and honey-gold droplet confetti, and a huge glowing pulsing golden word FEVER spelled F-E-V-E-R at the top of the frame. The word FEVER is the ONLY text anywhere in the frame — no other letters, no numbers, no captions. No coins, no slot machines, no casino imagery, no people. Ignore the flat grey backdrop of the reference image; it is not part of the character. Constant intensity from the first frame to the last frame so it loops seamlessly, no fade in, no fade out, no ending climax. Pure motion graphics. Audio: fast upbeat electronic festival music with taiko drums and bright bells, constant energy suitable for seamless looping, no ending cadence.
- **result-nebaaru.mp4**(結果発表・ねば〜る君) — Epic cinematic victory result animation, widescreen 16:9. A chubby glossy 3D cartoon mascot exactly matching the reference image — a rounded egg-shaped glossy brown body, a tiny stubby stem sprouting from the top of its head, two huge round black eyes with bright white highlights, a small red heart-shaped mouth with a little pink tongue sticking out, a golden-yellow spiral swirl painted on each cheek, two tiny stubby arms at its sides, and a cream-and-white vertically striped lower half — drops into the center of the frame out of a bright golden flash, lands with a gooey elastic squash and springs up into a proud triumphant pose. A single huge burst of amber and golden god rays sweeps out radially behind it, a dense shower of honey-gold droplets and glowing caramel confetti erupts upward and rains down through the frame, long sticky golden threads snap outward, two shockwave rings snap outward. The spectacle peaks in the first half, then over the last second the confetti falls away, the rays dim and the frame settles into a calm deep amber and dark indigo glow with the mascot held proud in the center, ending dark and quiet rather than bright. Ignore the flat grey backdrop of the reference image; it is not part of the character. Pure cinematic motion graphics, no people, no logos, no text, no numbers, no captions. Audio: triumphant fanfare with taiko drum impact and bright bells plus one springy goo boing on the landing, decaying to silence in the final half second.

> **ねば〜る君セットのプロンプトだけ 2 つ足してある。** ①`Ignore the flat grey backdrop of
> the reference image; it is not part of the character.` — 参照画像がギフト一覧のスクショで
> 背景が濃いグレー(`#2E2E2E`)の板になっており、これを絵の一部と誤認させないため。
> ②腹の名札は `a small blank white label patch` と**白い無地の札**として書いた —
> 実物の名札には日本語が入っており、「文字禁止」の指示と矛盾してモデルが崩れた文字を
> 描くのを避けるため(それでも intro には名札の文字が出たが、キャラの一部として読めるので許容した)。
> 色テーマは黒豹=紫+金 / コーギー=ホットピンク+金 に対し **ねば〜る君=琥珀+ハニーゴールド**で、
> 3セットの色相が綺麗に分かれる。固有モチーフの**金色のネバネバ糸**(`sticky golden threads`)は
> 全面カット `cut-nebaaru` の `stretchy glossy goo strands` と同系で、既存素材と地続きになっている。

`loop-pachinko.mp4` は初代の縦 9:16 素材で、**生成来歴の記録が残っていない**
(横ステージでは大きくクロップされるため既定では使わない)。

> **結果カットシーンは `result-corgi.mp4` が初の同梱素材で、`result-nebaaru.mp4` が2本目。**
> カタログには `result-panther` も在るが mp4 は未同梱で、選ぶと4秒の暗幕になる
> (`boostClipUrl` は 0 件許容 glob なので落ちはしない)。かつて黒豹行の既定が
> `resultClip: 'off'` だったのはこのため。**settingsVersion 9 で既定はねば〜る君に
> 差し替わり、4段すべて素材が揃ったので `resultClip` も実 id を既定にしている。**

> 著作権の注意は `gift/` / `band/` / `cut/` と同じ — TikTok 本家のギフト演出の再現ではなく、
> アイコンの題材を参照した完全オリジナル。生成物の利用条件は、黒豹・コーギーは
> Dreamina (CapCut)、**ねば〜る君は Higgsfield(生成時のプラン: Plus)**の利用規約に従う。
> どちらも CC0 ではない。**再エンコードした素材は生成サービスが埋める C2PA の
> コンテンツ来歴(`uuid`/`jumb` ボックス)が落ちている**点に注意
> (Dreamina の3本 + ねば〜る君の intro / count / result。`loop-nebaaru` は映像
> ストリームコピーだが `-map_metadata -1` を通しているので同様)。

---

# お邪魔(タップ封じ)の導入カットイン — `tap-lock/intro.mp4`・Dreamina(Seedance 2.5)製・2026-08-20 追加

| 項目 | 値 |
|---|---|
| 生成サービス | Dreamina / CapCut (https://dreamina.capcut.com) |
| モデル | `Dreamina Seedance 2.5`、モード = **オムニリファレンス**(参照画像1枚 + テキスト) |
| 参照画像 | TikTok ギフト **Boxing Gloves**(giftId 6007 / 299💎)のアイコン |
| 生成日 | 2026-08-20 |
| 出力(素の状態) | 1280×720 / 121フレーム / **AAC 音声あり**(44.1kHz stereo) / 5.056 秒 |
| 同梱の実尺 | **5.000 秒ちょうど**(120フレーム @ 真の 24fps CFR) |

用途スロット: **お邪魔(tapLock)の発動直後に1回だけ流す不透明フルフレーム**。
尺の契約は `shared/challenge.ts` の `TAP_LOCK_INTRO_MS`(5000)。

## 参照画像の前処理(必須だった)

ギフトアイコンの原寸は **215×181** で、Dreamina は「素材が小さすぎます」で受け付けない。
lanczos で 6 倍に上げてから渡した(参照は形と色しか読まれないので、拡大のボケは実害なし):

```
-vf "scale=1290:1086:flags=lanczos,unsharp=5:5:0.8:5:5:0.0" -q:v 2
```

## 加工内容(尺を契約値ちょうどに詰める再エンコード)

Seedance は `duration` 秒の注文に対し **`duration×24+1` フレーム**で返す
(`rl/` の8本・ねば〜る君セットと同じ挙動)。**頭を1フレーム落として 120f = 5.000 秒**
にした — 見せ場(ガラスが割れて暗く沈む)が末尾にあるので、詰めるのは必ず頭側。

> ⚠ **Dreamina のこの出力は 60fps コンテナに載った VFR**(pts が 0, 0.050, 0.0833,
> 0.1333 … と 1/60 の飛び飛び)で、`r_frame_rate` を素直に読むと 60 に見える。
> 中身は 24fps なので、`-ss` の秒指定ではなく **`trim=start_frame=` + `settb=1/24`
> + `setpts=N` で打ち直す**こと(CREDITS の `rl/` 節と同じ罠)。

```
ffmpeg -i <raw>.mp4 \
  -filter_complex "[0:v]trim=start_frame=1,settb=1/24,setpts=N[v];[0:a]atrim=start=0.0416667,asetpts=PTS-STARTPTS[a]" \
  -map "[v]" -map "[a]" -t 5 \
  -c:v libx264 -crf 18 -pix_fmt yuv420p -r 24 -fps_mode cfr \
  -c:a aac -b:a 192k -ar 44100 -ac 2 -movflags +faststart intro.mp4
```

音声も同じ 1/24 秒だけ頭を落として A/V のズレを作らない(実測 mean -21.7dB / peak -3.1dB)。

## ⚠️ 不透明フルフレーム — screen 禁止・`.fx-clip-opaque`・音声は素材のもの

`cut/*.mp4` と同族。黒背景発光体ではないので `mix-blend-mode: screen` 禁止、
`.fx-clip-opaque` で重ねる(配置は `.monitor-root` 直下・z-index なし)。

**段の長さは素材ではなく定数が決める**(`TAP_LOCK_INTRO_MS`)。モニターは `onEnded` を
使わず JS タイマーで打ち切る。

音声は**素材に焼き込まれたもの**をそのまま鳴らす(別 BGM は無い)。モニターは
`seEnabled` のとき `muted` を外し、音量は
`effectiveSeVolume(seVolume, seVolumes['comment'])` を当てる —
**お邪魔が元から使っている `comment` スロットの流用**で、専用スロットは足していない
(新キーは保存済み `settings.json` に届かないため)。

> **封印はこの5秒を待たない。** worker はギフト一致の瞬間に絶対期限をラッチするので、
> 幕の裏で残り時間は普通に減る(既定 30 秒なら明けた時点で残り 25 秒)。
> だから入口ガード(`tapLockWillStart`)は「実尺 ≥ 5 秒」を要求する —
> 封印より導入が長いと、動画が明けた時点でもう解けていて何が起きたか分からない。
> 凍結は `test/unit/tap-lock-cutin.spec.ts`。

左上に Dreamina の **"AI" ウォーターマーク**が焼き込まれている(黒豹4本 + コーギー4本と
同じ扱い)。Web UI に非表示オプションが見当たらないためそのまま出荷している。

## 生成プロンプト(全文)

共通ガード: widescreen 16:9 / 参照画像の被写体を `exactly matching the reference image` で固定 /
`Pure cinematic motion graphics` / 文字・数字・ロゴ・人物 禁止 / 末尾に `Audio:` 句。
参照画像の背景(濃いグレーの地)は被写体ではないと明示するのは `intro-nebaaru` と同じ手口。

- **tap-lock/intro.mp4**(画面を殴って封印) — Epic cinematic first-person impact animation, widescreen 16:9. Deep dark violet and near-black background with swirling smoke and crackling purple energy. A pair of glossy 3D cartoon boxing gloves exactly matching the reference image, a crimson red glove and a bright blue glove with a white wrist wrap and violet striped cuff, swing in from the sides, then the red glove lunges straight at the camera and lands a heavy punch directly into the lens. The impact snaps the frame with violent camera shake, a white-hot shockwave ring bursts outward, and jagged cracks spread across the whole screen like shattering glass. Purple and magenta energy floods through the cracks, the light drains away, and the frame settles into a dark sealed violet glow with the two gloves crossed in the center. Ignore the flat dark grey backdrop of the reference image, it is not part of the subject. Pure cinematic motion graphics, no people, no logos, no text, no numbers, no captions. Audio: a fast whoosh of air, one heavy bone-deep punch impact with a glass-shatter crack, then a low descending buzzer drone that decays to silence.

> 著作権の注意は `cut/` / `boost/` と同じ — TikTok 本家のギフト演出の再現ではなく、
> アイコンの題材を参照した完全オリジナル。生成物の利用条件は Dreamina (CapCut) の
> 利用規約に従う(CC0 ではない)。再エンコードにより生成サービスの C2PA
> コンテンツ来歴ボックスは落ちている。


## 革命の導入と結果の全画面動画2本 — `revolution/` ・Dreamina (CapCut) 製・2026-08-20 追加

カウントダウンチャレンジのお助け「革命」(白鳥 / Swan 699💎)の山場を挟む2本。
**導入**は窓が開く前の 8 秒(このあと画面一杯の 5..1 カウントダウンが 5 秒続く)、
**結果**は窓が満了した瞬間の 6 秒で、この動画の**上に**戦果(減算合計 / タップ回数 /
いいね反転)を重ねて発表する。**導入と結果は尺が違う**(導入は山場、結果は数字を読ませるだけ)。

| ファイル | 段 | モチーフ | 尺 | N | S | 実尺 | 出力音量 | サイズ |
|---|---|---|---|---|---|---|---|---|
| `revolution/intro.mp4` | 導入(`REVOLUTION_INTRO_MS`) | 闇の中の白鳥に装甲が飛来して装着され、完全武装の戦闘態勢へ(戦闘モード突入) | 8.000秒 | 192 | 1 | 8.000秒 | -16.55 LUFS / -1.24 dBTP | 1.13 MB |
| `revolution/result.mp4` | 結果(`REVOLUTION_RESULT_MS`) | 白鳥が翼を畳み、深紅の残光へ静かに沈む | 6.000秒 | 144 | 1 | 6.000秒 | -16.32 LUFS / -1.44 dBTP | 0.41 MB |

> **導入は 2026-08-20 に 6 秒 → 8 秒へ差し替えた**(ユーザー要件「戦闘モードに入るような演出」)。
> 初版は「翼を広げて放射状の光」の 6 秒(144f・-16.76 LUFS / 0.43 MB)。尺の権威は
> `REVOLUTION_INTRO_MS` なので、**定数と素材のフレーム数は必ず一緒に変えること**
> (前置き合計も 11 秒 → 13 秒になる — 設定画面の説明文は定数から導出しているので自動追随)。

**置き場所は `revolution/` サブディレクトリ。** 理由は `rl/hot/` と同じで、直下に置くと
既存カタログの孤児検査を踏む。読み込みは専用 glob(`renderer/lib/fx.ts` の
`REVOLUTION_INTRO_CLIP_URL` / `REVOLUTION_RESULT_CLIP_URL`)で、**0件許容**なので
ファイルを置くだけで差し替わる(intro 投入前は `rl/hot/dragon.mp4` を 6 秒で打ち切って
仮流用していた。この節の追加でその仮流用は終了)。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | **Dreamina (CapCut)** / `Dreamina Seedance 2.5`(モード **オムニリファレンス**・参照画像あり) |
| 生成日 | 2026-08-20 |
| 参照画像 | TikTok ギフト「白鳥」のサムネ(272×231)から下端のギフト名の帯を切り落とし、被写体を寄せて Lanczos で 1020×900 へ拡大したもの |
| 生成パラメータ | `16:9` / `720P` / 尺は本ごと(導入 `8s` / 結果 `6s`)/ 音声は Seedance 2.5 が `Audio:` 句から自動で焼き込む(専用トグルは無い) |
| 素の出力 | 1280×720 / **60fps を名乗る容器に真の 24fps・(尺×24+1) フレーム**(導入 193f = 8.0167秒 / 結果 145f = 6.0167秒)/ H.264 / AAC 44.1kHz |
| コスト | 288 クレジット(6秒)/ 384 クレジット(8秒)。導入は 6 秒版と 8 秒版で2回生成している |
| ウォーターマーク | 左上に "AI" の焼き込みあり(非表示オプションが見当たらず、既存の Dreamina 製素材と同じくそのまま出荷) |

加工内容: **上の `rl/hot` と同一のレシピ**(頭 1 フレームを落としてフレーム数ちょうど —
導入は 192f = 8.000 秒、結果は 144f = 6.000 秒)。

```
# S=1(頭を1フレーム落とす)、N は本ごと(導入 192 / 結果 144)。
# measured_* は本ごとに2パス loudnorm で実測した値
ffmpeg -y -i raw.mp4 -filter_complex \
 "[0:v]trim=start_frame=1:end_frame=1+N,settb=1/24,setpts=N[v];\
  [0:a]atrim=start=0.041667:duration=N/24,asetpts=PTS-STARTPTS,\
       loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=<II>:measured_TP=<ITP>:measured_LRA=<ILRA>:measured_thresh=<ITH>:offset=<OFF>:linear=true,\
       afade=t=out:st=N/24-0.15:d=0.15,aresample=48000[a]" \
 -map "[v]" -map "[a]" -map_metadata -1 \
 -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -profile:v high -fps_mode cfr -r 24 \
 -c:a aac -b:a 128k -ac 2 -ar 48000 -movflags +faststart out.mp4
```

実測: intro(8秒版)が `input_i=-21.63 / input_tp=-2.30`、result が
`input_i=-33.07 / input_tp=-15.59`(6秒版 intro は `-22.07 / -3.24` だった)。
どれもピーク余裕が十分あるので `linear=true` がそのまま効き、前段の
`volume=…,alimiter=…` は要らなかった。

> ## ⚠️ 頭を詰める(末尾ではない)
> 余分な 1 フレームは**先頭**から落とす。どの本も見せ場と締めが末尾にあり、
> `THE LAST TWO SECONDS ARE A COMPLETELY FROZEN STILL IMAGE` で終端を静止させてあるため
> (末尾を削るとその静止が痩せる)。終端フレーム間差分の実測は
> **intro(8秒版)0.084** / result 0.141(6秒版 intro は 0.140)。
> `rl/hot` の合格実績は lion 0.89 / phoenix 0.59 / dragon 0.013。
> 末尾フレーム輝度は intro 96.96 / result 68.85(目安 70〜230 — result は
> `ending dark and quiet` の指定どおりなので下振れは意図どおり)。
> 後処理後の末尾フレームは元素材と一致(PSNR 39.7 dB — crf 28 の再エンコードぶんの差)。

> ## ⚠️ `result.mp4` は「中央を空ける」指定が効いていない
> `count-*.mp4` と同じ `THE CENTER OF THE FRAME STAYS CLEAR, DEEP AND DARK AND UNCLUTTERED`
> を入れたが、生成物は白鳥が中央に来た。**そのまま採用している** — 数字は
> `.revolution-settle .rs-main` の暗いパネル(`rgba(20,2,6,.72)` + 内側リング)の上に
> 置くので可読性は担保される(`boost/result-*.mp4` も被写体は中央で、同じ作りで出荷済み)。
> 撮り直すなら、この句だけでは足りないので `rl/hot` の終端指定と同じく
> **「中央に置かないもの」を列挙する**書き方へ変えること。

## 生成プロンプト(全文)

共通ガード: `centered composition, subject inside the middle third of the frame,
safe for a vertical center crop` / 文字・数字・ロゴ・人物・ウォーターマーク 禁止 /
末尾に `Audio:` 句 / 参照画像の背景(フラットな暗いグレーの板)は被写体ではないと明示
(`intro-nebaaru` / `result-nebaaru` と同じ手口)。

- **revolution/intro.mp4**(8秒・戦闘モード突入 — 出荷版) — A regal white swan with a small golden crown and a glowing green clover at its breast stands in darkness, head bowed. Crimson alarm light sweeps across the frame twice and the swan snaps its head up, eyes flaring white. Shards of luminous armour plating rush in from off-screen and lock onto its wings and breast with hard metallic impacts, a banner of light unfurls behind it, and the swan slams into a wide-winged battle stance as red and white energy blazes outward in a shockwave. Fast aggressive push-in with two hard shutter flashes, like a fighting game entering battle mode. THE LAST TWO SECONDS ARE A COMPLETELY FROZEN STILL IMAGE: absolutely no motion of any kind, the wings stop moving, the armour stops glinting, no flickering, no embers drifting, no particles floating, no camera movement, the swan held in a battle-ready pose facing the viewer head-on, filling the center of the frame, exactly like a paused freeze-frame. Ignore the flat grey backdrop of the reference image; it is not part of the character. Pure black background with drifting embers and crimson volumetric god rays. Glossy 3D render in the style of a TikTok live gift animation, centered composition with the subject inside the middle third of the frame, safe for a vertical center crop, high contrast, vivid saturated colors. Audio: a rising alarm siren and pounding war drums building to a huge metallic clang and a brass battle horn blast, then a low rolling boom. No text, no letters, no numbers, no logos, no watermark, no subtitles, no UI, no people.

- **revolution/intro.mp4**(6秒・初版 — 差し替え済み。記録として残す) — A regal white swan with a small golden crown and a glowing green clover at its breast stands in darkness. It slowly lifts its head, then sweeps its huge feathered wings wide open, releasing a radial shockwave of white and blue light that floods the frame. Slow steady push-in. THE LAST TWO SECONDS ARE A COMPLETELY FROZEN STILL IMAGE: … (以下、終端指定と共通ガードは 8 秒版と同じ). Audio: a rush of beating wings building to one huge brass fanfare hit and a low rolling boom.

- **revolution/result.mp4** — A regal white swan with a small golden crown and a glowing green clover at its breast settles LOW at the BOTTOM of the frame, slowly folding its huge wings closed while fine points of light drift down along the edges. The spectacle peaks in the first half, then the light dims and the frame settles into a calm deep crimson and pearl glow, ending dark and quiet rather than bright. THE CENTER OF THE FRAME STAYS CLEAR, DEEP AND DARK AND UNCLUTTERED: the swan is lit only from the rim and from behind, and all bright light is pushed out toward the edges of the frame, because a large bright overlay will be composited over the exact center. THE LAST TWO SECONDS ARE A COMPLETELY FROZEN STILL IMAGE: absolutely no motion of any kind, the wings stop moving, no flickering, no particles drifting, no camera movement, exactly like a paused freeze-frame. Ignore the flat grey backdrop of the reference image; it is not part of the character. Glossy 3D render in the style of a TikTok live gift animation, safe for a vertical center crop, high contrast, volumetric light. Audio: soft chimes and one closing bell impact, decaying to silence in the final half second. No text, no letters, no numbers, no logos, no watermark, no subtitles, no UI, no people.

> 著作権の注意は `cut/` / `boost/` と同じ — TikTok 本家のギフト演出の再現ではなく、
> ギフトアイコンの題材を参照した完全オリジナル。生成物の利用条件は Dreamina (CapCut) の
> 利用規約に従う(**CC0 ではない**)。**再配布可否は未了** — `rl/` の Dreamina 製16本や
> `boost/` と同じ扱いで、Higgsfield 製ハート系12本の「2026-08-17 に判断済み」とは
> 混同しないこと。再エンコードにより生成サービスの C2PA コンテンツ来歴ボックスは落ちている。

---

## お題ルーレットの導入全画面動画 — `quiz/intro.mp4`・Dreamina (CapCut) 製・2026-08-22 追加

カウントダウンチャレンジの「お題ルーレット」(quiz) が発動した瞬間に流す **8 秒の不透明フルフレーム**。
このあと全画面のお題回転(`QUIZ_SPIN_MS` **18 秒**)→ お題決定(`QUIZ_REVEAL_MS` **4 秒**)と
続くので、前置きは合計 **30 秒**(+ お題発表準備 `prepSec` 既定 5 秒)になる
(2026-08-22 に回転を 6→18 秒・決定を 2.5→4 秒へ — ユーザー指定「回転は今の3倍・焦らしをたっぷり」)。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | **Dreamina (CapCut)** / `Dreamina Seedance 2.0`(**テキストのみ = 参照画像なし**) |
| 生成日 | 2026-08-22 |
| 生成パラメータ | `16:9` / `720P` / `8s`。音声は `Audio:` 句から自動で焼き込み(専用トグルは無い) |
| コスト | **✦192**(8 秒)。1 回で採用、撮り直しなし |
| 素の出力 | 1280×720 / **60fps を名乗る容器に真の 24fps・193 フレーム**(8.057 秒)/ H.264 / AAC 44.1kHz stereo / 7.04MB |
| 同梱の実尺 | **8.000 秒ちょうど**(192 フレーム @ 真の 24fps CFR)/ **1.03MB** |
| 出力音量 | **-16.1 LUFS / -1.5 dBTP**(LRA 3.3) |
| ウォーターマーク | 左上に "AI" の焼き込みあり(非表示オプションが見当たらず、既存の Dreamina 製素材と同じくそのまま出荷) |

モチーフ: 暗転 → スポットライト2灯 → 赤金の緞帳が中央から開く → 金屏風・赤提灯の高座に
色違いの着物(橙 / 青緑 / 桃)のキャラ3体が座布団に並び、一斉に扇子を開く → 前面に巨大な
光る回転盤が降りてきて高速回転、金の紙吹雪 → **終端は完全な静止画**。

**参照画像を使っていないのは意図** — お題ルーレットには既定のトリガーギフトが無く
(`DEFAULT_QUIZ_RULE` の `giftId` は空)、参照すべきアイコンが存在しないため。
「ギフト風」の見た目は `Glossy 3D render in the style of a TikTok live gift animation` の
一句だけで担保している(`rl/hot/djglasses` などと同じ文言)。

**置き場所は `quiz/` サブディレクトリ。** 理由は `rl/hot/` `revolution/` `tap-lock/` と同じで、
直下に置くと `test/unit/fx-catalog.spec.ts` の「直下の mp4 に未知の孤児が無い」に引っかかる。
読み込みは専用 glob(`renderer/lib/fx.ts` の `QUIZ_INTRO_CLIP_URL`)で **0 件許容** —
ファイルを消しても `startQuizFx` が導入だけ飛ばして回転から始まる(黒画面にはならない)。

### 選ばれ方 — 番兵 `QUIZ_INTRO_SELF`

`QuizConfig.introClip` は3通りの値を取る(`shared/challenge.ts` の `validateQuiz`):

| 値 | 意味 |
|---|---|
| `'quiz'`(= `QUIZ_INTRO_SELF`・**既定**) | この専用素材 |
| `'off'` | 導入なし(回転から開始・前置きは 8.5 秒に縮む) |
| `cut-*` | 全面カットのカタログから差し替え |

**モニターは番兵を `fxClipUrl` より先に分岐する**(`MonitorView` の `startQuizFx`)。
専用素材は `FX_CLIPS` のカタログに載っていないので、順序を逆にすると `'quiz'` が
未知 id 扱いで `null` になり、既定の導入が黙って消える(`test/renderer/quiz-fx.spec.ts` で凍結)。

> 既定を `'quiz'` にしたので **`SETTINGS_VERSION` 10 → 11 + `migrateChallengeQuizIntro`** が要る。
> v0.13.0 が配った `'off'` は「導入は要らない」ではなく「**専用素材がまだ無い**」という意味
> だったので、**`'off'` ちょうどのときだけ**引き上げ、`cut-*` の指名は尊重する。

### 加工内容(`revolution/` と同一のレシピ)

Seedance は `duration` 秒の注文に対し **`duration×24+1` フレーム**で返す。頭を 1 フレーム
落として 192f = 8.000 秒にした(見せ場と終端の静止が末尾にあるので、詰めるのは必ず頭側)。

```
# 1パス目で実測 → input_i=-18.75 / input_tp=-1.92 / input_lra=4.20 / input_thresh=-29.54 / offset=0.36
ffmpeg -y -i raw.mp4 -filter_complex \
 "[0:v]trim=start_frame=1:end_frame=193,settb=1/24,setpts=N[v];\
  [0:a]atrim=start=0.0416667:duration=8,asetpts=PTS-STARTPTS,\
       loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-18.75:measured_TP=-1.92:measured_LRA=4.20:measured_thresh=-29.54:offset=0.36:linear=true,\
       afade=t=out:st=7.85:d=0.15,aresample=48000[a]" \
 -map "[v]" -map "[a]" -map_metadata -1 \
 -c:v libx264 -crf 28 -preset slow -pix_fmt yuv420p -profile:v high -fps_mode cfr -r 24 \
 -c:a aac -b:a 128k -ac 2 -ar 48000 -movflags +faststart intro.mp4
```

> ⚠ **この素材はピーク余裕が足りず `linear=true` は素通りしていない。**
> 目標 -16 LUFS には +2.75dB 要るのに素の真ピークが -1.92 dBTP しかないので、
> loudnorm は dynamic へ落ちている。実害が無いのは **LRA が 4.20 と狭く、
> dynamic でもほぼ一定ゲインにしかならない**から(実測 LRA 3.3 / TP -1.5 で着地)。
> 撮り直して LRA が広い素材になったときは、`revolution/` の注記どおり
> 前段に `volume=…,alimiter=…` を挟んで linear へ戻すこと。

実測(合格基準は `rl/hot` 節と同じ):

| 項目 | 実測 | 目安 |
|---|---|---|
| フレーム数 / 実尺 | 192f / 8.000 秒 | 契約ちょうど |
| 終端フレーム間差分(平均輝度) | **0.006**(7.5〜8.0 秒) | < 1.0(実績 dragon 0.013 / djglasses 0.024 / revolution 0.084) |
| 末尾フレーム輝度 | 97.04 | 70〜230 |
| 頭の暗転 | 1 フレームのみ(t=0 で YAVG 14 → 0.25 秒で 55) | 立ち上がりを捨てていない |

> **静止は約 3 秒ある**(t≒5.0 秒以降ほぼ不動)。指定は「最後の 2 秒」だったが、
> Seedance は `rl/hot/dragon` のときと同じく指定より長めに止める。次の段が
> 全画面テキストの回転なので繋ぎは問題ないが、**動きを 6 秒使いたいなら
> 「THE LAST ONE SECOND」へ縮めて撮り直す**こと。

> ## ⚠️ 不透明フルフレーム — screen 禁止・`.fx-clip-opaque`・音声は素材のもの
>
> `cut/*.mp4` `tap-lock/intro.mp4` と同族。黒背景発光体ではないので
> `mix-blend-mode: screen` 禁止、`.fx-clip-opaque` で重ねる
> (配置は `.monitor-root` 直下・z-index なし)。
>
> **段の長さは素材ではなく定数が決める**(`QUIZ_INTRO_MS` = 8000)。モニターは `onEnded` を
> 使わず JS タイマーで打ち切り、終端 400ms は `.out` でフェードさせる。
> **導入ホルダーは `loop` も `onEnded` も持たない** — `cut-*`(5.06 秒)へ差し替えると
> 素材が尽きたあと最終フレームで静止したまま残り約 3 秒待つ(黒画面にも巻き戻りにもならない)。
>
> 音声は**素材に焼き込まれたもの**。モニターは `seEnabled` のとき `muted` を外し、
> 音量は **`quiz.bgmVolume`**(既定 70)を当てる — `giftFullCut.volume` と同じ
> 「絶対値・全体音量を掛けない」流儀。
>
> **尺を変えるときは `QUIZ_INTRO_MS` と素材のフレーム数を必ず一緒に動かすこと。**
> 設定画面の前置き秒数の表示は定数から導出しているので自動追随する。

### 生成プロンプト(全文)

共通ガードは `revolution/` と同じ(中央・正面・終端で静止 / 文字・ロゴ・ウォーターマーク禁止 /
末尾に `Audio:` 句)。**人物禁止だけは外している** — 大喜利の題材なのでキャラが要る。
代わりに「**完全に架空・実在の人物に似せない・実在の番組の意匠を使わない**」を明示した。

> Festive Japanese vaudeville stage opening, widescreen 16:9. In darkness two warm spotlights snap on and a deep crimson-and-gold stage curtain sweeps open from the center. Behind it a raised wooden stage is revealed: a gold folding screen backdrop and glowing red paper lanterns hanging on both sides, with a compact row of three original invented stylized 3D cartoon characters in brightly colored kimono, orange, teal and magenta, sitting on square silk cushions, who all snap open round paper folding fans in unison and grin. A giant glossy 3D prize wheel then drops into the center in front of them and spins up fast with heavy motion blur, its segments in vivid candy colors with gold trim, throwing gold sparkles and confetti across the frame. THE LAST TWO SECONDS ARE A COMPLETELY FROZEN STILL IMAGE: absolutely no motion of any kind, the wheel is held frozen mid-spin as a single motion-blurred still, the characters hold their pose with fans raised, no flickering, no confetti drifting, no sparkles moving, no camera movement, exactly like a paused freeze-frame. The wheel and the row of characters stay inside the middle third of the frame, safe for a vertical center crop. The characters are completely fictional cartoon designs with simple stylized faces, not resembling any real person, no celebrity likeness, no existing television programme, no broadcast branding of any kind. Glossy 3D render in the style of a TikTok live gift animation, centered symmetrical composition, high contrast, vivid saturated colors, volumetric light. Audio: a bright festive Japanese entrance fanfare, a wooden clapper crack, plucked shamisen, taiko drum hits and hand claps as the curtain opens, a rising whoosh as the wheel spins up, ending with one big gong hit and a cheerful bell flourish decaying toward silence in the final half second. No text, no letters, no numbers, no logos, no watermark, no subtitles, no UI.

> ## 著作権について
>
> **実在のテレビ番組を題材にしていない。** 番組名・ロゴ・テーマ曲・セットの意匠・出演者の
> 似姿はいずれも使わず、**寄席 / 大喜利 / 出囃子という一般的な文化的題材**として構成した
> (プロンプトにも `no existing television programme, no broadcast branding of any kind` と
> `not resembling any real person, no celebrity likeness` を明示してある)。生成物のキャラは
> 顔の造作を持たないデフォルメ人形で、特定の人物に紐づかない。
>
> 生成物の利用条件は Dreamina (CapCut) の利用規約に従う(**CC0 ではない**)。
> **再配布可否は未了** — `rl/` の Dreamina 製16本・`boost/` `revolution/` `tap-lock/` と
> 同じ扱い。再エンコードにより生成サービスの C2PA コンテンツ来歴ボックスは落ちている。

---

## お題ルーレットの結果発表カットシーン — `quiz/result.mp4`・Dreamina (CapCut) 製・2026-08-22 追加

投票が締め切られた瞬間に流す **6 秒の不透明フルフレーム**(`QUIZ_RESULT_MS`)。
この映像の**上に**票数 → 判定 → ±N を重ねて発表する(`.quiz-settle`)。

| 項目 | 値 |
|---|---|
| 生成サービス / モデル | **Dreamina (CapCut)** / `Dreamina Seedance 2.0`(**テキストのみ = 参照画像なし**) |
| 生成日 | 2026-08-22 |
| 生成パラメータ | `16:9` / `720P` / `6s`。音声は `音は…` の一句から自動で焼き込み |
| コスト | **✦144**(6 秒 × 24)。1 回で採用、撮り直しなし |
| 素の出力 | 1280×720 / **60fps を名乗る容器に真の 24fps・145 フレーム**(6.017 秒)/ H.264 / AAC / 5.21MB |
| 同梱の実尺 | **6.000 秒ちょうど**(144 フレーム @ 真の 24fps CFR)/ **1.98MB** |
| 出力音量 | **-17.7 LUFS / -1.5 dBTP**(2 パス loudnorm + 末尾 150ms afade) |
| ウォーターマーク | `quiz/intro.mp4` と同じく左上に "AI" の焼き込みあり |

モチーフ: 寄席の高座を正面から見た**固定カメラ**。奥に金屏風、赤い提灯が3つ灯って揺れ、
左右から深紅の緞帳が金の房を揺らしながらゆっくり閉じていく。手前の畳には赤い座布団が積まれ、
暖色のスポット1灯だけが当たる。金粉がゆっくり舞い落ちる。

### ⚠️ 中央を暗く保つのが必須条件

この映像の上には**票数・判定(金の毛筆)・±N(緑/赤の巨大数字)が重なる**。
プロンプトで「照明は暖色のスポット1灯だけで、画面の中央は影が落ちて暗いまま」を明示し、
明るい要素(提灯・金屏風の照り)を上寄りと左右へ逃がしてある。
**差し替えるときは必ず中央下寄りが暗いことを確認すること** — 明るい絵に替えると
判定と ±N が読めなくなる(`revolution/result.mp4` の「中央を空ける」指定と同じ要件)。

### 幕との関係(`.quiz-settle.on-clip`)

素材があるときはモニターが `.quiz-settle` に `on-clip` を付けて **金屏風の地を引っ込める**
(`background: none`)。幕は `.fx-clip-opaque` より DOM 順で手前にあるので、
引っ込めないと不透明な地が映像を完全に隠す。
素材が無い / `fxClipsEnabled` オフのときは `on-clip` が付かず、これまで通り CSS の金屏風が出る
— **票数・判定・±N は映像の有無に関わらず必ず出し切る**。

### 加工内容(`revolution/` `quiz/intro.mp4` と同一のレシピ)

```
# 1パス目(測定)
ffmpeg -i RAW.mp4 -af loudnorm=I=-16:TP=-1.5:LRA=11:print_format=json -f null -
# 2パス目(トリム + 正規化 + 末尾フェード)
ffmpeg -i RAW.mp4 \
  -vf "trim=start_frame=0:end_frame=144,settb=1/24,setpts=N" -r 24 \
  -af "loudnorm=I=-16:TP=-1.5:LRA=11:measured_I=-21.94:measured_TP=-4.25:measured_LRA=13.30:measured_thresh=-36.27:offset=0.17:linear=true,atrim=0:6,asetpts=N/SR/TB,afade=t=out:st=5.85:d=0.15" \
  -c:v libx264 -profile:v high -pix_fmt yuv420p -crf 19 -preset slow \
  -c:a aac -b:a 160k -ar 48000 -movflags +faststart result.mp4
```

> **`-ss` も `fps=24` も `setpts=N/24/TB` も使わない。** 素材は 60fps を名乗る容器に真の
> 24fps が入っており、`-ss` はシーク破綻、`fps=24` は毎回 1 フレーム落とし、
> `setpts=N/24/TB` は入力 TB が 1/60 なので 2.5 倍に重複展開する。
> 正解は `trim=start_frame=…,settb=1/24,setpts=N` + `-r 24`(`rl/` で確立したレシピ)。

### 生成プロンプト(全文)

> 日本の寄席の高座を正面から捉えた固定カメラ。奥に金屏風、上部に赤い提灯が3つ灯ってゆっくり揺れる。左右から深紅のビロードの緞帳が金の房を揺らしながらゆっくり閉じていく。手前の床には赤い座布団が数枚積まれている。照明は暖色のスポット1灯だけで、画面の中央は影が落ちて暗いまま。金粉がゆっくり舞い落ちる。実写風でシネマティック、落ち着いた色調。人物なし、文字なし、ロゴなし。カメラは一切動かさない。音は和太鼓の締めの一打と、遠くの拍手。

> ## 著作権について
>
> **実在のテレビ番組を題材にしていない。** 人物を一切出さず(`人物なし`)、番組名・ロゴ・
> セットの意匠も使わない。**寄席の高座・緞帳・金屏風・提灯・座布団という一般的な
> 文化的題材**だけで構成している。
>
> 生成物の利用条件は Dreamina (CapCut) の利用規約に従う(**CC0 ではない**)。
> **再配布可否は未了** — `quiz/intro.mp4` と同じ扱い。
> 再エンコードにより生成サービスの C2PA コンテンツ来歴ボックスは落ちている。
