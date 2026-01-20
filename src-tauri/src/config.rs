use serde::{Deserialize, Serialize};
use std::{fs, path::PathBuf};
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AppConfig {
  pub library_root: Option<String>,
}

fn config_path(app: &AppHandle) -> Result<PathBuf, String> {
  let dir = app
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?;
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir.join("config.json"))
}

pub fn load_config(app: &AppHandle) -> Result<AppConfig, String> {
  let path = config_path(app)?;
  if !path.exists() {
    return Ok(AppConfig::default());
  }
  let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
  serde_json::from_str(&text).map_err(|e| e.to_string())
}

pub fn save_config(app: &AppHandle, cfg: &AppConfig) -> Result<(), String> {
  let path = config_path(app)?;
  let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
  fs::write(path, text).map_err(|e| e.to_string())
}