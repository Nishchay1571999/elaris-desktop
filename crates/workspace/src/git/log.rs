//! Commit history for the graph and the commit view.

use std::path::Path;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use super::runner::{self, Opts, read};
use super::{DIFF_LIMIT, diff::cut};
use crate::Result;

const FIELD: char = '\u{1f}';
const RECORD: char = '\u{1e}';

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GraphCommit {
    pub sha: String,
    /// Parent hashes; two or more for a merge.
    pub parents: Vec<String>,
    pub author: String,
    pub email: String,
    /// Author time, seconds since the Unix epoch.
    #[ts(type = "number")]
    pub time: i64,
    /// Branches and tags here, as git decorates them: `HEAD -> main`,
    /// `origin/main`, `tag: v1.0`.
    pub refs: Vec<String>,
    pub subject: String,
}

#[derive(Debug, Clone, Deserialize, TS)]
#[serde(rename_all = "camelCase", default)]
#[ts(export)]
pub struct LogOptions {
    pub skip: u32,
    pub limit: u32,
    /// Every branch and tag, not just what HEAD reaches.
    pub all: bool,
}

impl Default for LogOptions {
    fn default() -> Self {
        Self { skip: 0, limit: 200, all: true }
    }
}

const LOG_FORMAT: &str = "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1e";

/// Commits newest first, in an order where children come before parents.
pub(crate) fn log(root: &Path, options: &LogOptions) -> Result<Vec<GraphCommit>> {
    if read(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() && !options.all {
        return Ok(Vec::new());
    }
    let skip = format!("--skip={}", options.skip);
    let limit = format!("--max-count={}", options.limit.clamp(1, 2000));
    let mut args = vec!["log", "--topo-order", "--decorate=short", LOG_FORMAT, &skip, &limit];
    args.push(if options.all { "--all" } else { "HEAD" });
    let out = match read(root, &args) {
        Ok(out) => out,
        // `--all` in a repo with no commits at all has nothing to show.
        Err(_) if read(root, &["rev-parse", "--verify", "--quiet", "HEAD"]).is_err() => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    Ok(out.split(RECORD).filter_map(|record| parse_commit(record.trim_start_matches('\n'))).collect())
}

fn parse_commit(record: &str) -> Option<GraphCommit> {
    let mut f = record.split(FIELD);
    let sha = f.next()?.trim().to_owned();
    if sha.is_empty() {
        return None;
    }
    Some(GraphCommit {
        sha,
        parents: f.next()?.split_whitespace().map(str::to_owned).collect(),
        author: f.next()?.to_owned(),
        email: f.next()?.to_owned(),
        time: f.next()?.parse().unwrap_or(0),
        refs: f.next()?.split(", ").filter(|r| !r.is_empty()).map(str::to_owned).collect(),
        subject: f.next().unwrap_or_default().to_owned(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CommitDetail {
    pub commit: GraphCommit,
    /// The full message, subject and body.
    pub message: String,
    pub committer: String,
    /// Changes against the first parent, as a multi-file unified diff.
    pub patch: String,
}

pub(crate) fn show(root: &Path, sha: &str) -> Result<CommitDetail> {
    let meta = read(root, &["show", "-s", "--decorate=short", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%D%x1f%s%x1f%cn%x1f%B", sha, "--"])?;
    let commit = parse_commit(&meta).ok_or_else(|| crate::Error::GitCommand(format!("No commit {sha}")))?;
    let mut rest = meta.split(FIELD).skip(7);
    let committer = rest.next().unwrap_or_default().to_owned();
    let message = rest.next().unwrap_or_default().trim().to_owned();
    // Merges diff against their first parent rather than as a combined diff.
    let patch = runner::run(
        root,
        &["show", "--format=", "-m", "--first-parent", "-M", "--no-ext-diff", "--patch", sha, "--"],
        Opts { read_only: true, ..Opts::default() },
    )?;
    Ok(CommitDetail { commit, message, committer, patch: cut(patch, DIFF_LIMIT * 4) })
}
