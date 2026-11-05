//! Git for the workspace: libgit2 for quick reads, the git CLI (through
//! [`runner`]) for everything that changes the repository.

pub(crate) mod diff;
pub(crate) mod log;
pub(crate) mod ops;
pub mod runner;
pub(crate) mod status;

use std::path::{Path, PathBuf};

use git2::{BranchType, DiffFormat, DiffOptions, ErrorCode, Repository};
use serde::Serialize;
use ts_rs::TS;

use crate::{Error, Result};

pub use diff::DiffSide;
pub use log::{CommitDetail, GraphCommit, LogOptions};
pub use ops::{CommitOptions, FetchOptions, Progress, PullOptions, PushOptions, RemoteEntry, StashEntry, StashOptions, TagEntry};
pub use runner::GitOutputEntry;
pub use status::{RepoOperation, ScmFile, ScmStatus};

/// Diffs beyond this size are cut off; the view says so.
pub(crate) const DIFF_LIMIT: usize = 512 * 1024;

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

/// The branch pull requests merge into: whatever `origin/HEAD` names, else
/// `main` or `master` if one exists locally.
pub(crate) fn default_branch(root: &Path) -> Option<String> {
    let repo = Repository::discover(root).ok()?;
    if let Some(target) = repo
        .find_reference("refs/remotes/origin/HEAD")
        .ok()
        .and_then(|r| r.symbolic_target().map(str::to_owned))
    {
        return Some(target.trim_start_matches("refs/remotes/origin/").to_owned());
    }
    ["main", "master"]
        .into_iter()
        .find(|name| repo.find_branch(name, BranchType::Local).is_ok())
        .map(str::to_owned)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Branches {
    /// Local branch names, sorted.
    pub local: Vec<String>,
    /// Remote branches with no local branch of the same name, as `origin/name`.
    pub remote: Vec<String>,
    /// Every remote branch, as `origin/name`, sorted.
    pub all_remote: Vec<String>,
}

pub(crate) fn branches(root: &Path) -> Result<Branches> {
    let (repo, _) = open(root)?;
    let mut local = Vec::new();
    let mut remote = Vec::new();
    for branch in repo.branches(None)? {
        let (branch, kind) = branch?;
        let Some(name) = branch.name()?.map(str::to_owned) else { continue };
        match kind {
            BranchType::Local => local.push(name),
            // `origin/HEAD` is a pointer, not a branch.
            BranchType::Remote if !name.ends_with("/HEAD") => remote.push(name),
            BranchType::Remote => {}
        }
    }
    remote.sort();
    let all_remote = remote.clone();
    remote.retain(|name| {
        let short = name.split_once('/').map_or(name.as_str(), |(_, s)| s);
        !local.iter().any(|l| l == short)
    });
    local.sort();
    remote.sort();
    Ok(Branches { local, remote, all_remote })
}

/// Checks out `name`. A remote branch (`origin/feature`) gets a local
/// tracking branch, or switches to the local one if it already exists.
/// Uncommitted changes come along: when they would block the switch, they're
/// stashed, the branch is checked out, and the stash is popped onto it.
pub(crate) fn switch(root: &Path, name: &str) -> Result<()> {
    let (repo, _) = open(root)?;
    if name.starts_with('-') || !git2::Branch::name_is_valid(name)? {
        return Err(Error::GitCommand(format!("{name} is not a valid branch name")));
    }
    let args: Vec<&str> = if repo.find_branch(name, BranchType::Local).is_ok() {
        vec!["switch", name]
    } else if repo.find_branch(name, BranchType::Remote).is_ok() {
        let short = name.split_once('/').map_or(name, |(_, s)| s);
        if repo.find_branch(short, BranchType::Local).is_ok() {
            vec!["switch", short]
        } else {
            vec!["switch", "--track", name]
        }
    } else {
        return Err(Error::GitCommand(format!("No branch named {name}")));
    };
    match run_git(root, &args) {
        Err(Error::GitCommand(message)) if message.contains("would be overwritten") => {
            carry_changes(root, &args, name)
        }
        other => other,
    }
}

/// Stashes everything (untracked files too), runs the switch, and pops the
/// stash onto the new branch. If the switch still fails the changes are put
/// back where they were; if they clash with the new branch, git leaves the
/// conflicts in the files and keeps the stash.
fn carry_changes(root: &Path, switch_args: &[&str], name: &str) -> Result<()> {
    let message = format!("Elaris: uncommitted changes carried to {name}");
    run_git(root, &["stash", "push", "--include-untracked", "--message", &message])?;
    if let Err(error) = run_git(root, switch_args) {
        run_git(root, &["stash", "pop"])?;
        return Err(error);
    }
    run_git(root, &["stash", "pop"]).map_err(|_| {
        Error::GitCommand(format!(
            "Switched to {name}, but some uncommitted changes clash with it. \
             Resolve the conflicts marked in the files; a copy of the changes is kept in git stash."
        ))
    })
}

fn run_git(root: &Path, args: &[&str]) -> Result<()> {
    runner::git(root, args).map(drop)
}

/// The top of the work tree containing `root`.
pub(crate) fn toplevel(root: &Path) -> Result<PathBuf> {
    let (repo, _) = open(root)?;
    Ok(repo.workdir().ok_or_else(|| Error::NotARepository(root.display().to_string()))?.to_path_buf())
}

/// The repository containing `root`, and `root`'s path inside its work tree.
pub(crate) fn open(root: &Path) -> Result<(Repository, PathBuf)> {
    let repo = Repository::discover(root)
        .map_err(|_| Error::NotARepository(root.display().to_string()))?;
    let workdir = repo
        .workdir()
        .ok_or_else(|| Error::NotARepository(root.display().to_string()))?
        .canonicalize()?;
    let prefix = root.strip_prefix(&workdir).unwrap_or(Path::new("")).to_path_buf();
    Ok((repo, prefix))
}

/// One entry per changed file, staged and unstaged together.
pub(crate) fn status(root: &Path) -> Result<Vec<ChangedFile>> {
    Ok(status::flatten(&status::scm_status(root)?))
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
