//! The language servers Elaris knows how to start without help, named as
//! nvim-lspconfig names them so a user's own Neovim config can override any
//! of them, and the Mason package that installs each one.
//!
//! Only servers that send semantic tokens are listed: colour is what Elaris
//! asks them for.

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

pub struct ServerSpec {
    /// The nvim-lspconfig name, e.g. `rust_analyzer`.
    pub name: &'static str,
    /// What the UI calls it: the program's own name.
    pub label: &'static str,
    /// Neovim filetypes, which double as LSP language ids.
    pub filetypes: &'static [&'static str],
    pub command: &'static str,
    pub args: &'static [&'static str],
    /// The Mason package that installs `command`.
    pub mason: &'static str,
    pub root_markers: &'static [&'static str],
    /// Take the outermost marker below the workspace root rather than the
    /// nearest: one rust-analyzer per Cargo workspace, not one per crate.
    pub outermost_root: bool,
    /// Settings the server reads through `workspace/configuration`.
    pub settings: fn() -> Value,
}

fn no_settings() -> Value {
    Value::Null
}

pub const SERVERS: &[ServerSpec] = &[
    ServerSpec {
        name: "rust_analyzer",
        label: "rust-analyzer",
        filetypes: &["rust"],
        command: "rust-analyzer",
        args: &[],
        mason: "rust-analyzer",
        root_markers: &["Cargo.toml"],
        outermost_root: true,
        settings: no_settings,
    },
    ServerSpec {
        name: "ts_ls",
        label: "typescript-language-server",
        filetypes: &["typescript", "typescriptreact", "javascript", "javascriptreact"],
        command: "typescript-language-server",
        args: &["--stdio"],
        mason: "typescript-language-server",
        root_markers: &["tsconfig.json", "jsconfig.json", "package.json"],
        outermost_root: false,
        settings: no_settings,
    },
    ServerSpec {
        // Pyright itself sends no semantic tokens; basedpyright does.
        name: "basedpyright",
        label: "basedpyright",
        filetypes: &["python"],
        command: "basedpyright-langserver",
        args: &["--stdio"],
        mason: "basedpyright",
        root_markers: &["pyproject.toml", "setup.py", "setup.cfg", "requirements.txt", "pyrightconfig.json"],
        outermost_root: false,
        settings: no_settings,
    },
    ServerSpec {
        name: "gopls",
        label: "gopls",
        filetypes: &["go", "gomod"],
        command: "gopls",
        args: &[],
        mason: "gopls",
        root_markers: &["go.work", "go.mod"],
        outermost_root: false,
        // Off by default in gopls.
        settings: || json!({ "gopls": { "semanticTokens": true } }),
    },
    ServerSpec {
        name: "lua_ls",
        label: "lua-language-server",
        filetypes: &["lua"],
        command: "lua-language-server",
        args: &[],
        mason: "lua-language-server",
        root_markers: &[".luarc.json", ".luarc.jsonc", ".stylua.toml", "stylua.toml"],
        outermost_root: false,
        settings: no_settings,
    },
    ServerSpec {
        name: "clangd",
        label: "clangd",
        filetypes: &["c", "cpp", "objc", "objcpp"],
        command: "clangd",
        args: &[],
        mason: "clangd",
        root_markers: &["compile_commands.json", "compile_flags.txt", ".clangd"],
        outermost_root: false,
        settings: no_settings,
    },
    ServerSpec {
        name: "zls",
        label: "zls",
        filetypes: &["zig"],
        command: "zls",
        args: &[],
        mason: "zls",
        root_markers: &["build.zig"],
        outermost_root: false,
        settings: no_settings,
    },
];

pub fn spec_for(filetype: &str) -> Option<&'static ServerSpec> {
    SERVERS.iter().find(|spec| spec.filetypes.contains(&filetype))
}

/// The Neovim filetype of `path`, for the languages any server here or in a
/// user's config is likely to cover.
pub fn filetype(path: &Path) -> Option<&'static str> {
    let name = path.file_name()?.to_str()?;
    if name == "go.mod" {
        return Some("gomod");
    }
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    Some(match ext.as_str() {
        "rs" => "rust",
        "ts" | "mts" | "cts" => "typescript",
        "tsx" => "typescriptreact",
        "js" | "mjs" | "cjs" => "javascript",
        "jsx" => "javascriptreact",
        "py" | "pyi" => "python",
        "go" => "go",
        "lua" => "lua",
        "c" | "h" => "c",
        "cc" | "cpp" | "cxx" | "hpp" | "hh" | "hxx" => "cpp",
        "m" => "objc",
        "mm" => "objcpp",
        "zig" => "zig",
        "swift" => "swift",
        "java" => "java",
        "kt" | "kts" => "kotlin",
        "rb" => "ruby",
        "php" => "php",
        "cs" => "cs",
        "svelte" => "svelte",
        "vue" => "vue",
        "toml" => "toml",
        "json" => "json",
        "yaml" | "yml" => "yaml",
        "sh" | "bash" | "zsh" => "sh",
        _ => return None,
    })
}

/// The folder a server for `file` should treat as its root: the nearest (or
/// outermost) folder holding one of `markers`, no higher than `workspace`.
/// Falls back to `workspace`, or to the file's folder when it lies outside.
pub fn find_root(workspace: &Path, file: &Path, markers: &[String], outermost: bool) -> PathBuf {
    let Some(start) = file.parent() else { return workspace.to_path_buf() };
    if !start.starts_with(workspace) {
        return start.to_path_buf();
    }
    let mut found = None;
    for dir in start.ancestors() {
        if markers.iter().any(|marker| dir.join(marker).exists()) {
            found = Some(dir.to_path_buf());
            if !outermost {
                break;
            }
        }
        if dir == workspace {
            break;
        }
    }
    found.unwrap_or_else(|| workspace.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rust_roots_at_the_cargo_workspace_and_ts_at_the_nearest_package() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::create_dir_all(root.join("crates/a/src")).unwrap();
        std::fs::create_dir_all(root.join("apps/web/src")).unwrap();
        std::fs::write(root.join("Cargo.toml"), "").unwrap();
        std::fs::write(root.join("crates/a/Cargo.toml"), "").unwrap();
        std::fs::write(root.join("package.json"), "").unwrap();
        std::fs::write(root.join("apps/web/package.json"), "").unwrap();

        let markers = |m: &[&str]| m.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let rs = find_root(root, &root.join("crates/a/src/lib.rs"), &markers(&["Cargo.toml"]), true);
        assert_eq!(rs, root);
        let ts = find_root(root, &root.join("apps/web/src/a.ts"), &markers(&["package.json"]), false);
        assert_eq!(ts, root.join("apps/web"));
    }

    #[test]
    fn filetypes_follow_neovim_names() {
        assert_eq!(filetype(Path::new("a/b.tsx")), Some("typescriptreact"));
        assert_eq!(filetype(Path::new("go.mod")), Some("gomod"));
        assert_eq!(spec_for("rust").map(|s| s.label), Some("rust-analyzer"));
        assert_eq!(filetype(Path::new("README")), None);
    }
}
