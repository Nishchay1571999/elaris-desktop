import { useEffect, useMemo, useRef, useState } from "react"

import type { ServerStatus } from "@/bindings/ServerStatus"
import { CodeText, DiffSign, diffRowClass, LanguageServer } from "@/components/workspace/code"
import { useHighlighted } from "@/hooks/use-highlighted"
import { diffLines } from "@/lib/diff"
import { ipc } from "@/lib/ipc"
import { highlightDiff, highlightLines, languageOf } from "@/lib/syntax"
import { cn } from "@/lib/utils"
import { useSessions } from "@/stores/sessions"
import { useWorkspace } from "@/stores/workspace"

import type { ToolPart } from "./activity"

/** A Write or Edit call open in a chat tab: everything written, or the whole file with the edit marked. */
export function ToolView({ sessionId, partId }: { sessionId: string; partId: string }) {
  const part = useSessions((s) => findPart(s.sessions[sessionId]?.messages, partId))
  const [status, setStatus] = useState<ServerStatus | null>(null)

  if (!part) {
    return <p className="flex-1 p-4 text-sm text-muted-foreground">This tool call is no longer available.</p>
  }

  const args = part.input ?? {}
  const path = toolPath(part)

  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-border">
      <div className="flex h-8 shrink-0 items-center gap-3 border-b border-border px-4">
        <span className="selectable min-w-0 truncate font-mono text-[11px] text-muted-foreground">{path}</span>
        <span className="shrink-0 text-[11px] text-subtle-foreground">{label(part)}</span>
        <div className="flex-1" />
        <LanguageServer path={path} status={status} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {part.status === "failed" && part.output && (
          <p className="selectable border-b border-border px-4 py-2 text-xs whitespace-pre-wrap text-destructive">{part.output}</p>
        )}
        {part.name === "Write" ? (
          <Written
            path={path}
            text={typeof args.content === "string" ? args.content : ""}
            // Not while the agent is still writing: the server would chase every chunk.
            lsp={part.status === "done"}
            onStatus={setStatus}
          />
        ) : (
          <FileDiff path={path} part={part} onStatus={setStatus} />
        )}
      </div>
    </div>
  )
}

function label(part: ToolPart) {
  if (part.status === "running") return part.name === "Write" ? "Writing…" : "Editing…"
  if (part.status === "failed") return `${part.name} failed`
  if (part.name === "Write") return "Written by the agent"
  const count = edits(part).length
  return count > 1 ? `${count} edits by the agent` : "Edited by the agent"
}

interface EditStep {
  before: string
  after: string
  all: boolean
}

function edits(part: ToolPart): EditStep[] {
  const args = part.input ?? {}
  const text = (v: unknown) => (typeof v === "string" ? v : "")
  if (part.name === "MultiEdit" && Array.isArray(args.edits)) {
    return (args.edits as Record<string, unknown>[]).map((e) => ({
      before: text(e.old_string),
      after: text(e.new_string),
      all: e.replace_all === true,
    }))
  }
  if (part.name === "NotebookEdit") return [{ before: "", after: text(args.new_source), all: false }]
  return [{ before: text(args.old_string), after: text(args.new_string), all: args.replace_all === true }]
}

/**
 * The whole file as it is now, diffed against itself with this call's edits undone, so the
 * changed lines sit in context like a git diff. Falls back to just the edited snippets when
 * the file can't be read or no longer contains what the edit wrote.
 */
