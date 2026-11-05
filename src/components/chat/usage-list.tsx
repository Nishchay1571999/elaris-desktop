import { ChevronRight, LoaderCircle } from "lucide-react"
import { useState } from "react"

import { cn } from "@/lib/utils"

import type { ToolPart } from "./activity"
import { ToolRow } from "./tool-row"

/** One MCP server or tool, with every call made to it. */
export interface UsageGroup {
  id: string
  label: string
  calls: ToolPart[]
  /** Per-tool counts shown under the label, e.g. an MCP server's tools. */
  breakdown?: Array<{ label: string; count: number }>
}

/** What the agent used, most-called first; each entry expands to its calls. */
export function UsageList({ groups, opener }: { groups: UsageGroup[]; opener: (part: ToolPart) => (() => void) | undefined }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {groups.map((group) => (
        <li key={group.id} className="animate-message-in">
          <UsageRow group={group} opener={opener} />
        </li>
      ))}
    </ul>
  )
}

function UsageRow({ group, opener }: { group: UsageGroup; opener: (part: ToolPart) => (() => void) | undefined }) {
  const [open, setOpen] = useState(false)
  const running = group.calls.some((part) => part.status === "running")
  const failed = group.calls.filter((part) => part.status === "failed").length

  return (
    <div className="rounded-lg border border-border bg-surface-sunken text-xs">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-1.5 text-left outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <span className="flex w-full min-w-0 items-center gap-2">
          <ChevronRight className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", open && "rotate-90")} />
          <span className="min-w-0 flex-1 truncate font-medium" title={group.label}>
            {group.label}
          </span>
          {running && <LoaderCircle aria-label="Running" className="size-3.5 shrink-0 animate-spin text-brand" />}
          {failed > 0 && <span className="shrink-0 text-[11px] text-destructive tabular-nums">{failed} failed</span>}
          <span className="shrink-0 text-[11px] text-subtle-foreground tabular-nums">×{group.calls.length}</span>
        </span>
        {group.breakdown && (
          <span className="truncate pl-5.5 font-mono text-[11px] text-muted-foreground">
            {group.breakdown.map(({ label, count }) => `${label} ×${count}`).join(" · ")}
          </span>
        )}
      </button>
      {open && (
        <div className="flex flex-col gap-1.5 border-t border-border p-2">
          {group.calls.map((part) => (
            <ToolRow key={part.id} part={part} onOpen={opener(part)} />
          ))}
        </div>
      )}
    </div>
  )
}
