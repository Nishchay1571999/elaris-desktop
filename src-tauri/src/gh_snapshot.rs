//! A pull request or issue as Markdown for an agent to read: what `gh … view --json`
//! returns, laid out like GitHub shows it, and the attachments it links to.

use std::fmt::Write as _;

use serde_json::Value;

/// A pull request from `gh pr view --json` with `VIEW_FIELDS`.
pub fn render_pr(pr: &Value, repo: &str) -> String {
    let mut out = heading(pr, repo, "Pull request");
    let state = if pr["isDraft"].as_bool() == Some(true) && pr["state"] == "OPEN" { "DRAFT".to_owned() } else { text(&pr["state"]) };
    let _ = writeln!(out, "- State: {state}");
    let _ = writeln!(out, "- Author: {}", login(&pr["author"]));
    let _ = writeln!(out, "- Branches: {} → {}", text(&pr["headRefName"]), text(&pr["baseRefName"]));
    let _ = writeln!(
        out,
        "- Changes: {} files, +{} −{}",
        pr["changedFiles"].as_u64().unwrap_or(0),
        pr["additions"].as_u64().unwrap_or(0),
        pr["deletions"].as_u64().unwrap_or(0)
    );
    if let Some(decision) = pr["reviewDecision"].as_str().filter(|d| !d.is_empty()) {
        let _ = writeln!(out, "- Review decision: {decision}");
    }
    let requested = names(&pr["reviewRequests"], |r| r["login"].as_str().or(r["name"].as_str()).or(r["slug"].as_str()));
    if !requested.is_empty() {
        let _ = writeln!(out, "- Review requested from: {}", requested.join(", "));
    }
    if let Some(mergeable) = pr["mergeable"].as_str().filter(|m| *m != "UNKNOWN") {
        let _ = writeln!(out, "- Mergeable: {mergeable}");
    }
    meta(&mut out, pr);
    let _ = writeln!(out, "\nThe diff isn't included; `gh pr diff {} -R {repo}` prints it.", number(pr));

    description(&mut out, pr);

    // Comments and reviews, in the order they happened.
    let mut thread: Vec<(String, String)> = Vec::new();
    for c in array(&pr["comments"]) {
        thread.push((text(&c["createdAt"]), format!("### {} commented · {}\n\n{}", login(&c["author"]), text(&c["createdAt"]), body(c))));
    }
    for r in array(&pr["reviews"]) {
        let state = text(&r["state"]);
        if state == "COMMENTED" && body(r).is_empty() {
            continue;
        }
        let verb = match state.as_str() {
            "APPROVED" => "approved",
            "CHANGES_REQUESTED" => "requested changes",
            "DISMISSED" => "reviewed (dismissed)",
            _ => "reviewed",
        };
        let said = if body(r).is_empty() { String::new() } else { format!("\n\n{}", body(r)) };
        thread.push((text(&r["submittedAt"]), format!("### {} {verb} · {}{said}", login(&r["author"]), text(&r["submittedAt"]))));
    }
    thread.sort_by(|a, b| a.0.cmp(&b.0));
    conversation(&mut out, thread.into_iter().map(|(_, entry)| entry));
    review_threads(&mut out, array(&pr["reviewThreads"]));

    let files = array(&pr["files"]);
    if !files.is_empty() {
        out.push_str("\n\n## Files changed\n\n");
        for f in files {
            let _ = writeln!(
                out,
                "- {} (+{} −{})",
                text(&f["path"]),
                f["additions"].as_u64().unwrap_or(0),
                f["deletions"].as_u64().unwrap_or(0)
            );
        }
    }
    let commits = array(&pr["commits"]);
    if !commits.is_empty() {
        out.push_str("\n## Commits\n\n");
        for c in commits {
            let oid = text(&c["oid"]);
            let _ = writeln!(out, "- {} {}", oid.get(..7).unwrap_or(&oid), text(&c["messageHeadline"]));
        }
    }
    let checks = array(&pr["statusCheckRollup"]);
    if !checks.is_empty() {
        out.push_str("\n## Checks\n\n");
        for c in checks {
            let (name, result) = if c["__typename"] == "StatusContext" {
                (text(&c["context"]), text(&c["state"]))
            } else {
                let conclusion = text(&c["conclusion"]);
                (text(&c["name"]), if conclusion.is_empty() { text(&c["status"]) } else { conclusion })
            };
            let _ = writeln!(out, "- {name}: {result}");
        }
    }
    out.trim_end().to_owned()
}

