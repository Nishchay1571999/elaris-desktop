//! Elaris Desktop: a Tauri shell around the Rust crates. The React UI calls the
//! commands in [`commands`]; all file, git, persistence and agent work happens
//! here, off the UI thread.

mod agent_contexts;
mod agent_desktop;
mod agent_device;
mod agent_terminal;
mod commands;
mod error;
mod gh_snapshot;
mod shell;
mod sidecar;
mod state;
mod store;

use agent_core::ClaudeAgent;
use code_intelligence::CodeIntelligence;
use contexts::ContextStore;
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
            let contexts = ContextStore::open(&data_dir.join("elaris.db"))?;
            let code = CodeIntelligence::new(data_dir.join("code-intelligence"));
            app.manage(AppState::new(store, claude, contexts, code));
            commands::git::install(app.handle());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::workspace::workspace_open,
            commands::workspace::workspace_current,
            commands::workspace::workspace_recent,
            commands::workspace::workspace_open_file,
            commands::workspace::workspace_reveal,
            commands::workspace::workspace_list_dir,
            commands::workspace::workspace_read_file,
            commands::workspace::workspace_logo,
            commands::workspace::read_image_data_url,
            commands::git::git_output_history,
            commands::git::git_init,
            commands::git::git_status,
            commands::git::git_scm_status,
            commands::git::git_diff,
            commands::git::git_diff_file,
            commands::git::git_apply_patch,
            commands::git::git_stage,
            commands::git::git_stage_all,
            commands::git::git_unstage,
            commands::git::git_unstage_all,
            commands::git::git_discard,
            commands::git::git_discard_all,
            commands::git::git_ignore,
            commands::git::git_commit,
            commands::git::git_last_commit_message,
            commands::git::git_undo_last_commit,
            commands::git::git_authors,
            commands::git::git_fetch,
            commands::git::git_pull,
            commands::git::git_push,
            commands::git::git_sync,
            commands::git::git_clone,
            commands::git::git_branches,
            commands::git::git_switch,
            commands::git::git_create_branch,
            commands::git::git_rename_branch,
            commands::git::git_delete_branch,
            commands::git::git_delete_remote_branch,
            commands::git::git_merge,
            commands::git::git_rebase,
            commands::git::git_checkout_commit,
            commands::git::git_cherry_pick,
            commands::git::git_revert,
            commands::git::git_abort_operation,
            commands::git::git_continue_operation,
            commands::git::git_stashes,
            commands::git::git_stash,
            commands::git::git_stash_apply,
            commands::git::git_stash_drop,
            commands::git::git_stash_clear,
            commands::git::git_stash_show,
            commands::git::git_tags,
            commands::git::git_create_tag,
            commands::git::git_delete_tag,
            commands::git::git_push_tags,
            commands::git::git_delete_remote_tag,
            commands::git::git_remotes,
            commands::git::git_add_remote,
            commands::git::git_remove_remote,
            commands::git::git_rename_remote,
            commands::git::git_log,
            commands::git::git_show,
            commands::git::git_log_range,
            commands::github::gh_status,
            commands::github::gh_install,
            commands::github::gh_login,
            commands::github::gh_login_cancel,
            commands::github::gh_logout,
            commands::github::gh_repo,
            commands::github::gh_pr_list,
            commands::github::gh_pr_view,
            commands::github::gh_pr_diff,
            commands::github::gh_pr_for_branch,
            commands::github::gh_pr_comment,
            commands::github::gh_pr_review,
            commands::github::gh_pr_merge,
            commands::github::gh_pr_set_state,
            commands::github::gh_pr_checkout,
            commands::github::gh_pr_create,
            commands::github::gh_search,
            commands::github::gh_repos,
            commands::github::gh_labels,
            commands::github::gh_issue_view,
            commands::github::gh_issue_comment,
            commands::github::gh_issue_set_state,
            commands::github::gh_asset,
            commands::github::gh_save_item,
            commands::github::gh_asset_open,
            commands::github::open_url,
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
            commands::chat::chat_send_agent,
            commands::chat::chat_image,
            commands::chat::chat_attach,
            commands::chat::chat_running,
            commands::chat::chat_stop,
            commands::chat::chat_permission,
            commands::chat::chat_answer,
            commands::chat::permissions_list,
            commands::chat::permissions_forget,
            commands::contexts::contexts_save,
            commands::contexts::contexts_list,
            commands::contexts::contexts_get,
            commands::contexts::contexts_rename,
            commands::contexts::contexts_delete,
            commands::contexts::contexts_export,
            commands::contexts::items_list,
            commands::contexts::items_delete,
            commands::contexts::items_export,
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
