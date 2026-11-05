//! Reads a session the way the agent itself recorded it: the Claude Agent
//! SDK's transcript at `~/.claude/projects/<folder>/<agent session id>.jsonl`,
//! plus one file per subagent under `<agent session id>/subagents/`. Unlike the
//! chat Elaris saves (which clips long tool output), these hold every prompt,
//! reply, thinking block, tool call and tool result exactly as the model saw them.
//!
//! Each conversation line becomes an [`Entry`]: the line verbatim, plus a
//! Markdown rendering with nothing cut. Lines that only carry the SDK's own
//! bookkeeping (request blobs, cost and mode snapshots, file history) repeat
//! what the conversation lines already hold, so they are left out.

use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use agent_protocol::{Message, MessageRole, Part, Session};
use serde_json::{Map, Value};

/// Conversation line types worth keeping; everything else is SDK bookkeeping.
const KEPT: &[&str] = &["user", "assistant", "system", "attachment", "summary"];

/// One step of a saved session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Entry {
    /// The subagent that produced it; `None` for the main conversation.
    pub agent: Option<String>,
    /// `user`, `assistant`, `system`, `attachment`, `summary` or `subagent`.
    pub role: String,
    /// The first content block's type: `text`, `thinking`, `tool_use`,
    /// `tool_result`, `image`, or the role for lines without blocks.
    pub kind: String,
    pub tool_name: Option<String>,
    /// The source line (or record) verbatim.
    pub raw: String,
    /// Markdown of everything in it. Empty for lines a reader has no use for,
    /// such as the harness's own reminders, which stay available in `raw`.
    pub rendered: String,
}

/// A whole session ready to save.
#[derive(Debug, Default)]
pub struct Transcript {
    pub entries: Vec<Entry>,
    /// Identifies the transcript's content, to skip saving it twice.
    pub fingerprint: String,
    /// True when built from Elaris's own copy, whose tool output may be clipped.
    pub partial: bool,
}

/// The SDK's transcript for `agent_session_id`, looked for in every project
/// folder rather than by re-deriving the folder name from the path.
pub fn find(projects_dir: &Path, agent_session_id: &str) -> Option<PathBuf> {
    if agent_session_id.is_empty() || agent_session_id.contains(['/', '\\']) {
        return None;
    }
    let file = format!("{agent_session_id}.jsonl");
    fs::read_dir(projects_dir)
        .ok()?
        .filter_map(Result::ok)
        .map(|dir| dir.path().join(&file))
        .find(|path| path.is_file())
}

/// Every conversation line of the transcript at `path`, then each subagent's.
pub fn load(path: &Path) -> io::Result<Transcript> {
    let mut entries = Vec::new();
    let mut hash = Fnv::new();
    read_lines(path, None, &mut entries, &mut hash)?;

    let subagents = path.with_extension("").join("subagents");
    let mut files: Vec<PathBuf> = fs::read_dir(&subagents)
        .map(|dir| dir.filter_map(Result::ok).map(|e| e.path()).collect())
        .unwrap_or_default();
    files.retain(|p| p.extension().is_some_and(|ext| ext == "jsonl"));
    files.sort();
    for file in files {
        let agent = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let meta = fs::read_to_string(file.with_extension("meta.json")).unwrap_or_else(|_| "{}".into());
        entries.push(subagent_header(&agent, &meta));
        read_lines(&file, Some(&agent), &mut entries, &mut hash)?;
    }
    Ok(Transcript { entries, fingerprint: hash.finish(), partial: false })
}

/// Falls back to the chat as Elaris saved it, when the SDK's transcript is gone
/// (or never existed, as with the offline mock).
pub fn from_session(session: &Session) -> Transcript {
    let mut hash = Fnv::new();
    let entries = session
        .messages
        .iter()
        .map(|message| {
            let raw = serde_json::to_string(message).unwrap_or_default();
            hash.write(raw.as_bytes());
            message_entry(message, raw)
        })
        .collect();
    Transcript { entries, fingerprint: hash.finish(), partial: true }
}

