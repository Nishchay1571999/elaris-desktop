//! Instructions: the `CLAUDE.md` files the agent reads at the start of every
//! chat, as Claude Code does. Yours in `~/.claude`, the open folder's own
//! (shared and local), and any in the folders above it.
//!
//! Only files in that list can be written or deleted, so the UI can't be used
//! to touch anything else on disk.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

use serde::Serialize;
use ts_rs::TS;

use crate::{Error, Paths, Result};

/// Files bigger than this aren't instructions anyone wrote by hand.
const MAX_BYTES: u64 = 512 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum InstructionScope {
    /// `~/.claude/CLAUDE.md`, read in every folder.
    User,
    /// A `CLAUDE.md` or `CLAUDE.local.md` in a folder above the open one.
    Parent,
    /// The open folder's `CLAUDE.md` or `.claude/CLAUDE.md`, usually committed.
    Project,
    /// The open folder's `CLAUDE.local.md`, usually kept out of git.
    Local,
}

/// One instructions file, read or not yet created.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct InstructionFile {
    pub scope: InstructionScope,
    /// Absolute path; also the file's id for saving and deleting.
    pub path: String,
    pub exists: bool,
    /// Empty when the file doesn't exist.
    pub content: String,
    /// Last modified, in milliseconds since the epoch.
    #[ts(type = "number | null")]
    pub modified_ms: Option<u64>,
}

/// The files the agent reads, in the order it reads them: yours, then the
/// folders above the open one from the outermost in, then the open folder's.
/// Files that can be created are listed even when missing.
pub fn list(paths: &Paths, project: Option<&Path>) -> Result<Vec<InstructionFile>> {
    candidates(paths, project).into_iter().map(|(scope, path)| read(scope, &path)).collect()
}

/// Writes `content` to the file at `path`, creating it (and `.claude/`) if
/// needed. `expected` is the content the editor started from (`None` for a
/// new file); if the file changed on disk since, nothing is written.
pub fn save(
    paths: &Paths,
    project: Option<&Path>,
    path: &str,
    content: &str,
    expected: Option<&str>,
) -> Result<Vec<InstructionFile>> {
    let (_, target) = find(paths, project, path)?;
    check_unchanged(&target, expected)?;
    if let Some(dir) = target.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let temp = target.with_extension(format!("md.elaris-{}", std::process::id()));
    std::fs::write(&temp, content)?;
    if let Ok(meta) = std::fs::metadata(&target) {
        std::fs::set_permissions(&temp, meta.permissions())?;
    }
    std::fs::rename(&temp, &target).inspect_err(|_| {
        let _ = std::fs::remove_file(&temp);
    })?;
    list(paths, project)
}

/// Deletes the file at `path` if it still holds `expected`.
pub fn delete(paths: &Paths, project: Option<&Path>, path: &str, expected: &str) -> Result<Vec<InstructionFile>> {
    let (_, target) = find(paths, project, path)?;
    check_unchanged(&target, Some(expected))?;
    std::fs::remove_file(&target)?;
    list(paths, project)
}

fn candidates(paths: &Paths, project: Option<&Path>) -> Vec<(InstructionScope, PathBuf)> {
    let mut files = vec![(InstructionScope::User, paths.claude_dir.join("CLAUDE.md"))];
    let Some(root) = project else { return files };

    // Folders above are only listed when they already have instructions.
    let mut above: Vec<&Path> = root.ancestors().skip(1).filter(|dir| dir.parent().is_some()).collect();
    above.reverse();
    for dir in above {
        for name in ["CLAUDE.md", "CLAUDE.local.md"] {
            let path = dir.join(name);
            if path.is_file() && path != files[0].1 {
                files.push((InstructionScope::Parent, path));
            }
        }
    }

    files.push((InstructionScope::Project, root.join("CLAUDE.md")));
    // The second project location is offered only if someone already uses it.
    let nested = root.join(".claude/CLAUDE.md");
    if nested.is_file() {
        files.push((InstructionScope::Project, nested));
    }
    files.push((InstructionScope::Local, root.join("CLAUDE.local.md")));
    files
}

