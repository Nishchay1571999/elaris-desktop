//! Everything the Source Control panel can do to a repository: staging,
//! committing, syncing with remotes, branches, stashes, tags and remotes.
//! Each is a thin wrapper over the git CLI, so hooks, credential helpers and
//! config behave exactly as they do in a terminal.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::runner::{self, Opts, git, git_input, read};
use super::{open, status};
use crate::{Error, Result};

fn fail(message: impl Into<String>) -> Error {
    Error::GitCommand(message.into())
}

/// `git <args> -- <paths>`.
fn with_paths<'a>(args: &[&'a str], paths: &'a [String]) -> Vec<&'a str> {
    let mut all = args.to_vec();
    all.push("--");
    all.extend(paths.iter().map(String::as_str));
    all
}

fn has_commits(root: &Path) -> bool {
    read(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_ok()
}

// ---------------------------------------------------------------- changes

pub(crate) fn stage(root: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    // `-A` also stages deletions of the given paths.
    git(root, &with_paths(&["add", "-A"], paths)).map(drop)
}

pub(crate) fn stage_all(root: &Path) -> Result<()> {
    git(root, &["add", "-A", "--", "."]).map(drop)
}

pub(crate) fn unstage(root: &Path, paths: &[String]) -> Result<()> {
    if paths.is_empty() {
        return Ok(());
    }
    if has_commits(root) {
        git(root, &with_paths(&["restore", "--staged"], paths)).map(drop)
    } else {
        // Nothing to restore from before the first commit.
        git(root, &with_paths(&["rm", "--cached", "-r", "-q"], paths)).map(drop)
    }
}

pub(crate) fn unstage_all(root: &Path) -> Result<()> {
    unstage(root, &[".".to_owned()])
}

/// Throws away work-tree changes to `paths`. Tracked files go back to their
/// staged (or committed) version; untracked ones are moved to the Trash, so a
/// slip can be undone.
pub(crate) fn discard(root: &Path, paths: &[String]) -> Result<()> {
    let current = status::scm_status(root)?;
    let (untracked, tracked): (Vec<String>, Vec<String>) =
        paths.iter().cloned().partition(|p| current.untracked.iter().any(|f| &f.path == p));
    if !tracked.is_empty() {
        git(root, &with_paths(&["restore", "--worktree"], &tracked))?;
    }
    let files: Vec<PathBuf> = untracked.iter().map(|p| root.join(p)).filter(|p| p.exists()).collect();
    if !files.is_empty() {
        trash::delete_all(&files).map_err(|e| fail(format!("Couldn't move files to the Trash: {e}")))?;
    }
    Ok(())
}

/// Discards every change in the workspace, untracked files included.
pub(crate) fn discard_all(root: &Path) -> Result<()> {
    let current = status::scm_status(root)?;
    let paths: Vec<String> = current.unstaged.iter().chain(&current.untracked).map(|f| f.path.clone()).collect();
    discard(root, &paths)
}

/// Appends `rel` to the workspace's `.gitignore`.
pub(crate) fn ignore(root: &Path, rel: &str) -> Result<()> {
    let file = root.join(".gitignore");
    let mut text = std::fs::read_to_string(&file).unwrap_or_default();
    let line = format!("/{rel}");
    if text.lines().any(|l| l.trim() == line) {
        return Ok(());
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&line);
    text.push('\n');
    std::fs::write(file, text)?;
    Ok(())
}

// ---------------------------------------------------------------- commits

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct CommitOptions {
    pub message: String,
    /// Commit only these workspace-relative paths, staging them first.
    pub paths: Option<Vec<String>>,
    /// Commit exactly what is staged; stage nothing.
    pub staged_only: bool,
    /// Rewrite the last commit. An empty message keeps its message.
    pub amend: bool,
    /// Add a `Signed-off-by` trailer.
    pub signoff: bool,
    /// Skip pre-commit and commit-msg hooks.
    pub no_verify: bool,
    pub allow_empty: bool,
}

/// Commits and returns the new commit's short hash. Without `paths` or
/// `staged_only`, every change in the workspace is staged first.
pub(crate) fn commit(root: &Path, options: &CommitOptions) -> Result<String> {
    let message = options.message.trim();
    if message.is_empty() && !options.amend {
        return Err(fail("Write a commit message first"));
    }
    match &options.paths {
        Some(paths) if paths.is_empty() => return Err(fail("Pick at least one file to commit")),
        Some(paths) => stage(root, paths)?,
        None if !options.staged_only => stage_all(root)?,
        None => {}
    }
    let mut args = vec!["commit"];
    if message.is_empty() {
        args.push("--no-edit");
    } else {
        args.extend(["-F", "-"]);
    }
    for (on, flag) in [
        (options.amend, "--amend"),
        (options.signoff, "--signoff"),
        (options.no_verify, "--no-verify"),
        (options.allow_empty, "--allow-empty"),
    ] {
        if on {
            args.push(flag);
        }
    }
    // Only what was picked, even if other files were already staged.
    if let Some(paths) = &options.paths {
        args.push("--");
        args.extend(paths.iter().map(String::as_str));
    }
    if message.is_empty() {
        git(root, &args)?;
    } else {
        git_input(root, &args, message)?;
    }
    read(root, &["rev-parse", "--short", "HEAD"])
}

/// The last commit's full message, to prefill an amend.
pub(crate) fn last_commit_message(root: &Path) -> Result<String> {
    read(root, &["log", "-1", "--format=%B"])
}

/// Undoes the last commit, keeping its changes staged. Returns its message
/// so it can go back in the commit box.
pub(crate) fn undo_last_commit(root: &Path) -> Result<String> {
    let message = last_commit_message(root)?;
    if read(root, &["rev-parse", "--verify", "--quiet", "HEAD~1"]).is_ok() {
        git(root, &["reset", "--soft", "HEAD~1"])?;
    } else {
        // The only commit: back to an unborn branch with everything staged.
        git(root, &["update-ref", "-d", "HEAD"])?;
    }
    Ok(message)
}

// ---------------------------------------------------------------- sync

/// Receives git's progress lines (`Receiving objects:  45% (450/1000)`).
pub type Progress<'a> = &'a mut dyn FnMut(&str);

fn run_with_progress(root: &Path, args: &[&str], progress: Progress) -> Result<()> {
    runner::run(root, args, Opts { progress: Some(progress), ..Opts::default() }).map(drop)
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct FetchOptions {
    /// A single remote; `None` fetches the upstream's remote (or `origin`).
    pub remote: Option<String>,
    /// Every remote.
    pub all: bool,
    /// Drop remote branches that were deleted on the remote.
    pub prune: bool,
}

pub(crate) fn fetch(root: &Path, options: &FetchOptions, progress: Progress) -> Result<()> {
    let mut args = vec!["fetch", "--progress"];
    if options.prune {
        args.push("--prune");
    }
    if options.all {
        args.push("--all");
    } else if let Some(remote) = &options.remote {
        args.push(remote);
    }
    run_with_progress(root, &args, progress)
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct PullOptions {
    /// Pull from this remote and branch instead of the upstream.
    pub remote: Option<String>,
    pub branch: Option<String>,
    pub rebase: bool,
}

pub(crate) fn pull(root: &Path, options: &PullOptions, progress: Progress) -> Result<()> {
    let mut args = vec!["pull", "--progress"];
    if options.rebase {
        args.push("--rebase");
    } else if read(root, &["config", "--get", "pull.rebase"]).is_err() {
        // Unconfigured, newer git refuses to pull diverged branches; merge,
        // as git always used to.
        args.push("--no-rebase");
    }
    if let Some(remote) = &options.remote {
        args.push(remote);
        if let Some(branch) = &options.branch {
            args.push(branch);
        }
    }
    run_with_progress(root, &args, progress)
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct PushOptions {
    /// Push to this remote (and set it as upstream) instead of the upstream.
    pub remote: Option<String>,
    /// `--force-with-lease`: overwrite the remote only if nobody else pushed.
    pub force: bool,
    /// Also push annotated tags that point at pushed commits.
    pub follow_tags: bool,
}

/// Pushes the current branch. A branch without an upstream is published:
/// pushed to the given remote (or the only one, or `origin`) and tracked.
pub(crate) fn push(root: &Path, options: &PushOptions, progress: Progress) -> Result<()> {
    let current = status::scm_status(root)?;
    let branch = current.branch.ok_or_else(|| fail("Check out a branch to push"))?;
    let mut args = vec!["push", "--progress"];
    if options.force {
        args.push("--force-with-lease");
    }
    if options.follow_tags {
        args.push("--follow-tags");
    }
    let remote;
    if options.remote.is_some() || current.upstream.is_none() {
        remote = match &options.remote {
            Some(remote) => remote.clone(),
            None => default_remote(root)?,
        };
        args.extend(["--set-upstream", &remote, &branch]);
    }
    run_with_progress(root, &args, progress)
}

/// Pulls, then pushes what's left: VS Code's Sync Changes.
pub(crate) fn sync(root: &Path, rebase: bool, progress: Progress) -> Result<()> {
    let current = status::scm_status(root)?;
    if current.upstream.is_some() && current.behind > 0 {
        pull(root, &PullOptions { rebase, ..PullOptions::default() }, progress)?;
    }
    push(root, &PushOptions::default(), progress)
}

/// The remote to publish to: the only one, else `origin`.
fn default_remote(root: &Path) -> Result<String> {
    let remotes = remotes(root)?;
    match remotes.as_slice() {
        [] => Err(fail("This repository has no remote. Add one first (Remote ▸ Add Remote).")),
        [only] => Ok(only.name.clone()),
        many => many
            .iter()
            .find(|r| r.name == "origin")
            .map(|r| r.name.clone())
            .ok_or_else(|| fail("Pick a remote to push to (Pull, Push ▸ Push to…)")),
    }
}

/// Clones `url` into a new folder inside `parent`; returns the folder's path.
pub fn clone(url: &str, parent: &Path, progress: Progress) -> Result<PathBuf> {
    let url = url.trim();
    let name = url
        .trim_end_matches('/')
        .rsplit(['/', ':'])
        .next()
        .map(|n| n.trim_end_matches(".git"))
        .filter(|n| !n.is_empty())
        .ok_or_else(|| fail(format!("{url} doesn't look like a repository URL")))?;
    let dest = parent.join(name);
    if dest.exists() {
        return Err(fail(format!("{} already exists", dest.display())));
    }
    let dest_arg = dest.to_string_lossy().into_owned();
    run_with_progress(parent, &["clone", "--progress", "--", url, &dest_arg], progress)?;
    Ok(dest)
}

// ---------------------------------------------------------------- branches

fn check_branch_name(root: &Path, name: &str) -> Result<()> {
    read(root, &["check-ref-format", "--branch", name]).map(drop).map_err(|_| fail(format!("{name:?} isn't a valid branch name")))
}

/// Creates `name` from `from` (default: the current commit) and switches to
/// it, keeping uncommitted changes.
pub(crate) fn create_branch(root: &Path, name: &str, from: Option<&str>) -> Result<()> {
    let name = name.trim();
    check_branch_name(root, name)?;
    let mut args = vec!["switch", "-c", name];
    if let Some(from) = from {
        args.push(from);
        // A remote start point should be tracked, as `switch --track` does.
        if from.contains('/') && read(root, &["rev-parse", "--verify", "--quiet", &format!("refs/remotes/{from}")]).is_ok() {
            args.push("--track");
        }
    }
    git(root, &args).map(drop)
}

pub(crate) fn rename_branch(root: &Path, old: &str, new: &str) -> Result<()> {
    let new = new.trim();
    check_branch_name(root, new)?;
    git(root, &["branch", "-m", old, new]).map(drop)
}

/// Deletes a local branch. Unmerged work needs `force`; the error says so.
pub(crate) fn delete_branch(root: &Path, name: &str, force: bool) -> Result<()> {
    git(root, &["branch", if force { "-D" } else { "-d" }, name]).map(drop)
}

/// Deletes `remote/name` on the remote.
pub(crate) fn delete_remote_branch(root: &Path, remote_branch: &str) -> Result<()> {
    let (remote, name) = remote_branch.split_once('/').ok_or_else(|| fail(format!("{remote_branch} isn't a remote branch")))?;
    git(root, &["push", remote, "--delete", name]).map(drop)
}

pub(crate) fn merge(root: &Path, name: &str) -> Result<()> {
    git(root, &["merge", "--no-edit", name]).map(drop)
}

pub(crate) fn rebase(root: &Path, onto: &str) -> Result<()> {
    git(root, &["rebase", onto]).map(drop)
}

pub(crate) fn checkout_commit(root: &Path, sha: &str) -> Result<()> {
    git(root, &["switch", "--detach", sha]).map(drop)
}

pub(crate) fn cherry_pick(root: &Path, sha: &str) -> Result<()> {
    git(root, &["cherry-pick", sha]).map(drop)
}

pub(crate) fn revert(root: &Path, sha: &str) -> Result<()> {
    git(root, &["revert", "--no-edit", sha]).map(drop)
}

/// The subcommand of the operation in progress, if any.
fn operation_command(root: &Path) -> Result<&'static str> {
    use status::RepoOperation::*;
    let (repo, _) = open(root)?;
    Ok(match status::operation(&repo) {
        Some(Merge) => "merge",
        Some(Rebase) => "rebase",
        Some(CherryPick) => "cherry-pick",
        Some(Revert) => "revert",
        None => return Err(fail("No merge, rebase, cherry-pick or revert is in progress")),
    })
}

pub(crate) fn abort_operation(root: &Path) -> Result<()> {
    git(root, &[operation_command(root)?, "--abort"]).map(drop)
}

/// Continues after conflicts are resolved and staged.
pub(crate) fn continue_operation(root: &Path) -> Result<()> {
    git(root, &[operation_command(root)?, "--continue"]).map(drop)
}

// ---------------------------------------------------------------- stashes

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct StashEntry {
    /// `n` in `stash@{n}`.
    pub index: u32,
    /// E.g. `On main: half-done refactor`.
    pub message: String,
    /// Seconds since the Unix epoch.
    #[ts(type = "number")]
    pub time: i64,
}

pub(crate) fn stashes(root: &Path) -> Result<Vec<StashEntry>> {
    let out = read(root, &["stash", "list", "--format=%gd%x1f%gs%x1f%ct"])?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\u{1f}');
            let index = fields.next()?.strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
            let message = fields.next()?.to_owned();
            let time = fields.next()?.parse().unwrap_or(0);
            Some(StashEntry { index, message, time })
        })
        .collect())
}

