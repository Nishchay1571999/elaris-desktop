//! Saved contexts: a whole agent session, kept in a local SQLite database
//! under a short id such as `ctx-7f3k2q`, so another chat can be handed it.
//!
//! A context is a snapshot. It holds the session's transcript entry by entry
//! (each verbatim, plus a Markdown rendering with nothing trimmed) and the
//! scrollback of the terminals its agent opened. Another chat references it
//! as `#ctx-7f3k2q`: small contexts go into the prompt whole
//! ([`ContextStore::expand_prompt`]); larger ones are read page by page
//! through the agent's `elaris-context` tools ([`ContextStore::read`] and friends).
//!
//! It also keeps pull requests and issues saved from GitHub, referenced as
//! `%pr-7f3k2q` or `%issue-7f3k2q` (see [`items`]).

mod items;
mod transcript;

use std::fmt::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use agent_protocol::Session;
use rusqlite::{Connection, OptionalExtension, params};
use serde::Serialize;
use ts_rs::TS;

pub use items::{ItemAsset, ItemSummary, NewAsset, NewItem, item_references};
pub use transcript::{Entry, Transcript};

/// Contexts this small (all referenced ones together, in estimated tokens)
/// go into the prompt whole; larger ones are read through tools.
pub const INLINE_TOKENS: u64 = 60_000;
/// A page of [`ContextStore::read`] when the caller doesn't say.
pub const PAGE_CHARS: usize = 40_000;
const ID_PREFIX: &str = "ctx-";
const ID_LENGTH: usize = 6;
const OUTLINE_LINE: usize = 120;

const SCHEMA: &str = "
CREATE TABLE contexts (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    source_session_id TEXT NOT NULL,
    agent_session_id TEXT,
    workspace TEXT,
    model TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    entries INTEGER NOT NULL,
    chars INTEGER NOT NULL,
    partial INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    outline TEXT NOT NULL
);
CREATE INDEX contexts_by_source ON contexts (source_session_id, created_at);
CREATE TABLE context_entries (
    context_id TEXT NOT NULL REFERENCES contexts (id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    agent TEXT,
    role TEXT NOT NULL,
    kind TEXT NOT NULL,
    tool_name TEXT,
    raw TEXT NOT NULL,
    rendered TEXT NOT NULL,
    PRIMARY KEY (context_id, seq)
);
CREATE TABLE context_terminals (
    context_id TEXT NOT NULL REFERENCES contexts (id) ON DELETE CASCADE,
    terminal_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    output TEXT NOT NULL,
    trimmed INTEGER NOT NULL,
    PRIMARY KEY (context_id, terminal_id)
);
-- Trigram tokens match any substring, such as part of a command line.
CREATE VIRTUAL TABLE context_fts USING fts5 (
    rendered, context_id UNINDEXED, seq UNINDEXED, tokenize = 'trigram'
);
";

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("No saved context #{0}")]
    NotFound(String),
    #[error("Saved contexts database: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("Couldn't read the agent's transcript: {0}")]
    Io(#[from] std::io::Error),
}

pub type Result<T> = std::result::Result<T, Error>;

/// A saved context as lists and pickers show it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ContextSummary {
    /// e.g. `ctx-7f3k2q`; referenced as `#ctx-7f3k2q`.
    pub id: String,
    pub title: String,
    /// The chat it was saved from.
    pub source_session_id: String,
    pub workspace: Option<String>,
    pub model: String,
    /// Epoch milliseconds.
    #[ts(type = "number")]
    pub created_at: i64,
    pub entries: u32,
    /// Estimated tokens to read all of it.
    #[ts(type = "number")]
    pub tokens: u64,
    /// Saved from Elaris's own copy of the chat, whose tool output may be clipped,
    /// because the agent's transcript wasn't available.
    pub partial: bool,
}

/// A terminal the session's agent opened, with all the output it still had.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalCapture {
    pub id: u32,
    pub title: String,
    pub output: String,
    /// Its scrollback had already dropped the earliest output.
    pub trimmed: bool,
}

/// What [`ContextStore::save`] snapshots.
pub struct Capture<'a> {
    pub session: &'a Session,
    /// Where the Agent SDK keeps transcripts, normally `~/.claude/projects`.
    pub projects_dir: &'a Path,
    pub terminals: Vec<TerminalCapture>,
}

/// A search match.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hit {
    pub context_id: String,
    pub seq: u32,
    pub snippet: String,
}

pub struct ContextStore {
    db: Mutex<Connection>,
    /// Where saved pull requests' and issues' attachments are copied, a folder per item.
    assets_dir: PathBuf,
}

/// A prompt with everything it references attached: [`ContextStore::expand`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Expanded {
    pub prompt: String,
    /// Images from referenced pull requests and issues, to send the agent as images.
    pub images: Vec<ItemAsset>,
}

