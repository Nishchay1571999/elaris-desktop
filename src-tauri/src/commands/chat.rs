use std::path::PathBuf;

use agent_core::{MockAgent, Notice, RunOutcome};
use agent_protocol::{
    AgentEvent, AgentRequest, Answers, ImageAttachment, LiveReply, MOCK_MODEL, Message, MessageRole, MessageStatus,
    PermissionDecision, PromptImage, Session,
};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde::Deserialize;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::agent_terminal;
use crate::error::{CommandError, CommandResult, blocking};
use crate::state::AppState;
use crate::store::now_ms;

const TITLE_LENGTH: usize = 60;
/// The Claude API's per-image limit.
const MAX_IMAGE_BYTES: usize = 5 * 1024 * 1024;
const MAX_IMAGES: usize = 20;

/// An image pasted or dropped into the composer, base64-encoded.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewImage {
    media_type: String,
    #[serde(default)]
    name: String,
    data: String,
}

/// Appends the user's message and an empty streaming reply, returns the
/// updated session, then runs the chat's agent in the background, streaming
/// over `on_event`. The reply is saved as it goes (after each tool call) and
/// at the end, whether or not any window is still listening.
#[tauri::command]
pub fn chat_send(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    text: String,
    images: Vec<NewImage>,
    on_event: Channel<AgentEvent>,
) -> CommandResult<Session> {
    let now = now_ms();
    let reply = message(MessageRole::Assistant, String::new(), MessageStatus::Streaming, now);
    let cancel = state.begin_run(&session_id, reply.clone(), on_event)?;
    let images = match save_images(&state, &session_id, images) {
        Ok(images) => images,
        Err(e) => {
            state.end_run(&session_id);
            return Err(e);
        }
    };

    let appended = state.store.update(&session_id, |session| {
        if session.messages.is_empty() {
            session.title = if text.trim().is_empty() { "Image".into() } else { title_from(&text) };
        }
        let mut prompt = message(MessageRole::User, text.clone(), MessageStatus::Complete, now);
        prompt.images = images.clone();
        session.messages.push(prompt);
        session.messages.push(reply.clone());
        session.updated_at = now;
    });
    let session = match appended {
        Ok(session) => session,
        Err(e) => {
            state.end_run(&session_id);
            return Err(e.into());
        }
    };

    let workspace = state.workspace();
    // Run where the chat started; fall back to whatever is open now.
    let cwd: Option<PathBuf> =
        session.workspace.clone().map(Into::into).or_else(|| workspace.as_ref().map(|w| w.root().to_path_buf()));
    // Always-allow rules are kept by this folder.
    let root = cwd.as_ref().map(|dir| dir.display().to_string());
    let request = AgentRequest {
        session_id: session_id.clone(),
        messages: session
            .messages
            .iter()
            .filter(|m| m.status == MessageStatus::Complete)
            .map(|m| (m.role, m.content.clone()))
            .collect(),
        settings: session.settings(),
        cwd,
        workspace_name: workspace.and_then(|w| w.root().file_name().map(|n| n.to_string_lossy().into_owned())),
        resume: session.agent_session_id.clone(),
        allowed_tools: root.as_deref().map(|root| state.store.allowed_tools(root)).unwrap_or_default(),
        // Just saved, so their paths are valid.
        images: images
            .iter()
            .filter_map(|image| {
                let path = state.store.image_path(&session_id, image).ok()?;
                Some(PromptImage { media_type: image.media_type.clone(), path })
            })
            .collect(),
    };

    tauri::async_runtime::spawn(async move {
        let state = app.state::<AppState>();
        let save = |reply: &Message| {
            // Fails only if the chat was deleted mid-reply, which is fine.
            let _ = state.store.update(&session_id, |session| {
                if let Some(slot) = session.messages.iter_mut().find(|m| m.id == reply.id) {
                    *slot = reply.clone();
                }
                session.updated_at = now_ms();
            });
        };
        let mut emit = |event: AgentEvent| {
            state.publish(&session_id, &event);
            if let AgentEvent::Usage { usage } = &event {
                let _ = state.store.update(&session_id, |session| session.usage += *usage);
            }
            if matches!(event, AgentEvent::ToolEnd { .. })
                && let Some(reply) = state.reply(&session_id)
            {
                save(&reply);
            }
        };

        let outcome = if request.settings.model == MOCK_MODEL {
            MockAgent::default().run(&request, &cancel, &mut emit).await
        } else {
            let on_notice = |notice: Notice| match notice {
                Notice::Session(agent_session_id) => {
                    let _ = state.store.update(&session_id, |s| s.agent_session_id = Some(agent_session_id));
                }
                Notice::AllowRules(rules) => {
                    if let Some(root) = &root {
                        let _ = state.store.allow_tools(root, &rules);
                    }
                }
                // Commands can run for minutes, so the reply keeps streaming meanwhile.
                Notice::Terminal { request_id, request: call } => {
                    let (app, session_id, cwd) = (app.clone(), session_id.clone(), request.cwd.clone());
                    tauri::async_runtime::spawn(async move {
                        let state = app.state::<AppState>();
                        let cx = agent_terminal::Context {
                            terminals: &state.terminals,
                            reads: &state.agent_reads,
                            session_id: &session_id,
                            cwd: cwd.as_deref(),
                            alive: &|| state.is_running(&session_id),
                            opened: &|terminal| {
                                let _ = app.emit(agent_terminal::OPENED_EVENT, terminal);
                            },
                        };
                        let result = agent_terminal::handle(&cx, call).await;
                        let (ok, text) = match result {
                            Ok(text) => (true, text),
                            Err(text) => (false, text),
                        };
                        let _ = state.claude.answer_terminal(&session_id, &request_id, ok, &text).await;
                    });
                }
            };
            state.claude.run(&request, &cancel, &mut emit, on_notice).await
        };

        let Some(mut reply) = state.end_run(&session_id) else { return };
        if reply.status == MessageStatus::Streaming {
            // Every outcome emits a terminal event; this is a safety net.
            reply.finish(match outcome {
                RunOutcome::Finished => MessageStatus::Complete,
                RunOutcome::Stopped => MessageStatus::Stopped,
                RunOutcome::Failed => MessageStatus::Error,
            });
        }
        save(&reply);
    });

    Ok(session)
}

