//! The agent's `elaris-context` tool, which only Elaris provides: it reads
//! the saved contexts (whole earlier sessions) the user hands a chat with
//! `#ctx-…`, page by page, so ones too large for the prompt still arrive whole.

use agent_core::ContextsRequest;
use contexts::{ContextStore, PAGE_CHARS, render_terminal};

const SEARCH_HITS: usize = 20;

/// Carries out one call, returning what the tool call answers (an `Err` is
/// reported to the agent as a failed call).
pub fn handle(store: &ContextStore, request: ContextsRequest) -> Result<String, String> {
    let id = |id: &str| id.trim().trim_start_matches('#').to_owned();
    let text = match request {
        ContextsRequest::List { query } => {
            let saved = store.list(query.as_deref()).map_err(|e| e.to_string())?;
            if saved.is_empty() {
                return Ok("No saved contexts match.".into());
            }
            saved
                .iter()
                .map(|s| {
                    let place = s.workspace.as_deref().map(|w| format!(" · {w}")).unwrap_or_default();
                    format!("#{} · {} · {} entries · ~{} tokens{place}", s.id, s.title, s.entries, s.tokens)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        ContextsRequest::Overview { id: ctx } => store.overview(&id(&ctx)).map_err(|e| e.to_string())?,
        ContextsRequest::Read { id: ctx, from_seq, offset, max_chars } => store
            .read(&id(&ctx), from_seq.unwrap_or(0), offset.unwrap_or(0), max_chars.unwrap_or(PAGE_CHARS))
            .map_err(|e| e.to_string())?,
        ContextsRequest::Search { id: ctx, query, limit } => {
            let ctx = ctx.as_deref().map(id);
            let hits = store
                .search(ctx.as_deref(), &query, limit.unwrap_or(SEARCH_HITS))
                .map_err(|e| e.to_string())?;
            if hits.is_empty() {
                return Ok(format!("Nothing matches \"{query}\"."));
            }
            hits.iter()
                .map(|hit| format!("#{} seq {}: {}", hit.context_id, hit.seq, hit.snippet.replace('\n', " ")))
                .collect::<Vec<_>>()
                .join("\n")
        }
        ContextsRequest::Raw { id: ctx, seq } => store.raw(&id(&ctx), seq).map_err(|e| e.to_string())?,
        ContextsRequest::Terminals { id: ctx } => {
            let terminals = store.terminals(&id(&ctx)).map_err(|e| e.to_string())?;
            if terminals.is_empty() {
                "The session had no terminals open when it was saved.".into()
            } else {
                terminals.iter().map(render_terminal).collect::<Vec<_>>().join("\n\n")
            }
        }
    };
    Ok(text)
}