impl ContextStore {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        let assets_dir = path.parent().unwrap_or(Path::new(".")).join("saved-items");
        Self::init(db, assets_dir)
    }

    /// Attachments still go to disk, under the system's temporary folder.
    pub fn open_in_memory() -> Result<Self> {
        let assets_dir = std::env::temp_dir().join(format!("elaris-saved-items-{}", uuid::Uuid::new_v4()));
        Self::init(Connection::open_in_memory()?, assets_dir)
    }

    fn init(db: Connection, assets_dir: PathBuf) -> Result<Self> {
        db.pragma_update(None, "foreign_keys", true)?;
        let version: i64 = db.pragma_query_value(None, "user_version", |row| row.get(0))?;
        if version < 1 {
            db.execute_batch(&format!("BEGIN; {SCHEMA} PRAGMA user_version = 1; COMMIT;"))?;
        }
        if version < 2 {
            db.execute_batch(&format!("BEGIN; {} PRAGMA user_version = 2; COMMIT;", items::SCHEMA))?;
        }
        Ok(Self { db: Mutex::new(db), assets_dir })
    }

    /// Snapshots the session: the agent's own transcript when it's on this
    /// machine, else Elaris's copy. If nothing changed since the session was
    /// last saved, returns that context instead of a duplicate.
    pub fn save(&self, capture: Capture<'_>) -> Result<ContextSummary> {
        let session = capture.session;
        let transcript = match session
            .agent_session_id
            .as_deref()
            .and_then(|id| transcript::find(capture.projects_dir, id))
        {
            Some(path) => transcript::load(&path)?,
            None => transcript::from_session(session),
        };

        let mut db = self.db.lock().unwrap();
        let newest: Option<(String, String)> = db
            .query_row(
                "SELECT id, fingerprint FROM contexts WHERE source_session_id = ?1 ORDER BY created_at DESC LIMIT 1",
                [&session.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if let Some((id, fingerprint)) = newest
            && fingerprint == transcript.fingerprint
        {
            return summary(&db, &id);
        }

        let tx = db.transaction()?;
        let id = new_id(&tx)?;
        let chars: usize = transcript.entries.iter().map(|e| e.rendered.chars().count()).sum::<usize>()
            + capture.terminals.iter().map(|t| t.output.chars().count()).sum::<usize>();
        let title = if session.title.trim().is_empty() { "Untitled chat".to_owned() } else { session.title.clone() };
        tx.execute(
            "INSERT INTO contexts (id, title, source_session_id, agent_session_id, workspace, model, created_at,
                                   entries, chars, partial, fingerprint, outline)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            params![
                id,
                title,
                session.id,
                session.agent_session_id,
                session.workspace,
                session.model,
                now_ms(),
                transcript.entries.len() as i64,
                chars as i64,
                transcript.partial,
                transcript.fingerprint,
                outline(&transcript.entries, &capture.terminals),
            ],
        )?;
        {
            let mut entry = tx.prepare(
                "INSERT INTO context_entries (context_id, seq, agent, role, kind, tool_name, raw, rendered)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )?;
            let mut fts = tx.prepare("INSERT INTO context_fts (rendered, context_id, seq) VALUES (?1, ?2, ?3)")?;
            for (seq, e) in transcript.entries.iter().enumerate() {
                entry.execute(params![id, seq as i64, e.agent, e.role, e.kind, e.tool_name, e.raw, e.rendered])?;
                if !e.rendered.is_empty() {
                    fts.execute(params![e.rendered, id, seq as i64])?;
                }
            }
            let mut terminal = tx.prepare(
                "INSERT INTO context_terminals (context_id, terminal_id, title, output, trimmed) VALUES (?1, ?2, ?3, ?4, ?5)",
            )?;
            for t in &capture.terminals {
                terminal.execute(params![id, t.id, t.title, t.output, t.trimmed])?;
            }
        }
        tx.commit()?;
        summary(&db, &id)
    }

    /// Newest first; `query` filters by id or title.
    pub fn list(&self, query: Option<&str>) -> Result<Vec<ContextSummary>> {
        let db = self.db.lock().unwrap();
        let pattern = format!("%{}%", like_escape(query.unwrap_or("").trim().trim_start_matches('#')));
        let mut stmt = db.prepare(&format!(
            "SELECT {SUMMARY_COLUMNS} FROM contexts
             WHERE id LIKE ?1 ESCAPE '\\' OR title LIKE ?1 ESCAPE '\\'
             ORDER BY created_at DESC"
        ))?;
        let rows = stmt.query_map([pattern], summary_row)?;
        Ok(rows.collect::<rusqlite::Result<_>>()?)
    }

    pub fn get(&self, id: &str) -> Result<ContextSummary> {
        summary(&self.db.lock().unwrap(), id)
    }

    pub fn rename(&self, id: &str, title: &str) -> Result<ContextSummary> {
        let db = self.db.lock().unwrap();
        if db.execute("UPDATE contexts SET title = ?2 WHERE id = ?1", params![id, title.trim()])? == 0 {
            return Err(Error::NotFound(id.to_owned()));
        }
        summary(&db, id)
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM context_fts WHERE context_id = ?1", [id])?;
        if tx.execute("DELETE FROM contexts WHERE id = ?1", [id])? == 0 {
            return Err(Error::NotFound(id.to_owned()));
        }
        tx.commit()?;
        Ok(())
    }

    /// What the context covers: its prompts in order and the tools it used.
    pub fn overview(&self, id: &str) -> Result<String> {
        let db = self.db.lock().unwrap();
        let s = summary(&db, id)?;
        let outline: String = db.query_row("SELECT outline FROM contexts WHERE id = ?1", [id], |row| row.get(0))?;
        Ok(format!("{}\n\n{outline}", heading(&s)))
    }

    /// The whole context as one Markdown document: every entry, then the terminals.
    pub fn export(&self, id: &str) -> Result<String> {
        let db = self.db.lock().unwrap();
        let s = summary(&db, id)?;
        let mut out = format!("# {}\n\n", s.title);
        let mut stmt = db.prepare("SELECT rendered FROM context_entries WHERE context_id = ?1 AND rendered != '' ORDER BY seq")?;
        let entries = stmt.query_map([id], |row| row.get::<_, String>(0))?;
        for rendered in entries {
            out.push_str(&rendered?);
            out.push_str("\n\n");
        }
        for t in terminals(&db, id)? {
            out.push_str(&render_terminal(&t));
            out.push_str("\n\n");
        }
        Ok(out.trim_end().to_owned() + "\n")
    }

    /// Up to `max_chars` of the rendered context, from entry `from_seq`
    /// (`offset` characters into it). Entries are only split when one alone is
    /// longer than a page; the text ends by saying where the next page starts.
    pub fn read(&self, id: &str, from_seq: u32, offset: usize, max_chars: usize) -> Result<String> {
        let max_chars = max_chars.max(1000);
        let db = self.db.lock().unwrap();
        let s = summary(&db, id)?;
        let mut stmt = db.prepare(
            "SELECT seq, rendered FROM context_entries WHERE context_id = ?1 AND seq >= ?2 AND rendered != '' ORDER BY seq",
        )?;
        let mut rows = stmt.query(params![id, from_seq])?;

        let mut body = String::new();
        let mut used = 0;
        let mut next = None;
        let (mut first, mut last) = (None, None);
        while let Some(row) = rows.next()? {
            let seq: u32 = row.get(0)?;
            let rendered: String = row.get(1)?;
            let skip = if first.is_none() && seq == from_seq { offset } else { 0 };
            let text: String = rendered.chars().skip(skip).collect();
            let len = text.chars().count();
            if used + len > max_chars {
                if first.is_none() {
                    // A single entry larger than a page: hand it over in pieces.
                    let piece: String = text.chars().take(max_chars).collect();
                    let _ = write!(body, "<entry seq=\"{seq}\" from=\"{skip}\">\n{piece}\n</entry>\n");
                    first = Some(seq);
                    last = Some(seq);
                    next = Some((seq, skip + max_chars));
                } else {
                    next = Some((seq, 0));
                }
                break;
            }
            let attr = if skip > 0 { format!(" from=\"{skip}\"") } else { String::new() };
            let _ = write!(body, "<entry seq=\"{seq}\"{attr}>\n{text}\n</entry>\n");
            used += len;
            first.get_or_insert(seq);
            last = Some(seq);
        }

        let range = match (first, last) {
            (Some(a), Some(b)) if a == b => format!("entry {a}"),
            (Some(a), Some(b)) => format!("entries {a}–{b}"),
            _ => "no entries".to_owned(),
        };
        let total = s.entries.saturating_sub(1);
        let tail = match next {
            Some((seq, 0)) => format!("More follows: read with fromSeq={seq}."),
            Some((seq, offset)) => format!("More follows: read with fromSeq={seq} and offset={offset}."),
            None => "End of the conversation. Terminal output, if any, is under `terminals`.".to_owned(),
        };
        Ok(format!("{} · {range} (last is {total})\n\n{body}\n{tail}", heading(&s)))
    }

    /// Entries whose rendering contains `query`, best first; `id` limits it to one context.
    pub fn search(&self, id: Option<&str>, query: &str, limit: usize) -> Result<Vec<Hit>> {
        let query = query.trim();
        if query.is_empty() {
            return Ok(Vec::new());
        }
        let db = self.db.lock().unwrap();
        let limit = limit.max(1) as i64;
        // Trigrams need three characters; shorter queries scan instead.
        let hits = if query.chars().count() >= 3 {
            let phrase = format!("\"{}\"", query.replace('"', "\"\""));
            let mut stmt = db.prepare(
                "SELECT context_id, seq, snippet(context_fts, 0, '«', '»', '…', 24) FROM context_fts
                 WHERE context_fts MATCH ?1 AND (?2 IS NULL OR context_id = ?2) ORDER BY rank LIMIT ?3",
            )?;
            stmt.query_map(params![phrase, id, limit], hit_row)?.collect::<rusqlite::Result<Vec<_>>>()?
        } else {
            let mut stmt = db.prepare(
                "SELECT context_id, seq, rendered FROM context_entries
                 WHERE instr(lower(rendered), lower(?1)) > 0 AND (?2 IS NULL OR context_id = ?2)
                 ORDER BY context_id, seq LIMIT ?3",
            )?;
            stmt.query_map(params![query, id, limit], hit_row)?
                .map(|hit| hit.map(|h| Hit { snippet: around(&h.snippet, query), ..h }))
                .collect::<rusqlite::Result<Vec<_>>>()?
        };
        Ok(hits)
    }

    /// Entry `seq` exactly as the transcript recorded it.
    pub fn raw(&self, id: &str, seq: u32) -> Result<String> {
        let db = self.db.lock().unwrap();
        db.query_row("SELECT raw FROM context_entries WHERE context_id = ?1 AND seq = ?2", params![id, seq], |row| row.get(0))
            .optional()?
            .ok_or_else(|| Error::NotFound(format!("{id} entry {seq}")))
    }

    pub fn terminals(&self, id: &str) -> Result<Vec<TerminalCapture>> {
        let db = self.db.lock().unwrap();
        summary(&db, id)?;
        terminals(&db, id)
    }

    /// Saves a pull request or issue snapshot with copies of its attachments.
    pub fn save_item(&self, item: NewItem) -> Result<ItemSummary> {
        items::save(&mut self.db.lock().unwrap(), item, &self.assets_dir)
    }

    /// Saved pull requests and issues, newest first; `query` filters by id, title or `owner/name#number`.
    pub fn list_items(&self, query: Option<&str>) -> Result<Vec<ItemSummary>> {
        let pattern = format!("%{}%", like_escape(query.unwrap_or("").trim().trim_start_matches('%')));
        items::list(&self.db.lock().unwrap(), &pattern)
    }

    pub fn get_item(&self, id: &str) -> Result<ItemSummary> {
        items::summary(&self.db.lock().unwrap(), id)
    }

    pub fn delete_item(&self, id: &str) -> Result<()> {
        items::delete(&mut self.db.lock().unwrap(), id, &self.assets_dir)
    }

    /// A saved pull request or issue as Markdown, its attachments listed with their paths.
    pub fn export_item(&self, id: &str) -> Result<String> {
        items::export(&self.db.lock().unwrap(), id)
    }

    /// [`ContextStore::expand`]'s prompt alone.
    pub fn expand_prompt(&self, text: &str) -> Result<String> {
        self.expand(text).map(|e| e.prompt)
    }

    /// `text` with every `#ctx-…` and `%pr-…`/`%issue-…` it references attached
    /// for the agent. Chats go in whole while they fit in [`INLINE_TOKENS`], else
    /// as an outline and how to read the rest with tools; pull requests and issues
    /// go in whole, their images alongside. Unchanged if it references none.
    pub fn expand(&self, text: &str) -> Result<Expanded> {
        let ids = references(text);
        let item_ids = item_references(text);
        if ids.is_empty() && item_ids.is_empty() {
            return Ok(Expanded { prompt: text.to_owned(), images: Vec::new() });
        }
        let summaries = ids.iter().map(|id| self.get(id)).collect::<Result<Vec<_>>>()?;
        let mut budget = INLINE_TOKENS;
        let mut blocks = Vec::new();
        for s in &summaries {
            let attrs = format!(
                "id=\"{}\" title=\"{}\" entries=\"{}\" tokens=\"~{}\"{}",
                s.id,
                attr(&s.title),
                s.entries,
                s.tokens,
                s.workspace.as_deref().map(|w| format!(" workspace=\"{}\"", attr(w))).unwrap_or_default(),
            );
            if s.tokens <= budget {
                budget -= s.tokens;
                blocks.push(format!("<saved-context {attrs}>\n{}</saved-context>", self.export(&s.id)?));
            } else {
                blocks.push(format!(
                    "<saved-context {attrs} attached=\"by-reference\">\nToo large to include here. Read it with the \
                     `elaris-context` tools: `read` with id \"{id}\" from fromSeq=0, page by page, or `search` it for \
                     specific parts. Nothing in it is trimmed; `raw` gives an entry exactly as recorded, and `terminals` \
                     the output of terminals it opened.\n\n{}\n</saved-context>",
                    self.overview(&s.id)?,
                    id = s.id,
                ));
            }
        }
        let mut notes = Vec::new();
        if !summaries.is_empty() {
            let names = summaries.iter().map(|s| format!("#{}", s.id)).collect::<Vec<_>>().join(", ");
            notes.push(format!(
                "The user attached the saved context{} above ({names} in their message): the record of an earlier \
                 agent session, including its tool calls, commands and their output.",
                if summaries.len() == 1 { "" } else { "s" },
            ));
        }

        let mut images = Vec::new();
        if !item_ids.is_empty() {
            let db = self.db.lock().unwrap();
            let mut kinds = Vec::new();
            for id in &item_ids {
                let (block, assets) = items::prompt_block(&db, id)?;
                blocks.push(block);
                images.extend(assets.into_iter().filter(ItemAsset::sendable));
                let kind = items::summary(&db, id)?.kind;
                if !kinds.contains(&kind) {
                    kinds.push(kind);
                }
            }
            let names = item_ids.iter().map(|id| format!("%{id}")).collect::<Vec<_>>().join(", ");
            let what = kinds.iter().map(|k| format!("{}{}", items::noun(k), if item_ids.len() == 1 { "" } else { "s" })).collect::<Vec<_>>().join(" and ");
            notes.push(format!(
                "The user attached the saved GitHub {what} above ({names} in their message): a snapshot taken when they saved \
                 it, with its discussion and attachments. GitHub may have moved on since; `gh` can fetch the latest."
            ));
        }

        let prompt = format!(
            "{}\n\n{} Use {} as context for their request:\n\n{text}",
            blocks.join("\n\n"),
            notes.join(" "),
            if blocks.len() == 1 { "it" } else { "them" },
        );
        Ok(Expanded { prompt, images })
    }
}

/// Ids of the contexts `text` references as `#ctx-…`, each once, in order.
pub fn references(text: &str) -> Vec<String> {
    let mut ids: Vec<String> = Vec::new();
    let bytes = text.as_bytes();
    let marker = format!("#{ID_PREFIX}");
    let mut from = 0;
    while let Some(found) = text[from..].find(&marker) {
        let start = from + found;
        let id_start = start + 1;
        let id_end = id_start + ID_PREFIX.len() + ID_LENGTH;
        from = start + marker.len();
        let before_ok = start == 0 || !bytes[start - 1].is_ascii_alphanumeric();
        let Some(id) = text.get(id_start..id_end) else { continue };
        let body_ok = id[ID_PREFIX.len()..].bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit());
        let after_ok = bytes.get(id_end).is_none_or(|b| !b.is_ascii_alphanumeric() && *b != b'-' && *b != b'_');
        if before_ok && body_ok && after_ok && !ids.iter().any(|known| known == id) {
            ids.push(id.to_owned());
        }
    }
    ids
}

