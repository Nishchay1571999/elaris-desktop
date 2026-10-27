//! Skills: what is in `~/.claude/skills`, searching skills.sh, and installing
//! or removing through the `skills` CLI.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tokio::process::Command;
use tokio::sync::Mutex;
use ts_rs::TS;

use crate::{Error, Paths, Result};

const REGISTRY: &str = "https://skills.sh";
/// skills.sh has no "browse" endpoint, so the default listing merges searches
/// for the jobs people most often install a skill for.
const POPULAR_QUERIES: &[&str] = &["frontend", "review", "testing", "docs", "git", "design", "react", "python"];
const POPULAR_LIMIT: usize = 40;
const INSTALL_TIMEOUT: Duration = Duration::from_secs(180);

static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent("Elaris")
        .build()
        .expect("HTTP client")
});

/// Installs and removals both rewrite the CLI's lock file, so they run one at a time.
static CLI: Mutex<()> = Mutex::const_new(());

/// A skill in the agent's skills folder.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstalledSkill {
    /// Folder name, which is also what `skills remove` takes.
    pub id: String,
    /// The `name` in SKILL.md, or the folder name.
    pub name: String,
    pub description: Option<String>,
    /// `owner/repo` it was installed from; `None` for a skill written by hand.
    pub source: Option<String>,
    pub path: String,
    /// ISO timestamp from the lock file.
    pub installed_at: Option<String>,
}

/// A skill published on skills.sh.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct SkillListing {
    /// `owner/repo/skill`, also its page on skills.sh.
    pub id: String,
    /// Folder name inside the repository.
    pub skill_id: String,
    pub name: String,
    /// `owner/repo`, what `skills add` takes.
    pub source: String,
    #[serde(default)]
    #[ts(type = "number")]
    pub installs: u64,
}

/// Skills in the agent's folder, sorted by name. A missing folder is no skills.
pub fn installed(paths: &Paths) -> Result<Vec<InstalledSkill>> {
    let dir = paths.skills_dir();
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e.into()),
    };
    let lock = read_lock(&paths.skill_lock);

    let mut skills: Vec<InstalledSkill> = entries
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let path = entry.path();
            // Reading through the path follows symlinks, which is how the CLI usually links skills in.
            let manifest = std::fs::read_to_string(path.join("SKILL.md")).ok()?;
            let id = entry.file_name().to_string_lossy().into_owned();
            let front = frontmatter(&manifest);
            let locked = lock.get(&id);
            Some(InstalledSkill {
                name: front.get("name").cloned().unwrap_or_else(|| id.clone()),
                description: front.get("description").cloned().filter(|d| !d.is_empty()),
                source: locked.map(|l| l.source.clone()),
                path: path.display().to_string(),
                installed_at: locked.and_then(|l| l.installed_at.clone()),
                id,
            })
        })
        .collect();
    skills.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(skills)
}

/// Searches skills.sh; an empty query returns popular skills instead. Most installed first.
pub async fn search(query: &str) -> Result<Vec<SkillListing>> {
    let query = query.trim();
    if query.is_empty() {
        return popular().await;
    }
    if query.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let mut skills = fetch(query, 30).await?;
    skills.sort_by(|a, b| b.installs.cmp(&a.installs));
    Ok(skills)
}

async fn popular() -> Result<Vec<SkillListing>> {
    let searches = POPULAR_QUERIES.iter().map(|q| tokio::spawn(fetch(q, 12)));
    let mut seen = HashSet::new();
    let mut skills = Vec::new();
    let mut last_error = None;
    for search in searches {
        match search.await {
            Ok(Ok(found)) => skills.extend(found.into_iter().filter(|s| seen.insert(s.id.clone()))),
            Ok(Err(e)) => last_error = Some(e),
            Err(e) => last_error = Some(Error::Cli(e.to_string())),
        }
    }
    if skills.is_empty()
        && let Some(error) = last_error
    {
        return Err(error);
    }
    skills.sort_by(|a, b| b.installs.cmp(&a.installs));
    skills.truncate(POPULAR_LIMIT);
    Ok(skills)
}

async fn fetch(query: &str, limit: usize) -> Result<Vec<SkillListing>> {
    #[derive(Deserialize)]
    struct Response {
        skills: Vec<SkillListing>,
    }
    let response = CLIENT
        .get(format!("{REGISTRY}/api/search"))
        .query(&[("q", query), ("limit", &limit.to_string())])
        .send()
        .await?
        .error_for_status()?;
    Ok(response.json::<Response>().await?.skills)
}

