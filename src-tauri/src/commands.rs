use crate::{config, db, library};
use chrono::Utc;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;
use tauri::Manager;

fn get_root(app: &AppHandle) -> Result<PathBuf, String> {
  let cfg = config::load_config(app)?;
  let root = cfg.library_root.ok_or("Library root not set yet")?;
  Ok(PathBuf::from(root))
}

fn sanitize_slug(s: &str) -> String {
  let mut out = s.trim().to_lowercase().replace(' ', "_");
  for ch in ['<', '>', ';', ':', '"', '/', '\\', '|', '?', '*'] {
    out = out.replace(ch, "");
  }
  if out.is_empty() {
    out = "unknown_artist".into();
  }
  out
}

fn pick_primary_artist(artists: &[String]) -> String {
  let deny = ["sound_warning", "conditional_dnp"];
  artists
    .iter()
    .find(|a| !deny.contains(&a.as_str()))
    .cloned()
    .unwrap_or_else(|| "unknown_artist".into())
}

#[derive(Serialize)]
pub struct Status {
  pub ok: bool,
  pub message: String,
}

#[derive(Serialize)]
pub struct ImportResult {
  pub imported: u32,
  pub skipped: u32,
  pub missing_files: u32,
  pub errors: Vec<String>,
}

#[derive(Deserialize)]
struct JsonDb {
  items: Vec<JsonItem>,
}

#[derive(Deserialize)]
struct JsonItem {
  source: Option<String>,
  id: serde_json::Value,
  url: Option<String>,
  tags: Option<Vec<String>>,
  rating: Option<String>,
  artist: Option<Vec<String>>,
  timestamp: Option<String>,
  local_path: Option<String>,
  sources: Option<Vec<String>>,
}

#[derive(Serialize)]
pub struct ItemDto {
  pub item_id: i64,
  pub source: String,
  pub source_id: String,
  pub remote_url: Option<String>,
  pub file_abs: String,
  pub ext: Option<String>,
  pub tags: Vec<String>,
  pub artists: Vec<String>,
  pub sources: Vec<String>,
  pub rating: Option<String>,
  pub fav_count: Option<i64>,
  pub score_total: Option<i64>,
  pub timestamp: Option<String>,
  pub added_at: String,
}

#[tauri::command]
pub fn get_config(app: AppHandle) -> Result<config::AppConfig, String> {
  config::load_config(&app)
}

#[tauri::command]
pub fn set_library_root(app: AppHandle, library_root: String) -> Result<Status, String> {
  let root = PathBuf::from(&library_root);

  if !root.exists() {
    return Err("Selected library root does not exist".into());
  }
  if !root.is_dir() {
    return Err("Selected library root is not a directory".into());
  }

  library::ensure_layout(&root)?;

  let conn = db::open(&library::db_path(&root))?;
  db::init_schema(&conn)?;

  // allow file access for chosen library root
  if let Err(e) = app.fs_scope().allow_directory(&root, true) {
    return Err(format!("Failed to allow directory in fs scope: {e}"));
  }
  // allow asset:// serving for convertFileSrc(...)
  if let Err(e) = app.asset_protocol_scope().allow_directory(&root, true) {
    return Err(format!("Failed to allow directory in asset protocol scope: {e}"));
  }

  let mut cfg = config::load_config(&app)?;
  cfg.library_root = Some(library_root);
  config::save_config(&app, &cfg)?;

  Ok(Status {
    ok: true,
    message: "Library root set and DB initialized".into(),
  })
}

