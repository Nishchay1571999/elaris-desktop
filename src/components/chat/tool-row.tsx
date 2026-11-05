import { ChevronRight, Maximize2, X } from "lucide-react"
import { type KeyboardEvent, useState } from "react"

import { cn } from "@/lib/utils"

import { type ToolPart, toolAction, toolEntryLabel } from "./activity"
import { ToolDetail } from "./tool-detail"
import { ToolIcon, WorkLogDetails, WorkLogRow } from "./work-log"

/**
 * One tool call as a work-log line: its icon, the command or file, a chevron.
 * Click to see what it did, inline or (with `onOpen`) full page.
 */
export function ToolRow({ part, onOpen }: { part: ToolPart; onOpen?: () => void }) {
  const failed = part.status === "failed"
  const running = part.status === "running"
  const [open, setOpen] = useState(false)
  const hasDetail = Object.keys(part.input ?? {}).length > 0 || !!part.output
  const label = toolEntryLabel(part)
  const toggle = () => (onOpen ? onOpen() : setOpen((o) => !o))

  return (
    <WorkLogRow
      {...(hasDetail && {
        role: "button",
        tabIndex: 0,
        "aria-label": failed ? `${label}, tool call failed` : label,
        "aria-expanded": onOpen ? undefined : open,
        onClick: toggle,
        onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault()
            toggle()
          }
        },
      })}
      title={part.summary || undefined}
      icon={
        <ToolIcon
          action={toolAction(part)}
          className={cn("size-4 shrink-0 stroke-2", failed ? "text-destructive/60" : "text-subtle-foreground")}
        />
      }
      label={<span className={cn("block truncate", running && "live-tool-shine")}>{label}</span>}
      trailing={
        <>
          {failed && <X aria-hidden className="size-3 shrink-0 text-destructive/60" />}
          <span className={cn("flex size-4 shrink-0 items-center justify-center", !hasDetail && "invisible")} aria-hidden>
            {onOpen ? (
              <Maximize2 className="size-3 text-subtle-foreground opacity-0 transition-opacity group-hover/timeline-row:opacity-100" />
            ) : (
              <ChevronRight
                className={cn(
                  "size-3 text-subtle-foreground opacity-70 transition-transform duration-200",
                  open && "rotate-90",
                )}
              />
            )}
          </span>
        </>
      }
    >
      {open && !onOpen && (
        <WorkLogDetails>
          <ToolDetail name={part.name} input={part.input} output={part.output} failed={failed} />
        </WorkLogDetails>
      )}
    </WorkLogRow>
  )
}
