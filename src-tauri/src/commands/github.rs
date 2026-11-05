//! GitHub through the user's own `gh` CLI: install, sign-in, and pull requests.
//! Nothing talks to GitHub but `gh`, signed in as the user, on this machine.
//! gh's JSON goes to the UI as-is; `src/lib/github.ts` types it.

use std::io::{BufRead, BufReader, Read, Write};
use std::path::Path;
use std::process::{Child, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::State;
use tauri::ipc::Channel;

use crate::commands::git::push_current;
use crate::error::{CommandError, CommandResult, GitHubErrorKind, blocking};
use crate::gh_snapshot;
use crate::shell::{self, Failure};
use crate::state::AppState;
use contexts::{ItemSummary, NewAsset, NewItem};
use workspace::Workspace;

const DEVICE_URL: &str = "https://github.com/login/device";

/// The `gh auth login` running for the sign-in card, so Cancel can stop it.
pub static LOGIN: Mutex<Option<Child>> = Mutex::new(None);

fn gh_error(kind: GitHubErrorKind, message: impl Into<String>) -> CommandError {
    CommandError::GitHub { kind, message: message.into() }
}

fn not_signed_in(message: &str) -> bool {
    let m = message.to_lowercase();
    m.contains("gh auth login") || m.contains("not logged") || m.contains("authentication required") || m.contains("bad credentials")
}

/// Runs gh in `root`; its trimmed stdout. A missing gh or a signed-out one gets its own error kind.
fn gh(root: Option<&Path>, args: &[&str], input: Option<&str>) -> CommandResult<String> {
    shell::run_with_input(root, "gh", args, input).map_err(|failure| match failure {
        Failure::NotFound => gh_error(GitHubErrorKind::NotInstalled, "The GitHub CLI (gh) isn't installed"),
        Failure::Failed(message) if not_signed_in(&message) => {
            gh_error(GitHubErrorKind::NotSignedIn, "Sign in to GitHub to continue")
        }
        Failure::Failed(message) | Failure::Io(message) => gh_error(GitHubErrorKind::Other, message),
    })
}

fn gh_json(root: Option<&Path>, args: &[&str]) -> CommandResult<Value> {
    let out = gh(root, args, None)?;
    serde_json::from_str(&out).map_err(|e| gh_error(GitHubErrorKind::Other, format!("Unexpected output from gh: {e}")))
}

/* ------------------------------------------------------------------------- */
/* Setup and sign-in                                                         */
/* ------------------------------------------------------------------------- */

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GhStatus {
    installed: bool,
    version: Option<String>,
    /// Homebrew is there to install gh with.
    brew_available: bool,
    /// The signed-in account, if any.
    user: Option<Value>,
}

#[tauri::command]
pub async fn gh_status() -> CommandResult<GhStatus> {
    blocking(|| {
        let brew_available = shell::run(None, "brew", &["--version"]).is_ok();
        let version = match shell::run(None, "gh", &["--version"]) {
            Ok(out) => out.lines().next().map(|l| l.trim_start_matches("gh version ").to_owned()),
            Err(_) => return Ok::<_, CommandError>(GhStatus { installed: false, version: None, brew_available, user: None }),
        };
        let user = gh_json(None, &["api", "user", "--jq", "{login, name, avatarUrl: .avatar_url, url: .html_url}"]).ok();
        Ok(GhStatus { installed: true, version, brew_available, user })
    })
    .await
}

#[derive(Clone, Serialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum SetupEvent {
    /// A line the tool printed, for the progress log.
    Line { text: String },
    /// The one-time code to enter at `url`.
    Code { code: String, url: String },
}

/// Installs gh with Homebrew, streaming brew's output.
#[tauri::command]
pub async fn gh_install(on_event: Channel<SetupEvent>) -> CommandResult<()> {
    blocking(move || {
        let mut child = shell::command("brew", None)
            .args(["install", "gh"])
            .env("HOMEBREW_NO_AUTO_UPDATE", "1")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| match shell::spawn_failure("brew", e) {
                Failure::NotFound => gh_error(GitHubErrorKind::NotInstalled, "Homebrew isn't installed"),
                Failure::Failed(m) | Failure::Io(m) => gh_error(GitHubErrorKind::Other, m),
            })?;
        let readers = [stream(child.stdout.take(), on_event.clone(), |_| {}), stream(child.stderr.take(), on_event.clone(), |_| {})];
        let status = child.wait().map_err(|e| gh_error(GitHubErrorKind::Other, e.to_string()))?;
        readers.into_iter().flatten().for_each(|r| drop(r.join()));
        shell::refresh_login_path();
        if status.success() { Ok(()) } else { Err(gh_error(GitHubErrorKind::NotInstalled, "brew install gh failed; see the log above")) }
    })
    .await
}