fn read_lines(path: &Path, agent: Option<&str>, entries: &mut Vec<Entry>, hash: &mut Fnv) -> io::Result<()> {
    let text = fs::read_to_string(path)?;
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        if let Some(entry) = line_entry(line, agent) {
            hash.write(line.as_bytes());
            entries.push(entry);
        }
    }
    Ok(())
}

/// The entry for one transcript line, or `None` for bookkeeping lines.
pub fn line_entry(line: &str, agent: Option<&str>) -> Option<Entry> {
    let value: Value = serde_json::from_str(line).ok()?;
    let kind_of_line = value.get("type")?.as_str()?;
    if !KEPT.contains(&kind_of_line) {
        return None;
    }
    let content = value.get("message").and_then(|m| m.get("content"));
    let blocks: &[Value] = content.and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    let kind = blocks
        .first()
        .and_then(|b| b.get("type"))
        .and_then(Value::as_str)
        .unwrap_or(if content.is_some_and(Value::is_string) { "text" } else { kind_of_line })
        .to_owned();
    let tool_name = blocks
        .iter()
        .find(|b| b.get("type").and_then(Value::as_str) == Some("tool_use"))
        .and_then(|b| b.get("name"))
        .and_then(Value::as_str)
        .map(str::to_owned);

    let rendered = match kind_of_line {
        "user" => render_user(&value, content),
        "assistant" => blocks.iter().filter_map(render_assistant_block).collect::<Vec<_>>().join("\n\n"),
        "system" => match value.get("content").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) {
            Some(text) => {
                let subtype = value.get("subtype").and_then(Value::as_str).unwrap_or("message");
                format!("### System · {subtype}\n\n{text}")
            }
            None => String::new(),
        },
        "summary" => value
            .get("summary")
            .and_then(Value::as_str)
            .map(|s| format!("### Summary of earlier conversation\n\n{s}"))
            .unwrap_or_default(),
        // The harness's reminders (environment, skill lists, token counts):
        // kept verbatim, but not part of the conversation to read.
        _ => String::new(),
    };

    Some(Entry {
        agent: agent.map(str::to_owned),
        role: kind_of_line.to_owned(),
        kind,
        tool_name,
        raw: line.to_owned(),
        rendered,
    })
}

fn render_user(line: &Value, content: Option<&Value>) -> String {
    // Text the harness added (skill bodies, command output) rather than the person.
    let heading = if line.get("isMeta").and_then(Value::as_bool) == Some(true) { "### Added to the prompt" } else { "## You" };
    match content {
        Some(Value::String(text)) => format!("{heading}\n\n{text}"),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter_map(|block| match block.get("type").and_then(Value::as_str)? {
                "text" => Some(format!("{heading}\n\n{}", block.get("text")?.as_str()?)),
                "tool_result" => {
                    let id = block.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    let failed = block.get("is_error").and_then(Value::as_bool) == Some(true);
                    let status = if failed { "failed" } else { "ok" };
                    let body = result_text(block.get("content"));
                    Some(format!("### Result · {status} · {id}\n\n{}", fence(&body, "")))
                }
                "image" => Some(format!("{heading}\n\n{}", image_note(block))),
                "document" => Some(format!("{heading}\n\n[document]")),
                _ => Some(format!("{heading}\n\n{}", fence(&pretty(block), "json"))),
            })
            .collect::<Vec<_>>()
            .join("\n\n"),
        _ => String::new(),
    }
}

fn render_assistant_block(block: &Value) -> Option<String> {
    match block.get("type")?.as_str()? {
        "text" => {
            let text = block.get("text")?.as_str()?;
            (!text.trim().is_empty()).then(|| format!("## Elaris\n\n{text}"))
        }
        "thinking" => {
            let text = block.get("thinking")?.as_str()?;
            (!text.trim().is_empty()).then(|| format!("### Thinking\n\n{text}"))
        }
        "redacted_thinking" => None,
        "tool_use" | "server_tool_use" => {
            let name = block.get("name").and_then(Value::as_str).unwrap_or("tool");
            let id = block.get("id").and_then(Value::as_str).unwrap_or("");
            let input = block.get("input").cloned().unwrap_or(Value::Null);
            Some(format!("### Tool call · {name} · {id}\n\n{}", render_input(name, input)))
        }
        "image" => Some(format!("## Elaris\n\n{}", image_note(block))),
        _ => Some(format!("### {}\n\n{}", block.get("type")?.as_str()?, fence(&pretty(block), "json"))),
    }
}

