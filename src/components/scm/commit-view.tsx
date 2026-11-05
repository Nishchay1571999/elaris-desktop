import { Copy, LoaderCircle, X } from "lucide-react"
import { useEffect, useState } from "react"

import type { CommitDetail } from "@/bindings/CommitDetail"
import { IconButton } from "@/components/ui/button"
import { PatchFiles } from "@/components/workspace/patch-files"
import { errorMessage, ipc } from "@/lib/ipc"
import * as act from "@/lib/scm-actions"
import { relativeTime } from "@/lib/utils"
import { useUi } from "@/stores/ui"

/** One commit: who, when, its full message and the files it changed. */
export function CommitView({ sha }: { sha: string }) {
  const [detail, setDetail] = useState<CommitDetail | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ipc.git
      .show(sha)
      .then((d) => !cancelled && setDetail(d))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [sha])

  const commit = detail?.commit
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <span className="selectable font-mono text-xs text-muted-foreground">{sha.slice(0, 10)}</span>
        <IconButton label="Copy commit hash" onClick={() => void navigator.clipboard.writeText(sha)}>
          <Copy className="size-3.5" />
        </IconButton>
        <div className="flex-1" />
        <button type="button" onClick={act.showGraph} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          Commit graph
        </button>
        <IconButton label="Close" onClick={() => useUi.getState().navigate({ view: { kind: "chat" } })}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <p className="selectable text-sm text-destructive">{error}</p>
        ) : !detail || !commit ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" /> Loading commit…
          </p>
        ) : (
          <div className="mx-auto flex max-w-5xl flex-col gap-4">
            <header className="flex flex-col gap-2">
              <pre className="selectable font-sans text-[15px] font-medium whitespace-pre-wrap">{detail.message || commit.subject}</pre>
              <p className="text-xs text-muted-foreground">
                <span className="text-foreground">{commit.author}</span> &lt;{commit.email}&gt; committed{" "}
                {relativeTime(commit.time * 1000)}
                {detail.committer && detail.committer !== commit.author && <> · committed by {detail.committer}</>}
              </p>
              {commit.parents.length > 0 && (
                <p className="flex flex-wrap items-center gap-1.5 text-xs text-subtle-foreground">
                  {commit.parents.length > 1 ? "Parents" : "Parent"}
                  {commit.parents.map((p) => (
                    <button key={p} type="button" onClick={() => act.showCommit(p)} className="font-mono text-brand hover:underline">
                      {p.slice(0, 7)}
                    </button>
                  ))}
                  {commit.parents.length > 1 && <span>(changes shown against the first)</span>}
                </p>
              )}
            </header>
            <PatchFiles patch={detail.patch} />
          </div>
        )}
      </div>
    </div>
  )
}

/** What a stash holds, as a diff. */
export function StashView({ index, message }: { index: number; message: string }) {
  const [patch, setPatch] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    ipc.git
      .stashShow(index)
      .then((p) => !cancelled && setPatch(p))
      .catch((e) => !cancelled && setError(errorMessage(e)))
    return () => {
      cancelled = true
    }
  }, [index])

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border pr-2 pl-4">
        <span className="min-w-0 truncate text-[13px]">{message}</span>
        <span className="font-mono text-xs text-subtle-foreground">stash@{`{${index}}`}</span>
        <div className="flex-1" />
        <button type="button" onClick={() => void act.applyStash(false)} className="rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
          Apply…
        </button>
        <IconButton label="Close" onClick={() => useUi.getState().navigate({ view: { kind: "chat" } })}>
          <X className="size-4" />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <p className="selectable text-sm text-destructive">{error}</p>
        ) : patch === null ? (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" /> Loading stash…
          </p>
        ) : (
          <div className="mx-auto max-w-5xl">
            <PatchFiles patch={patch} />
          </div>
        )}
      </div>
    </div>
  )
}