#[tauri::command]
pub fn list_items(app: AppHandle) -> Result<Vec<ItemDto>, String> {
  let root = get_root(&app)?;
  let conn = db::open(&library::db_path(&root))?;

  let mut stmt = conn.prepare(
    r#"
    SELECT
      i.item_id,
      i.source,
      i.source_id,
      i.remote_url,
      i.file_rel,
      i.ext,
      i.rating,
      i.fav_count,
      i.score_total,
      i.created_at,
      i.added_at,

      COALESCE((
        SELECT GROUP_CONCAT(t.name, char(9))
        FROM tags t
        JOIN item_tags it ON it.tag_id = t.tag_id
        WHERE it.item_id = i.item_id
      ), '') AS tags,

      COALESCE((
        SELECT GROUP_CONCAT(t.name, char(9))
        FROM tags t
        JOIN item_tags it ON it.tag_id = t.tag_id
        WHERE it.item_id = i.item_id AND t.type = 'artist'
      ), '') AS artists,

      COALESCE((
        SELECT GROUP_CONCAT(s.url, char(9))
        FROM sources s
        JOIN item_sources isrc ON isrc.source_row_id = s.source_row_id
        WHERE isrc.item_id = i.item_id
      ), '') AS sources

    FROM items i
    WHERE i.trashed_at IS NULL
    ORDER BY i.added_at DESC
    "#
  ).map_err(|e| e.to_string())?;

  let rows = stmt
    .query_map([], |r: &Row| {
      let file_rel: String = r.get(4)?;
      let file_abs = root.join(&file_rel);
      let _ext: Option<String> = r.get(5)?;

      let split_tab = |s: String| -> Vec<String> {
        if s.is_empty() {
          vec![]
        } else {
          s.split('\t').map(|x| x.to_string()).collect()
        }
      };

      Ok(ItemDto {
        item_id: r.get(0)?,
        source: r.get(1)?,
        source_id: r.get(2)?,
        remote_url: r.get(3)?,
        file_abs: file_abs.to_string_lossy().to_string(),
        ext: r.get(5)?,

        rating: r.get(6)?,
        fav_count: r.get(7)?,
        score_total: r.get(8)?,
        timestamp: r.get(9)?,
        added_at: r.get(10)?,

        tags: split_tab(r.get(11)?),
        artists: split_tab(r.get(12)?),
        sources: split_tab(r.get(13)?),
      })
    })
    .map_err(|e| e.to_string())?;

  let mut out = vec![];
  for row in rows {
    out.push(row.map_err(|e| e.to_string())?);
  }
  Ok(out)
}

fn upsert_tag(conn: &Connection, name: &str, tag_type: &str) -> Result<i64, String> {
  conn
    .execute(
      "INSERT INTO tags(name, type) VALUES(?, ?) ON CONFLICT(name) DO UPDATE SET type=excluded.type",
      params![name, tag_type],
    )
    .map_err(|e| e.to_string())?;

  let id: i64 = conn
    .query_row(
      "SELECT tag_id FROM tags WHERE name=?",
      params![name],
      |r: &Row| r.get(0),
    )
    .map_err(|e| e.to_string())?;

  Ok(id)
}

fn upsert_source(conn: &Connection, url: &str) -> Result<i64, String> {
  conn
    .execute(
      "INSERT INTO sources(url) VALUES(?) ON CONFLICT(url) DO NOTHING",
      params![url],
    )
    .map_err(|e| e.to_string())?;

  let id: i64 = conn
    .query_row(
      "SELECT source_row_id FROM sources WHERE url=?",
      params![url],
      |r: &Row| r.get(0),
    )
    .map_err(|e| e.to_string())?;

  Ok(id)
}

