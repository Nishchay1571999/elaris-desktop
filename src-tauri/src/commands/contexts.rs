use std::path::PathBuf;

use contexts::{Capture, ContextSummary, ItemSummary, TerminalCapture};
use tauri::{AppHandle, Manager, State};
use terminal::plain_text;

use crate::error::{CommandError, CommandResult, blocking};
use crate::state::AppState;

/// Saves chat `session_id` as a context other chats can reference with `#id`:
/// the agent's whole transcript plus its terminals' output. Saving a chat that
/// hasn't changed since returns the context saved then.
#[tauri::command]
pub async fn contexts_save(app: AppHandle, session_id: String) -> CommandResult<ContextSummary> {
    let state = app.state::<AppState>();
    if state.is_running(&session_id) {
        return Err(CommandError::Agent("Wait for the reply to finish, then save the chat.".into()));
    }
    blocking(move || -> CommandResult<ContextSummary> {
        let state = app.state::<AppState>();
        let session = state.store.get(&session_id)?;
        let terminals = state
            .terminals
            .list()
            .into_iter()
            .filter(|info| info.owner.as_deref() == Some(session_id.as_str()))
            .filter_map(|info| {
                let chunk = state.terminals.read(info.id, 0).ok()?;
                Some(TerminalCapture { id: info.id, title: info.title, output: plain_text(&chunk.bytes), trimmed: chunk.skipped })
            })
            .collect();
        let projects_dir = claude_projects_dir();
        Ok(state.contexts.save(Capture { session: &session, projects_dir: &projects_dir, terminals })?)
    })
    .await
}

/// Newest first; `query` matches ids and titles.
#[tauri::command]
pub async fn contexts_list(app: AppHandle, query: Option<String>) -> CommandResult<Vec<ContextSummary>> {
    blocking(move || app.state::<AppState>().contexts.list(query.as_deref())).await
}

#[tauri::command]
pub fn contexts_get(state: State<'_, AppState>, id: String) -> CommandResult<ContextSummary> {
    Ok(state.contexts.get(&id)?)
}

#[tauri::command]
pub fn contexts_rename(state: State<'_, AppState>, id: String, title: String) -> CommandResult<ContextSummary> {
    Ok(state.contexts.rename(&id, &title)?)
}

#[tauri::command]
pub fn contexts_delete(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    Ok(state.contexts.delete(&id)?)
}

/// The whole context as Markdown, for pasting outside Elaris.
#[tauri::command]
pub async fn contexts_export(app: AppHandle, id: String) -> CommandResult<String> {
    blocking(move || app.state::<AppState>().contexts.export(&id)).await
}

/// Saved pull requests and issues (`gh_save_item`), newest first; `query` matches ids,
/// titles and `owner/name#number`.
#[tauri::command]
pub async fn items_list(app: AppHandle, query: Option<String>) -> CommandResult<Vec<ItemSummary>> {
    blocking(move || app.state::<AppState>().contexts.list_items(query.as_deref())).await
}

#[tauri::command]
pub fn items_delete(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    Ok(state.contexts.delete_item(&id)?)
}

/// A saved pull request or issue as Markdown, its attachments listed with where they are on disk.
#[tauri::command]
pub async fn items_export(app: AppHandle, id: String) -> CommandResult<String> {
    blocking(move || app.state::<AppState>().contexts.export_item(&id)).await
}

/// Where the Agent SDK keeps its transcripts.
fn claude_projects_dir() -> PathBuf {
    let config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".claude")))
        .unwrap_or_default();
    config.join("projects")
}
