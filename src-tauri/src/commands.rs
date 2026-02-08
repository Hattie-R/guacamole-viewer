use crate::{config, db, library};
use chrono::Utc;
use rusqlite::{params, Connection, Row, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::AppHandle;
use tauri_plugin_fs::FsExt;
use tauri::Manager;
use std::io::Write;
use std::sync::{Arc, Mutex};
use crate::fa::{FAState, FASyncStatus};
use std::io::Cursor;


pub fn get_root(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
  let cfg = config::load_config(app)?;
  let root = cfg.library_root.ok_or("Library root not set yet")?;
  Ok(PathBuf::from(root))
}

fn open_conn_for_root(root: &PathBuf) -> Result<Connection, String> {
  let conn = db::open(&library::db_path(root))?;
  db::init_schema(&conn)?;
  Ok(conn)
}

fn settings_get(conn: &Connection, key: &str) -> Result<Option<String>, String> {
  let v: Option<String> = conn
    .query_row(
      "SELECT value FROM settings WHERE key=?",
      params![key],
      |r: &Row| r.get(0),
    )
    .optional()
    .map_err(|e| e.to_string())?;
  Ok(v)
}

fn settings_set(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
  conn.execute(
    "INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
    params![key, value],
  ).map_err(|e| e.to_string())?;
  Ok(())
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

#[derive(Deserialize)]
pub struct E621Tags {
  pub general: Vec<String>,
  pub species: Vec<String>,
  pub character: Vec<String>,
  pub artist: Vec<String>,
  pub meta: Vec<String>,
  pub lore: Vec<String>,
  pub copyright: Vec<String>,
}

#[derive(Deserialize)]
pub struct E621PostInput {
  pub id: i64,
  pub file_url: String,
  pub file_ext: String,
  pub file_md5: Option<String>,
  pub rating: Option<String>,
  pub fav_count: Option<i64>,
  pub score_total: Option<i64>,
  pub created_at: Option<String>,
  pub sources: Vec<String>,
  pub tags: E621Tags,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct SyncStatus {
  pub running: bool,
  pub cancelled: bool,
  pub max_new_downloads: Option<u32>,

  pub scanned_pages: u32,
  pub scanned_posts: u32,
  pub skipped_existing: u32,

  pub new_attempted: u32,
  pub downloaded_ok: u32,
  pub failed_downloads: u32,
  pub unavailable: u32,

  pub last_error: Option<String>,
}

#[derive(Serialize)]
pub struct UnavailableDto {
  pub source: String,
  pub source_id: String,
  pub seen_at: String,
  pub reason: String,
  pub sources: Vec<String>,
}

#[tauri::command]
pub fn e621_unavailable_list(app: AppHandle, limit: u32) -> Result<Vec<UnavailableDto>, String> {
  let root = get_root(&app)?;
  let conn = db::open(&library::db_path(&root))?;
  db::init_schema(&conn)?;

  let mut stmt = conn.prepare(
    r#"
    SELECT source, source_id, seen_at, reason, sources_json
    FROM unavailable_posts
    ORDER BY seen_at DESC
    LIMIT ?
    "#
  ).map_err(|e| e.to_string())?;

  let rows = stmt.query_map([limit], |r| {
    let sources_json: String = r.get(4)?;
    let sources: Vec<String> = serde_json::from_str(&sources_json).unwrap_or_default();

    Ok(UnavailableDto {
      source: r.get(0)?,
      source_id: r.get(1)?,
      seen_at: r.get(2)?,
      reason: r.get(3)?,
      sources,
    })
  }).map_err(|e| e.to_string())?;

  let mut out = vec![];
  for row in rows {
    out.push(row.map_err(|e| e.to_string())?);
  }
  Ok(out)
}

#[derive(Default)]
pub struct SyncState {
  pub status: SyncStatus,
  pub cancel_requested: bool,
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
pub fn add_e621_post(app: AppHandle, post: E621PostInput) -> Result<Status, String> {
  let root = get_root(&app)?;
  library::ensure_layout(&root)?;

  let conn = db::open(&library::db_path(&root))?;
  db::init_schema(&conn)?;

  // dedupe by (source, id)
  let exists: i64 = conn
    .query_row(
      "SELECT COUNT(*) FROM items WHERE source='e621' AND source_id=? AND trashed_at IS NULL",
      params![post.id.to_string()],
      |r: &Row| r.get(0),
    )
    .map_err(|e| e.to_string())?;
  if exists > 0 {
    return Ok(Status { ok: true, message: "Already downloaded".into() });
  }

  // dedupe by md5 if present
  if let Some(md5) = &post.file_md5 {
    let md5_exists: i64 = conn
      .query_row(
        "SELECT COUNT(*) FROM items WHERE md5=? AND trashed_at IS NULL",
        params![md5],
        |r: &Row| r.get(0),
      )
      .map_err(|e| e.to_string())?;
    if md5_exists > 0 {
      return Ok(Status { ok: true, message: "Already downloaded (md5 match)".into() });
    }
  }

  // filename: primaryArtist_e621_<id>.<ext>
  let primary_artist = sanitize_slug(&pick_primary_artist(&post.tags.artist));
  let ext = post.file_ext.trim().to_lowercase();
  if ext.is_empty() {
    return Err("Missing file_ext from e621".into());
  }

  let base = format!("{primary_artist}_e621_{}.{}", post.id, ext);
  let media_dir = root.join("media");
  let mut filename = base.clone();
  let mut dest_path = media_dir.join(&filename);

  // ensure unique filename
  let mut n = 1;
  while dest_path.exists() {
    filename = format!("{primary_artist}_e621_{}_dup{}.{}", post.id, n, ext);
    dest_path = media_dir.join(&filename);
    n += 1;
  }

  // temp download
  let tmp_dir = root.join("cache").join("tmp");
  fs::create_dir_all(&tmp_dir).map_err(|e| e.to_string())?;
  let tmp_path = tmp_dir.join(format!("{filename}.part"));

  let client = reqwest::blocking::Client::new();
  let mut resp = client
    .get(&post.file_url)
    .header("User-Agent", "Guacamole Viewer/0.1.0 (local archiver)")
    .send()
    .map_err(|e| e.to_string())?;

  if !resp.status().is_success() {
    return Err(format!("Download failed: HTTP {}", resp.status()));
  }

  let mut file = fs::File::create(&tmp_path).map_err(|e| e.to_string())?;
  std::io::copy(&mut resp, &mut file).map_err(|e| e.to_string())?;
  file.flush().map_err(|e| e.to_string())?;

  fs::rename(&tmp_path, &dest_path).map_err(|e| e.to_string())?;

  let file_rel = format!("media/{}", filename.replace('\\', "/"));
  let added_at = Utc::now().to_rfc3339();

  conn.execute(
    r#"
    INSERT INTO items(source, source_id, md5, remote_url, file_rel, ext, rating, fav_count, score_total, created_at, added_at, primary_artist)
    VALUES('e621', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    "#,
    params![
      post.id.to_string(),
      post.file_md5,
      post.file_url,
      file_rel,
      ext,
      post.rating,
      post.fav_count,
      post.score_total,
      post.created_at,
      added_at,
      primary_artist
    ],
  ).map_err(|e| e.to_string())?;

  let item_id = conn.last_insert_rowid();

  // typed tags
  for t in post.tags.general { let id = upsert_tag(&conn, &t, "general")?; conn.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)", params![item_id, id]).map_err(|e| e.to_string())?; }
  for t in post.tags.species { let id = upsert_tag(&conn, &t, "species")?; conn.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)", params![item_id, id]).map_err(|e| e.to_string())?; }
  for t in post.tags.character { let id = upsert_tag(&conn, &t, "character")?; conn.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)", params![item_id, id]).map_err(|e| e.to_string())?; }
  for t in post.tags.artist { let id = upsert_tag(&conn, &t, "artist")?; conn.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)", params![item_id, id]).map_err(|e| e.to_string())?; }
  for t in post.tags.meta { let id = upsert_tag(&conn, &t, "meta")?; conn.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)", params![item_id, id]).map_err(|e| e.to_string())?; }
  for t in post.tags.lore { let id = upsert_tag(&conn, &t, "lore")?; conn.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)", params![item_id, id]).map_err(|e| e.to_string())?; }
  for t in post.tags.copyright { let id = upsert_tag(&conn, &t, "copyright")?; conn.execute("INSERT OR IGNORE INTO item_tags(item_id, tag_id) VALUES(?,?)", params![item_id, id]).map_err(|e| e.to_string())?; }

  // sources urls
  for u in post.sources {
    let sid = upsert_source(&conn, &u)?;
    conn.execute(
      "INSERT OR IGNORE INTO item_sources(item_id, source_row_id) VALUES(?, ?)",
      params![item_id, sid],
    ).map_err(|e| e.to_string())?;
  }

  Ok(Status { ok: true, message: "Downloaded into library".into() })
}

#[derive(Serialize)]
pub struct E621CredInfo {
  pub username: Option<String>,
  pub has_api_key: bool,
}

fn load_e621_creds(conn: &Connection) -> Result<(String, String), String> {
  let username = settings_get(conn, "e621_username")?
    .ok_or("e621 username not set")?;
  let api_key = settings_get(conn, "e621_api_key")?
    .ok_or("e621 api key not set")?;
  Ok((username, api_key))
}

fn upsert_unavailable(
  conn: &Connection,
  source: &str,
  source_id: &str,
  reason: &str,
  sources: Vec<String>,
) -> Result<(), String> {
  let seen_at = Utc::now().to_rfc3339();
  let sources_json = serde_json::to_string(&sources).map_err(|e| e.to_string())?;

  conn.execute(
    r#"
    INSERT INTO unavailable_posts(source, source_id, seen_at, reason, sources_json)
    VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(source, source_id)
    DO UPDATE SET seen_at=excluded.seen_at, reason=excluded.reason, sources_json=excluded.sources_json
    "#,
    params![source, source_id, seen_at, reason, sources_json],
  ).map_err(|e| e.to_string())?;

  Ok(())
}

#[tauri::command]
pub fn e621_get_cred_info(app: AppHandle) -> Result<E621CredInfo, String> {
  let root = get_root(&app)?;
  let conn = open_conn_for_root(&root)?;
  let username = settings_get(&conn, "e621_username")?;
  let has_api_key = settings_get(&conn, "e621_api_key")?.is_some();
  Ok(E621CredInfo { username, has_api_key })
}

#[tauri::command]
pub fn e621_set_credentials(app: AppHandle, username: String, api_key: String) -> Result<Status, String> {
  let root = get_root(&app)?;
  let conn = open_conn_for_root(&root)?;

  let u = username.trim();
  if u.is_empty() {
    return Err("Username cannot be empty".into());
  }
  settings_set(&conn, "e621_username", u)?;

  // allow leaving api_key blank to keep existing key
  if !api_key.trim().is_empty() {
    settings_set(&conn, "e621_api_key", api_key.trim())?;
  }

  Ok(Status { ok: true, message: "Saved e621 credentials".into() })
}

#[tauri::command]
pub fn e621_test_connection(app: AppHandle) -> Result<Status, String> {
  let root = get_root(&app)?;
  let conn = open_conn_for_root(&root)?;
  let (username, api_key) = load_e621_creds(&conn)?;

  let client = reqwest::blocking::Client::new();
  let resp = client
    .get("https://e621.net/posts.json")
    .basic_auth(username, Some(api_key))
    .header("User-Agent", "Guacamole Viewer/0.1.0 (test)")
    .query(&[("limit", "1"), ("tags", "order:id_desc")])
    .send()
    .map_err(|e| e.to_string())?;

  if !resp.status().is_success() {
    return Err(format!("Test failed: HTTP {}", resp.status()));
  }

  Ok(Status { ok: true, message: "Connected to e621 successfully".into() })
}

#[tauri::command]
pub fn e621_fetch_posts(app: AppHandle, tags: String, limit: u32, page: Option<String>) -> Result<serde_json::Value, String> {
  let root = get_root(&app)?;
  let conn = open_conn_for_root(&root)?;
  let (username, api_key) = load_e621_creds(&conn)?;

  let client = reqwest::blocking::Client::new();
  let mut req = client
    .get("https://e621.net/posts.json")
    .basic_auth(username, Some(api_key))
    .header("User-Agent", "Guacamole Viewer/0.1.0 (feeds)")
    .query(&[("tags", tags), ("limit", limit.to_string())]);

  if let Some(p) = page {
    req = req.query(&[("page", p)]);
  }

  let resp = req.send().map_err(|e| e.to_string())?;
  if !resp.status().is_success() {
    return Err(format!("e621 error: HTTP {}", resp.status()));
  }

  resp.json::<serde_json::Value>().map_err(|e| e.to_string())
}

#[tauri::command]
pub fn e621_sync_status(state: tauri::State<'_, Arc<Mutex<SyncState>>>) -> Result<SyncStatus, String> {
  let st = state.lock().map_err(|_| "Sync state lock poisoned")?;
  Ok(st.status.clone())
}

#[tauri::command]
pub fn e621_sync_cancel(state: tauri::State<'_, Arc<Mutex<SyncState>>>) -> Result<Status, String> {
  let mut st = state.lock().map_err(|_| "Sync state lock poisoned")?;
  st.cancel_requested = true;
  st.status.cancelled = true;
  Ok(Status { ok: true, message: "Cancel requested".into() })
}

#[tauri::command]
pub fn e621_sync_start(
  app: AppHandle,
  state: tauri::State<'_, Arc<Mutex<SyncState>>>,
  max_new_downloads: Option<u32>,
) -> Result<Status, String> {
  {
    let mut st = state.lock().map_err(|_| "Sync state lock poisoned")?;
    if st.status.running {
      return Err("Sync already running".into());
    }
    st.cancel_requested = false;
    st.status = SyncStatus {
      running: true,
      cancelled: false,
      max_new_downloads,
      ..Default::default()
    };
  }

  let app2 = app.clone();
  let state2 = state.inner().clone();

  std::thread::spawn(move || {
    let result: Result<(), String> = (|| {
      let root = get_root(&app2)?;
      let conn = db::open(&library::db_path(&root))?;
      db::init_schema(&conn)?;

      // Load creds from DB settings (you already implemented e621 creds in settings)
      // This expects keys: e621_username, e621_api_key
      let username: String = conn.query_row(
        "SELECT value FROM settings WHERE key='e621_username'",
        [],
        |r: &Row| r.get(0),
      ).map_err(|_| "e621 username not set")?;

      let api_key: String = conn.query_row(
        "SELECT value FROM settings WHERE key='e621_api_key'",
        [],
        |r: &Row| r.get(0),
      ).map_err(|_| "e621 api key not set")?;

      let client = reqwest::blocking::Client::new();

      let mut page: u32 = 1;

      loop {
        // cancel check
        {
          let st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
          if st.cancel_requested {
            break;
          }
        }

        // stop if hit max
        {
          let st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
          if let Some(maxn) = st.status.max_new_downloads {
            if st.status.new_attempted >= maxn {
              break;
            }
          }
        }

        // fetch favorites page
        let tags = format!("fav:{} order:id_desc", username);
        let resp = client
          .get("https://e621.net/posts.json")
          .basic_auth(&username, Some(&api_key))
          .header("User-Agent", "Guacamole Viewer/0.1.0 (sync)")
          .query(&[
            ("tags", tags.as_str()),
            ("limit", "320"),
            ("page", &page.to_string()),
          ])
          .send()
          .map_err(|e| e.to_string())?;

        if !resp.status().is_success() {
          return Err(format!("e621 sync API error: HTTP {}", resp.status()));
        }

        let json: serde_json::Value = resp.json().map_err(|e| e.to_string())?;
        let posts = json.get("posts").and_then(|p| p.as_array()).cloned().unwrap_or_default();

        {
          let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
          st.status.scanned_pages += 1;
        }

        if posts.is_empty() {
          break;
        }

        for p in posts {
          // cancel check
          {
            let st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            if st.cancel_requested {
              break;
            }
          }

          {
            let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            st.status.scanned_posts += 1;
          }

          let post_id = p.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
          if post_id == 0 {
            continue;
          }

          // already downloaded check by (source,id)
          let exists: i64 = conn.query_row(
            "SELECT COUNT(*) FROM items WHERE source='e621' AND source_id=? AND trashed_at IS NULL",
            params![post_id.to_string()],
            |r: &Row| r.get(0),
          ).map_err(|e| e.to_string())?;

          if exists > 0 {
            let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            st.status.skipped_existing += 1;
            continue;
          }

          // md5 check (optional)
          let md5 = p.get("file").and_then(|f| f.get("md5")).and_then(|m| m.as_str()).map(|s| s.to_string());
          if let Some(ref m) = md5 {
            let md5_exists: i64 = conn.query_row(
              "SELECT COUNT(*) FROM items WHERE md5=? AND trashed_at IS NULL",
              params![m],
              |r: &Row| r.get(0),
            ).map_err(|e| e.to_string())?;
            if md5_exists > 0 {
              let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
              st.status.skipped_existing += 1;
              continue;
            }
          }

          // stop after N new downloads (attempted)
          {
            let st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            if let Some(maxn) = st.status.max_new_downloads {
              if st.status.new_attempted >= maxn {
                break;
              }
            }
          }

          // file.url might be missing for deleted/blocked
          let file_url = p.get("file").and_then(|f| f.get("url")).and_then(|u| u.as_str()).map(|s| s.to_string());
          let file_ext = p.get("file").and_then(|f| f.get("ext")).and_then(|u| u.as_str()).unwrap_or("").to_string();

          let sources: Vec<String> = p.get("sources")
            .and_then(|s| s.as_array())
            .map(|arr| arr.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
            .unwrap_or_default();

          if file_url.is_none() {
            upsert_unavailable(&conn, "e621", &post_id.to_string(), "missing_file_url", sources)?;
            let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            st.status.unavailable += 1;
            continue;
          }

          // convert to your existing E621PostInput and reuse add_e621_post
          let tags_obj = p.get("tags").cloned().unwrap_or(serde_json::Value::Null);

          let vec_from = |k: &str| -> Vec<String> {
            tags_obj.get(k)
              .and_then(|v| v.as_array())
              .map(|a| a.iter().filter_map(|x| x.as_str().map(|s| s.to_string())).collect())
              .unwrap_or_default()
          };

          let post_input = E621PostInput {
            id: post_id,
            file_url: file_url.clone().unwrap(),
            file_ext,
            file_md5: md5.clone(),
            rating: p.get("rating").and_then(|x| x.as_str()).map(|s| s.to_string()),
            fav_count: p.get("fav_count").and_then(|x| x.as_i64()),
            score_total: p.get("score").and_then(|s| s.get("total")).and_then(|x| x.as_i64()),
            created_at: p.get("created_at").and_then(|x| x.as_str()).map(|s| s.to_string()),
            sources,
            tags: E621Tags {
              general: vec_from("general"),
              species: vec_from("species"),
              character: vec_from("character"),
              artist: vec_from("artist"),
              meta: vec_from("meta"),
              lore: vec_from("lore"),
              copyright: vec_from("copyright"),
            },
          };

          {
            let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
            st.status.new_attempted += 1;
          }

          match add_e621_post(app2.clone(), post_input) {
            Ok(_) => {
              let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
              st.status.downloaded_ok += 1;
            }
            Err(err) => {
              // keep the sources in unavailable so the user can follow them
              upsert_unavailable(&conn, "e621", &post_id.to_string(), "download_failed", file_url.is_some().then(|| vec![]).unwrap_or_default())?;
              let mut st = state2.lock().map_err(|_| "Sync state lock poisoned")?;
              st.status.failed_downloads += 1;
              st.status.last_error = Some(err);
            }
          }
        }

        page += 1;
      }

      Ok(())
    })();

    // mark finished
    let mut st = state2.lock().ok();
    if let Some(ref mut st) = st {
      st.status.running = false;
      if let Err(e) = result {
        st.status.last_error = Some(e);
      }
    }
  });

  Ok(Status { ok: true, message: "Sync started".into() })
}

#[tauri::command]
pub fn e621_favorite(app: AppHandle, post_id: i64) -> Result<Status, String> {
  let root = get_root(&app)?;
  let conn = open_conn_for_root(&root)?;
  let (username, api_key) = load_e621_creds(&conn)?;

  let client = reqwest::blocking::Client::new();
  let resp = client
    .post("https://e621.net/favorites.json")
    .basic_auth(username, Some(api_key))
    .header("User-Agent", "Guacamole Viewer/0.1.0 (favorite)")
    .header("Content-Type", "application/x-www-form-urlencoded")
    .body(format!("post_id={}", post_id))
    .send()
    .map_err(|e| e.to_string())?;

  // 422 = already favorited, acceptable for "ensure"
  if !resp.status().is_success() && resp.status().as_u16() != 422 {
    return Err(format!("Favorite failed: HTTP {}", resp.status()));
  }

  Ok(Status { ok: true, message: "Favorited on e621".into() })
}

#[tauri::command]
pub fn fa_set_credentials(app: tauri::AppHandle, a: String, b: String) -> Result<(), String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("fa_creds.json");
    
    // Ensure the config directory exists!
    if let Some(parent) = path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
    }

    let json = serde_json::json!({ "a": a, "b": b });
    std::fs::write(&path, json.to_string()).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[derive(serde::Serialize)]
pub struct FaCredInfo {
    pub has_creds: bool,
}

#[tauri::command]
pub fn fa_get_cred_info(app: tauri::AppHandle) -> Result<FaCredInfo, String> {
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("fa_creds.json");
    Ok(FaCredInfo { has_creds: path.exists() })
}

#[tauri::command]
pub fn fa_start_sync(app: tauri::AppHandle, limit: Option<u32>) -> Result<(), String> {
    // Load creds
    let path = app.path().app_config_dir().map_err(|e| e.to_string())?.join("fa_creds.json");
    if !path.exists() { return Err("No credentials set".into()); }
    
    let content = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
    let json: serde_json::Value = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    
    let a = json["a"].as_str().unwrap_or("").to_string();
    let b = json["b"].as_str().unwrap_or("").to_string();

    let stop_after = limit.unwrap_or(0); // 0 = unlimited

    tauri::async_runtime::spawn(async move {
        crate::fa::run_sync(app, a, b, stop_after).await;
    });

    Ok(())
}

#[tauri::command]
pub fn get_trash_count(app: tauri::AppHandle) -> Result<u32, String> {
    let root = get_root(&app)?;
    let conn = db::open(&library::db_path(&root))?;
    let count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE trashed_at IS NOT NULL",
        [],
        |row| row.get(0),
    ).unwrap_or(0);
    Ok(count)
}

#[tauri::command]
pub fn get_trashed_items(app: tauri::AppHandle) -> Result<Vec<ItemDto>, String> {
    let root = get_root(&app)?;
    let conn = db::open(&library::db_path(&root))?;

    let mut stmt = conn.prepare(
        r#"
        SELECT
          i.item_id, i.source, i.source_id, i.remote_url, i.file_rel, i.ext,
          i.rating, i.fav_count, i.score_total, i.created_at, i.added_at,
          '', '', '' -- We don't need tags/sources for the trash view usually
        FROM items i
        WHERE i.trashed_at IS NOT NULL
        ORDER BY i.trashed_at DESC
        "#
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map([], |r| {
        let file_rel: String = r.get(4)?;
        let file_abs = root.join(&file_rel);
        
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
            tags: vec![],
            artists: vec![],
            sources: vec![],
        })
    }).map_err(|e| e.to_string())?;

    let mut out = vec![];
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn restore_item(app: tauri::AppHandle, item_id: i64) -> Result<(), String> {
    let root = get_root(&app)?;
    let conn = db::open(&library::db_path(&root))?;
    
    conn.execute(
        "UPDATE items SET trashed_at = NULL WHERE item_id = ?",
        [item_id]
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub fn empty_trash(app: tauri::AppHandle) -> Result<(), String> {
    let root = get_root(&app)?;
    let conn = db::open(&library::db_path(&root))?;

    // 1. Get all files to delete
    let mut stmt = conn.prepare("SELECT file_rel FROM items WHERE trashed_at IS NOT NULL")
        .map_err(|e| e.to_string())?;
    
    let files_to_delete: Vec<String> = stmt.query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    // 2. Delete from Disk
    for rel_path in files_to_delete {
        let abs_path = root.join(rel_path);
        if abs_path.exists() {
            let _ = std::fs::remove_file(abs_path); // Ignore errors if file missing
        }
    }

    // 3. Delete from DB (Cascades should handle tags/sources if set up, but let's be clean)
    // Note: If you don't have ON DELETE CASCADE in your schema, you might leave orphan tags.
    // For simplicity, we just delete the item row here.
    conn.execute("DELETE FROM items WHERE trashed_at IS NOT NULL", [])
        .map_err(|e| e.to_string())?;

    Ok(())
}

#[tauri::command]
pub fn fa_sync_status(state: tauri::State<FAState>) -> FASyncStatus {
    state.status.lock().unwrap().clone()
}

#[tauri::command]
pub fn fa_cancel_sync(state: tauri::State<FAState>) {
    *state.should_cancel.lock().unwrap() = true;
}

#[tauri::command]
pub fn clear_library_root(app: tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("config.json");

    // Remove the config file entirely, or write an empty config
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn update_item_tags(app: tauri::AppHandle, item_id: i64, tags: Vec<String>) -> Result<(), String> {
    let root = get_root(&app)?;
    let mut conn = db::open(&library::db_path(&root))?;
    
    // Use a transaction to ensure all or nothing
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 1. Remove ALL existing tags for this item
    tx.execute("DELETE FROM item_tags WHERE item_id = ?", [item_id])
        .map_err(|e| e.to_string())?;

    // 2. Add the new list
    for tag in tags {
        let clean_tag = tag.trim().to_lowercase();
        if clean_tag.is_empty() { continue; }

        // Ensure tag exists in the 'tags' table (defaulting to 'general' type)
        tx.execute(
            "INSERT OR IGNORE INTO tags (name, type) VALUES (?, 'general')",
            [&clean_tag]
        ).map_err(|e| e.to_string())?;

        // Get the tag's ID
        let tag_id: i64 = tx.query_row(
            "SELECT tag_id FROM tags WHERE name = ?",
            [&clean_tag],
            |row| row.get(0)
        ).map_err(|e| e.to_string())?;

        // Link item to tag
        tx.execute(
            "INSERT INTO item_tags (item_id, tag_id) VALUES (?, ?)",
            [item_id, tag_id]
        ).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn e621_clear_credentials(app: tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_config_dir()
        .map_err(|e| e.to_string())?
        .join("e621_credentials.json");

    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
pub fn get_library_stats(app: tauri::AppHandle) -> Result<u32, String> {
  let root = get_root(&app)?;
  let conn = db::open(&library::db_path(&root))?;

  let count: u32 = conn.query_row(
    "SELECT COUNT(*) FROM items WHERE trashed_at IS NULL",
    [],
    |row| row.get(0),
  ).map_err(|e| e.to_string())?;

  Ok(count)
}

#[tauri::command]
pub fn update_item_rating(app: tauri::AppHandle, item_id: i64, rating: String) -> Result<(), String> {
    let root = get_root(&app)?;
    let conn = db::open(&library::db_path(&root))?;
    
    // rating must be 's', 'q', or 'e'
    let r = match rating.to_lowercase().as_str() {
        "s" | "safe" => "s",
        "q" | "questionable" => "q",
        "e" | "explicit" => "e",
        _ => return Err("Invalid rating".into()),
    };

        // Convert ID to string first so it lives long enough
    let id_str = item_id.to_string();
    
    conn.execute(
        "UPDATE items SET rating = ? WHERE item_id = ?",
        rusqlite::params![r, id_str],
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub fn update_item_sources(app: tauri::AppHandle, item_id: i64, sources: Vec<String>) -> Result<(), String> {
    let root = get_root(&app)?;
    let mut conn = db::open(&library::db_path(&root))?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // 1. Unlink all existing sources for this item
    tx.execute("DELETE FROM item_sources WHERE item_id = ?", [item_id])
        .map_err(|e| e.to_string())?;

    // 2. Add new sources
    for url in sources {
        let clean_url = url.trim();
        if clean_url.is_empty() { continue; }

        // Insert Source URL if new
        tx.execute("INSERT OR IGNORE INTO sources (url) VALUES (?)", [clean_url])
            .map_err(|e| e.to_string())?;
        
        // Get Source ID
        let source_row_id: i64 = tx.query_row(
            "SELECT source_row_id FROM sources WHERE url = ?", 
            [clean_url], 
            |r| r.get(0)
        ).map_err(|e| e.to_string())?;

        // Link
        tx.execute(
            "INSERT INTO item_sources (item_id, source_row_id) VALUES (?, ?)", 
            [item_id, source_row_id]
        ).map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn list_items(
    app: tauri::AppHandle,
    limit: Option<u32>,
    offset: Option<u32>,
    search: Option<String>, // Tag search only
    rating: Option<String>, // 's', 'q', 'e', or 'nsfw'
    source: Option<String>, // 'e621', 'furaffinity', or 'all'
    order: Option<String>,  // 'newest', 'oldest', 'score', 'random'
) -> Result<Vec<ItemDto>, String> {
    let limit = limit.unwrap_or(100);
    let offset = offset.unwrap_or(0);
    let search_query = search.unwrap_or_default();
    let rating_filter = rating.unwrap_or("all".to_string());
    let source_filter = source.unwrap_or("all".to_string());
    let sort_order = order.unwrap_or("newest".to_string());

    let root = get_root(&app)?;
    let conn = db::open(&library::db_path(&root))?;

    // Base SQL
    let mut sql = String::from(
        r#"
        SELECT
          i.item_id, i.source, i.source_id, i.remote_url, i.file_rel, i.ext,
          i.rating, i.fav_count, i.score_total, i.created_at, i.added_at,
          (SELECT GROUP_CONCAT(t.name, char(9)) FROM item_tags it JOIN tags t ON it.tag_id = t.tag_id WHERE it.item_id = i.item_id),
          (SELECT GROUP_CONCAT(t.name, char(9)) FROM item_tags it JOIN tags t ON it.tag_id = t.tag_id WHERE it.item_id = i.item_id AND t.type = 'artist'),
          (SELECT GROUP_CONCAT(s.url, char(9)) FROM item_sources isrc JOIN sources s ON isrc.source_row_id = s.source_row_id WHERE isrc.item_id = i.item_id)
        FROM items i
        WHERE i.trashed_at IS NULL
        "#
    );

    let mut params_store: Vec<String> = vec![]; 
    let mut where_clauses: Vec<String> = vec![];

    // --- 1. RATING FILTER ---
    if rating_filter != "all" {
        if rating_filter == "nsfw" {
            where_clauses.push("(i.rating = 'q' OR i.rating = 'e')".to_string());
        } else {
            params_store.push(rating_filter);
            where_clauses.push(format!("i.rating = ?{}", params_store.len()));
        }
    }

    // --- 2. SOURCE FILTER ---
    if source_filter != "all" {
        params_store.push(source_filter);
        where_clauses.push(format!("i.source = ?{}", params_store.len()));
    }

    // --- 3. TAG SEARCH ---
    let terms: Vec<&str> = search_query.split_whitespace().collect();
    for term in terms {
        // --- 1. NEGATED TYPE (-type:image) ---
        if term.starts_with("-type:") {
            let val = term.replace("-type:", "").to_lowercase();
            match val.as_str() {
                "image" | "img" => where_clauses.push("NOT (i.ext IN ('jpg', 'jpeg', 'png', 'webp'))".to_string()),
                "video" | "vid" => where_clauses.push("NOT (i.ext IN ('mp4', 'webm'))".to_string()),
                "gif" => where_clauses.push("i.ext != 'gif'".to_string()),
                _ => {}
            }
        }
        // --- 2. POSITIVE TYPE (type:video) ---
        else if term.starts_with("type:") {
            let val = term.replace("type:", "").to_lowercase();
            match val.as_str() {
                "image" | "img" => where_clauses.push("(i.ext IN ('jpg', 'jpeg', 'png', 'webp'))".to_string()),
                "video" | "vid" => where_clauses.push("(i.ext IN ('mp4', 'webm'))".to_string()),
                "gif" => where_clauses.push("(i.ext = 'gif')".to_string()),
                _ => {}
            }
        }
        // --- 3. NEGATED EXTENSION (-ext:png) ---
        else if term.starts_with("-ext:") {
            let val = term.replace("-ext:", "").to_lowercase();
            params_store.push(val);
            where_clauses.push(format!("i.ext != ?{}", params_store.len()));
        }
        // --- 4. POSITIVE EXTENSION (ext:png) ---
        else if term.starts_with("ext:") {
            let val = term.replace("ext:", "").to_lowercase();
            params_store.push(val);
            where_clauses.push(format!("i.ext = ?{}", params_store.len()));
        }
        // --- 5. META TAGS (rating, source, order - ignored here, handled by params) ---
        // We skip these so they don't get treated as generic tags
        else if term.starts_with("rating:") || term.starts_with("source:") || term.starts_with("order:") {
            continue;
        }
        // --- 6. NEGATED TAG (-tag) ---
        else if term.starts_with("-") {
            let tag = term.trim_start_matches("-").to_lowercase();
            params_store.push(tag);
            where_clauses.push(format!(
                "NOT EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.tag_id WHERE it.item_id = i.item_id AND t.name = ?{})", 
                params_store.len()
            ));
        }
        // --- 7. REGULAR TAG (tag) ---
        else {
            let tag = term.to_lowercase();
            if tag.contains("*") {
                let like_tag = tag.replace("*", "%");
                params_store.push(like_tag);
                where_clauses.push(format!(
                    "EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.tag_id WHERE it.item_id = i.item_id AND t.name LIKE ?{})", 
                    params_store.len()
                ));
            } else {
                params_store.push(tag);
                where_clauses.push(format!(
                    "EXISTS (SELECT 1 FROM item_tags it JOIN tags t ON it.tag_id = t.tag_id WHERE it.item_id = i.item_id AND t.name = ?{})", 
                    params_store.len()
                ));
            }
        }
    }

    // --- APPLY WHERE ---
    if !where_clauses.is_empty() {
        sql.push_str(" AND ");
        sql.push_str(&where_clauses.join(" AND "));
    }

    // --- 4. ORDERING ---
    let order_clause = match sort_order.as_str() {
        "score" => "ORDER BY i.score_total DESC",
        "favs" | "favcount" => "ORDER BY i.fav_count DESC",
        "random" => "ORDER BY RANDOM()",
        "oldest" => "ORDER BY i.added_at ASC",
        _ => "ORDER BY i.added_at DESC", // Default 'newest'
    };

    sql.push_str(&format!(" {} LIMIT {} OFFSET {}", order_clause, limit, offset));

    // Prepare & Execute
    let db_params: Vec<&dyn rusqlite::ToSql> = params_store.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
    let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
    
    let rows = stmt.query_map(&*db_params, |r| {
        let file_rel: String = r.get(4)?;
        let file_abs = root.join(&file_rel);
        
        let split_tab = |s: String| -> Vec<String> {
            if s.is_empty() { vec![] } else { s.split('\t').map(|x| x.to_string()).collect() }
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
            tags: split_tab(r.get(11).unwrap_or_default()),
            artists: split_tab(r.get(12).unwrap_or_default()),
            sources: split_tab(r.get(13).unwrap_or_default()),
        })
    }).map_err(|e| e.to_string())?;

    let mut out = vec![];
    for row in rows {
        out.push(row.map_err(|e| e.to_string())?);
    }
    Ok(out)
}

#[tauri::command]
pub fn get_thumbnail(app: tauri::AppHandle, file_rel: String) -> Result<Vec<u8>, String> {
    let root = get_root(&app)?;
    let path = root.join(&file_rel);
    
    // Check cache first? (Optional optimization: save thumbs to disk)
    // For now, let's generate on fly (might be slow) or just return the file if it's small.
    
    // BETTER STRATEGY:
    // Only generate if we don't have it. Save it to `library/.cache/thumbs/`
    
    let cache_dir = root.join(".cache").join("thumbs");
    if !cache_dir.exists() {
        std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    }
    
    // Hash path to get unique filename
    let name_hash = format!("{:x}", md5::compute(file_rel.as_bytes()));
    let thumb_path = cache_dir.join(format!("{}.jpg", name_hash));
    
    if thumb_path.exists() {
        return std::fs::read(thumb_path).map_err(|e| e.to_string());
    }
    
    // Generate
    if path.extension().unwrap_or_default() == "mp4" || path.extension().unwrap_or_default() == "webm" {
        // Video thumbnailing is hard without ffmpeg. Return empty or placeholder?
        // For now, let's just error so frontend shows default icon
        return Err("Video thumbnail not supported yet".into());
    }

    let img = image::open(&path).map_err(|e| e.to_string())?;
    let thumb = img.thumbnail(300, 300); // 300px max width/height
    
    let mut bytes: Vec<u8> = Vec::new();
    thumb.write_to(&mut Cursor::new(&mut bytes), image::ImageOutputFormat::Jpeg(80))
        .map_err(|e| e.to_string())?;
        
    // Save to cache
    std::fs::write(&thumb_path, &bytes).map_err(|e| e.to_string())?;
    
    Ok(bytes)
}

#[tauri::command]
pub fn ensure_thumbnail(app: tauri::AppHandle, file_rel: String) -> Result<String, String> {
    let root = get_root(&app)?;
    let path = root.join(&file_rel);
    let cache_dir = root.join(".cache").join("thumbs");
    
    if !cache_dir.exists() {
        std::fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    }
    
    let name_hash = format!("{:x}", md5::compute(file_rel.as_bytes()));
    let thumb_filename = format!("{}.jpg", name_hash);
    let thumb_path = cache_dir.join(&thumb_filename);
    
    // Return relative path if exists
    if thumb_path.exists() {
        return Ok(format!(".cache/thumbs/{}", thumb_filename));
    }
    
    // If video, skip generation for now
    let ext = path.extension().and_then(|s| s.to_str()).unwrap_or("").to_lowercase();
    if ext == "mp4" || ext == "webm" || ext == "gif" {
        // For GIFs/Videos, we might just return the original file if we can't thumb it easily
        // Or return empty string to signal "use placeholder"
        return Ok("".to_string());
    }

    // Generate
    let img = image::open(&path).map_err(|e| format!("Failed to open image: {}", e))?;
    let thumb = img.thumbnail(250, 250); // Small grid size
    
    let mut bytes: Vec<u8> = Vec::new();
    thumb.write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageOutputFormat::Jpeg(70))
        .map_err(|e| e.to_string())?;
        
    std::fs::write(&thumb_path, &bytes).map_err(|e| e.to_string())?;
    
    Ok(format!(".cache/thumbs/{}", thumb_filename))
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
pub fn trash_item(app: tauri::AppHandle, item_id: i64) -> Result<(), String> {
    let root = get_root(&app)?;
    let conn = db::open(&library::db_path(&root))?;
    
    // Soft delete: Set trashed_at to current timestamp
    let now = chrono::Local::now().to_rfc3339();
    
    conn.execute(
        "UPDATE items SET trashed_at = ? WHERE item_id = ?",
        [now, item_id.to_string()] // Convert i64 to string just in case, but params usually handles it
    ).map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
pub fn auto_clean_trash(app: tauri::AppHandle) {
    let _ = prune_expired_trash(&app);
}

// Prune items trashed more than 30 days ago
pub fn prune_expired_trash(app: &tauri::AppHandle) -> Result<(), String> {
    let root = match get_root(app) {
        Ok(r) => r,
        Err(_) => return Ok(()), // No library loaded yet
    };
    
    let conn = db::open(&library::db_path(&root)).map_err(|e| e.to_string())?;

    // 1. Find expired files
    // SQL: Select items trashed > 30 days ago
    // We use SQLite's datetime functions. 
    // 'now' is UTC. 'trashed_at' is stored as ISO8601 string.
    let mut stmt = conn.prepare(
        "SELECT file_rel FROM items WHERE trashed_at < datetime('now', '-30 days') AND trashed_at IS NOT NULL"
    ).map_err(|e| e.to_string())?;

    let files_to_delete: Vec<String> = stmt.query_map([], |row| row.get(0))
        .map_err(|e| e.to_string())?
        .filter_map(Result::ok)
        .collect();

    // 2. Delete files from disk
    for rel_path in files_to_delete {
        let abs_path = root.join(rel_path);
        if abs_path.exists() {
            let _ = std::fs::remove_file(abs_path);
        }
    }

    // 3. Delete rows from DB
    conn.execute(
        "DELETE FROM items WHERE trashed_at < datetime('now', '-30 days') AND trashed_at IS NOT NULL",
        []
    ).map_err(|e| e.to_string())?;

    Ok(())
}