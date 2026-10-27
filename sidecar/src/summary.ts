import { relative } from "node:path"

const MAX = 120

/** A one-line description of a tool call for the chat transcript. */
export function summarize(toolName: string, input: Record<string, unknown>, cwd: string): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)
  const path = (key: string) => {
    const value = str(key)
    if (!value) return undefined
    const rel = relative(cwd, value)
    return rel && !rel.startsWith("..") ? rel : value
  }

  const describe: Record<string, () => string | undefined> = {
    Read: () => path("file_path"),
    Edit: () => path("file_path"),
    MultiEdit: () => path("file_path"),
    Write: () => path("file_path"),
    NotebookEdit: () => path("notebook_path"),
    Bash: () => str("command"),
    Glob: () => str("pattern"),
    Grep: () => str("pattern"),
    WebFetch: () => str("url"),
    WebSearch: () => str("query"),
    Task: () => str("description"),
    Agent: () => str("description"),
    TodoWrite: () => "Updated the task list",
    "mcp__terminal-access__run": () => str("command"),
    "mcp__terminal-access__read": () => `Terminal ${input.terminalId}`,
    "mcp__terminal-access__write": () => `Terminal ${input.terminalId}: ${JSON.stringify(input.input ?? "")}`,
    "mcp__terminal-access__stop": () => `Terminal ${input.terminalId}`,
    "mcp__terminal-access__list": () => "Open terminals",
    AskUserQuestion: () => {
      const questions = Array.isArray(input.questions) ? (input.questions as { question?: unknown }[]) : []
      return questions.map((q) => String(q.question ?? "")).join(" · ")
    },
  }
  const text = describe[toolName]?.() ?? Object.values(input).find((v): v is string => typeof v === "string")

  const oneLine = (text ?? "").replace(/\s+/g, " ").trim()
  return oneLine.length > MAX ? `${oneLine.slice(0, MAX - 1)}…` : oneLine
}
