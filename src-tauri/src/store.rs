//! Sessions persisted as one JSON file each under the app data folder, plus a
//! small settings file. Images attached to a chat sit in a folder of its own
//! under `attachments`. Writes go to a temp file first and are renamed into
//! place, so a crash never leaves a half-written session.

use std::collections::HashMap;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_protocol::{ImageAttachment, MessageStatus, Session, SessionSummary};
use serde::{Deserialize, Serialize};

const MAX_RECENT_WORKSPACES: usize = 8;

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("Chat not found")]
    NotFound,
    #[error("Invalid chat id")]
    InvalidId,
    #[error("Unsupported image type: {0}")]
    ImageType(String),
    #[error("Storage error: {0}")]
    Io(#[from] io::Error),
    #[error("Corrupt data: {0}")]
    Json(#[from] serde_json::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    recent_workspaces: Vec<String>,
    /// Permission rules the user chose to always allow, by workspace root.
    allowed_tools: HashMap<String, Vec<String>>,
}

pub struct Store {
    sessions_dir: PathBuf,
    attachments_dir: PathBuf,
    settings_path: PathBuf,
    /// Serialises read-modify-write cycles.
    lock: Mutex<()>,
}

impl Store {
    pub fn open(data_dir: &Path) -> Result<Self> {
        let sessions_dir = data_dir.join("sessions");
        fs::create_dir_all(&sessions_dir)?;
        let store = Self {
            sessions_dir,
            attachments_dir: data_dir.join("attachments"),
            settings_path: data_dir.join("settings.json"),
            lock: Mutex::new(()),
        };
        store.recover_interrupted()?;
        Ok(store)
    }

    /// Newest first. Unreadable files are skipped rather than failing the list.
    pub fn list(&self) -> Result<Vec<SessionSummary>> {
        let _guard = self.lock.lock().unwrap();
        let mut summaries: Vec<SessionSummary> = self
            .session_files()?
            .filter_map(|path| read_json::<Session>(&path).ok())
            .map(|session| SessionSummary::from(&session))
            .collect();
        summaries.sort_by(|a, b| b.updated_at.cmp(&a.updated_at));
        Ok(summaries)
    }

    pub fn get(&self, id: &str) -> Result<Session> {
        let _guard = self.lock.lock().unwrap();
        self.read(id)
    }

    pub fn insert(&self, session: &Session) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        self.write(session)
    }

    /// Loads, mutates and saves a session atomically with respect to other
    /// store calls; returns the saved copy.
    pub fn update(&self, id: &str, change: impl FnOnce(&mut Session)) -> Result<Session> {
        let _guard = self.lock.lock().unwrap();
        let mut session = self.read(id)?;
        change(&mut session);
        self.write(&session)?;
        Ok(session)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        ignore_missing(fs::remove_file(self.path_for(id)?))?;
        ignore_missing(fs::remove_dir_all(self.attachments_dir.join(checked(id)?)))
    }

    /// Saves an image for chat `session_id` and describes it for the message.
    pub fn save_image(&self, session_id: &str, media_type: &str, name: &str, bytes: &[u8]) -> Result<ImageAttachment> {
        let image = ImageAttachment {
            id: uuid::Uuid::new_v4().to_string(),
            media_type: media_type.to_owned(),
            name: name.to_owned(),
        };
        let path = self.image_path(session_id, &image)?;
        fs::create_dir_all(path.parent().expect("image paths have a folder"))?;
        fs::write(&path, bytes)?;
        Ok(image)
    }

    /// Where an attached image is kept.
    pub fn image_path(&self, session_id: &str, image: &ImageAttachment) -> Result<PathBuf> {
        let ext = match image.media_type.as_str() {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            other => return Err(Error::ImageType(other.to_owned())),
        };
        Ok(self.attachments_dir.join(checked(session_id)?).join(format!("{}.{ext}", checked(&image.id)?)))
    }

    pub fn recent_workspaces(&self) -> Vec<String> {
        let _guard = self.lock.lock().unwrap();
        read_json::<Settings>(&self.settings_path).unwrap_or_default().recent_workspaces
    }

    /// Moves `root` to the front of the recent list.
    pub fn remember_workspace(&self, root: &str) -> Result<()> {
        let _guard = self.lock.lock().unwrap();
        let mut settings = read_json::<Settings>(&self.settings_path).unwrap_or_default();
        settings.recent_workspaces.retain(|r| r != root);
        settings.recent_workspaces.insert(0, root.to_owned());
        settings.recent_workspaces.truncate(MAX_RECENT_WORKSPACES);
        write_json(&self.settings_path, &settings)
    }

    pub fn allowed_tools(&self, root: &str) -> Vec<String> {
        let _guard = self.lock.lock().unwrap();
        let mut settings = read_json::<Settings>(&self.settings_path).unwrap_or_default();
        settings.allowed_tools.remove(root).unwrap_or_default()
    }

    /// Adds `rules` to the workspace's always-allowed list, skipping repeats.
    pub fn allow_tools(&self, root: &str, rules: &[String]) -> Result<Vec<String>> {
        self.change_allowed_tools(root, |allowed| {
            for rule in rules {
                if !allowed.contains(rule) {
                    allowed.push(rule.clone());
                }
            }
        })
    }

    pub fn forget_tool(&self, root: &str, rule: &str) -> Result<Vec<String>> {
        self.change_allowed_tools(root, |allowed| allowed.retain(|r| r != rule))
    }

    fn change_allowed_tools(&self, root: &str, change: impl FnOnce(&mut Vec<String>)) -> Result<Vec<String>> {
        let _guard = self.lock.lock().unwrap();
        let mut settings = read_json::<Settings>(&self.settings_path).unwrap_or_default();
        let allowed = settings.allowed_tools.entry(root.to_owned()).or_default();
        change(allowed);
        let result = allowed.clone();
        if result.is_empty() {
            settings.allowed_tools.remove(root);
        }
        write_json(&self.settings_path, &settings)?;
        Ok(result)
    }

    /// Replies that were streaming when the app quit can never finish; mark
    /// them stopped so the UI doesn't show a caret forever.
    fn recover_interrupted(&self) -> Result<()> {
        for path in self.session_files()? {
            let Ok(mut session) = read_json::<Session>(&path) else { continue };
            let mut changed = false;
            for message in &mut session.messages {
                if message.status == MessageStatus::Streaming {
                    message.finish(MessageStatus::Stopped);
                    changed = true;
                }
            }
            if changed {
                write_json(&path, &session)?;
            }
        }
        Ok(())
    }

    fn session_files(&self) -> Result<impl Iterator<Item = PathBuf>> {
        Ok(fs::read_dir(&self.sessions_dir)?
            .filter_map(|entry| entry.ok().map(|e| e.path()))
            .filter(|path| path.extension().is_some_and(|ext| ext == "json")))
    }

    fn path_for(&self, id: &str) -> Result<PathBuf> {
        Ok(self.sessions_dir.join(format!("{}.json", checked(id)?)))
    }

    fn read(&self, id: &str) -> Result<Session> {
        match read_json(&self.path_for(id)?) {
            Err(Error::Io(e)) if e.kind() == io::ErrorKind::NotFound => Err(Error::NotFound),
            other => other,
        }
    }

    fn write(&self, session: &Session) -> Result<()> {
        write_json(&self.path_for(&session.id)?, session)
    }
}

