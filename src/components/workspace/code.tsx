import { memo } from "react"

import type { ServerStatus } from "@/bindings/ServerStatus"
import { Tooltip } from "@/components/ui/tooltip"
import type { Line } from "@/lib/syntax"
import { cn } from "@/lib/utils"
import { useCodeIntel } from "@/stores/code"

/** One highlighted line. Memoised: only lines whose colours changed re-render. */
export const CodeText = memo(function CodeText({ line }: { line: Line | null | undefined }) {
  if (!line || line.length === 0) return " "
  return line.map((seg, i) => (
    <span key={i} className={seg.cls || undefined}>
      {seg.text}
    </span>
  ))
})

/** Background for a diff row by its sign; the sign itself goes in a coloured gutter. */
export function diffRowClass(sign: string) {
  return sign === "+" ? "bg-diff-add" : sign === "-" ? "bg-diff-del" : undefined
}

export function DiffSign({ sign }: { sign: string }) {
  const changed = sign === "+" || sign === "-"
  return (
    <span className={cn("w-4 shrink-0 select-none", sign === "+" ? "text-git-added" : "text-git-deleted")}>
      {changed ? sign : ""}
    </span>
  )
}

const SOURCE: Record<string, string> = {
  neovim: "From your Neovim config",
  mason: "Installed with Mason",
  path: "Found on your PATH",
}

/**
 * The file's language server in a pane header: a dot and its name, or what is
 * stopping it, with the one action that fixes it (install through Mason).
 */
export function LanguageServer({ path, status }: { path: string; status: ServerStatus | null }) {
  const pkg = status?.package ?? null
  const installing = useCodeIntel((s) => (pkg ? s.installing[pkg] : false)) || status?.state === "installing"
  const failure = useCodeIntel((s) => (pkg ? s.failures[pkg] : undefined))
  const install = useCodeIntel((s) => s.install)

  if (!status?.server || status.state === "unsupported") return null
  const name = status.server

  let dot: string
  let label: string
  let detail: string
  if (installing) {
    dot = "bg-brand animate-pulse"
    label = `Installing ${name}…`
    detail = "Neovim is installing it with Mason. Colours from the server appear when it's done."
  } else if (failure) {
    dot = "bg-destructive"
    label = `${name} didn't install`
    detail = failure
  } else if (status.state === "missing") {
    dot = "border border-subtle-foreground"
    label = `${name} not installed`
    detail = status.canInstall
      ? `Install it with Mason for exact colours. Until then, colours come from syntax alone.`
      : "Install Neovim to add language servers. Until then, colours come from syntax alone."
  } else if (status.state === "failed") {
    dot = "bg-destructive"
    label = `${name} failed`
    detail = status.message ?? "The server stopped."
  } else if (status.state === "noColors") {
    dot = "bg-subtle-foreground"
    label = name
    detail = "This server sends no semantic colours, so colours come from syntax alone."
  } else if (status.busy) {
    dot = "bg-git-modified animate-pulse"
    label = `${name} indexing`
    detail = "Colours sharpen as the server finishes indexing."
  } else if (status.state === "running") {
    dot = "bg-git-added"
    label = name
    detail = "Colours come from the language server."
  } else {
    dot = "bg-subtle-foreground"
    label = `Starting ${name}…`
    detail = "Colours come from syntax until the server answers."
  }
  const source = status.source ? SOURCE[status.source] : null
  const offerInstall =
    !installing && status.canInstall && pkg !== null && (status.state === "missing" || status.state === "failed" || !!failure)

  return (
    <div className="flex shrink-0 items-center gap-2">
      <Tooltip
        label={
          <>
            {detail}
            {source && <span className="mt-1 block text-muted-foreground">{source}</span>}
          </>
        }
      >
        <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", dot)} />
          {label}
        </span>
      </Tooltip>
      {offerInstall && (
        <button
          type="button"
          onClick={() => void install(path, pkg)}
          className="h-6 rounded-md border border-border-strong px-2 text-xs text-foreground transition-colors outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {failure ? "Try again" : status.state === "missing" ? "Install" : "Install with Mason"}
        </button>
      )}
    </div>
  )
}