function FileDiff({
  path,
  part,
  onStatus,
}: {
  path: string
  part: ToolPart
  onStatus: (status: ServerStatus | null) => void
}) {
  const root = useWorkspace((s) => s.info?.root)
  // Re-read whenever the workspace reports changes.
  const changes = useWorkspace((s) => s.changes)
  const [texts, setTexts] = useState<{ before: string; after: string } | null | undefined>(undefined)
  const firstChange = useRef<HTMLDivElement>(null)
  const scrolled = useRef(false)

  useEffect(() => {
    const rel = root && path.startsWith(`${root}/`) ? path.slice(root.length + 1) : null
    if (!rel || part.status !== "done") {
      setTexts(null)
      return
    }
    let cancelled = false
    ipc.workspace
      .readFile(rel)
      .then((file) => {
        if (cancelled) return
        const before = file.text != null && !file.truncated ? undoEdits(file.text, edits(part)) : null
        setTexts(before === null ? null : { before, after: file.text! })
      })
      .catch(() => !cancelled && setTexts(null))
    return () => {
      cancelled = true
    }
  }, [root, path, part, changes])

  // The file as it is now gets the language server's colours; removed lines come from the text before.
  const after = useHighlighted(path, texts?.after ?? null)
  const language = languageOf(path)
  const beforeLines = useMemo(() => (texts ? highlightLines(texts.before, language) : []), [texts, language])
  const lines = useMemo(() => (texts ? diffLines(texts.before, texts.after) : null), [texts])

  useEffect(() => onStatus(after.status), [after.status, onStatus])

  useEffect(() => {
    if (lines && !scrolled.current && firstChange.current) {
      firstChange.current.scrollIntoView({ block: "center" })
      scrolled.current = true
    }
  }, [lines])

  if (texts === undefined) return null
  if (lines === null) {
    return (
      <>
        <p className="border-b border-border px-4 py-2 text-xs text-subtle-foreground">
          Showing only the edited lines — the full file couldn't be matched to this edit.
        </p>
        {edits(part).map((edit, i) => (
          <section key={i} className={cn(i > 0 && "border-t border-border")}>
            <FullDiff lines={diffLines(edit.before, edit.after)} language={language} />
          </section>
        ))}
      </>
    )
  }

  let oldNo = 0
  let newNo = 0
  let marked = false
  return (
    <pre className="selectable min-w-max py-2 font-mono text-[12px] leading-5">
      {lines.map((line, i) => {
        const sign = line[0]
        if (sign !== "+") oldNo++
        if (sign !== "-") newNo++
        const changed = sign === "+" || sign === "-"
        const first = changed && !marked
        if (first) marked = true
        return (
          <div key={i} ref={first ? firstChange : undefined} className={cn("flex pr-4", diffRowClass(sign))}>
            <span className="w-12 shrink-0 pr-2 text-right text-subtle-foreground select-none">{sign === "+" ? "" : oldNo}</span>
            <span className="w-12 shrink-0 pr-2 text-right text-subtle-foreground select-none">{sign === "-" ? "" : newNo}</span>
            <DiffSign sign={sign} />
            <span>
              <CodeText line={sign === "-" ? beforeLines[oldNo - 1] : after.lines[newNo - 1]} />
            </span>
          </div>
        )
      })}
    </pre>
  )
}

/** `current` with `steps` reversed (last first), or null if any step's result isn't in it. */
function undoEdits(current: string, steps: EditStep[]): string | null {
  let text = current
  for (const { before, after, all } of [...steps].reverse()) {
    if (!after || !text.includes(after)) return null
    if (all) {
      text = text.split(after).join(before)
    } else {
      const at = text.indexOf(after)
      text = text.slice(0, at) + before + text.slice(at + after.length)
    }
  }
  return text
}

function Written({
  path,
  text,
  lsp,
  onStatus,
}: {
  path: string
  text: string
  lsp: boolean
  onStatus: (status: ServerStatus | null) => void
}) {
  const { lines, status } = useHighlighted(path, text, { lsp })
  useEffect(() => onStatus(status), [status, onStatus])
  return (
    <pre className="selectable min-w-max py-2 font-mono text-[12px] leading-5">
      {lines.map((line, i) => (
        <div key={i} className="flex">
          <span className="w-12 shrink-0 pr-4 text-right text-subtle-foreground select-none">{i + 1}</span>
          <span className="pr-4">
            <CodeText line={line} />
          </span>
        </div>
      ))}
    </pre>
  )
}

function FullDiff({ lines, language }: { lines: string[]; language: string | null }) {
  // Keyed by content: callers build `lines` afresh on every render.
  const text = lines.join("\n")
  const coloured = useMemo(() => highlightDiff(text.split("\n"), language), [text, language])
  return (
    <pre className="selectable min-w-max py-2 font-mono text-[12px] leading-5">
      {lines.map((line, i) => (
        <div key={i} className={cn("flex px-4", diffRowClass(line[0]))}>
          <DiffSign sign={line[0]} />
          <span>
            <CodeText line={coloured[i]} />
          </span>
        </div>
      ))}
    </pre>
  )
}

/** The file a Write or Edit call touched. */
export function toolPath(part: ToolPart): string {
  const args = part.input ?? {}
  if (typeof args.file_path === "string") return args.file_path
  if (typeof args.notebook_path === "string") return args.notebook_path
  return part.summary
}

export function findPart(messages: { parts: unknown[] }[] | undefined, id: string): ToolPart | undefined {
  for (const message of messages ?? []) {
    for (const part of message.parts as ToolPart[]) {
      if (part.type === "tool" && part.id === id) return part
    }
  }
  return undefined
}
