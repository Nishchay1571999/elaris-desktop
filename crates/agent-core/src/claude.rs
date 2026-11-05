//! Host side of the sidecar protocol defined in
//! `apps/desktop/sidecar/src/protocol.ts`: one JSON object per line each way.
//! One sidecar process serves every chat; replies are routed by `runId`.

use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agent_protocol::{
    AgentEvent, AgentMode, AgentRequest, Answers, PermissionDecision, PermissionPolicy, PromptImage, SessionSettings,
    TokenUsage,
};
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use crate::RunOutcome;

/// How to start the sidecar, e.g. `node path/to/sidecar/dist/main.js`.
#[derive(Debug, Clone)]
pub struct SidecarCommand {
    pub program: PathBuf,
    pub args: Vec<String>,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum HostCommand<'a> {
    Run {
        run_id: &'a str,
        prompt: &'a str,
        cwd: String,
        model: &'a str,
        mode: AgentMode,
        permissions: PermissionPolicy,
        resume: Option<&'a str>,
        allowed_tools: &'a [String],
        images: &'a [PromptImage],
    },
    Interrupt {
        run_id: &'a str,
    },
    /// The user changed the chat's mode, model or permissions mid-run.
    Settings {
        run_id: &'a str,
        mode: AgentMode,
        model: &'a str,
        permissions: PermissionPolicy,
    },
    Permission {
        run_id: &'a str,
        request_id: &'a str,
        decision: PermissionDecision,
    },
    Answer {
        run_id: &'a str,
        request_id: &'a str,
        /// `None` when the user skipped the question.
        answers: Option<&'a Answers>,
    },
    /// Asks for the tokens an agent session has used; `run_id` routes the reply.
    Usage {
        run_id: &'a str,
        agent_session_id: &'a str,
    },
    /// Answers a `terminal` request: the text the agent's tool call returns.
    TerminalResult {
        run_id: &'a str,
        request_id: &'a str,
        ok: bool,
        text: &'a str,
    },
    /// Answers a `desktop` request: the text, and screenshot, the agent's tool call returns.
    DesktopResult {
        run_id: &'a str,
        request_id: &'a str,
        ok: bool,
        text: &'a str,
        image: Option<&'a ResultImage>,
    },
    /// Answers a `device` request: the text, and screenshot, the agent's tool call returns.
    DeviceResult {
        run_id: &'a str,
        request_id: &'a str,
        ok: bool,
        text: &'a str,
        image: Option<&'a ResultImage>,
    },
    /// Answers a `contexts` request: the text the agent's tool call returns.
    ContextsResult {
        run_id: &'a str,
        request_id: &'a str,
        ok: bool,
        text: &'a str,
    },
}

/// An image a tool call returns to the agent, base64-encoded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResultImage {
    pub media_type: String,
    pub data: String,
}

/// A call to the agent's `terminal-access` tool, which only Elaris provides:
/// the sidecar forwards it and the host runs it in a terminal tab.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum TerminalRequest {
    /// Runs `command` in a new terminal. In the background it returns once the
    /// output settles and keeps running (dev servers, watchers); otherwise it
    /// waits for the command to finish, up to `wait_seconds`.
    Run {
        command: String,
        #[serde(default)]
        title: Option<String>,
        #[serde(default)]
        background: bool,
        #[serde(default)]
        wait_seconds: Option<u64>,
    },
    /// Output since the agent last read this terminal, waiting up to `wait_seconds` for some.
    Read {
        terminal_id: u32,
        #[serde(default)]
        wait_seconds: Option<u64>,
    },
    /// Types `input` into the terminal (`\u0003` is Ctrl+C).
    Write { terminal_id: u32, input: String },
    Stop { terminal_id: u32 },
    List,
}

/// A call to the agent's `desktop-control` tool, which only Elaris provides:
/// the host takes screenshots of the main display and moves the mouse and
/// types for the agent. Coordinates are in screenshot pixels.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum DesktopRequest {
    Screenshot,
    Click {
        x: i32,
        y: i32,
        #[serde(default)]
        button: MouseButton,
        /// 2 double-clicks, 3 triple-clicks.
        #[serde(default)]
        count: Option<u8>,
    },
    Move { x: i32, y: i32 },
    Drag { from_x: i32, from_y: i32, to_x: i32, to_y: i32 },
    Scroll {
        x: i32,
        y: i32,
        direction: ScrollDirection,
        /// Lines to scroll.
        #[serde(default)]
        amount: Option<u32>,
    },
    /// Types `text` into whatever has keyboard focus.
    Type { text: String },
    /// Presses a key combination such as `cmd+shift+t`.
    Key { keys: String },
    /// Opens an app by name or a URL.
    Open { target: String },
}

