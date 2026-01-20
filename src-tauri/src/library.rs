use std::{fs, path::{Path, PathBuf}};

pub fn ensure_layout(root: &Path) -> Result<(), String> {
  fs::create_dir_all(root.join("db")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join("media")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join("cache").join("thumbs")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join("cache").join("previews")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join(".trash").join("media")).map_err(|e| e.to_string())?;
  fs::create_dir_all(root.join(".trash").join("cache")).map_err(|e| e.to_string())?;
  Ok(())
}

pub fn db_path(root: &Path) -> PathBuf {
  root.join("db").join("library.sqlite")
}