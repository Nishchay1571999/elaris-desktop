use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use workspace::{FileEntry, FilePreview, Watcher, Workspace, WorkspaceInfo};

use crate::error::{CommandResult, blocking};
use crate::state::AppState;

/// Emitted with [`WorkspaceChanged`] when files in the open workspace change.
pub const CHANGED_EVENT: &str = "workspace://changed";

#[derive(Clone, Serialize)]
pub struct WorkspaceChanged {
    paths: Vec<String>,
}

#[tauri::command]
pub async fn workspace_open(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> CommandResult<WorkspaceInfo> {
    let (workspace, watcher, info) = blocking(move || {
        let workspace = Workspace::open(&path)?;
        let watcher = Watcher::start(workspace.root(), move |paths| {
            let _ = app.emit(CHANGED_EVENT, WorkspaceChanged { paths });
        })?;
        let info = workspace.info();
        Ok::<_, workspace::Error>((workspace, watcher, info))
    })
    .await?;

    state.set_workspace(workspace, watcher);
    state.store.remember_workspace(&info.root)?;
    Ok(info)
}

/// The open workspace with fresh git info (the branch may have changed).
#[tauri::command]
pub async fn workspace_current(state: State<'_, AppState>) -> CommandResult<Option<WorkspaceInfo>> {
    let Some(workspace) = state.workspace() else { return Ok(None) };
    blocking(move || Ok::<_, workspace::Error>(Some(workspace.info()))).await
}

#[tauri::command]
pub fn workspace_recent(state: State<'_, AppState>) -> Vec<String> {
    state.store.recent_workspaces()
}

#[tauri::command]
pub async fn workspace_list_dir(state: State<'_, AppState>, path: String) -> CommandResult<Vec<FileEntry>> {
    let workspace = state.require_workspace()?;
    blocking(move || workspace.list_dir(&path)).await
}

#[tauri::command]
pub async fn workspace_read_file(state: State<'_, AppState>, path: String) -> CommandResult<FilePreview> {
    let workspace = state.require_workspace()?;
    blocking(move || workspace.read_file(&path)).await
}
