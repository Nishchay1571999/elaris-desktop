# Elaris Desktop

A Tauri v2 app combining AI chat and coding: a three-pane shell with sessions and customizations on the left, chat in the centre, and the open folder's **Files** and **Changes** on the right.

## Getting started

Requires Node.js ≥ 20.9, pnpm 10, a Rust toolchain and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm desktop:dev
```

| Command | What it does |
| --- | --- |
| `pnpm desktop:dev` | Run the desktop app with hot reload, as *Elaris (dev)* with its own chat history |
| `pnpm desktop:app` | Build a standalone copy for daily use at `target/release/elaris-desktop` (no bundle) |
| `pnpm desktop:build` | Build a release bundle |
| `pnpm desktop:install` | Build `Elaris.app` and install it to `/Applications`, quitting and replacing any running copy |
| `pnpm typecheck` | Typecheck the UI |
| `cargo test --workspace` | Rust tests; also regenerates `src/bindings` (ts-rs) |
| `pnpm repos list` / `pnpm repos clone` | See and clone the other Elaris repos (see [Other Elaris repos](#other-elaris-repos)) |

## How it works

Rust does the work: `crates/workspace` lists files (honouring `.gitignore`), watches for changes and reads git status and diffs through libgit2; chats are saved as JSON in the app data folder.

**The agent is the Claude Agent SDK.** It only exists for TypeScript and Python, so it runs in a small Node sidecar (`sidecar/`) that `crates/agent-core` starts and talks to over stdio (one JSON message per line). The agent works in the open folder with Claude Code's tools, streams text and tool calls into the chat (expand a call to see its diff, command output or file contents), asks before edits and commands (approve once, *Always allow* for the folder, or pick *Accept edits*, *Auto* or *Bypass* under the composer), asks you multiple-choice questions when it needs a decision, and resumes its own session on follow-up messages. Choose Claude Opus 5.5 (default), Sonnet 5.5 or Haiku 5.5, or the offline *Mock agent*.

- **Auth:** the SDK uses `ANTHROPIC_API_KEY` if set, otherwise your Claude Code login.
- **Node:** needs Node ≥ 18 on the machine. Set `ELARIS_NODE` if it isn't found, and `ELARIS_SIDECAR` to point at a different `main.js`.
- **Packaging:** release bundles don't ship Node or the sidecar yet. `pnpm desktop:app` builds a copy that loads the sidecar from this repo (`sidecar/dist/main.js`), so it only runs on the machine that built it, and rebuilding the sidecar changes it the next time the sidecar restarts.
- **Working on Elaris with Elaris:** use the `desktop:app` copy. `desktop:dev` rebuilds and restarts whenever `crates/` or `src-tauri/` change, which kills a running agent. A window reload (frontend edits, ⌘R) is fine: replies keep running in Rust and the chat picks them up again.

Under **Customizations** in the sidebar you can install plugins and skills, add MCP servers, and edit **Instructions**: the `CLAUDE.md` files the agent reads at the start of every chat (yours in `~/.claude`, any in folders above the open one, and the open folder's shared `CLAUDE.md` and personal `CLAUDE.local.md`). The page shows which files are read, in what order and roughly how many tokens each costs, and won't overwrite a file that changed on disk since you opened it. **Tools** sets each shell, file and git tool to *Allow*, *Ask* or *Off*, saved as permission rules in `~/.claude/settings.json` (so Claude Code follows them too), and lists the *Always allow* rules saved for the open folder.

Features not built yet (agents, hooks, attachments, worktrees) are shown disabled and marked *Planned*.

## Repository layout

```text
elaris-desktop/
├── Cargo.toml          # Rust workspace: crates/* and src-tauri
├── crates/
│   ├── agent-protocol/     # IPC/stream types, mirrored to TS with ts-rs
│   ├── agent-core/         # Claude agent (sidecar client) + offline mock
│   ├── code-intelligence/  # Language servers (via Neovim/Mason) for semantic tokens
│   ├── customizations/     # Skills, MCP servers, tool permissions, CLAUDE.md
│   ├── terminal/           # Pseudo-terminals for shells and agent commands
│   └── workspace/          # File tree, git status/diff, file watching
├── src/                # UI: components, Zustand stores, lib/ipc.ts, bindings/
├── sidecar/            # Node: Claude Agent SDK, driven over stdio
├── src-tauri/          # Tauri shell: commands, app state, JSON session store
└── scripts/            # install.sh, elaris-repos.sh
```

## Other Elaris repos

This repo is one part of Elaris. The others (the web app and the workspace repo with shared docs) are separate repos, and some may be private. To get them:

```bash
pnpm repos clone          # all of them
pnpm repos clone web      # just one
```

Inside the Elaris workspace this fills in the missing `apps/*` folders. From a standalone clone it first clones the workspace to `../elaris`. Repos you don't have access to are skipped.
