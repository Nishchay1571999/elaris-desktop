//! Language servers for the desktop app's code views.
//!
//! Elaris finds servers the way the user's Neovim does: a server enabled in
//! their Lua config (`vim.lsp.config` / `vim.lsp.enable`) wins, with its
//! command and settings; otherwise a built-in server from [`servers::SERVERS`]
//! is looked up in Mason's bin folders and then on the PATH. A missing server
//! can be installed through Mason ([`CodeIntelligence::install`]).
//!
//! Servers run one per (server, project root) and stay up until the
//! workspace changes. Today they are asked for one thing: semantic tokens,
//! which the UI lays over its own quick highlighting.

mod nvim;
mod rpc;
pub mod servers;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{Value, json};
use tokio::sync::OnceCell;
use ts_rs::TS;

use crate::nvim::Environment;
use crate::rpc::{Answers, Connection, RequestError};
use crate::servers::ServerSpec;

const INITIALIZE_TIMEOUT: Duration = Duration::from_secs(60);
const TOKENS_TIMEOUT: Duration = Duration::from_secs(30);

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Neovim isn't installed, and Elaris installs language servers through Neovim's Mason")]
    NoNeovim,
    #[error("No language server is known for this file")]
    Unsupported,
    #[error("{0}")]
    Install(String),
    #[error("{0}")]
    Server(String),
    #[error("The language server didn't answer in time")]
    Timeout,
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ServerState {
    /// No server is known for this kind of file.
    Unsupported,
    /// A server is known but not installed.
    Missing,
    Installing,
    /// Installed, not started yet.
    Available,
    Running,
    /// Running, but sends no semantic tokens.
    NoColors,
    Failed,
}

/// Where the server's command came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ServerSource {
    /// The user's Neovim Lua config.
    Neovim,
    /// A Mason install, the user's or Elaris's.
    Mason,
    Path,
}

#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ServerStatus {
    /// The Neovim filetype, e.g. `typescriptreact`.
    pub language: Option<String>,
    /// The server's program name, e.g. `rust-analyzer`.
    pub server: Option<String>,
    pub state: ServerState,
    pub source: Option<ServerSource>,
    /// The Mason package that would install the server.
    pub package: Option<String>,
    /// Neovim is there to run Mason.
    pub can_install: bool,
    /// The server is still loading or indexing; its colours may be partial.
    pub busy: bool,
    /// Why it failed.
    pub message: Option<String>,
}

/// LSP semantic tokens, still encoded: five numbers per token (line delta,
/// start delta, length, type index, modifier bits), positions in UTF-16.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct SemanticTokens {
    pub types: Vec<String>,
    pub modifiers: Vec<String>,
    pub data: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, TS)]
#[ts(export)]
pub struct Highlights {
    pub status: ServerStatus,
    pub tokens: Option<SemanticTokens>,
}

/// The server chosen for a file.
struct Choice {
    name: String,
    label: String,
    language: &'static str,
    program: Option<PathBuf>,
    args: Vec<String>,
    settings: Value,
    init_options: Value,
    package: Option<&'static str>,
    root_markers: Vec<String>,
    outermost_root: bool,
    source: ServerSource,
}

type Key = (String, PathBuf);

pub struct CodeIntelligence {
    data_dir: PathBuf,
    env: OnceCell<Environment>,
    clients: Mutex<HashMap<Key, Arc<OnceCell<Arc<Client>>>>>,
    /// Servers that failed to start, with why; cleared by an install or a reset.
    failed: Mutex<HashMap<Key, String>>,
    /// Mason packages being installed.
    installing: Mutex<Vec<String>>,
}

impl CodeIntelligence {
    /// `data_dir` holds Elaris's own mason.nvim and its installs.
    pub fn new(data_dir: impl Into<PathBuf>) -> Self {
        Self {
            data_dir: data_dir.into(),
            env: OnceCell::new(),
            clients: Mutex::default(),
            failed: Mutex::default(),
            installing: Mutex::default(),
        }
    }

    /// Stops every server, e.g. when another folder opens.
    pub fn reset(&self) {
        self.clients.lock().unwrap().clear();
        self.failed.lock().unwrap().clear();
    }

    async fn env(&self) -> &Environment {
        self.env.get_or_init(|| Environment::discover(self.data_dir.clone())).await
    }

    pub async fn status(&self, workspace: &Path, file: &Path) -> ServerStatus {
        let Some(language) = servers::filetype(file) else { return unsupported(None) };
        let Some(choice) = self.choose(language).await else { return unsupported(Some(language)) };
        let root = servers::find_root(workspace, file, &choice.root_markers, choice.outermost_root);
        self.status_of(&choice, &(choice.name.clone(), root))
    }

