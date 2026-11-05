use serde::Serialize;
use tauri::{AppHandle, Emitter, State};
use workspace::{FileEntry, FilePreview, Watcher, Workspace, WorkspaceInfo};

use crate::error::{CommandError, CommandResult, blocking};
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

/// The folder's logo (its favicon or `logo.*`, see `workspace::find_logo`) as a `data:` URL,
/// or null when it has none. Works for any folder, not only the open one.
#[tauri::command]
pub async fn workspace_logo(path: String) -> CommandResult<Option<String>> {
    blocking(move || {
        let Some(file) = workspace::find_logo(std::path::Path::new(&path)) else { return Ok(None) };
        image_data_url(&file).map(Some)
    })
    .await
}

/// An image the user picked as a project's logo, as a `data:` URL.
#[tauri::command]
pub async fn read_image_data_url(path: String) -> CommandResult<String> {
    blocking(move || image_data_url(std::path::Path::new(&path))).await
}

fn image_data_url(path: &std::path::Path) -> CommandResult<String> {
    use base64::Engine as _;
    let mime = workspace::image_mime(path)
        .ok_or_else(|| CommandError::Image("Pick an SVG, PNG, ICO, JPEG, WebP or GIF image".into()))?;
    let meta = std::fs::metadata(path).map_err(|e| CommandError::Image(e.to_string()))?;
    if meta.len() > workspace::MAX_LOGO_BYTES {
        return Err(CommandError::Image("That image is over 2 MB; pick a smaller one".into()));
    }
    let bytes = std::fs::read(path).map_err(|e| CommandError::Image(e.to_string()))?;
    Ok(format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(bytes)))
}
