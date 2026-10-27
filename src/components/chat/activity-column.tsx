import { FileSearch } from "lucide-react"
import { useState } from "react"

import type { Message } from "@/bindings/Message"
import { useFollowBottom } from "@/hooks/use-follow-bottom"
import { cn } from "@/lib/utils"
import { useUi } from "@/stores/ui"

import { type Lane, laneOf, TERMINAL_TOOLS, terminalOf, type ToolPart } from "./activity"
import { HEADER } from "./chat-header"
import { ToolRow } from "./tool-row"

/** The right column's tabs, each a set of tool names. Write comes first and is shown by default. */
const ACTION_TABS = [
  { id: "write", label: "Write", tools: ["Write"], empty: "New files the agent writes show up here." },
  { id: "edit", label: "Edit", tools: ["Edit", "MultiEdit", "NotebookEdit"], empty: "Edits to existing files show up here." },
  {
    id: "bash",
    label: "Terminal",
    tools: ["Bash", ...TERMINAL_TOOLS],
    empty: "Commands and scripts the agent runs show up here.",
  },
] as const

type ActionTab = (typeof ACTION_TABS)[number]["id"]

/** One side of the chat: the tool calls in a lane, grouped under the prompt that led to them. */
export function ActivityColumn({ sessionId, lane, messages }: { sessionId: string; lane: Lane; messages: Message[] }) {
  const [tab, setTab] = useState<ActionTab>("write")
  const openToolTab = useUi((s) => s.openToolTab)
  const showAgentTerminal = useUi((s) => s.showAgentTerminal)
  const scroller = useFollowBottom<HTMLDivElement>([messages, tab])

  const all = toolsInLane(messages, lane)
  const current = ACTION_TABS.find((t) => t.id === tab)!
  const shown = lane === "actions" ? all.filter(({ part }) => (current.tools as readonly string[]).includes(part.name)) : all
  const empty = lane === "actions" ? current.empty : "Files and searches the agent looks at show up here."

  // Writes and edits open full page; terminal calls open their terminal's tab; other commands expand in place.
  const opener = (part: ToolPart) => {
    if (part.name === "Bash") return undefined
    if (TERMINAL_TOOLS.includes(part.name)) {
      const terminal = terminalOf(part)
      return terminal === null ? undefined : () => void showAgentTerminal(sessionId, terminal, part.summary, true)
    }
    return () => openToolTab(sessionId, part.id)
  }

  return (
    <aside aria-label={lane === "reads" ? "Read" : "Wrote & ran"} className="flex min-h-0 flex-col">
      {lane === "reads" ? (
        <h2 className={cn(HEADER, "gap-1.5 px-4 text-[11px] font-medium tracking-wide text-subtle-foreground uppercase")}>
          <FileSearch className="size-3.5" />
          Read
        </h2>
      ) : (
        <div role="tablist" aria-label="Tool calls" className={cn(HEADER, "gap-1 px-3")}>
          {ACTION_TABS.map(({ id, label, tools }) => {
            const inTab = all.filter(({ part }) => (tools as readonly string[]).includes(part.name))
            const running = inTab.some(({ part }) => part.status === "running")
            return (
              <button
                key={id}
                type="button"
                role="tab"
                aria-selected={tab === id}
                onClick={() => setTab(id)}
                className={cn(
                  "flex h-6 items-center gap-1.5 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
                  tab === id && "bg-muted font-medium text-foreground",
                )}
              >
                {label}
                {inTab.length > 0 && <span className="text-[11px] text-subtle-foreground tabular-nums">{inTab.length}</span>}
                {running && <span aria-label="Running" className="size-1.5 animate-pulse rounded-full bg-brand" />}
              </button>
            )
          })}
        </div>
      )}
      <div ref={scroller} role={lane === "actions" ? "tabpanel" : undefined} className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto px-3 pb-6">
        {shown.length === 0 ? (
          <p className="px-1 text-xs text-subtle-foreground">{empty}</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {groupByTurn(shown).map(({ id, prompt, tools }) => (
              <li key={id} className="flex flex-col gap-1.5">
                {prompt && (
                  <p className="truncate px-1 text-[11px] text-subtle-foreground" title={prompt}>
                    {prompt}
                  </p>
                )}
                {tools.map((part) => (
                  <div key={part.id} className="animate-message-in">
                    <ToolRow part={part} onOpen={opener(part)} />
                  </div>
                ))}
              </li>
            ))}
          </ol>
        )}
      </div>
    </aside>
  )
}

interface Entry {
  part: ToolPart
  /** The assistant message the call belongs to. */
  turn: string
  /** The user message that started that turn. */
  prompt: string | null
}

function toolsInLane(messages: Message[], lane: Lane): Entry[] {
  const entries: Entry[] = []
  let prompt: string | null = null
  for (const message of messages) {
    if (message.role === "user") {
      prompt = message.content
      continue
    }
    for (const part of message.parts) {
      if (part.type === "tool" && laneOf(part) === lane) entries.push({ part, turn: message.id, prompt })
    }
  }
  return entries
}

function groupByTurn(entries: Entry[]) {
  const turns: Array<{ id: string; prompt: string | null; tools: ToolPart[] }> = []
  for (const { part, turn, prompt } of entries) {
    const last = turns.at(-1)
    if (last?.id === turn) last.tools.push(part)
    else turns.push({ id: turn, prompt, tools: [part] })
  }
  return turns
}
