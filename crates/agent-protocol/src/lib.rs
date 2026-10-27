//! Types shared by every Elaris front end that talks to an agent.
//!
//! Everything here is serialised over IPC and mirrored to TypeScript with
//! `ts-rs` (`cargo test` regenerates `apps/desktop/src/bindings`). Field names
//! are camelCase on the wire so the React side reads them naturally.

use std::collections::HashMap;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use ts_rs::TS;

/// The local, offline stand-in agent.
pub const MOCK_MODEL: &str = "mock";
/// Model for new chats.
pub const DEFAULT_MODEL: &str = "claude-opus-5-5";

/// One step of a streamed reply. Starts as a superset of `ChatStreamEvent` in
/// `apps/web`; tool and permission events come from the Claude agent.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "kebab-case", rename_all_fields = "camelCase")]
#[ts(export)]
pub enum AgentEvent {
    TextDelta { delta: String },
    /// The agent started using a tool. `summary` is a short human description
    /// of the input (a path, a command); `input` is the input itself, with
    /// long strings clipped.
    ToolStart {
        id: String,
        name: String,
        summary: String,
        #[ts(type = "Record<string, unknown>")]
        input: Value,
    },
    /// `output` is the tool's text result, clipped.
    ToolEnd { id: String, ok: bool, output: Option<String> },
    /// The agent wants to run a tool that needs the user's approval. Answer
    /// with the `chat_permission` command. `always` holds the rules that
    /// "always allow" would save for the project, if any are safe to offer.
    PermissionRequest {
        request_id: String,
        tool_name: String,
        summary: String,
        #[ts(type = "Record<string, unknown>")]
        input: Value,
        always: Option<Vec<String>>,
    },
    PermissionResolved { request_id: String, allowed: bool },
    /// The agent is asking the user to choose. Answer with `chat_answer`.
    Question { request_id: String, questions: Vec<Question> },
    QuestionResolved { request_id: String },
    /// Tokens used since the last `usage` event; add them up for the total.
    Usage { usage: TokenUsage },
    Finish,
    Stopped,
    Error { message: String },
}

/// Tokens the model read and wrote. Input counts every prompt token, cached
/// or not; `cache_read` and `cache_write` say how many of those were cached.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct TokenUsage {
    #[ts(type = "number")]
    pub input: u64,
    #[ts(type = "number")]
    pub output: u64,
    #[ts(type = "number")]
    pub cache_read: u64,
    #[ts(type = "number")]
    pub cache_write: u64,
}

impl std::ops::AddAssign for TokenUsage {
    fn add_assign(&mut self, other: Self) {
        self.input += other.input;
        self.output += other.output;
        self.cache_read += other.cache_read;
        self.cache_write += other.cache_write;
    }
}

impl AgentEvent {
    /// Whether this event ends the run.
    pub fn is_terminal(&self) -> bool {
        matches!(self, Self::Finish | Self::Stopped | Self::Error { .. })
    }

    /// The id of the permission or question this event opens or closes.
    pub fn request_id(&self) -> Option<&str> {
        match self {
            Self::PermissionRequest { request_id, .. }
            | Self::PermissionResolved { request_id, .. }
            | Self::Question { request_id, .. }
            | Self::QuestionResolved { request_id } => Some(request_id),
            _ => None,
        }
    }
}

/// One multiple-choice question from the agent (its `AskUserQuestion` tool).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Question {
    pub question: String,
    /// A short label for the question, a few words at most.
    pub header: String,
    pub multi_select: bool,
    pub options: Vec<QuestionOption>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct QuestionOption {
    pub label: String,
    pub description: String,
}

/// The user's reply to a `permission-request`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum PermissionDecision {
    Allow,
    /// Allow, and save the request's `always` rules for the project.
    Always,
    Deny,
}

/// The user's reply to a `question`: answer text by question text. Several
/// choices for one question are joined with ", ".
pub type Answers = HashMap<String, String>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum AgentMode {
    /// Plans and edits on its own.
    #[default]
    Agent,
    /// Answers questions without editing files.
    Ask,
    /// Produces a plan for review before any change.
    Plan,
}

