import type { Part } from "@/bindings/Part"

export type ToolPart = Extract<Part, { type: "tool" }>

/** The agent hands over a finished plan with this tool; approving it leaves plan mode. */
export const PLAN_TOOL = "ExitPlanMode"

/** Elaris's own `terminal-access` tool, which runs commands in terminal tabs. */
const TERMINAL_PREFIX = "mcp__terminal-access__"
export const TERMINAL_TOOLS = ["run", "read", "write", "stop", "list"].map((action) => `${TERMINAL_PREFIX}${action}`)

/** Elaris's own `desktop-control` tool, which uses the Mac's screen, mouse and keyboard. */
const DESKTOP_PREFIX = "mcp__desktop-control__"
export const DESKTOP_TOOLS = ["screenshot", "click", "move", "drag", "scroll", "type", "key", "open"].map(
  (action) => `${DESKTOP_PREFIX}${action}`,
)

/** Elaris's own `device-control` tool, which drives Android emulators and iOS simulators. */
const DEVICE_PREFIX = "mcp__device-control__"

/** Elaris's own `elaris-context` tool, which reads chats saved as `#ctx-…`. */
const CONTEXT_PREFIX = "mcp__elaris-context__"

/** A tool's name as people read it: "Terminal run" rather than `mcp__terminal-access__run`. */
export function toolLabel(name: string): string {
  if (name.startsWith(TERMINAL_PREFIX)) return `Terminal ${name.slice(TERMINAL_PREFIX.length)}`
  if (name.startsWith(DESKTOP_PREFIX)) return `Desktop ${name.slice(DESKTOP_PREFIX.length)}`
  if (name.startsWith(CONTEXT_PREFIX)) return `Saved chat ${name.slice(CONTEXT_PREFIX.length)}`
  if (name.startsWith(DEVICE_PREFIX)) return `Device ${name.slice(DEVICE_PREFIX.length).replace("_", " ")}`
  return name
}

/** The MCP server and tool behind a call named `mcp__<server>__<tool>`, or null for a built-in tool. */
export function mcpServerOf(name: string): { server: string; tool: string } | null {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  return match ? { server: match[1], tool: match[2] } : null
}

/** The terminal a `terminal-access` call ran in or acted on, if any. */
export function terminalOf(part: ToolPart): number | null {
  if (!part.name.startsWith(TERMINAL_PREFIX)) return null
  if (typeof part.input?.terminalId === "number") return part.input.terminalId
  // `run` reports the terminal it started on its first line.
  const match = part.output?.match(/^Terminal (\d+)/)
  return match ? Number(match[1]) : null
}

/** What a tool call did, as T3 Code groups them: picks its icon and its words in a work group summary. */
export type ToolAction =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "search"
  | "browser"
  | "device"
  | "agent"
  | "todo"
  | "question"
  | "other"

const EDIT_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"])

export function toolAction(part: ToolPart): ToolAction {
  const { name } = part
  if (name === "Read" || name === "NotebookRead" || name.startsWith(CONTEXT_PREFIX)) return "read"
  if (EDIT_TOOLS.has(name)) return "edit"
  if (name === "Bash" || name.startsWith(TERMINAL_PREFIX)) return "command"
  if (name === "Grep" || name === "Glob" || name === "LS") return "code-search"
  if (name === "WebSearch" || name === "WebFetch") return "search"
  if (name.startsWith(DESKTOP_PREFIX)) return "browser"
  if (name.startsWith(DEVICE_PREFIX)) return "device"
  if (name === "Task" || name === "Agent") return "agent"
  if (name === "TodoWrite") return "todo"
  if (name === "AskUserQuestion") return "question"
  return "other"
}

/** The line a tool call shows in the work log: the command itself, "Read src/app.tsx", … */
export function toolEntryLabel(part: ToolPart): string {
  const summary = part.summary.trim()
  switch (toolAction(part)) {
    case "read":
      return part.name.startsWith(CONTEXT_PREFIX) ? `${toolLabel(part.name)} ${summary}`.trim() : `Read ${summary || "file"}`
    case "edit":
      return summary || "Changed a file"
    case "command":
      return part.name === "Bash" || part.name === `${TERMINAL_PREFIX}run` ? summary || "Ran a command" : `${toolLabel(part.name)} ${summary}`.trim()
    case "code-search":
      return part.name === "Glob" ? `Searched files ${summary}` : `Searched ${summary}`
    case "search":
      return part.name === "WebSearch" ? `Searched the web for ${summary}` : `Fetched ${summary}`
    case "todo":
      return "Updated the task list"
    default:
      return summary ? `${toolLabel(part.name)} · ${summary}` : toolLabel(part.name)
  }
}

function actionLabel(action: ToolAction, count: number): string {
  const n = (one: string, many: string) => `${count} ${count === 1 ? one : many}`
  switch (action) {
    case "read":
      return `Read ${n("file", "files")}`
    case "edit":
      return `Changed ${n("file", "files")}`
    case "command":
      return `Ran ${n("command", "commands")}`
    case "code-search":
      return `Searched code ${n("time", "times")}`
    case "search":
      return `Searched the web ${n("time", "times")}`
    case "browser":
      return `Used the desktop ${n("time", "times")}`
    case "device":
      return `Used device controls ${n("time", "times")}`
    case "agent":
      return `Started ${n("agent", "agents")}`
    case "todo":
      return `Updated the task list${count > 1 ? ` ${count} times` : ""}`
    case "question":
      return `Asked ${n("question", "questions")}`
    case "other":
      return `Used ${n("tool", "tools")}`
  }
}

/** What a run of tool calls did, in T3 Code's words: "Ran 3 commands, read 2 files". */
export function workSummary(parts: ToolPart[]): { label: string; action: ToolAction | "mixed" } {
  const groups = new Map<ToolAction, Set<string>>()
  for (const part of parts) {
    const action = toolAction(part)
    // Changing one file twice is still one changed file.
    const key = action === "edit" ? part.summary || part.id : part.id
    groups.set(action, (groups.get(action) ?? new Set()).add(key))
  }
  const labels = [...groups].slice(0, 2).map(([action, keys], i) => {
    const label = actionLabel(action, keys.size)
    return i === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
  })
  const more = groups.size > 2 ? `, +${groups.size - 2} more` : ""
  return { label: labels.join(", ") + more, action: groups.size === 1 ? [...groups.keys()][0] : "mixed" }
}