/// A call to the agent's `elaris-context` tool, which only Elaris provides:
/// the host reads the saved contexts (whole earlier sessions) the user
/// referenced with `#ctx-…`.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ContextsRequest {
    List {
        #[serde(default)]
        query: Option<String>,
    },
    /// The context's prompts in order and the tools it used.
    Overview { id: String },
    /// A page of the context from entry `from_seq`, `offset` characters in.
    Read {
        id: String,
        #[serde(default)]
        from_seq: Option<u32>,
        #[serde(default)]
        offset: Option<usize>,
        #[serde(default)]
        max_chars: Option<usize>,
    },
    /// Entries containing `query`; every context when `id` is `None`.
    Search {
        #[serde(default)]
        id: Option<String>,
        query: String,
        #[serde(default)]
        limit: Option<usize>,
    },
    /// Entry `seq` exactly as the transcript recorded it.
    Raw { id: String, seq: u32 },
    Terminals { id: String },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "camelCase", rename_all_fields = "camelCase")]
enum Reply {
    Event { run_id: String, event: AgentEvent },
    Session { run_id: String, agent_session_id: String },
    Rules { run_id: String, rules: Vec<String> },
    Done { run_id: String },
    /// `None` when the session's transcript isn't on this machine.
    Usage { run_id: String, usage: Option<TokenUsage> },
    Terminal { run_id: String, request_id: String, request: TerminalRequest },
    Desktop { run_id: String, request_id: String, request: DesktopRequest },
    Contexts { run_id: String, request_id: String, request: ContextsRequest },
    Device { run_id: String, request_id: String, request: serde_json::Value },
}

impl Reply {
    fn run_id(&self) -> &str {
        match self {
            Self::Event { run_id, .. }
            | Self::Session { run_id, .. }
            | Self::Rules { run_id, .. }
            | Self::Done { run_id }
            | Self::Usage { run_id, .. }
            | Self::Terminal { run_id, .. }
            | Self::Desktop { run_id, .. }
            | Self::Contexts { run_id, .. }
            | Self::Device { run_id, .. } => run_id,
        }
    }
}

/// Things a run reports besides its events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Notice {
    /// The agent's session id, to pass as `resume` next time.
    Session(String),
    /// Permission rules the user chose to always allow in this workspace.
    AllowRules(Vec<String>),
    /// The agent used its terminal tool; answer with [`ClaudeAgent::answer_terminal`].
    Terminal { request_id: String, request: TerminalRequest },
    /// The agent used its desktop tool; answer with [`ClaudeAgent::answer_desktop`].
    Desktop { request_id: String, request: DesktopRequest },
    /// The agent read a saved context; answer with [`ClaudeAgent::answer_contexts`].
    Contexts { request_id: String, request: ContextsRequest },
    /// The agent used its emulator and simulator tool; answer with [`ClaudeAgent::answer_device`].
    /// The request is passed through as JSON: the `device-control` crate owns its shape.
    Device { request_id: String, request: serde_json::Value },
}

type Routes = Arc<Mutex<HashMap<String, mpsc::UnboundedSender<Reply>>>>;

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    routes: Routes,
}

/// Runs prompts through the Claude Agent SDK. Cheap to clone; the sidecar
/// starts on first use and is restarted if it exits.
#[derive(Clone)]
pub struct ClaudeAgent {
    command: SidecarCommand,
    sidecar: Arc<tokio::sync::Mutex<Option<Sidecar>>>,
}

impl ClaudeAgent {
    pub fn new(command: SidecarCommand) -> Self {
        Self { command, sidecar: Arc::new(tokio::sync::Mutex::new(None)) }
    }