/// Signs in with GitHub's device flow, no terminal needed: sends the one-time
/// code to the UI, opens the browser, and waits for the user to approve.
#[tauri::command]
pub async fn gh_login(on_event: Channel<SetupEvent>) -> CommandResult<()> {
    blocking(move || {
        let mut child = shell::command("gh", None)
            .args(["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web", "--skip-ssh-key"])
            .env_remove("GH_PROMPT_DISABLED")
            // gh opens the browser itself after Enter; this keeps it from failing headless.
            .env("GH_BROWSER", shell::OPENER)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| match shell::spawn_failure("gh", e) {
                Failure::NotFound => gh_error(GitHubErrorKind::NotInstalled, "The GitHub CLI (gh) isn't installed"),
                Failure::Failed(m) | Failure::Io(m) => gh_error(GitHubErrorKind::Other, m),
            })?;
        let mut stdin = child.stdin.take();
        let (code_tx, code_rx) = std::sync::mpsc::channel::<()>();
        let on_line = {
            let on_event = on_event.clone();
            move |line: &str| {
                if let Some(code) = one_time_code(line) {
                    let _ = on_event.send(SetupEvent::Code { code, url: DEVICE_URL.to_owned() });
                    let _ = code_tx.send(());
                }
            }
        };
        let readers = [stream(child.stdout.take(), on_event.clone(), on_line.clone()), stream(child.stderr.take(), on_event.clone(), on_line)];
        *LOGIN.lock().unwrap() = Some(child);

        // gh waits for Enter before opening the browser.
        if code_rx.recv_timeout(Duration::from_secs(20)).is_ok()
            && let Some(stdin) = stdin.as_mut()
        {
            let _ = stdin.write_all(b"\n");
        }
        drop(stdin);

        let status = loop {
            let mut slot = LOGIN.lock().unwrap();
            let Some(child) = slot.as_mut() else { break None };
            match child.try_wait() {
                Ok(Some(status)) => {
                    slot.take();
                    break Some(status);
                }
                Ok(None) => {}
                Err(_) => break None,
            }
            drop(slot);
            thread::sleep(Duration::from_millis(250));
        };
        readers.into_iter().flatten().for_each(|r| drop(r.join()));
        match status {
            Some(status) if status.success() => {
                // So `git push` over https uses gh's token.
                let _ = gh(None, &["auth", "setup-git"], None);
                Ok(())
            }
            Some(_) => Err(gh_error(GitHubErrorKind::NotSignedIn, "Sign-in didn't finish")),
            None => Err(gh_error(GitHubErrorKind::NotSignedIn, "Sign-in was cancelled")),
        }
    })
    .await
}

#[tauri::command]
pub fn gh_login_cancel() {
    if let Some(mut child) = LOGIN.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

#[tauri::command]
pub async fn gh_logout() -> CommandResult<()> {
    blocking(|| gh(None, &["auth", "logout", "--hostname", "github.com"], None).map(drop)).await
}

/// `XXXX-XXXX` from gh's "First copy your one-time code: XXXX-XXXX".
fn one_time_code(line: &str) -> Option<String> {
    let (_, rest) = line.split_once("one-time code:")?;
    let code = rest.trim().split_whitespace().next()?;
    (code.len() >= 8 && code.contains('-')).then(|| code.to_owned())
}

/// Forwards each line of `pipe` to the UI (and `on_line`) from a thread.
fn stream<R: Read + Send + 'static>(
    pipe: Option<R>,
    events: Channel<SetupEvent>,
    on_line: impl Fn(&str) + Send + 'static,
) -> Option<thread::JoinHandle<()>> {
    let pipe = pipe?;
    Some(thread::spawn(move || {
        // gh prints its prompts without a trailing newline, so split on both.
        let mut reader = BufReader::new(pipe);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let text = String::from_utf8_lossy(&buf).trim_end().to_owned();
                    if text.is_empty() {
                        continue;
                    }
                    on_line(&text);
                    let _ = events.send(SetupEvent::Line { text });
                }
            }
        }
    }))
}