#[derive(Debug, Clone, Default, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct StashOptions {
    pub message: Option<String>,
    pub include_untracked: bool,
    /// Stash only what's staged.
    pub staged: bool,
}

pub(crate) fn stash(root: &Path, options: &StashOptions) -> Result<()> {
    let mut args = vec!["stash", "push"];
    if options.include_untracked {
        args.push("--include-untracked");
    }
    if options.staged {
        args.push("--staged");
    }
    let message = options.message.as_deref().map(str::trim).filter(|m| !m.is_empty());
    if let Some(message) = message {
        args.extend(["--message", message]);
    }
    let out = git(root, &args)?;
    if out.contains("No local changes to save") {
        return Err(fail("There are no changes to stash"));
    }
    Ok(())
}

fn stash_ref(index: u32) -> String {
    format!("stash@{{{index}}}")
}

pub(crate) fn stash_apply(root: &Path, index: u32, pop: bool) -> Result<()> {
    git(root, &["stash", if pop { "pop" } else { "apply" }, &stash_ref(index)]).map(drop)
}

pub(crate) fn stash_drop(root: &Path, index: u32) -> Result<()> {
    git(root, &["stash", "drop", &stash_ref(index)]).map(drop)
}

pub(crate) fn stash_clear(root: &Path) -> Result<()> {
    git(root, &["stash", "clear"]).map(drop)
}

