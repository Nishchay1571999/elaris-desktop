import { FileDiff, Files, FolderOpen } from "lucide-react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { type RightTab, useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

import { ChangesList } from "./changes-list"
import { FileTree } from "./file-tree"

export function RightPanel() {
  const { info, changes, error, pickAndOpen } = useWorkspace()
  const tab = useUi((s) => s.rightTab)
  const setTab = useUi((s) => s.setRightTab)

  return (
    <aside aria-label="Workspace" className="flex h-full flex-col bg-sidebar">
      <div role="tablist" className="flex h-11 shrink-0 items-center gap-1 px-2">
        <TabButton id="changes" active={tab === "changes"} onSelect={setTab}>
          <FileDiff className="size-3.5" /> Changes
          {changes.length > 0 && (
            <span className="rounded-full bg-brand-soft px-1.5 text-[10px] text-brand">{changes.length}</span>
          )}
        </TabButton>
        <TabButton id="files" active={tab === "files"} onSelect={setTab}>
          <Files className="size-3.5" /> Files
        </TabButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!info ? (
          <div className="flex flex-col items-center gap-3 px-6 pt-16 text-center">
            <p className="text-sm text-muted-foreground">Open a folder to browse its files and changes.</p>
            <Button onClick={() => void pickAndOpen()} className="border border-border-strong text-foreground">
              <FolderOpen className="size-3.5" /> Open folder
            </Button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : tab === "files" ? (
          <FileTree />
        ) : (
          <ChangesList />
        )}
      </div>
    </aside>
  )
}

function TabButton({
  id,
  active,
  onSelect,
  children,
}: {
  id: RightTab
  active: boolean
  onSelect: (tab: RightTab) => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={() => onSelect(id)}
      className={cn(
        "flex h-7 items-center gap-1.5 rounded-md px-2 text-[13px] text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
        active && "bg-sidebar-selected text-foreground",
      )}
    >
      {children}
    </button>
  )
}
