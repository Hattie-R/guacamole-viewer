use rusqlite::Connection;
use std::path::Path;

pub fn open(db_path: &Path) -> Result<Connection, String> {
  let conn = Connection::open(db_path).map_err(|e| e.to_string())?;
  conn
    .pragma_update(None, "journal_mode", "WAL")
    .map_err(|e| e.to_string())?;
  conn
    .pragma_update(None, "foreign_keys", "ON")
    .map_err(|e| e.to_string())?;
  Ok(conn)
}

pub fn init_schema(conn: &Connection) -> Result<(), String> {
  conn.execute_batch(
    r#"
    CREATE TABLE IF NOT EXISTS items (
      item_id        INTEGER PRIMARY KEY,
      source         TEXT NOT NULL,
      source_id      TEXT NOT NULL,
      md5            TEXT,
      remote_url     TEXT,
      file_rel       TEXT NOT NULL,
      ext            TEXT,
      mime           TEXT,
      size_bytes     INTEGER,
      width          INTEGER,
      height         INTEGER,
      duration_sec   REAL,
      rating         TEXT,
      fav_count      INTEGER,
      score_total    INTEGER,
      created_at     TEXT,
      added_at       TEXT NOT NULL,
      primary_artist TEXT,
      trashed_at     TEXT,
      deleted_at     TEXT,
      UNIQUE(source, source_id)
    );

    CREATE INDEX IF NOT EXISTS idx_items_added_at ON items(added_at);
    CREATE INDEX IF NOT EXISTS idx_items_trashed_at ON items(trashed_at);

    CREATE TABLE IF NOT EXISTS tags (
      tag_id INTEGER PRIMARY KEY,
      name   TEXT NOT NULL UNIQUE,
      type   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS item_tags (
      item_id INTEGER NOT NULL,
      tag_id  INTEGER NOT NULL,
      PRIMARY KEY (item_id, tag_id),
      FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE,
      FOREIGN KEY (tag_id)  REFERENCES tags(tag_id)  ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sources (
      source_row_id INTEGER PRIMARY KEY,
      url           TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS item_sources (
      item_id       INTEGER NOT NULL,
      source_row_id INTEGER NOT NULL,
      PRIMARY KEY (item_id, source_row_id),
      FOREIGN KEY (item_id) REFERENCES items(item_id) ON DELETE CASCADE,
      FOREIGN KEY (source_row_id) REFERENCES sources(source_row_id) ON DELETE CASCADE
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS fts_items
    USING fts5(item_id UNINDEXED, text);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    "#,
  )
  .map_err(|e| e.to_string())?;

  Ok(())
}