/// When the agent must ask before using a tool.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum PermissionPolicy {
    /// Ask before edits and commands.
    #[default]
    Ask,
    /// Apply file edits without asking; still ask for commands.
    AcceptEdits,
    /// A classifier approves routine calls and asks about risky ones.
    Auto,
    /// Never ask. Only for trusted folders.
    Bypass,
}

/// The per-chat choices the composer exposes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionSettings {
    pub mode: AgentMode,
    /// A Claude model id, or [`MOCK_MODEL`].
    pub model: String,
    pub permissions: PermissionPolicy,
}

impl Default for SessionSettings {
    fn default() -> Self {
        Self { mode: AgentMode::default(), model: DEFAULT_MODEL.into(), permissions: PermissionPolicy::default() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum MessageStatus {
    Streaming,
    Complete,
    Stopped,
    Error,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ToolStatus {
    Running,
    Done,
    Failed,
}

/// A piece of an assistant reply, in the order it happened.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type", rename_all = "lowercase")]
#[ts(export)]
pub enum Part {
    Text {
        text: String,
    },
    Tool {
        id: String,
        name: String,
        summary: String,
        status: ToolStatus,
        #[serde(default)]
        #[ts(type = "Record<string, unknown>")]
        input: Value,
        #[serde(default)]
        output: Option<String>,
    },
}

/// An image the user attached to a message. The file lives in the app's data
/// folder, next to the chat; read it with the `chat_image` command.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ImageAttachment {
    pub id: String,
    /// `image/png`, `image/jpeg`, `image/gif` or `image/webp`.
    pub media_type: String,
    /// The original file name, if it had one.
    #[serde(default)]
    pub name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Message {
    pub id: String,
    pub role: MessageRole,
    /// All text of the message, Markdown for assistant messages.
    pub content: String,
    /// Text and tool calls in order. Empty for user messages.
    #[serde(default)]
    pub parts: Vec<Part>,
    /// Images the user attached. Empty for assistant messages.
    #[serde(default)]
    pub images: Vec<ImageAttachment>,
    /// Epoch milliseconds.
    #[ts(type = "number")]
    pub created_at: i64,
    pub status: MessageStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub error: Option<String>,
}

impl Message {
    /// Folds one stream event into this (assistant) message. The front end
    /// mirrors this in `stores/sessions.ts`.
    pub fn apply(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::TextDelta { delta } => {
                self.content.push_str(delta);
                match self.parts.last_mut() {
                    Some(Part::Text { text }) => text.push_str(delta),
                    _ => self.parts.push(Part::Text { text: delta.clone() }),
                }
            }
            AgentEvent::ToolStart { id, name, summary, input } => self.parts.push(Part::Tool {
                id: id.clone(),
                name: name.clone(),
                summary: summary.clone(),
                status: ToolStatus::Running,
                input: input.clone(),
                output: None,
            }),
            AgentEvent::ToolEnd { id, ok, output } => {
                for part in &mut self.parts {
                    if let Part::Tool { id: tool_id, status, output: tool_output, .. } = part
                        && tool_id == id
                    {
                        *status = if *ok { ToolStatus::Done } else { ToolStatus::Failed };
                        tool_output.clone_from(output);
                    }
                }
            }
            AgentEvent::PermissionRequest { .. }
            | AgentEvent::PermissionResolved { .. }
            | AgentEvent::Question { .. }
            | AgentEvent::QuestionResolved { .. }
            | AgentEvent::Usage { .. } => {}
            AgentEvent::Finish => self.finish(MessageStatus::Complete),
            AgentEvent::Stopped => self.finish(MessageStatus::Stopped),
            AgentEvent::Error { message } => {
                self.error = Some(message.clone());
                self.finish(MessageStatus::Error);
            }
        }
    }

    /// Ends the message; tools still running can't finish any more.
    pub fn finish(&mut self, status: MessageStatus) {
        self.status = status;
        for part in &mut self.parts {
            if let Part::Tool { status: tool_status @ ToolStatus::Running, .. } = part {
                *tool_status = ToolStatus::Failed;
            }
        }
    }
}

/// A reply still being written, as a window that (re)attaches needs it: the
/// message so far and the permission or question requests still open.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct LiveReply {
    pub reply: Message,
    /// `permission-request` and `question` events not yet resolved.
    pub pending: Vec<AgentEvent>,
}

impl LiveReply {
    pub fn new(reply: Message) -> Self {
        Self { reply, pending: Vec::new() }
    }

    pub fn apply(&mut self, event: &AgentEvent) {
        match event {
            AgentEvent::PermissionRequest { .. } | AgentEvent::Question { .. } => self.pending.push(event.clone()),
            AgentEvent::PermissionResolved { request_id, .. } | AgentEvent::QuestionResolved { request_id } => {
                self.pending.retain(|e| e.request_id() != Some(request_id));
            }
            _ if event.is_terminal() => self.pending.clear(),
            _ => {}
        }
        self.reply.apply(event);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Session {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub created_at: i64,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub mode: AgentMode,
    #[serde(default = "default_model")]
    pub model: String,
    #[serde(default)]
    pub permissions: PermissionPolicy,
    /// Absolute path of the workspace the session was started in.
    pub workspace: Option<String>,
    /// The Claude agent's own session id, used to resume its context.
    #[serde(default)]
    pub agent_session_id: Option<String>,
    /// Tokens used by every reply so far. Chats from before this was kept start at zero.
    #[serde(default)]
    pub usage: TokenUsage,
    pub messages: Vec<Message>,
}

fn default_model() -> String {
    // Chats saved before models existed ran on the mock.
    MOCK_MODEL.into()
}

impl Session {
    pub fn settings(&self) -> SessionSettings {
        SessionSettings { mode: self.mode, model: self.model.clone(), permissions: self.permissions }
    }

    pub fn apply_settings(&mut self, settings: SessionSettings) {
        self.mode = settings.mode;
        self.model = settings.model;
        self.permissions = settings.permissions;
    }
}

/// What the sidebar needs, without loading every transcript.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    #[ts(type = "number")]
    pub updated_at: i64,
    pub workspace: Option<String>,
}

impl From<&Session> for SessionSummary {
    fn from(session: &Session) -> Self {
        Self {
            id: session.id.clone(),
            title: session.title.clone(),
            updated_at: session.updated_at,
            workspace: session.workspace.clone(),
        }
    }
}

/// An image sent with the newest prompt, as a file the agent reads.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptImage {
    pub media_type: String,
    pub path: PathBuf,
}

/// Input to an agent run: the newest prompt plus the context it runs in.
#[derive(Debug, Clone)]
pub struct AgentRequest {
    pub session_id: String,
    /// Full history up to and including the newest user message. Agents that
    /// keep their own context (Claude, via `resume`) only send the last one.
    pub messages: Vec<(MessageRole, String)>,
    pub settings: SessionSettings,
    /// Folder the agent works in.
    pub cwd: Option<PathBuf>,
    /// Display name of that folder.
    pub workspace_name: Option<String>,
    /// The agent's session to continue, from an earlier run.
    pub resume: Option<String>,
    /// Permission rules the user saved for this workspace, like `Edit` or
    /// `Bash(pnpm test:*)`. Matching tool calls run without asking.
    pub allowed_tools: Vec<String>,
    /// Images attached to the newest user message.
    pub images: Vec<PromptImage>,
}

impl AgentRequest {
    pub fn prompt(&self) -> &str {
        self.messages
            .iter()
            .rev()
            .find(|(role, _)| *role == MessageRole::User)
            .map(|(_, content)| content.as_str())
            .unwrap_or_default()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn reply() -> Message {
        Message {
            id: "m".into(),
            role: MessageRole::Assistant,
            content: String::new(),
            parts: Vec::new(),
            images: Vec::new(),
            created_at: 0,
            status: MessageStatus::Streaming,
            error: None,
        }
    }

    #[test]
    fn folds_text_and_tools_in_order() {
        let mut message = reply();
        for event in [
            AgentEvent::TextDelta { delta: "Look".into() },
            AgentEvent::TextDelta { delta: "ing.".into() },
            AgentEvent::ToolStart {
                id: "t".into(),
                name: "Read".into(),
                summary: "a.rs".into(),
                input: json!({ "file_path": "a.rs" }),
            },
            AgentEvent::ToolEnd { id: "t".into(), ok: true, output: Some("fn main() {}".into()) },
            AgentEvent::TextDelta { delta: "Done.".into() },
            AgentEvent::Finish,
        ] {
            message.apply(&event);
        }
        assert_eq!(message.content, "Looking.Done.");
        assert_eq!(message.status, MessageStatus::Complete);
        assert_eq!(
            message.parts,
            vec![
                Part::Text { text: "Looking.".into() },
                Part::Tool {
                    id: "t".into(),
                    name: "Read".into(),
                    summary: "a.rs".into(),
                    status: ToolStatus::Done,
                    input: json!({ "file_path": "a.rs" }),
                    output: Some("fn main() {}".into()),
                },
                Part::Text { text: "Done.".into() },
            ]
        );
    }

    #[test]
    fn stopping_fails_tools_still_running() {
        let mut message = reply();
        message.apply(&AgentEvent::ToolStart {
            id: "t".into(),
            name: "Bash".into(),
            summary: "ls".into(),
            input: json!({ "command": "ls" }),
        });
        message.apply(&AgentEvent::Stopped);
        assert!(matches!(message.parts[0], Part::Tool { status: ToolStatus::Failed, .. }));
    }

    #[test]
    fn events_use_camel_case_fields() {
        let json = serde_json::to_string(&AgentEvent::PermissionRequest {
            request_id: "r".into(),
            tool_name: "Bash".into(),
            summary: "ls".into(),
            input: json!({}),
            always: None,
        })
        .unwrap();
        assert_eq!(
            json,
            r#"{"type":"permission-request","requestId":"r","toolName":"Bash","summary":"ls","input":{},"always":null}"#
        );
    }

    #[test]
    fn old_sessions_load_as_mock_chats() {
        let json = r#"{"id":"s","title":"t","createdAt":0,"updatedAt":0,"mode":"agent","workspace":null,
            "messages":[{"id":"m","role":"user","content":"hi","createdAt":0,"status":"complete"}]}"#;
        let session: Session = serde_json::from_str(json).unwrap();
        assert_eq!(session.model, MOCK_MODEL);
        assert!(session.messages[0].parts.is_empty());
    }

    #[test]
    fn live_reply_tracks_open_requests() {
        let mut live = LiveReply::new(reply());
        let ask = |id: &str| AgentEvent::PermissionRequest {
            request_id: id.into(),
            tool_name: "Edit".into(),
            summary: "a.rs".into(),
            input: json!({}),
            always: None,
        };
        live.apply(&AgentEvent::TextDelta { delta: "Editing.".into() });
        live.apply(&ask("p1"));
        live.apply(&AgentEvent::Question { request_id: "q1".into(), questions: Vec::new() });
        live.apply(&AgentEvent::PermissionResolved { request_id: "p1".into(), allowed: true });
        assert_eq!(live.reply.content, "Editing.");
        assert_eq!(live.pending.iter().filter_map(AgentEvent::request_id).collect::<Vec<_>>(), ["q1"]);

        live.apply(&ask("p2"));
        live.apply(&AgentEvent::Stopped);
        assert!(live.pending.is_empty());
        assert_eq!(live.reply.status, MessageStatus::Stopped);
    }

    #[test]
    fn tool_parts_saved_before_details_still_load() {
        let json = r#"{"type":"tool","id":"t","name":"Read","summary":"a.rs","status":"done"}"#;
        let part: Part = serde_json::from_str(json).unwrap();
        assert!(matches!(part, Part::Tool { input: Value::Null, output: None, .. }));
    }
}
