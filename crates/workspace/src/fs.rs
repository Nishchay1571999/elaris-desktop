use std::io::Read;
use std::path::Path;

use ignore::WalkBuilder;
use serde::Serialize;
use ts_rs::TS;

use crate::{Result, relative};

/// Files larger than this are previewed only up to this many bytes.
const PREVIEW_LIMIT: u64 = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FileEntry {
    pub name: String,
    /// Relative to the workspace root, `/`-separated.
    pub path: String,
    pub is_dir: bool,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FilePreview {
    /// `None` when the file looks binary.
    pub text: Option<String>,
    #[ts(type = "number")]
    pub size: u64,
    pub truncated: bool,
}

pub(crate) fn list_dir(root: &Path, dir: &Path) -> Result<Vec<FileEntry>> {
    if !dir.is_dir() {
        return Err(crate::Error::NotADirectory(dir.display().to_string()));
    }
    let walker = WalkBuilder::new(dir)
        .max_depth(Some(1))
        .hidden(false)
        // Honour .gitignore even in folders that aren't repositories yet.
        .require_git(false)
        .filter_entry(|entry| entry.file_name() != ".git")
        .build();

    let mut entries = Vec::new();
    for result in walker {
        let entry = result?;
        if entry.depth() == 0 {
            continue;
        }
        let Some(path) = relative(root, entry.path()) else { continue };
        entries.push(FileEntry {
            name: entry.file_name().to_string_lossy().into_owned(),
            path,
            is_dir: entry.file_type().is_some_and(|t| t.is_dir()),
        });
    }
    entries.sort_by(|a, b| {
        b.is_dir
            .cmp(&a.is_dir)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(entries)
}

pub(crate) fn read_file(path: &Path) -> Result<FilePreview> {
    let size = std::fs::metadata(path)?.len();
    let mut bytes = Vec::with_capacity(size.min(PREVIEW_LIMIT) as usize);
    std::fs::File::open(path)?.take(PREVIEW_LIMIT).read_to_end(&mut bytes)?;

    let text = if bytes.contains(&0) {
        None
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    };
    Ok(FilePreview { text, size, truncated: size > PREVIEW_LIMIT })
}
