import { Copy, GitBranchPlus, GitCommitHorizontal, LoaderCircle, RefreshCw, Tag, Undo2, Cherry, X } from "lucide-react"
import { memo, useCallback, useEffect, useMemo, useState } from "react"

import type { GraphCommit } from "@/bindings/GraphCommit"
import { IconButton } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { Segmented } from "@/components/ui/segmented"
import { type GraphRow, laneColor, layoutGraph } from "@/lib/graph"
import { errorMessage, ipc } from "@/lib/ipc"
import * as act from "@/lib/scm-actions"
import { cn, relativeTime } from "@/lib/utils"
import { useScm } from "@/stores/scm"
import { useUi } from "@/stores/ui"

const PAGE = 200
const ROW = 26
const LANE = 14

/** Every branch's history as a graph, VS Code's Commit Graph. */
export function CommitGraph() {
  const [all, setAll] = useState(true)
  const [commits, setCommits] = useState<GraphCommit[] | null>(null)
  const [more, setMore] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Reload when HEAD, the branch or its standing move.
  const head = useScm((s) => `${s.status?.branch}|${s.status?.detached}|${s.status?.ahead}|${s.status?.behind}|${s.status?.upstream}`)

  const load = useCallback(
    async (skip: number) => {
      setLoading(true)
      try {
        const page = await ipc.git.log({ skip, limit: PAGE, all })
        setCommits((c) => (skip === 0 ? page : [...(c ?? []), ...page]))
        setMore(page.length === PAGE)
        setError(null)
      } catch (e) {
        setError(errorMessage(e))
      } finally {
        setLoading(false)
      }
    },
    [all],
  )

  useEffect(() => {
    void load(0)
  }, [load, head])

  const rows = useMemo(() => layoutGraph(commits ?? []), [commits])
  const width = Math.min(20, Math.max(1, ...rows.map((r) => r.width))) * LANE + LANE / 2

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <span className="text-[13px] font-medium">Commit Graph</span>
        <Segmented<"all" | "head">
          label="Which commits"
          value={all ? "all" : "head"}
          onChange={(v) => setAll(v === "all")}
          options={[
            { value: "all", label: "All branches" },
            { value: "head", label: "Current branch" },
          ]}
        />
        {loading && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
        <div className="flex-1" />
        <IconButton label="Refresh" onClick={() => void load(0)}>
          <RefreshCw className="size-3.5" />
        </IconButton>
        <IconButton label="Close" onClick={() => useUi.getState().navigate({ view: { kind: "chat" } })}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="selectable p-4 text-sm text-destructive">{error}</p>
        ) : commits?.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No commits yet.</p>
        ) : (
          <div className="py-1 text-[13px]">
            {commits?.map((commit, i) => (
              <CommitRow key={commit.sha} commit={commit} row={rows[i]} width={width} />
            ))}
            {more && (
              <button
                type="button"
                disabled={loading}
                onClick={() => void load(commits?.length ?? 0)}
                className="mx-4 my-2 rounded-md px-2 py-1 text-xs text-brand outline-none hover:bg-muted disabled:opacity-50"
              >
                {loading ? "Loading…" : "Load more commits"}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

const CommitRow = memo(function CommitRow({ commit, row, width }: { commit: GraphCommit; row: GraphRow; width: number }) {
  const short = commit.sha.slice(0, 7)
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={() => act.showCommit(commit.sha)}
          style={{ height: ROW, contentVisibility: "auto", containIntrinsicSize: `auto ${ROW}px` }}
          className="flex w-full items-center gap-2 pr-4 text-left outline-none hover:bg-muted focus-visible:bg-muted"
        >
          <Lanes row={row} width={width} merge={commit.parents.length > 1} />
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            {commit.refs.map((ref) => (
              <RefPill key={ref} name={ref} />
            ))}
            <span className="truncate">{commit.subject}</span>
          </span>
          <span className="w-32 shrink-0 truncate text-xs text-muted-foreground">{commit.author}</span>
          <span className="w-20 shrink-0 text-right text-xs text-subtle-foreground tabular-nums">{relativeTime(commit.time * 1000)}</span>
          <span className="w-14 shrink-0 text-right font-mono text-[11px] text-subtle-foreground">{short}</span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => act.showCommit(commit.sha)}>
          <GitCommitHorizontal /> Open Commit
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void act.checkoutCommit(commit.sha)}>
          <GitCommitHorizontal /> Checkout (Detached)
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void act.createBranch(commit.sha)}>
          <GitBranchPlus /> Create Branch Here…
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void act.createTag(commit.sha)}>
          <Tag /> Create Tag Here…
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void act.cherryPick(commit.sha)}>
          <Cherry /> Cherry-pick
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void act.revertCommit(commit.sha)}>
          <Undo2 /> Revert Commit
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(commit.sha)}>
          <Copy /> Copy Commit Hash
        </ContextMenuItem>
        <ContextMenuItem onSelect={() => void navigator.clipboard.writeText(commit.subject)}>
          <Copy /> Copy Commit Message
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
})

function Lanes({ row, width, merge }: { row: GraphRow; width: number; merge: boolean }) {
  const x = (lane: number) => lane * LANE + LANE / 2 + 4
  const mid = ROW / 2
  return (
    <svg width={width} height={ROW} className="shrink-0" aria-hidden>
      {row.top.map((s, i) => (
        <path key={`t${i}`} d={curve(x(s.from), 0, x(s.to), mid)} stroke={laneColor(s.color)} strokeWidth={1.5} fill="none" />
      ))}
      {row.bottom.map((s, i) => (
        <path key={`b${i}`} d={curve(x(s.from), mid, x(s.to), ROW)} stroke={laneColor(s.color)} strokeWidth={1.5} fill="none" />
      ))}
      <circle
        cx={x(row.lane)}
        cy={mid}
        r={merge ? 3 : 4}
        fill={merge ? "var(--background)" : laneColor(row.lane)}
        stroke={laneColor(row.lane)}
        strokeWidth={merge ? 2 : 0}
      />
    </svg>
  )
}

/** Straight when the lane doesn't move; a smooth bend when it does. */
function curve(x1: number, y1: number, x2: number, y2: number) {
  if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`
  const my = (y1 + y2) / 2
  return `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`
}

function RefPill({ name }: { name: string }) {
  const head = name.startsWith("HEAD -> ")
  const tag = name.startsWith("tag: ")
  const label = name.replace(/^HEAD -> /, "").replace(/^tag: /, "")
  const remote = !head && !tag && label.includes("/") && label !== "HEAD"
  return (
    <span
      className={cn(
        "flex shrink-0 items-center gap-1 rounded-full border px-1.5 text-[10.5px] leading-4",
        head && "border-brand bg-brand-soft text-brand",
        tag && "border-git-modified/40 text-git-modified",
        remote && "border-border text-muted-foreground",
        !head && !tag && !remote && "border-git-added/40 text-git-added",
      )}
    >
      {tag && <Tag className="size-2.5" />}
      {label}
    </span>
  )
}
