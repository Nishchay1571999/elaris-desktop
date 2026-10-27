import type { Part } from "@/bindings/Part"

export type ToolPart = Extract<Part, { type: "tool" }>

/** Which side of the chat a tool call is shown on: what the agent took in, or what it did. */
export type Lane = "reads" | "actions"

const READ_TOOLS = new Set(["Read", "Grep", "Glob", "LS", "NotebookRead", "WebFetch", "WebSearch"])
const ACTION_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit", "Bash"])

/** Elaris's own `terminal-access` tool, which runs commands in terminal tabs. */
const TERMINAL_PREFIX = "mcp__terminal-access__"
export const TERMINAL_TOOLS = ["run", "read", "write", "stop", "list"].map((action) => `${TERMINAL_PREFIX}${action}`)

/** A tool's name as people read it: "Terminal run" rather than `mcp__terminal-access__run`. */
export function toolLabel(name: string): string {
  return name.startsWith(TERMINAL_PREFIX) ? `Terminal ${name.slice(TERMINAL_PREFIX.length)}` : name
}

/** The terminal a `terminal-access` call ran in or acted on, if any. */
export function terminalOf(part: ToolPart): number | null {
  if (!part.name.startsWith(TERMINAL_PREFIX)) return null
  if (typeof part.input?.terminalId === "number") return part.input.terminalId
  // `run` reports the terminal it started on its first line.
  const match = part.output?.match(/^Terminal (\d+)/)
  return match ? Number(match[1]) : null
}

// Shell commands that only look at files (plus `touch`, which the user wants with them).
const READ_COMMANDS = new Set([
  "cat", "head", "tail", "less", "more", "bat", "ls", "tree", "find", "fd", "grep", "rg", "ag",
  "wc", "stat", "file", "du", "pwd", "which", "touch", "cd", "jq",
])
const READ_GIT = new Set(["status", "log", "diff", "show", "blame", "branch"])

/** The lane for a tool call, or null to keep it inline in the transcript. */
export function laneOf(part: ToolPart): Lane | null {
  if (READ_TOOLS.has(part.name)) return "reads"
  if (part.name === "Bash") {
    const command = typeof part.input?.command === "string" ? part.input.command : ""
    return isReadCommand(command) ? "reads" : "actions"
  }
  return ACTION_TOOLS.has(part.name) || part.name.startsWith(TERMINAL_PREFIX) ? "actions" : null
}

/** True when every step of a shell pipeline only reads, e.g. `cd src && cat a.ts | head`. */
function isReadCommand(command: string): boolean {
  // `cat > file` writes; discarding output (`2>&1`, `>/dev/null`) doesn't.
  if (command.replace(/\d*>&\d|[&\d]*>+\s*\/dev\/null/g, "").includes(">")) return false
  const steps = command.split(/&&|\|\||[;|\n]/).map((s) => s.trim()).filter(Boolean)
  return (
    steps.length > 0 &&
    steps.every((step) => {
      const words = step.split(/\s+/).filter((w) => !/^\w+=/.test(w))
      const [head, sub] = words
      if (head === "git") return READ_GIT.has(sub ?? "")
      if (head === "sed") return words.includes("-n") && !words.some((w) => w.startsWith("-i"))
      return READ_COMMANDS.has(head ?? "")
    })
  )
}
