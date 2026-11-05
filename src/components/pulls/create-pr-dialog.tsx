import { GitBranchPlus, GitPullRequestCreate, LoaderCircle } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { create } from "zustand"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog"
import { Select } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { changeColor } from "@/components/workspace/changes-list"
import { ipc } from "@/lib/ipc"
import { baseName, cn, parentDir } from "@/lib/utils"
import { useGitHub } from "@/stores/github"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

const useDialog = create<{ open: boolean }>()(() => ({ open: false }))

/**
 * Opens the new pull request dialog, or the connect dialog first when gh isn't
 * installed or signed in. If the branch already has an open PR, shows that instead.
 */
export function useCreatePr() {
  return async () => {
    const gh = useGitHub.getState()
    const status = gh.status ?? (await gh.refreshStatus())
    if (!status?.installed) return useGitHub.setState({ needsSetup: "not-installed" })
    if (!status.user) return useGitHub.setState({ needsSetup: "not-signed-in" })
    useDialog.setState({ open: true })
  }
}

export function CreatePrDialog() {
  const open = useDialog((s) => s.open)
  const setOpen = (open: boolean) => useDialog.setState({ open })
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[85vh] w-[min(94vw,40rem)] flex-col p-0" aria-describedby={undefined}>
        {open && <CreatePr close={() => setOpen(false)} />}
      </DialogContent>
    </Dialog>
  )
}