fn find(paths: &Paths, project: Option<&Path>, path: &str) -> Result<(InstructionScope, PathBuf)> {
    candidates(paths, project)
        .into_iter()
        .find(|(_, candidate)| candidate.as_os_str() == path)
        .ok_or_else(|| Error::Invalid(format!("{path} isn't an instructions file for this folder")))
}

fn read(scope: InstructionScope, path: &Path) -> Result<InstructionFile> {
    let meta = match std::fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(InstructionFile {
                scope,
                path: path.display().to_string(),
                exists: false,
                content: String::new(),
                modified_ms: None,
            });
        }
        Err(e) => return Err(e.into()),
    };
    if meta.len() > MAX_BYTES {
        return Err(Error::Invalid(format!("{} is over 512 KB, too big to edit here", path.display())));
    }
    let bytes = std::fs::read(path)?;
    let modified_ms = meta
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|age| age.as_millis() as u64);
    Ok(InstructionFile {
        scope,
        path: path.display().to_string(),
        exists: true,
        content: String::from_utf8_lossy(&bytes).into_owned(),
        modified_ms,
    })
}

fn check_unchanged(path: &Path, expected: Option<&str>) -> Result<()> {
    let current = match std::fs::read(path) {
        Ok(bytes) => Some(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    if current.as_deref() == expected {
        Ok(())
    } else {
        Err(Error::Invalid(format!(
            "{} changed on disk since you opened it. Reload to see the new version.",
            path.display()
        )))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> (tempfile::TempDir, Paths, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let claude_dir = dir.path().join("home/.claude");
        let paths = Paths {
            claude_json: dir.path().join("home/.claude.json"),
            skill_lock: dir.path().join("lock.json"),
            claude_dir,
        };
        let project = dir.path().join("code/app");
        std::fs::create_dir_all(&project).unwrap();
        (dir, paths, project)
    }

    fn scopes(files: &[InstructionFile]) -> Vec<(InstructionScope, bool)> {
        files.iter().map(|f| (f.scope, f.exists)).collect()
    }

    #[test]
    fn lists_what_can_be_created_and_only_parents_that_exist() {
        let (dir, paths, project) = setup();
        std::fs::write(dir.path().join("code/CLAUDE.md"), "Use pnpm.").unwrap();

        let files = list(&paths, Some(&project)).unwrap();
        assert_eq!(
            scopes(&files),
            [
                (InstructionScope::User, false),
                (InstructionScope::Parent, true),
                (InstructionScope::Project, false),
                (InstructionScope::Local, false),
            ]
        );
        assert_eq!(files[1].content, "Use pnpm.");
        assert_eq!(scopes(&list(&paths, None).unwrap()), [(InstructionScope::User, false)]);
    }

    #[test]
    fn saves_creates_folders_and_refuses_stale_edits() {
        let (_dir, paths, project) = setup();
        let user = paths.claude_dir.join("CLAUDE.md").display().to_string();

        let files = save(&paths, Some(&project), &user, "Be brief.", None).unwrap();
        assert!(files[0].exists);
        assert_eq!(files[0].content, "Be brief.");

        // The editor started from an older copy.
        assert!(save(&paths, Some(&project), &user, "Be thorough.", Some("Be terse.")).is_err());
        assert!(save(&paths, Some(&project), &user, "Be thorough.", None).is_err());
        assert_eq!(std::fs::read_to_string(&user).unwrap(), "Be brief.");

        save(&paths, Some(&project), &user, "Be thorough.", Some("Be brief.")).unwrap();
        let files = delete(&paths, Some(&project), &user, "Be thorough.").unwrap();
        assert!(!files[0].exists);
    }

    #[test]
    fn refuses_paths_that_are_not_instructions() {
        let (_dir, paths, project) = setup();
        let other = project.join("package.json").display().to_string();
        assert!(save(&paths, Some(&project), &other, "{}", None).is_err());
        assert!(!project.join("package.json").exists());
    }
}