/// An issue from `gh issue view --json` with `ISSUE_FIELDS`.
pub fn render_issue(issue: &Value, repo: &str) -> String {
    let mut out = heading(issue, repo, "Issue");
    let reason = issue["stateReason"].as_str().filter(|r| !r.is_empty()).map(|r| format!(" ({r})")).unwrap_or_default();
    let _ = writeln!(out, "- State: {}{reason}", text(&issue["state"]));
    let _ = writeln!(out, "- Author: {}", login(&issue["author"]));
    let assignees = names(&issue["assignees"], |a| a["login"].as_str());
    if !assignees.is_empty() {
        let _ = writeln!(out, "- Assignees: {}", assignees.join(", "));
    }
    meta(&mut out, issue);
    description(&mut out, issue);
    conversation(
        &mut out,
        array(&issue["comments"])
            .iter()
            .map(|c| format!("### {} commented · {}\n\n{}", login(&c["author"]), text(&c["createdAt"]), body(c))),
    );
    out.trim_end().to_owned()
}

fn heading(item: &Value, repo: &str, noun: &str) -> String {
    format!("# {} ({repo}#{})\n\n{noun} {}\n\n", text(&item["title"]), number(item), text(&item["url"]))
}

fn meta(out: &mut String, item: &Value) {
    let labels = names(&item["labels"], |l| l["name"].as_str());
    if !labels.is_empty() {
        let _ = writeln!(out, "- Labels: {}", labels.join(", "));
    }
    let _ = writeln!(out, "- Opened: {}", text(&item["createdAt"]));
    for (field, label) in [("mergedAt", "Merged"), ("closedAt", "Closed")] {
        if let Some(at) = item[field].as_str().filter(|at| !at.is_empty() && !at.starts_with("0001")) {
            let _ = writeln!(out, "- {label}: {at}");
            break;
        }
    }
    let _ = writeln!(out, "- Last updated: {}", text(&item["updatedAt"]));
}

fn description(out: &mut String, item: &Value) {
    let body = body(item);
    out.push_str("\n## Description\n\n");
    out.push_str(if body.is_empty() { "(No description.)" } else { &body });
}

fn conversation(out: &mut String, entries: impl Iterator<Item = String>) {
    let entries: Vec<String> = entries.collect();
    if entries.is_empty() {
        return;
    }
    out.push_str("\n\n## Conversation\n\n");
    out.push_str(&entries.join("\n\n"));
}

/// How many lines of code above a line comment to show with it.
const HUNK_LINES: usize = 6;