function CreatePr({ close }: { close: () => void }) {
  const info = useWorkspace((s) => s.info)
  const changes = useWorkspace((s) => s.changes)
  const repo = useGitHub((s) => s.repo)
  const branchPr = useGitHub((s) => s.branchPr)
  const defaultBase = repo?.defaultBranchRef?.name ?? info?.defaultBranch ?? "main"

  const [bases, setBases] = useState<string[]>([defaultBase])
  const [base, setBase] = useState(defaultBase)
  const onBase = info?.branch === base || !info?.branch
  const [newBranch, setNewBranch] = useState("")
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [draft, setDraft] = useState(false)
  const [picked, setPicked] = useState<Record<string, boolean>>(() => Object.fromEntries(changes.map((c) => [c.path, true])))
  const [commitMessage, setCommitMessage] = useState("")
  const [step, setStep] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (repo === undefined) void useGitHub.getState().refreshRepo()
    ipc.git
      .branches()
      .then((b) => setBases([...new Set([defaultBase, ...b.local, ...b.remote.map((r) => r.replace(/^origin\//, ""))])]))
      .catch(() => {})
  }, [defaultBase, repo])

  // Prefill from the branch's commits: one commit gives its subject and body; several, a list.
  useEffect(() => {
    if (onBase) return
    ipc.git
      .logRange(base)
      .then((commits) => {
        if (commits.length === 0) return
        setTitle((t) => t || commits[0].subject)
        setBody((b) => b || (commits.length === 1 ? commits[0].body : commits.map((c) => `- ${c.subject}`).join("\n")))
      })
      .catch(() => {})
  }, [base, onBase])

  const selected = useMemo(() => changes.filter((c) => picked[c.path]).map((c) => c.path), [changes, picked])
  const committing = selected.length > 0

  if (branchPr) {
    return (
      <Shell title="Pull request already open">
        <p className="px-5 py-4 text-[13px] text-muted-foreground">
          {info?.branch} already has #{branchPr.number}: “{branchPr.title}”. Push new commits to update it.
        </p>
        <Footer>
          <Button onClick={close}>Close</Button>
          <Button
            className={PRIMARY}
            onClick={() => {
              close()
              useUi.getState().navigate({ view: { kind: "pulls", number: branchPr.number } })
            }}
          >
            Open #{branchPr.number}
          </Button>
        </Footer>
      </Shell>
    )
  }

  const submit = async () => {
    setError(null)
    try {
      if (onBase) {
        if (!newBranch.trim()) throw new Error(`Name a new branch: pull requests can't come from ${base} itself`)
        setStep("Creating branch…")
        await ipc.git.createBranch(newBranch.trim())
      }
      if (committing) {
        setStep("Committing…")
        await ipc.git.commit(commitMessage.trim() || title.trim(), selected)
      }
      setStep("Pushing and opening the pull request…")
      const created = await ipc.github.createPr({ title, body, base, draft })
      await Promise.all([useWorkspace.getState().refreshInfo(), useGitHub.getState().refreshBranchPr()])
      close()
      if (created.number) useUi.getState().navigate({ view: { kind: "pulls", number: created.number } })
      else void ipc.openUrl(created.url)
    } catch (e) {
      setError(e instanceof Error ? e.message : useGitHub.getState().handleError(e))
      await useWorkspace.getState().refreshInfo()
    } finally {
      setStep(null)
    }
  }

  return (
    <Shell title="New pull request">
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        <div className="flex flex-wrap items-center gap-2 text-[13px] text-muted-foreground">
          Merge
          {onBase ? (
            <label className="flex items-center gap-1.5">
              <GitBranchPlus className="size-3.5" />
              <input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value.replace(/\s+/g, "-"))}
                placeholder="new-branch-name"
                aria-label="New branch"
                className="h-7 w-48 rounded-md border border-input bg-surface-sunken px-2 font-mono text-xs text-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              />
            </label>
          ) : (
            <code className="rounded bg-brand-soft px-1.5 py-0.5 font-mono text-xs text-brand">{info?.branch}</code>
          )}
          into
          <Select label="Base branch" value={base} onChange={setBase} options={bases.map((b) => ({ value: b, label: b }))} />
        </div>
        {onBase && (
          <p className="-mt-2 text-xs text-subtle-foreground">
            You're on {base}. A new branch is made from here, keeping your changes, and the pull request comes from it.
          </p>
        )}

        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Title"
          aria-label="Title"
          autoFocus
          className="h-9 rounded-lg border border-input bg-surface-sunken px-3 text-sm outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder="Describe the change (Markdown)…"
          aria-label="Description"
          rows={7}
          className="resize-y rounded-lg border border-input bg-surface-sunken px-3 py-2 text-[13px] leading-relaxed outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <label className="flex items-center gap-2 text-[13px]">
          <Switch checked={draft} onCheckedChange={setDraft} aria-label="Draft" />
          Open as a draft
        </label>

        {changes.length > 0 && (
          <section className="rounded-xl border border-border">
            <header className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs">
              <span className="flex-1 font-medium">Uncommitted changes</span>
              <button
                type="button"
                className="text-muted-foreground hover:text-foreground"
                onClick={() => setPicked(Object.fromEntries(changes.map((c) => [c.path, selected.length < changes.length])))}
              >
                {selected.length < changes.length ? "Select all" : "Select none"}
              </button>
            </header>
            <ul className="max-h-40 overflow-y-auto py-1 text-[13px]">
              {changes.map((change) => (
                <li key={change.path}>
                  <label className="flex h-6 cursor-pointer items-center gap-2 px-3 hover:bg-muted/60">
                    <input
                      type="checkbox"
                      checked={!!picked[change.path]}
                      onChange={(e) => setPicked((p) => ({ ...p, [change.path]: e.target.checked }))}
                      className="accent-(--brand)"
                    />
                    <span className={cn("truncate", changeColor(change.kind))}>{baseName(change.path)}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-subtle-foreground">{parentDir(change.path)}</span>
                  </label>
                </li>
              ))}
            </ul>
            {committing && (
              <div className="border-t border-border p-2">
                <input
                  value={commitMessage}
                  onChange={(e) => setCommitMessage(e.target.value)}
                  placeholder={title ? `Commit message (defaults to the title)` : "Commit message"}
                  aria-label="Commit message"
                  className="h-7 w-full rounded-md bg-transparent px-1.5 text-[13px] outline-none placeholder:text-subtle-foreground"
                />
              </div>
            )}
          </section>
        )}

        {error && <p className="selectable text-xs text-destructive">{error}</p>}
      </div>
      <Footer>
        {step && (
          <span className="mr-auto flex items-center gap-1.5 text-xs text-muted-foreground">
            <LoaderCircle className="size-3.5 animate-spin" /> {step}
          </span>
        )}
        <Button onClick={close} disabled={!!step}>
          Cancel
        </Button>
        <Button
          className={PRIMARY}
          disabled={!!step || !title.trim() || (onBase && !newBranch.trim()) || (committing && !(commitMessage.trim() || title.trim()))}
          onClick={() => void submit()}
        >
          <GitPullRequestCreate className="size-3.5" />
          {committing ? "Commit and open pull request" : draft ? "Open draft" : "Open pull request"}
        </Button>
      </Footer>
    </Shell>
  )
}

const PRIMARY = "h-7 gap-1.5 bg-brand px-3 text-brand-foreground hover:bg-brand/90 hover:text-brand-foreground"

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <>
      <header className="flex items-center gap-2 border-b border-border px-5 py-3.5">
        <GitPullRequestCreate className="size-4 text-brand" />
        <DialogTitle className="text-sm font-semibold">{title}</DialogTitle>
        <DialogDescription className="sr-only">Push this branch and open a pull request on GitHub</DialogDescription>
      </header>
      {children}
    </>
  )
}

function Footer({ children }: { children: React.ReactNode }) {
  return <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border px-5 py-3">{children}</footer>
}
