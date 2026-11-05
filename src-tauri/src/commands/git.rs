//! The Source Control panel's commands. The work itself lives in the
//! `workspace` crate; these run it off the async runtime and stream progress.

use std::collections::VecDeque;
use std::sync::Mutex;

use serde::Serialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use workspace::{
    Branches, ChangedFile, CommitDetail, CommitOptions, DiffSide, FetchOptions, GitOutputEntry, GraphCommit, LogOptions,
    PullOptions, PushOptions, RemoteEntry, ScmStatus, StashEntry, StashOptions, TagEntry, Workspace,
};

use crate::error::{CommandResult, blocking};
use crate::shell;
use crate::state::AppState;

/// Emitted with each [`GitOutputEntry`] as git commands finish.
pub const OUTPUT_EVENT: &str = "git://output";
/// Entries kept for a Git Output view opened later.
const OUTPUT_KEEP: usize = 500;

static OUTPUT: Mutex<VecDeque<GitOutputEntry>> = Mutex::new(VecDeque::new());

/// Runs git with the login shell's PATH and records every command for the
/// Git Output view. Called once at startup.
pub fn install(app: &AppHandle) {
    workspace::set_command_hook(|command| {
        command.env("PATH", shell::login_path());
    });
    let app = app.clone();
    workspace::set_output_sink(move |entry| {
        let _ = app.emit(OUTPUT_EVENT, &entry);
        let mut log = OUTPUT.lock().unwrap();
        if log.len() == OUTPUT_KEEP {
            log.pop_front();
        }
        log.push_back(entry);
    });
}

/// Git commands run so far this session, oldest first.
#[tauri::command]
pub fn git_output_history() -> Vec<GitOutputEntry> {
    OUTPUT.lock().unwrap().iter().cloned().collect()
}

/// Runs `work` against the open workspace on the blocking pool.
async fn with_workspace<T: Send + 'static>(
    state: State<'_, AppState>,
    work: impl FnOnce(Workspace) -> workspace::Result<T> + Send + 'static,
) -> CommandResult<T> {
    let workspace = state.require_workspace()?;
    blocking(move || work(workspace)).await
}

/// Forwards git's progress lines to the window.
fn progress(channel: Channel<String>) -> impl FnMut(&str) {
    move |line| {
        let _ = channel.send(line.to_owned());
    }
}

// ---------------------------------------------------------------- status and diffs

/// Makes the open folder a git repository.
#[tauri::command]
pub async fn git_init(state: State<'_, AppState>) -> CommandResult<()> {
    with_workspace(state, |ws| ws.git(&["init"], None).map(drop)).await
}

/// Changed files in the open workspace; empty when it isn't a git repository.
#[tauri::command]
pub async fn git_status(state: State<'_, AppState>) -> CommandResult<Vec<ChangedFile>> {
    with_workspace(state, |ws| match ws.status() {
        Err(workspace::Error::NotARepository(_)) => Ok(Vec::new()),
        other => other,
    })
    .await
}

/// Staged, unstaged, untracked and conflicted files, and the branch's
/// standing; `None` when the workspace isn't a git repository.
#[tauri::command]
pub async fn git_scm_status(state: State<'_, AppState>) -> CommandResult<Option<ScmStatus>> {
    with_workspace(state, |ws| match ws.scm_status() {
        Err(workspace::Error::NotARepository(_)) => Ok(None),
        other => other.map(Some),
    })
    .await
}

/// A file's changes against HEAD, staged and unstaged together.
#[tauri::command]
pub async fn git_diff(state: State<'_, AppState>, path: String) -> CommandResult<String> {
    with_workspace(state, move |ws| ws.diff(&path)).await
}

#[tauri::command]
pub async fn git_diff_file(state: State<'_, AppState>, path: String, side: DiffSide) -> CommandResult<String> {
    with_workspace(state, move |ws| ws.diff_file(&path, side)).await
}

/// Stages, unstages (`cached` + `reverse`) or reverts (`reverse`) a hunk.
#[tauri::command]
pub async fn git_apply_patch(state: State<'_, AppState>, patch: String, cached: bool, reverse: bool) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.apply_patch(&patch, cached, reverse)).await
}

// ---------------------------------------------------------------- changes

#[tauri::command]
pub async fn git_stage(state: State<'_, AppState>, paths: Vec<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.stage(&paths)).await
}

#[tauri::command]
pub async fn git_stage_all(state: State<'_, AppState>) -> CommandResult<()> {
    with_workspace(state, |ws| ws.stage_all()).await
}

