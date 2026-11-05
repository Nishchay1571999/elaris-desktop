import { FolderGit2, FolderOpen, GitBranchPlus } from "lucide-react"

import { ScmCommitBox } from "@/components/scm/scm-commit-box"
import { ScmFileList } from "@/components/scm/scm-file-list"
import { ScmHeader } from "@/components/scm/scm-header"
import { Button } from "@/components/ui/button"
import { ipc } from "@/lib/ipc"
import * as act from "@/lib/scm-actions"
import { changeCount } from "@/lib/scm"
import { useScm } from "@/stores/scm"
import { useWorkspace } from "@/stores/workspace"

/** The right-hand panel: Source Control for the open folder. */
export function RightPanel() {
  const { info, error, pickAndOpen } = useWorkspace()
  const status = useScm((s) => s.status)

  return (
    <aside aria-label="Source Control" className="flex h-full flex-col bg-sidebar">
      <ScmHeader isGit={!!info?.isGit} />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!info ? (
          <Empty text="Open a folder to see its changes.">
            <Button onClick={() => void pickAndOpen()} className="border border-border-strong text-foreground">
              <FolderOpen className="size-3.5" /> Open folder
            </Button>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </Empty>
        ) : !info.isGit ? (
          <Empty text="This folder isn't a git repository yet.">
            <Button
              onClick={() => void useScm.getState().run("Initializing repository…", () => ipc.git.init())}
              className="border border-border-strong text-foreground"
            >
              <FolderGit2 className="size-3.5" /> Initialize Repository
            </Button>
            <Button onClick={() => void act.cloneRepository()} className="border border-border-strong text-foreground">
              <GitBranchPlus className="size-3.5" /> Clone Repository
            </Button>
          </Empty>
        ) : !status ? null : (
          <>
            <ScmCommitBox status={status} />
            {changeCount(status) === 0 ? (
              <p className="px-4 py-3 text-xs text-subtle-foreground">No changes.</p>
            ) : (
              <ScmFileList status={status} />
            )}
          </>
        )}
      </div>
    </aside>
  )
}

function Empty({ text, children }: { text: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 pt-16 text-center">
      <p className="text-sm text-muted-foreground">{text}</p>
      {children}
    </div>
  )
}
