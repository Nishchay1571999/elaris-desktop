//! Source Control operations against real repositories, with a local bare
//! repository standing in for the remote.

use std::fs;
use std::path::Path;
use std::process::Command;
use std::sync::{Arc, Mutex};

use workspace::{
    ChangeKind, CommitOptions, DiffSide, FetchOptions, LogOptions, PullOptions, PushOptions, RepoOperation, StashOptions,
    Workspace,
};

fn write(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn sh(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).trim().to_owned()
}

/// A repository on `main` with a committer identity and one commit.
fn repo(dir: &Path) -> Workspace {
    sh(dir, &["init", "-q", "-b", "main"]);
    sh(dir, &["config", "user.name", "Test"]);
    sh(dir, &["config", "user.email", "test@example.com"]);
    sh(dir, &["config", "commit.gpgsign", "false"]);
    write(dir, "a.txt", "one\ntwo\nthree\n");
    sh(dir, &["add", "-A"]);
    sh(dir, &["commit", "-qm", "first"]);
    Workspace::open(dir).unwrap()
}

fn no_progress() -> impl FnMut(&str) {
    |_| {}
}

fn paths(files: &[workspace::ScmFile]) -> Vec<&str> {
    files.iter().map(|f| f.path.as_str()).collect()
}

#[test]
fn splits_staged_and_unstaged_and_stages_and_unstages() {
    let dir = tempfile::tempdir().unwrap();
    let ws = repo(dir.path());
    write(dir.path(), "a.txt", "one\nTWO\nthree\n");
    write(dir.path(), "new.txt", "hi\n");

    let status = ws.scm_status().unwrap();
    assert_eq!(status.branch.as_deref(), Some("main"));
    assert!(status.staged.is_empty());
    assert_eq!(paths(&status.unstaged), ["a.txt"]);
    assert_eq!(paths(&status.untracked), ["new.txt"]);

    ws.stage(&["a.txt".into(), "new.txt".into()]).unwrap();
    let status = ws.scm_status().unwrap();
    assert_eq!(paths(&status.staged), ["a.txt", "new.txt"]);
    assert_eq!(status.staged[1].kind, ChangeKind::Added);
    assert!(status.unstaged.is_empty() && status.untracked.is_empty());

    ws.unstage(&["a.txt".into()]).unwrap();
    let status = ws.scm_status().unwrap();
    assert_eq!(paths(&status.staged), ["new.txt"]);
    assert_eq!(paths(&status.unstaged), ["a.txt"]);

    ws.unstage_all().unwrap();
    ws.stage_all().unwrap();
    assert_eq!(paths(&ws.scm_status().unwrap().staged), ["a.txt", "new.txt"]);
}

#[test]
fn unstages_before_the_first_commit() {
    let dir = tempfile::tempdir().unwrap();
    sh(dir.path(), &["init", "-q", "-b", "main"]);
    write(dir.path(), "x.txt", "x\n");
    let ws = Workspace::open(dir.path()).unwrap();
    ws.stage_all().unwrap();
    let status = ws.scm_status().unwrap();
    assert!(status.unborn);
    assert_eq!(paths(&status.staged), ["x.txt"]);
    ws.unstage(&["x.txt".into()]).unwrap();
    assert_eq!(paths(&ws.scm_status().unwrap().untracked), ["x.txt"]);
}

#[test]
fn discards_tracked_changes_and_trashes_untracked_files() {
    let dir = tempfile::tempdir().unwrap();
    let ws = repo(dir.path());
    write(dir.path(), "a.txt", "changed\n");
    write(dir.path(), "scratch.txt", "throwaway\n");
    ws.discard(&["a.txt".into(), "scratch.txt".into()]).unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "one\ntwo\nthree\n");
    assert!(!dir.path().join("scratch.txt").exists());
    let status = ws.scm_status().unwrap();
    assert!(status.unstaged.is_empty() && status.untracked.is_empty());
}

