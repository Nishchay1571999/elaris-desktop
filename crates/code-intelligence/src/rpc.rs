//! JSON-RPC 2.0 over a language server's stdio, with LSP's `Content-Length`
//! framing. Just enough of a client for what Elaris asks: requests with
//! timeouts, notifications, answers to the few requests servers send back,
//! and whether the server is still busy with work-done progress.

use std::collections::{HashMap, HashSet, VecDeque};
use std::ffi::OsStr;
use std::io;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStderr, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot};

/// The document changed while the server was answering; ask again.
pub const CONTENT_MODIFIED: i64 = -32801;
/// The server gave up on the request (rust-analyzer does this while loading).
pub const SERVER_CANCELLED: i64 = -32802;

#[derive(Debug, Clone)]
pub enum RequestError {
    /// The server answered with an error.
    Response { code: i64, message: String },
    Timeout,
    /// The server exited or closed its output.
    Closed,
}

impl std::fmt::Display for RequestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Response { message, .. } => f.write_str(message),
            Self::Timeout => f.write_str("the language server didn't answer in time"),
            Self::Closed => f.write_str("the language server exited"),
        }
    }
}

/// What the client answers when the server asks: settings for
/// `workspace/configuration`, folders for `workspace/workspaceFolders`.
pub struct Answers {
    pub settings: Value,
    pub folders: Value,
}

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, RequestError>>>>>;

pub struct Connection {
    _child: Child,
    outgoing: mpsc::UnboundedSender<Value>,
    pending: Pending,
    next_id: AtomicI64,
    closed: Arc<AtomicBool>,
    /// Work-done progress tokens begun and not yet ended.
    progress: Arc<Mutex<HashSet<String>>>,
    /// The last lines the server wrote to stderr, to explain a crash.
    stderr: Arc<Mutex<VecDeque<String>>>,
}

impl Connection {
    /// Starts `program` with `path_env` as its PATH. Must be called inside a
    /// Tokio runtime; the server is killed when the connection drops.
    pub fn spawn(program: &Path, args: &[String], cwd: &Path, path_env: &OsStr, answers: Answers) -> io::Result<Self> {
        let mut child = Command::new(program)
            .args(args)
            .current_dir(cwd)
            .env("PATH", path_env)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()?;
        let stdin = child.stdin.take().expect("stdin is piped");
        let stdout = child.stdout.take().expect("stdout is piped");
        let stderr_pipe = child.stderr.take().expect("stderr is piped");

        let (outgoing, queue) = mpsc::unbounded_channel();
        let pending = Pending::default();
        let closed = Arc::new(AtomicBool::new(false));
        let progress = Arc::new(Mutex::new(HashSet::new()));
        let stderr = Arc::new(Mutex::new(VecDeque::new()));
        tokio::spawn(write_loop(stdin, queue));
        tokio::spawn(stderr_loop(stderr_pipe, stderr.clone()));
        tokio::spawn(read_loop(
            BufReader::new(stdout),
            Reader { pending: pending.clone(), outgoing: outgoing.clone(), closed: closed.clone(), progress: progress.clone(), answers },
        ));

        Ok(Self { _child: child, outgoing, pending, next_id: AtomicI64::new(1), closed, progress, stderr })
    }

    pub fn is_closed(&self) -> bool {
        self.closed.load(Ordering::Relaxed)
    }

    /// True while the server reports work in progress (indexing, loading a workspace).
    pub fn is_busy(&self) -> bool {
        !self.progress.lock().unwrap().is_empty()
    }

    /// The last few lines of the server's stderr, joined.
    pub fn stderr_tail(&self) -> String {
        let lines = self.stderr.lock().unwrap();
        let skip = lines.len().saturating_sub(3);
        lines.iter().skip(skip).map(String::as_str).collect::<Vec<_>>().join(" ")
    }