/// Line comments, one section per thread: where it is, the code it's on, then each comment.
fn review_threads(out: &mut String, threads: &[Value]) {
    let threads: Vec<&Value> = threads.iter().filter(|t| !array(&t["comments"]["nodes"]).is_empty()).collect();
    if threads.is_empty() {
        return;
    }
    out.push_str("\n\n## Review threads\n\nComments on lines of the diff.");
    for t in threads {
        let comments = array(&t["comments"]["nodes"]);
        // An outdated thread has no line in the current diff, only the one it was left on.
        let line = t["line"].as_u64().or(t["originalLine"].as_u64());
        let start = t["startLine"].as_u64().or(t["originalStartLine"].as_u64()).filter(|s| Some(*s) != line);
        let at = match (start, line) {
            (Some(s), Some(l)) => format!(":{s}-{l}"),
            (None, Some(l)) => format!(":{l}"),
            _ => String::new(),
        };
        let mut flags = Vec::new();
        if t["isResolved"].as_bool() == Some(true) {
            flags.push("resolved");
        }
        if t["isOutdated"].as_bool() == Some(true) {
            flags.push("outdated");
        }
        let flags = if flags.is_empty() { String::new() } else { format!(" ({})", flags.join(", ")) };
        let _ = write!(out, "\n\n### {}{at}{flags}", text(&t["path"]));

        let hunk = text(&comments[0]["diffHunk"]);
        let lines: Vec<&str> = hunk.lines().filter(|l| !l.starts_with("@@")).collect();
        if !lines.is_empty() {
            let shown = lines[lines.len().saturating_sub(HUNK_LINES)..].join("\n");
            let _ = write!(out, "\n\n````diff\n{shown}\n````");
        }
        for c in comments {
            let _ = write!(out, "\n\n#### {} · {}\n\n{}", login(&c["author"]), text(&c["createdAt"]), body(c));
        }
    }
}

/// Every attachment `markdown` links to or embeds, each once, in order.
pub fn attachment_urls(markdown: &str) -> Vec<String> {
    let mut urls: Vec<String> = Vec::new();
    for (start, _) in markdown.match_indices("https://") {
        let rest = &markdown[start..];
        let end = rest.find(|c: char| c.is_whitespace() || "()<>\"'[]`".contains(c)).unwrap_or(rest.len());
        let url = rest[..end].trim_end_matches(['.', ',', ';', ':', '!', '?']);
        if is_attachment(url) && !urls.iter().any(|u| u == url) {
            urls.push(url.to_owned());
        }
    }
    urls
}

/// Where GitHub keeps files dropped into a comment; the same rule as `isAttachment` in `gh-markdown.tsx`.
fn is_attachment(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else { return false };
    if let Some(path) = rest.strip_prefix("github.com/") {
        if path.starts_with("user-attachments/assets/") || path.starts_with("user-attachments/files/") {
            return true;
        }
        let parts: Vec<&str> = path.splitn(4, '/').collect();
        return parts.len() == 4 && !parts[0].is_empty() && !parts[1].is_empty() && matches!(parts[2], "assets" | "files");
    }
    rest.starts_with("user-images.githubusercontent.com/") || rest.starts_with("private-user-images.githubusercontent.com/")
}

fn number(item: &Value) -> u64 {
    item["number"].as_u64().unwrap_or(0)
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or("").to_owned()
}

fn body(item: &Value) -> String {
    item["body"].as_str().unwrap_or("").trim().to_owned()
}

fn login(actor: &Value) -> String {
    actor["login"].as_str().filter(|l| !l.is_empty()).unwrap_or("ghost").to_owned()
}

fn array(value: &Value) -> &[Value] {
    value.as_array().map(Vec::as_slice).unwrap_or(&[])
}

