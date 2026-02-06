mod commands;
mod config;
mod db;
mod library;
pub mod fa; 

use tauri::Manager; // ✅ required for fs_scope & asset_protocol_scope
use tauri_plugin_fs::FsExt;
use std::sync::{Arc, Mutex};

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_fs::init())
    .manage(Arc::new(Mutex::new(commands::SyncState::default())))
    .manage(crate::fa::FAState::new())
    .setup(|app| {
      let handle = app.handle().clone();

      if let Ok(cfg) = crate::config::load_config(&handle) {
        if let Some(root) = cfg.library_root {
          let root = std::path::PathBuf::from(root);

          // Re-apply scopes on startup
          let _ = handle.fs_scope().allow_directory(&root, true);
          let _ = handle.asset_protocol_scope().allow_directory(&root, true);
        }
      }

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      commands::add_e621_post,
      commands::get_config,
      commands::set_library_root,
      commands::list_items,
      commands::trash_item,
      commands::get_library_stats,
      commands::clear_library_root,
      commands::update_item_tags,
      commands::fa_set_credentials,
      commands::fa_start_sync,
      commands::fa_sync_status,
      commands::fa_cancel_sync,
      commands::get_trashed_items,
      commands::restore_item,
      commands::empty_trash,
      commands::auto_clean_trash,
      commands::e621_clear_credentials,
      commands::e621_get_cred_info,
      commands::e621_set_credentials,
      commands::e621_test_connection,
      commands::e621_fetch_posts,
      commands::e621_favorite,
      commands::e621_sync_start,
      commands::e621_sync_status,
      commands::e621_sync_cancel,
      commands::e621_unavailable_list,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