/* ------------------------------------------------------------------------- */
/* The repository and its pull requests                                      */
/* ------------------------------------------------------------------------- */

/// The open folder's GitHub repository, or null when it has no GitHub remote.
#[tauri::command]
pub async fn gh_repo(state: State<'_, AppState>) -> CommandResult<Option<Value>> {
    let workspace = state.require_workspace()?;
    blocking(move || {
        match gh_json(
            Some(workspace.root()),
            &["repo", "view", "--json", "nameWithOwner,url,defaultBranchRef,viewerPermission,isFork,owner"],
        ) {
            Ok(repo) => Ok(Some(repo)),
            Err(CommandError::GitHub { kind: GitHubErrorKind::Other, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    })
    .await
}

const LIST_FIELDS: &str = "number,title,author,headRefName,baseRefName,isDraft,state,createdAt,updatedAt,reviewDecision,statusCheckRollup,additions,deletions,labels,url,comments";
const VIEW_FIELDS: &str = "number,title,body,author,headRefName,baseRefName,isDraft,state,createdAt,updatedAt,mergedAt,closedAt,reviewDecision,statusCheckRollup,additions,deletions,changedFiles,labels,url,comments,reviews,files,commits,mergeable,mergeStateStatus,reviewRequests";

/// Where a pull request or issue lives: `owner/name` when the UI names one (lists span every
/// repository), otherwise the open folder's repository.
struct Target {
    workspace: Option<Workspace>,
    repo: Option<String>,
}

impl Target {
    fn new(state: &AppState, repo: Option<String>) -> CommandResult<Self> {
        match repo {
            Some(repo) => Ok(Self { workspace: None, repo: Some(repo) }),
            None => Ok(Self { workspace: Some(state.require_workspace()?), repo: None }),
        }
    }

    /// gh run for this target: in the open folder, or anywhere with `-R owner/name`.
    fn gh(&self, args: &[&str], input: Option<&str>) -> CommandResult<String> {
        gh(self.workspace.as_ref().map(|w| w.root()), &self.args(args), input)
    }

    fn gh_json(&self, args: &[&str]) -> CommandResult<Value> {
        gh_json(self.workspace.as_ref().map(|w| w.root()), &self.args(args))
    }

    fn args<'a>(&'a self, args: &[&'a str]) -> Vec<&'a str> {
        let mut all = args.to_vec();
        if let Some(repo) = &self.repo {
            all.extend(["-R", repo.as_str()]);
        }
        all
    }
}

#[tauri::command]
pub async fn gh_pr_list(state: State<'_, AppState>, filter: String, query: Option<String>) -> CommandResult<Value> {
    let workspace = state.require_workspace()?;
    blocking(move || {
        let mut args = vec!["pr", "list", "--limit", "50", "--json", LIST_FIELDS];
        let state = match filter.as_str() {
            "merged" => "merged",
            "closed" => "closed",
            _ => "open",
        };
        args.extend(["--state", state]);
        if filter == "mine" {
            args.extend(["--author", "@me"]);
        }
        let mut search = query.unwrap_or_default().trim().to_owned();
        if filter == "review" {
            search = format!("review-requested:@me {search}").trim().to_owned();
        }
        if !search.is_empty() {
            args.extend(["--search", &search]);
        }
        gh_json(Some(workspace.root()), &args)
    })
    .await
}

#[tauri::command]
pub async fn gh_pr_view(state: State<'_, AppState>, repo: Option<String>, number: u64) -> CommandResult<Value> {
    let target = Target::new(&state, repo)?;
    blocking(move || pr_view(&target, number)).await
}

/// `gh pr view` with `VIEW_FIELDS`, plus `reviewThreads`: the line comments it leaves out.
fn pr_view(target: &Target, number: u64) -> CommandResult<Value> {
    let mut pr = target.gh_json(&["pr", "view", &number.to_string(), "--json", VIEW_FIELDS])?;
    let repo = repo_of(pr["url"].as_str().unwrap_or_default()).or(target.repo.clone()).unwrap_or_default();
    pr["reviewThreads"] = review_threads(&repo, number)?;
    Ok(pr)
}

/// The pull request's changes as a unified diff.
#[tauri::command]
pub async fn gh_pr_diff(state: State<'_, AppState>, repo: Option<String>, number: u64) -> CommandResult<String> {
    let target = Target::new(&state, repo)?;
    blocking(move || target.gh(&["pr", "diff", &number.to_string(), "--color", "never"], None)).await
}

/// The open pull request for the checked-out branch, if there is one.
#[tauri::command]
pub async fn gh_pr_for_branch(state: State<'_, AppState>) -> CommandResult<Option<Value>> {
    let workspace = state.require_workspace()?;
    blocking(move || {
        match gh_json(Some(workspace.root()), &["pr", "view", "--json", "number,title,state,isDraft,url,statusCheckRollup,reviewDecision"]) {
            Ok(pr) if pr["state"] == "OPEN" => Ok(Some(pr)),
            Ok(_) => Ok(None),
            Err(CommandError::GitHub { kind: GitHubErrorKind::Other, .. }) => Ok(None),
            Err(e) => Err(e),
        }
    })
    .await
}

#[tauri::command]
pub async fn gh_pr_comment(state: State<'_, AppState>, repo: Option<String>, number: u64, body: String) -> CommandResult<()> {
    let target = Target::new(&state, repo)?;
    blocking(move || target.gh(&["pr", "comment", &number.to_string(), "--body-file", "-"], Some(&body)).map(drop)).await
}

/// `action` is `approve`, `request-changes` or `comment`.
#[tauri::command]
pub async fn gh_pr_review(
    state: State<'_, AppState>,
    repo: Option<String>,
    number: u64,
    action: String,
    body: String,
) -> CommandResult<()> {
    let target = Target::new(&state, repo)?;
    blocking(move || {
        let flag = match action.as_str() {
            "approve" => "--approve",
            "request-changes" => "--request-changes",
            _ => "--comment",
        };
        let number = number.to_string();
        let mut args = vec!["pr", "review", number.as_str(), flag];
        let body = body.trim();
        if !body.is_empty() {
            args.extend(["--body-file", "-"]);
        }
        target.gh(&args, (!body.is_empty()).then_some(body)).map(drop)
    })
    .await
}

/// `method` is `squash`, `merge` or `rebase`.
#[tauri::command]
pub async fn gh_pr_merge(
    state: State<'_, AppState>,
    repo: Option<String>,
    number: u64,
    method: String,
    delete_branch: bool,
) -> CommandResult<()> {
    let target = Target::new(&state, repo)?;
    blocking(move || {
        let flag = match method.as_str() {
            "merge" => "--merge",
            "rebase" => "--rebase",
            _ => "--squash",
        };
        let number = number.to_string();
        let mut args = vec!["pr", "merge", number.as_str(), flag];
        if delete_branch {
            args.push("--delete-branch");
        }
        target.gh(&args, None).map(drop)
    })
    .await
}

/// `change` is `close`, `reopen`, `ready` or `draft`.
#[tauri::command]
pub async fn gh_pr_set_state(state: State<'_, AppState>, repo: Option<String>, number: u64, change: String) -> CommandResult<()> {
    let target = Target::new(&state, repo)?;
    blocking(move || {
        let number = number.to_string();
        let args: Vec<&str> = match change.as_str() {
            "close" => vec!["pr", "close", &number],
            "reopen" => vec!["pr", "reopen", &number],
            "ready" => vec!["pr", "ready", &number],
            "draft" => vec!["pr", "ready", &number, "--undo"],
            other => return Err(gh_error(GitHubErrorKind::Other, format!("Unknown change {other}"))),
        };
        target.gh(&args, None).map(drop)
    })
    .await
}

/// Checks out the pull request's branch in the open folder.
#[tauri::command]
pub async fn gh_pr_checkout(state: State<'_, AppState>, number: u64) -> CommandResult<()> {
    let workspace = state.require_workspace()?;
    blocking(move || gh(Some(workspace.root()), &["pr", "checkout", &number.to_string()], None).map(drop)).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatePr {
    title: String,
    body: String,
    base: String,
    draft: bool,
}

#[derive(Serialize)]
pub struct CreatedPr {
    number: Option<u64>,
    url: String,
}

/// Pushes the branch and opens a pull request from it into `base`.
#[tauri::command]
pub async fn gh_pr_create(state: State<'_, AppState>, request: CreatePr) -> CommandResult<CreatedPr> {
    let workspace = state.require_workspace()?;
    blocking(move || {
        let branch = workspace.info().branch.ok_or_else(|| gh_error(GitHubErrorKind::Other, "Check out a branch first"))?;
        if branch == request.base {
            return Err(gh_error(GitHubErrorKind::Other, format!("You're on {branch}; switch to another branch to open a pull request")));
        }
        if request.title.trim().is_empty() {
            return Err(gh_error(GitHubErrorKind::Other, "Give the pull request a title"));
        }
        push_current(&workspace)?;
        let mut args = vec!["pr", "create", "--title", request.title.trim(), "--body-file", "-", "--base", &request.base, "--head", &branch];
        if request.draft {
            args.push("--draft");
        }
        let out = gh(Some(workspace.root()), &args, Some(&request.body))?;
        let url = out.lines().rev().find(|l| l.starts_with("http")).unwrap_or(&out).trim().to_owned();
        let number = url.rsplit('/').next().and_then(|n| n.parse().ok());
        Ok(CreatedPr { number, url })
    })
    .await
}

/* ------------------------------------------------------------------------- */
/* Pull requests and issues across every repository                          */
/* ------------------------------------------------------------------------- */

const SEARCH_FIELDS: &str = "number,title,state,repository,labels,author,createdAt,updatedAt,commentsCount,url";
/// Only pull requests have a draft state; `gh search issues` rejects the field.
const SEARCH_PR_FIELDS: &str = "number,title,state,isDraft,repository,labels,author,createdAt,updatedAt,commentsCount,url";
const ISSUE_FIELDS: &str = "number,title,body,author,state,stateReason,labels,assignees,comments,createdAt,updatedAt,closedAt,url";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchFilters {
    /// `open`, `closed`, or for pull requests `merged`.
    state: String,
    /// How the signed-in user is involved: `involves`, `author`, `assignee`, `review-requested`,
    /// `mentions`, or `any` (only with a repository; GitHub won't search everything).
    involvement: String,
    /// `owner/name`, or every repository.
    repo: Option<String>,
    label: Option<String>,
    /// `YYYY-MM-DD`: updated on or after.
    updated_since: Option<String>,
    query: Option<String>,
}

/// Pull requests (`kind` = `prs`) or issues (`issues`) from any repository gh can see, newest first.
#[tauri::command]
pub async fn gh_search(kind: String, filters: SearchFilters) -> CommandResult<Value> {
    blocking(move || {
        let prs = kind == "prs";
        let mut args: Vec<String> =
            [
                "search",
                if prs { "prs" } else { "issues" },
                "--limit",
                "50",
                "--sort",
                "updated",
                "--json",
                if prs { SEARCH_PR_FIELDS } else { SEARCH_FIELDS },
            ]
                .map(String::from)
                .to_vec();
        let mut qualifiers: Vec<String> = Vec::new();
        match (filters.state.as_str(), prs) {
            ("merged", true) => args.push("--merged".into()),
            ("closed", true) => {
                args.extend(["--state".into(), "closed".into()]);
                qualifiers.push("is:unmerged".into());
            }
            ("closed", false) => args.extend(["--state".into(), "closed".into()]),
            _ => args.extend(["--state".into(), "open".into()]),
        }
        let flag = match filters.involvement.as_str() {
            "author" => Some("--author"),
            "assignee" => Some("--assignee"),
            "review-requested" if prs => Some("--review-requested"),
            "mentions" => Some("--mentions"),
            "any" if filters.repo.is_some() => None,
            _ => Some("--involves"),
        };
        if let Some(flag) = flag {
            args.extend([flag.into(), "@me".into()]);
        }
        if let Some(repo) = filters.repo.filter(|r| !r.is_empty()) {
            args.extend(["--repo".into(), repo]);
        }
        if let Some(label) = filters.label.filter(|l| !l.is_empty()) {
            args.extend(["--label".into(), label]);
        }
        if let Some(since) = filters.updated_since.filter(|d| !d.is_empty()) {
            args.extend(["--updated".into(), format!(">={since}")]);
        }
        qualifiers.extend(filters.query.unwrap_or_default().split_whitespace().map(String::from));
        if !qualifiers.is_empty() {
            // After `--` so a query like `-label:bug` isn't read as a flag.
            args.push("--".into());
            args.extend(qualifiers);
        }
        let args: Vec<&str> = args.iter().map(String::as_str).collect();
        gh_json(None, &args)
    })
    .await
}

/// The repositories the signed-in user can work in, most recently pushed first.
#[tauri::command]
pub async fn gh_repos() -> CommandResult<Value> {
    blocking(|| {
        gh_json(
            None,
            &[
                "api",
                "user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
                "--jq",
                "[.[] | {nameWithOwner: .full_name, private, archived}]",
            ],
        )
    })
    .await
}

#[tauri::command]
pub async fn gh_labels(repo: String) -> CommandResult<Value> {
    blocking(move || gh_json(None, &["label", "list", "-R", &repo, "--limit", "200", "--json", "name,color"])).await
}

#[tauri::command]
pub async fn gh_issue_view(repo: String, number: u64) -> CommandResult<Value> {
    blocking(move || gh_json(None, &["issue", "view", &number.to_string(), "-R", &repo, "--json", ISSUE_FIELDS])).await
}

#[tauri::command]
pub async fn gh_issue_comment(repo: String, number: u64, body: String) -> CommandResult<()> {
    blocking(move || gh(None, &["issue", "comment", &number.to_string(), "-R", &repo, "--body-file", "-"], Some(&body)).map(drop)).await
}

/// `change` is `close` (completed), `close-not-planned` or `reopen`.
#[tauri::command]
pub async fn gh_issue_set_state(repo: String, number: u64, change: String) -> CommandResult<()> {
    blocking(move || {
        let number = number.to_string();
        let args: Vec<&str> = match change.as_str() {
            "close" => vec!["issue", "close", &number, "-R", &repo, "--reason", "completed"],
            "close-not-planned" => vec!["issue", "close", &number, "-R", &repo, "--reason", "not planned"],
            "reopen" => vec!["issue", "reopen", &number, "-R", &repo],
            other => return Err(gh_error(GitHubErrorKind::Other, format!("Unknown change {other}"))),
        };
        gh(None, &args, None).map(drop)
    })
    .await
}

/* ------------------------------------------------------------------------- */
/* Attachments                                                               */
/* ------------------------------------------------------------------------- */

/// An attachment from a pull request or issue, downloaded into the app's cache.
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    path: String,
    content_type: String,
    name: String,
    size: u64,
}

/// Hosts that get the user's GitHub token; private repositories' attachments need it.
fn is_github_host(url: &str) -> bool {
    let host = url.split("://").nth(1).and_then(|rest| rest.split(['/', '?', '#']).next()).unwrap_or("");
    host == "github.com" || host.ends_with(".github.com") || host.ends_with(".githubusercontent.com")
}

fn extension_for(content_type: &str) -> Option<&'static str> {
    Some(match content_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        "image/svg+xml" => "svg",
        "image/avif" => "avif",
        "video/mp4" => "mp4",
        "video/quicktime" => "mov",
        "video/webm" => "webm",
        "audio/mpeg" => "mp3",
        "audio/wav" | "audio/x-wav" => "wav",
        "application/pdf" => "pdf",
        "application/zip" => "zip",
        "application/json" => "json",
        "text/plain" => "txt",
        _ => return None,
    })
}

/// The URL's last path segment, if it looks like a file name.
fn file_name(url: &str) -> Option<String> {
    let path = url.split(['?', '#']).next()?;
    let last = path.rsplit('/').next()?;
    last.contains('.').then(|| last.to_owned())
}

/// Downloads `url` (an image, video or any file in a pull request or issue) once, into the
/// app's cache, and returns where it is. GitHub's attachment URLs never change, so a cached
/// file is used for good. GitHub hosts get the signed-in user's token, other hosts nothing.
#[tauri::command]
pub async fn gh_asset(app: tauri::AppHandle, url: String) -> CommandResult<Asset> {
    let dir = asset_cache(&app)?;
    blocking(move || fetch_asset(&dir, &url)).await
}

fn asset_cache(app: &tauri::AppHandle) -> CommandResult<std::path::PathBuf> {
    use tauri::Manager;
    Ok(app.path().app_cache_dir().map_err(|e| gh_error(GitHubErrorKind::Other, e.to_string()))?.join("gh-assets"))
}

/// [`gh_asset`]'s work, on the calling thread.
fn fetch_asset(dir: &Path, url: &str) -> CommandResult<Asset> {
    use sha2::{Digest, Sha256};

    if !url.starts_with("https://") {
        return Err(gh_error(GitHubErrorKind::Other, "Only https attachments can be loaded"));
    }
    let io = |e: std::io::Error| gh_error(GitHubErrorKind::Other, e.to_string());
    std::fs::create_dir_all(dir).map_err(io)?;
    let key = format!("{:x}", Sha256::digest(url.as_bytes()));
    let meta = dir.join(format!("{key}.json"));
    if let Ok(text) = std::fs::read_to_string(&meta) {
        if let Ok(asset) = serde_json::from_str::<Asset>(&text) {
            if Path::new(&asset.path).exists() {
                return Ok(asset);
            }
        }
    }

    let partial = dir.join(format!("{key}.part"));
    let partial_str = partial.to_string_lossy().into_owned();
    // The token goes in through stdin (curl's config), never on the command line; curl
    // drops it on the redirect to the storage host.
    let config = if is_github_host(url) {
        let token = gh(None, &["auth", "token"], None)?;
        format!("header = \"Authorization: token {token}\"\n")
    } else {
        String::new()
    };
    let out = shell::run_with_input(
        None,
        "curl",
        &["-sSL", "--fail", "--max-time", "300", "-K", "-", "-o", &partial_str, "-w", "%{content_type}\t%{url_effective}", url],
        Some(&config),
    )
    .map_err(|failure| {
        let _ = std::fs::remove_file(&partial);
        match failure {
            Failure::Failed(message) | Failure::Io(message) => gh_error(GitHubErrorKind::Other, format!("Couldn't load the attachment: {message}")),
            Failure::NotFound => gh_error(GitHubErrorKind::Other, "curl isn't installed"),
        }
    })?;
    let (content_type, effective) = out.split_once('\t').unwrap_or((out.as_str(), url));
    let content_type = content_type.split(';').next().unwrap_or("").trim().to_lowercase();
    let name = file_name(url)
        .or_else(|| file_name(effective))
        .unwrap_or_else(|| format!("{}.{}", url.rsplit('/').next().unwrap_or("attachment"), extension_for(&content_type).unwrap_or("bin")));
    let ext = name.rsplit_once('.').map(|(_, e)| e.to_lowercase()).filter(|e| e.len() <= 8).unwrap_or_else(|| "bin".into());
    let path = dir.join(format!("{key}.{ext}"));
    std::fs::rename(&partial, &path).map_err(io)?;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let asset = Asset { path: path.to_string_lossy().into_owned(), content_type, name, size };
    let _ = std::fs::write(&meta, serde_json::to_string(&asset).unwrap_or_default());
    Ok(asset)
}

/// Saves pull request (`kind` = `pr`) or issue (`issue`) `number` for chats to reference as
/// `%id`: its description, discussion and, for a pull request, files, commits and checks, plus
/// every attachment, downloaded. `repo` (owner/name) is required for issues; a pull request
/// without one is on the open folder's repository. An unchanged one returns the snapshot saved before.
#[tauri::command]
pub async fn gh_save_item(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    kind: String,
    repo: Option<String>,
    number: u64,
) -> CommandResult<ItemSummary> {
    use tauri::Manager;

    let target = Target::new(&state, repo)?;
    let cache = asset_cache(&app)?;
    blocking(move || {
        let (item, kind) = match kind.as_str() {
            "pr" => (pr_view(&target, number)?, "pr"),
            "issue" if target.repo.is_some() => (target.gh_json(&["issue", "view", &number.to_string(), "--json", ISSUE_FIELDS])?, "issue"),
            "issue" => return Err(gh_error(GitHubErrorKind::Other, "Name the issue's repository")),
            other => return Err(gh_error(GitHubErrorKind::Other, format!("Unknown kind {other}"))),
        };
        let url = item["url"].as_str().unwrap_or_default().to_owned();
        let repo = repo_of(&url).or(target.repo.clone()).unwrap_or_default();
        let markdown = if kind == "pr" { gh_snapshot::render_pr(&item, &repo) } else { gh_snapshot::render_issue(&item, &repo) };

        // An attachment that won't download is still named in the text, by its URL.
        let assets = gh_snapshot::attachment_urls(&markdown)
            .into_iter()
            .filter_map(|url| {
                let asset = fetch_asset(&cache, &url).ok()?;
                Some(NewAsset { url, name: asset.name, content_type: asset.content_type, path: asset.path.into() })
            })
            .collect();
        let saved = app.state::<AppState>().contexts.save_item(NewItem {
            kind: kind.into(),
            repo,
            number: number as u32,
            title: item["title"].as_str().unwrap_or_default().to_owned(),
            state: item["state"].as_str().unwrap_or_default().to_owned(),
            url,
            markdown,
            assets,
        })?;
        Ok(saved)
    })
    .await
}

const REVIEW_THREADS_QUERY: &str = "query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id isResolved isOutdated path line originalLine startLine originalStartLine
          comments(first: 100) { nodes { id author { login } body createdAt diffHunk url } }
        }
      }
    }
  }
}";

