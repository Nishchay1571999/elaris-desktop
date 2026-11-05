import { ChevronRight, LoaderCircle } from "lucide-react"
import { memo, useMemo, useState } from "react"

import { CodeText, DiffSign, diffRowClass } from "@/components/workspace/code"
import { useGh } from "@/hooks/use-gh"
import { lineClass } from "@/lib/diff"
import { ipc } from "@/lib/ipc"
import { type PatchFile, parsePatch } from "@/lib/patch"
import { highlightDiff, languageOf } from "@/lib/syntax"
import { cn } from "@/lib/utils"

import { DiffStat } from "./pr-bits"

/** Big files start folded so the page stays quick. */
const FOLD_LINES = 400

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

const STATUS_TEXT: Record<PatchFile["status"], string> = {
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  modified: "",
  binary: "Binary",
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
      {shown && <Hunks file={file} />}
    </section>
  )
})

function Hunks({ file }: { file: PatchFile }) {
  const coloured = useMemo(() => highlightDiff(file.lines, languageOf(file.path), true), [file])
  if (file.status === "binary" || file.lines.length === 0) {
    return <p className="px-4 py-3 text-xs text-muted-foreground">{file.status === "binary" ? "Binary file not shown." : "No content changes."}</p>
  }
  return (
    <pre className="selectable overflow-x-auto py-1 font-mono text-[12px] leading-5">
      {file.lines.map((line, i) =>
        coloured[i] ? (
          <div key={i} className={cn("flex min-w-max pr-4 pl-3", diffRowClass(line[0]))}>
            <DiffSign sign={line[0]} />
            <span>
              <CodeText line={coloured[i]} />
            </span>
          </div>
        ) : (
          <div key={i} className={cn("min-w-max px-3", line.startsWith("@@") ? "bg-brand-soft text-muted-foreground" : lineClass(line))}>
            {line || " "}
          </div>
        ),
      )}
    </pre>
  )
}