fn names(value: &Value, name: impl Fn(&Value) -> Option<&str>) -> Vec<String> {
    array(value).iter().filter_map(|v| name(v).map(str::to_owned)).collect()
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn finds_attachments_once_each() {
        let body = "Broken: ![shot](https://github.com/user-attachments/assets/abc-1)\n\
                    https://github.com/user-attachments/assets/vid-2.\n\
                    <img src=\"https://private-user-images.githubusercontent.com/1/x.png?jwt=t\">\n\
                    log: [crash.log](https://github.com/acme/app/files/9/crash.log) and again \
                    https://github.com/user-attachments/assets/abc-1\n\
                    not these: https://github.com/acme/app/pull/3 https://example.com/a.png";
        assert_eq!(
            attachment_urls(body),
            [
                "https://github.com/user-attachments/assets/abc-1",
                "https://github.com/user-attachments/assets/vid-2",
                "https://private-user-images.githubusercontent.com/1/x.png?jwt=t",
                "https://github.com/acme/app/files/9/crash.log",
            ]
        );
    }

    #[test]
    fn renders_a_pull_request_in_order() {
        let pr = json!({
            "number": 7, "title": "Fix login", "url": "https://github.com/acme/app/pull/7",
            "state": "OPEN", "isDraft": false, "author": {"login": "ana"},
            "headRefName": "fix", "baseRefName": "main", "changedFiles": 1, "additions": 3, "deletions": 1,
            "body": "Fixes the crash.", "labels": [{"name": "bug"}], "createdAt": "2026-01-01T00:00:00Z",
            "updatedAt": "2026-01-03T00:00:00Z", "closedAt": null,
            "comments": [{"author": {"login": "bo"}, "body": "Second", "createdAt": "2026-01-02T00:00:00Z"}],
            "reviews": [
                {"author": {"login": "cy"}, "body": "", "state": "APPROVED", "submittedAt": "2026-01-03T00:00:00Z"},
                {"author": {"login": "cy"}, "body": "", "state": "COMMENTED", "submittedAt": "2026-01-01T12:00:00Z"},
            ],
            "files": [{"path": "src/login.rs", "additions": 3, "deletions": 1}],
            "commits": [{"oid": "0123456789", "messageHeadline": "Fix login"}],
            "statusCheckRollup": [{"__typename": "CheckRun", "name": "test", "status": "COMPLETED", "conclusion": "SUCCESS"}],
        });
        let md = render_pr(&pr, "acme/app");
        assert!(md.starts_with("# Fix login (acme/app#7)"), "{md}");
        assert!(md.contains("- Labels: bug") && md.contains("Fixes the crash."), "{md}");
        assert!(md.contains("gh pr diff 7 -R acme/app"));
        let (bo, cy) = (md.find("### bo commented").unwrap(), md.find("### cy approved").unwrap());
        assert!(bo < cy, "{md}");
        assert!(!md.contains("cy reviewed"), "empty comment reviews are left out");
        assert!(md.contains("- src/login.rs (+3 −1)") && md.contains("- 0123456 Fix login") && md.contains("- test: SUCCESS"));
    }

    #[test]
    fn renders_line_comments_by_thread() {
        let hunk = "@@ -1,3 +1,9 @@\n a\n+b\n+c\n+d\n+e\n+f\n+g\n+emit();";
        let pr = json!({
            "number": 7, "title": "Fix login", "url": "https://github.com/acme/app/pull/7", "state": "OPEN",
            "reviews": [{"author": {"login": "cy"}, "body": "", "state": "COMMENTED", "submittedAt": "2026-01-01T12:00:00Z"}],
            "reviewThreads": [
                {"path": "src/a.tsx", "line": 47, "startLine": null, "isResolved": false, "isOutdated": false,
                 "comments": {"nodes": [
                     {"author": {"login": "cy"}, "body": "Fires on every mount.", "createdAt": "2026-01-01T12:00:00Z", "diffHunk": hunk},
                     {"author": {"login": "ana"}, "body": "Fixed.", "createdAt": "2026-01-02T00:00:00Z", "diffHunk": hunk},
                 ]}},
                {"path": "docs/x.md", "line": null, "originalLine": 9, "originalStartLine": 4, "isResolved": true, "isOutdated": true,
                 "comments": {"nodes": [{"author": {"login": "cy"}, "body": "Typo.", "createdAt": "2026-01-01T12:00:00Z", "diffHunk": ""}]}},
            ],
        });
        let md = render_pr(&pr, "acme/app");
        assert!(md.contains("## Review threads") && md.contains("### src/a.tsx:47\n"), "{md}");
        assert!(md.contains("+emit();\n````") && !md.contains("\n a\n") && !md.contains("@@"), "only the last lines of the hunk: {md}");
        let (cy, ana) = (md.find("#### cy · 2026-01-01T12:00:00Z\n\nFires on every mount.").unwrap(), md.find("#### ana").unwrap());
        assert!(cy < ana, "{md}");
        assert!(md.contains("### docs/x.md:4-9 (resolved, outdated)"), "{md}");
    }
}