/// `npx skills add <source> --skill <name>` for Claude, user-wide. Resolves when the CLI exits.
pub async fn add(npx: &Path, source: &str, skill: &str) -> Result<()> {
    check_source(source)?;
    check_name(skill)?;
    run(npx, &["add", source, "--skill", skill, "--global", "--yes", "--agent", "claude-code"]).await
}

/// `npx skills remove <id>`, user-wide.
pub async fn remove(npx: &Path, id: &str) -> Result<()> {
    check_name(id)?;
    run(npx, &["remove", id, "--global", "--yes"]).await
}

async fn run(npx: &Path, args: &[&str]) -> Result<()> {
    let _turn = CLI.lock().await;

    let mut command = Command::new(npx);
    command.arg("--yes").arg("skills").args(args).kill_on_drop(true);
    command.env("NO_COLOR", "1").env("FORCE_COLOR", "0");
    // npx's `#!/usr/bin/env node` needs node on PATH; apps opened from Finder don't inherit the shell's.
    if let Some(bin) = npx.parent().filter(|dir| !dir.as_os_str().is_empty()) {
        let path = std::env::var_os("PATH").unwrap_or_default();
        let joined = std::env::join_paths(std::iter::once(bin.to_path_buf()).chain(std::env::split_paths(&path)))
            .map_err(|e| Error::Cli(e.to_string()))?;
        command.env("PATH", joined);
    }

    let output = tokio::time::timeout(INSTALL_TIMEOUT, command.output())
        .await
        .map_err(|_| Error::Cli("The skills CLI took longer than 3 minutes and was stopped".into()))?
        .map_err(|e| match e.kind() {
            std::io::ErrorKind::NotFound => Error::Cli("Node.js wasn't found, and the skills CLI runs on it".into()),
            _ => Error::Io(e),
        })?;

    if output.status.success() {
        return Ok(());
    }
    let text = format!("{}\n{}", String::from_utf8_lossy(&output.stdout), String::from_utf8_lossy(&output.stderr));
    Err(Error::Cli(failure_line(&text)))
}

/// The line of CLI output that says what went wrong, without colour codes or box drawing.
fn failure_line(output: &str) -> String {
    let lines: Vec<String> = output
        .lines()
        .map(|line| strip_ansi(line).trim_matches(|c: char| c.is_whitespace() || "│├└┌◇◆■▲●✗✖×─╮╯".contains(c)).to_string())
        .filter(|line| !line.is_empty() && !line.starts_with("npm warn"))
        .collect();
    let line = lines
        .iter()
        .find(|line| {
            let lower = line.to_lowercase();
            lower.contains("error") || lower.contains("failed") || lower.contains("not found") || lower.contains("no matching")
        })
        .or_else(|| lines.last());
    line.cloned().unwrap_or_else(|| "The skills CLI failed".into())
}

fn strip_ansi(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.peek() == Some(&'[') {
                chars.next();
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
            continue;
        }
        out.push(c);
    }
    out
}

fn check_source(source: &str) -> Result<()> {
    let valid = source.split('/').count() == 2
        && source.split('/').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c)))
        && !source.starts_with(['-', '.']);
    if valid { Ok(()) } else { Err(Error::Invalid(format!("“{source}” isn't an owner/repo source"))) }
}

fn check_name(name: &str) -> Result<()> {
    let valid = !name.is_empty()
        && !name.starts_with(['-', '.'])
        && name.chars().all(|c| c.is_alphanumeric() || " -_.:".contains(c));
    if valid { Ok(()) } else { Err(Error::Invalid(format!("“{name}” isn't a skill name"))) }
}

struct Locked {
    source: String,
    installed_at: Option<String>,
}

/// Folder name → where it came from. A missing or unreadable lock file is no sources.
fn read_lock(path: &Path) -> HashMap<String, Locked> {
    #[derive(Deserialize)]
    struct Lock {
        #[serde(default)]
        skills: HashMap<String, Entry>,
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Entry {
        source: String,
        installed_at: Option<String>,
    }
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| serde_json::from_str::<Lock>(&text).ok())
        .map(|lock| {
            lock.skills
                .into_iter()
                .map(|(id, e)| (id, Locked { source: e.source, installed_at: e.installed_at }))
                .collect()
        })
        .unwrap_or_default()
}

