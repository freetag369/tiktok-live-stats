CREATE TABLE gift_picker_cache (
  target TEXT NOT NULL,
  gift_id TEXT NOT NULL,
  name TEXT NOT NULL,
  diamonds INTEGER NOT NULL,
  icon_url TEXT,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (target, gift_id)
);
