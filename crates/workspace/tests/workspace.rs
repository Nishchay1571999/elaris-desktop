use std::fs;
use std::path::Path;

use git2::{Repository, Signature};
use workspace::{ChangeKind, ChangedFile, Workspace};

fn write(root: &Path, rel: &str, contents: &str) {
    let path = root.join(rel);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, contents).unwrap();
}

fn commit_all(repo: &Repository) {
    let mut index = repo.index().unwrap();
    index.add_all(["*"], git2::IndexAddOption::DEFAULT, None).unwrap();
    index.write().unwrap();
    let tree = repo.find_tree(index.write_tree().unwrap()).unwrap();
    let sig = Signature::now("Test", "test@example.com").unwrap();
    let parents: Vec<_> = repo.head().ok().and_then(|h| h.peel_to_commit().ok()).into_iter().collect();
    let parents: Vec<_> = parents.iter().collect();
    repo.commit(Some("HEAD"), &sig, &sig, "commit", &tree, &parents).unwrap();
}

#[test]
fn lists_folders_first_and_honours_gitignore_without_a_repo() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), ".gitignore", "node_modules/\n*.log\n");
    write(dir.path(), "node_modules/x/index.js", "");
    write(dir.path(), "debug.log", "");
    write(dir.path(), "src/main.rs", "");
    write(dir.path(), "Docs/readme.md", "");
    write(dir.path(), "b.txt", "");
    write(dir.path(), "A.txt", "");

    let ws = Workspace::open(dir.path()).unwrap();
    let names: Vec<_> = ws.list_dir("").unwrap().into_iter().map(|e| e.name).collect();
    // Folders first, then files; case-insensitive; ignored entries left out.
    assert_eq!(names, ["Docs", "src", ".gitignore", "A.txt", "b.txt"]);

    let nested = ws.list_dir("src").unwrap();
    assert_eq!(nested[0].path, "src/main.rs");
    assert!(!nested[0].is_dir);
}

#[test]
fn refuses_paths_outside_the_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let ws = Workspace::open(dir.path()).unwrap();
    assert!(ws.list_dir("..").is_err());
    assert!(ws.read_file("../etc/passwd").is_err());
}

#[test]
fn reports_status_and_diffs_against_head() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    write(dir.path(), "kept.txt", "one\ntwo\n");
    write(dir.path(), "gone.txt", "bye\n");
    commit_all(&repo);

    write(dir.path(), "kept.txt", "one\nTWO\n");
    fs::remove_file(dir.path().join("gone.txt")).unwrap();
    write(dir.path(), "new/fresh.txt", "hello\n");

    let ws = Workspace::open(dir.path()).unwrap();
    let info = ws.info();
    assert!(info.is_git);
    assert!(info.branch.is_some());

    assert_eq!(
        ws.status().unwrap(),
        vec![
            ChangedFile { path: "gone.txt".into(), kind: ChangeKind::Deleted },
            ChangedFile { path: "kept.txt".into(), kind: ChangeKind::Modified },
            ChangedFile { path: "new/fresh.txt".into(), kind: ChangeKind::Untracked },
        ]
    );

    let diff = ws.diff("kept.txt").unwrap();
    assert!(diff.contains("-two"), "{diff}");
    assert!(diff.contains("+TWO"), "{diff}");
    assert!(ws.diff("new/fresh.txt").unwrap().contains("+hello"));
    assert!(ws.diff("gone.txt").unwrap().contains("-bye"));
}

#[test]
fn status_is_scoped_to_a_subfolder_workspace() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    write(dir.path(), "app/a.txt", "a\n");
    write(dir.path(), "other.txt", "o\n");
    commit_all(&repo);
    write(dir.path(), "app/a.txt", "A\n");
    write(dir.path(), "other.txt", "O\n");

    let ws = Workspace::open(dir.path().join("app")).unwrap();
    assert_eq!(ws.status().unwrap(), vec![ChangedFile { path: "a.txt".into(), kind: ChangeKind::Modified }]);
    assert!(ws.diff("a.txt").unwrap().contains("+A"));
}

#[test]
fn branch_is_known_before_the_first_commit() {
    let dir = tempfile::tempdir().unwrap();
    Repository::init(dir.path()).unwrap();
    let info = Workspace::open(dir.path()).unwrap().info();
    assert!(info.is_git);
    assert!(info.branch.is_some());
}

