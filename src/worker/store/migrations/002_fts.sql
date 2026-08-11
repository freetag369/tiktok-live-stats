-- Comment full-text search.  Applied only when the runtime probe finds FTS5
-- compiled in (verified present in Node 24.12.0 / SQLite 3.50.4, but the probe
-- stays because Electron's bundled SQLite is not under our control).
--
-- An external-content FTS5 table does NOT populate itself: the three triggers
-- below are mandatory.  They run inside the 250 ms ingest transaction, so the
-- ingest benchmark must be re-run with FTS on.

CREATE VIRTUAL TABLE comment_fts USING fts5(
  content,
  content='comment',
  content_rowid='rowid',
  tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER comment_ai AFTER INSERT ON comment BEGIN
  INSERT INTO comment_fts(rowid, content) VALUES (new.rowid, new.content);
END;

CREATE TRIGGER comment_ad AFTER DELETE ON comment BEGIN
  INSERT INTO comment_fts(comment_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
END;

CREATE TRIGGER comment_au AFTER UPDATE ON comment BEGIN
  INSERT INTO comment_fts(comment_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO comment_fts(rowid, content) VALUES (new.rowid, new.content);
END;
