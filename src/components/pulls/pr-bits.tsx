import {
  CircleCheck,
  CircleDashed,
  CircleDot,
  CircleSlash,
  CircleX,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
} from "lucide-react"

import { Tooltip } from "@/components/ui/tooltip"
import { avatarUrl, type CheckState, checksSummary, type GhCheck, type GhLabel, type ReviewDecision } from "@/lib/github"
import { cn } from "@/lib/utils"

/** A pull request's state as GitHub draws it: open, draft, merged or closed. */
export function PrStateIcon({ state, isDraft, className }: { state: string; isDraft: boolean; className?: string }) {
  const base = cn("size-4 shrink-0", className)
  if (state === "MERGED") return <GitMerge aria-label="Merged" className={cn(base, "text-[oklch(0.62_0.17_300)]")} />
  if (state === "CLOSED") return <GitPullRequestClosed aria-label="Closed" className={cn(base, "text-git-deleted")} />
  if (isDraft) return <GitPullRequestDraft aria-label="Draft" className={cn(base, "text-muted-foreground")} />
  return <GitPullRequest aria-label="Open" className={cn(base, "text-git-added")} />
}

/**
 * An issue's state as GitHub draws it: open, done, or closed as not planned. Search results
 * carry no reason, so a closed one there reads as done.
 */
export function IssueStateIcon({ state, reason, className }: { state: string; reason?: string | null; className?: string }) {
  const base = cn("size-4 shrink-0", className)
  if (state.toUpperCase() === "OPEN") return <CircleDot aria-label="Open" className={cn(base, "text-git-added")} />
  if (reason === "NOT_PLANNED") return <CircleSlash aria-label="Not planned" className={cn(base, "text-muted-foreground")} />
  return <CircleCheck aria-label="Closed" className={cn(base, "text-[oklch(0.62_0.17_300)]")} />
}

export function IssueStatePill({ state, reason }: { state: string; reason?: string | null }) {
  const open = state === "OPEN"
  const notPlanned = !open && reason === "NOT_PLANNED"
  const tone = open
    ? "bg-git-added/15 text-git-added"
    : notPlanned
      ? "bg-muted text-muted-foreground"
      : "bg-[oklch(0.62_0.17_300/15%)] text-[oklch(0.62_0.17_300)]"
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium", tone)}>
      <IssueStateIcon state={state} reason={reason} className="size-3.5 text-current" />
      {open ? "Open" : notPlanned ? "Not planned" : "Closed"}
    </span>
  )
}

export function prStateLabel(state: string, isDraft: boolean) {
  return state === "MERGED" ? "Merged" : state === "CLOSED" ? "Closed" : isDraft ? "Draft" : "Open"
}

export function StatePill({ state, isDraft }: { state: string; isDraft: boolean }) {
  const tone =
    state === "MERGED"
      ? "bg-[oklch(0.62_0.17_300/15%)] text-[oklch(0.62_0.17_300)]"
      : state === "CLOSED"
        ? "bg-git-deleted/15 text-git-deleted"
        : isDraft
          ? "bg-muted text-muted-foreground"
          : "bg-git-added/15 text-git-added"
  return (
    <span className={cn("inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium", tone)}>
      <PrStateIcon state={state} isDraft={isDraft} className="size-3.5 text-current" />
      {prStateLabel(state, isDraft)}
    </span>
  )
}

const CHECK_TONE: Record<CheckState, string> = {
  pass: "text-git-added",
  fail: "text-git-deleted",
  pending: "text-git-modified",
  none: "text-subtle-foreground",
}

export function CheckIcon({ state, className }: { state: CheckState; className?: string }) {
  const cls = cn("size-3.5 shrink-0", CHECK_TONE[state], className)
  if (state === "pass") return <CircleCheck className={cls} />
  if (state === "fail") return <CircleX className={cls} />
  return <CircleDashed className={cn(cls, state === "pending" && "animate-[spin_3s_linear_infinite]")} />
}

/** The checks rolled up into one icon, with a count. */
export function ChecksBadge({ checks }: { checks: GhCheck[] | null | undefined }) {
  const { state, passed, total } = checksSummary(checks)
  if (state === "none") return null
  const label =
    state === "pass" ? `All ${total} checks passed` : state === "fail" ? `${total - passed} of ${total} checks failing` : `${passed} of ${total} checks done`
  return (
    <Tooltip label={label}>
      <span aria-label={label} className="flex items-center gap-1 text-xs text-muted-foreground tabular-nums">
        <CheckIcon state={state} />
        {passed}/{total}
      </span>
    </Tooltip>
  )
}

export function ReviewBadge({ decision }: { decision: ReviewDecision }) {
  if (!decision) return null
  const [label, tone] =
    decision === "APPROVED"
      ? ["Approved", "text-git-added border-git-added/40"]
      : decision === "CHANGES_REQUESTED"
        ? ["Changes requested", "text-git-deleted border-git-deleted/40"]
        : ["Review required", "text-muted-foreground border-border-strong"]
  return <span className={cn("rounded-full border px-1.5 py-px text-[11px] whitespace-nowrap", tone)}>{label}</span>
}

export function Avatar({ login, size = 20, className }: { login: string; size?: number; className?: string }) {
  return (
    <img
      src={avatarUrl(login, size)}
      alt=""
      title={login}
      width={size}
      height={size}
      loading="lazy"
      className={cn("shrink-0 rounded-full bg-muted", className)}
      style={{ width: size, height: size }}
    />
  )
}

export function Labels({ labels }: { labels: GhLabel[] }) {
  if (labels.length === 0) return null
  return (
    <span className="flex flex-wrap gap-1">
      {labels.map((label) => (
        <span
          key={label.name}
          className="rounded-full border px-1.5 py-px text-[11px] leading-4"
          style={{ borderColor: `#${label.color}80`, color: `color-mix(in oklch, #${label.color} 70%, var(--foreground))`, background: `#${label.color}1f` }}
        >
          {label.name}
        </span>
      ))}
    </span>
  )
}

export function DiffStat({ additions, deletions }: { additions: number; deletions: number }) {
  return (
    <span className="font-mono text-[11px] tabular-nums">
      <span className="text-git-added">+{additions}</span> <span className="text-git-deleted">−{deletions}</span>
    </span>
  )
}

/** "2h ago" from an ISO date. */
export function since(iso: string | null | undefined): string {
  if (!iso) return ""
  const ms = Date.parse(iso)
  const seconds = Math.round((Date.now() - ms) / 1000)
  if (seconds < 60) return "just now"
  const units: Array<[number, string]> = [
    [60, "m"],
    [3600, "h"],
    [86400, "d"],
    [86400 * 30, "mo"],
    [86400 * 365, "y"],
  ]
  let label = ""
  for (const [size, unit] of units) if (seconds >= size) label = `${Math.floor(seconds / size)}${unit} ago`
  return label
}
