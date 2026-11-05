//! The one place the git CLI runs. Every call comes through here so it gets
//! the same environment (no prompts, no editor) and so the Git Output view can
//! show exactly what ran and what git said.

use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, RwLock};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use ts_rs::TS;

use crate::{Error, Result};

/// Output kept per stream in the log; the rest is dropped.
const LOG_LIMIT: usize = 64 * 1024;

/// One git invocation, as shown in the Git Output view.
#[derive(Debug, Clone, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct GitOutputEntry {
    pub id: u32,
    /// Arguments after `git`.
    pub args: Vec<String>,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub started_at: u64,
    pub duration_ms: u32,
    /// `None` when git couldn't be started or was killed by a signal.
    pub exit_code: Option<i32>,
    /// Empty for read-only calls such as `status`, which run on every change.
    pub stdout: String,
    pub stderr: String,
}

type Hook = Arc<dyn Fn(&mut Command) + Send + Sync>;
type Sink = Arc<dyn Fn(GitOutputEntry) + Send + Sync>;

static HOOK: RwLock<Option<Hook>> = RwLock::new(None);
static SINK: RwLock<Option<Sink>> = RwLock::new(None);
static NEXT_ID: AtomicU32 = AtomicU32::new(1);

/// Adjusts every git command before it runs; the app uses it to supply the
/// login shell's PATH.
pub fn set_command_hook(hook: impl Fn(&mut Command) + Send + Sync + 'static) {
    *HOOK.write().unwrap() = Some(Arc::new(hook));
}

/// Receives a record of every git command once it finishes.
pub fn set_output_sink(sink: impl Fn(GitOutputEntry) + Send + Sync + 'static) {
    *SINK.write().unwrap() = Some(Arc::new(sink));
}

#[derive(Default)]
pub(crate) struct Opts<'a> {
    /// Written to git's stdin (`commit -F -`, `apply -`).
    pub input: Option<&'a str>,
    /// Exit codes besides 0 that aren't failures (`diff --no-index` exits 1).
    pub ok_codes: &'a [i32],
    /// Takes no locks and leaves stdout out of the log.
    pub read_only: bool,
    /// Called with each progress or message line git prints to stderr.
    pub progress: Option<&'a mut dyn FnMut(&str)>,
}

/// Runs `git args` in `dir` and returns its raw stdout.
pub(crate) fn run(dir: &Path, args: &[&str], opts: Opts) -> Result<String> {
    let Opts { input, ok_codes, read_only, mut progress } = opts;
    let mut command = Command::new("git");
    command
        // Paths with non-ASCII names print as-is instead of octal escapes.
        .args(["-c", "core.quotepath=false"])
        .args(args)
        .current_dir(dir)
        .env("GIT_TERMINAL_PROMPT", "0")
        // Merges and rebases continue with the message git prepared.
        .env("GIT_EDITOR", "true")
        .env("GIT_SEQUENCE_EDITOR", "true")
        .env("NO_COLOR", "1")
        .stdin(if input.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if read_only {
        command.env("GIT_OPTIONAL_LOCKS", "0");
    }
    if let Some(hook) = HOOK.read().unwrap().clone() {
        hook(&mut command);
    }

    let started_at = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0);
    let clock = Instant::now();
    let record = |exit_code: Option<i32>, stdout: &str, stderr: &str| {
        let Some(sink) = SINK.read().unwrap().clone() else { return };
        sink(GitOutputEntry {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            args: args.iter().map(|a| (*a).to_owned()).collect(),
            started_at,
            duration_ms: clock.elapsed().as_millis() as u32,
            exit_code,
            stdout: if read_only { String::new() } else { clip(stdout) },
            stderr: clip(stderr),
        });
    };

    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            let message = if error.kind() == std::io::ErrorKind::NotFound {
                "git wasn't found; install the Xcode command line tools or git".to_owned()
            } else {
                format!("Couldn't run git: {error}")
            };
            record(None, "", &message);
            return Err(Error::GitCommand(message));
        }
    };
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        // A git that exits early closes its stdin; what it printed says why.
        let _ = stdin.write_all(input.as_bytes());
    }
    let mut stdout_pipe = child.stdout.take().expect("piped stdout");
    let reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let _ = stdout_pipe.read_to_end(&mut bytes);
        bytes
    });
    let stderr = read_stderr(child.stderr.take().expect("piped stderr"), progress.as_deref_mut());
    let stdout = String::from_utf8_lossy(&reader.join().unwrap_or_default()).into_owned();
    let status = child.wait()?;

    record(status.code(), &stdout, &stderr);
    match status.code() {
        Some(0) => Ok(stdout),
        Some(code) if ok_codes.contains(&code) => Ok(stdout),
        _ => {
            let message = [stderr.trim(), stdout.trim()].into_iter().find(|s| !s.is_empty()).map(str::to_owned);
            Err(Error::GitCommand(message.unwrap_or_else(|| format!("git {} failed", args.first().unwrap_or(&"")))))
        }
    }
}

/// Runs a command that changes the repository; its trimmed stdout.
pub(crate) fn git(dir: &Path, args: &[&str]) -> Result<String> {
    run(dir, args, Opts::default()).map(|out| out.trim().to_owned())
}

/// Like [`git`], writing `input` to stdin.
pub(crate) fn git_input(dir: &Path, args: &[&str], input: &str) -> Result<String> {
    run(dir, args, Opts { input: Some(input), ..Opts::default() }).map(|out| out.trim().to_owned())
}

/// Runs a command that only reads; its trimmed stdout.
pub(crate) fn read(dir: &Path, args: &[&str]) -> Result<String> {
    run(dir, args, Opts { read_only: true, ..Opts::default() }).map(|out| out.trim().to_owned())
}

/// Reads stderr to the end. Progress meters redraw with `\r`, so each
/// `\r`- or `\n`-terminated piece goes to `progress`, and only the final
/// state of each line is kept.
fn read_stderr<'p>(mut pipe: impl Read, mut progress: Option<&mut (dyn FnMut(&str) + 'p)>) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut current = Vec::new();
    let mut buf = [0u8; 4096];
    let mut flush = |current: &mut Vec<u8>, newline: bool, lines: &mut Vec<String>| {
        let text = String::from_utf8_lossy(current).trim_end().to_owned();
        current.clear();
        if text.is_empty() {
            // `…done.\r\n`: the last redraw is the meter's final state.
            if let Some(last) = lines.last_mut().filter(|l| newline && l.starts_with('\r')) {
                last.remove(0);
            }
            return;
        }
        if let Some(progress) = progress.as_mut() {
            progress(&text);
        }
        if newline {
            lines.push(text);
        } else {
            // A `\r` redraw: remember it until the next piece replaces it.
            lines.push(format!("\r{text}"));
        }
    };
    loop {
        let read = match pipe.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for &byte in &buf[..read] {
            match byte {
                b'\n' => flush(&mut current, true, &mut lines),
                b'\r' => flush(&mut current, false, &mut lines),
                _ => current.push(byte),
            }
        }
    }
    flush(&mut current, true, &mut lines);
    // Drop redraws that were superseded, keeping the last state of each meter.
    let mut kept: Vec<String> = Vec::new();
    for line in lines {
        if kept.last().is_some_and(|prev| prev.starts_with('\r')) {
            kept.pop();
        }
        kept.push(line);
    }
    kept.iter().map(|l| l.trim_start_matches('\r')).collect::<Vec<_>>().join("\n")
}

fn clip(text: &str) -> String {
    if text.len() <= LOG_LIMIT {
        return text.to_owned();
    }
    let mut end = LOG_LIMIT;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… (output cut off)", &text[..end])
}