#[test]
fn diffs_each_side_and_stages_a_single_hunk() {
    let dir = tempfile::tempdir().unwrap();
    let ws = repo(dir.path());
    // Two edits far enough apart to be separate hunks.
    let original: String = (1..=30).map(|n| format!("line {n}\n")).collect();
    write(dir.path(), "a.txt", &original);
    sh(dir.path(), &["commit", "-qam", "thirty lines"]);
    let edited = original.replace("line 2\n", "line TWO\n").replace("line 29\n", "line TWENTY-NINE\n");
    write(dir.path(), "a.txt", &edited);

    let unstaged = ws.diff_file("a.txt", DiffSide::Unstaged).unwrap();
    assert_eq!(unstaged.matches("\n@@ ").count(), 2, "{unstaged}");
    assert!(ws.diff_file("a.txt", DiffSide::Staged).unwrap().is_empty());

    // Header plus the first hunk only.
    let second = unstaged.match_indices("\n@@ ").nth(1).unwrap().0 + 1;
    ws.apply_patch(&unstaged[..second], true, false).unwrap();

    let staged = ws.diff_file("a.txt", DiffSide::Staged).unwrap();
    assert!(staged.contains("+line TWO") && !staged.contains("TWENTY-NINE"), "{staged}");
    let rest = ws.diff_file("a.txt", DiffSide::Unstaged).unwrap();
    assert!(rest.contains("+line TWENTY-NINE") && !rest.contains("+line TWO"), "{rest}");

    // Unstage it again by applying the staged hunk in reverse.
    ws.apply_patch(&staged, true, true).unwrap();
    assert!(ws.diff_file("a.txt", DiffSide::Staged).unwrap().is_empty());

    // Revert a hunk in the work tree.
    let unstaged = ws.diff_file("a.txt", DiffSide::Unstaged).unwrap();
    let second = unstaged.match_indices("\n@@ ").nth(1).unwrap().0 + 1;
    ws.apply_patch(&unstaged[..second], false, true).unwrap();
    let content = fs::read_to_string(dir.path().join("a.txt")).unwrap();
    assert!(content.contains("line 2\n") && content.contains("TWENTY-NINE"));

    write(dir.path(), "fresh.txt", "brand new\n");
    assert!(ws.diff_file("fresh.txt", DiffSide::Untracked).unwrap().contains("+brand new"));
}

#[test]
fn commits_staged_only_amends_and_undoes() {
    let dir = tempfile::tempdir().unwrap();
    let ws = repo(dir.path());
    write(dir.path(), "a.txt", "staged\n");
    write(dir.path(), "b.txt", "left out\n");
    ws.stage(&["a.txt".into()]).unwrap();

    let options = CommitOptions { message: "second".into(), staged_only: true, ..CommitOptions::default() };
    let sha = ws.commit(&options).unwrap();
    assert!(!sha.is_empty());
    assert_eq!(paths(&ws.scm_status().unwrap().untracked), ["b.txt"]);

    let amend = CommitOptions { message: "second, reworded".into(), amend: true, staged_only: true, ..CommitOptions::default() };
    ws.commit(&amend).unwrap();
    assert_eq!(ws.last_commit_message().unwrap(), "second, reworded");
    assert_eq!(sh(dir.path(), &["rev-list", "--count", "HEAD"]), "2");

    assert_eq!(ws.undo_last_commit().unwrap(), "second, reworded");
    assert_eq!(sh(dir.path(), &["rev-list", "--count", "HEAD"]), "1");
    assert_eq!(paths(&ws.scm_status().unwrap().staged), ["a.txt"]);

    // Without staged_only, everything goes in.
    ws.commit(&CommitOptions { message: "all".into(), ..CommitOptions::default() }).unwrap();
    let status = ws.scm_status().unwrap();
    assert!(status.staged.is_empty() && status.untracked.is_empty());
    assert!(ws.commit(&CommitOptions::default()).is_err(), "an empty message is refused");
}

