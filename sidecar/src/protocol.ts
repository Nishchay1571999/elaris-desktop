/**
 * The stdio protocol between the Rust host (`crates/agent-core/src/claude.rs`)
 * and this sidecar: one JSON object per line in each direction. stdout carries
 * only these messages; diagnostics go to stderr.
 *
 * `AgentEvent` matches the Rust enum in `crates/agent-protocol`; serde rejects
 * anything else, so keep the two in step.
 */

export interface TokenUsage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export type AgentEvent =
  | { type: "text-delta"; delta: string }
  | { type: "tool-start"; id: string; name: string; summary: string; input: Record<string, unknown> }
  | { type: "tool-end"; id: string; ok: boolean; output: string | null }
  | {
      type: "permission-request"
      requestId: string
      toolName: string
      summary: string
      input: Record<string, unknown>
      /** Rules "always allow" would save for the project; null hides the option. */
      always: string[] | null
    }
  | { type: "permission-resolved"; requestId: string; allowed: boolean }
  | { type: "question"; requestId: string; questions: Question[] }
  | { type: "question-resolved"; requestId: string }
  /**
   * Tokens used since the last `usage` event. `context` is the prompt size of the main
   * agent's latest model call (how full its context window is); subagents leave it out.
   */
  | { type: "usage"; usage: TokenUsage; context?: number }
  /** The agent entered plan mode, or left it once the plan was approved. */
  | { type: "mode"; mode: AgentMode }
  /** A subagent started or was resumed; `agent` is the SDK's id for it, the same on every run. */
  | { type: "subagent-start"; agent: string; toolId: string | null; description: string }
  /** A subagent's `text-delta`, `tool-start` or `tool-end`. */
  | { type: "subagent"; agent: string; event: AgentEvent }
  | { type: "subagent-end"; agent: string; status: SubagentStatus }
  | { type: "finish" }
  | { type: "stopped" }
  | { type: "error"; message: string }

export type SubagentStatus = "running" | "completed" | "failed" | "stopped"

export interface Question {
  question: string
  header: string
  multiSelect: boolean
  options: { label: string; description: string }[]
}

export type AgentMode = "agent" | "ask" | "plan"
export type PermissionPolicy = "ask" | "accept-edits" | "auto" | "bypass"
export type PermissionDecision = "allow" | "always" | "deny"
/** Answer text by question text; several choices are joined with ", ". */
export type Answers = Record<string, string>

/** A call to the `terminal-access` tool, carried out by the host (`apps/desktop/src-tauri/src/agent_terminal.rs`). */
export type TerminalRequest =
  | { action: "run"; command: string; background?: boolean; title?: string; waitSeconds?: number }
  | { action: "read"; terminalId: number; waitSeconds?: number }
  | { action: "write"; terminalId: number; input: string }
  | { action: "stop"; terminalId: number }
  | { action: "list" }

/** A call to the `desktop-control` tool, carried out by the host (`apps/desktop/src-tauri/src/agent_desktop.rs`). */
export type DesktopRequest =
  | { action: "screenshot" }
  | { action: "click"; x: number; y: number; button?: "left" | "right" | "middle"; count?: number }
  | { action: "move"; x: number; y: number }
  | { action: "drag"; fromX: number; fromY: number; toX: number; toY: number }
  | { action: "scroll"; x: number; y: number; direction: "up" | "down" | "left" | "right"; amount?: number }
  | { action: "type"; text: string }
  | { action: "key"; keys: string }
  | { action: "open"; target: string }

/**
 * A call to the `device-control` tool, carried out by the host
 * (`apps/desktop/src-tauri/src/agent_device.rs`). The host passes it to the
 * `device-control` crate as JSON, so this must match its `Request` and `Step`.
 */