    /// Colours for `text`, the current contents of `file`. Starts the file's
    /// server if needed; `tokens` is `None` when there is no server to ask.
    pub async fn highlights(&self, workspace: &Path, file: &Path, text: &str) -> Highlights {
        let Some(language) = servers::filetype(file) else { return no_tokens(unsupported(None)) };
        let Some(choice) = self.choose(language).await else { return no_tokens(unsupported(Some(language))) };
        let root = servers::find_root(workspace, file, &choice.root_markers, choice.outermost_root);
        let key = (choice.name.clone(), root.clone());
        if choice.program.is_none() || self.failed.lock().unwrap().contains_key(&key) {
            return no_tokens(self.status_of(&choice, &key));
        }

        let tokens = match self.client(&choice, &key).await {
            Ok(client) => client.semantic_tokens(file, language, text).await,
            Err(error) => Err(error),
        };
        match tokens {
            Ok(tokens) => Highlights { status: self.status_of(&choice, &key), tokens },
            Err(error) => {
                // A server that answered once and then stalled is still usable next time.
                if !matches!(error, Error::Timeout) {
                    self.failed.lock().unwrap().insert(key.clone(), error.to_string());
                    self.clients.lock().unwrap().remove(&key);
                }
                let mut status = self.status_of(&choice, &key);
                status.message.get_or_insert_with(|| error.to_string());
                no_tokens(status)
            }
        }
    }

    /// Installs the server for `file` through Mason and reports its new status.
    pub async fn install(&self, workspace: &Path, file: &Path) -> Result<ServerStatus> {
        let language = servers::filetype(file).ok_or(Error::Unsupported)?;
        let spec = servers::spec_for(language).ok_or(Error::Unsupported)?;
        let env = self.env().await;
        {
            let mut installing = self.installing.lock().unwrap();
            if installing.iter().any(|p| p == spec.mason) {
                return Err(Error::Install(format!("{} is already being installed", spec.label)));
            }
            installing.push(spec.mason.to_owned());
        }
        let result = env.install(spec.mason).await;
        self.installing.lock().unwrap().retain(|p| p != spec.mason);
        result?;

        if env.resolve(spec.command).is_none() {
            return Err(Error::Install(format!(
                "Mason finished, but {} still isn't in its bin folder. Try :MasonInstall {} in Neovim.",
                spec.command, spec.mason
            )));
        }
        self.failed.lock().unwrap().retain(|(name, _), _| name != spec.name);
        Ok(self.status(workspace, file).await)
    }

    async fn choose(&self, language: &'static str) -> Option<Choice> {
        let env = self.env().await;

        // A server the user's Neovim enables for this filetype.
        let enabled = env.servers.iter().filter(|s| s.enabled && s.filetypes.iter().any(|f| f == language));
        for server in enabled {
            let Some(command) = server.command() else { continue };
            let Some(program) = env.resolve(&command[0]) else { continue };
            let spec = servers::SERVERS.iter().find(|s| s.name == server.name);
            return Some(Choice {
                name: server.name.clone(),
                label: label_of(&command[0]),
                language,
                program: Some(program),
                args: command[1..].to_vec(),
                settings: non_empty(&server.settings).unwrap_or_else(|| spec.map_or(Value::Null, |s| (s.settings)())),
                init_options: non_empty(&server.init_options).unwrap_or(Value::Null),
                package: spec.map(|s| s.mason),
                root_markers: if server.root_markers.is_empty() {
                    spec.map(markers).unwrap_or_default()
                } else {
                    server.root_markers.clone()
                },
                outermost_root: spec.is_some_and(|s| s.outermost_root),
                source: ServerSource::Neovim,
            });
        }

        // A built-in server, with the user's command and settings for it if their config has any.
        let spec = servers::spec_for(language)?;
        let user = env.servers.iter().find(|s| s.name == spec.name);
        let (program, args, source) = match user.and_then(|u| u.command()) {
            Some(command) if env.resolve(&command[0]).is_some() => {
                (env.resolve(&command[0]), command[1..].to_vec(), ServerSource::Neovim)
            }
            _ => {
                let program = env.resolve(spec.command);
                let in_mason = program.as_deref().is_some_and(|p| p.components().any(|c| c.as_os_str() == "mason"));
                let source = if in_mason { ServerSource::Mason } else { ServerSource::Path };
                (program, spec.args.iter().map(|a| a.to_string()).collect(), source)
            }
        };
        Some(Choice {
            name: spec.name.to_owned(),
            label: spec.label.to_owned(),
            language,
            program,
            args,
            settings: user.and_then(|u| non_empty(&u.settings)).unwrap_or_else(spec.settings),
            init_options: user.and_then(|u| non_empty(&u.init_options)).unwrap_or(Value::Null),
            package: Some(spec.mason),
            root_markers: markers(spec),
            outermost_root: spec.outermost_root,
            source,
        })
    }