#[test]
fn lists_and_switches_branches() {
    let dir = tempfile::tempdir().unwrap();
    let repo = Repository::init(dir.path()).unwrap();
    write(dir.path(), "a.txt", "a\n");
    commit_all(&repo);
    let head = repo.head().unwrap().peel_to_commit().unwrap();
    repo.branch("feature", &head, false).unwrap();
    repo.remote("origin", "https://example.com/repo.git").unwrap();
    // A remote-only branch, as a fetch would leave it.
    repo.reference("refs/remotes/origin/remote-only", head.id(), false, "test").unwrap();
    repo.reference("refs/remotes/origin/feature", head.id(), false, "test").unwrap();

    let ws = Workspace::open(dir.path()).unwrap();
    let start = ws.info().branch.unwrap();
    let branches = ws.branches().unwrap();
    assert!(branches.local.contains(&"feature".to_owned()));
    assert!(branches.local.contains(&start));
    // origin/feature has a local twin, so only the remote-only one is offered.
    assert_eq!(branches.remote, ["origin/remote-only"]);
    assert_eq!(ws.info().default_branch.as_deref(), Some(start.as_str()));

    ws.switch_branch("feature").unwrap();
    assert_eq!(ws.info().branch.as_deref(), Some("feature"));

    ws.switch_branch("origin/remote-only").unwrap();
    assert_eq!(ws.info().branch.as_deref(), Some("remote-only"));
    assert!(ws.branches().unwrap().remote.is_empty());

    assert!(ws.switch_branch("--force").is_err());
    assert!(ws.switch_branch("nope").is_err());
}

/// A repo whose `feature` branch changed `a.txt`, checked out on the start branch.
fn repo_with_diverged_feature(dir: &Path) -> Repository {
    let repo = Repository::init(dir).unwrap();
    let mut config = repo.config().unwrap();
    config.set_str("user.name", "Test").unwrap();
    config.set_str("user.email", "test@example.com").unwrap();
    write(dir, "a.txt", "one\ntwo\nthree\n");
    write(dir, "b.txt", "b\n");
    commit_all(&repo);
    let start = repo.head().unwrap().shorthand().unwrap().to_owned();
    {
        let head = repo.head().unwrap().peel_to_commit().unwrap();
        repo.branch("feature", &head, false).unwrap();
    }
    repo.set_head("refs/heads/feature").unwrap();
    write(dir, "a.txt", "ONE\ntwo\nthree\n");
    commit_all(&repo);
    repo.set_head(&format!("refs/heads/{start}")).unwrap();
    repo.checkout_head(Some(git2::build::CheckoutBuilder::new().force())).unwrap();
    repo
}

#[test]
fn switching_carries_uncommitted_changes_over() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo_with_diverged_feature(dir.path());
    // Touches a.txt, which differs on feature, so a plain switch would refuse.
    write(dir.path(), "a.txt", "one\ntwo\nTHREE\n");
    write(dir.path(), "new.txt", "fresh\n");

    let ws = Workspace::open(dir.path()).unwrap();
    ws.switch_branch("feature").unwrap();
    assert_eq!(ws.info().branch.as_deref(), Some("feature"));
    assert_eq!(fs::read_to_string(dir.path().join("a.txt")).unwrap(), "ONE\ntwo\nTHREE\n");
    assert_eq!(fs::read_to_string(dir.path().join("new.txt")).unwrap(), "fresh\n");
    assert!(repo.find_reference("refs/stash").is_err(), "stash should be popped");
}

#[test]
fn switching_keeps_clashing_changes_in_conflicts_and_the_stash() {
    let dir = tempfile::tempdir().unwrap();
    let repo = repo_with_diverged_feature(dir.path());
    write(dir.path(), "a.txt", "uno\ntwo\nthree\n");

    let ws = Workspace::open(dir.path()).unwrap();
    let error = ws.switch_branch("feature").unwrap_err().to_string();
    assert!(error.contains("clash"), "{error}");
    assert_eq!(ws.info().branch.as_deref(), Some("feature"));
    assert!(fs::read_to_string(dir.path().join("a.txt")).unwrap().contains("<<<<<<<"));
    assert!(repo.find_reference("refs/stash").is_ok());
}