const SUMMARY_COLUMNS: &str = "id, title, source_session_id, workspace, model, created_at, entries, chars, partial";

fn summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ContextSummary> {
    Ok(ContextSummary {
        id: row.get(0)?,
        title: row.get(1)?,
        source_session_id: row.get(2)?,
        workspace: row.get(3)?,
        model: row.get(4)?,
        created_at: row.get(5)?,
        entries: row.get(6)?,
        tokens: estimate_tokens(row.get::<_, i64>(7)?),
        partial: row.get(8)?,
    })
}

fn hit_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Hit> {
    Ok(Hit { context_id: row.get(0)?, seq: row.get(1)?, snippet: row.get(2)? })
}

fn summary(db: &Connection, id: &str) -> Result<ContextSummary> {
    db.query_row(&format!("SELECT {SUMMARY_COLUMNS} FROM contexts WHERE id = ?1"), [id], summary_row)
        .optional()?
        .ok_or_else(|| Error::NotFound(id.to_owned()))
}

fn terminals(db: &Connection, id: &str) -> Result<Vec<TerminalCapture>> {
    let mut stmt =
        db.prepare("SELECT terminal_id, title, output, trimmed FROM context_terminals WHERE context_id = ?1 ORDER BY terminal_id")?;
    let rows = stmt.query_map([id], |row| {
        Ok(TerminalCapture { id: row.get(0)?, title: row.get(1)?, output: row.get(2)?, trimmed: row.get(3)? })
    })?;
    Ok(rows.collect::<rusqlite::Result<_>>()?)
}