export type DeviceRequest =
  | { action: "devices" }
  | { action: "boot"; name: string }
  | {
      action: "app"
      op: "list" | "launch" | "stop" | "restart" | "install" | "uninstall" | "clear" | "info"
      app?: string
      path?: string
      device?: string
    }
  | { action: "screen"; image?: boolean; maxElements?: number; device?: string }
  | {
      action: "act"
      steps: ({ do: string } & Record<string, unknown>)[]
      observe?: "elements" | "image" | "none"
      maxElements?: number
      device?: string
    }
  | {
      action: "logs"
      app?: string
      grep?: string
      since?: number
      lines?: number
      level?: "verbose" | "debug" | "info" | "warn" | "error"
      device?: string
    }
  | { action: "appData"; op: "ls" | "read" | "sql"; path?: string; query?: string; grep?: string; app?: string; device?: string }

/** A call to the `elaris-context` tool, carried out by the host (`apps/desktop/src-tauri/src/agent_contexts.rs`). */
export type ContextsRequest =
  | { action: "list"; query?: string }
  | { action: "overview"; id: string }
  | { action: "read"; id: string; fromSeq?: number; offset?: number; maxChars?: number }
  | { action: "search"; query: string; id?: string; limit?: number }
  | { action: "raw"; id: string; seq: number }
  | { action: "terminals"; id: string }

/** Host → sidecar. */
export type Command =
  | {
      type: "run"
      runId: string
      prompt: string
      cwd: string
      model: string
      mode: AgentMode
      permissions: PermissionPolicy
      /** The agent session to continue, if any. */
      resume: string | null
      /** Permission rules saved for this workspace, e.g. `Bash(pnpm test:*)`. */
      allowedTools: string[]
      /** Images attached to the prompt, as files to read. */
      images?: { mediaType: string; path: string }[]
    }
  | { type: "interrupt"; runId: string }
  /** The user changed the chat's settings while it runs. */
  | { type: "settings"; runId: string; mode: AgentMode; model: string; permissions: PermissionPolicy }
  | { type: "permission"; runId: string; requestId: string; decision: PermissionDecision }
  /** `answers` is null when the user skipped the question. */
  | { type: "answer"; runId: string; requestId: string; answers: Answers | null }
  /** The tokens an agent session has used; `runId` only routes the reply. */
  | { type: "usage"; runId: string; agentSessionId: string }
  /** Answers a `terminal` request with the text the tool call returns. */
  | { type: "terminalResult"; runId: string; requestId: string; ok: boolean; text: string }
  /** Answers a `desktop` request; `image` is a base64 screenshot. */
  | {
      type: "desktopResult"
      runId: string
      requestId: string
      ok: boolean
      text: string
      image: { mediaType: string; data: string } | null
    }
  /** Answers a `device` request; `image` is a base64 screenshot. */
  | {
      type: "deviceResult"
      runId: string
      requestId: string
      ok: boolean
      text: string
      image: { mediaType: string; data: string } | null
    }
  /** Answers a `contexts` request with the text the tool call returns. */
  | { type: "contextsResult"; runId: string; requestId: string; ok: boolean; text: string }

/** Sidecar → host. */
export type Reply =
  | { type: "event"; runId: string; event: AgentEvent }
  /** The SDK's session id for this run, to pass back as `resume` next time. */
  | { type: "session"; runId: string; agentSessionId: string }
  /** The user chose "always allow"; the host saves these rules for the workspace. */
  | { type: "rules"; runId: string; rules: string[] }
  /** The run is over; no more messages for this `runId`. */
  | { type: "done"; runId: string }
  /** Answers `usage`; null when the session's transcript isn't on this machine. */
  | { type: "usage"; runId: string; usage: TokenUsage | null }
  /** The agent called `terminal-access`; the host answers with `terminalResult`. */
  | { type: "terminal"; runId: string; requestId: string; request: TerminalRequest }
  /** The agent called `desktop-control`; the host answers with `desktopResult`. */
  | { type: "desktop"; runId: string; requestId: string; request: DesktopRequest }
  /** The agent called `device-control`; the host answers with `deviceResult`. */
  | { type: "device"; runId: string; requestId: string; request: DeviceRequest }
  /** The agent called `elaris-context`; the host answers with `contextsResult`. */
  | { type: "contexts"; runId: string; requestId: string; request: ContextsRequest }

export function send(reply: Reply) {
  process.stdout.write(`${JSON.stringify(reply)}\n`)
}

export function log(message: string) {
  process.stderr.write(`[sidecar] ${message.trimEnd()}\n`)
}