#[tauri::command]
pub async fn git_unstage(state: State<'_, AppState>, paths: Vec<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.unstage(&paths)).await
}

#[tauri::command]
pub async fn git_unstage_all(state: State<'_, AppState>) -> CommandResult<()> {
    with_workspace(state, |ws| ws.unstage_all()).await
}

/// Throws away work-tree changes; untracked files go to the Trash.
#[tauri::command]
pub async fn git_discard(state: State<'_, AppState>, paths: Vec<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.discard(&paths)).await
}

#[tauri::command]
pub async fn git_discard_all(state: State<'_, AppState>) -> CommandResult<()> {
    with_workspace(state, |ws| ws.discard_all()).await
}

#[tauri::command]
pub async fn git_ignore(state: State<'_, AppState>, path: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.ignore(&path)).await
}

// ---------------------------------------------------------------- commits

/// Commits and returns the new commit's short hash. With neither `paths`
/// nor `stagedOnly`, every change is staged first.
#[tauri::command]
pub async fn git_commit(state: State<'_, AppState>, request: CommitOptions) -> CommandResult<String> {
    with_workspace(state, move |ws| ws.commit(&request)).await
}

#[tauri::command]
pub async fn git_last_commit_message(state: State<'_, AppState>) -> CommandResult<String> {
    with_workspace(state, |ws| ws.last_commit_message()).await
}

/// Undoes the last commit, keeping its changes staged; returns its message.
#[tauri::command]
pub async fn git_undo_last_commit(state: State<'_, AppState>) -> CommandResult<String> {
    with_workspace(state, |ws| ws.undo_last_commit()).await
}

#[tauri::command]
pub async fn git_authors(state: State<'_, AppState>) -> CommandResult<Vec<String>> {
    with_workspace(state, |ws| ws.authors()).await
}

// ---------------------------------------------------------------- sync

#[tauri::command]
pub async fn git_fetch(state: State<'_, AppState>, options: FetchOptions, on_progress: Channel<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.fetch(&options, &mut progress(on_progress))).await
}

#[tauri::command]
pub async fn git_pull(state: State<'_, AppState>, options: PullOptions, on_progress: Channel<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.pull(&options, &mut progress(on_progress))).await
}

/// Pushes the current branch; one without an upstream is published.
#[tauri::command]
pub async fn git_push(state: State<'_, AppState>, options: PushOptions, on_progress: Channel<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.push(&options, &mut progress(on_progress))).await
}

/// Pushes the current branch, publishing it if needed; before opening a pull request.
pub(crate) fn push_current(workspace: &Workspace) -> CommandResult<()> {
    Ok(workspace.push(&PushOptions::default(), &mut |_| {})?)
}

/// Pulls if behind, then pushes.
#[tauri::command]
pub async fn git_sync(state: State<'_, AppState>, rebase: bool, on_progress: Channel<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.sync(rebase, &mut progress(on_progress))).await
}

/// Clones `url` into a new folder inside `parent`; returns the folder.
#[tauri::command]
pub async fn git_clone(url: String, parent: String, on_progress: Channel<String>) -> CommandResult<String> {
    blocking(move || {
        workspace::clone(&url, std::path::Path::new(&parent), &mut progress(on_progress)).map(|p| p.display().to_string())
    })
    .await
}

// ---------------------------------------------------------------- branches

#[tauri::command]
pub async fn git_branches(state: State<'_, AppState>) -> CommandResult<Branches> {
    with_workspace(state, |ws| ws.branches()).await
}

/// Checks out `name`; a remote branch becomes a local tracking branch.
#[tauri::command]
pub async fn git_switch(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.switch_branch(&name)).await
}

/// Creates `name` from `from` (default: the current commit) and switches to
/// it, keeping uncommitted changes.
#[tauri::command]
pub async fn git_create_branch(state: State<'_, AppState>, name: String, from: Option<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.create_branch(&name, from.as_deref())).await
}

#[tauri::command]
pub async fn git_rename_branch(state: State<'_, AppState>, old: String, new: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.rename_branch(&old, &new)).await
}

#[tauri::command]
pub async fn git_delete_branch(state: State<'_, AppState>, name: String, force: bool) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.delete_branch(&name, force)).await
}

#[tauri::command]
pub async fn git_delete_remote_branch(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.delete_remote_branch(&name)).await
}

#[tauri::command]
pub async fn git_merge(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.merge(&name)).await
}

#[tauri::command]
pub async fn git_rebase(state: State<'_, AppState>, onto: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.rebase(&onto)).await
}

#[tauri::command]
pub async fn git_checkout_commit(state: State<'_, AppState>, sha: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.checkout_commit(&sha)).await
}

