import { ArrowUpFromLine, Check, ChevronDown, GitPullRequestCreate, LoaderCircle } from "lucide-react"
import { useState } from "react"

import { useCreatePr } from "@/components/pulls/create-pr-dialog"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { errorMessage, ipc } from "@/lib/ipc"
import { cn, isMac } from "@/lib/utils"
import { useGitHub } from "@/stores/github"
import { useWorkspace } from "@/stores/workspace"

/**
 * Commits every change in the folder, from the top of the Changes tab, with
 * "Commit & push" and "Commit & open PR" one click away.
 */
export function CommitBox() {
  const changes = useWorkspace((s) => s.changes)
  const branch = useWorkspace((s) => s.info?.branch)
  const [message, setMessage] = useState("")
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const createPr = useCreatePr()

  const run = async (then: "commit" | "push" | "pr") => {
    if (!message.trim() || busy) return
    setError(null)
    setBusy(then === "commit" ? "Committing…" : "Committing and pushing…")
    try {
      const sha = await ipc.git.commit(message.trim(), null)
      if (then === "push") await ipc.git.push()
      setMessage("")
      setDone(then === "push" ? `Committed ${sha} and pushed` : `Committed ${sha}`)
      setTimeout(() => setDone(null), 3000)
      await useWorkspace.getState().refreshInfo()
      if (then === "push") void useGitHub.getState().refreshBranchPr()
      if (then === "pr") await createPr()
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(null)
    }
  }

  if (changes.length === 0 && !done) return null

  return (
    <div className="border-b border-border p-2">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey)) {
            e.preventDefault()
            void run(e.shiftKey ? "push" : "commit")
          }
        }}
        rows={2}
        placeholder={`Commit message (${isMac ? "⌘" : "Ctrl+"}↩ to commit${branch ? ` on ${branch}` : ""})`}
        aria-label="Commit message"
        className="block w-full resize-none rounded-md border border-input bg-surface-sunken px-2 py-1.5 text-[13px] outline-none placeholder:text-subtle-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="mt-1.5 flex items-center">
        <button
          type="button"
          disabled={!message.trim() || !!busy || changes.length === 0}
          onClick={() => void run("commit")}
          className="flex h-7 flex-1 items-center justify-center gap-1.5 rounded-l-md bg-brand text-xs font-medium text-brand-foreground outline-none hover:bg-brand/90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:bg-muted disabled:text-subtle-foreground"
        >
          {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
          {busy ?? `Commit ${changes.length} file${changes.length === 1 ? "" : "s"}`}
        </button>
        <Menu>
          <MenuTrigger asChild disabled={!message.trim() || !!busy || changes.length === 0}>
            <button
              type="button"
              aria-label="More commit options"
              className="flex h-7 items-center rounded-r-md border-l border-brand-foreground/20 bg-brand px-1.5 text-brand-foreground outline-none hover:bg-brand/90 disabled:border-border disabled:bg-muted disabled:text-subtle-foreground"
            >
              <ChevronDown className="size-3.5" />
            </button>
          </MenuTrigger>
          <MenuContent align="end">
            <MenuItem onSelect={() => void run("push")}>
              <ArrowUpFromLine /> Commit & push
            </MenuItem>
            <MenuItem onSelect={() => void run("pr")}>
              <GitPullRequestCreate /> Commit & open pull request…
            </MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {done && <p className="mt-1.5 text-xs text-git-added">{done}</p>}
      {error && <p className={cn("selectable mt-1.5 text-xs text-destructive")}>{error}</p>}
    </div>
  )
}