/// A shell command reads best as itself; the rest of the input follows as JSON.
fn render_input(name: &str, input: Value) -> String {
    let command_key = match name {
        "Bash" | "mcp__terminal-access__run" => Some("command"),
        _ => None,
    };
    if let (Some(key), Value::Object(mut fields)) = (command_key, input.clone())
        && let Some(Value::String(command)) = fields.remove(key)
    {
        let rest = if fields.is_empty() { String::new() } else { format!("\n\n{}", fence(&pretty(&Value::Object(fields)), "json")) };
        return format!("{}{rest}", fence(&command, "sh"));
    }
    fence(&pretty(&input), "json")
}

/// A tool result's content (a string or content blocks) as text, all of it.
fn result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|block| match block.get("type").and_then(Value::as_str) {
                Some("text") => block.get("text").and_then(Value::as_str).unwrap_or("").to_owned(),
                Some("image") => image_note(block),
                _ => pretty(block),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Some(Value::Null) | None => String::new(),
        Some(other) => pretty(other),
    }
}

fn image_note(block: &Value) -> String {
    let media = block.pointer("/source/media_type").and_then(Value::as_str).unwrap_or("image");
    format!("[{media} attached; its data is kept in the raw entry]")
}

fn subagent_header(agent: &str, meta: &str) -> Entry {
    let info: Map<String, Value> = serde_json::from_str(meta).unwrap_or_default();
    let field = |key: &str| info.get(key).and_then(Value::as_str).unwrap_or("").to_owned();
    let (kind, description, tool) = (field("agentType"), field("description"), field("toolUseId"));
    let mut rendered = format!("# Subagent {agent}");
    if !kind.is_empty() {
        rendered.push_str(&format!(" · {kind}"));
    }
    if !description.is_empty() {
        rendered.push_str(&format!("\n\n{description}"));
    }
    if !tool.is_empty() {
        rendered.push_str(&format!("\n\nStarted by tool call {tool}. Everything below, up to the next heading like this one, is its own conversation."));
    }
    Entry {
        agent: Some(agent.to_owned()),
        role: "subagent".into(),
        kind: "subagent".into(),
        tool_name: None,
        raw: meta.to_owned(),
        rendered,
    }
}

/// Renders a message from Elaris's own copy of a chat.
fn message_entry(message: &Message, raw: String) -> Entry {
    let (role, rendered) = match message.role {
        MessageRole::User => {
            let mut text = format!("## You\n\n{}", message.content);
            for image in &message.images {
                text.push_str(&format!("\n\n[{} attached: {}]", image.media_type, image.name));
            }
            ("user", text)
        }
        MessageRole::Assistant => {
            let mut parts =
                if message.parts.is_empty() { vec![format!("## Elaris\n\n{}", message.content)] } else { render_parts(&message.parts) };
            for agent in &message.agents {
                parts.push(format!("# Subagent {} · {}", agent.id, agent.description));
                parts.extend(render_parts(&agent.parts));
            }
            ("assistant", parts.join("\n\n"))
        }
    };
    let tool_name = message.parts.iter().find_map(|p| match p {
        Part::Tool { name, .. } => Some(name.clone()),
        _ => None,
    });
    Entry { agent: None, role: role.into(), kind: "message".into(), tool_name, raw, rendered }
}

fn render_parts(parts: &[Part]) -> Vec<String> {
    parts
        .iter()
        .map(|part| match part {
            Part::Text { text } => format!("## Elaris\n\n{text}"),
            Part::Input { text } => format!("## You\n\n{text}"),
            Part::Tool { id, name, input, output, status, .. } => {
                let mut text = format!("### Tool call · {name} · {id}\n\n{}", render_input(name, input.clone()));
                if let Some(output) = output {
                    let status = format!("{status:?}").to_lowercase();
                    text.push_str(&format!("\n\n### Result · {status} · {id}\n\n{}", fence(output, "")));
                }
                text
            }
        })
        .collect()
}

