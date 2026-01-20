mod commands;
mod config;
mod db;
mod library;

use tauri::Manager; // ✅ required for fs_scope & asset_protocol_scope
use tauri_plugin_fs::FsExt;

pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
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
      commands::get_config,
      commands::set_library_root,
      commands::list_items,
      commands::import_json,
      commands::trash_item,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
