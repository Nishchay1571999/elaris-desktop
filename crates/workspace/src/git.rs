use std::path::{Path, PathBuf};

use git2::{DiffFormat, DiffOptions, ErrorCode, Repository, Status, StatusOptions};
use serde::Serialize;
use ts_rs::TS;

use crate::{Error, Result, relative};

/// Diffs beyond this size are cut off; the view says so.
const DIFF_LIMIT: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ChangeKind {
    Added,
    Modified,
    Deleted,
    Renamed,
    Untracked,
    Conflicted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ChangedFile {
    /// Relative to the workspace root, `/`-separated.
    pub path: String,
    pub kind: ChangeKind,
}

/// Whether `root` is inside a repository, and its current branch.
pub(crate) fn head_info(root: &Path) -> (bool, Option<String>) {
    let Ok(repo) = Repository::discover(root) else { return (false, None) };
    let branch = match repo.head() {
        Ok(head) if head.is_branch() => head.shorthand().map(str::to_owned),
        Ok(_) => None,
        // A fresh repo has no commits; HEAD still names the branch.
        Err(e) if e.code() == ErrorCode::UnbornBranch => repo
            .find_reference("HEAD")
            .ok()
            .and_then(|r| r.symbolic_target().map(str::to_owned))
            .map(|t| t.trim_start_matches("refs/heads/").to_owned()),
        Err(_) => None,
    };
    (true, branch)
}

/// The repository containing `root`, and `root`'s path inside its work tree.
fn open(root: &Path) -> Result<(Repository, PathBuf)> {
    let repo = Repository::discover(root)
        .map_err(|_| Error::NotARepository(root.display().to_string()))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| Error::NotARepository(root.display().to_string()))?
        .canonicalize()?;
    let prefix = root.strip_prefix(&workdir).unwrap_or(Path::new("")).to_path_buf();
    Ok((repo, prefix))
}

pub(crate) fn status(root: &Path) -> Result<Vec<ChangedFile>> {
    let (repo, prefix) = open(root)?;
    let mut options = StatusOptions::new();
    options
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .renames_head_to_index(true)
        .renames_index_to_workdir(true);

    let mut changes = Vec::new();
    for entry in repo.statuses(Some(&mut options))?.iter() {
        let Some(path) = entry.path() else { continue };
        let Some(path) = relative(&prefix, Path::new(path)) else { continue };
        if let Some(kind) = classify(entry.status()) {
            changes.push(ChangedFile { path, kind });
        }
    }
    changes.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(changes)
}

fn classify(status: Status) -> Option<ChangeKind> {
    Some(if status.is_conflicted() {
        ChangeKind::Conflicted
    } else if status.intersects(Status::INDEX_RENAMED | Status::WT_RENAMED) {
        ChangeKind::Renamed
    } else if status.intersects(Status::INDEX_DELETED | Status::WT_DELETED) {
        ChangeKind::Deleted
    } else if status.contains(Status::INDEX_NEW) {
        ChangeKind::Added
    } else if status.contains(Status::WT_NEW) {
        ChangeKind::Untracked
    } else if status.intersects(Status::INDEX_MODIFIED | Status::WT_MODIFIED | Status::INDEX_TYPECHANGE | Status::WT_TYPECHANGE) {
        ChangeKind::Modified
    } else {
        return None;
    })
}

pub(crate) fn diff(root: &Path, rel: &str) -> Result<String> {
    let (repo, prefix) = open(root)?;
    let repo_path = prefix.join(rel);
    let pathspec = repo_path.to_string_lossy().replace('\\', "/");

    let mut options = DiffOptions::new();
    options
        .pathspec(&pathspec)
        .disable_pathspec_match(true)
        .include_untracked(true)
        .recurse_untracked_dirs(true)
        .show_untracked_content(true);

    let head_tree = match repo.head() {
        Ok(head) => Some(head.peel_to_tree()?),
        Err(e) if e.code() == ErrorCode::UnbornBranch => None,
        Err(e) => return Err(e.into()),
    };
    let diff = repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut options))?;

    let mut out = String::new();
    diff.print(DiffFormat::Patch, |_, _, line| {
        if out.len() >= DIFF_LIMIT {
            return false;
        }
        let content = String::from_utf8_lossy(line.content());
        match line.origin() {
            origin @ ('+' | '-' | ' ') => {
                out.push(origin);
                out.push_str(&content);
            }
            _ => out.push_str(&content),
        }
        true
    })
    .or_else(|e| if e.code() == ErrorCode::User { Ok(()) } else { Err(e) })?;
    Ok(out)
}
