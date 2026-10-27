import { useEffect, useMemo, useState } from "react"

import { lineClass } from "@/lib/diff"
import { errorMessage, ipc } from "@/lib/ipc"
import { highlightDiff, languageOf } from "@/lib/syntax"
import { cn } from "@/lib/utils"
import { useWorkspace } from "@/stores/workspace"

import { CodeText, DiffSign, diffRowClass } from "./code"
import { PaneHeader } from "./pane-header"

export function DiffView({ path }: { path: string }) {
  const [diff, setDiff] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // Re-fetch whenever git status changes (the watcher refreshes it).
  const changes = useWorkspace((s) => s.changes)

  useEffect(() => {
    let cancelled = false
    ipc.git
      .diff(path)
      .then((d) => !cancelled && (setDiff(d), setError(null)))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [path, changes])

  const lines = useMemo(() => diff?.split("\n") ?? [], [diff])
  const coloured = useMemo(() => highlightDiff(lines, languageOf(path), true), [lines, path])

  return (
    <div className="flex h-full flex-col">
      <PaneHeader path={path}>
        <span className="text-xs text-subtle-foreground">Changes vs HEAD</span>
      </PaneHeader>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-4 text-sm text-destructive">{error}</p>
        ) : diff === null ? null : diff === "" ? (
          <p className="p-4 text-sm text-muted-foreground">No changes in this file.</p>
        ) : (
          <pre className="selectable min-w-max py-2 font-mono text-[12px] leading-5">
            {lines.map((line, i) =>
              coloured[i] ? (
                <div key={i} className={cn("flex pr-4 pl-4", diffRowClass(line[0]))}>
                  <DiffSign sign={line[0]} />
                  <span>
                    <CodeText line={coloured[i]} />
                  </span>
                </div>
              ) : (
                <div key={i} className={cn("px-4", lineClass(line))}>
                  {line || " "}
                </div>
              ),
            )}
          </pre>
        )}
      </div>
    </div>
  )
}
