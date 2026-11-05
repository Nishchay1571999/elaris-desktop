use serde::{Deserialize, Serialize};
use tauri::State;
use workspace::{Branches, ChangedFile};

use crate::error::{CommandError, CommandResult, blocking};
use crate::shell::{self, Failure};
use crate::state::AppState;

/// Changed files in the open workspace; empty when it isn't a git repository.
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> CommandResult<Vec<ChangedFile>> {
    let workspace = state.require_workspace()?;
    blocking(move || match workspace.status() {
        Err(workspace::Error::NotARepository(_)) => Ok(Vec::new()),
        other => other,
    })
    .await
}

#[tauri::command]
pub async fn git_diff(state: State<'_, AppState>, path: String) -> CommandResult<String> {
    let workspace = state.require_workspace()?;
    blocking(move || workspace.diff(&path)).await
}

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>) -> CommandResult<Branches> {
    let workspace = state.require_workspace()?;
    blocking(move || workspace.branches()).await
}

/// Checks out `name`; a remote branch becomes a local tracking branch.
#[tauri::command]
pub async fn git_switch(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    let workspace = state.require_workspace()?;
    blocking(move || workspace.switch_branch(&name)).await
}

/// Creates `name` from the current commit and switches to it, keeping uncommitted changes.
#[tauri::command]
pub async fn git_create_branch(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    let workspace = state.require_workspace()?;
    blocking(move || {
        let name = name.trim();
        git(workspace.root(), &["check-ref-format", "--branch", name], None).map_err(|_| git_error(format!("{name:?} isn't a valid branch name")))?;
        git(workspace.root(), &["switch", "-c", name], None).map(drop)
    })
    .await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitRequest {
    message: String,
    /// Workspace-relative paths to commit; `None` commits every change.
    paths: Option<Vec<String>>,
}

/// Stages the given paths (or everything) and commits them. Returns the new commit's short hash.
#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, request: CommitRequest) -> CommandResult<String> {
    let workspace = state.require_workspace()?;
    blocking(move || {
        let root = workspace.root();
        if request.message.trim().is_empty() {
            return Err(git_error("Write a commit message first"));
        }
        match &request.paths {
            Some(paths) if paths.is_empty() => return Err(git_error("Pick at least one file to commit")),
            // `-A` with paths also stages deletions of those paths.
            Some(paths) => {
                let mut args = vec!["add", "-A", "--"];
                args.extend(paths.iter().map(String::as_str));
                git(root, &args, None)?;
            }
            None => {
                git(root, &["add", "-A"], None)?;
            }
        }
        let mut args = vec!["commit", "-F", "-"];
        // Only what was picked, even if other files were already staged.
        if let Some(paths) = &request.paths {
            args.push("--");
            args.extend(paths.iter().map(String::as_str));
        }
        git(root, &args, Some(&request.message))?;
        git(root, &["rev-parse", "--short", "HEAD"], None)
    })
    .await
}

/// Pushes the current branch to `origin`, setting it as upstream.
#[tauri::command]
pub async fn git_push(state: State<'_, AppState>) -> CommandResult<()> {
    let workspace = state.require_workspace()?;
    blocking(move || push_current(&workspace)).await
}

pub(crate) fn push_current(workspace: &workspace::Workspace) -> CommandResult<()> {
    let branch = workspace.info().branch.ok_or_else(|| git_error("Check out a branch to push"))?;
    git(workspace.root(), &["push", "--set-upstream", "origin", &branch], None)?;
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitSummary {
    subject: String,
    body: String,
}

/// Commits on this branch that `base` doesn't have, oldest first; to prefill a pull request.
#[tauri::command]
pub async fn git_log_range(state: State<'_, AppState>, base: String) -> CommandResult<Vec<CommitSummary>> {
    let workspace = state.require_workspace()?;
    blocking(move || {
        let root = workspace.root();
        // Compare with the remote's copy when there is one: the local base may be stale.
        let remote = format!("origin/{base}");
        let from = if git(root, &["rev-parse", "--verify", "--quiet", &remote], None).is_ok() { remote } else { base };
        let out = git(root, &["log", "--reverse", "--format=%s%x00%b%x1e", &format!("{from}..HEAD")], None)?;
        Ok::<_, CommandError>(out
            .split('\u{1e}')
            .filter_map(|entry| {
                let (subject, body) = entry.trim().split_once('\0')?;
                Some(CommitSummary { subject: subject.trim().to_owned(), body: body.trim().to_owned() })
            })
            .collect())
    })
    .await
}

pub(crate) fn git_error(message: impl Into<String>) -> CommandError {
    CommandError::Git(message.into())
}

/// Runs git in `root`; its trimmed stdout, or what it printed as the error.
pub(crate) fn git(root: &std::path::Path, args: &[&str], input: Option<&str>) -> CommandResult<String> {
    shell::run_with_input(Some(root), "git", args, input).map_err(|failure| match failure {
        Failure::NotFound => git_error("git wasn't found; install the Xcode command line tools or git"),
        Failure::Failed(message) | Failure::Io(message) => git_error(message),
    })
}