/// Pull request `number`'s line comments, grouped into threads. `gh pr view --json reviews`
/// has only each review's summary, so a review made of line comments alone comes back empty.
fn review_threads(repo: &str, number: u64) -> CommandResult<Value> {
    let (owner, name) = repo.split_once('/').ok_or_else(|| gh_error(GitHubErrorKind::Other, format!("Not a repository: {repo}")))?;
    gh_json(
        None,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={REVIEW_THREADS_QUERY}"),
            "-f",
            &format!("owner={owner}"),
            "-f",
            &format!("name={name}"),
            "-F",
            &format!("number={number}"),
            "--jq",
            ".data.repository.pullRequest.reviewThreads.nodes",
        ],
    )
}

/// `owner/name` from a pull request's or issue's URL.
fn repo_of(url: &str) -> Option<String> {
    let path = url.strip_prefix("https://github.com/")?;
    let mut parts = path.split('/');
    Some(format!("{}/{}", parts.next().filter(|p| !p.is_empty())?, parts.next().filter(|p| !p.is_empty())?))
}

/// Opens a downloaded attachment in its default app. Only files in the attachment cache.
#[tauri::command]
pub fn gh_asset_open(app: tauri::AppHandle, path: String) -> CommandResult<()> {
    use tauri::Manager;
    let dir = app.path().app_cache_dir().map_err(|e| gh_error(GitHubErrorKind::Other, e.to_string()))?.join("gh-assets");
    let path = Path::new(&path);
    if !path.starts_with(&dir) || path.components().any(|c| matches!(c, std::path::Component::ParentDir)) {
        return Err(gh_error(GitHubErrorKind::Other, "Only downloaded attachments can be opened"));
    }
    shell::open_url(&path.to_string_lossy());
    Ok(())
}

