# 同梱フォントの出典

お題ルーレット(笑点風の寄席演出)の見出しとめくりに使う毛筆書体。

| 項目 | 値 |
|---|---|
| 書体名 | 佑字 肅 (Yuji Syuku) |
| ファイル | `YujiSyuku-Regular.ttf`(8,430,348 バイト / TrueType) |
| 権利者 | Copyright 2021 The Yuji Project Authors |
| 原典 | https://github.com/Kinutafontfactory/Yuji |
| 取得元 | https://raw.githubusercontent.com/google/fonts/main/ofl/yujisyuku/YujiSyuku-Regular.ttf |
| 取得日 | 2026-08-22 |
| ライセンス | SIL Open Font License, Version 1.1(全文は同ディレクトリの `OFL.txt`) |

加工内容: **無し**。google/fonts の配布物をそのまま格納している。

## 使い方の約束

- 読み口は `src/renderer/styles/monitor.css` の `@font-face`(お題ルーレット節の先頭)**1 箇所だけ**。
  `monitor.html` の CSP が `font-src 'self'` なので、**外部 CDN からは読めない**。
  Web フォントを増やすときも必ずここへ同梱して `@font-face` を足すこと。
- CSS 変数 `--qz-brush` / `--qz-mincho` から参照する。`tokens.css` の `--font` / `--num` は
  **触らない** — あちらはモニター全画面が連動する共有トークンで、和風にすると
  7セグやランキングまで巻き添えになる。
- フォールバックは OS 同梱の明朝(Windows は游明朝、mac はヒラギノ明朝)。
  `font-display: swap` なので、解析が終わるまでの一瞬だけ明朝で出て入れ替わる。

## SIL OFL 1.1 の要点(再配布時に守ること)

- 同梱・改変・再配布は可。**ただし `OFL.txt` を必ず一緒に配ること**(本ディレクトリに同梱済み)。
- 書体そのものを単体で販売しないこと。
- 改変版に "Yuji" の名を付けて配らないこと(Reserved Font Name の指定は原典の OFL.txt を参照)。

> この書体は CC0 ではない(同ディレクトリの効果音 `../se/` の Kenney 素材とは条件が違う)。
> 配布パッケージを作るときは `OFL.txt` が同梱物に含まれているかを確認すること。
