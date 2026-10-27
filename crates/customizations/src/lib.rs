//! The customizations the agent picks up from Claude's own config: skills in
//! `~/.claude/skills`, MCP servers in `~/.claude.json`, tool permission rules
//! in `~/.claude/settings.json`, and the `CLAUDE.md` instructions it reads in
//! every chat.
//!
//! Skills are installed and removed through the `skills` CLI (`npx skills`),
//! so its lock file stays the record of where each one came from; the
//! registry at skills.sh is searched directly. MCP servers are written to the
//! user scope of `~/.claude.json`, the same place `claude mcp add -s user` uses.

pub mod instructions;
mod json_file;
pub mod mcp;
pub mod permissions;
pub mod skills;

use std::path::PathBuf;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Invalid(String),
    #[error("Couldn't read {path}: {source}")]
    Config { path: String, source: serde_json::Error },
    #[error("Couldn't reach skills.sh: {0}")]
    Registry(#[from] reqwest::Error),
    #[error("{0}")]
    Cli(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// Where Claude's config and the `skills` CLI's lock file live, honouring
/// `CLAUDE_CONFIG_DIR` and `XDG_STATE_HOME` as those tools do.
#[derive(Debug, Clone)]
pub struct Paths {
    /// Holds `skills/`, one folder per skill.
    pub claude_dir: PathBuf,
    /// Holds the user-scope `mcpServers`.
    pub claude_json: PathBuf,
    /// The `skills` CLI's record of each install's source.
    pub skill_lock: PathBuf,
}

impl Paths {
    pub fn from_env() -> Self {
        let home = std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        let config_dir = std::env::var_os("CLAUDE_CONFIG_DIR").map(PathBuf::from);
        let skill_lock = match std::env::var_os("XDG_STATE_HOME") {
            Some(state) => PathBuf::from(state).join("skills/.skill-lock.json"),
            None => home.join(".agents/.skill-lock.json"),
        };
        Self {
            claude_dir: config_dir.clone().unwrap_or_else(|| home.join(".claude")),
            claude_json: config_dir.unwrap_or_else(|| home.clone()).join(".claude.json"),
            skill_lock,
        }
    }

    pub fn skills_dir(&self) -> PathBuf {
        self.claude_dir.join("skills")
    }

    /// Holds the user-scope `permissions` rules.
    pub fn settings_json(&self) -> PathBuf {
        self.claude_dir.join("settings.json")
    }
}
