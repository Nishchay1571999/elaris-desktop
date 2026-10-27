//! The agent's `terminal-access` tool, which only Elaris provides. Every `run`
//! starts its own terminal, owned by the chat, that opens as a tab beside it
//! like one the user opened with ⌘T. Long-running commands (dev servers,
//! watchers) keep going there; the agent checks on them with `read`.

use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use std::time::{Duration, Instant};

use agent_core::TerminalRequest;
use serde::Serialize;
use terminal::{Program, Spawn, Terminals, plain_text};

/// Emitted with [`AgentTerminal`] when the agent starts a terminal, so the UI opens its tab.
pub const OPENED_EVENT: &str = "terminal://agent-opened";

/// Size until the tab is shown and fits itself.
pub const COLS: u16 = 120;
pub const ROWS: u16 = 32;

const POLL: Duration = Duration::from_millis(100);
/// A background command counts as started once its output has been quiet this long.
const SETTLED: Duration = Duration::from_millis(1500);
/// After typing into a terminal, how long to wait for it to answer.
const ECHO: Duration = Duration::from_millis(800);
/// Output beyond this is trimmed from the front: the latest lines matter most.
const MAX_TEXT: usize = 30_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTerminal {
    pub id: u32,
    pub session_id: String,
    pub title: String,
}

/// How far the agent has read each terminal.
#[derive(Default)]
pub struct ReadPositions(Mutex<HashMap<u32, u64>>);

impl ReadPositions {
    fn get(&self, id: u32) -> u64 {
        self.0.lock().unwrap().get(&id).copied().unwrap_or(0)
    }

    fn set(&self, id: u32, next: u64) {
        self.0.lock().unwrap().insert(id, next);
    }
}

/// What a call from the agent in one chat works with.
pub struct Context<'a> {
    pub terminals: &'a Terminals,
    pub reads: &'a ReadPositions,
    pub session_id: &'a str,
    /// Where the chat's agent works.
    pub cwd: Option<&'a Path>,
    /// False once the chat's reply has ended, so waits stop early.
    pub alive: &'a (dyn Fn() -> bool + Sync),
    /// Tells the UI to open a new terminal's tab.
    pub opened: &'a (dyn Fn(AgentTerminal) + Sync),
}

/// Carries out one call, returning what the tool call answers (an `Err` is
/// reported to the agent as a failed call).
pub async fn handle(cx: &Context<'_>, request: TerminalRequest) -> Result<String, String> {
    let session_id = cx.session_id;
    match request {
        TerminalRequest::Run { command, title, background, wait_seconds } => {
            let cwd = cx.cwd.ok_or("Open a folder for the agent to work in first.")?;
            let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| short(&command));
            let id = cx
                .terminals
                .spawn(Spawn {
                    cwd,
                    cols: COLS,
                    rows: ROWS,
                    program: Program::Command(command.clone()),
                    owner: Some(session_id.to_owned()),
                    title: title.clone(),
                })
                .map_err(|e| e.to_string())?;
            (cx.opened)(AgentTerminal { id, session_id: session_id.to_owned(), title });

            let (wait, settle) = if background {
                (seconds(wait_seconds, 10, 60), Some(SETTLED))
            } else {
                (seconds(wait_seconds, 120, 600), None)
            };
            let exit = wait_for(cx, id, wait, settle).await;
            let status = match exit {
                Some(code) => exited(code),
                None if background => "still running in the background. Use `read` to follow its output and `stop` to end it.".into(),
                None => format!(
                    "still running after {}s. Use `read` to wait for more output, `write` to answer prompts, or `stop` to end it.",
                    wait.as_secs()
                ),
            };
            Ok(report(cx, id, &format!("Terminal {id} · `{command}`"), &status))
        }
        TerminalRequest::Read { terminal_id: id, wait_seconds } => {
            owned(cx, id)?;
            let wait = seconds(wait_seconds, 0, 60);
            if cx.terminals.read(id, cx.reads.get(id)).is_ok_and(|c| c.bytes.is_empty() && c.exit.is_none()) {
                wait_for_output(cx, id, wait).await;
            }
            let status = status(cx, id);
            Ok(report(cx, id, &format!("Terminal {id}"), &status))
        }
        TerminalRequest::Write { terminal_id: id, input } => {
            owned(cx, id)?;
            cx.terminals.write(id, input.as_bytes()).map_err(|e| e.to_string())?;
            wait_for(cx, id, ECHO * 6, Some(ECHO)).await;
            let status = status(cx, id);
            Ok(report(cx, id, &format!("Terminal {id}"), &status))
        }
        TerminalRequest::Stop { terminal_id: id } => {
            owned(cx, id)?;
            // Ctrl+C first, so servers shut down cleanly; then make sure.
            let _ = cx.terminals.write(id, b"\x03");
            let exit = wait_for(cx, id, Duration::from_secs(3), None).await;
            let text = report(cx, id, &format!("Terminal {id}"), "stopped.");
            if exit.is_none() {
                cx.terminals.kill(id);
            }
            Ok(text)
        }
        TerminalRequest::List => {
            let lines: Vec<String> = cx
                .terminals
                .list()
                .into_iter()
                .filter(|info| info.owner.as_deref() == Some(session_id))
                .map(|info| {
                    let status = info.exit.map_or_else(|| "running".to_owned(), exited);
                    format!("Terminal {} · `{}` · {status}", info.id, info.title)
                })
                .collect();
            Ok(if lines.is_empty() { "No terminals are open for this chat.".into() } else { lines.join("\n") })
        }
    }
}