#[tauri::command]
pub fn import_json(app: AppHandle, json_path: String, rename_files: bool) -> Result<ImportResult, String> {
  let root = get_root(&app)?;
  library::ensure_layout(&root)?;

  let text = fs::read_to_string(&json_path).map_err(|e| e.to_string())?;
  let parsed: JsonDb = serde_json::from_str(&text).map_err(|e| e.to_string())?;

  let conn = db::open(&library::db_path(&root))?;
  db::init_schema(&conn)?;

  let mut result = ImportResult { imported: 0, skipped: 0, missing_files: 0, errors: vec![] };

  for it in parsed.items {
    let source = it.source.unwrap_or_else(|| "unknown".into());
    let source_id = it.id.to_string().trim_matches('"').to_string();

    let local_path = match it.local_path {
      Some(p) => p,
      None => { result.errors.push(format!("Missing local_path for {source}:{source_id}")); continue; }
    };
    let src = PathBuf::from(&local_path);
    if !src.exists() {
      result.missing_files += 1;
      continue;
    }

    // Skip if already in DB by (source, source_id)
    let exists: i64 = conn.query_row(
      "SELECT COUNT(*) FROM items WHERE source=? AND source_id=?",
      params![source, source_id],
      |r: &Row| r.get(0)
    ).map_err(|e| e.to_string())?;
    if exists > 0 {
      result.skipped += 1;
      continue;
    }

    let ext = src.extension().and_then(|e| e.to_str()).unwrap_or("").to_string();

    let artists = it.artist.unwrap_or_default();
    let primary_artist = sanitize_slug(&pick_primary_artist(&artists));

    let base_name = if rename_files {
      format!("{primary_artist}_{source}_{source_id}.{}", ext)
    } else {
      src.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_string()
    };

    // Ensure unique destination filename
    let mut filename = base_name.clone();
    let mut n = 1;
    let media_dir = root.join("media");
    let mut dest = media_dir.join(&filename);
    while dest.exists() {
      filename = if rename_files {
        format!("{primary_artist}_{source}_{source_id}_dup{n}.{}", ext)
      } else {
        let stem = src.file_stem().and_then(|s| s.to_str()).unwrap_or("file");
        format!("{stem}_dup{n}.{}", ext)
      };
      dest = media_dir.join(&filename);
      n += 1;
    }

    // Copy into library root (reorganize)
    fs::copy(&src, &dest).map_err(|e| e.to_string())?;

    let file_rel = format!("media/{}", filename.replace('\\', "/"));
    let added_at = Utc::now().to_rfc3339();

    conn.execute(
      r#"
      INSERT INTO items(source, source_id, remote_url, file_rel, ext, rating, created_at, added_at, primary_artist)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)
      "#,
      params![
        source, source_id, it.url, file_rel, ext,
        it.rating, it.timestamp, added_at, primary_artist
      ]
    ).map_err(|e| e.to_string())?;

    let item_id = conn.last_insert_rowid();

    // tags (JSON tags = general)
    if let Some(tags) = it.tags {
      for tag in tags {
        let tag_id = upsert_tag(&conn, &tag, "general")?;
        conn.execute(
          "INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?, ?)",
          params![item_id, tag_id]
        ).map_err(|e| e.to_string())?;
      }
    }

    // artists as typed tags
    for a in &artists {
      let tag_id = upsert_tag(&conn, a, "artist")?;
      conn.execute(
        "INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?, ?)",
        params![item_id, tag_id]
      ).map_err(|e| e.to_string())?;
    }

    // sources URLs if present
    if let Some(srcs) = it.sources {
      for u in srcs {
        let sid = upsert_source(&conn, &u)?;
        conn.execute(
          "INSERT OR IGNORE INTO item_sources(item_id, source_row_id) VALUES(?, ?)",
          params![item_id, sid]
        ).map_err(|e| e.to_string())?;
      }
    }

    result.imported += 1;
  }

  Ok(result)
}

#[tauri::command]
pub fn trash_item(app: AppHandle, item_id: i64) -> Result<Status, String> {
  let root = get_root(&app)?;
  let conn = db::open(&library::db_path(&root))?;

  let file_rel: String = conn.query_row(
    "SELECT file_rel FROM items WHERE item_id=? AND trashed_at IS NULL",
    params![item_id],
    |r: &Row| r.get(0),
  ).map_err(|e| e.to_string())?;

  let src_abs = root.join(&file_rel);

  let trash_rel = file_rel.replacen("media/", ".trash/media/", 1);
  let dst_abs = root.join(&trash_rel);

  if let Some(parent) = dst_abs.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  fs::rename(&src_abs, &dst_abs).map_err(|e| e.to_string())?;

  let now = Utc::now().to_rfc3339();
  conn.execute(
    "UPDATE items SET trashed_at=? WHERE item_id=?",
    params![now, item_id]
  ).map_err(|e| e.to_string())?;

  Ok(Status { ok: true, message: "Moved to trash".into() })
}