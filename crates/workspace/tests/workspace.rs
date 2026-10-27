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
