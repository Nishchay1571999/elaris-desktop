//! Per-side diffs through the git CLI, so a hunk cut from them can be fed
//! straight back to `git apply`.

use std::path::Path;

use serde::Deserialize;
use ts_rs::TS;

use super::{DIFF_LIMIT, runner};
use crate::Result;

/// Which change of a file to diff.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum DiffSide {
    /// Index against HEAD: what the next commit takes.
    Staged,
    /// Work tree against the index.
    Unstaged,
    /// A file git doesn't track yet, shown as all added.
    Untracked,
}

/// Unified diff of `rel` (workspace-relative) for one side, cut off past
/// [`DIFF_LIMIT`]. Paths in its headers are relative to the repository root.
pub(crate) fn diff_file(root: &Path, rel: &str, side: DiffSide) -> Result<String> {
    let opts = || runner::Opts { read_only: true, ..runner::Opts::default() };
    let out = match side {
        DiffSide::Staged => runner::run(root, &["diff", "--cached", "--no-ext-diff", "-M", "--", rel], opts())?,
        DiffSide::Unstaged => runner::run(root, &["diff", "--no-ext-diff", "--", rel], opts())?,
        DiffSide::Untracked => runner::run(
            root,
            &["diff", "--no-index", "--no-ext-diff", "--", "/dev/null", rel],
            // `--no-index` exits 1 when the files differ, which they always do.
            runner::Opts { ok_codes: &[1], ..opts() },
        )?,
    };
    Ok(cut(out, DIFF_LIMIT))
}

/// Applies a patch in the repository root: to the index (`cached`), the work
/// tree, or reversed to undo it. How hunks get staged, unstaged and reverted.
pub(crate) fn apply_patch(root: &Path, patch: &str, cached: bool, reverse: bool) -> Result<()> {
    let top = super::toplevel(root)?;
    let mut args = vec!["apply", "--recount", "--whitespace=nowarn"];
    if cached {
        args.push("--cached");
    }
    if reverse {
        args.push("--reverse");
    }
    args.push("-");
    runner::git_input(&top, &args, patch).map(drop)
}

/// `text` up to about `limit` bytes, ending on a whole line.
pub(crate) fn cut(mut text: String, limit: usize) -> String {
    if text.len() > limit {
        let mut end = limit;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        let end = text[..end].rfind('\n').map_or(end, |i| i + 1);
        text.truncate(end);
    }
    text
}
