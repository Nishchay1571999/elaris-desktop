//! `git status`, split the way the Source Control panel shows it: staged,
//! unstaged, untracked and conflicted files, plus where the branch stands
//! against its upstream.

use std::path::Path;

use git2::{Repository, RepositoryState};
use serde::Serialize;
use ts_rs::TS;

use super::runner;
use super::{ChangeKind, ChangedFile, open};
use crate::{Result, relative};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScmFile {
    /// Relative to the workspace root, `/`-separated.
    pub path: String,
    /// Where a renamed or copied file came from.
    pub orig_path: Option<String>,
    pub kind: ChangeKind,
}

/// A merge, rebase, cherry-pick or revert that stopped part-way.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum RepoOperation {
    Merge,
    Rebase,
    CherryPick,
    Revert,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ScmStatus {
    /// Current branch; `None` when HEAD is detached.
    pub branch: Option<String>,
    /// Short hash HEAD points at when detached.
    pub detached: Option<String>,
    /// The branch has no commits yet.
    pub unborn: bool,
    /// Tracked remote branch, e.g. `origin/main`.
    pub upstream: Option<String>,
    /// Commits to push.
    pub ahead: u32,
    /// Commits to pull.
    pub behind: u32,
    pub staged: Vec<ScmFile>,
    pub unstaged: Vec<ScmFile>,
    pub untracked: Vec<ScmFile>,
    pub conflicted: Vec<ScmFile>,
    pub operation: Option<RepoOperation>,
}

pub(crate) fn scm_status(root: &Path) -> Result<ScmStatus> {
    let (repo, prefix) = open(root)?;
    // `-- .` keeps a workspace that is a subfolder to its own files.
    let out = runner::run(
        root,
        &["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all", "--", "."],
        runner::Opts { read_only: true, ..runner::Opts::default() },
    )?;
    let mut status = parse(&out, &prefix);
    status.operation = operation(&repo);
    Ok(status)
}

/// Parses `git status --porcelain=v2 --branch -z`. Paths in it are relative to
/// the repository root; `prefix` is the workspace's place inside it.
fn parse(out: &str, prefix: &Path) -> ScmStatus {
    let mut status = ScmStatus::default();
    let rel = |path: &str| relative(prefix, Path::new(path));
    let mut entries = out.split('\0');
    while let Some(entry) = entries.next() {
        let mut head = entry.splitn(2, ' ');
        match (head.next(), head.next()) {
            (Some("#"), Some(header)) => header_line(&mut status, header),
            (Some("1"), Some(rest)) => {
                // XY sub mH mI mW hH hI path
                let fields: Vec<_> = rest.splitn(8, ' ').collect();
                let [xy, .., path] = fields[..] else { continue };
                let Some(path) = rel(path) else { continue };
                push_change(&mut status, xy, path, None);
            }
            (Some("2"), Some(rest)) => {
                // XY sub mH mI mW hH hI Xscore path, then the original path.
                let fields: Vec<_> = rest.splitn(9, ' ').collect();
                let orig = entries.next().and_then(rel);
                let [xy, .., path] = fields[..] else { continue };
                let Some(path) = rel(path) else { continue };
                push_change(&mut status, xy, path, orig);
            }
            (Some("u"), Some(rest)) => {
                // XY sub m1 m2 m3 mW h1 h2 h3 path
                let Some(path) = rest.splitn(10, ' ').nth(9).and_then(rel) else { continue };
                status.conflicted.push(ScmFile { path, orig_path: None, kind: ChangeKind::Conflicted });
            }
            (Some("?"), Some(path)) => {
                let Some(path) = rel(path) else { continue };
                status.untracked.push(ScmFile { path, orig_path: None, kind: ChangeKind::Untracked });
            }
            _ => {}
        }
    }
    for list in [&mut status.staged, &mut status.unstaged, &mut status.untracked, &mut status.conflicted] {
        list.sort_by(|a, b| a.path.cmp(&b.path));
    }
    status
}

