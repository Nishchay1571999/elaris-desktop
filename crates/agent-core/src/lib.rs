//! Elaris agents.
//!
//! - [`ClaudeAgent`] runs the Claude Agent SDK. The SDK only exists for
//!   TypeScript and Python, so it lives in a small Node sidecar
//!   (`apps/desktop/sidecar`) that this module starts, feeds and supervises
//!   over stdio.
//! - [`MockAgent`] is a local, deterministic stand-in that streams canned
//!   Markdown, for working offline. Nothing it says is AI output.

mod claude;
mod mock;

pub use claude::{
    ClaudeAgent, ContextsRequest, DesktopRequest, MouseButton, Notice, ResultImage, ScrollDirection, SidecarCommand,
    TerminalRequest,
};
pub use mock::MockAgent;
pub use tokio_util::sync::CancellationToken;

/// How a run ended. The final event has already been emitted.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RunOutcome {
    Finished,
    Stopped,
    Failed,
}
