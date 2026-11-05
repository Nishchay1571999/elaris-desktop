import { useMemo } from "react"

import { CodeText, DiffSign, diffRowClass } from "@/components/workspace/code"
import { diffLines } from "@/lib/diff"
import { highlightDiff, languageOf } from "@/lib/syntax"
import { cn } from "@/lib/utils"

import { PLAN_TOOL } from "./activity"
import { Markdown } from "./markdown"

interface ToolDetailProps {
  name: string
  /** The tool's input, long strings already clipped by the sidecar. */
  input: Record<string, unknown> | null
  /** The tool's text result, once it has finished. */
  output?: string | null
  failed?: boolean
}

/** What a tool call did, shown under its row in the transcript and on approval cards. */
export function ToolDetail({ name, input, output, failed }: ToolDetailProps) {
  // File tools report a one-line confirmation on success; only errors are worth showing.
  const editOutput = failed ? output : null
  const args = input ?? {}
  const str = (key: string) => (typeof args[key] === "string" ? (args[key] as string) : undefined)
  const language = languageOf(str("file_path") ?? "")

  switch (name) {
    case "Edit":
      return (
        <>
          <Diff language={language} lines={diffLines(str("old_string") ?? "", str("new_string") ?? "")} />
          <Output text={editOutput} />
        </>
      )
    case "MultiEdit": {
      const edits = Array.isArray(args.edits) ? (args.edits as Record<string, unknown>[]) : []
      return (
        <>
          {edits.map((edit, i) => (
            <Diff key={i} language={language} lines={diffLines(String(edit.old_string ?? ""), String(edit.new_string ?? ""))} />
          ))}
          <Output text={editOutput} />
        </>
      )
    }
    case "Write":
      return (
        <>
          <Diff language={language} lines={diffLines("", str("content") ?? "")} />
          <Output text={editOutput} />
        </>
      )
    case "Bash":
      return (
        <>
          <Block label={str("description") ?? "Command"} text={`$ ${str("command") ?? ""}`} />
          <Output text={output} />
        </>
      )
    case PLAN_TOOL:
      return (
        <div className="selectable rounded-md bg-surface-sunken px-3 py-2">
          <Markdown text={str("plan") ?? ""} />
        </div>
      )
    case "Read":
    case "Grep":
    case "Glob":
    case "WebFetch":
    case "WebSearch":
    case "AskUserQuestion":
      return <Output text={output} />
    default:
      return (
        <>
          {Object.keys(args).length > 0 && <Block label="Input" text={JSON.stringify(args, null, 2)} />}
          <Output text={output} />
        </>
      )
  }
}

function Diff({ lines, language }: { lines: string[]; language: string | null }) {
  // Keyed by content: callers build `lines` afresh on every render.
  const text = lines.join("\n")
  const coloured = useMemo(() => highlightDiff(text.split("\n"), language), [text, language])
  if (lines.length === 0) return null
  return (
    <pre className="selectable max-h-80 overflow-auto rounded-md bg-surface-sunken py-1.5 font-mono text-[11.5px] leading-[18px]">
      {lines.map((line, i) => (
        <div key={i} className={cn("flex min-w-max px-2.5", diffRowClass(line[0]))}>
          <DiffSign sign={line[0]} />
          <span>
            <CodeText line={coloured[i]} />
          </span>
        </div>
      ))}
    </pre>
  )
}

function Output({ text }: { text?: string | null }) {
  if (!text) return null
  return <Block label="Output" text={text} />
}

function Block({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <div className="mb-1 text-[11px] text-subtle-foreground">{label}</div>
      <pre className="selectable max-h-80 overflow-auto rounded-md bg-surface-sunken px-2.5 py-1.5 font-mono text-[11.5px] leading-[18px] whitespace-pre-wrap">
        {text}
      </pre>
    </div>
  )
}
