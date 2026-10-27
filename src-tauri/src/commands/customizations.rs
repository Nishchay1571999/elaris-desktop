use customizations::instructions::{self, InstructionFile};
use customizations::mcp::{self, McpServer};
use customizations::permissions::{self, PermissionRules, RuleBehavior};
use customizations::skills::{self, InstalledSkill, SkillListing};
use customizations::Paths;

use tauri::State;

use crate::error::{CommandResult, blocking};
use crate::sidecar;
use crate::state::AppState;

/// Skills in `~/.claude/skills`, which every chat's agent can load.
#[tauri::command]
pub async fn skills_installed() -> CommandResult<Vec<InstalledSkill>> {
    blocking(|| skills::installed(&Paths::from_env())).await
}

/// Searches skills.sh; an empty query lists popular skills.
#[tauri::command]
pub async fn skills_search(query: String) -> CommandResult<Vec<SkillListing>> {
    Ok(skills::search(&query).await?)
}

/// Installs one skill with `npx skills add`; resolves when it is on disk.
#[tauri::command]
pub async fn skills_add(source: String, skill: String) -> CommandResult<Vec<InstalledSkill>> {
    skills::add(&sidecar::npx(), &source, &skill).await?;
    skills_installed().await
}

#[tauri::command]
pub async fn skills_remove(id: String) -> CommandResult<Vec<InstalledSkill>> {
    skills::remove(&sidecar::npx(), &id).await?;
    skills_installed().await
}

/// User-scope MCP servers from `~/.claude.json`.
#[tauri::command]
pub async fn mcp_list() -> CommandResult<Vec<McpServer>> {
    blocking(|| mcp::list(&Paths::from_env().claude_json)).await
}

#[tauri::command]
pub async fn mcp_add(name: String, config: serde_json::Value) -> CommandResult<Vec<McpServer>> {
    blocking(move || mcp::add(&Paths::from_env().claude_json, &name, config)).await
}

#[tauri::command]
pub async fn mcp_remove(name: String) -> CommandResult<Vec<McpServer>> {
    blocking(move || mcp::remove(&Paths::from_env().claude_json, &name)).await
}

/// Tool permission rules from `~/.claude/settings.json`.
#[tauri::command]
pub async fn tools_rules() -> CommandResult<PermissionRules> {
    blocking(|| permissions::list(&Paths::from_env().settings_json())).await
}

/// Moves `rules` to `behavior`'s list; `None` removes them so the default applies.
#[tauri::command]
pub async fn tools_set(rules: Vec<String>, behavior: Option<RuleBehavior>) -> CommandResult<PermissionRules> {
    blocking(move || permissions::set(&Paths::from_env().settings_json(), &rules, behavior)).await
}

/// The `CLAUDE.md` files every chat in the open folder reads, missing ones included.
#[tauri::command]
pub async fn instructions_list(state: State<'_, AppState>) -> CommandResult<Vec<InstructionFile>> {
    let root = state.workspace().map(|w| w.root().to_path_buf());
    blocking(move || instructions::list(&Paths::from_env(), root.as_deref())).await
}

/// Writes one file; `expected` is what the editor started from (`None` for a new file).
#[tauri::command]
pub async fn instructions_save(
    state: State<'_, AppState>,
    path: String,
    content: String,
    expected: Option<String>,
) -> CommandResult<Vec<InstructionFile>> {
    let root = state.workspace().map(|w| w.root().to_path_buf());
    blocking(move || {
        instructions::save(&Paths::from_env(), root.as_deref(), &path, &content, expected.as_deref())
    })
    .await
}

#[tauri::command]
pub async fn instructions_delete(
    state: State<'_, AppState>,
    path: String,
    expected: String,
) -> CommandResult<Vec<InstructionFile>> {
    let root = state.workspace().map(|w| w.root().to_path_buf());
    blocking(move || instructions::delete(&Paths::from_env(), root.as_deref(), &path, &expected)).await
}
