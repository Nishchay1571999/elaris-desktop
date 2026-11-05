//! Saved pull requests and issues: a snapshot of one, as Markdown, with copies
//! of its attachments, under a short id such as `pr-7f3k2q` or `issue-7f3k2q`.
//! Another chat references one as `%pr-7f3k2q`; it goes into the prompt whole,
//! and its images go to the agent as images.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use ts_rs::TS;

use crate::{Error, Result, attr, estimate_tokens, now_ms, random_body};

pub(crate) const SCHEMA: &str = "
CREATE TABLE items (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    state TEXT NOT NULL,
    url TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    markdown TEXT NOT NULL
);
CREATE INDEX items_by_source ON items (kind, repo, number, created_at);
CREATE TABLE item_assets (
    item_id TEXT NOT NULL REFERENCES items (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    url TEXT NOT NULL,
    name TEXT NOT NULL,
    content_type TEXT NOT NULL,
    path TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (item_id, seq)
);
";

/// Images the agent is sent as images; other attachments it reads from disk.
const SENDABLE_IMAGES: &[&str] = &["image/png", "image/jpeg", "image/gif", "image/webp"];
/// The Claude API's per-image limit.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// A saved pull request or issue as lists and pickers show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ItemSummary {
    /// e.g. `pr-7f3k2q`; referenced as `%pr-7f3k2q`.
    pub id: String,
    /// `pr` or `issue`.
    pub kind: String,
    /// `owner/name`.
    pub repo: String,
    pub number: u32,
    pub title: String,
    /// As GitHub said when it was saved: `OPEN`, `CLOSED` or `MERGED`.
    pub state: String,
    pub url: String,
    /// Epoch milliseconds.
    #[ts(type = "number")]
    pub created_at: i64,
    /// Attachments saved with it.
    pub assets: u32,
    /// Estimated tokens of its text.
    #[ts(type = "number")]
    pub tokens: u64,
}

/// An attachment downloaded for [`NewItem`]; [`crate::ContextStore::save_item`] copies it.
pub struct NewAsset {
    pub url: String,
    pub name: String,
    pub content_type: String,
    /// Where it was downloaded to.
    pub path: PathBuf,
}

/// What [`crate::ContextStore::save_item`] saves.
pub struct NewItem {
    pub kind: String,
    pub repo: String,
    pub number: u32,
    pub title: String,
    pub state: String,
    pub url: String,
    /// The pull request or issue, rendered: description, comments, reviews…
    pub markdown: String,
    pub assets: Vec<NewAsset>,
}

/// A saved attachment.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ItemAsset {
    pub url: String,
    pub name: String,
    pub content_type: String,
    pub path: PathBuf,
    pub size: u64,
}

impl ItemAsset {
    /// The agent can be sent it as an image.
    pub fn sendable(&self) -> bool {
        SENDABLE_IMAGES.contains(&self.content_type.as_str()) && self.size <= MAX_IMAGE_BYTES
    }
}

const SUMMARY_COLUMNS: &str = "id, kind, repo, number, title, state, url, created_at,
    (SELECT COUNT(*) FROM item_assets WHERE item_id = items.id), length(markdown)";

fn summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ItemSummary> {
    Ok(ItemSummary {
        id: row.get(0)?,
        kind: row.get(1)?,
        repo: row.get(2)?,
        number: row.get(3)?,
        title: row.get(4)?,
        state: row.get(5)?,
        url: row.get(6)?,
        created_at: row.get(7)?,
        assets: row.get(8)?,
        tokens: estimate_tokens(row.get(9)?),
    })
}

pub(crate) fn summary(db: &Connection, id: &str) -> Result<ItemSummary> {
    db.query_row(&format!("SELECT {SUMMARY_COLUMNS} FROM items WHERE id = ?1"), [id], summary_row)
        .optional()?
        .ok_or_else(|| Error::NotFound(id.to_owned()))
}

