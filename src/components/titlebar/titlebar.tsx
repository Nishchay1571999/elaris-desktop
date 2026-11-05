import { ArrowLeft, ArrowRight, GitBranch, PanelLeft, PanelRight } from "lucide-react"

import { ProjectLogo } from "@/components/workspace/project-logo"
import { WorkspaceMenu } from "@/components/workspace/workspace-menu"
import { IconButton } from "@/components/ui/button"
import { useBinding } from "@/lib/commands"
import { formatBinding } from "@/lib/keybindings"
import { cn, isMac } from "@/lib/utils"
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
      </div>

      <IconButton
        label={`${rightOpen ? "Hide" : "Show"} files panel${rightKey && ` (${rightKey})`}`}
        onClick={() => setRightOpen(!rightOpen)}
      >
        <PanelRight className="size-4" />
      </IconButton>
    </header>
  )
}