    /// Streams one run through `emit`, reporting the agent's session id and
    /// newly saved permission rules through `on_notice`. Cancelling `cancel`
    /// interrupts the agent; the run then ends with `stopped`.
    pub async fn run(
        &self,
        request: &AgentRequest,
        cancel: &CancellationToken,
        mut emit: impl FnMut(AgentEvent),
        mut on_notice: impl FnMut(Notice),
    ) -> RunOutcome {
        let Some(cwd) = &request.cwd else {
            emit(AgentEvent::Error { message: "Open a folder for the agent to work in.".into() });
            return RunOutcome::Failed;
        };
        let run_id = request.session_id.as_str();
        let (tx, mut rx) = mpsc::unbounded_channel();

        let started = self
            .send_with_route(
                run_id,
                tx,
                &HostCommand::Run {
                    run_id,
                    prompt: request.prompt(),
                    cwd: cwd.display().to_string(),
                    model: &request.settings.model,
                    mode: request.settings.mode,
                    permissions: request.settings.permissions,
                    resume: request.resume.as_deref(),
                    allowed_tools: &request.allowed_tools,
                    images: &request.images,
                },
            )
            .await;
        if let Err(message) = started {
            emit(AgentEvent::Error { message });
            return RunOutcome::Failed;
        }

        let mut outcome = None;
        let mut interrupted = false;
        loop {
            let reply = tokio::select! {
                _ = cancel.cancelled(), if !interrupted => {
                    interrupted = true;
                    let _ = self.send(&HostCommand::Interrupt { run_id }).await;
                    continue;
                }
                reply = rx.recv() => reply,
            };
            match reply {
                Some(Reply::Event { event, .. }) => {
                    if event.is_terminal() {
                        outcome = Some(match event {
                            AgentEvent::Finish => RunOutcome::Finished,
                            AgentEvent::Stopped => RunOutcome::Stopped,
                            _ => RunOutcome::Failed,
                        });
                    }
                    emit(event);
                }
                Some(Reply::Session { agent_session_id, .. }) => on_notice(Notice::Session(agent_session_id)),
                Some(Reply::Rules { rules, .. }) => on_notice(Notice::AllowRules(rules)),
                Some(Reply::Terminal { request_id, request, .. }) => {
                    on_notice(Notice::Terminal { request_id, request });
                }
                Some(Reply::Desktop { request_id, request, .. }) => {
                    on_notice(Notice::Desktop { request_id, request });
                }
                Some(Reply::Contexts { request_id, request, .. }) => {
                    on_notice(Notice::Contexts { request_id, request });
                }
                Some(Reply::Device { request_id, request, .. }) => {
                    on_notice(Notice::Device { request_id, request });
                }
                Some(Reply::Done { .. }) => break,
                Some(Reply::Usage { .. }) => {}
                // The sidecar exited mid-run.
                None => break,
            }
        }
        self.remove_route(run_id).await;

        outcome.unwrap_or_else(|| {
            emit(AgentEvent::Error { message: "The agent process exited unexpectedly.".into() });
            RunOutcome::Failed
        })
    }

    /// The tokens agent session `agent_session_id` has used across every run,
    /// subagents included, as the SDK reads them from its transcript. `None`
    /// if the transcript isn't on this machine.
    pub async fn session_usage(&self, agent_session_id: &str) -> Result<Option<TokenUsage>, String> {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let run_id = format!("usage-{}", NEXT.fetch_add(1, Ordering::Relaxed));
        let (tx, mut rx) = mpsc::unbounded_channel();
        let sent = self.send_with_route(&run_id, tx, &HostCommand::Usage { run_id: &run_id, agent_session_id }).await;
        let reply = match sent {
            Ok(()) => tokio::time::timeout(Duration::from_secs(15), rx.recv()).await,
            Err(e) => {
                self.remove_route(&run_id).await;
                return Err(e);
            }
        };
        self.remove_route(&run_id).await;
        match reply {
            Ok(Some(Reply::Usage { usage, .. })) => Ok(usage),
            Ok(_) => Err("The agent process exited unexpectedly.".into()),
            Err(_) => Err("Reading the chat's token usage timed out.".into()),
        }
    }

    /// Hands the run in `run_id` the chat's new settings, so it switches now
    /// rather than on the next message. A no-op when nothing runs there.
    pub async fn update_settings(&self, run_id: &str, settings: &SessionSettings) -> Result<(), String> {
        self.send(&HostCommand::Settings {
            run_id,
            mode: settings.mode,
            model: &settings.model,
            permissions: settings.permissions,
        })
        .await
    }

    /// Answers a `permission-request` from the run in `run_id`.
    pub async fn answer_permission(
        &self,
        run_id: &str,
        request_id: &str,
        decision: PermissionDecision,
    ) -> Result<(), String> {
        self.send(&HostCommand::Permission { run_id, request_id, decision }).await
    }

    /// Answers a `question` from the run in `run_id`; `None` skips it.
    pub async fn answer_question(
        &self,
        run_id: &str,
        request_id: &str,
        answers: Option<&Answers>,
    ) -> Result<(), String> {
        self.send(&HostCommand::Answer { run_id, request_id, answers }).await
    }