    fn status_of(&self, choice: &Choice, key: &Key) -> ServerStatus {
        let can_install = self.env.get().is_some_and(|env| env.nvim.is_some());
        let installing = choice.package.is_some_and(|p| self.installing.lock().unwrap().iter().any(|i| i == p));
        let failed = self.failed.lock().unwrap().get(key).cloned();
        let client = self.clients.lock().unwrap().get(key).and_then(|cell| cell.get().cloned());

        let state = if installing {
            ServerState::Installing
        } else if choice.program.is_none() {
            ServerState::Missing
        } else if failed.is_some() {
            ServerState::Failed
        } else if let Some(client) = &client {
            if client.legend.is_some() { ServerState::Running } else { ServerState::NoColors }
        } else {
            ServerState::Available
        };
        ServerStatus {
            language: Some(choice.language.to_owned()),
            server: Some(choice.label.clone()),
            state,
            source: choice.program.is_some().then_some(choice.source),
            package: choice.package.map(str::to_owned),
            can_install,
            busy: client.is_some_and(|c| c.conn.is_busy()),
            message: failed,
        }
    }

    /// The running client for `key`, started on first use. A server that
    /// exited is started again.
    async fn client(&self, choice: &Choice, key: &Key) -> Result<Arc<Client>> {
        let cell = {
            let mut clients = self.clients.lock().unwrap();
            if clients.get(key).and_then(|c| c.get()).is_some_and(|c| c.conn.is_closed()) {
                clients.remove(key);
            }
            clients.entry(key.clone()).or_default().clone()
        };
        let env = self.env().await;
        cell.get_or_try_init(|| Client::start(env, choice, &key.1)).await.cloned()
    }
}

fn markers(spec: &ServerSpec) -> Vec<String> {
    spec.root_markers.iter().map(|m| m.to_string()).collect()
}

fn label_of(program: &str) -> String {
    Path::new(program).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| program.to_owned())
}

/// Lua's empty table arrives as `[]`; treat it, and null, as unset.
fn non_empty(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Array(a) if a.is_empty() => None,
        Value::Object(o) if o.is_empty() => None,
        other => Some(other.clone()),
    }
}

fn unsupported(language: Option<&str>) -> ServerStatus {
    ServerStatus {
        language: language.map(str::to_owned),
        server: None,
        state: ServerState::Unsupported,
        source: None,
        package: None,
        can_install: false,
        busy: false,
        message: None,
    }
}

fn no_tokens(status: ServerStatus) -> Highlights {
    Highlights { status, tokens: None }
}

struct Legend {
    types: Vec<String>,
    modifiers: Vec<String>,
}

/// One running server.
struct Client {
    conn: Connection,
    /// `None` when the server has no semantic tokens.
    legend: Option<Legend>,
    /// Open documents: uri → (version, text last sent).
    documents: tokio::sync::Mutex<HashMap<String, (i64, String)>>,
}

impl Client {
    async fn start(env: &Environment, choice: &Choice, root: &Path) -> Result<Arc<Self>> {
        let program = choice.program.as_ref().ok_or(Error::Unsupported)?;
        let root_uri = file_uri(root);
        let folders = json!([{ "uri": root_uri, "name": root.file_name().map(|n| n.to_string_lossy()).unwrap_or_default() }]);
        let conn = Connection::spawn(
            program,
            &choice.args,
            root,
            &env.path_env(),
            Answers { settings: choice.settings.clone(), folders: folders.clone() },
        )
        .map_err(|e| Error::Server(format!("Couldn't start {}: {e}", choice.label)))?;

        let params = json!({
            "processId": std::process::id(),
            "clientInfo": { "name": "Elaris" },
            "rootUri": root_uri,
            "rootPath": root.display().to_string(),
            "workspaceFolders": folders,
            "initializationOptions": choice.init_options,
            "capabilities": capabilities(),
        });
        let result = match conn.request("initialize", params, INITIALIZE_TIMEOUT).await {
            Ok(result) => result,
            Err(error) => {
                // Give stderr a moment to arrive: it usually says why.
                tokio::time::sleep(Duration::from_millis(150)).await;
                let tail = conn.stderr_tail();
                let reason = if tail.is_empty() { error.to_string() } else { tail };
                return Err(Error::Server(format!("{} didn't start: {reason}", choice.label)));
            }
        };
        conn.notify("initialized", json!({}));
        if !choice.settings.is_null() {
            conn.notify("workspace/didChangeConfiguration", json!({ "settings": choice.settings }));
        }

        let legend = result.pointer("/capabilities/semanticTokensProvider/legend").map(|legend| Legend {
            types: strings(legend.get("tokenTypes")),
            modifiers: strings(legend.get("tokenModifiers")),
        });
        Ok(Arc::new(Self { conn, legend, documents: Default::default() }))
    }

