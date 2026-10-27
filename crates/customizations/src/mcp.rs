//! MCP servers in the user scope of `~/.claude.json` (its top-level
//! `mcpServers`), which every chat's agent loads.

use std::path::Path;

use serde::Serialize;
use serde_json::{Map, Value};
use ts_rs::TS;

use crate::json_file::{read, write};
use crate::{Error, Result};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum McpTransport {
    Stdio,
    Http,
    Sse,
}

/// One configured server, summarised for the list.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct McpServer {
    pub name: String,
    pub transport: McpTransport,
    /// The URL, or the command line that starts it.
    pub target: String,
}

/// User-scope servers, in the order the file lists them.
pub fn list(claude_json: &Path) -> Result<Vec<McpServer>> {
    let root = read(claude_json)?;
    let Some(Value::Object(servers)) = root.get("mcpServers") else { return Ok(Vec::new()) };
    Ok(servers.iter().filter_map(|(name, config)| summarise(name, config)).collect())
}

/// Adds or replaces the server `name` with `config`, e.g.
/// `{"type": "http", "url": "…"}` or `{"command": "npx", "args": [...]}`.
pub fn add(claude_json: &Path, name: &str, config: Value) -> Result<Vec<McpServer>> {
    check_name(name)?;
    if summarise(name, &config).is_none() {
        return Err(Error::Invalid("A server needs a url, or a command to start it".into()));
    }
    let mut root = read(claude_json)?;
    let servers = root.entry("mcpServers").or_insert_with(|| Value::Object(Map::new()));
    let Value::Object(servers) = servers else {
        return Err(Error::Invalid(format!("mcpServers in {} isn't an object", claude_json.display())));
    };
    servers.insert(name.to_string(), config);
    write(claude_json, &root)?;
    list(claude_json)
}

/// Removes the server `name`; removing one that isn't there is not an error.
pub fn remove(claude_json: &Path, name: &str) -> Result<Vec<McpServer>> {
    let mut root = read(claude_json)?;
    if let Some(Value::Object(servers)) = root.get_mut("mcpServers")
        && servers.shift_remove(name).is_some()
    {
        write(claude_json, &root)?;
    }
    list(claude_json)
}

fn summarise(name: &str, config: &Value) -> Option<McpServer> {
    let text = |key: &str| config.get(key).and_then(Value::as_str);
    let transport = match text("type") {
        Some("http") => McpTransport::Http,
        Some("sse") => McpTransport::Sse,
        Some("stdio") | None if text("command").is_some() => McpTransport::Stdio,
        _ => return None,
    };
    let target = match transport {
        McpTransport::Stdio => {
            let args = config.get("args").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str);
            std::iter::once(text("command")?).chain(args).collect::<Vec<_>>().join(" ")
        }
        _ => text("url")?.to_string(),
    };
    Some(McpServer { name: name.to_string(), transport, target })
}

fn check_name(name: &str) -> Result<()> {
    let valid = !name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c));
    if valid {
        Ok(())
    } else {
        Err(Error::Invalid("Server names use letters, numbers, dots, dashes and underscores".into()))
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn adds_and_removes_servers_keeping_everything_else() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, r#"{"numStartups": 3, "mcpServers": {"basecamp": {"type": "http", "url": "https://mcp.basecamp.com/mcp"}}, "projects": {}}"#).unwrap();

        let servers = add(&path, "memory", json!({"command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"]})).unwrap();
        assert_eq!(
            servers,
            [
                McpServer { name: "basecamp".into(), transport: McpTransport::Http, target: "https://mcp.basecamp.com/mcp".into() },
                McpServer { name: "memory".into(), transport: McpTransport::Stdio, target: "npx -y @modelcontextprotocol/server-memory".into() },
            ]
        );

        let saved: Value = serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        let keys: Vec<_> = saved.as_object().unwrap().keys().cloned().collect();
        assert_eq!(keys, ["numStartups", "mcpServers", "projects"]);
        assert_eq!(saved["numStartups"], 3);

        let servers = remove(&path, "basecamp").unwrap();
        assert_eq!(servers.len(), 1);
        assert_eq!(servers[0].name, "memory");
    }

    #[test]
    fn a_missing_file_has_no_servers_and_is_created_on_add() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        assert!(list(&path).unwrap().is_empty());
        add(&path, "context7", json!({"type": "http", "url": "https://mcp.context7.com/mcp"})).unwrap();
        assert_eq!(list(&path).unwrap().len(), 1);
    }

    #[test]
    fn refuses_bad_names_and_configs_without_a_target() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        assert!(add(&path, "bad name", json!({"type": "http", "url": "https://x"})).is_err());
        assert!(add(&path, "empty", json!({"type": "http"})).is_err());
        assert!(!path.exists());
    }

    #[test]
    fn an_unreadable_file_is_an_error_not_an_overwrite() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(".claude.json");
        std::fs::write(&path, "{ not json").unwrap();
        assert!(add(&path, "memory", json!({"command": "npx"})).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{ not json");
    }
}