    /// Answers a terminal request from the run in `run_id` with the text its tool call returns.
    pub async fn answer_terminal(&self, run_id: &str, request_id: &str, ok: bool, text: &str) -> Result<(), String> {
        self.send(&HostCommand::TerminalResult { run_id, request_id, ok, text }).await
    }

    /// Answers a desktop request from the run in `run_id`, with a screenshot if it took one.
    pub async fn answer_desktop(
        &self,
        run_id: &str,
        request_id: &str,
        ok: bool,
        text: &str,
        image: Option<&ResultImage>,
    ) -> Result<(), String> {
        self.send(&HostCommand::DesktopResult { run_id, request_id, ok, text, image }).await
    }

    /// Answers a device request from the run in `run_id`, with a screenshot if it took one.
    pub async fn answer_device(
        &self,
        run_id: &str,
        request_id: &str,
        ok: bool,
        text: &str,
        image: Option<&ResultImage>,
    ) -> Result<(), String> {
        self.send(&HostCommand::DeviceResult { run_id, request_id, ok, text, image }).await
    }

    /// Answers a saved-context request from the run in `run_id` with the text its tool call returns.
    pub async fn answer_contexts(&self, run_id: &str, request_id: &str, ok: bool, text: &str) -> Result<(), String> {
        self.send(&HostCommand::ContextsResult { run_id, request_id, ok, text }).await
    }

    async fn send(&self, command: &HostCommand<'_>) -> Result<(), String> {
        let mut guard = self.sidecar.lock().await;
        let sidecar = guard.as_mut().ok_or("The agent isn't running.")?;
        write_line(&mut sidecar.stdin, command).await
    }

    /// Registers a route for `run_id`, then sends, starting the sidecar if needed.
    async fn send_with_route(
        &self,
        run_id: &str,
        tx: mpsc::UnboundedSender<Reply>,
        command: &HostCommand<'_>,
    ) -> Result<(), String> {
        let mut guard = self.sidecar.lock().await;
        let alive = match guard.as_mut() {
            Some(sidecar) => matches!(sidecar.child.try_wait(), Ok(None)),
            None => false,
        };
        if !alive {
            *guard = Some(self.spawn()?);
        }
        let sidecar = guard.as_mut().expect("started above");
        sidecar.routes.lock().unwrap().insert(run_id.to_owned(), tx);
        write_line(&mut sidecar.stdin, command).await
    }

    async fn remove_route(&self, run_id: &str) {
        if let Some(sidecar) = self.sidecar.lock().await.as_ref() {
            sidecar.routes.lock().unwrap().remove(run_id);
        }
    }

    fn spawn(&self) -> Result<Sidecar, String> {
        let mut child = Command::new(&self.command.program)
            .args(&self.command.args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .map_err(|e| format!("Couldn't start the agent ({}): {e}", self.command.program.display()))?;

        let stdin = child.stdin.take().expect("piped");
        let stdout = child.stdout.take().expect("piped");
        let stderr = child.stderr.take().expect("piped");
        let routes: Routes = Arc::default();

        let reader_routes = routes.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                match serde_json::from_str::<Reply>(&line) {
                    Ok(reply) => {
                        let route = reader_routes.lock().unwrap().get(reply.run_id()).cloned();
                        if let Some(tx) = route {
                            let _ = tx.send(reply);
                        }
                    }
                    Err(e) => eprintln!("[agent] unreadable reply ({e}): {line}"),
                }
            }
            // Exited: dropping the senders ends every run still waiting.
            reader_routes.lock().unwrap().clear();
        });
        tokio::spawn(async move {
            let mut lines = BufReader::new(stderr).lines();
            while let Ok(Some(line)) = lines.next_line().await {
                eprintln!("{line}");
            }
        });

        Ok(Sidecar { child, stdin, routes })
    }
}

