import { ArrowDownUp, ArrowLeft, ArrowRight, CloudUpload, GitBranch, LoaderCircle, PanelLeft, PanelRight } from "lucide-react"

import { ProjectLogo } from "@/components/workspace/project-logo"
import { WorkspaceMenu } from "@/components/workspace/workspace-menu"
import { IconButton } from "@/components/ui/button"
import { useBinding } from "@/lib/commands"
import { publishBranch, sync } from "@/lib/scm-actions"
import { formatBinding } from "@/lib/keybindings"
import { cn, isMac } from "@/lib/utils"
import { useScm } from "@/stores/scm"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

/**
 * The window's title bar. On macOS the native one is hidden behind this
 * (titleBarStyle: Overlay), so empty areas carry `data-tauri-drag-region`.
 */
export function Titlebar() {
  const { leftOpen, rightOpen, index, history, back, forward, setLeftOpen, setRightOpen } = useUi()
  const info = useWorkspace((s) => s.info)
  const sidebarKey = formatBinding(useBinding("view.sidebar"))
  const rightKey = formatBinding(useBinding("view.rightPanel"))

  return (
    <header
      data-tauri-drag-region
      className={cn("flex h-10 shrink-0 items-center gap-1 border-b border-border pr-2", isMac ? "pl-20" : "pl-2")}
    >
      <IconButton
        label={`${leftOpen ? "Hide" : "Show"} sidebar${sidebarKey && ` (${sidebarKey})`}`}
        onClick={() => setLeftOpen(!leftOpen)}
      >
        <PanelLeft className="size-4" />
      </IconButton>

      <div data-tauri-drag-region className="flex flex-1 items-center justify-center gap-1">
        <IconButton label="Back" onClick={back} disabled={index === 0}>
          <ArrowLeft className="size-4" />
        </IconButton>
        <IconButton label="Forward" onClick={forward} disabled={index >= history.length - 1}>
          <ArrowRight className="size-4" />
        </IconButton>

        <WorkspaceMenu align="center">
          <button
            type="button"
            className="flex h-7 w-full max-w-[560px] min-w-64 items-center gap-2 rounded-md border border-border bg-surface-sunken px-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:border-border-strong hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
          >
            {info ? (
              <>
                <ProjectLogo root={info.root} />
                <span className="truncate text-foreground">{info.name}</span>
                {info.branch && (
                  <span className="flex items-center gap-1 text-xs text-subtle-foreground">
                    <GitBranch className="size-3" />
                    {info.branch}
                  </span>
                )}
              </>
            ) : (
              <span>Open a folder…</span>
            )}
          </button>
        </WorkspaceMenu>
        <SyncStatus />
      </div>

      <IconButton
        label={`${rightOpen ? "Hide" : "Show"} Source Control${rightKey && ` (${rightKey})`}`}
        onClick={() => setRightOpen(!rightOpen)}
      >
        <PanelRight className="size-4" />
      </IconButton>
    </header>
  )
}

/**
 * Where the branch stands against its remote, like VS Code's status bar:
 * `2↓ 1↑` syncs on click, and a branch with no upstream offers to publish.
 */
function SyncStatus() {
  const status = useScm((s) => s.status)
  const busy = useScm((s) => s.busy)
  if (!status?.branch) return null
  const base =
    "flex h-7 shrink-0 items-center gap-1 rounded-md px-1.5 text-xs text-subtle-foreground tabular-nums outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none"
  if (busy) {
    return (
      <span className={base} title={busy.progress ?? busy.label}>
        <LoaderCircle className="size-3 animate-spin" />
      </span>
    )
  }
  if (!status.upstream) {
    return (
      <button type="button" title="Publish branch" aria-label="Publish branch" onClick={() => void publishBranch()} className={base}>
        <CloudUpload className="size-3.5" />
      </button>
    )
  }
  const label = `Sync: ${status.behind} to pull, ${status.ahead} to push`
  return (
    <button type="button" title={label} aria-label={label} onClick={() => void sync()} className={base}>
      <ArrowDownUp className="size-3" />
      {(status.behind > 0 || status.ahead > 0) && (
        <span>
          {status.behind}↓ {status.ahead}↑
        </span>
      )}
    </button>
  )
}
