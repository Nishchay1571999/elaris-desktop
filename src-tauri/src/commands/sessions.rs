use agent_protocol::{MOCK_MODEL, Session, SessionSettings, SessionSummary, TokenUsage};
use tauri::State;

use crate::error::{CommandError, CommandResult};
use crate::state::AppState;
use crate::store::now_ms;

#[tauri::command]
pub fn sessions_list(state: State<'_, AppState>) -> CommandResult<Vec<SessionSummary>> {
    Ok(state.store.list()?)
}

#[tauri::command]
pub fn sessions_get(state: State<'_, AppState>, id: String) -> CommandResult<Session> {
    Ok(state.store.get(&id)?)
}

/// The tokens the chat has used, read through the Agent SDK from the agent's
/// own transcript so earlier replies count too, and saved with the chat.
/// Falls back to the saved count when there is no transcript (mock chats, or
/// one made on another machine).
#[tauri::command]
pub async fn sessions_usage(state: State<'_, AppState>, id: String) -> CommandResult<TokenUsage> {
    let session = state.store.get(&id)?;
    let Some(agent_session_id) = session.agent_session_id else { return Ok(session.usage) };
    match state.claude.session_usage(&agent_session_id).await.map_err(CommandError::Agent)? {
        Some(usage) => {
            state.store.update(&id, |s| s.usage = usage)?;
            Ok(usage)
        }
        None => Ok(session.usage),
    }
}

/// Creates an empty chat bound to the open workspace (if any). The UI calls
/// this on first send, so pressing "New" doesn't leave empty chats behind.
#[tauri::command]
pub fn sessions_create(state: State<'_, AppState>, settings: SessionSettings) -> CommandResult<Session> {
    let now = now_ms();
    let session = Session {
        id: uuid::Uuid::new_v4().to_string(),
        title: "New chat".into(),
        created_at: now,
        updated_at: now,
        mode: settings.mode,
        model: settings.model,
        permissions: settings.permissions,
        workspace: state.workspace().map(|w| w.root().display().to_string()),
        agent_session_id: None,
        usage: Default::default(),
        context: 0,
        messages: Vec::new(),
    };
    state.store.insert(&session)?;
    Ok(session)
}

#[tauri::command]
pub fn sessions_rename(state: State<'_, AppState>, id: String, title: String) -> CommandResult<Session> {
    let title = title.trim().to_owned();
    Ok(state.store.update(&id, |session| {
        if !title.is_empty() {
            session.title = title;
        }
    })?)
}

/// Mode, model and permission policy. A reply in flight switches to them
/// straight away, except Ask's no-edit rule, which applies from the next message.
#[tauri::command]
pub async fn sessions_update_settings(
    state: State<'_, AppState>,
    id: String,
    settings: SessionSettings,
) -> CommandResult<Session> {
    let session = state.store.update(&id, |session| session.apply_settings(settings.clone()))?;
    // The mock agent has nothing to switch, and the real one can't switch to it.
    if state.is_running(&id) && settings.model != MOCK_MODEL {
        // The run may have just ended; the saved settings cover the next one.
        let _ = state.claude.update_settings(&id, &settings).await;
    }
    Ok(session)
}

#[tauri::command]
pub fn sessions_delete(state: State<'_, AppState>, id: String) -> CommandResult<()> {
    state.cancel_run(&id);
    Ok(state.store.delete(&id)?)
}