    pub async fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, RequestError> {
        if self.is_closed() {
            return Err(RequestError::Closed);
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = oneshot::channel();
        self.pending.lock().unwrap().insert(id, tx);
        let message = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        if self.outgoing.send(message).is_err() {
            self.pending.lock().unwrap().remove(&id);
            return Err(RequestError::Closed);
        }
        match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err(RequestError::Closed),
            Err(_) => {
                self.pending.lock().unwrap().remove(&id);
                self.notify("$/cancelRequest", json!({ "id": id }));
                Err(RequestError::Timeout)
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.outgoing.send(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }
}

async fn write_loop(mut stdin: ChildStdin, mut queue: mpsc::UnboundedReceiver<Value>) {
    while let Some(message) = queue.recv().await {
        let body = message.to_string();
        let frame = format!("Content-Length: {}\r\n\r\n{body}", body.len());
        if stdin.write_all(frame.as_bytes()).await.is_err() || stdin.flush().await.is_err() {
            break;
        }
    }
}

/// Servers log freely to stderr; it's drained so the pipe never fills, and
/// the tail is kept.
async fn stderr_loop(stderr: ChildStderr, tail: Arc<Mutex<VecDeque<String>>>) {
    let mut lines = BufReader::new(stderr).lines();
    while let Ok(Some(line)) = lines.next_line().await {
        if line.trim().is_empty() {
            continue;
        }
        let mut tail = tail.lock().unwrap();
        if tail.len() == 20 {
            tail.pop_front();
        }
        tail.push_back(line.chars().take(300).collect());
    }
}

struct Reader {
    pending: Pending,
    outgoing: mpsc::UnboundedSender<Value>,
    closed: Arc<AtomicBool>,
    progress: Arc<Mutex<HashSet<String>>>,
    answers: Answers,
}

async fn read_loop(mut stdout: BufReader<ChildStdout>, reader: Reader) {
    while let Ok(Some(message)) = read_message(&mut stdout).await {
        reader.dispatch(message);
    }
    reader.closed.store(true, Ordering::Relaxed);
    for (_, waiter) in reader.pending.lock().unwrap().drain() {
        let _ = waiter.send(Err(RequestError::Closed));
    }
}

impl Reader {
    fn dispatch(&self, message: Value) {
        let method = message.get("method").and_then(Value::as_str);
        let id = message.get("id").cloned();
        match (method, id) {
            // A response to one of our requests.
            (None, Some(id)) => {
                let Some(id) = id.as_i64() else { return };
                let Some(waiter) = self.pending.lock().unwrap().remove(&id) else { return };
                let result = match message.get("error") {
                    Some(error) => Err(RequestError::Response {
                        code: error.get("code").and_then(Value::as_i64).unwrap_or(0),
                        message: error.get("message").and_then(Value::as_str).unwrap_or("request failed").to_owned(),
                    }),
                    None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                };
                let _ = waiter.send(result);
            }
            // A request from the server; every one gets an answer so it never waits on us.
            (Some(method), Some(id)) => {
                let params = message.get("params").cloned().unwrap_or(Value::Null);
                let result = match method {
                    "workspace/configuration" => self.configuration(&params),
                    "workspace/workspaceFolders" => self.answers.folders.clone(),
                    _ => Value::Null,
                };
                let _ = self.outgoing.send(json!({ "jsonrpc": "2.0", "id": id, "result": result }));
            }
            (Some("$/progress"), None) => {
                let params = message.get("params");
                let token = params.and_then(|p| p.get("token")).map(|t| t.to_string());
                let kind = params.and_then(|p| p.pointer("/value/kind")).and_then(Value::as_str);
                if let Some(token) = token {
                    let mut progress = self.progress.lock().unwrap();
                    match kind {
                        Some("begin") => {
                            progress.insert(token);
                        }
                        Some("end") => {
                            progress.remove(&token);
                        }
                        _ => {}
                    }
                }
            }
            _ => {}
        }
    }

    /// One value per requested item: the settings under its dotted `section`,
    /// as Neovim's `vim.lsp` answers it.
    fn configuration(&self, params: &Value) -> Value {
        let items = params.get("items").and_then(Value::as_array).cloned().unwrap_or_default();
        let values = items
            .iter()
            .map(|item| match item.get("section").and_then(Value::as_str) {
                Some(section) if !section.is_empty() => section
                    .split('.')
                    .try_fold(&self.answers.settings, |value, key| value.get(key))
                    .cloned()
                    .unwrap_or(Value::Null),
                _ => self.answers.settings.clone(),
            })
            .collect();
        Value::Array(values)
    }
}

/// The next framed message, `Ok(None)` at end of stream. A frame without a
/// length is skipped as `Value::Null`.
async fn read_message(stdout: &mut BufReader<ChildStdout>) -> io::Result<Option<Value>> {
    let mut length = None;
    loop {
        let mut line = String::new();
        if stdout.read_line(&mut line).await? == 0 {
            return Ok(None);
        }
        let line = line.trim_end();
        if line.is_empty() {
            break;
        }
        if let Some((name, value)) = line.split_once(':')
            && name.eq_ignore_ascii_case("content-length")
        {
            length = value.trim().parse::<usize>().ok();
        }
    }
    let Some(length) = length else { return Ok(Some(Value::Null)) };
    let mut body = vec![0; length];
    stdout.read_exact(&mut body).await?;
    Ok(Some(serde_json::from_slice(&body).unwrap_or(Value::Null)))
}
