//! Terminal tabs: the user's shells, started in the open workspace, and the
//! terminals the agent starts (see [`crate::agent_terminal`]). A window shows
//! one by attaching to it: output arrives as raw bytes over a channel, which
//! the emulator decodes.

use std::path::PathBuf;

use serde_json::json;
use tauri::State;
use tauri::ipc::{Channel, InvokeResponseBody};
use terminal::{Event, Program, Spawn};

use crate::agent_terminal::AgentTerminal;
use crate::error::CommandResult;
use crate::state::AppState;

/// Starts the user's shell in the open folder (or home) and returns its id.
#[tauri::command]
pub fn terminal_open(state: State<'_, AppState>, cols: u16, rows: u16) -> CommandResult<u32> {
    let cwd = state
        .workspace()
        .map(|workspace| workspace.root().to_path_buf())
        .or_else(|| std::env::var_os("HOME").map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("/"));
    let spawn = Spawn { cwd: &cwd, cols, rows, program: Program::Shell, owner: None, title: "Terminal".into() };
    Ok(state.terminals.spawn(spawn)?)
}

/// Follows terminal `id`: its scrollback, then new output, as raw bytes on
/// `on_event`, and finally `{ "exit": code }` once it ends.
#[tauri::command]
pub fn terminal_attach(state: State<'_, AppState>, id: u32, on_event: Channel<InvokeResponseBody>) -> CommandResult<()> {
    let sink = Box::new(move |event: Event| {
        let body = match event {
            Event::Output(bytes) => InvokeResponseBody::Raw(bytes),
            Event::Exit(code) => InvokeResponseBody::Json(json!({ "exit": code }).to_string()),
        };
        on_event.send(body).is_ok()
    });
    Ok(state.terminals.subscribe(id, sink)?)
}

/// The agent's terminals still open, so a reloaded window can show their tabs again.
#[tauri::command]
pub fn terminal_agent_list(state: State<'_, AppState>) -> Vec<AgentTerminal> {
    state
        .terminals
        .list()
        .into_iter()
        .filter_map(|info| Some(AgentTerminal { id: info.id, session_id: info.owner?, title: info.title }))
        .collect()
}

#[tauri::command]
pub fn terminal_write(state: State<'_, AppState>, id: u32, data: String) -> CommandResult<()> {
    Ok(state.terminals.write(id, data.as_bytes())?)
}

#[tauri::command]
pub fn terminal_resize(state: State<'_, AppState>, id: u32, cols: u16, rows: u16) -> CommandResult<()> {
    Ok(state.terminals.resize(id, cols, rows)?)
}

/// Ends the terminal's process and forgets it.
#[tauri::command]
pub fn terminal_close(state: State<'_, AppState>, id: u32) {
    state.terminals.kill(id);
}

/// Ends the user's shells, e.g. those left behind when the window reloaded.
/// The agent's keep running: their tabs come back through `terminal_agent_list`.
#[tauri::command]
pub fn terminal_close_all(state: State<'_, AppState>) {
    state.terminals.kill_where(|info| info.owner.is_none());
}
