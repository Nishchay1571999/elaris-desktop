import { X } from "lucide-react"
import { useState } from "react"

import { cn } from "@/lib/utils"

import { type ToolPart, toolAction, toolEntryLabel, workSummary } from "./activity"
import { ToolRow } from "./tool-row"
import { ToolIcon, WorkLogButton } from "./work-log"

/**
 * A run of tool calls folded into one line, as T3 Code does it: the call that
 * is running while it works ("pnpm test", shimmering), then "Ran 3 commands,
 * read 2 files" once it's done. Click to list every call.
 */
export function WorkGroup({ parts }: { parts: ToolPart[] }) {
  const [open, setOpen] = useState(false)
  const live = parts.findLast((p) => p.status === "running")
  const failed = parts.some((p) => p.status === "failed")
  const summary = workSummary(parts)
  const label = live ? toolEntryLabel(live) : summary.label

  return (
    <div>
      <WorkLogButton
        aria-label={failed ? `${label}, tool call failed` : label}
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        icon={
          <ToolIcon
            action={live ? toolAction(live) : summary.action}
            className={cn("size-4 shrink-0 stroke-2", live ? "text-foreground" : "text-subtle-foreground")}
          />
        }
        label={<span className={cn("block truncate", live && "live-tool-shine")}>{label}</span>}
        trailing={failed && !live && <X aria-hidden className="size-3 shrink-0 text-destructive/60" />}
      />
      {open && (
        <div
          role="region"
          aria-label="Tool calls"
          className="scrollbar-hidden flex max-h-[min(18rem,50dvh)] min-w-0 flex-col overflow-y-auto"
        >
          {parts.map((part) => (
            <ToolRow key={part.id} part={part} />
          ))}
        </div>
      )}
    </div>
  )
}