/// Decodes and saves the composer's images before the message that shows them.
fn save_images(state: &AppState, session_id: &str, images: Vec<NewImage>) -> CommandResult<Vec<ImageAttachment>> {
    if images.len() > MAX_IMAGES {
        return Err(CommandError::Image(format!("Attach at most {MAX_IMAGES} images at a time")));
    }
    images
        .into_iter()
        .map(|image| {
            let bytes = BASE64.decode(&image.data).map_err(|e| CommandError::Image(format!("Unreadable image: {e}")))?;
            if bytes.len() > MAX_IMAGE_BYTES {
                return Err(CommandError::Image(format!("{} is larger than 5 MB", display_name(&image.name))));
            }
            Ok(state.store.save_image(session_id, &image.media_type, &image.name, &bytes)?)
        })
        .collect()
}

fn display_name(name: &str) -> &str {
    if name.is_empty() { "The image" } else { name }
}

/// An attached image as a `data:` URL the UI can show.
#[tauri::command]
pub async fn chat_image(app: AppHandle, session_id: String, image: ImageAttachment) -> CommandResult<String> {
    blocking(move || -> CommandResult<String> {
        let path = app.state::<AppState>().store.image_path(&session_id, &image)?;
        let bytes = std::fs::read(path).map_err(crate::store::Error::from)?;
        Ok(format!("data:{};base64,{}", image.media_type, BASE64.encode(bytes)))
    })
    .await
}

/// Follows the reply streaming in `session_id` from a window that missed its
/// start (it reloaded). Returns `None` when nothing is streaming there.
#[tauri::command]
pub fn chat_attach(
    state: State<'_, AppState>,
    session_id: String,
    on_event: Channel<AgentEvent>,
) -> Option<LiveReply> {
    state.attach(&session_id, on_event)
}

/// Ids of chats with a reply in flight.
#[tauri::command]
pub fn chat_running(state: State<'_, AppState>) -> Vec<String> {
    state.running()
}

#[tauri::command]
pub fn chat_stop(state: State<'_, AppState>, session_id: String) {
    state.cancel_run(&session_id);
}

/// Answers a `permission-request` event from the chat's running agent.
#[tauri::command]
pub async fn chat_permission(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    decision: PermissionDecision,
) -> CommandResult<()> {
    state
        .claude
        .answer_permission(&session_id, &request_id, decision)
        .await
        .map_err(CommandError::Agent)
}

/// Answers a `question` event from the chat's running agent; `None` skips it.
#[tauri::command]
pub async fn chat_answer(
    state: State<'_, AppState>,
    session_id: String,
    request_id: String,
    answers: Option<Answers>,
) -> CommandResult<()> {
    state
        .claude
        .answer_question(&session_id, &request_id, answers.as_ref())
        .await
        .map_err(CommandError::Agent)
}

/// Rules the user chose to always allow in the workspace at `root`.
#[tauri::command]
pub fn permissions_list(state: State<'_, AppState>, root: String) -> Vec<String> {
    state.store.allowed_tools(&root)
}

/// Removes one always-allow rule; returns the ones left.
#[tauri::command]
pub fn permissions_forget(state: State<'_, AppState>, root: String, rule: String) -> CommandResult<Vec<String>> {
    Ok(state.store.forget_tool(&root, &rule)?)
}

fn message(role: MessageRole, content: String, status: MessageStatus, now: i64) -> Message {
    Message {
        id: uuid::Uuid::new_v4().to_string(),
        role,
        content,
        parts: Vec::new(),
        images: Vec::new(),
        created_at: now,
        status,
        error: None,
    }
}

fn title_from(text: &str) -> String {
    let one_line = text.split_whitespace().collect::<Vec<_>>().join(" ");
    if one_line.chars().count() <= TITLE_LENGTH {
        return one_line;
    }
    let cut: String = one_line.chars().take(TITLE_LENGTH - 1).collect();
    format!("{}…", cut.trim_end())
}