/// The stash's changes as a patch, untracked files included.
pub(crate) fn stash_show(root: &Path, index: u32) -> Result<String> {
    let opts = || Opts { read_only: true, ..Opts::default() };
    let r = stash_ref(index);
    let out = runner::run(root, &["stash", "show", "-p", "--include-untracked", "--no-ext-diff", &r], opts())
        // Older git has no --include-untracked here.
        .or_else(|_| runner::run(root, &["stash", "show", "-p", "--no-ext-diff", &r], opts()))?;
    Ok(super::diff::cut(out, super::DIFF_LIMIT * 4))
}

// ---------------------------------------------------------------- tags

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct TagEntry {
    pub name: String,
    /// Short hash of the commit it points at.
    pub sha: String,
    /// The annotation's subject, or the commit's for a lightweight tag.
    pub subject: String,
}

pub(crate) fn tags(root: &Path) -> Result<Vec<TagEntry>> {
    let out = read(
        root,
        &["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%1f%(objectname:short)%1f%(contents:subject)", "refs/tags"],
    )?;
    Ok(out
        .lines()
        .filter_map(|line| {
            let mut fields = line.split('\u{1f}');
            Some(TagEntry {
                name: fields.next()?.to_owned(),
                sha: fields.next()?.to_owned(),
                subject: fields.next().unwrap_or_default().to_owned(),
            })
        })
        .collect())
}