#[test]
fn publishes_pushes_fetches_and_pulls_with_a_remote() {
    let dir = tempfile::tempdir().unwrap();
    let remote = dir.path().join("remote.git");
    fs::create_dir(&remote).unwrap();
    sh(&remote, &["init", "-q", "--bare", "-b", "main"]);
    let mine = dir.path().join("mine");
    fs::create_dir(&mine).unwrap();
    let ws = repo(&mine);

    assert!(ws.push(&PushOptions::default(), &mut no_progress()).is_err(), "no remote yet");
    ws.add_remote("origin", remote.to_str().unwrap()).unwrap();
    assert_eq!(ws.remotes().unwrap()[0].name, "origin");

    // No upstream: push publishes.
    ws.push(&PushOptions::default(), &mut no_progress()).unwrap();
    let status = ws.scm_status().unwrap();
    assert_eq!(status.upstream.as_deref(), Some("origin/main"));
    assert_eq!((status.ahead, status.behind), (0, 0));

    write(&mine, "a.txt", "mine\n");
    ws.commit(&CommitOptions { message: "local".into(), ..CommitOptions::default() }).unwrap();
    assert_eq!(ws.scm_status().unwrap().ahead, 1);
    ws.push(&PushOptions::default(), &mut no_progress()).unwrap();
    assert_eq!(ws.scm_status().unwrap().ahead, 0);

    // Someone else pushes.
    let theirs = dir.path().join("theirs");
    sh(dir.path(), &["clone", "-q", remote.to_str().unwrap(), theirs.to_str().unwrap()]);
    sh(&theirs, &["config", "user.name", "Other"]);
    sh(&theirs, &["config", "user.email", "other@example.com"]);
    write(&theirs, "b.txt", "theirs\n");
    sh(&theirs, &["add", "-A"]);
    sh(&theirs, &["commit", "-qm", "remote work"]);
    sh(&theirs, &["push", "-q"]);

    let mut lines = Vec::new();
    ws.fetch(&FetchOptions { prune: true, ..FetchOptions::default() }, &mut |l| lines.push(l.to_owned())).unwrap();
    assert_eq!(ws.scm_status().unwrap().behind, 1);
    ws.pull(&PullOptions::default(), &mut no_progress()).unwrap();
    assert_eq!(ws.scm_status().unwrap().behind, 0);
    assert!(mine.join("b.txt").exists());

    // Sync: behind and ahead at once.
    write(&theirs, "c.txt", "more\n");
    sh(&theirs, &["add", "-A"]);
    sh(&theirs, &["commit", "-qm", "more remote work"]);
    sh(&theirs, &["push", "-q"]);
    write(&mine, "d.txt", "mine again\n");
    ws.commit(&CommitOptions { message: "more local".into(), ..CommitOptions::default() }).unwrap();
    ws.fetch(&FetchOptions::default(), &mut no_progress()).unwrap();
    let status = ws.scm_status().unwrap();
    assert_eq!((status.ahead, status.behind), (1, 1));
    ws.sync(false, &mut no_progress()).unwrap();
    let status = ws.scm_status().unwrap();
    assert_eq!((status.ahead, status.behind), (0, 0));

    // Tags travel too.
    ws.create_tag("v1.0", Some("first release"), None).unwrap();
    ws.push_tags(None, &mut no_progress()).unwrap();
    assert_eq!(sh(&remote, &["tag"]), "v1.0");
    ws.delete_remote_tag("origin", "v1.0").unwrap();
    assert_eq!(sh(&remote, &["tag"]), "");
}

