/**
 * Typed wrappers around the Rust commands in `src-tauri/src/commands`. This is
 * the only module that talks to Tauri; everything else imports from here.
 * Types come from `src/bindings`, generated from the Rust structs.
 */
import { Channel, invoke } from "@tauri-apps/api/core"
import { listen, type UnlistenFn } from "@tauri-apps/api/event"
import { ask, open } from "@tauri-apps/plugin-dialog"

import type { AgentEvent } from "@/bindings/AgentEvent"
import type { ChangedFile } from "@/bindings/ChangedFile"
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

export const ipc = {
  workspace: {
    open: (path: string) => invoke<WorkspaceInfo>("workspace_open", { path }),
    current: () => invoke<WorkspaceInfo | null>("workspace_current"),
    recent: () => invoke<string[]>("workspace_recent"),
    listDir: (path: string) => invoke<FileEntry[]>("workspace_list_dir", { path }),
    readFile: (path: string) => invoke<FilePreview>("workspace_read_file", { path }),
    /** Debounced batches of changed workspace-relative paths. */
    onChanged: (handler: (paths: string[]) => void): Promise<UnlistenFn> =>
      listen<{ paths: string[] }>("workspace://changed", (event) => handler(event.payload.paths)),
  },
  git: {
    status: () => invoke<ChangedFile[]>("git_status"),
    diff: (path: string) => invoke<string>("git_diff", { path }),
  },
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
    pickFolder: async () => {
      const picked = await open({ directory: true, multiple: false, title: "Open folder" })
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

/** Tauri rejects with the Rust error's message string. */
export function errorMessage(error: unknown): string {
  return typeof error === "string" ? error : error instanceof Error ? error.message : "Something went wrong"
}