    async fn semantic_tokens(&self, file: &Path, language: &str, text: &str) -> Result<Option<SemanticTokens>> {
        let Some(legend) = &self.legend else { return Ok(None) };
        let uri = file_uri(file);
        self.sync(&uri, language, text).await;

        // Servers that are still loading cancel or reject the request; give them a moment.
        let mut attempt = 0;
        let result = loop {
            let params = json!({ "textDocument": { "uri": uri } });
            match self.conn.request("textDocument/semanticTokens/full", params, TOKENS_TIMEOUT).await {
                Ok(result) => break result,
                Err(RequestError::Response { code, .. })
                    if (code == rpc::CONTENT_MODIFIED || code == rpc::SERVER_CANCELLED) && attempt < 5 =>
                {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(400 * attempt)).await;
                }
                Err(RequestError::Timeout) => return Err(Error::Timeout),
                Err(error) => return Err(Error::Server(error.to_string())),
            }
        };
        let Some(data) = result.get("data").and_then(Value::as_array) else { return Ok(None) };
        Ok(Some(SemanticTokens {
            types: legend.types.clone(),
            modifiers: legend.modifiers.clone(),
            data: data.iter().filter_map(|n| n.as_u64().map(|n| n as u32)).collect(),
        }))
    }

    /// Opens the document, or sends its new text if it changed.
    async fn sync(&self, uri: &str, language: &str, text: &str) {
        let mut documents = self.documents.lock().await;
        match documents.get_mut(uri) {
            Some((_, sent)) if sent == text => {}
            Some((version, sent)) => {
                *version += 1;
                *sent = text.to_owned();
                self.conn.notify(
                    "textDocument/didChange",
                    json!({
                        "textDocument": { "uri": uri, "version": *version },
                        "contentChanges": [{ "text": text }],
                    }),
                );
            }
            None => {
                self.conn.notify(
                    "textDocument/didOpen",
                    json!({ "textDocument": { "uri": uri, "languageId": language, "version": 1, "text": text } }),
                );
                documents.insert(uri.to_owned(), (1, text.to_owned()));
            }
        }
    }
}

fn capabilities() -> Value {
    json!({
        "general": { "positionEncodings": ["utf-16"] },
        "window": { "workDoneProgress": true },
        "workspace": { "configuration": true, "workspaceFolders": true },
        "textDocument": {
            "synchronization": { "dynamicRegistration": false, "didSave": false },
            "semanticTokens": {
                "dynamicRegistration": false,
                "requests": { "full": true, "range": false },
                "tokenTypes": [
                    "namespace", "type", "class", "enum", "interface", "struct", "typeParameter", "parameter",
                    "variable", "property", "enumMember", "event", "function", "method", "macro", "keyword",
                    "modifier", "comment", "string", "number", "regexp", "operator", "decorator",
                ],
                "tokenModifiers": [
                    "declaration", "definition", "readonly", "static", "deprecated", "abstract", "async",
                    "modification", "documentation", "defaultLibrary",
                ],
                "formats": ["relative"],
                "overlappingTokenSupport": false,
                "multilineTokenSupport": false,
                "augmentsSyntaxTokens": true,
            },
        },
    })
}

fn strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|a| a.iter().map(|v| v.as_str().unwrap_or_default().to_owned()).collect())
        .unwrap_or_default()
}

/// A `file://` URI with everything but unreserved characters and `/` escaped.
fn file_uri(path: &Path) -> String {
    let mut uri = String::from("file://");
    for byte in path.to_string_lossy().bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => uri.push(byte as char),
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uris_escape_spaces_and_unicode() {
        assert_eq!(file_uri(Path::new("/a b/ç.rs")), "file:///a%20b/%C3%A7.rs");
    }

    #[test]
    fn empty_lua_tables_are_unset() {
        assert_eq!(non_empty(&json!([])), None);
        assert_eq!(non_empty(&json!({ "a": 1 })), Some(json!({ "a": 1 })));
    }
}
