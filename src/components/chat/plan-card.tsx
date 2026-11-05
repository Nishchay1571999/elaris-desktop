import { Check, ClipboardList, Copy, X } from "lucide-react"
import { useState } from "react"

import { cn } from "@/lib/utils"

import type { ToolPart } from "./activity"
import { Markdown } from "./markdown"

/**
 * The plan the agent proposed in plan mode, shown as a document rather than a
 * tool call. Approving it happens on the prompt docked over the composer.
 */
export function PlanCard({ part }: { part: ToolPart }) {
  const plan = typeof part.input?.plan === "string" ? part.input.plan : ""
  const [copied, setCopied] = useState(false)
  const status =
    part.status === "running" ? "Waiting for approval" : part.status === "done" ? "Approved" : "Not approved"

  const copy = () => {
    void navigator.clipboard.writeText(plan).then(() => {
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    })
  }

  return (
    <section aria-label="Proposed plan" className="overflow-hidden rounded-xl border border-border-strong bg-surface-elevated">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2 text-xs">
        <ClipboardList className="size-3.5 text-brand" />
        <span className="font-medium">Plan</span>
        <span
          className={cn(
            "flex items-center gap-1 text-muted-foreground",
            part.status === "done" && "text-git-added",
            part.status === "failed" && "text-subtle-foreground",
          )}
        >
          {part.status === "done" && <Check className="size-3" />}
          {part.status === "failed" && <X className="size-3" />}
          {status}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          onClick={copy}
          disabled={!plan}
          className="flex h-6 items-center gap-1 rounded-md px-1.5 text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </header>
      <div className="scrollbar-hidden max-h-[28rem] overflow-y-auto px-5 py-4">
        <Markdown text={plan || "_The plan was empty._"} />
      </div>
    </section>
  )
}
