//! Elaris Desktop: a Tauri shell around the Rust crates. The React UI calls the
//! commands in [`commands`]; all file, git, persistence and agent work happens
//! here, off the UI thread.

mod agent_terminal;
mod commands;
mod error;
mod sidecar;
mod state;
mod store;

use agent_core::ClaudeAgent;
use code_intelligence::CodeIntelligence;
use tauri::Manager;

use crate::state::AppState;
use crate::store::Store;

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let store = Store::open(&data_dir)?;
            let claude = ClaudeAgent::new(sidecar::command(app.handle()));
            let code = CodeIntelligence::new(data_dir.join("code-intelligence"));
            app.manage(AppState::new(store, claude, code));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace::workspace_open,
            commands::workspace::workspace_current,
            commands::workspace::workspace_recent,
            commands::workspace::workspace_list_dir,
            commands::workspace::workspace_read_file,
            commands::git::git_status,
            commands::git::git_diff,
            commands::code::code_highlights,
            commands::code::code_install_server,
            commands::sessions::sessions_list,
            commands::sessions::sessions_get,
            commands::sessions::sessions_usage,
            commands::sessions::sessions_create,
            commands::sessions::sessions_rename,
            commands::sessions::sessions_update_settings,
            commands::sessions::sessions_delete,
            commands::chat::chat_send,
            commands::chat::chat_image,
            commands::chat::chat_attach,
            commands::chat::chat_running,
            commands::chat::chat_stop,
            commands::chat::chat_permission,
            commands::chat::chat_answer,
            commands::chat::permissions_list,
            commands::chat::permissions_forget,
            commands::customizations::skills_installed,
            commands::customizations::skills_search,
            commands::customizations::skills_add,
            commands::customizations::skills_remove,
            commands::customizations::mcp_list,
            commands::customizations::mcp_add,
            commands::customizations::mcp_remove,
            commands::customizations::tools_rules,
            commands::customizations::tools_set,
            commands::customizations::instructions_list,
            commands::customizations::instructions_save,
            commands::customizations::instructions_delete,
            commands::edit::edit_action,
            commands::terminal::terminal_open,
            commands::terminal::terminal_attach,
            commands::terminal::terminal_agent_list,
            commands::terminal::terminal_write,
            commands::terminal::terminal_resize,
            commands::terminal::terminal_close,
            commands::terminal::terminal_close_all,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Elaris");
}
