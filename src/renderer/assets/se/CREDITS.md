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
| reel-confirm.ogg | `roulette-hit`(ルーレット確定) | 0.74 秒 | 確認1.mp3 | 前後の無音を除去 → ogg(q5)。音量は未加工 |

妨害の2つが ogg ではなく mp3 なのは提供された素材の形式そのままだから(単発音なので
`band/` の BGM と同じくエンコーダ遅延の継ぎ目問題は起きない)。ルーレットの2つは
無音除去とレベル合わせで再エンコードが必要だったので、他の単発音と同じ ogg に揃えた。

`reel-stop` だけ増幅しているのは素材のピークが -11.9dB と他の単発音より 11dB 低く、
カタログの `gain`(≤1)では合わせきれなかったため。増幅後のピークは -1.5dB
(`bong.ogg` の -0.9dB とほぼ同じ)で、カタログ側の gain 0.9 で最終調整している。

取り込みコマンド(再現用。元ファイルはリポジトリ外の `IMAGE/`):

```
ffmpeg -i "スイッチ5.mp3" -af "atrim=start=0.020:end=0.30,asetpts=N/SR/TB,volume=10.9dB" -c:a libvorbis -q:a 5 reel-stop.ogg
ffmpeg -i "確認1.mp3"     -af "atrim=start=0.022:end=0.76,asetpts=N/SR/TB"               -c:a libvorbis -q:a 5 reel-confirm.ogg
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

`spin-reel2.ogg` は**作者提供の素材**(上の「作者提供の専用音」と同じ扱い)、
他の2つは **ffmpeg でプロシージャル合成**した自前素材
(Higgsfield のAI音楽生成が提供範囲から外れたため。2026-08-13 時点で音声合成のみ)。
band/ と違い外部生成物を含まないので、ライセンスの扱いは上の Kenney 素材(CC0)と
同等にクリーン。

| ファイル | 用途 | 内容 | 実尺 |
|---|---|---|---|
| spin-reel2.ogg | リール回転ループ音(**既定**) | 作者提供の `jingle_26.mp3`。先頭の無音 82ms を落として ogg(q4)化したのみ(音量は未加工) | 2.97 秒 |
| bgm-roulette1.ogg | 回転中BGM(**既定はオフ**) | サスペンス — スネアロール(16Hz ノイズ減衰)+ A の低音ドローン + 心拍風パルス。8秒シームレスループ(全周期成分が 8s を割り切る) | 8.0 秒 |
| spin-reel1.ogg | リール回転ループ音 | 同梱 tick.ogg(Kenney CC0)を 75ms 間隔で 40 連結 | 3.0 秒 |

- **ogg なのは意図的**: mp3 はエンコーダ遅延の無音がループ継ぎ目に入る
  (HTMLAudio の loop で数十ms の途切れが聞こえる)。ogg はギャップレス。
- 差し替え方: 同名の ogg で上書きするだけ(コード変更不要)。Higgsfield 等の
  サイトで生成した曲に入れ替える場合は、ループ前提の尺(8〜12秒)にすること。
  その場合はこの表の出典も書き換えること(CC0 ではなくなる)。
- カタログとループ/フェード再生は `src/renderer/lib/bgm.ts`
  (ROULETTE_BGM / ROULETTE_SPIN_SE)。音圧差はカタログの gain で吸収する。
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

# bgm-roulette1.ogg — スネアロール + ドローン + 心拍(8.0s ループ)
ffmpeg  -f lavfi -i "aevalsrc=(random(0)-0.5)*exp(-48*mod(t\,0.0625)):s=44100:d=8"  -f lavfi -i "aevalsrc=0.30*sin(2*PI*55*t)+0.17*sin(2*PI*110*t)+0.10*sin(2*PI*164.81*t):s=44100:d=8"  -f lavfi -i "aevalsrc=sin(2*PI*(75-55*mod(t\,0.5))*mod(t\,0.5))*exp(-14*mod(t\,0.5)):s=44100:d=8"  -filter_complex "[0:a]highpass=f=250,lowpass=f=6500,volume=0.9[roll];[1:a]tremolo=f=0.5:d=0.35,volume=0.85[drone];[2:a]lowpass=f=200,volume=1.6[thump];[roll][drone][thump]amix=inputs=3:normalize=0,alimiter=limit=0.9,aformat=sample_fmts=fltp:channel_layouts=stereo[out]"  -map "[out]" -c:a libvorbis -q:a 5 roulette/bgm-roulette1.ogg
```