pub fn render_terminal(t: &TerminalCapture) -> String {
    let note = if t.trimmed { "\n\n(The terminal had already dropped its earliest output.)" } else { "" };
    format!("### Terminal {} · {}{note}\n\n{}", t.id, t.title, transcript::fence(&t.output, ""))
}

fn heading(s: &ContextSummary) -> String {
    let partial = if s.partial { " · from Elaris's copy, so long tool output may be clipped" } else { "" };
    format!("Saved context {} · \"{}\" · {} entries · ~{} tokens{partial}", s.id, s.title, s.entries, s.tokens)
}

/// The prompts in order, then how often each tool was used.
fn outline(entries: &[Entry], terminals: &[TerminalCapture]) -> String {
    let mut out = String::from("Prompts:\n");
    let mut prompts = 0;
    let mut tools: Vec<(String, usize)> = Vec::new();
    for (seq, e) in entries.iter().enumerate() {
        if e.agent.is_none() && e.role == "user" && e.rendered.starts_with("## You") {
            let text = e.rendered.trim_start_matches("## You").trim();
            let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            let short: String = line.chars().take(OUTLINE_LINE).collect();
            let more = if line.chars().count() > OUTLINE_LINE { "…" } else { "" };
            let _ = writeln!(out, "- [seq {seq}] {short}{more}");
            prompts += 1;
        }
        if let Some(name) = &e.tool_name {
            match tools.iter_mut().find(|(n, _)| n == name) {
                Some((_, count)) => *count += 1,
                None => tools.push((name.clone(), 1)),
            }
        }
    }
    if prompts == 0 {
        out.push_str("- (none)\n");
    }
    if !tools.is_empty() {
        tools.sort_by(|a, b| b.1.cmp(&a.1));
        let list: Vec<String> = tools.iter().map(|(n, c)| format!("{n} ×{c}")).collect();
        let _ = writeln!(out, "Tool calls: {}", list.join(", "));
    }
    if !terminals.is_empty() {
        let list: Vec<String> = terminals.iter().map(|t| format!("{} ({})", t.id, t.title)).collect();
        let _ = writeln!(out, "Terminals: {}", list.join(", "));
    }
    out.trim_end().to_owned()
}