/// `text` in a code fence long enough that nothing inside can close it.
pub fn fence(text: &str, lang: &str) -> String {
    let mut longest = 0;
    let mut run = 0;
    for c in text.chars() {
        run = if c == '`' { run + 1 } else { 0 };
        longest = longest.max(run);
    }
    let ticks = "`".repeat((longest + 1).max(3));
    format!("{ticks}{lang}\n{text}\n{ticks}")
}

fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// FNV-1a: small, stable across builds, and plenty to tell transcripts apart.
struct Fnv(u64);

impl Fnv {
    fn new() -> Self {
        Self(0xcbf2_9ce4_8422_2325)
    }

    fn write(&mut self, bytes: &[u8]) {
        for byte in bytes {
            self.0 ^= u64::from(*byte);
            self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
        }
        // Line boundaries count too.
        self.0 ^= 0xff;
        self.0 = self.0.wrapping_mul(0x0100_0000_01b3);
    }

    fn finish(&self) -> String {
        format!("{:016x}", self.0)
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn renders_tool_calls_and_results_whole() {
        let big = "line\n".repeat(50_000);
        let call = json!({"type":"assistant","message":{"role":"assistant","content":[
            {"type":"tool_use","id":"t1","name":"Bash","input":{"command":"adb devices","description":"List devices"}}
        ]}});
        let result = json!({"type":"user","message":{"role":"user","content":[
            {"type":"tool_result","tool_use_id":"t1","content":big,"is_error":false}
        ]}});

        let call = line_entry(&call.to_string(), None).unwrap();
        assert_eq!(call.tool_name.as_deref(), Some("Bash"));
        assert!(call.rendered.contains("```sh\nadb devices\n```"), "{}", call.rendered);
        assert!(call.rendered.contains("\"description\": \"List devices\""));

        let result = line_entry(&result.to_string(), None).unwrap();
        assert_eq!(result.kind, "tool_result");
        assert!(result.rendered.contains(&big), "the whole output is kept");
    }

    #[test]
    fn keeps_thinking_and_skips_bookkeeping() {
        let thinking = json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"Check the device first."}]}});
        assert!(line_entry(&thinking.to_string(), None).unwrap().rendered.contains("### Thinking\n\nCheck the device first."));
        assert!(line_entry(r#"{"type":"api-request-blob","message":{}}"#, None).is_none());
        assert!(line_entry(r#"{"type":"cost-state"}"#, None).is_none());

        // Harness reminders are kept verbatim but not rendered.
        let reminder = line_entry(r#"{"type":"attachment","attachment":{"type":"date"}}"#, None).unwrap();
        assert_eq!(reminder.rendered, "");
    }

    #[test]
    fn fences_outlast_backticks_inside() {
        assert_eq!(fence("a ``` b", ""), "````\na ``` b\n````");
    }

    #[test]
    fn loads_subagents_after_the_main_conversation() {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("-tmp-app");
        fs::create_dir_all(project.join("s1/subagents")).unwrap();
        fs::write(
            project.join("s1.jsonl"),
            [
                r#"{"type":"user","message":{"role":"user","content":"Set up adb"}}"#,
                r#"{"type":"api-request","params":{}}"#,
                r#"{"type":"assistant","message":{"content":[{"type":"text","text":"Done."}]}}"#,
            ]
            .join("\n"),
        )
        .unwrap();
        fs::write(project.join("s1/subagents/agent-a.jsonl"), r#"{"type":"user","message":{"content":"Find adb"}}"#).unwrap();
        fs::write(project.join("s1/subagents/agent-a.meta.json"), r#"{"agentType":"Explore","toolUseId":"t9"}"#).unwrap();

        let path = find(dir.path(), "s1").unwrap();
        let transcript = load(&path).unwrap();
        let roles: Vec<_> = transcript.entries.iter().map(|e| (e.role.as_str(), e.agent.as_deref())).collect();
        assert_eq!(
            roles,
            [("user", None), ("assistant", None), ("subagent", Some("agent-a")), ("user", Some("agent-a"))]
        );
        assert!(transcript.entries[2].rendered.contains("Explore"));
        assert!(!transcript.partial);
        assert!(find(dir.path(), "../s1").is_none());
    }
}
