import { FileDiff, FolderOpen } from "lucide-react"

import { Button } from "@/components/ui/button"
import { useWorkspace } from "@/stores/workspace"

import { ChangesList } from "./changes-list"
import { CommitBox } from "./commit-box"

export function RightPanel() {
  const { info, changes, error, pickAndOpen } = useWorkspace()

  return (
    <aside aria-label="Workspace" className="flex h-full flex-col bg-sidebar">
      <div className="flex h-11 shrink-0 items-center gap-1 px-2">
        <h2 className="flex h-7 items-center gap-1.5 px-2 text-[13px] text-foreground">
          <FileDiff className="size-3.5" /> Changes
          {changes.length > 0 && (
            <span className="rounded-full bg-brand-soft px-1.5 text-[10px] text-brand">{changes.length}</span>
          )}
        </h2>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!info ? (
          <div className="flex flex-col items-center gap-3 px-6 pt-16 text-center">
            <p className="text-sm text-muted-foreground">Open a folder to see its changes.</p>
            <Button onClick={() => void pickAndOpen()} className="border border-border-strong text-foreground">
              <FolderOpen className="size-3.5" /> Open folder
            </Button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </div>
        ) : (
          <>
            {info.isGit && <CommitBox />}
            <ChangesList />
          </>
        )}
      </div>
    </aside>
  )
}