/// Six random lowercase letters and digits, an id's tail.
fn random_body() -> String {
    const ALPHABET: &[u8] = b"abcdefghijklmnopqrstuvwxyz0123456789";
    let bytes = uuid::Uuid::new_v4().into_bytes();
    bytes[..ID_LENGTH].iter().map(|b| ALPHABET[*b as usize % ALPHABET.len()] as char).collect()
}

/// A short, unused id like `ctx-7f3k2q`.
fn new_id(db: &Connection) -> Result<String> {
    loop {
        let id = format!("{ID_PREFIX}{}", random_body());
        let taken: bool = db.query_row("SELECT EXISTS (SELECT 1 FROM contexts WHERE id = ?1)", [&id], |row| row.get(0))?;
        if !taken {
            return Ok(id);
        }
    }
}

fn estimate_tokens(chars: i64) -> u64 {
    (chars.max(0) as u64).div_ceil(4)
}

/// About 160 characters of `text` around the first match of `query`.
fn around(text: &str, query: &str) -> String {
    let lower = text.to_lowercase();
    let at = lower.find(&query.to_lowercase()).unwrap_or(0);
    let start = lower[..at].char_indices().rev().nth(80).map_or(0, |(i, _)| i);
    let snippet: String = text.get(start..).unwrap_or(text).chars().take(160).collect();
    format!("{}{snippet}…", if start > 0 { "…" } else { "" })
}

