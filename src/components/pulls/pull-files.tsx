import { ChevronRight, LoaderCircle } from "lucide-react"
import { memo, useMemo, useState } from "react"

import { FOLD_LINES, PatchHunks, STATUS_TEXT } from "@/components/workspace/patch-files"
import { useGh } from "@/hooks/use-gh"
import { ipc } from "@/lib/ipc"
import { type PatchFile, parsePatch } from "@/lib/patch"
import { cn } from "@/lib/utils"

import { DiffStat } from "./pr-bits"

/** Every file the pull request changes, each a foldable diff. */
export function PullFiles({
  repo,
  target,
  number,
  updatedAt,
}: {
  repo?: string
  /** The repository for the cache key: `repo`, or the open folder's. */
  target: string
  number: number
  /** A new push changes this, and with it the remembered diff. */
  updatedAt: string
}) {
  const [viewed, setViewed] = useState<Record<string, boolean>>({})
  const { data: patch, error } = useGh(`diff:${target}#${number}@${updatedAt}`, () => ipc.github.prDiff(repo, number))
  const files = useMemo(() => (patch === undefined ? null : parsePatch(patch)), [patch])

  if (error && !files) return <p className="selectable text-[13px] text-destructive">{error}</p>
  if (!files)
    return (
      <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
        <LoaderCircle className="size-3.5 animate-spin" /> Loading changes…
      </p>
    )
  if (files.length === 0) return <p className="text-[13px] text-muted-foreground">No file changes.</p>

  const seen = files.filter((f) => viewed[f.path]).length
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground tabular-nums">
        {seen} of {files.length} files viewed
      </p>
      {files.map((file) => (
        <FileDiff
          key={file.path}
          file={file}
          viewed={!!viewed[file.path]}
          onViewed={(v) => setViewed((s) => ({ ...s, [file.path]: v }))}
        />
      ))}
    </div>
  )
}

const FileDiff = memo(function FileDiff({
  file,
  viewed,
  onViewed,
}: {
  file: PatchFile
  viewed: boolean
  onViewed: (viewed: boolean) => void
}) {
  const [open, setOpen] = useState(file.lines.length <= FOLD_LINES)
  const shown = open && !viewed

  return (
    <section className="overflow-hidden rounded-xl border border-border">
      <header className="flex items-center gap-2 bg-surface-sunken px-3 py-2 text-xs">
        <button
          type="button"
          aria-expanded={shown}
          onClick={() => (viewed ? onViewed(false) : setOpen((o) => !o))}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:underline"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", shown && "rotate-90")} />
          <span className="selectable truncate font-mono text-[12px]">
            {file.from && <span className="text-muted-foreground">{file.from} → </span>}
            {file.path}
          </span>
          {STATUS_TEXT[file.status] && <span className="shrink-0 text-subtle-foreground">{STATUS_TEXT[file.status]}</span>}
        </button>
        <DiffStat additions={file.additions} deletions={file.deletions} />
        <label className="flex shrink-0 cursor-pointer items-center gap-1.5 text-muted-foreground">
          <input type="checkbox" checked={viewed} onChange={(e) => onViewed(e.target.checked)} className="accent-(--brand)" />
          Viewed
        </label>
      </header>
      {shown && <PatchHunks file={file} />}
    </section>
  )
})
