use crate::{db, library};
use rusqlite::{params, Connection};
use scraper::{Html, Selector};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::AppHandle;
use tauri::Manager;

// --- Data Structures ---

#[derive(Serialize, Clone, Default)]
pub struct FASyncStatus {
    pub running: bool,
    pub scanned: u32,
    pub skipped_url: u32,
    pub skipped_md5: u32,
    pub imported: u32,
    pub upgraded: u32,
    pub errors: u32,
    pub current_message: String,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct E621File {
    url: Option<String>,
    ext: Option<String>,
    md5: Option<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct E621Tags {
    general: Vec<String>,
    species: Vec<String>,
    character: Vec<String>,
    artist: Vec<String>,
    meta: Vec<String>,
    lore: Vec<String>,
    copyright: Vec<String>,
}

#[derive(Deserialize)]
#[allow(dead_code)]
struct E621Post {
    id: u64,
    file: E621File,
    tags: E621Tags,
    rating: String,
    fav_count: u32,
    score: serde_json::Value,
    created_at: String,
    sources: Option<Vec<String>>,
}

#[derive(Deserialize)]
struct E621Response {
    posts: Vec<E621Post>,
}

pub struct FAState {
    pub status: Arc<Mutex<FASyncStatus>>,
    pub should_cancel: Arc<Mutex<bool>>,
}

impl FAState {
    pub fn new() -> Self {
        Self {
            status: Arc::new(Mutex::new(FASyncStatus::default())),
            should_cancel: Arc::new(Mutex::new(false)),
        }
    }
}

// --- Helper Functions ---

fn check_db_exists(conn: &Connection, source: &str, id: &str) -> bool {
    let count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE source = ? AND source_id = ?",
        [source, id],
        |row| row.get(0),
    ).unwrap_or(0);
    count > 0
}

fn check_local_md5(conn: &Connection, hash: &str) -> bool {
    let count: u32 = conn.query_row(
        "SELECT COUNT(*) FROM items WHERE file_md5 = ?",
        [hash],
        |row| row.get(0),
    ).unwrap_or(0);
    count > 0
}

async fn check_e621_md5(client: &reqwest::Client, hash: &str) -> Option<E621Post> {
    let url = format!("https://e621.net/posts.json?tags=md5:{}", hash);
    match client.get(&url).header("User-Agent", "TailBurrow/0.1.0").send().await {
        Ok(resp) => {
            if let Ok(json) = resp.json::<E621Response>().await {
                return json.posts.into_iter().next();
            }
        }
        Err(_) => {}
    };
    None
}

// --- Main Logic ---

pub async fn run_sync(app: AppHandle, cookie_a: String, cookie_b: String, stop_after: u32) {
    let state = app.state::<FAState>();
    
    {
        let mut s = state.status.lock().unwrap();
        *s = FASyncStatus { running: true, ..Default::default() };
        *state.should_cancel.lock().unwrap() = false;
    }

    let fa_client = reqwest::Client::builder()
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
        .build()
        .unwrap();

    let e621_client = reqwest::Client::new();
    let cookie_header = format!("a={}; b={}", cookie_a, cookie_b);

    let root = match crate::commands::get_root(&app) {
        Ok(r) => r,
        Err(_) => {
            let mut s = state.status.lock().unwrap();
            s.running = false;
            s.current_message = "Error: Library not loaded".to_string();
            return;
        },
    };
    let db_path = library::db_path(&root);

    let media_dir = root.join("media");
    if !media_dir.exists() {
        let _ = fs::create_dir_all(&media_dir);
    }

    let mut page = 1;
    
    loop {
        if *state.should_cancel.lock().unwrap() { break; }

        {
            let mut s = state.status.lock().unwrap();
            s.current_message = format!("Scanning page {}...", page);
        }

        let url = if page == 1 {
            "https://www.furaffinity.net/controls/favorites/".to_string()
        } else {
            format!("https://www.furaffinity.net/controls/favorites/{}/", page)
        };

        let resp = match fa_client.get(&url).header("Cookie", &cookie_header).send().await {
            Ok(r) => r,
            Err(_) => break,
        };

        let html = resp.text().await.unwrap_or_default();
        
        let ids: Vec<String> = {
            let document = Html::parse_document(&html);
            let figure_selector = Selector::parse("figure.t-image").unwrap();
            
            document.select(&figure_selector)
                .filter_map(|figure| {
                    figure.value().attr("id")
                        .map(|id| id.replace("sid-", ""))
                })
                .collect()
        };

        if ids.is_empty() {
            println!("No favorites found on page {}. Ending.", page);
            break; 
        }

        for id_str in ids {
            if *state.should_cancel.lock().unwrap() { break; }
            if id_str.is_empty() { continue; }

            {
                let mut s = state.status.lock().unwrap();
                s.scanned += 1;
                s.current_message = format!("Processing #{}...", id_str);
            }

            let conn = db::open(&db_path).unwrap();

            // 1. FAST LOCAL CHECK
            if check_db_exists(&conn, "furaffinity", &id_str) {
                let mut s = state.status.lock().unwrap();
                s.skipped_url += 1;
                continue; 
            }

            tokio::time::sleep(Duration::from_millis(800)).await; 

            // 2. Fetch Submission Page
            let view_url = format!("https://www.furaffinity.net/view/{}/", id_str);
            let view_resp = match fa_client.get(&view_url).header("Cookie", &cookie_header).send().await {
                Ok(r) => r,
                Err(_) => {
                    state.status.lock().unwrap().errors += 1;
                    continue;
                }
            };
            
            let view_html = view_resp.text().await.unwrap_or_default();
            
            // Extract Data
            let (download_url, fa_tags, artist_name, rating_char) = {
                let view_doc = Html::parse_document(&view_html);
                
                let download_selector = Selector::parse("div.download > a").unwrap();
                let dl = match view_doc.select(&download_selector).next() {
                    Some(el) => Some(format!("https:{}", el.value().attr("href").unwrap_or(""))),
                    None => None,
                };

                let tag_selector = Selector::parse("section.tags-row span.tags a").unwrap();
                let tags: Vec<String> = view_doc.select(&tag_selector)
                    .map(|el| el.text().collect::<String>())
                    .collect();

                let mut artist = "unknown".to_string();
                let selectors = [
                    "div.submission-id-sub-container a strong",
                    "div.submission-id-sub-container a[href*='/user/']",
                    ".submission-sidebar .user-name"
                ];

                for sel in selectors {
                    let s = Selector::parse(sel).unwrap();
                    if let Some(el) = view_doc.select(&s).next() {
                        let text = el.text().collect::<String>().trim().to_string();
                        if !text.is_empty() {
                            artist = text;
                            break;
                        }
                    }
                }

                if artist == "unknown" {
                    if let Some(url) = &dl {
                        if let Some(start_idx) = url.find("/art/") {
                            let rest = &url[start_idx + 5..];
                            if let Some(end_idx) = rest.find('/') {
                                artist = rest[..end_idx].to_string();
                            }
                        }
                    }
                }

                let clean_artist = artist.replace(" ", "_").to_lowercase();

                let rating_selector = Selector::parse("div.rating span").unwrap();
                let rating_text = view_doc.select(&rating_selector)
                    .next()
                    .map(|el| el.text().collect::<String>().trim().to_lowercase())
                    .unwrap_or("general".to_string());

                let rating_char = match rating_text.as_str() {
                    "adult" => "e",
                    "mature" => "q",
                    _ => "s",
                };
                
                (dl, tags, clean_artist, rating_char.to_string())
            };

            let download_url = match download_url {
                Some(url) => url,
                None => {
                    state.status.lock().unwrap().errors += 1;
                    continue;
                }
            };

            // 3. Download FA File
            let fa_bytes = match fa_client.get(&download_url).header("Cookie", &cookie_header).send().await {
                Ok(r) => match r.bytes().await {
                    Ok(b) => b,
                    Err(_) => continue,
                },
                Err(_) => continue,
            };

            let digest = md5::compute(&fa_bytes);
            let hash_str = format!("{:x}", digest);

            // 4. CHECK LOCAL MD5
            if check_local_md5(&conn, &hash_str) {
                let mut s = state.status.lock().unwrap();
                s.skipped_md5 += 1;
                continue; 
            }

            // 5. CHECK E621
            tokio::time::sleep(Duration::from_millis(500)).await;
            
            if let Some(e621_post) = check_e621_md5(&e621_client, &hash_str).await {
                // --- FOUND ON E621 (UPGRADE PATH) ---
                
                // Double check ID to prevent unique constraint crash
                if check_db_exists(&conn, "e621", &e621_post.id.to_string()) {
                    let mut s = state.status.lock().unwrap();
                    s.skipped_md5 += 1; // Mark as skipped
                    continue; 
                }

                if let Some(file_url) = e621_post.file.url {
                    let e621_bytes = match e621_client.get(&file_url).header("User-Agent", "TailBurrow/0.1.0").send().await {
                        Ok(r) => match r.bytes().await {
                            Ok(b) => b,
                            Err(_) => continue,
                        },
                        Err(_) => continue,
                    };

                    let ext = e621_post.file.ext.unwrap_or("jpg".to_string());
                    let filename = format!("e621_{}.{}", e621_post.id, ext);
                    let target_path = media_dir.join(&filename);
                    if let Ok(mut file) = fs::File::create(&target_path) {
                        let _ = file.write_all(&e621_bytes);
                    }

                    let now = chrono::Local::now().to_rfc3339();
                    let file_rel = format!("media/{}", filename);
                    let tx = conn.unchecked_transaction().unwrap();

                    // PROTECTED INSERT
                    let insert_res = tx.execute(
                        "INSERT INTO items (source, source_id, file_rel, file_md5, ext, rating, fav_count, score_total, created_at, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                        params!["e621", e621_post.id.to_string(), file_rel, hash_str, ext, e621_post.rating, e621_post.fav_count, 0, e621_post.created_at, now],
                    );

                    if insert_res.is_err() {
                        println!("Skipping duplicate e621 insert: {}", e621_post.id);
                        continue; // Skip if db constraint fails
                    }

                    let item_id = tx.last_insert_rowid();

                    // Add Tags (Correctly Typed)
                    let insert_tags_with_type = |tags: Vec<String>, t_type: &str, tx: &rusqlite::Transaction| {
                        for tag in tags {
                            let clean = tag.trim().to_lowercase();
                            if clean.is_empty() { continue; }
                            tx.execute("INSERT OR IGNORE INTO tags (name, type) VALUES (?, ?)", params![&clean, t_type]).unwrap();
                            let tag_id: i64 = tx.query_row("SELECT tag_id FROM tags WHERE name = ?", [&clean], |r| r.get(0)).unwrap();
                            tx.execute("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)", [item_id, tag_id]).unwrap();
                        }
                    };

                    insert_tags_with_type(e621_post.tags.artist, "artist", &tx);
                    insert_tags_with_type(e621_post.tags.copyright, "copyright", &tx);
                    insert_tags_with_type(e621_post.tags.character, "character", &tx);
                    insert_tags_with_type(e621_post.tags.species, "species", &tx);
                    insert_tags_with_type(e621_post.tags.general, "general", &tx);
                    insert_tags_with_type(e621_post.tags.meta, "meta", &tx);
                    insert_tags_with_type(e621_post.tags.lore, "lore", &tx);

                    // Add Sources
                    let e621_src = format!("https://e621.net/posts/{}", e621_post.id);
                    tx.execute("INSERT OR IGNORE INTO sources (url) VALUES (?)", [&e621_src]).unwrap();
                    let sid1: i64 = tx.query_row("SELECT source_row_id FROM sources WHERE url = ?", [&e621_src], |r| r.get(0)).unwrap();
                    tx.execute("INSERT INTO item_sources (item_id, source_row_id) VALUES (?, ?)", [item_id, sid1]).unwrap();

                    tx.execute("INSERT OR IGNORE INTO sources (url) VALUES (?)", [&view_url]).unwrap();
                    let sid2: i64 = tx.query_row("SELECT source_row_id FROM sources WHERE url = ?", [&view_url], |r| r.get(0)).unwrap();
                    tx.execute("INSERT INTO item_sources (item_id, source_row_id) VALUES (?, ?)", [item_id, sid2]).unwrap();

                    tx.commit().unwrap();

                    let mut s = state.status.lock().unwrap();
                    s.upgraded += 1;
                    
                    if stop_after > 0 && (s.imported + s.upgraded) >= stop_after {
                        break; 
                    }
                    continue; 
                }
            }

            // --- NOT ON E621 (EXCLUSIVE PATH) ---
            
            let ext = download_url.split('.').last().unwrap_or("jpg");
            let filename = format!("{}_fa_{}.{}", artist_name, id_str, ext);
            let target_path = media_dir.join(&filename);

            if let Ok(mut file) = fs::File::create(&target_path) {
                let _ = file.write_all(&fa_bytes);
            }

            let now = chrono::Local::now().to_rfc3339();
            let tx = conn.unchecked_transaction().unwrap();
            let file_rel = format!("media/{}", filename);

            // PROTECTED INSERT
            let insert_res = tx.execute(
                "INSERT INTO items (source, source_id, file_rel, file_md5, ext, rating, created_at, added_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params!["furaffinity", id_str, file_rel, hash_str, ext, rating_char, now, now],
            );

            if insert_res.is_err() {
                println!("Skipping duplicate FA insert: {}", id_str);
                continue; 
            }

            let item_id = tx.last_insert_rowid();

            tx.execute("INSERT OR IGNORE INTO sources (url) VALUES (?)", [&view_url]).unwrap();
            let source_row_id: i64 = tx.query_row("SELECT source_row_id FROM sources WHERE url = ?", [&view_url], |r| r.get(0)).unwrap();
            tx.execute("INSERT INTO item_sources (item_id, source_row_id) VALUES (?, ?)", [item_id, source_row_id]).unwrap();

            // Artist Tag
            {
                let clean_artist = artist_name.trim().to_lowercase();
                tx.execute("INSERT OR IGNORE INTO tags (name, type) VALUES (?, 'artist')", [&clean_artist]).unwrap();
                let tag_id: i64 = tx.query_row("SELECT tag_id FROM tags WHERE name = ?", [&clean_artist], |r| r.get(0)).unwrap();
                tx.execute("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)", [item_id, tag_id]).unwrap();
            }

            // General Tags
            for tag in fa_tags {
                let clean = tag.trim().to_lowercase();
                if clean.is_empty() { continue; }
                tx.execute("INSERT OR IGNORE INTO tags (name, type) VALUES (?, 'general')", [&clean]).unwrap();
                let tag_id: i64 = tx.query_row("SELECT tag_id FROM tags WHERE name = ?", [&clean], |r| r.get(0)).unwrap();
                tx.execute("INSERT OR IGNORE INTO item_tags (item_id, tag_id) VALUES (?, ?)", [item_id, tag_id]).unwrap();
            }

            tx.commit().unwrap();

            let mut s = state.status.lock().unwrap();
            s.imported += 1;

            if stop_after > 0 && (s.imported + s.upgraded) >= stop_after {
                break; 
            }
        }

        if stop_after > 0 {
            let s = state.status.lock().unwrap();
            if (s.imported + s.upgraded) >= stop_after {
                break; 
            }
        }

        page += 1;
        if page > 50 { break; } 
    }

    let mut s = state.status.lock().unwrap();
    s.running = false;
    s.current_message = "Done.".to_string();
}