/// Tags `target` (default HEAD). A message makes it an annotated tag.
pub(crate) fn create_tag(root: &Path, name: &str, message: Option<&str>, target: Option<&str>) -> Result<()> {
    let name = name.trim();
    if name.is_empty() || read(root, &["check-ref-format", &format!("refs/tags/{name}")]).is_err() {
        return Err(fail(format!("{name:?} isn't a valid tag name")));
    }
    let message = message.map(str::trim).filter(|m| !m.is_empty());
    let mut args = vec!["tag"];
    if let Some(message) = message {
        args.extend(["-a", "-m", message]);
    }
    args.push(name);
    if let Some(target) = target {
        args.push(target);
    }
    git(root, &args).map(drop)
}

pub(crate) fn delete_tag(root: &Path, name: &str) -> Result<()> {
    git(root, &["tag", "-d", name]).map(drop)
}

pub(crate) fn push_tags(root: &Path, remote: Option<&str>, progress: Progress) -> Result<()> {
    let remote = match remote {
        Some(remote) => remote.to_owned(),
        None => default_remote(root)?,
    };
    run_with_progress(root, &["push", "--progress", &remote, "--tags"], progress)
}

pub(crate) fn delete_remote_tag(root: &Path, remote: &str, name: &str) -> Result<()> {
    git(root, &["push", remote, "--delete", &format!("refs/tags/{name}")]).map(drop)
}