/// `id`, if it is safe to use as a file name (no separators or dots).
fn checked(id: &str) -> Result<&str> {
    let valid = !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if valid { Ok(id) } else { Err(Error::InvalidId) }
}

fn ignore_missing(result: io::Result<()>) -> Result<()> {
    match result {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        other => Ok(other?),
    }
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T> {
    Ok(serde_json::from_slice(&fs::read(path)?)?)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use agent_protocol::{AgentMode, Message, MessageRole, PermissionPolicy};

    use super::*;

    fn session(id: &str, updated_at: i64, status: MessageStatus) -> Session {
        Session {
            id: id.into(),
            title: id.into(),
            created_at: 0,
            updated_at,
            mode: AgentMode::Agent,
            model: "mock".into(),
            permissions: PermissionPolicy::Ask,
            workspace: None,
            agent_session_id: None,
            usage: Default::default(),
            context: 0,
            messages: vec![Message {
                id: "m".into(),
                role: MessageRole::Assistant,
                content: String::new(),
                parts: Vec::new(),
                images: Vec::new(),
                agents: Vec::new(),
                created_at: 0,
                status,
                error: None,
            }],
        }
    }

    #[test]
    fn round_trips_and_lists_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.insert(&session("old", 1, MessageStatus::Complete)).unwrap();
        store.insert(&session("new", 2, MessageStatus::Complete)).unwrap();

        let ids: Vec<_> = store.list().unwrap().into_iter().map(|s| s.id).collect();
        assert_eq!(ids, ["new", "old"]);

        store.update("old", |s| s.title = "renamed".into()).unwrap();
        assert_eq!(store.get("old").unwrap().title, "renamed");

        store.delete("old").unwrap();
        assert!(matches!(store.get("old"), Err(Error::NotFound)));
    }

    #[test]
    fn rejects_ids_that_could_escape_the_folder() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        assert!(matches!(store.get("../settings"), Err(Error::InvalidId)));
    }

    #[test]
    fn keeps_images_with_their_chat() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.insert(&session("s", 1, MessageStatus::Complete)).unwrap();
        let image = store.save_image("s", "image/png", "shot.png", b"png").unwrap();
        let path = store.image_path("s", &image).unwrap();
        assert_eq!(fs::read(&path).unwrap(), b"png");

        let escape = ImageAttachment { id: "../../settings".into(), ..image.clone() };
        assert!(matches!(store.image_path("s", &escape), Err(Error::InvalidId)));
        let tiff = ImageAttachment { media_type: "image/tiff".into(), ..image };
        assert!(matches!(store.image_path("s", &tiff), Err(Error::ImageType(_))));

        store.delete("s").unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn marks_interrupted_replies_stopped_on_open() {
        let dir = tempfile::tempdir().unwrap();
        Store::open(dir.path()).unwrap().insert(&session("s", 1, MessageStatus::Streaming)).unwrap();

        let reopened = Store::open(dir.path()).unwrap();
        assert_eq!(reopened.get("s").unwrap().messages[0].status, MessageStatus::Stopped);
    }

    #[test]
    fn keeps_recent_workspaces_unique_and_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.remember_workspace("/a").unwrap();
        store.remember_workspace("/b").unwrap();
        store.remember_workspace("/a").unwrap();
        assert_eq!(store.recent_workspaces(), ["/a", "/b"]);
    }

    #[test]
    fn keeps_allowed_tools_per_workspace_without_repeats() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        store.remember_workspace("/a").unwrap();
        store.allow_tools("/a", &["Edit".into(), "Bash(ls:*)".into()]).unwrap();
        store.allow_tools("/a", &["Edit".into()]).unwrap();
        store.allow_tools("/b", &["Write".into()]).unwrap();

        assert_eq!(store.allowed_tools("/a"), ["Edit", "Bash(ls:*)"]);
        assert_eq!(store.allowed_tools("/b"), ["Write"]);
        assert_eq!(store.recent_workspaces(), ["/a"]);

        assert_eq!(store.forget_tool("/a", "Edit").unwrap(), ["Bash(ls:*)"]);
        assert!(Store::open(dir.path()).unwrap().allowed_tools("/c").is_empty());
    }
}
