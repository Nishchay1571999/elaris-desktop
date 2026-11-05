//! Everything the desktop app knows about an open folder: its file tree
//! (honouring ignore files), git status and diffs, and change notifications.
//!
//! Paths crossing this API are relative to the workspace root and always use
//! `/` separators, so they can be shown and sent back as-is.

mod fs;
mod git;
mod logo;
mod watch;

use std::path::{Path, PathBuf};

use serde::Serialize;
use ts_rs::TS;

pub use fs::{FileEntry, FilePreview};
pub use git::{Branches, ChangeKind, ChangedFile};
pub use logo::{MAX_LOGO_BYTES, find_logo, image_mime};
pub use watch::Watcher;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0} is not a folder")]
    NotADirectory(String),
    #[error("{0} is outside the workspace")]
    OutsideWorkspace(String),
    #[error("{0} is not inside a git repository")]
    NotARepository(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Git(#[from] git2::Error),
    /// A git CLI command failed; holds what it printed.
    #[error("{0}")]
    GitCommand(String),
    #[error(transparent)]
    Walk(#[from] ignore::Error),
    #[error(transparent)]
    Watch(#[from] notify_debouncer_full::notify::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct WorkspaceInfo {
    /// Folder name, shown in the title bar.
    pub name: String,
    /// Absolute, canonical path.
    pub root: String,
    pub is_git: bool,
    /// Current branch, or `None` for a detached HEAD or a non-git folder.
    pub branch: Option<String>,
    /// The branch pull requests target, when one can be found.
    pub default_branch: Option<String>,
}

/// An opened folder. Cheap to clone; holds no handles.
#[derive(Debug, Clone)]
pub struct Workspace {
    root: PathBuf,
}

impl Workspace {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref();
        let root = path.canonicalize()?;
        if !root.is_dir() {
            return Err(Error::NotADirectory(path.display().to_string()));
        }
        Ok(Self { root })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn info(&self) -> WorkspaceInfo {
        let (is_git, branch) = git::head_info(&self.root);
        WorkspaceInfo {
            name: self
                .root
                .file_name()
                .map(|n| n.to_string_lossy().into_owned())
                .unwrap_or_else(|| self.root.display().to_string()),
            root: self.root.display().to_string(),
            is_git,
            branch,
            default_branch: if is_git { git::default_branch(&self.root) } else { None },
        }
    }

    pub fn branches(&self) -> Result<Branches> {
        git::branches(&self.root)
    }

    /// Checks out a local branch, or a remote one (`origin/name`) as a local
    /// tracking branch. Uncommitted changes are carried over to it.
    pub fn switch_branch(&self, name: &str) -> Result<()> {
        git::switch(&self.root, name)
    }

    /// Immediate children of `rel` (`""` for the root): folders first, then
    /// files, each sorted case-insensitively. Ignored files are left out.
    pub fn list_dir(&self, rel: &str) -> Result<Vec<FileEntry>> {
        fs::list_dir(&self.root, &self.resolve(rel)?)
    }

    /// Text contents of a file, truncated for very large files.
    pub fn read_file(&self, rel: &str) -> Result<FilePreview> {
        fs::read_file(&self.resolve(rel)?)
    }

    pub fn status(&self) -> Result<Vec<ChangedFile>> {
        git::status(&self.root)
    }

    /// Unified diff of one file against HEAD (staged and unstaged together).
    pub fn diff(&self, rel: &str) -> Result<String> {
        self.resolve(rel)?;
        git::diff(&self.root, rel)
    }

    /// Joins `rel` onto the root, refusing anything that escapes it.
    fn resolve(&self, rel: &str) -> Result<PathBuf> {
        let joined = self.root.join(rel);
        // Deleted files can't be canonicalised; fall back to a lexical check.
        let resolved = joined.canonicalize().unwrap_or_else(|_| joined.clone());
        let escapes = Path::new(rel)
            .components()
            .any(|c| matches!(c, std::path::Component::ParentDir | std::path::Component::RootDir));
        if escapes || !resolved.starts_with(&self.root) {
            return Err(Error::OutsideWorkspace(rel.to_owned()));
        }
        Ok(resolved)
    }
}

/// `path` relative to `root`, with `/` separators.
pub(crate) fn relative(root: &Path, path: &Path) -> Option<String> {
    let rel = path.strip_prefix(root).ok()?;
    let parts: Vec<_> = rel.components().map(|c| c.as_os_str().to_string_lossy()).collect();
    Some(parts.join("/"))
}
