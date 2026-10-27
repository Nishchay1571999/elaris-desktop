use tauri::State;
use workspace::ChangedFile;

use crate::error::{CommandResult, blocking};
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
