//! Running the user's command-line tools (`git`, `gh`, `brew`) the way their
//! terminal would: with their login shell's PATH, never waiting on a prompt.

use std::env;
use std::ffi::OsString;
use std::io::Write;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::RwLock;

#[cfg(target_os = "macos")]
pub const OPENER: &str = "open";
#[cfg(not(target_os = "macos"))]
pub const OPENER: &str = "xdg-open";

/// Why a tool didn't do its job.
#[derive(Debug)]
pub enum Failure {
    /// The program isn't installed (or isn't on the PATH).
    NotFound,
    /// It ran and failed; holds what it printed to stderr.
    Failed(String),
    /// It couldn't be started for another reason.
    Io(String),
}

/// `program` set up to run in `root` with the login PATH and no prompts.
pub fn command(program: &str, root: Option<&Path>) -> Command {
    let mut command = Command::new(program);
    command
        .env("PATH", login_path())
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("NO_COLOR", "1")
        .stdin(Stdio::null());
    if let Some(root) = root {
        command.current_dir(root);
    }
    command
}

/// Runs `program` and returns its trimmed stdout.
pub fn run(root: Option<&Path>, program: &str, args: &[&str]) -> Result<String, Failure> {
    run_with_input(root, program, args, None)
}

/// Like [`run`], writing `input` to the program's stdin (for `--body-file -`, `commit -F -`).
pub fn run_with_input(root: Option<&Path>, program: &str, args: &[&str], input: Option<&str>) -> Result<String, Failure> {
    let mut command = command(program, root);
    command.args(args).stdout(Stdio::piped()).stderr(Stdio::piped());
    if input.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|e| spawn_failure(program, e))?;
    if let (Some(input), Some(mut stdin)) = (input, child.stdin.take()) {
        stdin.write_all(input.as_bytes()).map_err(|e| Failure::Io(e.to_string()))?;
    }
    let output = child.wait_with_output().map_err(|e| Failure::Io(e.to_string()))?;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        let message = [stderr, stdout].into_iter().find(|s| !s.is_empty());
        return Err(Failure::Failed(message.unwrap_or_else(|| format!("{program} {} failed", args.first().unwrap_or(&"")))));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_owned())
}

pub fn spawn_failure(program: &str, error: std::io::Error) -> Failure {
    match error.kind() {
        std::io::ErrorKind::NotFound => Failure::NotFound,
        _ => Failure::Io(format!("Couldn't run {program}: {error}")),
    }
}

/// Opens a URL in the default browser.
pub fn open_url(url: &str) {
    let _ = Command::new(OPENER).arg(url).stdin(Stdio::null()).spawn();
}

static PATH: RwLock<Option<OsString>> = RwLock::new(None);

/// The PATH of the user's login shell, read once (and again after
/// [`refresh_login_path`]). Apps opened from Finder start with a bare PATH that
/// misses Homebrew's `gh`.
pub fn login_path() -> OsString {
    if let Some(path) = PATH.read().unwrap().as_ref() {
        return path.clone();
    }
    let path = read_login_path();
    *PATH.write().unwrap() = Some(path.clone());
    path
}

/// Reads the login PATH again, e.g. after installing a tool into a new folder.
pub fn refresh_login_path() {
    *PATH.write().unwrap() = Some(read_login_path());
}

fn read_login_path() -> OsString {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let login = Command::new(shell)
        .args(["-ilc", "printf '__ELARIS__%s__ELARIS__' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .ok()
        .and_then(|out| {
            let text = String::from_utf8_lossy(&out.stdout).into_owned();
            text.split("__ELARIS__").nth(1).map(OsString::from)
        });
    let mut dirs: Vec<_> = login.iter().flat_map(env::split_paths).collect();
    dirs.extend(env::var_os("PATH").iter().flat_map(env::split_paths));
    // Homebrew's usual homes, so a fresh install is found even before the shell knows it.
    dirs.extend(["/opt/homebrew/bin", "/usr/local/bin"].map(Into::into));
    // Dev only: hide tools to try the "not installed" screens.
    if let Some(hidden) = env::var_os("ELARIS_HIDE_PATH") {
        let hidden: Vec<_> = env::split_paths(&hidden).collect();
        dirs.retain(|d| !hidden.contains(d));
    }
    env::join_paths(dirs).unwrap_or_default()
}
