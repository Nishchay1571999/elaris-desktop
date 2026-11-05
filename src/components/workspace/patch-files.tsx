import { ChevronRight } from "lucide-react"
import { memo, useMemo, useState } from "react"

import { DiffStat } from "@/components/pulls/pr-bits"
import { lineClass } from "@/lib/diff"
import { type PatchFile, parsePatch } from "@/lib/patch"
import { highlightDiff, languageOf } from "@/lib/syntax"
import { cn } from "@/lib/utils"

import { CodeText, DiffSign, diffRowClass } from "./code"

/** Big files start folded so the page stays quick. */
export const FOLD_LINES = 400

export const STATUS_TEXT: Record<PatchFile["status"], string> = {
  added: "Added",
  deleted: "Deleted",
  renamed: "Renamed",
  modified: "",
  binary: "Binary",
}

/** A multi-file unified diff as foldable per-file sections: a commit's or a stash's changes. */
export function PatchFiles({ patch }: { patch: string }) {
  const files = useMemo(() => parsePatch(patch), [patch])
  if (files.length === 0) return <p className="text-[13px] text-muted-foreground">No file changes.</p>
  return (
    <div className="flex flex-col gap-3">
      {files.map((file) => (
        <FoldableFile key={`${file.from ?? ""}>${file.path}`} file={file} />
      ))}
    </div>
  )
}

const FoldableFile = memo(function FoldableFile({ file }: { file: PatchFile }) {
  const [open, setOpen] = useState(file.lines.length <= FOLD_LINES)
  return (
    <section className="overflow-hidden rounded-xl border border-border">
      <header className="flex items-center gap-2 bg-surface-sunken px-3 py-2 text-xs">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:underline"
        >
          <ChevronRight className={cn("size-3.5 shrink-0 text-subtle-foreground transition-transform", open && "rotate-90")} />
          <span className="selectable truncate font-mono text-[12px]">
            {file.from && <span className="text-muted-foreground">{file.from} → </span>}
            {file.path}
          </span>
          {STATUS_TEXT[file.status] && <span className="shrink-0 text-subtle-foreground">{STATUS_TEXT[file.status]}</span>}
        </button>
        <DiffStat additions={file.additions} deletions={file.deletions} />
      </header>
      {open && <PatchHunks file={file} />}
    </section>
  )
})

/** A file's hunks, syntax-highlighted. */
export function PatchHunks({ file }: { file: PatchFile }) {
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