// ---------------------------------------------------------------- remotes

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RemoteEntry {
    pub name: String,
    pub fetch_url: String,
    pub push_url: String,
}

pub(crate) fn remotes(root: &Path) -> Result<Vec<RemoteEntry>> {
    let out = read(root, &["remote", "-v"])?;
    let mut remotes: Vec<RemoteEntry> = Vec::new();
    for line in out.lines() {
        // origin\tgit@github.com:me/repo.git (fetch)
        let Some((name, rest)) = line.split_once('\t') else { continue };
        let Some((url, kind)) = rest.rsplit_once(' ') else { continue };
        let entry = match remotes.iter_mut().find(|r| r.name == name) {
            Some(entry) => entry,
            None => {
                remotes.push(RemoteEntry { name: name.to_owned(), fetch_url: String::new(), push_url: String::new() });
                remotes.last_mut().unwrap()
            }
        };
        match kind {
            "(fetch)" => entry.fetch_url = url.to_owned(),
            _ => entry.push_url = url.to_owned(),
        }
    }
    Ok(remotes)
}

pub(crate) fn add_remote(root: &Path, name: &str, url: &str) -> Result<()> {
    let (name, url) = (name.trim(), url.trim());
    if name.is_empty() || url.is_empty() {
        return Err(fail("A remote needs a name and a URL"));
    }
    git(root, &["remote", "add", name, url]).map(drop)
}

pub(crate) fn remove_remote(root: &Path, name: &str) -> Result<()> {
    git(root, &["remote", "remove", name]).map(drop)
}

pub(crate) fn rename_remote(root: &Path, old: &str, new: &str) -> Result<()> {
    git(root, &["remote", "rename", old, new.trim()]).map(drop)
}

// ---------------------------------------------------------------- people

/// Recent authors as `Name <email>`, most commits first, for co-author trailers.
pub(crate) fn authors(root: &Path) -> Result<Vec<String>> {
    if !has_commits(root) {
        return Ok(Vec::new());
    }
    let out = read(root, &["shortlog", "-sne", "--max-count=2000", "HEAD"])?;
    Ok(out.lines().filter_map(|l| l.split_once('\t').map(|(_, who)| who.trim().to_owned())).take(50).collect())
}
