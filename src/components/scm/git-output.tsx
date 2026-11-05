import { Copy, Eraser, X } from "lucide-react"
import { useEffect, useRef } from "react"

import type { GitOutputEntry } from "@/bindings/GitOutputEntry"
import { IconButton } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { useGitOutput } from "@/stores/git-output"
import { useUi } from "@/stores/ui"

/** VS Code's Git output channel: every git command the app ran and what git said. */
export function GitOutputView() {
  const entries = useGitOutput((s) => s.entries)
  const clear = useGitOutput((s) => s.clear)
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  // Follow new output while scrolled to the bottom.
  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [entries])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <span className="text-[13px] font-medium">Git Output</span>
        <span className="text-xs text-subtle-foreground">{entries.length} commands</span>
        <div className="flex-1" />
        <IconButton label="Copy all" onClick={() => void navigator.clipboard.writeText(entries.map(format).join("\n\n"))}>
          <Copy className="size-3.5" />
        </IconButton>
        <IconButton label="Clear" onClick={clear}>
          <Eraser className="size-3.5" />
        </IconButton>
        <IconButton label="Close" onClick={() => useUi.getState().navigate({ view: { kind: "chat" } })}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
        className="selectable min-h-0 flex-1 overflow-auto px-4 py-2 font-mono text-[12px] leading-5"
      >
        {entries.length === 0 ? (
          <p className="font-sans text-sm text-muted-foreground">Git commands the app runs show up here.</p>
        ) : (
          entries.map((entry) => <Entry key={entry.id} entry={entry} />)
        )}
      </div>
    </div>
  )
}

function Entry({ entry }: { entry: GitOutputEntry }) {
  const failed = entry.exitCode !== 0
  return (
    <div className="py-0.5">
      <div className="flex gap-2">
        <span className="shrink-0 text-subtle-foreground">{time(entry.startedAt)}</span>
        <span className={cn("min-w-0 flex-1 break-all", failed ? "text-destructive" : "text-foreground")}>
          &gt; git {entry.args.map(quote).join(" ")}
        </span>
        <span className="shrink-0 text-subtle-foreground tabular-nums">
          {entry.durationMs} ms{failed && ` · exit ${entry.exitCode ?? "?"}`}
        </span>
      </div>
      {entry.stdout.trim() && <pre className="pl-20 whitespace-pre-wrap text-muted-foreground">{entry.stdout.trimEnd()}</pre>}
      {entry.stderr.trim() && (
        <pre className={cn("pl-20 whitespace-pre-wrap", failed ? "text-destructive" : "text-muted-foreground")}>{entry.stderr.trimEnd()}</pre>
      )}
    </div>
  )
}

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })

/** Quotes an argument the way a shell would need it. */
const quote = (arg: string) => (/^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replace(/'/g, `'\\''`)}'`)

const format = (e: GitOutputEntry) =>
  [`${time(e.startedAt)} > git ${e.args.map(quote).join(" ")} [${e.durationMs} ms, exit ${e.exitCode ?? "?"}]`, e.stdout.trimEnd(), e.stderr.trimEnd()]
    .filter(Boolean)
    .join("\n")