/// Top-level `key: value` pairs of a SKILL.md's YAML frontmatter, enough for
/// `name` and `description`: plain or quoted scalars and `>`/`|` blocks.
fn frontmatter(text: &str) -> HashMap<String, String> {
    let mut fields = HashMap::new();
    let mut lines = text.lines();
    if lines.next().map(str::trim) != Some("---") {
        return fields;
    }
    let body: Vec<&str> = lines.take_while(|line| line.trim() != "---").collect();

    let mut i = 0;
    while i < body.len() {
        let line = body[i];
        i += 1;
        if line.starts_with([' ', '\t']) {
            continue;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = value.trim();
        let value = if value.starts_with(['>', '|']) {
            let mut block = Vec::new();
            while i < body.len() && (body[i].starts_with([' ', '\t']) || body[i].trim().is_empty()) {
                block.push(body[i].trim());
                i += 1;
            }
            let separator = if value.starts_with('|') { "\n" } else { " " };
            block.join(separator).trim().to_string()
        } else {
            unquote(value)
        };
        fields.insert(key.trim().to_string(), value);
    }
    fields
}

fn unquote(value: &str) -> String {
    for quote in ['"', '\''] {
        if value.len() >= 2 && value.starts_with(quote) && value.ends_with(quote) {
            let inner = &value[1..value.len() - 1];
            return if quote == '\'' { inner.replace("''", "'") } else { inner.replace("\\\"", "\"") };
        }
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_plain_quoted_and_folded_frontmatter() {
        let plain = frontmatter("---\nname: tdd\ndescription: Test first.\n---\nBody");
        assert_eq!(plain["name"], "tdd");
        assert_eq!(plain["description"], "Test first.");

        let quoted = frontmatter("---\nname: \"review\"\ndescription: 'It''s a review: two axes'\n---\n");
        assert_eq!(quoted["name"], "review");
        assert_eq!(quoted["description"], "It's a review: two axes");

        let folded = frontmatter("---\nname: docs\ndescription: >\n  Keep docs\n  in step.\nlicense: MIT\n---\n");
        assert_eq!(folded["description"], "Keep docs in step.");
        assert_eq!(folded["license"], "MIT");

        assert!(frontmatter("no frontmatter").is_empty());
    }

    #[test]
    fn lists_installed_skills_with_their_source() {
        let home = tempfile::tempdir().unwrap();
        let paths = Paths {
            claude_dir: home.path().join(".claude"),
            claude_json: home.path().join(".claude.json"),
            skill_lock: home.path().join("lock.json"),
        };
        let write = |id: &str, manifest: &str| {
            let dir = paths.skills_dir().join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("SKILL.md"), manifest).unwrap();
        };
        write("tdd", "---\nname: tdd\ndescription: Test first.\n---\n");
        write("mine", "---\ndescription: Written by hand.\n---\n");
        std::fs::create_dir_all(paths.skills_dir().join("not-a-skill")).unwrap();
        std::fs::write(
            &paths.skill_lock,
            r#"{"version":3,"skills":{"tdd":{"source":"mattpocock/skills","installedAt":"2026-01-02T00:00:00Z"}}}"#,
        )
        .unwrap();

        let skills = installed(&paths).unwrap();
        assert_eq!(skills.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["mine", "tdd"]);
        assert_eq!(skills[0].name, "mine");
        assert_eq!(skills[0].source, None);
        assert_eq!(skills[1].source.as_deref(), Some("mattpocock/skills"));
        assert_eq!(skills[1].installed_at.as_deref(), Some("2026-01-02T00:00:00Z"));
    }

    #[test]
    fn a_missing_skills_folder_is_no_skills() {
        let home = tempfile::tempdir().unwrap();
        let paths = Paths {
            claude_dir: home.path().join("nowhere"),
            claude_json: home.path().join(".claude.json"),
            skill_lock: home.path().join("lock.json"),
        };
        assert!(installed(&paths).unwrap().is_empty());
    }

    #[test]
    fn rejects_sources_and_names_that_look_like_flags() {
        assert!(check_source("anthropics/skills").is_ok());
        assert!(check_source("--global").is_err());
        assert!(check_source("a/b/c").is_err());
        assert!(check_name("Skill Development").is_ok());
        assert!(check_name("-g").is_err());
    }

    #[test]
    fn picks_the_error_line_out_of_cli_output() {
        let output = "\u{1b}[36m│\u{1b}[0m\n◇  Cloning\n■  Error: No matching skills found for: nope\n└  Done";
        assert_eq!(failure_line(output), "Error: No matching skills found for: nope");
    }
}
