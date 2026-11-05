/**
 * Typed wrappers around the Rust commands in `src-tauri/src/commands`. This is
 * the only module that talks to Tauri; everything else imports from here.
 * Types come from `src/bindings`, generated from the Rust structs.
 */
import { Channel, invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { ask, open } from "@tauri-apps/plugin-dialog"

import type { AgentEvent } from "@/bindings/AgentEvent"
import type { Branches } from "@/bindings/Branches"
import type { ChangedFile } from "@/bindings/ChangedFile"
import type { CommitDetail } from "@/bindings/CommitDetail"
import type { CommitOptions } from "@/bindings/CommitOptions"
import type { DiffSide } from "@/bindings/DiffSide"
import type { FetchOptions } from "@/bindings/FetchOptions"
import type { GitOutputEntry } from "@/bindings/GitOutputEntry"
import type { GraphCommit } from "@/bindings/GraphCommit"
import type { LogOptions } from "@/bindings/LogOptions"
import type { PullOptions } from "@/bindings/PullOptions"
import type { PushOptions } from "@/bindings/PushOptions"
import type { RemoteEntry } from "@/bindings/RemoteEntry"
import type { ScmStatus } from "@/bindings/ScmStatus"
import type { StashEntry } from "@/bindings/StashEntry"
import type { StashOptions } from "@/bindings/StashOptions"
import type { TagEntry } from "@/bindings/TagEntry"
import type { ContextSummary } from "@/bindings/ContextSummary"
import type { ItemSummary } from "@/bindings/ItemSummary"
import type { FileEntry } from "@/bindings/FileEntry"
import type { FilePreview } from "@/bindings/FilePreview"
import type { Highlights } from "@/bindings/Highlights"
import type { ImageAttachment } from "@/bindings/ImageAttachment"
import type { InstalledSkill } from "@/bindings/InstalledSkill"
import type { InstructionFile } from "@/bindings/InstructionFile"
import type { LiveReply } from "@/bindings/LiveReply"
import type { McpServer } from "@/bindings/McpServer"
import type { PermissionDecision } from "@/bindings/PermissionDecision"
import type { PermissionRules } from "@/bindings/PermissionRules"
import type { RuleBehavior } from "@/bindings/RuleBehavior"
import type { Session } from "@/bindings/Session"
import type { SessionSettings } from "@/bindings/SessionSettings"
import type { ServerStatus } from "@/bindings/ServerStatus"
import type { SessionSummary } from "@/bindings/SessionSummary"
import type { SkillListing } from "@/bindings/SkillListing"
import type { TokenUsage } from "@/bindings/TokenUsage"
import type { WorkspaceInfo } from "@/bindings/WorkspaceInfo"
import type {
  BranchPr,
  GhAsset,
  GhLabel,
  GhRepo,
  GhRepoRef,
  GhStatus,
  IssueDetail,
  IssueStateChange,
  MergeMethod,
  PrDetail,
  PrFilter,
  PrStateChange,
  PrSummary,
  ReviewAction,
  SearchFilters,
  SearchItem,
  SetupEvent,
  TrackerKind,
} from "@/lib/github"

export const ipc = {
  workspace: {
    open: (path: string) => invoke<WorkspaceInfo>("workspace_open", { path }),
    current: () => invoke<WorkspaceInfo | null>("workspace_current"),
    recent: () => invoke<string[]>("workspace_recent"),
    listDir: (path: string) => invoke<FileEntry[]>("workspace_list_dir", { path }),
    readFile: (path: string) => invoke<FilePreview>("workspace_read_file", { path }),
    /** Opens a workspace file in its default app. */
    openFile: (path: string) => invoke<void>("workspace_open_file", { path }),
    /** Shows a workspace file in Finder. */
    reveal: (path: string) => invoke<void>("workspace_reveal", { path }),
    /** Any folder's favicon or `logo.*` as a `data:` URL, or null. */
    logo: (path: string) => invoke<string | null>("workspace_logo", { path }),
    /** An image file (absolute path) as a `data:` URL, for a custom logo. */
    imageDataUrl: (path: string) => invoke<string>("read_image_data_url", { path }),
    /** Debounced batches of changed workspace-relative paths. */
    onChanged: (handler: (paths: string[]) => void): Promise<UnlistenFn> =>
      listen<{ paths: string[] }>("workspace://changed", (event) => handler(event.payload.paths)),
  },
  git: {
    /** Makes the open folder a git repository. */
    init: () => invoke<void>("git_init"),
    status: () => invoke<ChangedFile[]>("git_status"),
    /** Staged, unstaged, untracked and conflicted files; null outside a repository. */
    scmStatus: () => invoke<ScmStatus | null>("git_scm_status"),
    /** A file's changes against HEAD, staged and unstaged together. */
    diff: (path: string) => invoke<string>("git_diff", { path }),
    /** One side of a file's changes; headers name the file from the repository root. */
    diffFile: (path: string, side: DiffSide) => invoke<string>("git_diff_file", { path, side }),
    /** Stages (`cached`), unstages (`cached` + `reverse`) or reverts (`reverse`) a hunk. */
    applyPatch: (patch: string, cached: boolean, reverse: boolean) =>
      invoke<void>("git_apply_patch", { patch, cached, reverse }),
    stage: (paths: string[]) => invoke<void>("git_stage", { paths }),
    stageAll: () => invoke<void>("git_stage_all"),
    unstage: (paths: string[]) => invoke<void>("git_unstage", { paths }),
    unstageAll: () => invoke<void>("git_unstage_all"),
    /** Reverts work-tree changes; untracked files go to the Trash. */
    discard: (paths: string[]) => invoke<void>("git_discard", { paths }),
    discardAll: () => invoke<void>("git_discard_all"),
    ignore: (path: string) => invoke<void>("git_ignore", { path }),
    branches: () => invoke<Branches>("git_branches"),
    /** Checks out `name`; a remote branch (`origin/name`) becomes a local tracking branch. */
    switch: (name: string) => invoke<void>("git_switch", { name }),
    /** Creates a branch from `from` (default HEAD) and switches to it, keeping uncommitted changes. */
    createBranch: (name: string, from?: string) => invoke<void>("git_create_branch", { name, from: from ?? null }),
    renameBranch: (old: string, name: string) => invoke<void>("git_rename_branch", { old, new: name }),
    deleteBranch: (name: string, force = false) => invoke<void>("git_delete_branch", { name, force }),
    deleteRemoteBranch: (name: string) => invoke<void>("git_delete_remote_branch", { name }),
    merge: (name: string) => invoke<void>("git_merge", { name }),
    rebase: (onto: string) => invoke<void>("git_rebase", { onto }),
    checkoutCommit: (sha: string) => invoke<void>("git_checkout_commit", { sha }),
    cherryPick: (sha: string) => invoke<void>("git_cherry_pick", { sha }),
    revert: (sha: string) => invoke<void>("git_revert", { sha }),
    abortOperation: () => invoke<void>("git_abort_operation"),
    continueOperation: () => invoke<void>("git_continue_operation"),
    /**
     * Commits; returns the short hash. With neither `paths` nor `stagedOnly`, every change in
     * the folder is staged first. `paths` commits just those files.
     */
    commit: (message: string, paths: string[] | null, options: Partial<Omit<CommitOptions, "message" | "paths">> = {}) =>
      invoke<string>("git_commit", { request: { message, paths, ...options } }),
    lastCommitMessage: () => invoke<string>("git_last_commit_message"),
    /** Undoes the last commit, keeping its changes staged; returns its message. */
    undoLastCommit: () => invoke<string>("git_undo_last_commit"),
    /** Recent authors as `Name <email>`, for co-author trailers. */
    authors: () => invoke<string[]>("git_authors"),
    fetch: (options: Partial<FetchOptions> = {}, onProgress?: (line: string) => void) =>
      invoke<void>("git_fetch", { options, onProgress: lines(onProgress) }),
    pull: (options: Partial<PullOptions> = {}, onProgress?: (line: string) => void) =>
      invoke<void>("git_pull", { options, onProgress: lines(onProgress) }),
    /** Pushes the current branch; one without an upstream is published. */
    push: (options: Partial<PushOptions> = {}, onProgress?: (line: string) => void) =>
      invoke<void>("git_push", { options, onProgress: lines(onProgress) }),
    /** Pulls if behind, then pushes. */
    sync: (rebase = false, onProgress?: (line: string) => void) =>
      invoke<void>("git_sync", { rebase, onProgress: lines(onProgress) }),
    /** Clones into a new folder inside `parent`; resolves to the folder. */
    clone: (url: string, parent: string, onProgress?: (line: string) => void) =>
      invoke<string>("git_clone", { url, parent, onProgress: lines(onProgress) }),
    stashes: () => invoke<StashEntry[]>("git_stashes"),
    stash: (options: Partial<StashOptions> = {}) => invoke<void>("git_stash", { options }),
    stashApply: (index: number, pop: boolean) => invoke<void>("git_stash_apply", { index, pop }),
    stashDrop: (index: number) => invoke<void>("git_stash_drop", { index }),
    stashClear: () => invoke<void>("git_stash_clear"),
    stashShow: (index: number) => invoke<string>("git_stash_show", { index }),
    tags: () => invoke<TagEntry[]>("git_tags"),
    /** Tags `target` (default HEAD); a message makes it annotated. */
    createTag: (name: string, message?: string, target?: string) =>
      invoke<void>("git_create_tag", { name, message: message ?? null, target: target ?? null }),
    deleteTag: (name: string) => invoke<void>("git_delete_tag", { name }),
    pushTags: (remote?: string, onProgress?: (line: string) => void) =>
      invoke<void>("git_push_tags", { remote: remote ?? null, onProgress: lines(onProgress) }),
    deleteRemoteTag: (remote: string, name: string) => invoke<void>("git_delete_remote_tag", { remote, name }),
    remotes: () => invoke<RemoteEntry[]>("git_remotes"),
    addRemote: (name: string, url: string) => invoke<void>("git_add_remote", { name, url }),
    removeRemote: (name: string) => invoke<void>("git_remove_remote", { name }),
    renameRemote: (old: string, name: string) => invoke<void>("git_rename_remote", { old, new: name }),
    /** Commits for the graph, newest first, children before parents. */
    log: (options: Partial<LogOptions> = {}) => invoke<GraphCommit[]>("git_log", { options }),
    show: (sha: string) => invoke<CommitDetail>("git_show", { sha }),
    /** Commits on this branch that `base` lacks, oldest first. */
    logRange: (base: string) => invoke<Array<{ subject: string; body: string }>>("git_log_range", { base }),
    /** Git commands run so far this session, oldest first. */
    outputHistory: () => invoke<GitOutputEntry[]>("git_output_history"),
    /** Each git command as it finishes. */
    onOutput: (handler: (entry: GitOutputEntry) => void): Promise<UnlistenFn> =>
      listen<GitOutputEntry>("git://output", (event) => handler(event.payload)),
  },
  github: {
    status: () => invoke<GhStatus>("gh_status"),
    install: (onEvent: (event: SetupEvent) => void) => invoke<void>("gh_install", { onEvent: setupChannel(onEvent) }),
    /** Device-flow sign-in; the one-time code arrives as a `code` event. Resolves once signed in. */
    login: (onEvent: (event: SetupEvent) => void) => invoke<void>("gh_login", { onEvent: setupChannel(onEvent) }),
    cancelLogin: () => invoke<void>("gh_login_cancel"),
    logout: () => invoke<void>("gh_logout"),
    repo: () => invoke<GhRepo | null>("gh_repo"),
    prs: (filter: PrFilter, query?: string) => invoke<PrSummary[]>("gh_pr_list", { filter, query: query ?? null }),
    /** Pull requests or issues from any repository gh can see, most recently updated first. */
    search: (kind: TrackerKind, filters: SearchFilters) => invoke<SearchItem[]>("gh_search", { kind, filters }),
    repos: () => invoke<GhRepoRef[]>("gh_repos"),
    labels: (repo: string) => invoke<GhLabel[]>("gh_labels", { repo }),
    // `repo` (owner/name) names the pull request's repository; without it, the open folder's.
    pr: (repo: string | undefined, number: number) => invoke<PrDetail>("gh_pr_view", { repo: repo ?? null, number }),
    prDiff: (repo: string | undefined, number: number) => invoke<string>("gh_pr_diff", { repo: repo ?? null, number }),
    prForBranch: () => invoke<BranchPr | null>("gh_pr_for_branch"),
    comment: (repo: string | undefined, number: number, body: string) =>
      invoke<void>("gh_pr_comment", { repo: repo ?? null, number, body }),
    review: (repo: string | undefined, number: number, action: ReviewAction, body: string) =>
      invoke<void>("gh_pr_review", { repo: repo ?? null, number, action, body }),
    merge: (repo: string | undefined, number: number, method: MergeMethod, deleteBranch: boolean) =>
      invoke<void>("gh_pr_merge", { repo: repo ?? null, number, method, deleteBranch }),
    setState: (repo: string | undefined, number: number, change: PrStateChange) =>
      invoke<void>("gh_pr_set_state", { repo: repo ?? null, number, change }),
    issue: (repo: string, number: number) => invoke<IssueDetail>("gh_issue_view", { repo, number }),
    issueComment: (repo: string, number: number, body: string) => invoke<void>("gh_issue_comment", { repo, number, body }),
    issueSetState: (repo: string, number: number, change: IssueStateChange) =>
      invoke<void>("gh_issue_set_state", { repo, number, change }),
    /** Downloads an attachment into the app's cache once (with the gh token on GitHub hosts). */
    asset: (url: string) => invoke<GhAsset>("gh_asset", { url }),
    /** Opens a downloaded attachment in its default app. */
    assetOpen: (path: string) => invoke<void>("gh_asset_open", { path }),
    /**
     * Saves a pull request or issue, discussion and attachments included, for chats to reference
     * as `%id`. `repo` is required for issues; an unchanged one returns the snapshot saved before.
     */
    saveItem: (kind: "pr" | "issue", repo: string | undefined, number: number) =>
      invoke<ItemSummary>("gh_save_item", { kind, repo: repo ?? null, number }),
    checkout: (number: number) => invoke<void>("gh_pr_checkout", { number }),
    createPr: (request: { title: string; body: string; base: string; draft: boolean }) =>
      invoke<{ number: number | null; url: string }>("gh_pr_create", { request }),
  },
  /** Opens a web link in the default browser. */
  openUrl: (url: string) => invoke<void>("open_url", { url }),
  code: {
    /**
     * Semantic tokens for `text`, the contents of `path` as shown, from the file's language
     * server (started on first use). `path` is workspace-relative or absolute.
     */
    highlights: (path: string, text: string) => invoke<Highlights>("code_highlights", { path, text }),
    /** Installs the file's server through Neovim's Mason; can take minutes. */
    install: (path: string) => invoke<ServerStatus>("code_install_server", { path }),
  },
  sessions: {
    list: () => invoke<SessionSummary[]>("sessions_list"),
    get: (id: string) => invoke<Session>("sessions_get", { id }),
    /** Every token the chat has used, read fresh through the Agent SDK. */
    usage: (id: string) => invoke<TokenUsage>("sessions_usage", { id }),
    create: (settings: SessionSettings) => invoke<Session>("sessions_create", { settings }),
    rename: (id: string, title: string) => invoke<Session>("sessions_rename", { id, title }),
    updateSettings: (id: string, settings: SessionSettings) =>
      invoke<Session>("sessions_update_settings", { id, settings }),
    remove: (id: string) => invoke<void>("sessions_delete", { id }),
  },
  chat: {
    /** Resolves with the session once the user message is saved; the reply streams to `onEvent`. */
    send: (sessionId: string, text: string, images: NewImage[], onEvent: (event: AgentEvent) => void) =>
      invoke<Session>("chat_send", { sessionId, text, images, onEvent: channel(onEvent) }),
    /** Sends `text` to subagent `agent` from its tab, by way of the chat's agent; the reply streams to `onEvent`. */
    sendAgent: (sessionId: string, agent: string, text: string, onEvent: (event: AgentEvent) => void) =>
      invoke<Session>("chat_send_agent", { sessionId, agent, text, onEvent: channel(onEvent) }),
    /** An attached image as a `data:` URL. */
    image: (sessionId: string, image: ImageAttachment) => invoke<string>("chat_image", { sessionId, image }),
    /**
     * Follows a reply this window didn't start (it reloaded mid-reply). Resolves
     * with the reply so far, or `null` if nothing is streaming; later events go to `onEvent`.
     */
    attach: (sessionId: string, onEvent: (event: AgentEvent) => void) =>
      invoke<LiveReply | null>("chat_attach", { sessionId, onEvent: channel(onEvent) }),
    /** Ids of chats with a reply in flight. */
    running: () => invoke<string[]>("chat_running"),
    stop: (sessionId: string) => invoke<void>("chat_stop", { sessionId }),
    permission: (sessionId: string, requestId: string, decision: PermissionDecision) =>
      invoke<void>("chat_permission", { sessionId, requestId, decision }),
    /** `answers` maps question text to the chosen answer; `null` skips the question. */
    answer: (sessionId: string, requestId: string, answers: Record<string, string> | null) =>
      invoke<void>("chat_answer", { sessionId, requestId, answers }),
  },
  contexts: {
    /**
     * Saves the chat, its agent's whole transcript and terminals included, for other chats to
     * reference as `#id`. An unchanged chat returns the context saved before.
     */
    save: (sessionId: string) => invoke<ContextSummary>("contexts_save", { sessionId }),
    /** Newest first; `query` matches ids and titles. */
    list: (query?: string) => invoke<ContextSummary[]>("contexts_list", { query: query ?? null }),
    get: (id: string) => invoke<ContextSummary>("contexts_get", { id }),
    rename: (id: string, title: string) => invoke<ContextSummary>("contexts_rename", { id, title }),
    remove: (id: string) => invoke<void>("contexts_delete", { id }),
    /** The whole context as one Markdown document. */
    export: (id: string) => invoke<string>("contexts_export", { id }),
  },
  /** Saved pull requests and issues (`ipc.github.saveItem`), referenced as `%id`. */
  items: {
    /** Newest first; `query` matches ids, titles and `owner/name#number`. */
    list: (query?: string) => invoke<ItemSummary[]>("items_list", { query: query ?? null }),
    remove: (id: string) => invoke<void>("items_delete", { id }),
    /** Markdown, its attachments listed with where they are on disk. */
    export: (id: string) => invoke<string>("items_export", { id }),
  },
  permissions: {
    /** Rules always allowed in the folder at `root`, e.g. `Bash(pnpm test:*)`. */
    list: (root: string) => invoke<string[]>("permissions_list", { root }),
    forget: (root: string, rule: string) => invoke<string[]>("permissions_forget", { root, rule }),
  },
  skills: {
    /** Skills in `~/.claude/skills`, which every chat can load. */
    installed: () => invoke<InstalledSkill[]>("skills_installed"),
    /** Searches skills.sh; an empty query lists popular skills. */
    search: (query: string) => invoke<SkillListing[]>("skills_search", { query }),
    /** Runs `npx skills add`; resolves with the installed skills once it finishes. */
    add: (source: string, skill: string) => invoke<InstalledSkill[]>("skills_add", { source, skill }),
    remove: (id: string) => invoke<InstalledSkill[]>("skills_remove", { id }),
  },
  mcp: {
    /** User-scope servers from `~/.claude.json`. */
    list: () => invoke<McpServer[]>("mcp_list"),
    add: (name: string, config: Record<string, unknown>) => invoke<McpServer[]>("mcp_add", { name, config }),
    remove: (name: string) => invoke<McpServer[]>("mcp_remove", { name }),
  },
  tools: {
    /** Permission rules from `~/.claude/settings.json`. */
    rules: () => invoke<PermissionRules>("tools_rules"),
    /** Moves `rules` to `behavior`'s list; `null` removes them so the default applies. */
    set: (rules: string[], behavior: RuleBehavior | null) => invoke<PermissionRules>("tools_set", { rules, behavior }),
  },
  instructions: {
    /** The CLAUDE.md files every chat in the open folder reads, missing ones included. */
    list: () => invoke<InstructionFile[]>("instructions_list"),
    /** Fails without writing if the file no longer holds `expected` (`null`: doesn't exist). */
    save: (path: string, content: string, expected: string | null) =>
      invoke<InstructionFile[]>("instructions_save", { path, content, expected }),
    remove: (path: string, expected: string) => invoke<InstructionFile[]>("instructions_delete", { path, expected }),
  },
  terminal: {
    /** Starts the user's shell in the open folder (or home) and returns its id. */
    open: (cols: number, rows: number) => invoke<number>("terminal_open", { cols, rows }),
    /**
     * Follows a terminal: its scrollback, then new output, as raw bytes; then
     * `onExit` with the exit code once its process ends, however it ends.
     */
    attach: (id: number, onData: (bytes: Uint8Array) => void, onExit: (code: number | null) => void) => {
      const channel = new Channel<ArrayBuffer | { exit: number | null }>()
      channel.onmessage = (message) =>
        message instanceof ArrayBuffer ? onData(new Uint8Array(message)) : onExit(message.exit)
      return invoke<void>("terminal_attach", { id, onEvent: channel })
    },
    write: (id: number, data: string) => invoke<void>("terminal_write", { id, data }),
    resize: (id: number, cols: number, rows: number) => invoke<void>("terminal_resize", { id, cols, rows }),
    close: (id: number) => invoke<void>("terminal_close", { id }),
    /** Ends the user's shells, including ones a reloaded window left behind. The agent's keep running. */
    closeAll: () => invoke<void>("terminal_close_all"),
    /** The terminals agents have started that are still open. */
    agentList: () => invoke<AgentTerminal[]>("terminal_agent_list"),
    /** The agent in a chat started a terminal; its tab should open. */
    onAgentOpened: (handler: (terminal: AgentTerminal) => void): Promise<UnlistenFn> =>
      listen<AgentTerminal>("terminal://agent-opened", (event) => handler(event.payload)),
  },
  /** Runs the native Copy, Cut or Paste, as if chosen from the Edit menu (macOS only). */
  editAction: (action: "copy" | "cut" | "paste") => invoke<void>("edit_action", { action }),
  dialog: {
    pickImage: async () => {
      const picked = await open({
        multiple: false,
        title: "Choose a logo",
        filters: [{ name: "Images", extensions: ["svg", "png", "ico", "jpg", "jpeg", "webp", "gif"] }],
      })
      return typeof picked === "string" ? picked : null
    },
    pickFolder: async (title = "Open folder") => {
      const picked = await open({ directory: true, multiple: false, title })
      return typeof picked === "string" ? picked : null
    },
    confirm: (message: string, title: string, okLabel = "Delete") =>
      ask(message, { title, kind: "warning", okLabel }),
  },
}

/** A terminal the agent's `terminal-access` tool started in a chat. */
export interface AgentTerminal {
  id: number
  sessionId: string
  title: string
}

/** An image to attach, base64-encoded. */
export interface NewImage {
  mediaType: string
  name: string
  data: string
}

function channel(onEvent: (event: AgentEvent) => void): Channel<AgentEvent> {
  const channel = new Channel<AgentEvent>()
  channel.onmessage = onEvent
  return channel
}

/** A channel for git's progress lines; a no-op one when nobody is listening. */
function lines(onLine?: (line: string) => void): Channel<string> {
  const channel = new Channel<string>()
  if (onLine) channel.onmessage = onLine
  return channel
}

function setupChannel(onEvent: (event: SetupEvent) => void): Channel<SetupEvent> {
  const channel = new Channel<SetupEvent>()
  channel.onmessage = onEvent
  return channel
}

/** Tauri rejects with the Rust error's message string; `gh` errors lose their `gh:<kind>: ` tag. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string") return error.replace(/^gh:[a-z-]+: /, "")
  return error instanceof Error ? error.message : "Something went wrong"
}
