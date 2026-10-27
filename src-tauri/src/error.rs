use serde::{Serialize, Serializer};

/// Every command failure, sent to the UI as a plain message string.
#[derive(Debug, thiserror::Error)]
pub enum CommandError {
    #[error(transparent)]
    Workspace(#[from] workspace::Error),
    #[error(transparent)]
    Store(#[from] crate::store::Error),
    #[error(transparent)]
    Customizations(#[from] customizations::Error),
    #[error(transparent)]
    Code(#[from] code_intelligence::Error),
    #[error(transparent)]
    Terminal(#[from] terminal::Error),
    #[error("No folder is open")]
    NoWorkspace,
    #[error("A reply is already in progress in this chat")]
    AlreadyStreaming,
    #[error("{0}")]
    Image(String),
    #[error("{0}")]
    Agent(String),
    #[error("Background task failed: {0}")]
    Task(String),
}

impl Serialize for CommandError {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

/// Runs blocking file-system or git work on the blocking pool so commands
/// never stall the async runtime.
pub async fn blocking<T, E>(work: impl FnOnce() -> Result<T, E> + Send + 'static) -> CommandResult<T>
where
    T: Send + 'static,
    E: Into<CommandError> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|e| CommandError::Task(e.to_string()))?
        .map_err(Into::into)
}