pub(crate) fn list(db: &Connection, pattern: &str) -> Result<Vec<ItemSummary>> {
    let mut stmt = db.prepare(&format!(
        "SELECT {SUMMARY_COLUMNS} FROM items
         WHERE id LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\' OR (repo || '#' || number) LIKE ?1 ESCAPE '\\'
         ORDER BY created_at DESC"
    ))?;
    let rows = stmt.query_map([pattern], summary_row)?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn assets(db: &Connection, id: &str) -> Result<Vec<ItemAsset>> {
    let mut stmt = db.prepare("SELECT url, name, content_type, path, size FROM item_assets WHERE item_id = ?1 ORDER BY seq")?;
    let rows = stmt.query_map([id], |row| {
        Ok(ItemAsset {
            url: row.get(0)?,
            name: row.get(1)?,
            content_type: row.get(2)?,
            path: PathBuf::from(row.get::<_, String>(3)?),
            size: row.get::<_, i64>(4)? as u64,
        })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub(crate) fn markdown(db: &Connection, id: &str) -> Result<String> {
    db.query_row("SELECT markdown FROM items WHERE id = ?1", [id], |row| row.get(0))
        .optional()?
        .ok_or_else(|| Error::NotFound(id.to_owned()))
}

/// Saves `item`, copying its attachments into `assets_dir/<id>/`. If its newest
/// snapshot reads the same, returns that one instead of a duplicate.
pub(crate) fn save(db: &mut Connection, item: NewItem, assets_dir: &Path) -> Result<ItemSummary> {
    let same: Option<String> = db
        .query_row(
            "SELECT id FROM items WHERE kind = ?1 AND repo = ?2 AND number = ?3 AND markdown = ?4
             AND (SELECT COUNT(*) FROM item_assets WHERE item_id = items.id) = ?5
             ORDER BY created_at DESC LIMIT 1",
            params![item.kind, item.repo, item.number, item.markdown, item.assets.len() as i64],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(id) = same {
        return summary(db, &id);
    }

    let tx = db.transaction()?;
    let id = new_id(&tx, &item.kind)?;
    let dir = assets_dir.join(&id);
    if !item.assets.is_empty() {
        std::fs::create_dir_all(&dir)?;
    }
    tx.execute(
        "INSERT INTO items (id, kind, repo, number, title, state, url, created_at, markdown)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        params![id, item.kind, item.repo, item.number, item.title, item.state, item.url, now_ms(), item.markdown],
    )?;
    {
        let mut insert = tx.prepare(
            "INSERT INTO item_assets (item_id, seq, url, name, content_type, path, size) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
        )?;
        for (seq, asset) in item.assets.iter().enumerate() {
            // Numbered, so two attachments with the same name both keep theirs.
            let path = dir.join(format!("{}-{}", seq + 1, safe_name(&asset.name)));
            let size = std::fs::copy(&asset.path, &path)?;
            insert.execute(params![
                id,
                seq as i64,
                asset.url,
                asset.name,
                asset.content_type,
                path.to_string_lossy(),
                size as i64
            ])?;
        }
    }
    tx.commit()?;
    summary(db, &id)
}

pub(crate) fn delete(db: &mut Connection, id: &str, assets_dir: &Path) -> Result<()> {
    if db.execute("DELETE FROM items WHERE id = ?1", [id])? == 0 {
        return Err(Error::NotFound(id.to_owned()));
    }
    let _ = std::fs::remove_dir_all(assets_dir.join(id));
    Ok(())
}

/// The snapshot as one Markdown document, its attachments listed with where they are on disk.
pub(crate) fn export(db: &Connection, id: &str) -> Result<String> {
    let markdown = markdown(db, id)?;
    let assets = assets(db, id)?;
    Ok(format!("{}{}\n", markdown.trim_end(), attachments_section(&assets)))
}

/// The `<saved-pull-request>` / `<saved-issue>` block a prompt gets for `%id`.
pub(crate) fn prompt_block(db: &Connection, id: &str) -> Result<(String, Vec<ItemAsset>)> {
    let s = summary(db, id)?;
    let assets = assets(db, id)?;
    let tag = tag(&s.kind);
    let block = format!(
        "<{tag} id=\"{}\" repo=\"{}\" number=\"{}\" state=\"{}\" url=\"{}\" saved-at=\"{}\">\n{}{}\n</{tag}>",
        s.id,
        attr(&s.repo),
        s.number,
        attr(&s.state),
        attr(&s.url),
        s.created_at,
        markdown(db, id)?.trim_end(),
        attachments_section(&assets),
    );
    Ok((block, assets))
}

pub(crate) fn noun(kind: &str) -> &'static str {
    if kind == "pr" { "pull request" } else { "issue" }
}

fn tag(kind: &str) -> &'static str {
    if kind == "pr" { "saved-pull-request" } else { "saved-issue" }
}

fn attachments_section(assets: &[ItemAsset]) -> String {
    if assets.is_empty() {
        return String::new();
    }
    let mut out = String::from(
        "\n\n## Attachments\n\nDownloaded with it. Read them from these paths; images that fit are also attached to the message.\n\n",
    );
    for (i, a) in assets.iter().enumerate() {
        out.push_str(&format!("{}. {} ({}, {}): {}\n   From {}\n", i + 1, a.name, a.content_type, size_label(a.size), a.path.display(), a.url));
    }
    out.trim_end().to_owned()
}

fn size_label(bytes: u64) -> String {
    match bytes {
        b if b < 1024 => format!("{b} B"),
        b if b < 1024 * 1024 => format!("{} KB", b / 1024),
        b => format!("{:.1} MB", b as f64 / 1024.0 / 1024.0),
    }
}

/// A file name that stays inside the folder it's put in.
fn safe_name(name: &str) -> String {
    let base = name.rsplit(['/', '\\']).next().unwrap_or(name);
    let cleaned: String =
        base.chars().map(|c| if c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_') { c } else { '_' }).collect();
    let cleaned = cleaned.trim_start_matches('.');
    if cleaned.is_empty() { "attachment".into() } else { cleaned.chars().take(80).collect() }
}

/// A short, unused id like `pr-7f3k2q`.
fn new_id(db: &Connection, kind: &str) -> Result<String> {
    let prefix = if kind == "pr" { "pr" } else { "issue" };
    loop {
        let id = format!("{prefix}-{}", random_body());
        let taken: bool = db.query_row("SELECT EXISTS (SELECT 1 FROM items WHERE id = ?1)", [&id], |row| row.get(0))?;
        if !taken {
            return Ok(id);
        }
    }
}

/// Ids of the pull requests and issues `text` references as `%pr-…` or `%issue-…`, each once, in order.
pub fn item_references(text: &str) -> Vec<String> {
    let bytes = text.as_bytes();
    let mut ids: Vec<String> = Vec::new();
    for (start, _) in text.match_indices('%') {
        if start > 0 && bytes[start - 1].is_ascii_alphanumeric() {
            continue;
        }
        let rest = &text[start + 1..];
        let Some(prefix) = ["pr-", "issue-"].into_iter().find(|p| rest.starts_with(p)) else { continue };
        let Some(body) = rest.get(prefix.len()..prefix.len() + crate::ID_LENGTH) else { continue };
        let body_ok = body.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        let after = rest.as_bytes().get(prefix.len() + crate::ID_LENGTH);
        let after_ok = after.is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'-' && *b != b'_');
        let id = format!("{prefix}{body}");
        if body_ok && after_ok && !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids
}
