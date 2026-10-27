//! Claude's JSON config files (`~/.claude.json`, `~/.claude/settings.json`)
//! also hold Claude Code's own state, so they are changed in place: every
//! other key is kept, in order, and the write is atomic.

use std::path::Path;

use serde_json::{Map, Value};

use crate::{Error, Result};

/// The file's top-level object; a missing file is an empty one.
pub(crate) fn read(path: &Path) -> Result<Map<String, Value>> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Map::new()),
        Err(e) => return Err(e.into()),
    };
    match serde_json::from_str(&text) {
        Ok(Value::Object(root)) => Ok(root),
        Ok(_) => Err(Error::Invalid(format!("{} isn't a JSON object", path.display()))),
        Err(source) => Err(Error::Config { path: path.display().to_string(), source }),
    }
}

/// Writes beside the file and renames over it, keeping its permissions (it
/// may hold tokens, so it is usually private to the user). Creates the
/// folder if it is missing.
pub(crate) fn write(path: &Path, root: &Map<String, Value>) -> Result<()> {
    let mut text = serde_json::to_string_pretty(root).map_err(|e| Error::Invalid(e.to_string()))?;
    text.push('\n');
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = path.with_extension(format!("json.elaris-{}", std::process::id()));
    std::fs::write(&temp, text)?;
    if let Ok(meta) = std::fs::metadata(path) {
        std::fs::set_permissions(&temp, meta.permissions())?;
    }
    std::fs::rename(&temp, path).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    Ok(())
}
