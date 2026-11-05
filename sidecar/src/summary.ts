import { relative } from "node:path"

const MAX = 120

/** A one-line description of a tool call for the chat transcript. */
export function summarize(toolName: string, input: Record<string, unknown>, cwd: string): string {
  const str = (key: string) => (typeof input[key] === "string" ? (input[key] as string) : undefined)
  const point = (x: string, y: string) => `(${input[x]}, ${input[y]})`
  const context = () => `#${(str("id") ?? "").replace(/^#/, "")}`
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
    "mcp__elaris-context__list": () => str("query") ?? "Saved contexts",
    "mcp__elaris-context__overview": () => context(),
    "mcp__elaris-context__read": () => `${context()} from entry ${input.fromSeq ?? 0}`,
    "mcp__elaris-context__search": () => `${JSON.stringify(input.query ?? "")}${input.id ? ` in ${context()}` : ""}`,
    "mcp__elaris-context__raw": () => `${context()} entry ${input.seq}`,
    "mcp__elaris-context__terminals": () => `${context()} terminals`,
    "mcp__desktop-control__screenshot": () => "Main display",
    "mcp__desktop-control__click": () => {
      const how = { 2: "Double-click", 3: "Triple-click" }[Number(input.count)] ?? "Click"
      const button = input.button && input.button !== "left" ? ` (${input.button})` : ""
      return `${how}${button} at ${point("x", "y")}`
    },
    "mcp__desktop-control__move": () => `Pointer to ${point("x", "y")}`,
    "mcp__desktop-control__drag": () => `${point("fromX", "fromY")} → ${point("toX", "toY")}`,
    "mcp__desktop-control__scroll": () => `${str("direction") ?? "Scroll"} at ${point("x", "y")}`,
    "mcp__desktop-control__type": () => JSON.stringify(input.text ?? ""),
    "mcp__desktop-control__key": () => str("keys"),
    "mcp__desktop-control__open": () => str("target"),
    "mcp__device-control__devices": () => "Emulators and simulators",
    "mcp__device-control__boot": () => str("name"),
    "mcp__device-control__app": () => [str("action"), str("app") ?? str("path")].filter(Boolean).join(" "),
    "mcp__device-control__screen": () => (input.image ? "Screen and screenshot" : "Screen"),
    "mcp__device-control__act": () => {
      const steps = Array.isArray(input.steps) ? (input.steps as Record<string, unknown>[]) : []
      return steps
        .map((s) => {
          const what = s.text ?? s.key ?? s.url ?? s.untilText ?? s.direction ?? (s.element ? `[${s.element}]` : undefined)
          return what === undefined ? String(s.do) : `${s.do} ${typeof what === "string" ? what : String(what)}`
        })
        .join(", ")
    },
    "mcp__device-control__logs": () => [str("app") ?? "App log", str("grep") && `/${str("grep")}/`].filter(Boolean).join(" "),
    "mcp__device-control__app_data": () => [str("action"), str("path"), str("query")].filter(Boolean).join(" "),
    AskUserQuestion: () => {
      const questions = Array.isArray(input.questions) ? (input.questions as { question?: unknown }[]) : []
      return questions.map((q) => String(q.question ?? "")).join(" · ")
    },
  }
  const text = describe[toolName]?.() ?? Object.values(input).find((v): v is string => typeof v === "string")

  const oneLine = (text ?? "").replace(/\s+/g, " ").trim()
  return oneLine.length > MAX ? `${oneLine.slice(0, MAX - 1)}…` : oneLine
}
