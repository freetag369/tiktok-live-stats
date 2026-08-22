# 効果音の出典

下表の16件は Kenney (https://kenney.nl) の CC0 1.0 (パブリックドメイン) 素材。
妨害演出の専用音2件だけ出典が違う(このファイル下部の別セクション)。
https://creativecommons.org/publicdomain/zero/1.0/

加工内容: 用途名へのリネームのみ(音声データは未加工)。音量バランスは
アプリ側 `src/renderer/lib/se.ts` の gain で調整している。
どの演出にどの音を割り当てるかは設定画面(カウントダウンチャレンジ)で変更可能。

元パック:
- Interface Sounds — https://kenney.nl/assets/interface-sounds
- Music Jingles — https://kenney.nl/assets/music-jingles

| ファイル | 元パック | 元ファイル名 |
|---|---|---|
| click-soft.ogg | Interface Sounds | Audio/click_001.ogg |
| tick.ogg | Interface Sounds | Audio/tick_001.ogg |
| pop.ogg | Interface Sounds | Audio/drop_002.ogg |
| pluck.ogg | Interface Sounds | Audio/pluck_001.ogg |
| bong.ogg | Interface Sounds | Audio/bong_001.ogg |
| question.ogg | Interface Sounds | Audio/question_002.ogg |
| alert.ogg | Interface Sounds | Audio/error_004.ogg |
| confirm-1.ogg | Interface Sounds | Audio/confirmation_001.ogg |
| confirm-2.ogg | Interface Sounds | Audio/confirmation_002.ogg |
| confirm-3.ogg | Interface Sounds | Audio/confirmation_003.ogg |
| jingle-hit.ogg | Music Jingles | Audio/Hit jingles/jingles_HIT09.ogg |
| jingle-steel.ogg | Music Jingles | Audio/Steel jingles/jingles_STEEL07.ogg |
| jingle-pizzi.ogg | Music Jingles | Audio/Pizzicato jingles/jingles_PIZZI07.ogg |
| jingle-sax.ogg | Music Jingles | Audio/Sax jingles/jingles_SAX07.ogg |
| fanfare-8bit.ogg | Music Jingles | Audio/8-Bit jingles/jingles_NES00.ogg |
| fanfare-8bit-short.ogg | Music Jingles | Audio/8-Bit jingles/jingles_NES13.ogg |

---

# 作者提供の専用音 — 出典が違うので注意

上の Kenney 素材(CC0)とは**別物**。**本アプリ作者の自作**(権利クリア・再配布可)。

| ファイル | 既定の割り当てスロット | 実尺 | 元ファイル | 加工内容 |
|---|---|---|---|---|
| like-jam.mp3 | `like`(いいね妨害) | 5.64 秒 | いいね障害(s3にカット).mp3 | リネームのみ(未加工) |
| follow-jam.mp3 | `follow`(フォロー妨害) | 2.25 秒 | フォロー障害.mp3 | リネームのみ(未加工) |
| reel-stop.ogg | `roulette-near`(ルーレット 止まりそう) | 0.28 秒 | スイッチ5.mp3 | 前後の無音を除去 → **+10.9dB** → ogg(q5) |
| reel-confirm.ogg | (選択肢のみ・旧 `roulette-hit` 既定) | 0.74 秒 | 確認1.mp3 | 前後の無音を除去 → ogg(q5)。音量は未加工 |
| gauge-burst.mp3 | `gauge-full`(ゲージ満タン着弾) | 1.49 秒 | いいねゲージ満タン専用.mp3 | 末尾無音を除去 → **+5.1dB** → mp3(192k) |
| stock-burst.mp3 | `stock-full`(ストック満杯着弾) | 1.07 秒 | いいねストック満杯(着弾).mp3 | 末尾無音を除去 → **+4.3dB** → mp3(192k) |
| helper-stamp.mp3 | `helper`(お助け・ファンスタンプ) | 0.42 秒 | お助け(ファンスタンプ).mp3 | 末尾無音を除去 → **+4.2dB** → mp3(192k) |
| comment-jam.mp3 | `comment`(指定コメント妨害) | 2.93 秒 | コメント障害.mp3 | 末尾無音を除去 → **+7.8dB** → mp3(192k) |
| boost-tap.mp3 | `boost-start`(ブースト タップ開始) | 0.81 秒 | ブースト タップ開始.mp3 | 末尾無音を除去 → **+6.3dB** → mp3(192k) |
| boost-final.mp3 | **(未割当・選択肢のみ)** | 1.57 秒 | ブースト最後の.mp3 | 末尾無音を除去 → **+5.4dB** → mp3(192k) |
| boost-hit.mp3 | `boost-end`(ブースト着弾・一括減算) | 3.16 秒 | ブースト着弾(一括減算).mp3 | 末尾無音を除去 → **+6.4dB** → mp3(192k) |
| reel-kick.mp3 | `roulette-kick`(フェイク停止からの一撃) | 0.24 秒 | ルーレット キック(フェイク停止からの一撃).mp3 | 末尾無音を除去 → **+8.2dB** → mp3(192k) |
| reel-hit.mp3 | `roulette-hit`(ルーレット確定) | 0.65 秒 | ルーレット確定.mp3 | 末尾無音を除去 → **+6.5dB** → mp3(192k) |
| clear-fanfare.mp3 | `achieved`(達成 CLEAR) | 2.52 秒 | 達成.mp3 | 末尾無音を除去 → **+3.9dB** → mp3(192k) |

## 超激アツ(ultra)のカウントダウン式演出のボイス7件(2026-08-18 追加)

**同じ「作者提供」だが、上の10件とは正規化の方針が違う。** 元素材はリポジトリ外の
`Sound/` と `Sound/modorion/`(日本語ファイル名。id は ASCII スラッグ必須なので改名した)。

| ファイル | 既定の割り当て | 実尺 | 元ファイル | ゲイン |
|---|---|---|---|---|
| hype-kakugo.mp3 | `roulette-hype`(激熱の合図) | 1.46 秒 | kakugowokimemasyou.mp3 | +8.6dB |
| hype-iyashi.mp3 | (選択肢のみ) | 1.20 秒 | iyashinotikarayo.mp3 | +4.9dB |
| hype-yoroshiku.mp3 | (選択肢のみ) | 1.23 秒 | yorosikuonegaisimasu.mp3 | +4.7dB |
| hype-kiitenaiyo.mp3 | (選択肢のみ) | 1.25 秒 | 「こんなの聞いてないよ！？」.mp3 | +3.2dB |
| back-kuh.mp3 | `roulette-hype-back`(出目が戻る瞬間) | 0.26 秒 | modorion/「くっ！」.mp3 | +4.6dB |
| back-uh.mp3 | (選択肢のみ) | 0.18 秒 | modorion/「うっ！」.mp3 | +1.4dB |
| back-ite.mp3 | (選択肢のみ) | 0.39 秒 | modorion/「いてっ！」.mp3 | +5.2dB |

> ### ⚠️ ピーク合わせではなく RMS 合わせにした理由
>
> 元素材のピークは -9.1〜-11.9dB とよく揃っていたが、**RMS は -20.6〜-28.2dB で
> 7.6dB もばらついていた**。上の10件と同じ「ピークを -1.5dB へ揃える」で取り込むと、
> 短い叫び(「くっ！」「いてっ！」)ほど波高だけが立って**体感では小さく聞こえる**。
> ボイスは1本ずつ独立に鳴る(重ならない)ので、揃えるべきは体感 = RMS のほう。
>
> レシピ: **①前後の無音を除去 → ②トリム後の RMS を測り直して -17.0dB へ揃える
> → ③ `alimiter` で -1.5dBFS を上限に抑える → mp3(192k / mono / 44.1kHz)。**
>
> **②で「トリム後に測り直す」のが要点。** 戻り3本は末尾無音が大半で
> (「くっ！」は 1.045 秒 → 0.261 秒)、無音込みの RMS を基準にすると **4.6dB 過大**に
> なる(実際に一度踏んだ)。**頭の無音も落とす** — 残すとドンとの同期がずれる。
>
> 結果は7本とも **RMS -15.7〜-15.8dB(差 0.1dB)・ピーク -2.1〜-6.5dB**。既存 `assets/se/`
> 直下の RMS 分布(-10.0〜-26.4、中央値 ≒ -16)のほぼ中央に着地したので、
> **カタログの `gain` は 1.0**(引かない)。上の10件の 0.9 は「素材が小さすぎたぶんを
> ピークで持ち上げた」補正なので、方針が違うここには適用しない。

```
# <出力> ごとに: ①トリムだけした wav を作る → ②その RMS を測る → ③ゲイン+リミッタ
TRIM="silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,areverse,\
silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,areverse"
ffmpeg -i "<元ファイル>" -af "$TRIM" -ac 1 -ar 44100 -c:a pcm_s16le tmp.wav
ffmpeg -i tmp.wav -af volumedetect -f null -            # mean_volume を読む
ffmpeg -i tmp.wav -af "volume=<-17.0 - mean>dB,alimiter=limit=0.8414:attack=5:release=60,\
aformat=sample_fmts=fltp" -ac 1 -ar 44100 -c:a libmp3lame -b:a 192k <出力>.mp3
```

妨害の2つと 2026-08-14 追加の10件が ogg ではなく mp3 なのは提供された素材の形式
そのままだから(単発音なので `band/` の BGM と同じくエンコーダ遅延の継ぎ目問題は
起きない — 継ぎ目が問題になるのはループ素材だけ)。`reel-stop` / `reel-confirm` の2つは
初期に取り込んだぶんで、他の単発音と同じ ogg に揃えてある。

`reel-stop` だけ増幅しているのは素材のピークが -11.9dB と他の単発音より 11dB 低く、
カタログの `gain`(≤1)では合わせきれなかったため。増幅後のピークは -1.5dB
(`bong.ogg` の -0.9dB とほぼ同じ)で、カタログ側の gain 0.9 で最終調整している。

**下10件(2026-08-14 追加)も同じ理由で増幅している。** 素材のピークは -5.4〜-9.7dB
(平均 -18〜-27dB)で、既存の同梱音(ピーク -0.4〜-4.9dB / 平均 -11〜-20dB)より
6〜8dB 小さい。`playSe` は最終音量を 1.0 にクランプし(`lib/se.ts`)音量スライダの
上限も 100 なので、**小さいぶんを後から取り戻す手段が無い** — カタログの `gain` は
減衰しかできない。そこで `reel-stop` と同じ **ピーク -1.5dB** へ揃えて取り込み、
カタログ側は全件 gain 0.9 に置いた。形式は元素材のまま mp3(192k)。

取り込みコマンド(再現用。元ファイルはリポジトリ外の `IMAGE/`):

```
ffmpeg -i "スイッチ5.mp3" -af "atrim=start=0.020:end=0.30,asetpts=N/SR/TB,volume=10.9dB" -c:a libvorbis -q:a 5 reel-stop.ogg
ffmpeg -i "確認1.mp3"     -af "atrim=start=0.022:end=0.76,asetpts=N/SR/TB"               -c:a libvorbis -q:a 5 reel-confirm.ogg

# 2026-08-14 追加の10件(元は IMAGE/0120260814/)。末尾無音を落として +N dB でピーク -1.5dB へ。
# <+N> は上の表のとおり(実測ピークから -1.5dB までの差)。
ffmpeg -i "<元ファイル>"   -af "areverse,silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0,areverse,volume=<+N>dB"   -c:a libmp3lame -b:a 192k <出力>.mp3
```

既定の割り当ては `src/shared/challenge.ts` の `DEFAULT_SE_SOUNDS`。旧既定のまま
保存されている settings.json は `migrateChallengeSeSounds` が一度だけ寄せ替える
(自分で別の音を選んでいる設定は触らない)。

---

# カットインBGM(`band/` サブフォルダ)— 出典が違うので注意

上の Kenney 素材(CC0)とは**別物**。ダイヤ帯域カットイン(`../fx/band/`)の
再生中に流すパチンコ風BGMで、**Higgsfield (https://higgsfield.ai) の
`sonilo_music`(FAL / text-to-music)で AI 生成**した。**CC0 ではない** —
利用条件は Higgsfield の利用規約に従う。AGPL でのソースzip再配布前に
規約上の再配布可否を必ず確認すること(`../fx/CREDITS.md` と同じ注意)。

生成日 2026-08-12。加工内容: 返却された m4a を ffmpeg で mp3(VBR q4)へ
変換したのみ。カタログとループ/フェード再生は `src/renderer/lib/bgm.ts`
(効果音の `se.ts` とは別モジュール — 長尺・停止可能ハンドル持ち)。

| ファイル | 帯域 | 内容 | 実尺 |
|---|---|---|---|
| bgm-band1.mp3 | 1〜50💎(6秒) | 当たり(小)— 明るいチップチューン | 8.07 秒 |
| bgm-band2.mp3 | 51〜100💎(6秒) | 当たり(中)— ブラス入りファンファーレ | 8.07 秒 |
| bgm-band3.mp3 | 101〜600💎(8秒) | 大当たり — ユーロビート | 10.06 秒 |
| bgm-band4.mp3 | 601💎〜(10秒) | 超大当たり — フィーバーアンセム | 12.07 秒 |

実尺はカットイン尺よりやや長い。再生側は `loop = true` + カットイン終端
0.4 秒前からのフェードで打ち切るため、尺の一致は要らない(映像と同じ設計)。

---

# ルーレット回転サウンド(`roulette/` サブフォルダ)

`spin-reel2.ogg` と `slot.ogg` は**作者提供の素材**(上の「作者提供の専用音」と同じ扱い)、
他の2つは **ffmpeg でプロシージャル合成**した自前素材
(Higgsfield のAI音楽生成が提供範囲から外れたため。2026-08-13 時点で音声合成のみ)。
band/ と違い外部生成物を含まないので、ライセンスの扱いは上の Kenney 素材(CC0)と
同等にクリーン。

| ファイル | 用途 | 内容 | 実尺 |
|---|---|---|---|
| spin-reel2.ogg | リール回転ループ音(**既定**) | 作者提供の `jingle_26.mp3`。先頭の無音 82ms を落として ogg(q4)化したのみ(音量は未加工) | 2.97 秒 |
| bgm-roulette1.ogg | 回転中BGM(**既定はオフ**) | サスペンス — スネアロール(16Hz ノイズ減衰)+ A の低音ドローン + 心拍風パルス。8秒シームレスループ(全周期成分が 8s を割り切る) | 8.0 秒 |
| spin-reel1.ogg | リール回転ループ音 | 同梱 tick.ogg(Kenney CC0)を 75ms 間隔で 40 連結 | 3.0 秒 |
| slot.ogg | 回転中BGM **と** リール回転ループ音(両方の選択肢) | 作者提供の `IMAGE/bgm/slot.mp3`。ogg(q4)化したのみ(音量は未加工) | 5.22 秒 |

- **ogg なのは意図的**: mp3 はエンコーダ遅延の無音がループ継ぎ目に入る
  (HTMLAudio の loop で数十ms の途切れが聞こえる)。ogg はギャップレス。
- 差し替え方: 同名の ogg で上書きするだけ(コード変更不要)。Higgsfield 等の
  サイトで生成した曲に入れ替える場合は、ループ前提の尺(8〜12秒)にすること。
  その場合はこの表の出典も書き換えること(CC0 ではなくなる)。
- カタログとループ/フェード再生は `src/renderer/lib/bgm.ts`
  (ROULETTE_BGM / ROULETTE_SPIN_SE)。音圧差はカタログの gain で吸収する。
- **`slot.ogg` はファイル1本で id 2つ**: BGM枠 `bgm-roulette2` と回転音枠 `spin-slot` が
  同じ url を指す(`BY_ID` が3カタログをマージするので id は重複させられない)。
  差し替えるときは1本直せば両方に効く。
- **既定は BGM オフ + spin-reel2 のみ**(`DEFAULT_ROULETTE_SOUND`)。曲を重ねると
  停止まわりの3音(`roulette` / `roulette-near` / `roulette-hit`)が埋もれるため。
  BGM が欲しい人は設定画面のドロップダウンから選ぶ。

合成・取り込みコマンド(再現用):

```
# spin-reel2.ogg — 作者提供 jingle_26.mp3 の先頭無音を落として ogg 化
ffmpeg -i jingle_26.mp3 -af "atrim=start=0.082,asetpts=N/SR/TB,aresample=44100" -c:a libvorbis -q:a 4 roulette/spin-reel2.ogg

# spin-reel1.ogg — tick.ogg を 75ms 間隔で 40 連結(3.0s ループ)
ffmpeg -i tick.ogg -af "apad=whole_dur=0.075" -ar 44100 tick1.wav
ffmpeg -stream_loop 39 -i tick1.wav -c:a libvorbis -q:a 5 roulette/spin-reel1.ogg

# slot.ogg — 作者提供 slot.mp3 を ogg 化(先頭に無音が無いのでトリム不要)
ffmpeg -i IMAGE/bgm/slot.mp3 -af "aresample=44100" -c:a libvorbis -q:a 4 roulette/slot.ogg

# bgm-roulette1.ogg — スネアロール + ドローン + 心拍(8.0s ループ)
ffmpeg  -f lavfi -i "aevalsrc=(random(0)-0.5)*exp(-48*mod(t\,0.0625)):s=44100:d=8"  -f lavfi -i "aevalsrc=0.30*sin(2*PI*55*t)+0.17*sin(2*PI*110*t)+0.10*sin(2*PI*164.81*t):s=44100:d=8"  -f lavfi -i "aevalsrc=sin(2*PI*(75-55*mod(t\,0.5))*mod(t\,0.5))*exp(-14*mod(t\,0.5)):s=44100:d=8"  -filter_complex "[0:a]highpass=f=250,lowpass=f=6500,volume=0.9[roll];[1:a]tremolo=f=0.5:d=0.35,volume=0.85[drone];[2:a]lowpass=f=200,volume=1.6[thump];[roll][drone][thump]amix=inputs=3:normalize=0,alimiter=limit=0.9,aformat=sample_fmts=fltp:channel_layouts=stereo[out]"  -map "[out]" -c:a libvorbis -q:a 5 roulette/bgm-roulette1.ogg
```

---

# お題ルーレットBGM(`quiz/` サブフォルダ)— 出典が違うので注意

お題ルーレット(`shared/quiz-bgm.ts` の区間別BGM)の**出荷既定2曲**。
出典は**ユーザー(配信者)提供の素材**で、リポジトリ外の作業フォルダ
`Sound/追いかけっこキャッハー.mp3` / `Sound/考え中.mp3` から取り込んだ。
**CC0 ではない** — `band/` の Higgsfield 素材と同じ扱いで、AGPL の
ソースzip再配布前に権利元の許諾を必ず確認すること。

取り込み日 2026-08-22。カタログとループ/フェード再生は
`src/renderer/lib/bgm.ts` の `ROULETTE_BGM`(お題専用の配列は作らない —
回転中BGMの選択肢としても選べるようにするため)。

| ファイル | 区間 | 実尺 | 取り込み後の音量 | カタログ gain |
|---|---|---|---|---|
| bgm-quiz-chase.mp3 | ①ルーレット時(発動〜**導入の全面カット**〜回転)。②③④は `keep` なので投票開始まで続く | 132.28 秒 | -8.9 LUFS / TP +0.6dB(**無加工コピー**) | 0.6 |
| bgm-quiz-think.mp3 | ⑤コメント受付(投票タイム) | 109.19 秒 | -14.1 LUFS / TP -1.3dB(+5.2dB 増幅済み) | 1 |

- **gain の根拠**: 基準は `bgm-roulette1`(-12.8 LUFS × gain 0.85 = 実効 -14.2 LUFS)。
  chase は素材が熱いので 0.6 で実効 -13.3 LUFS、think は増幅済みなので gain 1 で -14.1 LUFS。
  両者の差は 0.8dB で、区間が切り替わっても音量段差が聞こえない。
- **think だけ増幅してあるのは `reel-stop` と同じ事情**: 素材が -19.2 LUFS と 9dB 以上
  小さく、カタログの `gain`(≤1)は減衰しかできないので後から取り戻せない。
  ピークは alimiter で -1.5dBFS へ抑えてから mp3(VBR q4)化した。
- **ループの継ぎ目は問題にならない**ので mp3 のままでよい(`roulette/` を ogg に
  している理由の対象外)。①は最長でも 8+18+4+5+60 ≒ 95 秒、⑤は 30 秒で、
  どちらも実尺の中に収まって一周しない。
- 差し替え方: 同名の mp3 で上書きするだけ(コード変更不要)。音量が大きく違う
  素材にするときは、この表の実測値を測り直して `bgm.ts` の `gain` を合わせること。
- 既定の割り当ては `src/shared/challenge.ts` の `DEFAULT_QUIZ`(`bgm` / `voteBgm`)。
  保存済み settings.json へは `migrateChallengeQuizBgm`(SETTINGS_VERSION 14)が
  一度だけ配る。

取り込みコマンド(再現用。元ファイルはリポジトリ外の `Sound/`):

```
# bgm-quiz-chase.mp3 — 無加工コピー(音圧調整はカタログの gain 0.6 側で行う)
cp "Sound/追いかけっこキャッハー.mp3" quiz/bgm-quiz-chase.mp3

# bgm-quiz-think.mp3 — mean -22.6dB → +5.2dB 増幅、ピークは -1.5dBFS で頭打ち
ffmpeg -i "Sound/考え中.mp3" -af "volume=5.2dB,alimiter=limit=0.8414:attack=5:release=60:level=disabled,aformat=sample_fmts=fltp" -ar 44100 -c:a libmp3lame -q:a 4 quiz/bgm-quiz-think.mp3
```
