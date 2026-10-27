//! Everything learned from the user's machine and their Neovim setup: the
//! PATH their login shell sees, the servers their Lua config enables
//! (`vim.lsp.config`), where their Mason keeps binaries, and installing a
//! server through Mason.
//!
//! Installs go through the user's own Mason when their config has one, so the
//! server lands where Neovim already finds it. Otherwise Elaris bootstraps a
//! private mason.nvim in its data folder and installs there, never touching
//! the user's config.

use std::env;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use serde::Deserialize;
use serde_json::Value;
use tokio::process::Command;

use crate::{Error, Result};

/// Loading a full Neovim config headless can be slow (plugin managers sync);
/// past this we carry on without it.
const CONFIG_TIMEOUT: Duration = Duration::from_secs(20);
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Writes the servers the config defines to `$ELARIS_OUT` as JSON. Runs after
/// the user's init.lua, so `vim.lsp.config` holds their merged configs.
const QUERY_LUA: &str = r#"
local out = { servers = {}, has_mason = vim.fn.exists(":MasonInstall") == 2 }
pcall(function()
  out.mason = (vim.env.MASON ~= nil and vim.env.MASON ~= "") and vim.env.MASON or (vim.fn.stdpath("data") .. "/mason")
end)
pcall(function()
  local names = {}
  for _, file in ipairs(vim.api.nvim_get_runtime_file("lsp/*.lua", true)) do
    names[vim.fn.fnamemodify(file, ":t:r")] = true
  end
  for name in pairs(vim.lsp._enabled_configs or {}) do names[name] = true end
  for name in pairs(names) do
    pcall(function()
      local config = vim.lsp.config[name]
      if type(config) ~= "table" or type(config.cmd) ~= "table" then return end
      local entry = {
        name = name,
        cmd = config.cmd,
        filetypes = config.filetypes or {},
        enabled = vim.lsp.is_enabled ~= nil and vim.lsp.is_enabled(name) or false,
        root_markers = {},
      }
      for _, marker in ipairs(config.root_markers or {}) do
        if type(marker) == "string" then table.insert(entry.root_markers, marker) end
      end
      if pcall(vim.json.encode, config.settings) then entry.settings = config.settings end
      if pcall(vim.json.encode, config.init_options) then entry.init_options = config.init_options end
      table.insert(out.servers, entry)
    end)
  end
end)
local file = io.open(vim.env.ELARIS_OUT, "w")
if file then
  file:write(vim.json.encode(out))
  file:close()
end
"#;

/// Elaris's own minimal Neovim setup: mason.nvim, installing into
/// `$ELARIS_LSP_ROOT/mason`. Used only when the user's config has no Mason.
const BOOTSTRAP_LUA: &str = r#"
local root = vim.env.ELARIS_LSP_ROOT
local src = root .. "/mason.nvim"
if not vim.uv.fs_stat(src) then
  local result = vim.system({ "git", "clone", "--depth=1", "https://github.com/mason-org/mason.nvim", src }):wait()
  if result.code ~= 0 then
    io.stderr:write("Couldn't download mason.nvim: " .. (result.stderr or ""))
    vim.cmd("cquit 1")
  end
end
vim.opt.rtp:prepend(src)
require("mason").setup({ install_root_dir = root .. "/mason" })
"#;

/// A server from the user's Neovim config.
#[derive(Debug, Clone, Deserialize)]
pub struct NvimServer {
    pub name: String,
    pub cmd: Vec<Value>,
    #[serde(default, deserialize_with = "lenient_strings")]
    pub filetypes: Vec<String>,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default, deserialize_with = "lenient_strings")]
    pub root_markers: Vec<String>,
    #[serde(default)]
    pub settings: Value,
    #[serde(default)]
    pub init_options: Value,
}