/// Polls until the process exits, its output has been quiet for `settle`
/// (once there is some), `wait` passes, or the chat's reply ends. Returns the
/// exit, if it happened.
async fn wait_for(
    cx: &Context<'_>,
    id: u32,
    wait: Duration,
    settle: Option<Duration>,
) -> Option<Option<u32>> {
    let deadline = Instant::now() + wait;
    let mut seen = cx.terminals.read(id, u64::MAX).map(|c| c.next).unwrap_or(0);
    let mut quiet_since = Instant::now();
    loop {
        let Ok(chunk) = cx.terminals.read(id, u64::MAX) else { return Some(None) };
        if chunk.exit.is_some() {
            return chunk.exit;
        }
        if chunk.next != seen {
            seen = chunk.next;
            quiet_since = Instant::now();
        } else if settle.is_some_and(|settle| seen > 0 && quiet_since.elapsed() >= settle) {
            return None;
        }
        if Instant::now() >= deadline || !(cx.alive)() {
            return None;
        }
        tokio::time::sleep(POLL).await;
    }
}

/// Waits up to `wait` for anything new past what the agent has read.
async fn wait_for_output(cx: &Context<'_>, id: u32, wait: Duration) {
    let deadline = Instant::now() + wait;
    let from = cx.reads.get(id);
    while Instant::now() < deadline && (cx.alive)() {
        match cx.terminals.read(id, from) {
            Ok(chunk) if chunk.bytes.is_empty() && chunk.exit.is_none() => tokio::time::sleep(POLL).await,
            _ => return,
        }
    }
}

/// `heading`, the status, and the output the agent hasn't seen yet.
fn report(cx: &Context<'_>, id: u32, heading: &str, status: &str) -> String {
    let Ok(chunk) = cx.terminals.read(id, cx.reads.get(id)) else {
        return format!("{heading}\nStatus: {status}");
    };
    cx.reads.set(id, chunk.next);
    let mut text = plain_text(&chunk.bytes).trim_end().to_owned();
    let mut trimmed = chunk.skipped;
    if text.len() > MAX_TEXT {
        let mut cut = text.len() - MAX_TEXT;
        while !text.is_char_boundary(cut) {
            cut += 1;
        }
        text = text.split_off(cut);
        trimmed = true;
    }
    let output = match (text.is_empty(), trimmed) {
        (true, _) => "(no new output)".to_owned(),
        (false, true) => format!("(earlier output trimmed)\n{text}"),
        (false, false) => text,
    };
    format!("{heading}\nStatus: {status}\nOutput:\n{output}")
}

fn status(cx: &Context<'_>, id: u32) -> String {
    match cx.terminals.info(id) {
        Ok(info) => info.exit.map_or_else(|| "running.".to_owned(), exited),
        Err(_) => "closed.".to_owned(),
    }
}

fn exited(code: Option<u32>) -> String {
    match code {
        Some(code) => format!("exited with code {code}."),
        None => "exited.".to_owned(),
    }
}

/// The agent may only drive the terminals its own chat started.
fn owned(cx: &Context<'_>, id: u32) -> Result<(), String> {
    let info = cx.terminals.info(id).map_err(|e| e.to_string())?;
    if info.owner.as_deref() == Some(cx.session_id) {
        Ok(())
    } else {
        Err(format!("Terminal {id} wasn't started by this chat. Use `list` to see the ones that were."))
    }
}

