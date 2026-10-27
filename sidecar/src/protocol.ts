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
  /** Tokens used since the last `usage` event. */
  | { type: "usage"; usage: TokenUsage }
  | { type: "finish" }
  | { type: "stopped" }
  | { type: "error"; message: string }

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
  | { type: "permission"; runId: string; requestId: string; decision: PermissionDecision }
  /** `answers` is null when the user skipped the question. */
  | { type: "answer"; runId: string; requestId: string; answers: Answers | null }
  /** The tokens an agent session has used; `runId` only routes the reply. */
  | { type: "usage"; runId: string; agentSessionId: string }
  /** Answers a `terminal` request with the text the tool call returns. */
  | { type: "terminalResult"; runId: string; requestId: string; ok: boolean; text: string }

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

export function send(reply: Reply) {
  process.stdout.write(`${JSON.stringify(reply)}\n`)
}

export function log(message: string) {
  process.stderr.write(`[sidecar] ${message.trimEnd()}\n`)
}
