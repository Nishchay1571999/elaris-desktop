# Elaris Desktop

Elaris Desktop is a macOS app for chatting with an AI coding agent that works in a folder on your computer. It is built with Tauri v2: a React UI, Rust for everything native, and a small Node sidecar that runs the [Claude Agent SDK](https://docs.claude.com/en/api/agent-sdk/overview).

You open a folder, describe what you want, and the agent reads, edits and runs things in that folder. It asks you before edits and commands, and you watch its work as it happens. Beside the chat you get terminals, your git changes, GitHub pull requests and issues, and you can save any chat and hand it to a later one.

- [Getting started](#getting-started)
- [What it does](#what-it-does)
  - [Layout](#layout) · [Chats](#chats) · [The agent](#the-agent) · [Composer](#composer) · [Transcript](#transcript) · [Approvals and questions](#approvals-and-questions) · [Subagents](#subagents)
  - [Saved contexts](#saved-contexts) · [Terminals](#terminals) · [Source Control](#source-control) · [GitHub](#github)
  - [Desktop control](#desktop-control) · [Emulators and simulators](#emulators-and-simulators) · [Code highlighting](#code-highlighting)
  - [Customizations](#customizations) · [Settings](#settings) · [Command palette and shortcuts](#command-palette-and-shortcuts) · [Project logos](#project-logos)
- [How it works](#how-it-works)
- [Where data is stored](#where-data-is-stored)
- [Environment variables](#environment-variables)
- [Tests](#tests)
- [Repository layout](#repository-layout)
- [Other Elaris repos](#other-elaris-repos)

## Getting started

You need Node.js 20.9 or newer, pnpm 10, a Rust toolchain and the [Tauri v2 prerequisites](https://v2.tauri.app/start/prerequisites/).

```bash
pnpm install
pnpm desktop:dev
```

| Command | What it does |
| --- | --- |
| `pnpm desktop:dev` | Runs the app with hot reload, as *Elaris (dev)*, with its own data folder and chat history |
| `pnpm desktop:app` | Builds a standalone copy at `target/release/elaris-desktop` (no bundle) |
| `pnpm desktop:build` | Builds a release bundle |
| `pnpm desktop:install` | Builds `Elaris.app`, installs it to `/Applications`, and quits and relaunches any running copy |
| `pnpm typecheck` | Typechecks the UI |
| `pnpm bindings` | Regenerates the TypeScript types in `src/bindings` from the Rust types (ts-rs) |
| `cargo test --workspace` | Runs the Rust tests (this also regenerates `src/bindings`) |
| `pnpm repos …` | Lists and clones the other Elaris repos (see [Other Elaris repos](#other-elaris-repos)) |

**Signing in to Claude.** The agent uses `ANTHROPIC_API_KEY` if it is set. Otherwise it uses your Claude Code login.

**The sidecar isn't bundled.** Built apps load the sidecar from this repo's `sidecar/dist/main.js`. That means a copy from `desktop:app` or `desktop:install` only runs on the machine that built it. Rebuilding the sidecar changes the app the next time the sidecar restarts.

**Working on Elaris with Elaris.** Use the `desktop:app` or `desktop:install` copy. `desktop:dev` rebuilds and restarts whenever `crates/` or `src-tauri/` change, and that kills any running agent. Reloading the window (⌘R, or after a frontend edit) is fine: replies keep running in Rust, and the chat picks them up again.

## What it does

### Layout

- **Three resizable panes.**
  - On the left, the sidebar: 280 px by default, collapsible.
  - In the middle, the main pane: a chat, a diff, a PR or issue, a customization page or settings.
  - On the right, the **Source Control** panel: 320 px by default, collapsible.
- **Title bar.** It uses the native macOS overlay title bar and has buttons for:
  - showing and hiding the sidebar;
  - Back and Forward (up to 50 steps of history);
  - showing and hiding the Source Control panel;
  - a workspace button with the project's logo, folder name and git branch. It opens the list of recent folders, *Open folder…* and *Change logo…*;
  - beside it, the branch's standing against its remote (`2↓ 1↑`). Click it to sync, or to publish a branch that has no upstream.
- **Tabs above the chat.** Each chat has a tab strip:
  - the conversation itself;
  - tabs for files the agent wrote or edited;
  - terminal tabs;
  - subagent tabs;
  - Pull requests and Issues tabs.
  Middle-click closes a tab.
- **Opening a chat switches to that chat's folder.** A thin progress bar runs across the top while a folder opens. Errors appear as a toast you can dismiss.
- **Clipboard on macOS.** Ctrl+C, Ctrl+X and Ctrl+V work like ⌘ everywhere except in terminals.

### Chats

The sidebar lists chats from every project.

- **Each row shows:**
  - the project's logo;
  - the chat's title;
  - the start of the first message;
  - how long ago it was last active.
- **The time is replaced by a live status when there is one:**
  - **Input**: the agent asked you a question.
  - **Approval**: the agent is waiting for permission.
  - **Working**: a reply is running.
  - a snooze wake-up time, or **Woke** once the snooze ends.
- **Row actions:**
  - Rename: double-click the title.
  - Close and Reopen.
  - Snooze: 1 hour, 3 hours, this evening, tomorrow or next week. Wake it early with *Wake chat now*.
  - Archive.
  - Delete. Deleted chats go to a shelf, where you can restore them or delete them for good.
- **Shelves.** A bar at the bottom of the list has *Working*, *Snoozed*, *Closed*, *Archived* and *Deleted* shelves, each with a count. A closed or archived chat comes back to the list when it gets a new reply.
- **Search** filters chats by title and preview.
- **New chat** opens on a "What should we build in {project}?" screen with a large message box.

### The agent

The agent is Claude Code's agent, run through the Claude Agent SDK. It works in the open folder with Claude Code's own tools (read, edit, write, bash, grep, glob, web fetch, web search, todos, subagents, plan mode). It also gets four tool servers built into Elaris:

| Tool server | Tools | What it lets the agent do |
| --- | --- | --- |
| `terminal-access` | `run`, `read`, `write`, `stop`, `list` | Run commands in terminal tabs you can watch and type into; read their output; send keys; stop them |
| `desktop-control` | `screenshot`, `click`, `move`, `drag`, `scroll`, `type`, `key`, `open` | See and use your Mac's screen (macOS only) |
| `device-control` | `devices`, `boot`, `app`, `screen`, `act`, `logs`, `app_data` | Drive Android emulators and iOS simulators |
| `elaris-context` | `list`, `overview`, `read`, `search`, `raw`, `terminals` | Read chats you saved as contexts |

**Models.** You can pick Claude Opus 5.5 (the default), Claude Sonnet 5.5 or Claude Haiku 5.5. There is also *Mock agent*, which streams canned offline replies and uses no API.

**Modes.**
- **Agent** works through the task on its own.
- **Ask** answers without changing files: the edit, write and notebook tools are turned off.
- **Plan** proposes a plan for you to approve first. The agent can also enter plan mode by itself. Approving the plan returns the chat to the mode it was in before.

**Permissions.**
- **Ask before edits**
- **Accept edits**
- **Auto**: a classifier approves routine actions.
- **Bypass permissions**: shown in red.

You can change the mode, model and permissions in the middle of a reply. One exception: switching to Ask takes effect from the next message.

**Sessions.** Follow-up messages resume the same agent session. If you move a chat to a different folder, it starts a new session and carries over up to 60,000 characters of the earlier conversation. Replies are saved as they go: after every tool call, and again at the end.

### Composer

- **The message box** grows as you type. Your unsent text is kept for each chat and survives restarts.
- **Send key.** Enter sends by default; you can switch it to ⌘Enter in Settings. Shift+Enter always adds a new line.
- **Sending during a reply** stops that reply and sends your message straight away. With nothing typed, the Send button becomes Stop.
- **Images.** Attach them with the picker, by pasting, or by dragging them in. You can send up to 20 per message. Large or unusual formats are redrawn as PNG or JPEG, and anything still over 5 MB is rejected.
- **Stash.** Set a prompt aside and bring it back later (it swaps with whatever is in the box). The stash holds up to 20 prompts and is shared across chats.
- **Mode, model and permissions** each have a chip. The permissions menu also lists the folder's *Always allowed* rules, and you can remove them there.
- **Branch menu.** Switch to a local branch, or check out a remote branch as a local one.
- **Pull request chip.** It shows the current branch's PR with its state and checks, or opens *Create pull request*.
- **References.** Type `#` to attach a saved chat, or `%` to attach a saved PR or issue. A picker shows up to 8 matches. Attached references appear as chips showing their size in tokens. You can't send while the message refers to an id that doesn't exist.
- **Pending messages.** Messages that haven't reached the agent yet stack above the box. Each one shows *Sending…*, *Waiting*, *Sends once the current reply stops* or *Couldn't send*. You can *Try again*, *Edit in the box* or *Don't send*.

### Transcript

- **Messages.**
  - Replies render as GitHub-flavoured Markdown, with highlighted code blocks that each have a Copy button.
  - Images in your own messages can be zoomed.
  - Hovering any message shows its time and a Copy button.
- **Usage.** The chat header has a context-window ring that turns amber at 70% and red at 90%. Next to it are the input and output token counts; their tooltip adds cache reads and writes.
- **Tool calls.**
  - Two or more tool calls in a row fold into one group. While it runs, the group shows the current call. When it finishes, it shows a summary such as "Ran 3 commands, read 2 files".
  - Expand a call to see what it did. Edits show a coloured diff, commands show the command and its output, plans show as Markdown, and other tools show their input and output.
- **File tabs.** Edit and write calls open a tab beside the chat:
  - a write shows the whole file, with line numbers;
  - an edit shows the whole current file diffed against its contents before the edit, and scrolls to the first change.
- **Plans** appear as a document card with its status (*Waiting for approval*, *Approved* or *Not approved*) and a Copy button.
- **Find in chat** (⌘F) highlights every match and shows "n of N". Enter and Shift+Enter move between matches, and the search updates as new text streams in.

### Approvals and questions

When the agent needs you, a panel opens on top of the message box. It handles one request at a time and shows how many more are waiting.

- **Permission requests** show the tool and a preview of what it will do. You can choose:
  - **Deny** (Esc);
  - **Allow** (↵);
  - **Always allow**, which saves the rule for this folder and reuses it in later chats.
  *Always allow* isn't offered for plain shell commands that come without a suggested rule, or for typing into terminals.
- **Plans** ask *Approve this plan?* with two buttons: *Keep planning* and *Approve plan*.
- **Questions** from the agent offer single- or multiple-choice answers with descriptions.
  - When there are several questions, each gets a tab.
  - Keys 1 to 9 pick an answer, ↑ and ↓ move, ⌘↵ sends and Esc skips.
  - To answer in your own words, type in the message box instead.

### Subagents

When the agent starts subagents, each one gets a tab. The tab shows what the subagent was asked and what it did, with its status: *Working*, *Done*, *Failed* or *Stopped*. You can message a subagent from its tab; the message is passed on to it once the current reply ends.

### Saved contexts

You can save any chat as a context, so another chat can use it later.

- **Saving.** The bookmark button beside the chat tab saves the whole chat: every prompt, reply, thinking block, tool call and output, and the output of terminals the chat opened. The context gets an id like `#ctx-a1b2c3`, which is copied for you. You can also export a context as Markdown.
- **What gets saved.** Elaris saves the Claude Agent SDK's own transcript (including subagents), unchanged. If that transcript isn't on this machine, it falls back to Elaris's copy of the chat and marks the context as partial. Saving a chat that hasn't changed returns the existing context instead of making a duplicate.
- **Using it.** Type `#ctx-…` in a message to attach the context.
  - Contexts that together fit in about 60,000 tokens go into the prompt whole.
  - Larger ones go in as an outline. The agent then reads the rest page by page, or searches it, with the `elaris-context` tools.
- **GitHub items.** PRs and issues can be saved the same way, as `%pr-…` and `%issue-…`. Their images are sent to the agent too.
- **Search.** Saved contexts are indexed in SQLite full-text search, so any part of a word matches.

### Terminals

- **⌘T** opens your shell in the project folder as a tab beside the chat.
- **Rendering.**
  - Terminals use xterm.js, drawn with WebGL (or the DOM if WebGL isn't available).
  - They use Geist Mono with Nerd Font symbols, and their colours follow the app theme.
  - The tab title follows the program that's running.
- **Persistence.** Shells and their scrollback (1 MB per terminal) survive switching tabs and chats.
- **Agent terminals.** Terminals the agent opens with `terminal-access` are tinted, pulse while they're running, and stay open after their command ends. They reopen as tabs after a window reload. The agent can only use terminals that its own chat opened.

### Source Control

The right panel works like VS Code's Source Control view. It refreshes whenever files or git state change on disk.

- **Changes.**
  - Files are grouped into *Merge Changes*, *Staged Changes*, *Changes* and *Untracked Changes*.
  - Each file has a letter badge: A, M, D, R, U, or `!` for a conflict.
  - View the files as a list or a folder tree (single-folder chains fold into one row), sorted by name, path or status.
  - Hover a file, folder or group to stage, unstage or discard it. Right-click a file for *Open Changes*, *Open File*, *Add to .gitignore*, *Reveal in Finder* and *Copy Path*.
  - ⌘-click and ⇧-click select several files. Space stages the focused file.
  - Discarding asks first. Untracked files go to the Trash rather than being deleted.
- **Diffs.**
  - Clicking a file opens its staged or working-tree diff. A file with both kinds of change gets a switch between them.
  - Each hunk has *Stage*, *Unstage* or *Revert* buttons, applied with `git apply`.
- **Committing.**
  - Write a message and press ⌘↩ to commit, or ⇧⌘↩ to commit and push.
  - If anything is staged, only the staged files are committed. If nothing is, Elaris asks once whether to stage everything (VS Code's smart commit).
  - The main button changes with the repository's state: *Commit*; *Continue* or *Abort* during a merge, rebase, cherry-pick or revert; *Publish Branch* when the branch has no upstream; and *Sync Changes 2↓ 1↑* when it's behind or ahead.
  - The button's menu adds *Commit & Push*, *Commit & Sync*, *Commit & Open Pull Request…*, *Commit All* and *Amend*.
- **The `…` menu** follows VS Code's:
  - View & Sort.
  - Pull, Push, Clone, Checkout to…, Fetch.
  - Add Co-authors… (adds `Co-authored-by:` trailers).
  - **Commit:** staged, all, amend, signed off, no-verify, undo last commit.
  - **Changes:** stage, unstage or discard all.
  - **Pull, Push:** sync, pull (rebase), pull from…, push to…, force push (`--force-with-lease`), fetch (prune), fetch from all remotes.
  - **Branch:** merge, rebase, create, create from…, rename, delete, delete remote branch, publish.
  - **Remote:** add, rename, remove.
  - **Stash:** stash (with untracked or staged only), apply or pop the latest or a chosen stash, drop, drop all, view.
  - **Tags:** create (lightweight, or annotated with a message), delete, delete on a remote, push.
  - Show Commit Graph, and Show Git Output.
  - Choices and names are asked for in a quick pick, like VS Code's.
- **Branches.** *Checkout to…* lists local branches, remote branches and tags, plus *Create new branch…*. A remote branch becomes a local tracking branch. If uncommitted changes would block a switch, Elaris stashes them, switches, and puts them back.
- **Commit Graph.**
  - Every branch's history (or just the current branch's) with lanes, merge dots, and pills for branches, tags and HEAD.
  - Click a commit to see its message and changed files. Right-click it to check it out, branch or tag from it, cherry-pick, revert, or copy its hash.
- **Git Output.** Every git command Elaris runs, with its time, duration, exit code and what git printed, the way VS Code's Git output channel shows it. Error popups link to it.
- **No repository yet.** The panel offers *Initialize Repository* and *Clone Repository*.
- **Under the hood.**
  - Status comes from `git status --porcelain=v2`, and everything that changes the repository runs the `git` command. Hooks, credential helpers and your git config apply as they do in a terminal.
  - Pulls, pushes, fetches and clones stream git's progress into the panel.
  - Every command and palette entry is also under *Git:* in the command palette.

### GitHub

Everything GitHub-related runs through your own [GitHub CLI](https://cli.github.com) (`gh`). Elaris doesn't talk to GitHub any other way.

- **Connecting.**
  - If `gh` is missing, Elaris can install it with Homebrew (showing the progress) or link to the download page.
  - Sign-in uses GitHub's device flow: you get a one-time code to copy and a button that opens github.com/login/device.
  - Settings shows who you are signed in as, and lets you sign out.
- **Pull requests and Issues lists.** Both cover every repository `gh` can see.
  - Tabs for each state: Open, Merged and Closed for pull requests; Open and Closed for issues.
  - Search.
  - Filters for involvement (involving me, created by me, assigned to me, review requested, mentioning me, everyone), repository, label and last updated.
  - Results are cached and refreshed in the background.
- **Pull request page.**
  - **Conversation:** the description, comments, reviews, and line-comment threads with a snippet of the diff. Images, videos and file attachments show inline.
  - **Files:** a collapsible diff for each file, with a *Viewed* checkbox per file.
  - **Checks:** sorted with failed first, then pending, then passed, each with its duration and a link.
  - **Commits:** the pull request's commits.
  - **Actions:**
    - merge (squash, merge commit or rebase), optionally deleting the branch;
    - mark as ready, or convert to draft;
    - close, or reopen;
    - check out the branch;
    - comment, approve, or request changes;
    - copy the link or the branch name;
    - save as a `%` context.
- **Issue page.** The issue's thread, labels and assignees. You can comment, close as done or as not planned, reopen, and save it as a `%` context.
- **Creating a pull request.**
  - Pick the base branch. The title and body are filled in from the branch's commits.
  - You can open it as a draft, and you can commit chosen files first.
  - If you're on the base branch, you name a new branch and your changes go with you.
  - Elaris pushes the branch for you. If the branch already has a pull request, it offers to open that one instead.

### Desktop control

With `desktop-control`, the agent can see your Mac's screen and use it: screenshots, clicks, moving the mouse, dragging, scrolling, typing, key combos such as `cmd+shift+t`, and opening apps or links.

- **macOS only.** It needs the Screen Recording and Accessibility permissions, and Elaris asks for them.
- **Screenshots** are scaled to fit 1280×800.
- **One at a time.** Calls run one at a time across every chat, and each one goes through the normal permission flow.

### Emulators and simulators

With `device-control`, the agent can drive Android emulators (through `adb`) and iOS simulators (through `xcrun simctl` and [AXe](https://github.com/cameroncooke/AXe): `brew install cameroncooke/axe/axe`). The tools are built to use few tokens:

- **`screen`** reads the screen as a short, numbered list of elements, such as `[7] Button "Continue" @540,1820`, instead of a screenshot. It can include a small image when the look of the screen matters.
- **`act`** runs a batch of up to 40 steps in one call: tap, long press, swipe, scroll (optionally until some text appears), type, key, wait, wait for something, and open a URL. Steps can target elements by number or by their text.
- **`app`** lists, launches, stops, restarts, installs, uninstalls, clears and inspects apps.
- **`logs`** returns only the app's own log, filtered by a search term, with repeated lines collapsed.
- **`app_data`** lists and reads the app's files and preferences, and runs SQL on a copy of the app's SQLite databases. Results are capped at 100 rows. On Android this needs a debuggable build.
- **`devices`** lists devices, and **`boot`** starts one.

Reading devices, screens and logs is allowed by default. Acting, booting and managing apps ask first. You can change this under **Customizations → Tools**.

### Code highlighting

- **Fast colouring first.** Code in edit tabs is coloured straight away with highlight.js.
- **Then language-server colours.** Semantic tokens from a language server are laid on top.
- **Which servers.** Elaris uses the language servers your Neovim config enables. If it can't find any, it falls back to `rust-analyzer`, `ts_ls`, `basedpyright`, `gopls`, `lua_ls`, `clangd` and `zls`.
- **Status.** The tab header shows the server's status: starting, indexing, running, missing or failed.
- **Installing a missing server.** *Install with Mason* installs it through Neovim's Mason. Elaris uses your own Mason setup if you have one, and otherwise a private copy, so your Neovim config isn't touched.
- **Elsewhere.** Diffs and PR files use highlight.js only.

### Customizations

These pages are in the sidebar.

- **MCP Servers.** Add and remove the MCP servers in your user-scope `~/.claude.json`.
  - There is a catalog of 14: Context7, GitHub, Linear, Notion, Sentry, Figma, Vercel, Supabase, Stripe, Playwright, Chrome DevTools, Brave Search, Memory and Sequential thinking.
  - Servers that need a key ask for it before they're added.
  - Servers added outside Elaris are listed too.
- **Skills.** See the skills installed in `~/.claude/skills`, browse and search [skills.sh](https://skills.sh), and install or remove skills (this runs `npx skills`).
- **Instructions.** View and edit the `CLAUDE.md` files the agent reads at the start of every chat:
  - yours, in `~/.claude`;
  - any in folders above the project;
  - the project's shared `CLAUDE.md` and personal `CLAUDE.local.md`.
  A strip shows the order they're read in and roughly how many tokens each one costs. Saving won't overwrite a file that changed on disk since you opened it.
- **Tools.** Set each tool to *Allow*, *Ask* or *Off*. These are saved as permission rules in `~/.claude/settings.json`, so Claude Code follows them too. The tools are grouped as:
  - **Shell:** run commands; run in terminal tabs; type into terminal tabs; delete with `rm`.
  - **Files:** read; find; search contents; edit; create or overwrite; edit notebooks.
  - **Git:** look at changes and history; stage and commit; switch and create branches; push; rewrite or discard work.
  - **Desktop:** see the screen; use the mouse and keyboard; open apps and links.
  - **Devices:** read devices and apps; tap, type and swipe; start devices and manage apps.
  The page also lists any other rules in `settings.json` and the folder's *Always allow* rules, and you can remove any of them.
- **Plugins.** A browsable catalog of plugins with install and on/off switches. Your choices are saved inside Elaris only; nothing is installed.

### Settings

- **Appearance.**
  - Theme: light, dark or system. Dark is the default.
  - Accent colour: blue, violet, teal, green, amber or rose.
  - Chat text size.
  - Density: comfortable or compact.
  - Animations on or off. They are also turned off when the system asks for reduced motion.
- **Chat.**
  - The send key.
  - The mode, model and permissions new chats start with.
- **Keyboard.** Rebind every command by clicking its shortcut and pressing new keys. Elaris warns you about clashes, and you can reset one shortcut or all of them.
- **GitHub.** Connect, or sign out.
- **About.** The app's version.

### Command palette and shortcuts

**⌘K** opens the command palette. It includes:
- recent chats in the current folder;
- every command;
- mode, model and permissions for the current chat or the next new one;
- recent folders.

Default shortcuts (Ctrl instead of ⌘ outside macOS). You can change them in Settings:

| Command | Shortcut |
| --- | --- |
| Command palette | ⌘K |
| New chat | ⌘N |
| Focus the message box | ⌘L |
| Find in chat | ⌘F |
| New terminal | ⌘T |
| Open folder… | ⌘O |
| Pull requests | ⇧⌘P |
| Settings | ⌘, |
| Toggle light and dark theme | ⇧⌘L |
| Toggle sidebar | ⌘B |
| Toggle Source Control panel | ⌥⌘B |
| Show Source Control | ⇧⌘G |
| Go back / forward | ⌘[ / ⌘] |

*Issues* and *New pull request…* are in the palette without default shortcuts.

### Project logos

Each project gets a logo. It appears in the title bar, on chat rows, in recent folders and in the palette.

- **By default** Elaris finds the project's own favicon or logo: at the top level, in `public/` or `assets/`, in Android launcher icons, or in `apps/*` and `packages/*` of a monorepo. If there isn't one, it makes a two-letter monogram.
- **Choosing your own.** *Change logo…* lets you pick one of 51 icons in 10 colours, an emoji, up to two letters, or an image file (SVG, PNG, ICO, JPEG, WebP or GIF, up to 2 MB).

## How it works

```text
React UI (src/) ──Tauri commands/events──▶ Rust (src-tauri/, crates/)
                                              │
                                              ├─ agent-core ──stdio, JSON lines──▶ Node sidecar (sidecar/)
                                              │                                      └─ Claude Agent SDK
                                              │                                         + in-process MCP servers
                                              │                                           (calls go back to Rust)
                                              ├─ workspace, terminal, contexts, customizations,
                                              │  code-intelligence, desktop-control, device-control
                                              └─ git, gh, brew, curl, adb, xcrun, nvim, npx (as child processes)
```

- **Rust does the work.** The UI calls about 90 Tauri commands (`src/lib/ipc.ts` is the typed client). The Rust types that cross over are exported to TypeScript with ts-rs (`src/bindings/`).
- **The Claude Agent SDK only exists for TypeScript and Python,** so it runs in a Node sidecar.
  - `crates/agent-core` starts one sidecar process that serves every chat, and talks to it with one JSON message per line. Replies are routed by run id.
  - If the sidecar exits, the next run starts a new one.
  - Replies keep running in Rust when the window reloads, and the reloaded window picks them back up.
- **Elaris's own tools** are MCP servers that live inside the sidecar. Each call is forwarded to Rust:
  - `agent_terminal.rs` handles `terminal-access`;
  - `agent_desktop.rs` handles `desktop-control`;
  - `agent_device.rs` handles `device-control`;
  - `agent_contexts.rs` handles `elaris-context`.
- **Child processes** (`git`, `gh` and the rest) get the PATH from your login shell, so tools installed with Homebrew, nvm or volta are found.
- **The Node binary** is found on PATH, in Homebrew's folders, in `~/.volta/bin`, or in the newest `~/.nvm` version. You can override it with `ELARIS_NODE`.

| Crate | What it does |
| --- | --- |
| `agent-protocol` | The types for chats, messages, events and settings that are shared with the UI (mirrored to TypeScript) |
| `agent-core` | Starts and talks to the sidecar; the offline mock agent |
| `workspace` | File listing (honours `.gitignore`), file watching, git status, diffs and branches (libgit2), finding project logos |
| `terminal` | Pseudo-terminals (`portable-pty`) for your shells and the agent's commands, with scrollback and plain-text output |
| `contexts` | Saved chats, PRs and issues in SQLite, with full-text search |
| `customizations` | Skills, MCP servers, tool permission rules, `CLAUDE.md` files |
| `code-intelligence` | Language servers found through Neovim and Mason, for semantic highlighting |
| `desktop-control` | Screenshots and mouse and keyboard input on macOS (Core Graphics) |
| `device-control` | Android emulators (`adb`) and iOS simulators (`simctl`, AXe) |

## Where data is stored

| What | Where |
| --- | --- |
| Chats | `<app data>/sessions/<id>.json`, one file per chat |
| Images you sent | `<app data>/attachments/<chat>/` |
| Recent folders and *Always allow* rules | `<app data>/settings.json` |
| Saved contexts, PRs and issues | `<app data>/elaris.db` (SQLite), with attachments in `<app data>/saved-items/` |
| Language servers Elaris installed | `<app data>/code-intelligence/` |
| GitHub images and files | `<app cache>/gh-assets/` |
| UI preferences, chat statuses, drafts, stash, GitHub cache | The webview's localStorage |
| MCP servers, tool rules, skills, `CLAUDE.md` | Claude Code's own files (`~/.claude.json`, `~/.claude/`), so Claude Code shares them |

`<app data>` is the folder for `ai.elaris.desktop` (on macOS, `~/Library/Application Support/ai.elaris.desktop`). Dev builds use `ai.elaris.desktop.dev`.

## Environment variables

| Variable | What it does |
| --- | --- |
| `ANTHROPIC_API_KEY` | The API key the agent uses (if it isn't set, your Claude Code login is used) |
| `ELARIS_NODE` | Path to the `node` binary that runs the sidecar |
| `ELARIS_SIDECAR` | Path to a different sidecar `main.js` |
| `ELARIS_NVIM` | Path to `nvim`, for language servers |
| `ELARIS_HIDE_PATH` | Dev only: hides folders from the PATH that tools see, to test the "not installed" screens |
| `CLAUDE_CONFIG_DIR` | Where Claude Code's config lives (default `~/.claude`) |
| `ANDROID_HOME` / `ANDROID_SDK_ROOT` | Where the Android SDK is |

## Tests

There are about 125 Rust tests across the crates and `src-tauri`. Run them with `cargo test --workspace`.

- **agent-core** is tested against a fake sidecar, including a sidecar crashing and being restarted.
- **Live tests** need a real screen or device: `desktop-control` and `device-control` mark theirs `#[ignore]`, and `code-intelligence`'s only run with `ELARIS_LIVE_LSP=1`.

## Repository layout

```text
elaris-desktop/
├── Cargo.toml              # Rust workspace: crates/* and src-tauri
├── crates/
│   ├── agent-protocol/     # Types shared with the UI, mirrored to TS with ts-rs
│   ├── agent-core/         # Sidecar client and offline mock agent
│   ├── code-intelligence/  # Language servers via Neovim/Mason, for semantic tokens
│   ├── contexts/           # Saved chats, PRs and issues (SQLite + FTS5)
│   ├── customizations/     # Skills, MCP servers, tool permissions, CLAUDE.md
│   ├── desktop-control/    # macOS screen, mouse and keyboard for the agent
│   ├── device-control/     # Android emulators and iOS simulators for the agent
│   ├── terminal/           # Pseudo-terminals for shells and agent commands
│   └── workspace/          # Files, git, file watching, project logos
├── sidecar/                # Node: Claude Agent SDK and Elaris's MCP servers, driven over stdio
├── src-tauri/              # Tauri shell: commands, app state, chat store, GitHub (gh), agent tool hosts
├── src/                    # React UI: components, Zustand stores, lib/ipc.ts, bindings/
└── scripts/                # install.sh, elaris-repos.sh
```

UI stack: React 19, Vite, Tailwind CSS 4, Radix UI, Zustand, xterm.js, react-markdown, highlight.js (lowlight), cmdk, react-resizable-panels.

## Other Elaris repos

This repo is one part of Elaris. The others are the web app and the workspace repo, which holds the shared docs. To get them:

```bash
pnpm repos clone          # all of them
pnpm repos clone web      # just one
```

Inside the Elaris workspace, this fills in the missing `apps/*` folders. From a standalone clone, it first clones the workspace to `../elaris`. Repos you don't have access to are skipped.