impl NvimServer {
    /// The command as strings; `None` if any part isn't one.
    pub fn command(&self) -> Option<Vec<String>> {
        let parts: Option<Vec<String>> = self.cmd.iter().map(|v| v.as_str().map(str::to_owned)).collect();
        parts.filter(|parts| !parts.is_empty())
    }
}

/// Lua encodes an empty table as `{}`, not `[]`.
fn lenient_strings<'de, D: serde::Deserializer<'de>>(de: D) -> std::result::Result<Vec<String>, D::Error> {
    let value = Value::deserialize(de)?;
    Ok(value.as_array().map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_owned)).collect()).unwrap_or_default())
}

#[derive(Debug, Default, Deserialize)]
struct QueryOutput {
    #[serde(default)]
    servers: Vec<NvimServer>,
    mason: Option<String>,
    #[serde(default)]
    has_mason: bool,
}

/// The machine as language servers need it, learned once per app run.
#[derive(Debug, Clone)]
pub struct Environment {
    /// Mason bin folders first (the user's, then Elaris's), then the PATH.
    pub search_path: Vec<PathBuf>,
    pub nvim: Option<PathBuf>,
    /// Servers from the user's Neovim config.
    pub servers: Vec<NvimServer>,
    /// The user's config can run `:MasonInstall`.
    pub user_mason: bool,
    /// Elaris's private Neovim data: the bootstrapped mason.nvim and its installs.
    pub own_root: PathBuf,
}

impl Environment {
    pub async fn discover(own_root: PathBuf) -> Self {
        let mut path = login_path().await;
        path.extend(env::var_os("PATH").map(|p| env::split_paths(&p).collect::<Vec<_>>()).unwrap_or_default());
        let home = env::var_os("HOME").map(PathBuf::from).unwrap_or_default();
        path.extend([
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
            home.join(".cargo/bin"),
            home.join(".local/bin"),
            home.join("go/bin"),
            home.join(".volta/bin"),
        ]);
        dedup(&mut path);

        let nvim = env::var_os("ELARIS_NVIM").map(PathBuf::from).or_else(|| find_in("nvim", &path));
        let query = match &nvim {
            Some(nvim) => query_config(nvim, &own_root, &path).await,
            None => QueryOutput::default(),
        };

        let user_mason = query.mason.map(PathBuf::from).unwrap_or_else(default_mason_dir);
        let mut search_path = vec![user_mason.join("bin"), own_root.join("mason/bin")];
        search_path.extend(path);
        Self { search_path, nvim, servers: query.servers, user_mason: query.has_mason, own_root }
    }

    /// `program` as an absolute path: as given if it has a folder, otherwise
    /// the first match on the search path.
    pub fn resolve(&self, program: &str) -> Option<PathBuf> {
        if program.contains('/') {
            let path = PathBuf::from(program);
            return path.is_file().then_some(path);
        }
        find_in(program, &self.search_path)
    }

    /// The PATH servers run with, so their own helpers (node, cargo) resolve.
    pub fn path_env(&self) -> OsString {
        env::join_paths(&self.search_path).unwrap_or_default()
    }

    /// Installs `package` with Mason: through the user's Neovim config when
    /// it has Mason, otherwise through Elaris's bootstrapped copy.
    pub async fn install(&self, package: &str) -> Result<()> {
        let nvim = self.nvim.as_ref().ok_or(Error::NoNeovim)?;
        let mut command = Command::new(nvim);
        command.env("PATH", self.path_env());
        if !self.user_mason {
            std::fs::create_dir_all(&self.own_root)?;
            let init = self.own_root.join("init.lua");
            std::fs::write(&init, BOOTSTRAP_LUA)?;
            command
                .env("ELARIS_LSP_ROOT", &self.own_root)
                // An app name with no config folder keeps the user's plugins out.
                .env("NVIM_APPNAME", "elaris-lsp")
                .arg("-u")
                .arg(&init);
        }
        // Mason blocks until installs finish when Neovim runs headless.
        command
            .args(["--headless", "-i", "NONE", "-c", &format!("MasonInstall {package}"), "-c", "qall"])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let output = tokio::time::timeout(INSTALL_TIMEOUT, command.output())
            .await
            .map_err(|_| Error::Install(format!("Installing {package} took too long")))??;
        if !output.status.success() {
            let detail = String::from_utf8_lossy(&output.stderr);
            let detail = detail.trim();
            return Err(Error::Install(if detail.is_empty() {
                format!("Mason couldn't install {package}")
            } else {
                format!("Mason couldn't install {package}: {}", last_lines(detail, 4))
            }));
        }
        Ok(())
    }
}