#[test]
fn clones_into_a_new_folder() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("source");
    fs::create_dir(&source).unwrap();
    repo(&source);
    let parent = dir.path().join("clones");
    fs::create_dir(&parent).unwrap();
    let url = format!("{}/", source.display());
    let dest = workspace::clone(&url, &parent, &mut no_progress()).unwrap();
    assert_eq!(dest, parent.join("source"));
    assert!(dest.join("a.txt").exists());
    assert!(workspace::clone(&url, &parent, &mut no_progress()).is_err(), "won't clone over a folder");
}

#[test]
fn manages_branches_and_reports_a_merge_conflict() {
    let dir = tempfile::tempdir().unwrap();
    let ws = repo(dir.path());
    ws.create_branch("feature", None).unwrap();
    assert_eq!(ws.scm_status().unwrap().branch.as_deref(), Some("feature"));
    write(dir.path(), "a.txt", "feature version\n");
    ws.commit(&CommitOptions { message: "feature".into(), ..CommitOptions::default() }).unwrap();

    ws.switch_branch("main").unwrap();
    write(dir.path(), "a.txt", "main version\n");
    ws.commit(&CommitOptions { message: "main".into(), ..CommitOptions::default() }).unwrap();

    assert!(ws.merge("feature").is_err());
    let status = ws.scm_status().unwrap();
    assert_eq!(status.operation, Some(RepoOperation::Merge));
    assert_eq!(paths(&status.conflicted), ["a.txt"]);
    ws.abort_operation().unwrap();
    let status = ws.scm_status().unwrap();
    assert_eq!(status.operation, None);
    assert!(status.conflicted.is_empty());

    // Resolve and continue instead.
    assert!(ws.merge("feature").is_err());
    write(dir.path(), "a.txt", "resolved\n");
    ws.stage(&["a.txt".into()]).unwrap();
    ws.continue_operation().unwrap();
    assert_eq!(ws.scm_status().unwrap().operation, None);
    assert_eq!(ws.log(&LogOptions { all: false, ..LogOptions::default() }).unwrap()[0].parents.len(), 2);

    assert!(ws.create_branch("not valid..name", None).is_err());
    ws.create_branch("old-name", Some("main")).unwrap();
    ws.rename_branch("old-name", "new-name").unwrap();
    ws.switch_branch("main").unwrap();
    ws.delete_branch("new-name", false).unwrap();
    assert!(ws.branches().unwrap().local.iter().all(|b| b != "new-name"));
}

#[test]
fn stashes_and_restores() {
    let dir = tempfile::tempdir().unwrap();
    let ws = repo(dir.path());
    assert!(ws.stash(&StashOptions::default()).is_err(), "nothing to stash");

    write(dir.path(), "a.txt", "work in progress\n");
    write(dir.path(), "new.txt", "untracked\n");
    ws.stash(&StashOptions { message: Some("wip".into()), include_untracked: true, ..StashOptions::default() }).unwrap();
    let status = ws.scm_status().unwrap();
    assert!(status.unstaged.is_empty() && status.untracked.is_empty());

    let stashes = ws.stashes().unwrap();
    assert_eq!(stashes.len(), 1);
    assert_eq!(stashes[0].index, 0);
    assert!(stashes[0].message.ends_with("wip"), "{}", stashes[0].message);
    assert!(ws.stash_show(0).unwrap().contains("+work in progress"));

    ws.stash_apply(0, false).unwrap();
    assert_eq!(ws.stashes().unwrap().len(), 1);
    ws.discard_all().unwrap();
    ws.stash_apply(0, true).unwrap();
    assert!(ws.stashes().unwrap().is_empty());
    assert!(dir.path().join("new.txt").exists());

    ws.stash(&StashOptions::default()).unwrap();
    ws.stash_drop(0).unwrap();
    assert!(ws.stashes().unwrap().is_empty());
}