async fn write_line(stdin: &mut ChildStdin, command: &HostCommand<'_>) -> Result<(), String> {
    let mut line = serde_json::to_vec(command).map_err(|e| e.to_string())?;
    line.push(b'\n');
    stdin.write_all(&line).await.map_err(|e| format!("The agent stopped responding: {e}"))?;
    stdin.flush().await.map_err(|e| format!("The agent stopped responding: {e}"))
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use agent_protocol::{MessageRole, SessionSettings};

    use super::*;

    /// A stand-in sidecar written in sh: replies to each `run` with a fixed
    /// script, echoing the run id, and to `interrupt` with `stopped`.
    fn fake(script: &str) -> ClaudeAgent {
        ClaudeAgent::new(SidecarCommand { program: "sh".into(), args: vec!["-c".into(), script.into()] })
    }

    const ECHO_RUN: &str = r#"
        while read -r line; do
          id=$(printf '%s' "$line" | sed -E 's/.*"runId":"([^"]+)".*/\1/')
          case "$line" in
            *'"type":"run"'*)
              echo "{\"type\":\"session\",\"runId\":\"$id\",\"agentSessionId\":\"agent-1\"}"
              case "$line" in
                *'"allowedTools":["Edit"]'*)
                  echo "{\"type\":\"rules\",\"runId\":\"$id\",\"rules\":[\"Bash(ls:*)\"]}" ;;
              esac
              echo "{\"type\":\"event\",\"runId\":\"$id\",\"event\":{\"type\":\"text-delta\",\"delta\":\"hi\"}}"
              case "$line" in
                *wait*) ;;
                *) echo "{\"type\":\"event\",\"runId\":\"$id\",\"event\":{\"type\":\"finish\"}}"
                   echo "{\"type\":\"done\",\"runId\":\"$id\"}" ;;
              esac ;;
            *'"type":"interrupt"'*)
              echo "{\"type\":\"event\",\"runId\":\"$id\",\"event\":{\"type\":\"stopped\"}}"
              echo "{\"type\":\"done\",\"runId\":\"$id\"}" ;;
          esac
        done
    "#;

    fn request(prompt: &str) -> AgentRequest {
        AgentRequest {
            session_id: "s1".into(),
            messages: vec![(MessageRole::User, prompt.into())],
            settings: SessionSettings::default(),
            cwd: Some(std::env::temp_dir()),
            workspace_name: None,
            resume: None,
            allowed_tools: Vec::new(),
            images: Vec::new(),
        }
    }

    #[tokio::test]
    async fn streams_events_and_reports_the_session() {
        let agent = fake(ECHO_RUN);
        let (mut events, mut notices) = (Vec::new(), Vec::new());
        let outcome = agent
            .run(&request("go"), &CancellationToken::new(), |e| events.push(e), |n| notices.push(n))
            .await;

        assert_eq!(outcome, RunOutcome::Finished);
        assert_eq!(events, vec![AgentEvent::TextDelta { delta: "hi".into() }, AgentEvent::Finish]);
        assert_eq!(notices, [Notice::Session("agent-1".into())]);
    }

    #[tokio::test]
    async fn sends_saved_rules_and_reports_new_ones() {
        let agent = fake(ECHO_RUN);
        let mut request = request("go");
        request.allowed_tools = vec!["Edit".into()];
        let mut notices = Vec::new();
        agent.run(&request, &CancellationToken::new(), |_| {}, |n| notices.push(n)).await;

        assert_eq!(notices[1], Notice::AllowRules(vec!["Bash(ls:*)".into()]));
    }

    #[tokio::test]
    async fn forwards_terminal_requests() {
        let agent = fake(
            r#"read -r line
            echo '{"type":"terminal","runId":"s1","requestId":"r1","request":{"action":"run","command":"pnpm dev","background":true}}'
            echo '{"type":"terminal","runId":"s1","requestId":"r2","request":{"action":"read","terminalId":3}}'
            echo '{"type":"event","runId":"s1","event":{"type":"finish"}}'
            echo '{"type":"done","runId":"s1"}'"#,
        );
        let mut notices = Vec::new();
        agent.run(&request("go"), &CancellationToken::new(), |_| {}, |n| notices.push(n)).await;

        assert_eq!(
            notices,
            [
                Notice::Terminal {
                    request_id: "r1".into(),
                    request: TerminalRequest::Run {
                        command: "pnpm dev".into(),
                        title: None,
                        background: true,
                        wait_seconds: None
                    },
                },
                Notice::Terminal {
                    request_id: "r2".into(),
                    request: TerminalRequest::Read { terminal_id: 3, wait_seconds: None },
                },
            ]
        );
    }

    #[tokio::test]
    async fn forwards_contexts_requests() {
        let agent = fake(
            r#"read -r line
            echo '{"type":"contexts","runId":"s1","requestId":"r1","request":{"action":"read","id":"ctx-abc123","fromSeq":4}}'
            echo '{"type":"contexts","runId":"s1","requestId":"r2","request":{"action":"search","query":"adb"}}'
            echo '{"type":"event","runId":"s1","event":{"type":"finish"}}'
            echo '{"type":"done","runId":"s1"}'"#,
        );
        let mut notices = Vec::new();
        agent.run(&request("go"), &CancellationToken::new(), |_| {}, |n| notices.push(n)).await;

        assert_eq!(
            notices,
            [
                Notice::Contexts {
                    request_id: "r1".into(),
                    request: ContextsRequest::Read { id: "ctx-abc123".into(), from_seq: Some(4), offset: None, max_chars: None },
                },
                Notice::Contexts {
                    request_id: "r2".into(),
                    request: ContextsRequest::Search { id: None, query: "adb".into(), limit: None },
                },
            ]
        );
    }

    #[tokio::test]
    async fn forwards_desktop_requests() {
        let agent = fake(
            r#"read -r line
            echo '{"type":"desktop","runId":"s1","requestId":"r1","request":{"action":"screenshot"}}'
            echo '{"type":"desktop","runId":"s1","requestId":"r2","request":{"action":"click","x":10,"y":20,"count":2}}'
            echo '{"type":"desktop","runId":"s1","requestId":"r3","request":{"action":"scroll","x":1,"y":2,"direction":"down"}}'
            echo '{"type":"event","runId":"s1","event":{"type":"finish"}}'
            echo '{"type":"done","runId":"s1"}'"#,
        );
        let mut notices = Vec::new();
        agent.run(&request("go"), &CancellationToken::new(), |_| {}, |n| notices.push(n)).await;

        let requests: Vec<_> = notices
            .into_iter()
            .map(|n| match n {
                Notice::Desktop { request, .. } => request,
                other => panic!("unexpected {other:?}"),
            })
            .collect();
        assert_eq!(
            requests,
            [
                DesktopRequest::Screenshot,
                DesktopRequest::Click { x: 10, y: 20, button: MouseButton::Left, count: Some(2) },
                DesktopRequest::Scroll { x: 1, y: 2, direction: ScrollDirection::Down, amount: None },
            ]
        );
    }

    #[tokio::test]
    async fn forwards_device_requests_as_json() {
        let agent = fake(
            r#"read -r line
            echo '{"type":"device","runId":"s1","requestId":"r1","request":{"action":"act","steps":[{"do":"tap","text":"Profile"}]}}'
            echo '{"type":"event","runId":"s1","event":{"type":"finish"}}'
            echo '{"type":"done","runId":"s1"}'"#,
        );
        let mut notices = Vec::new();
        agent.run(&request("go"), &CancellationToken::new(), |_| {}, |n| notices.push(n)).await;

        assert_eq!(
            notices,
            [Notice::Device {
                request_id: "r1".into(),
                request: serde_json::json!({ "action": "act", "steps": [{ "do": "tap", "text": "Profile" }] }),
            }]
        );
    }

    #[tokio::test]
    async fn cancelling_interrupts_the_run() {
        let agent = fake(ECHO_RUN);
        let cancel = CancellationToken::new();
        let mut events = Vec::new();
        let request = request("wait");
        let run = agent.run(&request, &cancel, |e| {
            if matches!(e, AgentEvent::TextDelta { .. }) {
                cancel.cancel();
            }
            events.push(e);
        }, |_| {});
        let outcome = tokio::time::timeout(Duration::from_secs(5), run).await.unwrap();

        assert_eq!(outcome, RunOutcome::Stopped);
        assert_eq!(events.last(), Some(&AgentEvent::Stopped));
    }

    #[tokio::test]
    async fn a_crashed_sidecar_fails_the_run_and_restarts_next_time() {
        let agent = fake("read -r line; exit 1");
        let mut events = Vec::new();
        let outcome = agent.run(&request("go"), &CancellationToken::new(), |e| events.push(e), |_| {}).await;
        assert_eq!(outcome, RunOutcome::Failed);
        assert!(matches!(events.last(), Some(AgentEvent::Error { .. })));

        // The dead process is replaced on the next run.
        let outcome = agent.run(&request("go"), &CancellationToken::new(), |_| {}, |_| {}).await;
        assert_eq!(outcome, RunOutcome::Failed);
    }

    #[tokio::test]
    async fn a_missing_program_is_a_clear_error() {
        let agent = ClaudeAgent::new(SidecarCommand { program: "/nonexistent/node".into(), args: vec![] });
        let mut events = Vec::new();
        agent.run(&request("go"), &CancellationToken::new(), |e| events.push(e), |_| {}).await;
        assert!(matches!(&events[0], AgentEvent::Error { message } if message.contains("Couldn't start the agent")));
    }
}
