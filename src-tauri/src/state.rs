use std::collections::HashMap;
use std::sync::Mutex;

use agent_core::{CancellationToken, ClaudeAgent};
use agent_protocol::{AgentEvent, LiveReply, Message};
use code_intelligence::CodeIntelligence;
use contexts::ContextStore;
use terminal::Terminals;
use tauri::ipc::Channel;
use workspace::{Watcher, Workspace};

use crate::agent_terminal::ReadPositions;
use crate::error::{CommandError, CommandResult};
use crate::store::Store;

pub struct AppState {
    pub store: Store,
    pub claude: ClaudeAgent,
    /// Chats saved for other chats to reference with `#ctx-…`.
    pub contexts: ContextStore,
    /// Language servers for the code views.
    pub code: CodeIntelligence,
    /// Shells behind the terminal tabs.
    pub terminals: Terminals,
    /// How far the agent has read each of its terminals.
    pub agent_reads: ReadPositions,
    open: Mutex<Option<OpenWorkspace>>,
    /// Session id → the reply currently streaming there.
    runs: Mutex<HashMap<String, LiveRun>>,
}

/// A reply in flight. It lives here rather than in the window, so a window
/// that reloads can pick it up again with `chat_attach`.
struct LiveRun {
    cancel: CancellationToken,
    live: LiveReply,
    /// Windows following the reply. A reloaded window's old channel fails to
    /// send and is dropped.
    subscribers: Vec<Channel<AgentEvent>>,
}

struct OpenWorkspace {
    workspace: Workspace,
    _watcher: Watcher,
}

impl AppState {
    pub fn new(store: Store, claude: ClaudeAgent, contexts: ContextStore, code: CodeIntelligence) -> Self {
        Self { store, claude, contexts, code, terminals: Terminals::new(), agent_reads: ReadPositions::default(), open: Mutex::new(None), runs: Mutex::new(HashMap::new()) }
    }

    /// Replaces the open workspace; the previous watcher and language servers stop.
    pub fn set_workspace(&self, workspace: Workspace, watcher: Watcher) {
        *self.open.lock().unwrap() = Some(OpenWorkspace { workspace, _watcher: watcher });
        self.code.reset();
    }

    pub fn workspace(&self) -> Option<Workspace> {
        self.open.lock().unwrap().as_ref().map(|open| open.workspace.clone())
    }

    pub fn require_workspace(&self) -> CommandResult<Workspace> {
        self.workspace().ok_or(CommandError::NoWorkspace)
    }

    /// Registers a new run for `session_id` with its empty `reply`, refusing a
    /// second one.
    pub fn begin_run(
        &self,
        session_id: &str,
        reply: Message,
        subscriber: Channel<AgentEvent>,
    ) -> CommandResult<CancellationToken> {
        let mut runs = self.runs.lock().unwrap();
        if runs.contains_key(session_id) {
            return Err(CommandError::AlreadyStreaming);
        }
        let cancel = CancellationToken::new();
        let run = LiveRun { cancel: cancel.clone(), live: LiveReply::new(reply), subscribers: vec![subscriber] };
        runs.insert(session_id.to_owned(), run);
        Ok(cancel)
    }

    /// Folds `event` into the run's reply and forwards it to every window
    /// following it.
    pub fn publish(&self, session_id: &str, event: &AgentEvent) {
        let mut runs = self.runs.lock().unwrap();
        let Some(run) = runs.get_mut(session_id) else { return };
        run.live.apply(event);
        run.subscribers.retain(|channel| channel.send(event.clone()).is_ok());
    }

    /// The reply so far, to save.
    pub fn reply(&self, session_id: &str) -> Option<Message> {
        self.runs.lock().unwrap().get(session_id).map(|run| run.live.reply.clone())
    }

    /// Follows the run in `session_id`, if there is one, returning where it is
    /// now. Later events go to `subscriber`; none fall between the two.
    pub fn attach(&self, session_id: &str, subscriber: Channel<AgentEvent>) -> Option<LiveReply> {
        let mut runs = self.runs.lock().unwrap();
        let run = runs.get_mut(session_id)?;
        run.subscribers.push(subscriber);
        Some(run.live.clone())
    }

    pub fn is_running(&self, session_id: &str) -> bool {
        self.runs.lock().unwrap().contains_key(session_id)
    }

    pub fn running(&self) -> Vec<String> {
        self.runs.lock().unwrap().keys().cloned().collect()
    }

    /// Removes the run, returning its final reply.
    pub fn end_run(&self, session_id: &str) -> Option<Message> {
        self.runs.lock().unwrap().remove(session_id).map(|run| run.live.reply)
    }

    pub fn cancel_run(&self, session_id: &str) {
        if let Some(run) = self.runs.lock().unwrap().get(session_id) {
            run.cancel.cancel();
        }
    }
}
