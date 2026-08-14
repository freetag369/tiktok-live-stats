-- 累計列ソート(累計💎 / 累計💗 / ハトミー / 来店回数 / スコア)を
-- 「viewer 全件の実体化 + ソート」から「索引順に必要な件数だけ」に変えるための索引。
--
-- 既に vl_diamonds / vl_visits / vl_score_e はあるが **単列**なので、
-- ORDER BY <col> DESC, user_id ASC の第2キーを満たせず全件ソートに落ちていた。
-- 索引だけ足しても効かず(駆動表が viewer のままでは使われない)、
-- viewers.ts 側を viewer_lifetime 駆動にするのと**セットで初めて効く**。
--
-- 実測(viewer 119,710行 / 1,000件取得):
--   索引のみ         : 効果なし(0%)
--   vl駆動のみ       : 効果なし(465ms)
--   両方             : 465ms -> 7.2ms (-99%)
--
-- 代償: viewer_lifetime の更新が1行あたり +13.2us(毎秒500イベントで +0.66%)、
-- DB は viewer 12万行時点で約 +19MB。該当ソート使用時の -690ms/8秒 に対して
-- 十分に見合う。
CREATE INDEX IF NOT EXISTS vl_diamonds_uid ON viewer_lifetime(diamonds DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS vl_likes_uid    ON viewer_lifetime(likes    DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS vl_heartme_uid  ON viewer_lifetime(heart_me DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS vl_visits_uid   ON viewer_lifetime(visits   DESC, user_id ASC);
CREATE INDEX IF NOT EXISTS vl_score_uid    ON viewer_lifetime(score_e  DESC, user_id ASC);
