import {
  ArrowDownUp,
  ArrowUpFromLine,
  Check,
  ChevronDown,
  CloudUpload,
  GitPullRequestCreate,
  LoaderCircle,
  Play,
  X,
} from "lucide-react"
import type { ReactNode } from "react"

import type { ScmStatus } from "@/bindings/ScmStatus"
import { useCreatePr } from "@/components/pulls/create-pr-dialog"
import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@/components/ui/menu"
import * as act from "@/lib/scm-actions"
import { changeCount } from "@/lib/scm"
import { cn, isMac } from "@/lib/utils"
import { useGitHub } from "@/stores/github"
import { type CommitMode, useScm } from "@/stores/scm"

const OPERATION_NAME = { merge: "Merge", rebase: "Rebase", "cherry-pick": "Cherry-pick", revert: "Revert" } as const

/**
 * The message box and the one button that matters right now, as in VS Code:
 * Commit when there are changes, Continue during a merge or rebase, Publish
 * Branch when it has no upstream, and Sync Changes when it's ahead or behind.
 */
export function ScmCommitBox({ status }: { status: ScmStatus }) {
  const message = useScm((s) => s.message)
  const setMessage = useScm((s) => s.setMessage)
  const busy = useScm((s) => s.busy)
  const createPr = useCreatePr()
  const count = changeCount(status)
  const where = status.branch ?? (status.detached ? `detached ${status.detached}` : "HEAD")

  const commit = async (mode: CommitMode = {}, openPr = false) => {
    const sha = await useScm.getState().commit(mode)
    if (sha && mode.then) void useGitHub.getState().refreshBranchPr()
    if (sha && openPr) await createPr()
  }

  return (
    <div className="border-b border-border px-2 pb-2">
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (isMac ? e.metaKey : e.ctrlKey)) {
            e.preventDefault()
            void commit(e.shiftKey ? { then: "push" } : {})
          }
        }}
        rows={Math.min(8, Math.max(2, message.split("\n").length))}
        placeholder={`Message (${isMac ? "⌘" : "Ctrl+"}↩ to commit on "${where}")`}
        aria-label="Commit message"
        className="block w-full resize-none rounded-md border border-input bg-surface-sunken px-2 py-1.5 text-[13px] outline-none placeholder:text-subtle-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      />
      <div className="mt-1.5">
        <PrimaryAction status={status} count={count} busy={!!busy} onCommit={commit} />
      </div>
      {busy && (
        <p className="mt-1.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle className="size-3 shrink-0 animate-spin" />
          <span className="shrink-0">{busy.label}</span>
          {busy.progress && <span className="min-w-0 truncate font-mono text-[11px] text-subtle-foreground">{busy.progress}</span>}
        </p>
      )}
    </div>
  )
}

function PrimaryAction({
  status,
  count,
  busy,
  onCommit,
}: {
  status: ScmStatus
  count: number
  busy: boolean
  onCommit: (mode?: CommitMode, openPr?: boolean) => Promise<void>
}) {
  const message = useScm((s) => s.message)

  if (status.operation) {
    const name = OPERATION_NAME[status.operation]
    const unresolved = status.conflicted.length > 0
    return (
      <SplitButton
        label={unresolved ? `Resolve ${status.conflicted.length} conflict${status.conflicted.length === 1 ? "" : "s"} to continue` : `Continue ${name}`}
        icon={<Play className="size-3.5" />}
        disabled={busy || unresolved}
        onClick={() => void act.continueOperation()}
        menu={
          <MenuItem onSelect={() => void act.abortOperation()}>
            <X /> Abort {name}
          </MenuItem>
        }
      />
    )
  }

  if (count > 0) {
    const noMessage = !message.trim()
    return (
      <SplitButton
        label={status.staged.length > 0 ? `Commit ${status.staged.length} staged` : "Commit"}
        icon={<Check className="size-3.5" />}
        disabled={busy || noMessage}
        onClick={() => void onCommit()}
        menuDisabled={busy}
        menu={
          <>
            <MenuItem disabled={noMessage} onSelect={() => void onCommit({ then: "push" })}>
              <ArrowUpFromLine /> Commit & Push
            </MenuItem>
            <MenuItem disabled={noMessage} onSelect={() => void onCommit({ then: "sync" })}>
              <ArrowDownUp /> Commit & Sync
            </MenuItem>
            <MenuItem disabled={noMessage} onSelect={() => void onCommit({ then: "push" }, true)}>
              <GitPullRequestCreate /> Commit & Open Pull Request…
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => void onCommit({ amend: true, stagedOnly: true })}>Commit Staged (Amend)</MenuItem>
            <MenuItem disabled={noMessage} onSelect={() => void onCommit({ all: true })}>
              Commit All
            </MenuItem>
          </>
        }
      />
    )
  }

  if (status.branch && !status.upstream) {
    return (
      <SplitButton
        label="Publish Branch"
        icon={<CloudUpload className="size-3.5" />}
        disabled={busy}
        onClick={() => void act.publishBranch()}
      />
    )
  }

  if (status.ahead > 0 || status.behind > 0) {
    return (
      <SplitButton
        label={`Sync Changes ${status.behind ? `${status.behind}↓ ` : ""}${status.ahead ? `${status.ahead}↑` : ""}`.trim()}
        icon={<ArrowDownUp className="size-3.5" />}
        disabled={busy}
        onClick={() => void act.sync()}
        menu={
          <>
            <MenuItem onSelect={() => void act.pull()}>Pull</MenuItem>
            <MenuItem onSelect={() => void act.pull(true)}>Pull (Rebase)</MenuItem>
            <MenuItem disabled={status.ahead === 0} onSelect={() => void act.push()}>
              Push
            </MenuItem>
          </>
        }
      />
    )
  }

  return <SplitButton label="Commit" icon={<Check className="size-3.5" />} disabled onClick={() => {}} />
}

function SplitButton({
  label,
  icon,
  disabled,
  onClick,
  menu,
  menuDisabled = disabled,
}: {
  label: string
  icon: ReactNode
  disabled: boolean
  onClick: () => void
  menu?: ReactNode
  menuDisabled?: boolean
}) {
  return (
    <div className="flex items-center">
      <button
        type="button"
        disabled={disabled}
        onClick={onClick}
        className={cn(
          "flex h-7 min-w-0 flex-1 items-center justify-center gap-1.5 bg-brand px-2 text-xs font-medium text-brand-foreground outline-none hover:bg-brand/90 focus-visible:ring-3 focus-visible:ring-ring/50 disabled:bg-muted disabled:text-subtle-foreground",
          menu ? "rounded-l-md" : "rounded-md",
        )}
      >
        {icon}
        <span className="truncate">{label}</span>
      </button>
      {menu && (
        <Menu>
          <MenuTrigger asChild disabled={menuDisabled}>
            <button
              type="button"
              aria-label="More options"
              className="flex h-7 items-center rounded-r-md border-l border-brand-foreground/20 bg-brand px-1.5 text-brand-foreground outline-none hover:bg-brand/90 disabled:border-border disabled:bg-muted disabled:text-subtle-foreground"
            >
              <ChevronDown className="size-3.5" />
            </button>
          </MenuTrigger>
          <MenuContent align="end" className="min-w-56">
            {menu}
          </MenuContent>
        </Menu>
      )}
    </div>
  )
}
