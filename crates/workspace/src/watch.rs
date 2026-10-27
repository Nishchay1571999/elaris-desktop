use std::path::Path;
use std::time::Duration;

use notify_debouncer_full::notify::{self, RecommendedWatcher, RecursiveMode};
use notify_debouncer_full::{DebounceEventResult, Debouncer, NoCache, new_debouncer_opt};

use crate::{Result, relative};

/// Watches a workspace recursively and reports batches of changed paths.
/// Watching stops when this is dropped.
pub struct Watcher {
    _debouncer: Debouncer<RecommendedWatcher, NoCache>,
}

impl Watcher {
    /// Calls `on_change` with relative paths roughly 300 ms after activity
    /// settles. Churn inside `.git` is dropped except for the files that change
    /// what `git status` reports (index, HEAD, refs).
    ///
    /// Runs without a file-ID cache: on macOS the default one stats every
    /// file under `root` (node_modules, target, symlinks followed) before
    /// returning, which made opening a big project take seconds. It only
    /// pairs up renames, and we report plain paths anyway.
    pub fn start(root: &Path, on_change: impl Fn(Vec<String>) + Send + 'static) -> Result<Self> {
        let base = root.to_path_buf();
        let mut debouncer = new_debouncer_opt::<_, RecommendedWatcher, _>(
            Duration::from_millis(300),
            None,
            move |result: DebounceEventResult| {
                let Ok(events) = result else { return };
                let mut paths: Vec<String> = events
                    .iter()
                    .flat_map(|event| event.paths.iter())
                    .filter_map(|path| relative(&base, path))
                    .filter(|path| is_interesting(path))
                    .collect();
                paths.sort();
                paths.dedup();
                if !paths.is_empty() {
                    on_change(paths);
                }
            },
            NoCache,
            notify::Config::default(),
        )?;
        debouncer.watch(root, RecursiveMode::Recursive)?;
        Ok(Self { _debouncer: debouncer })
    }
}

fn is_interesting(path: &str) -> bool {
    match path.strip_prefix(".git/") {
        Some(inner) => inner == "index" || inner == "HEAD" || inner.starts_with("refs/"),
        None => path != ".git",
    }
}