#[tauri::command]
pub async fn git_cherry_pick(state: State<'_, AppState>, sha: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.cherry_pick(&sha)).await
}

#[tauri::command]
pub async fn git_revert(state: State<'_, AppState>, sha: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.revert(&sha)).await
}

#[tauri::command]
pub async fn git_abort_operation(state: State<'_, AppState>) -> CommandResult<()> {
    with_workspace(state, |ws| ws.abort_operation()).await
}

#[tauri::command]
pub async fn git_continue_operation(state: State<'_, AppState>) -> CommandResult<()> {
    with_workspace(state, |ws| ws.continue_operation()).await
}

// ---------------------------------------------------------------- stashes

#[tauri::command]
pub async fn git_stashes(state: State<'_, AppState>) -> CommandResult<Vec<StashEntry>> {
    with_workspace(state, |ws| ws.stashes()).await
}

#[tauri::command]
pub async fn git_stash(state: State<'_, AppState>, options: StashOptions) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.stash(&options)).await
}

#[tauri::command]
pub async fn git_stash_apply(state: State<'_, AppState>, index: u32, pop: bool) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.stash_apply(index, pop)).await
}

#[tauri::command]
pub async fn git_stash_drop(state: State<'_, AppState>, index: u32) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.stash_drop(index)).await
}

#[tauri::command]
pub async fn git_stash_clear(state: State<'_, AppState>) -> CommandResult<()> {
    with_workspace(state, |ws| ws.stash_clear()).await
}

#[tauri::command]
pub async fn git_stash_show(state: State<'_, AppState>, index: u32) -> CommandResult<String> {
    with_workspace(state, move |ws| ws.stash_show(index)).await
}

// ---------------------------------------------------------------- tags

#[tauri::command]
pub async fn git_tags(state: State<'_, AppState>) -> CommandResult<Vec<TagEntry>> {
    with_workspace(state, |ws| ws.tags()).await
}

#[tauri::command]
pub async fn git_create_tag(
    state: State<'_, AppState>,
    name: String,
    message: Option<String>,
    target: Option<String>,
) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.create_tag(&name, message.as_deref(), target.as_deref())).await
}

#[tauri::command]
pub async fn git_delete_tag(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.delete_tag(&name)).await
}

#[tauri::command]
pub async fn git_push_tags(state: State<'_, AppState>, remote: Option<String>, on_progress: Channel<String>) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.push_tags(remote.as_deref(), &mut progress(on_progress))).await
}

#[tauri::command]
pub async fn git_delete_remote_tag(state: State<'_, AppState>, remote: String, name: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.delete_remote_tag(&remote, &name)).await
}

// ---------------------------------------------------------------- remotes

#[tauri::command]
pub async fn git_remotes(state: State<'_, AppState>) -> CommandResult<Vec<RemoteEntry>> {
    with_workspace(state, |ws| ws.remotes()).await
}

#[tauri::command]
pub async fn git_add_remote(state: State<'_, AppState>, name: String, url: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.add_remote(&name, &url)).await
}

#[tauri::command]
pub async fn git_remove_remote(state: State<'_, AppState>, name: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.remove_remote(&name)).await
}

#[tauri::command]
pub async fn git_rename_remote(state: State<'_, AppState>, old: String, new: String) -> CommandResult<()> {
    with_workspace(state, move |ws| ws.rename_remote(&old, &new)).await
}

// ---------------------------------------------------------------- history

#[tauri::command]
pub async fn git_log(state: State<'_, AppState>, options: LogOptions) -> CommandResult<Vec<GraphCommit>> {
    with_workspace(state, move |ws| ws.log(&options)).await
}

#[tauri::command]
pub async fn git_show(state: State<'_, AppState>, sha: String) -> CommandResult<CommitDetail> {
    with_workspace(state, move |ws| ws.show_commit(&sha)).await
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
    with_workspace(state, move |ws| {
        // Compare with the remote's copy when there is one: the local base may be stale.
        let remote = format!("origin/{base}");
        let from = if ws.git(&["rev-parse", "--verify", "--quiet", &remote], None).is_ok() { remote } else { base };
        let out = ws.git(&["log", "--reverse", "--format=%s%x00%b%x1e", &format!("{from}..HEAD")], None)?;
        Ok(out
            .split('\u{1e}')
            .filter_map(|entry| {
                let (subject, body) = entry.trim().split_once('\0')?;
                Some(CommitSummary { subject: subject.trim().to_owned(), body: body.trim().to_owned() })
            })
            .collect())
    })
    .await
}