#[tauri::command]
pub fn open_url(url: String) -> CommandResult<()> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err(gh_error(GitHubErrorKind::Other, "Only web links can be opened"));
    }
    shell::open_url(&url);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_one_time_code() {
        assert_eq!(one_time_code("! First copy your one-time code: 1A2B-3C4D").as_deref(), Some("1A2B-3C4D"));
        assert_eq!(one_time_code("Press Enter to open github.com"), None);
    }

    #[test]
    fn sends_the_token_only_to_github() {
        assert!(is_github_host("https://github.com/user-attachments/assets/abc"));
        assert!(is_github_host("https://private-user-images.githubusercontent.com/1/x.png"));
        assert!(!is_github_host("https://evil.com/github.com/x.png"));
        assert!(!is_github_host("https://github.com.evil.com/x.png"));
    }

    #[test]
    fn names_attachments() {
        assert_eq!(file_name("https://github.com/o/r/files/1/log.txt").as_deref(), Some("log.txt"));
        assert_eq!(file_name("https://github.com/user-attachments/assets/51fd2fd1"), None);
    }

    #[test]
    fn reads_the_repository_from_a_url() {
        assert_eq!(repo_of("https://github.com/acme/app/pull/7").as_deref(), Some("acme/app"));
        assert_eq!(repo_of("https://example.com/acme/app"), None);
    }

    #[test]
    fn spots_signed_out_errors() {
        assert!(not_signed_in("To get started with GitHub CLI, please run:  gh auth login"));
        assert!(!not_signed_in("no pull requests found for branch \"x\""));
    }
}