fn like_escape(text: &str) -> String {
    text.replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_")
}

fn attr(text: &str) -> String {
    text.replace('&', "&amp;").replace('"', "&quot;").replace('<', "&lt;")
}

fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use std::fs;

    use agent_protocol::{AgentMode, Message, MessageRole, MessageStatus, PermissionPolicy, TokenUsage};
    use serde_json::json;

    use super::*;

    fn session(agent_session_id: Option<&str>) -> Session {
        Session {
            id: "chat-1".into(),
            title: "ADB setup".into(),
            created_at: 0,
            updated_at: 0,
            mode: AgentMode::Agent,
            model: "claude-opus-5-5".into(),
            permissions: PermissionPolicy::Ask,
            workspace: Some("/tmp/app".into()),
            agent_session_id: agent_session_id.map(Into::into),
            usage: TokenUsage::default(),
            context: 0,
            messages: vec![Message {
                id: "m1".into(),
                role: MessageRole::User,
                content: "Connect to the phone".into(),
                parts: Vec::new(),
                images: Vec::new(),
                agents: Vec::new(),
                created_at: 0,
                status: MessageStatus::Complete,
                error: None,
            }],
        }
    }

    /// A projects folder holding transcript `s1` with a huge tool result.
    fn projects(output: &str) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let project = dir.path().join("-tmp-app");
        fs::create_dir_all(&project).unwrap();
        let lines = [
            json!({"type":"user","message":{"role":"user","content":"Connect to the phone over adb"}}),
            json!({"type":"assistant","message":{"content":[{"type":"thinking","thinking":"List devices first."}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"adb devices -l"}}]}}),
            json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":output}]}}),
            json!({"type":"assistant","message":{"content":[{"type":"text","text":"The Pixel is connected."}]}}),
        ];
        let text: Vec<String> = lines.iter().map(|l| l.to_string()).collect();
        fs::write(project.join("s1.jsonl"), text.join("\n")).unwrap();
        dir
    }

    fn save(store: &ContextStore, dir: &Path, terminals: Vec<TerminalCapture>) -> ContextSummary {
        let session = session(Some("s1"));
        store.save(Capture { session: &session, projects_dir: dir, terminals }).unwrap()
    }

    #[test]
    fn saves_the_whole_transcript_untrimmed() {
        let output = "emulator-5554 device product:sdk\n".repeat(40_000); // ~1.3 MB
        let dir = projects(&output);
        let store = ContextStore::open_in_memory().unwrap();
        let terminal = TerminalCapture { id: 3, title: "adb logcat".into(), output: "I/ActivityManager: boot".into(), trimmed: false };
        let saved = save(&store, dir.path(), vec![terminal]);

        assert!(saved.id.starts_with("ctx-") && saved.id.len() == 10, "{}", saved.id);
        assert_eq!((saved.entries, saved.partial, saved.title.as_str()), (5, false, "ADB setup"));
        let export = store.export(&saved.id).unwrap();
        assert!(export.contains(&output), "tool output is kept whole");
        assert!(export.contains("### Thinking\n\nList devices first."));
        assert!(export.contains("```sh\nadb devices -l\n```"));
        assert!(export.contains("### Terminal 3 · adb logcat") && export.contains("I/ActivityManager: boot"));

        // Entries round-trip byte for byte.
        let source = fs::read_to_string(dir.path().join("-tmp-app/s1.jsonl")).unwrap();
        let raw: Vec<String> = (0..5).map(|seq| store.raw(&saved.id, seq).unwrap()).collect();
        assert_eq!(raw.join("\n"), source);
    }

    #[test]
    fn saving_an_unchanged_session_returns_the_same_context() {
        let dir = projects("ok");
        let store = ContextStore::open_in_memory().unwrap();
        let first = save(&store, dir.path(), Vec::new());
        assert_eq!(save(&store, dir.path(), Vec::new()).id, first.id);

        let path = dir.path().join("-tmp-app/s1.jsonl");
        let more = json!({"type":"user","message":{"content":"Now install the APK"}});
        fs::write(&path, format!("{}\n{more}", fs::read_to_string(&path).unwrap())).unwrap();
        let second = save(&store, dir.path(), Vec::new());
        assert_ne!(second.id, first.id);
        assert_eq!(store.list(None).unwrap().iter().map(|s| &s.id).collect::<Vec<_>>().len(), 2);
    }

    #[test]
    fn falls_back_to_elaris_copy_without_a_transcript() {
        let dir = tempfile::tempdir().unwrap();
        let store = ContextStore::open_in_memory().unwrap();
        let session = session(None);
        let saved = store.save(Capture { session: &session, projects_dir: dir.path(), terminals: Vec::new() }).unwrap();
        assert!(saved.partial);
        assert!(store.export(&saved.id).unwrap().contains("## You\n\nConnect to the phone"));
    }

    #[test]
    fn reads_page_by_page_and_splits_only_oversized_entries() {
        let output = "x".repeat(5_000);
        let dir = projects(&output);
        let store = ContextStore::open_in_memory().unwrap();
        let id = save(&store, dir.path(), Vec::new()).id;

        let page = store.read(&id, 0, 0, 1_000).unwrap();
        assert!(page.contains("<entry seq=\"0\">"), "{page}");
        assert!(page.contains("More follows: read with fromSeq=3."), "{page}");

        // Entry 3 is bigger than a page: it comes in pieces that add up to all of it.
        let mut collected = String::new();
        let (mut seq, mut offset) = (3, 0);
        loop {
            let page = store.read(&id, seq, offset, 1_000).unwrap();
            let body = page.split_once('>').unwrap().1.split("\n</entry>").next().unwrap();
            collected.push_str(body.trim_start_matches('\n'));
            match page.rsplit_once("fromSeq=") {
                Some((_, rest)) if rest.contains("offset=") => {
                    let (s, o) = rest.trim_end_matches('.').split_once(" and offset=").unwrap();
                    (seq, offset) = (s.parse().unwrap(), o.parse().unwrap());
                }
                _ => break,
            }
        }
        assert!(collected.contains(&output));

        let last = store.read(&id, 4, 0, 1_000).unwrap();
        assert!(last.contains("End of the conversation"), "{last}");
    }

    #[test]
    fn searches_by_substring() {
        let dir = projects("List of devices attached\nR58N123 device");
        let store = ContextStore::open_in_memory().unwrap();
        let id = save(&store, dir.path(), Vec::new()).id;

        let hits = store.search(Some(&id), "devices -l", 5).unwrap();
        assert_eq!(hits[0].seq, 2, "{hits:?}");
        assert!(store.search(None, "R58N", 5).unwrap().iter().any(|h| h.seq == 3));
        assert!(!store.search(Some(&id), "-l", 5).unwrap().is_empty(), "short queries scan");
        assert!(store.search(Some("ctx-nope00"), "devices", 5).unwrap().is_empty());
    }

    #[test]
    fn deleting_removes_everything() {
        let dir = projects("ok");
        let store = ContextStore::open_in_memory().unwrap();
        let id = save(&store, dir.path(), Vec::new()).id;
        store.delete(&id).unwrap();
        assert!(matches!(store.get(&id), Err(Error::NotFound(_))));
        assert!(store.search(None, "adb", 5).unwrap().is_empty());
        assert!(matches!(store.delete(&id), Err(Error::NotFound(_))));
    }

    #[test]
    fn finds_references_once_each() {
        assert_eq!(references("use #ctx-abc123 and #ctx-abc123, (#ctx-zz9900)"), ["ctx-abc123", "ctx-zz9900"]);
        assert!(references("a#ctx-abc123 #ctx-abc1234 #ctx-ABC123 #ctx-ab").is_empty());
        assert_eq!(references("#ctx-abc123"), ["ctx-abc123"]);
    }

    #[test]
    fn small_contexts_go_inline_and_large_ones_by_reference() {
        let store = ContextStore::open_in_memory().unwrap();
        let small_dir = projects("short output");
        let small = save(&store, small_dir.path(), Vec::new()).id;

        let prompt = store.expand_prompt(&format!("Build a tool for this #{small}")).unwrap();
        assert!(prompt.starts_with(&format!("<saved-context id=\"{small}\"")), "{prompt}");
        assert!(prompt.contains("short output") && prompt.ends_with(&format!("Build a tool for this #{small}")));

        let big_dir = projects(&"y".repeat((INLINE_TOKENS as usize + 1) * 4));
        let session = Session { id: "chat-2".into(), ..session(Some("s1")) };
        let big = store.save(Capture { session: &session, projects_dir: big_dir.path(), terminals: Vec::new() }).unwrap().id;
        let prompt = store.expand_prompt(&format!("#{big} again")).unwrap();
        assert!(prompt.contains("attached=\"by-reference\"") && prompt.contains("Prompts:\n- [seq 0] Connect to the phone over adb"));
        assert!(!prompt.contains("yyyyyyyyyy"));

        assert_eq!(store.expand_prompt("no references").unwrap(), "no references");
        assert!(matches!(store.expand_prompt("#ctx-000000"), Err(Error::NotFound(_))));
    }

    fn item(dir: &Path, markdown: &str) -> NewItem {
        let image = dir.join("shot.png");
        let log = dir.join("crash.log");
        fs::write(&image, b"\x89PNG fake").unwrap();
        fs::write(&log, "panic at main.rs:3").unwrap();
        NewItem {
            kind: "pr".into(),
            repo: "acme/app".into(),
            number: 42,
            title: "Fix the login crash".into(),
            state: "OPEN".into(),
            url: "https://github.com/acme/app/pull/42".into(),
            markdown: markdown.into(),
            assets: vec![
                NewAsset {
                    url: "https://github.com/user-attachments/assets/1".into(),
                    name: "shot.png".into(),
                    content_type: "image/png".into(),
                    path: image,
                },
                NewAsset {
                    url: "https://github.com/user-attachments/files/2/crash.log".into(),
                    name: "../crash.log".into(),
                    content_type: "text/plain".into(),
                    path: log,
                },
            ],
        }
    }

    #[test]
    fn saves_pull_requests_with_their_attachments() {
        let dir = tempfile::tempdir().unwrap();
        let store = ContextStore::open_in_memory().unwrap();
        let saved = store.save_item(item(dir.path(), "# Fix the login crash\n\nIt crashed.")).unwrap();
        assert!(saved.id.starts_with("pr-") && saved.id.len() == 9, "{}", saved.id);
        assert_eq!((saved.assets, saved.number, saved.repo.as_str()), (2, 42, "acme/app"));

        // Saving it unchanged gives the same snapshot; a changed one is new.
        assert_eq!(store.save_item(item(dir.path(), "# Fix the login crash\n\nIt crashed.")).unwrap().id, saved.id);
        let newer = store.save_item(item(dir.path(), "# Fix the login crash\n\nStill crashes.")).unwrap();
        assert_ne!(newer.id, saved.id);
        assert_eq!(store.list_items(Some("acme/app#42")).unwrap().len(), 2);
        assert_eq!(store.list_items(Some(&format!("%{}", saved.id))).unwrap()[0].id, saved.id);

        let export = store.export_item(&saved.id).unwrap();
        assert!(export.contains("It crashed.") && export.contains("## Attachments"), "{export}");
        // Copied into the store's own folder, names kept inside it.
        let copied: Vec<_> = export.lines().filter_map(|l| l.split(": ").nth(1)).map(PathBuf::from).collect();
        assert_eq!(copied.len(), 2, "{export}");
        assert!(copied.iter().all(|p| p.exists() && p.starts_with(&store.assets_dir)), "{copied:?}");
        assert!(copied[1].ends_with("2-crash.log"), "{copied:?}");

        store.delete_item(&saved.id).unwrap();
        assert!(!copied[0].exists());
        assert!(matches!(store.get_item(&saved.id), Err(Error::NotFound(_))));
    }

    #[test]
    fn referenced_items_go_in_whole_with_their_images() {
        let dir = tempfile::tempdir().unwrap();
        let store = ContextStore::open_in_memory().unwrap();
        let pr = store.save_item(item(dir.path(), "# Fix the login crash\n\nIt crashed.")).unwrap().id;
        let chats = projects("short output");
        let ctx = save(&store, chats.path(), Vec::new()).id;

        let expanded = store.expand(&format!("Review %{pr} with #{ctx}")).unwrap();
        assert!(expanded.prompt.contains(&format!("<saved-pull-request id=\"{pr}\" repo=\"acme/app\" number=\"42\"")));
        assert!(expanded.prompt.contains("It crashed.") && expanded.prompt.contains("short output"));
        assert!(expanded.prompt.contains(&format!("(%{pr} in their message)")));
        assert!(expanded.prompt.ends_with(&format!("Review %{pr} with #{ctx}")));
        // Only the image goes as an image; the log is read from disk.
        assert_eq!(expanded.images.iter().map(|a| a.name.as_str()).collect::<Vec<_>>(), ["shot.png"]);

        assert!(matches!(store.expand("%issue-000000"), Err(Error::NotFound(_))));
    }

    #[test]
    fn finds_item_references_once_each() {
        assert_eq!(item_references("see %pr-abc123, %issue-zz9900 and %pr-abc123"), ["pr-abc123", "issue-zz9900"]);
        assert!(item_references("a%pr-abc123 %pr-abc1234 %pr-ABC123 %pr-ab 50%").is_empty());
        assert_eq!(item_references("%issue-000000"), ["issue-000000"]);
    }
}
