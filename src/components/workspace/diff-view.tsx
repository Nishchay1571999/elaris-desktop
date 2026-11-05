import { FileText, LoaderCircle, Minus, Plus, Undo2 } from "lucide-react"
import { useEffect, useMemo, useState } from "react"

import type { DiffSide } from "@/bindings/DiffSide"
import { Segmented } from "@/components/ui/segmented"
import { lineClass } from "@/lib/diff"
import { errorMessage, ipc } from "@/lib/ipc"
import { hunkPatch, splitHunks } from "@/lib/patch"
import { highlightDiff, languageOf } from "@/lib/syntax"
import { cn } from "@/lib/utils"
import { useScm } from "@/stores/scm"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

import { CodeText, DiffSign, diffRowClass } from "./code"
import { PaneHeader } from "./pane-header"

const SIDE_TEXT: Record<DiffSide, string> = {
  staged: "Staged changes (index vs HEAD)",
  unstaged: "Working tree changes (vs index)",
  untracked: "New file",
}

/**
 * One file's diff. With a `side` (from the Source Control panel) it shows the
 * staged or the working-tree changes, each hunk with Stage, Unstage or
 * Revert; without one, everything against HEAD, read-only.
 */
export function DiffView({ path, side }: { path: string; side?: DiffSide }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const status = useScm((s) => s.status)
  const busy = useScm((s) => !!s.busy)
  // Re-fetch whenever git status changes (the watcher refreshes it).
  const changes = useWorkspace((s) => s.changes)

  useEffect(() => {
    let cancelled = false
    const load = side ? ipc.git.diffFile(path, side) : ipc.git.diff(path)
    load
      .then((d) => !cancelled && (setDiff(d), setError(null)))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [path, side, changes, status])

  const split = useMemo(() => splitHunks(diff ?? ""), [diff])
  const lines = useMemo(() => split.hunks.flat(), [split])
  const coloured = useMemo(() => highlightDiff(lines, languageOf(path), true), [lines, path])
  const binary = split.header.some((l) => l.startsWith("Binary files "))

  // Which sides this file has, for the Staged / Working Tree switch.
  const staged = !!status?.staged.some((f) => f.path === path)
  const unstaged = !!status?.unstaged.some((f) => f.path === path)
  const untracked = !!status?.untracked.some((f) => f.path === path)
  const navigate = useUi((s) => s.navigate)
  const showSide = (next: DiffSide) => useUi.getState().replace({ view: { kind: "diff", path, side: next } })

  const scmFile = (list: "staged" | "unstaged" | "untracked") => status?.[list].find((f) => f.path === path)
  const applyHunk = (hunk: string[], cached: boolean, reverse: boolean, label: string) =>
    void useScm.getState().run(label, () => ipc.git.applyPatch(hunkPatch(split, hunk), cached, reverse))
  const revertHunk = async (hunk: string[]) => {
    if (await ipc.dialog.confirm("Revert this change in the file? It can't be undone.", "Revert change", "Revert")) {
      applyHunk(hunk, false, true, "Reverting change…")
    }
  }

  let offset = 0
  return (
    <div className="flex h-full flex-col">
      <PaneHeader
        path={path}
        actions={
          <span className="flex items-center gap-1">
            {side && (side === "staged" ? (
              <HeaderButton
                disabled={busy}
                onClick={() => {
                  const file = scmFile("staged")
                  if (file) void useScm.getState().unstage([file])
                }}
              >
                <Minus /> Unstage file
              </HeaderButton>
            ) : (
              <>
                <HeaderButton
                  disabled={busy}
                  onClick={() => {
                    const file = scmFile(side === "untracked" ? "untracked" : "unstaged")
                    if (file) void useScm.getState().discard([file])
                  }}
                >
                  <Undo2 /> {side === "untracked" ? "Delete" : "Discard"}
                </HeaderButton>
                <HeaderButton
                  disabled={busy}
                  onClick={() => {
                    const file = scmFile(side === "untracked" ? "untracked" : "unstaged")
                    if (file) void useScm.getState().stage([file])
                  }}
                >
                  <Plus /> Stage file
                </HeaderButton>
              </>
            ))}
            <HeaderButton onClick={() => void ipc.workspace.openFile(path).catch((e) => useWorkspace.setState({ error: errorMessage(e) }))}>
              <FileText /> Open
            </HeaderButton>
          </span>
        }
      >
        {side && staged && (unstaged || untracked) ? (
          <Segmented<DiffSide>
            label="Which changes"
            value={side}
            onChange={showSide}
            options={[
              { value: "staged", label: "Staged" },
              { value: untracked ? "untracked" : "unstaged", label: "Working tree" },
            ]}
          />
        ) : (
          <span className="text-xs text-subtle-foreground">{side ? SIDE_TEXT[side] : "Changes vs HEAD"}</span>
        )}
        {busy && <LoaderCircle className="size-3.5 animate-spin text-muted-foreground" />}
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : diff === null ? null : binary ? (
          <p className="p-4 text-sm text-muted-foreground">Binary file; no text diff to show.</p>
        ) : split.hunks.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">
            {side && side !== "untracked" && (staged || unstaged)
              ? `No ${side === "staged" ? "staged" : "unstaged"} changes in this file.`
              : "No changes in this file."}
            {side && staged && side !== "staged" && (
              <button type="button" className="ml-1 text-brand hover:underline" onClick={() => navigate({ view: { kind: "diff", path, side: "staged" } })}>
                Show staged changes
              </button>
            )}
          </p>
        ) : (
          <div className="selectable min-w-max py-2 font-mono text-[12px] leading-5">
            {split.hunks.map((hunk, h) => {
              const start = offset
              offset += hunk.length
              return (
                <section key={h} className="group/hunk">
                  <div className="sticky left-0 flex items-center gap-2 bg-brand-soft px-4 text-muted-foreground">
                    <span className="flex-1">{hunk[0]}</span>
                    {side === "unstaged" && (
                      <span className="flex gap-1 font-sans opacity-0 transition-opacity group-hover/hunk:opacity-100 focus-within:opacity-100">
                        <HunkButton disabled={busy} onClick={() => void revertHunk(hunk)}>
                          <Undo2 /> Revert
                        </HunkButton>
                        <HunkButton disabled={busy} onClick={() => applyHunk(hunk, true, false, "Staging change…")}>
                          <Plus /> Stage
                        </HunkButton>
                      </span>
                    )}
                    {side === "staged" && (
                      <span className="flex gap-1 font-sans opacity-0 transition-opacity group-hover/hunk:opacity-100 focus-within:opacity-100">
                        <HunkButton disabled={busy} onClick={() => applyHunk(hunk, true, true, "Unstaging change…")}>
                          <Minus /> Unstage
                        </HunkButton>
                      </span>
                    )}
                  </div>
                  {hunk.slice(1).map((line, i) => {
                    const at = start + i + 1
                    return coloured[at] ? (
                      <div key={i} className={cn("flex pr-4 pl-4", diffRowClass(line[0]))}>
                        <DiffSign sign={line[0]} />
                        <span>
                          <CodeText line={coloured[at]} />
                        </span>
                      </div>
                    ) : (
                      <div key={i} className={cn("px-4", lineClass(line))}>
                        {line || " "}
                      </div>
                    )
                  })}
                </section>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

function HeaderButton({ children, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40 [&_svg]:size-3.5"
      {...props}
    >
      {children}
    </button>
  )
}

function HunkButton({ children, ...props }: React.ComponentProps<"button">) {
  return (
    <button
      type="button"
      className="flex h-5 items-center gap-1 rounded px-1.5 text-[11px] text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 disabled:opacity-40 [&_svg]:size-3"
      {...props}
    >
      {children}
    </button>
  )
}