fn seconds(requested: Option<u64>, default: u64, max: u64) -> Duration {
    Duration::from_secs(requested.unwrap_or(default).min(max))
}

/// A tab title from a command line.
fn short(command: &str) -> String {
    let line = command.lines().next().unwrap_or("").trim();
    if line.chars().count() > 40 { format!("{}…", line.chars().take(39).collect::<String>()) } else { line.to_owned() }
}

#[cfg(all(test, unix))]
mod tests {
    use std::sync::Mutex;

    use super::*;

    struct Fixture {
        terminals: Terminals,
        reads: ReadPositions,
        dir: tempfile::TempDir,
        opened: Mutex<Vec<AgentTerminal>>,
    }

    impl Fixture {
        fn new() -> Self {
            Self {
                terminals: Terminals::new(),
                reads: ReadPositions::default(),
                dir: tempfile::tempdir().unwrap(),
                opened: Mutex::default(),
            }
        }

        async fn call(&self, session_id: &str, request: TerminalRequest) -> Result<String, String> {
            let opened = |terminal| self.opened.lock().unwrap().push(terminal);
            let cx = Context {
                terminals: &self.terminals,
                reads: &self.reads,
                session_id,
                cwd: Some(self.dir.path()),
                alive: &|| true,
                opened: &opened,
            };
            handle(&cx, request).await
        }

        async fn run(&self, command: &str, background: bool, wait: u64) -> String {
            let request = TerminalRequest::Run {
                command: command.into(),
                title: None,
                background,
                wait_seconds: Some(wait),
            };
            self.call("chat", request).await.unwrap()
        }
    }

    #[tokio::test]
    async fn run_waits_for_the_command_and_opens_a_tab() {
        let fx = Fixture::new();
        let text = fx.run("echo hello from elaris; exit 2", false, 30).await;
        assert!(text.starts_with("Terminal 1 · `echo hello from elaris; exit 2`"), "{text}");
        assert!(text.contains("Status: exited with code 2."), "{text}");
        assert!(text.contains("hello from elaris"), "{text}");
        let opened = fx.opened.lock().unwrap();
        assert_eq!(opened.len(), 1);
        assert_eq!((opened[0].id, opened[0].session_id.as_str()), (1, "chat"));
    }

    #[tokio::test]
    async fn background_returns_once_output_settles_and_keeps_running() {
        let fx = Fixture::new();
        let text = fx.run("echo server ready; sleep 30", true, 20).await;
        assert!(text.contains("still running in the background"), "{text}");
        assert!(text.contains("server ready"), "{text}");
        assert_eq!(fx.terminals.info(1).unwrap().exit, None);

        // Nothing new since: read says so, rather than repeating the output.
        let read = fx.call("chat", TerminalRequest::Read { terminal_id: 1, wait_seconds: None }).await.unwrap();
        assert!(read.contains("(no new output)"), "{read}");

        let list = fx.call("chat", TerminalRequest::List).await.unwrap();
        assert!(list.contains("Terminal 1 · `echo server ready; sleep 30` · running"), "{list}");

        let stop = fx.call("chat", TerminalRequest::Stop { terminal_id: 1 }).await.unwrap();
        assert!(stop.contains("Status: stopped."), "{stop}");
        tokio::time::sleep(Duration::from_millis(300)).await;
        assert!(fx.terminals.info(1).map_or(true, |info| info.exit.is_some()));
    }

    #[tokio::test]
    async fn write_types_into_the_terminal_and_returns_what_it_printed() {
        let fx = Fixture::new();
        fx.run("read name; echo \"hi $name\"", true, 3).await;
        let text = fx
            .call("chat", TerminalRequest::Write { terminal_id: 1, input: "ada\n".into() })
            .await
            .unwrap();
        assert!(text.contains("hi ada"), "{text}");
    }

    #[tokio::test]
    async fn other_chats_terminals_are_off_limits() {
        let fx = Fixture::new();
        fx.run("sleep 30", true, 1).await;
        let denied = fx.call("other", TerminalRequest::Read { terminal_id: 1, wait_seconds: None }).await;
        assert!(denied.unwrap_err().contains("wasn't started by this chat"));
        let list = fx.call("other", TerminalRequest::List).await.unwrap();
        assert_eq!(list, "No terminals are open for this chat.");
    }

    #[test]
    fn tab_titles_are_the_first_line_shortened() {
        assert_eq!(short("pnpm dev\n--port 3000"), "pnpm dev");
        assert_eq!(short(&"x".repeat(50)).chars().count(), 40);
    }
}