fn header_line(status: &mut ScmStatus, header: &str) {
    let (key, value) = header.split_once(' ').unwrap_or((header, ""));
    match key {
        "branch.oid" => {
            status.unborn = value == "(initial)";
            if !status.unborn {
                status.detached = Some(value.chars().take(7).collect());
            }
        }
        "branch.head" if value != "(detached)" => status.branch = Some(value.to_owned()),
        "branch.upstream" => status.upstream = Some(value.to_owned()),
        "branch.ab" => {
            for part in value.split(' ') {
                if let Some(n) = part.strip_prefix('+') {
                    status.ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix('-') {
                    status.behind = n.parse().unwrap_or(0);
                }
            }
        }
        _ => {}
    }
    // `branch.oid` comes first; it only counts as detached without a branch.
    if status.branch.is_some() {
        status.detached = None;
    }
}

fn push_change(status: &mut ScmStatus, xy: &str, path: String, orig_path: Option<String>) {
    let mut codes = xy.chars();
    let (x, y) = (codes.next().unwrap_or('.'), codes.next().unwrap_or('.'));
    if let Some(kind) = kind_of(x) {
        status.staged.push(ScmFile { path: path.clone(), orig_path: orig_path.clone(), kind });
    }
    if let Some(kind) = kind_of(y) {
        // A rename only shows on the side that has it.
        let orig_path = if kind == ChangeKind::Renamed { orig_path } else { None };
        status.unstaged.push(ScmFile { path, orig_path, kind });
    }
}

fn kind_of(code: char) -> Option<ChangeKind> {
    Some(match code {
        'M' | 'T' => ChangeKind::Modified,
        'A' | 'C' => ChangeKind::Added,
        'D' => ChangeKind::Deleted,
        'R' => ChangeKind::Renamed,
        'U' => ChangeKind::Conflicted,
        _ => return None,
    })
}

pub(super) fn operation(repo: &Repository) -> Option<RepoOperation> {
    match repo.state() {
        RepositoryState::Merge => Some(RepoOperation::Merge),
        RepositoryState::Rebase | RepositoryState::RebaseInteractive | RepositoryState::RebaseMerge => {
            Some(RepoOperation::Rebase)
        }
        RepositoryState::CherryPick | RepositoryState::CherryPickSequence => Some(RepoOperation::CherryPick),
        RepositoryState::Revert | RepositoryState::RevertSequence => Some(RepoOperation::Revert),
        _ => None,
    }
}

/// One entry per changed file, staged and unstaged together: for views that
/// only need to know a file changed and roughly how.
pub(crate) fn flatten(status: &ScmStatus) -> Vec<ChangedFile> {
    // When a file is in several groups, the most telling kind wins.
    fn rank(kind: ChangeKind) -> u8 {
        match kind {
            ChangeKind::Conflicted => 0,
            ChangeKind::Renamed => 1,
            ChangeKind::Deleted => 2,
            ChangeKind::Added => 3,
            ChangeKind::Untracked => 4,
            ChangeKind::Modified => 5,
        }
    }
    let mut files: Vec<ChangedFile> = Vec::new();
    for file in status.conflicted.iter().chain(&status.staged).chain(&status.unstaged).chain(&status.untracked) {
        match files.iter_mut().find(|f| f.path == file.path) {
            Some(existing) if rank(file.kind) < rank(existing.kind) => existing.kind = file.kind,
            Some(_) => {}
            None => files.push(ChangedFile { path: file.path.clone(), kind: file.kind }),
        }
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_branch_groups_and_renames() {
        let out = [
            "# branch.oid 0123456789abcdef",
            "# branch.head main",
            "# branch.upstream origin/main",
            "# branch.ab +2 -1",
            "1 M. N... 100644 100644 100644 aaa bbb staged file.txt",
            "1 .M N... 100644 100644 100644 aaa aaa sub/edited.txt",
            "1 MD N... 100644 100644 000000 aaa bbb both.txt",
            "2 R. N... 100644 100644 100644 aaa aaa R100 new name.txt",
            "old name.txt",
            "u UU N... 100644 100644 100644 100644 a b c clash.txt",
            "? fresh.txt",
            "",
        ]
        .join("\0");
        let status = parse(&out, Path::new(""));
        assert_eq!(status.branch.as_deref(), Some("main"));
        assert_eq!(status.detached, None);
        assert_eq!(status.upstream.as_deref(), Some("origin/main"));
        assert_eq!((status.ahead, status.behind), (2, 1));
        let paths = |files: &[ScmFile]| files.iter().map(|f| f.path.clone()).collect::<Vec<_>>();
        assert_eq!(paths(&status.staged), ["both.txt", "new name.txt", "staged file.txt"]);
        assert_eq!(paths(&status.unstaged), ["both.txt", "sub/edited.txt"]);
        assert_eq!(status.unstaged[0].kind, ChangeKind::Deleted);
        assert_eq!(status.staged[1].orig_path.as_deref(), Some("old name.txt"));
        assert_eq!(status.staged[1].kind, ChangeKind::Renamed);
        assert_eq!(paths(&status.conflicted), ["clash.txt"]);
        assert_eq!(paths(&status.untracked), ["fresh.txt"]);
    }

    #[test]
    fn strips_the_workspace_prefix_and_reads_detached_and_unborn() {
        let out = "# branch.oid 0123456789abcdef\0# branch.head (detached)\0? app/src/a.ts\0? other/b.ts\0";
        let status = parse(out, Path::new("app"));
        assert_eq!(status.branch, None);
        assert_eq!(status.detached.as_deref(), Some("0123456"));
        assert_eq!(status.untracked.len(), 1);
        assert_eq!(status.untracked[0].path, "src/a.ts");

        let status = parse("# branch.oid (initial)\0# branch.head main\0", Path::new(""));
        assert!(status.unborn);
        assert_eq!(status.branch.as_deref(), Some("main"));
    }
}
