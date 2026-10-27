//! Finds the Node runtime and the built sidecar script for [`ClaudeAgent`].
//!
//! Overrides: `ELARIS_NODE` (path to node) and `ELARIS_SIDECAR` (path to
//! `main.js`). Apps launched from Finder don't inherit the shell's PATH, so
//! common install locations are searched too.

use std::env;
use std::path::{Path, PathBuf};

use agent_core::SidecarCommand;
use tauri::{AppHandle, Manager};

const DEV_SCRIPT: &str = concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/dist/main.js");

pub fn command(app: &AppHandle) -> SidecarCommand {
    SidecarCommand { program: node(), args: vec![script(app).display().to_string()] }
}

fn script(app: &AppHandle) -> PathBuf {
    if let Some(path) = env::var_os("ELARIS_SIDECAR") {
        return path.into();
    }
    let bundled = app.path().resource_dir().ok().map(|dir| dir.join("sidecar/dist/main.js"));
    match bundled {
        Some(path) if path.exists() => path,
        _ => DEV_SCRIPT.into(),
    }
}

/// `npx` from the same install as [`node`], so it finds that node too.
pub fn npx() -> PathBuf {
    let name = if cfg!(windows) { "npx.cmd" } else { "npx" };
    let beside = node().with_file_name(name);
    if beside.is_file() { beside } else { name.into() }
}

fn node() -> PathBuf {
    if let Some(path) = env::var_os("ELARIS_NODE") {
        return path.into();
    }
    let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
    let path_dirs = env::var_os("PATH").map(|p| env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default();
    let extra = [
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        home.join(".volta/bin"),
    ];
    path_dirs
        .into_iter()
        .chain(extra)
        .chain(newest_nvm_bin(&home))
        .map(|dir| dir.join(if cfg!(windows) { "node.exe" } else { "node" }))
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| "node".into())
}

/// `~/.nvm/versions/node/<newest>/bin`, if nvm is installed.
fn newest_nvm_bin(home: &Path) -> Option<PathBuf> {
    let mut versions: Vec<PathBuf> = std::fs::read_dir(home.join(".nvm/versions/node"))
        .ok()?
        .filter_map(|entry| entry.ok().map(|e| e.path()))
        .collect();
    versions.sort_by_key(|path| version_key(path));
    versions.pop().map(|dir| dir.join("bin"))
}

fn version_key(path: &Path) -> Vec<u32> {
    let name = path.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    name.trim_start_matches('v').split('.').filter_map(|part| part.parse().ok()).collect()
}
