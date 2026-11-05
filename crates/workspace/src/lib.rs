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
pub use git::ops::clone;
pub use git::runner::{set_command_hook, set_output_sink};
pub use git::{
    Branches, ChangeKind, ChangedFile, CommitDetail, CommitOptions, DiffSide, FetchOptions, GitOutputEntry, GraphCommit,
    LogOptions, Progress, PullOptions, PushOptions, RemoteEntry, RepoOperation, ScmFile, ScmStatus, StashEntry,
    StashOptions, TagEntry,
};
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

    /// Git status split into staged, unstaged, untracked and conflicted
    /// files, with the branch's standing against its upstream.
    pub fn scm_status(&self) -> Result<ScmStatus> {
        git::status::scm_status(&self.root)
    }

    /// Unified diff of one side of a file's changes.
    pub fn diff_file(&self, rel: &str, side: DiffSide) -> Result<String> {
        self.resolve(rel)?;
        git::diff::diff_file(&self.root, rel, side)
    }

    /// Applies a patch (a hunk cut from [`Self::diff_file`]) to the index or
    /// work tree, optionally reversed.
    pub fn apply_patch(&self, patch: &str, cached: bool, reverse: bool) -> Result<()> {
        git::diff::apply_patch(&self.root, patch, cached, reverse)
    }

    pub fn stage(&self, paths: &[String]) -> Result<()> {
        self.check_paths(paths)?;
        git::ops::stage(&self.root, paths)
    }

    pub fn stage_all(&self) -> Result<()> {
        git::ops::stage_all(&self.root)
    }

    pub fn unstage(&self, paths: &[String]) -> Result<()> {
        self.check_paths(paths)?;
        git::ops::unstage(&self.root, paths)
    }

    pub fn unstage_all(&self) -> Result<()> {
        git::ops::unstage_all(&self.root)
    }

    /// Reverts work-tree changes; untracked files go to the Trash.
    pub fn discard(&self, paths: &[String]) -> Result<()> {
        self.check_paths(paths)?;
        git::ops::discard(&self.root, paths)
    }

    pub fn discard_all(&self) -> Result<()> {
        git::ops::discard_all(&self.root)
    }

    /// Adds `rel` to the workspace's `.gitignore`.
    pub fn ignore(&self, rel: &str) -> Result<()> {
        self.resolve(rel)?;
        git::ops::ignore(&self.root, rel)
    }

    /// Commits; returns the new commit's short hash.
    pub fn commit(&self, options: &CommitOptions) -> Result<String> {
        if let Some(paths) = &options.paths {
            self.check_paths(paths)?;
        }
        git::ops::commit(&self.root, options)
    }

    pub fn last_commit_message(&self) -> Result<String> {
        git::ops::last_commit_message(&self.root)
    }

    /// Undoes the last commit, keeping its changes staged; returns its message.
    pub fn undo_last_commit(&self) -> Result<String> {
        git::ops::undo_last_commit(&self.root)
    }

    pub fn fetch(&self, options: &FetchOptions, progress: Progress) -> Result<()> {
        git::ops::fetch(&self.root, options, progress)
    }

    pub fn pull(&self, options: &PullOptions, progress: Progress) -> Result<()> {
        git::ops::pull(&self.root, options, progress)
    }

    /// Pushes the current branch, publishing it if it has no upstream.
    pub fn push(&self, options: &PushOptions, progress: Progress) -> Result<()> {
        git::ops::push(&self.root, options, progress)
    }

    /// Pulls if behind, then pushes.
    pub fn sync(&self, rebase: bool, progress: Progress) -> Result<()> {
        git::ops::sync(&self.root, rebase, progress)
    }

    /// Creates a branch from `from` (default: HEAD) and switches to it.
    pub fn create_branch(&self, name: &str, from: Option<&str>) -> Result<()> {
        git::ops::create_branch(&self.root, name, from)
    }

    pub fn rename_branch(&self, old: &str, new: &str) -> Result<()> {
        git::ops::rename_branch(&self.root, old, new)
    }

    pub fn delete_branch(&self, name: &str, force: bool) -> Result<()> {
        git::ops::delete_branch(&self.root, name, force)
    }

    pub fn delete_remote_branch(&self, remote_branch: &str) -> Result<()> {
        git::ops::delete_remote_branch(&self.root, remote_branch)
    }

    pub fn merge(&self, name: &str) -> Result<()> {
        git::ops::merge(&self.root, name)
    }

    pub fn rebase(&self, onto: &str) -> Result<()> {
        git::ops::rebase(&self.root, onto)
    }

    pub fn checkout_commit(&self, sha: &str) -> Result<()> {
        git::ops::checkout_commit(&self.root, sha)
    }

    pub fn cherry_pick(&self, sha: &str) -> Result<()> {
        git::ops::cherry_pick(&self.root, sha)
    }

    pub fn revert(&self, sha: &str) -> Result<()> {
        git::ops::revert(&self.root, sha)
    }

    /// Aborts the merge, rebase, cherry-pick or revert in progress.
    pub fn abort_operation(&self) -> Result<()> {
        git::ops::abort_operation(&self.root)
    }

    /// Continues the operation in progress once conflicts are resolved.
    pub fn continue_operation(&self) -> Result<()> {
        git::ops::continue_operation(&self.root)
    }

    pub fn stashes(&self) -> Result<Vec<StashEntry>> {
        git::ops::stashes(&self.root)
    }

    pub fn stash(&self, options: &StashOptions) -> Result<()> {
        git::ops::stash(&self.root, options)
    }

    /// Applies a stash, dropping it too when `pop`.
    pub fn stash_apply(&self, index: u32, pop: bool) -> Result<()> {
        git::ops::stash_apply(&self.root, index, pop)
    }

    pub fn stash_drop(&self, index: u32) -> Result<()> {
        git::ops::stash_drop(&self.root, index)
    }

    pub fn stash_clear(&self) -> Result<()> {
        git::ops::stash_clear(&self.root)
    }

    pub fn stash_show(&self, index: u32) -> Result<String> {
        git::ops::stash_show(&self.root, index)
    }

    pub fn tags(&self) -> Result<Vec<TagEntry>> {
        git::ops::tags(&self.root)
    }

    pub fn create_tag(&self, name: &str, message: Option<&str>, target: Option<&str>) -> Result<()> {
        git::ops::create_tag(&self.root, name, message, target)
    }

    pub fn delete_tag(&self, name: &str) -> Result<()> {
        git::ops::delete_tag(&self.root, name)
    }

    pub fn push_tags(&self, remote: Option<&str>, progress: Progress) -> Result<()> {
        git::ops::push_tags(&self.root, remote, progress)
    }

    pub fn delete_remote_tag(&self, remote: &str, name: &str) -> Result<()> {
        git::ops::delete_remote_tag(&self.root, remote, name)
    }

    pub fn remotes(&self) -> Result<Vec<RemoteEntry>> {
        git::ops::remotes(&self.root)
    }

    pub fn add_remote(&self, name: &str, url: &str) -> Result<()> {
        git::ops::add_remote(&self.root, name, url)
    }

    pub fn remove_remote(&self, name: &str) -> Result<()> {
        git::ops::remove_remote(&self.root, name)
    }

    pub fn rename_remote(&self, old: &str, new: &str) -> Result<()> {
        git::ops::rename_remote(&self.root, old, new)
    }

    /// Recent authors as `Name <email>`, for co-author trailers.
    pub fn authors(&self) -> Result<Vec<String>> {
        git::ops::authors(&self.root)
    }

    /// Commits for the graph, newest first.
    pub fn log(&self, options: &LogOptions) -> Result<Vec<GraphCommit>> {
        git::log::log(&self.root, options)
    }

    pub fn show_commit(&self, sha: &str) -> Result<CommitDetail> {
        git::log::show(&self.root, sha)
    }

    /// Runs any git command in the workspace, recorded in the Git Output log;
    /// its trimmed stdout. For callers outside this crate with one-off needs.
    pub fn git(&self, args: &[&str], input: Option<&str>) -> Result<String> {
        match input {
            Some(input) => git::runner::git_input(&self.root, args, input),
            None => git::runner::git(&self.root, args),
        }
    }

    fn check_paths(&self, paths: &[String]) -> Result<()> {
        paths.iter().try_for_each(|p| self.resolve(p).map(drop))
    }

    /// The absolute path of `rel`, refusing anything outside the workspace.
    pub fn absolute(&self, rel: &str) -> Result<PathBuf> {
        self.resolve(rel)
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