/// Mason's default root: `stdpath("data")/mason`, honouring `XDG_DATA_HOME`
/// and `NVIM_APPNAME` as Neovim does.
fn default_mason_dir() -> PathBuf {
    let data = env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| env::var_os("HOME").map(PathBuf::from).unwrap_or_default().join(".local/share"));
    let app = env::var("NVIM_APPNAME").unwrap_or_else(|_| "nvim".to_owned());
    data.join(app).join("mason")
}

/// Runs the user's Neovim config headless and reads back its LSP servers.
async fn query_config(nvim: &Path, own_root: &Path, path: &[PathBuf]) -> QueryOutput {
    let attempt = async {
        std::fs::create_dir_all(own_root).ok()?;
        let script = own_root.join("query.lua");
        let out = own_root.join("query.json");
        std::fs::write(&script, QUERY_LUA).ok()?;
        let _ = std::fs::remove_file(&out);
        let status = Command::new(nvim)
            .args(["--headless", "-i", "NONE", "-c"])
            .arg(format!("luafile {}", script.display()))
            .args(["-c", "qall!"])
            .env("ELARIS_OUT", &out)
            .env("PATH", env::join_paths(path).unwrap_or_default())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status();
        tokio::time::timeout(CONFIG_TIMEOUT, status).await.ok()?.ok()?;
        serde_json::from_slice(&std::fs::read(&out).ok()?).ok()
    };
    attempt.await.unwrap_or_default()
}

/// The PATH of the user's login shell. Apps opened from Finder start with a
/// bare PATH that misses Homebrew, cargo, nvm and friends.
async fn login_path() -> Vec<PathBuf> {
    let shell = env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned());
    let run = Command::new(shell)
        .args(["-ilc", "printf '__ELARIS__%s__ELARIS__' \"$PATH\""])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .output();
    let Ok(Ok(output)) = tokio::time::timeout(SHELL_TIMEOUT, run).await else { return Vec::new() };
    let text = String::from_utf8_lossy(&output.stdout);
    let Some(value) = text.split("__ELARIS__").nth(1) else { return Vec::new() };
    env::split_paths(value).collect()
}

fn find_in(program: &str, dirs: &[PathBuf]) -> Option<PathBuf> {
    dirs.iter().map(|dir| dir.join(program)).find(|candidate| candidate.is_file())
}

fn dedup(paths: &mut Vec<PathBuf>) {
    let mut seen = std::collections::HashSet::new();
    paths.retain(|p| !p.as_os_str().is_empty() && seen.insert(p.clone()));
}

fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    lines[lines.len().saturating_sub(n)..].join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_lua_encoded_configs() {
        let json = r#"{"servers":[{"name":"lua_ls","cmd":["lua-language-server"],"filetypes":{},"enabled":true,
            "settings":{"Lua":{"hint":{"enable":true}}}},{"name":"x","cmd":["a",1]}],"mason":"/m","has_mason":true}"#;
        let out: QueryOutput = serde_json::from_str(json).unwrap();
        assert_eq!(out.servers[0].command(), Some(vec!["lua-language-server".to_owned()]));
        assert!(out.servers[0].filetypes.is_empty());
        assert_eq!(out.servers[1].command(), None);
        assert!(out.has_mason);
    }
}
