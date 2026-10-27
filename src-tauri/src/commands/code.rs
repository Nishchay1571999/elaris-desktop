//! Language servers for the code views: colours from semantic tokens, and
//! installing a missing server through Neovim's Mason.
//!
//! `path` is workspace-relative (file and diff views) or absolute (agent
//! Write/Edit tabs). The UI sends the text it shows, so the colours always
//! line up with it.

use std::path::{Path, PathBuf};

use code_intelligence::{Highlights, ServerStatus};
use tauri::State;

use crate::error::CommandResult;
use crate::state::AppState;

#[tauri::command]
pub async fn code_highlights(state: State<'_, AppState>, path: String, text: String) -> CommandResult<Highlights> {
    let (root, file) = locate(&state, &path)?;
    Ok(state.code.highlights(&root, &file, &text).await)
}

/// Can take minutes: Mason downloads the server.
#[tauri::command]
pub async fn code_install_server(state: State<'_, AppState>, path: String) -> CommandResult<ServerStatus> {
    let (root, file) = locate(&state, &path)?;
    Ok(state.code.install(&root, &file).await?)
}

fn locate(state: &AppState, path: &str) -> CommandResult<(PathBuf, PathBuf)> {
    let root = state.require_workspace()?.root().to_path_buf();
    let file = if Path::new(path).is_absolute() { PathBuf::from(path) } else { root.join(path) };
    Ok((root, file))
}
