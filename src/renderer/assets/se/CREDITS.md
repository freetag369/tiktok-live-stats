# 効果音の出典

すべて Kenney (https://kenney.nl) の CC0 1.0 (パブリックドメイン) 素材。
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
