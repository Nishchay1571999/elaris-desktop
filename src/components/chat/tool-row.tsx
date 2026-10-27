import { Check, ChevronRight, LoaderCircle, Maximize2, X } from "lucide-react"
import { useState } from "react"

import { cn } from "@/lib/utils"

import { type ToolPart, toolLabel } from "./activity"
import { ToolDetail } from "./tool-detail"

/** One tool call; click to see what it did, inline or (with `onOpen`) full page. */
export function ToolRow({ part, onOpen }: { part: ToolPart; onOpen?: () => void }) {
  const failed = part.status === "failed"
  const [open, setOpen] = useState(false)
  const hasDetail = Object.keys(part.input ?? {}).length > 0 || !!part.output

  return (
    <div className="rounded-lg border border-border bg-surface-sunken text-xs">
      <button
        type="button"
        aria-expanded={onOpen ? undefined : open}
        disabled={!hasDetail}
        onClick={() => (onOpen ? onOpen() : setOpen((o) => !o))}
        className="flex w-full min-w-0 items-center gap-2 rounded-lg px-2.5 py-1.5 text-left outline-none enabled:hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {part.status === "running" ? (
          <LoaderCircle aria-label="Running" className="size-3.5 shrink-0 animate-spin text-brand" />
        ) : part.status === "done" ? (
          <Check aria-label="Done" className="size-3.5 shrink-0 text-git-added" />
        ) : (
          <X aria-label="Failed" className="size-3.5 shrink-0 text-destructive" />
        )}
        <span className="shrink-0 font-medium">{toolLabel(part.name)}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px] text-muted-foreground" title={part.summary}>
          {part.summary}
        </span>
        {hasDetail && onOpen ? (
          <Maximize2 aria-label="Open full page" className="size-3 shrink-0 text-subtle-foreground" />
        ) : hasDetail && (
          <ChevronRight className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", open && "rotate-90")} />
        )}
      </button>
      {open && !onOpen && (
        <div className="flex flex-col gap-2 border-t border-border p-2">
          <ToolDetail name={part.name} input={part.input} output={part.output} failed={failed} />
        </div>
      )}
    </div>
  )
}