#[test]
fn lists_and_deletes_tags_and_shows_history() {
    let dir = tempfile::tempdir().unwrap();
    let ws = repo(dir.path());
    write(dir.path(), "a.txt", "second\n");
    ws.commit(&CommitOptions { message: "second\n\nwith a body".into(), ..CommitOptions::default() }).unwrap();
    ws.create_tag("light", None, Some("HEAD~1")).unwrap();
    ws.create_tag("v2", Some("annotated"), None).unwrap();
    assert!(ws.create_tag("bad name", None, None).is_err());

    let names: Vec<_> = ws.tags().unwrap().into_iter().map(|t| t.name).collect();
    assert!(names.contains(&"light".into()) && names.contains(&"v2".into()));
    ws.delete_tag("light").unwrap();
    assert_eq!(ws.tags().unwrap().len(), 1);

    let log = ws.log(&LogOptions::default()).unwrap();
    assert_eq!(log.len(), 2);
    assert_eq!(log[0].subject, "second");
    assert!(log[0].refs.iter().any(|r| r == "HEAD -> main"), "{:?}", log[0].refs);
    assert!(log[0].refs.iter().any(|r| r == "tag: v2"));
    assert_eq!(log[0].parents, [log[1].sha.clone()]);

    let paged = ws.log(&LogOptions { skip: 1, limit: 1, all: true }).unwrap();
    assert_eq!(paged.len(), 1);
    assert_eq!(paged[0].subject, "first");

    let detail = ws.show_commit(&log[0].sha).unwrap();
    assert_eq!(detail.message, "second\n\nwith a body");
    assert_eq!(detail.committer, "Test");
    assert!(detail.patch.contains("+second"), "{}", detail.patch);

    assert_eq!(ws.authors().unwrap(), ["Test <test@example.com>"]);
}

#[test]
fn ignores_files_and_works_from_a_subfolder() {
    let dir = tempfile::tempdir().unwrap();
    repo(dir.path());
    write(dir.path(), "app/src/main.ts", "x\n");
    write(dir.path(), "other/file.ts", "y\n");
    let ws = Workspace::open(dir.path().join("app")).unwrap();

    let status = ws.scm_status().unwrap();
    assert_eq!(paths(&status.untracked), ["src/main.ts"]);
    ws.stage(&["src/main.ts".into()]).unwrap();
    // The staged diff's headers name the file from the repository root, so
    // a hunk applies from anywhere.
    let staged = ws.diff_file("src/main.ts", DiffSide::Staged).unwrap();
    assert!(staged.contains("b/app/src/main.ts"), "{staged}");
    ws.apply_patch(&staged, true, true).unwrap();
    assert_eq!(paths(&ws.scm_status().unwrap().untracked), ["src/main.ts"]);

    ws.ignore("src/main.ts").unwrap();
    ws.ignore("src/main.ts").unwrap();
    assert_eq!(fs::read_to_string(dir.path().join("app/.gitignore")).unwrap(), "/src/main.ts\n");
    assert_eq!(paths(&ws.scm_status().unwrap().untracked), [".gitignore"]);
    assert!(ws.stage(&["../other/file.ts".into()]).is_err(), "paths outside the workspace are refused");
}

#[test]
fn records_every_git_command_for_the_output_log() {
    let seen = Arc::new(Mutex::new(Vec::new()));
    let sink = seen.clone();
    workspace::set_output_sink(move |entry| sink.lock().unwrap().push(entry));

    let dir = tempfile::tempdir().unwrap();
    let ws = repo(dir.path());
    let _ = ws.create_branch("..bad", None);
    ws.scm_status().unwrap();

    let seen = seen.lock().unwrap();
    // Other tests run in parallel and share the sink; look for ours.
    let failed = seen.iter().find(|e| e.args.first().is_some_and(|a| a == "check-ref-format") && e.args.iter().any(|a| a == "..bad")).unwrap();
    assert_ne!(failed.exit_code, Some(0));
    let status = seen.iter().find(|e| e.args.first().is_some_and(|a| a == "status")).unwrap();
    assert_eq!(status.exit_code, Some(0));
    assert!(status.stdout.is_empty(), "read-only output stays out of the log");
}
