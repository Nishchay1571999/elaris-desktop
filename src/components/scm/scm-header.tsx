import {
  Check,
  Ellipsis,
  GitFork,
  ListTree,
  List,
  LoaderCircle,
  RefreshCw,
} from "lucide-react"

import { IconButton } from "@/components/ui/button"
import {
  Menu,
  MenuCheckItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSub,
  MenuSubContent,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu"
import * as act from "@/lib/scm-actions"
import { changeCount } from "@/lib/scm"
import { useScm } from "@/stores/scm"

/**
 * The Source Control title row: change count, quick actions, and the `…`
 * menu laid out as VS Code's (View & Sort, Pull/Push, Commit, Changes,
 * Branch, Remote, Stash, Tags, graph and output).
 */
export function ScmHeader({ isGit }: { isGit: boolean }) {
  const status = useScm((s) => s.status)
  const busy = useScm((s) => s.busy)
  const count = changeCount(status)

  return (
    <div className="flex h-11 shrink-0 items-center gap-0.5 pr-2 pl-4">
      <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-[13px] text-foreground">
        <span className="truncate">Source Control</span>
        {count > 0 && <span className="rounded-full bg-brand-soft px-1.5 text-[10px] text-brand tabular-nums">{count}</span>}
      </h2>
      {isGit && (
        <>
          <IconButton label="Commit" disabled={!!busy || count === 0} onClick={() => void useScm.getState().commit()}>
            <Check className="size-3.5" />
          </IconButton>
          <IconButton label="Refresh" disabled={!!busy} onClick={() => void useScm.getState().refresh()}>
            {busy ? <LoaderCircle className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />}
          </IconButton>
          <IconButton label="Show commit graph" onClick={act.showGraph}>
            <GitFork className="size-3.5" />
          </IconButton>
        </>
      )}
      <ScmMenu isGit={isGit} />
    </div>
  )
}

function ScmMenu({ isGit }: { isGit: boolean }) {
  const viewMode = useScm((s) => s.viewMode)
  const sortBy = useScm((s) => s.sortBy)
  const status = useScm((s) => s.status)
  const busy = !!useScm((s) => s.busy)
  const { setViewMode, setSortBy, commit, stageAll, unstageAll, discardAll } = useScm.getState()
  const operation = status?.operation
  const hasBranch = !!status?.branch

  return (
    <Menu>
      <MenuTrigger asChild>
        <IconButton label="More actions">
          <Ellipsis className="size-4" />
        </IconButton>
      </MenuTrigger>
      <MenuContent align="end" className="min-w-56">
        {!isGit ? (
          <MenuItem onSelect={() => void act.cloneRepository()}>Clone…</MenuItem>
        ) : (
          <>
            <MenuItem onSelect={() => setViewMode(viewMode === "tree" ? "list" : "tree")}>
              {viewMode === "tree" ? <List /> : <ListTree />}
              {viewMode === "tree" ? "View as List" : "View as Tree"}
            </MenuItem>
            <MenuSub>
              <MenuSubTrigger>View & Sort</MenuSubTrigger>
              <MenuSubContent>
                <MenuCheckItem checked={viewMode === "list"} onSelect={() => setViewMode("list")}>
                  View as List
                </MenuCheckItem>
                <MenuCheckItem checked={viewMode === "tree"} onSelect={() => setViewMode("tree")}>
                  View as Tree
                </MenuCheckItem>
                <MenuSeparator />
                <MenuCheckItem checked={sortBy === "name"} onSelect={() => setSortBy("name")}>
                  Sort by Name
                </MenuCheckItem>
                <MenuCheckItem checked={sortBy === "path"} onSelect={() => setSortBy("path")}>
                  Sort by Path
                </MenuCheckItem>
                <MenuCheckItem checked={sortBy === "status"} onSelect={() => setSortBy("status")}>
                  Sort by Status
                </MenuCheckItem>
              </MenuSubContent>
            </MenuSub>
            <MenuSeparator />
            <MenuItem disabled={busy} onSelect={() => void act.pull()}>
              Pull
            </MenuItem>
            <MenuItem disabled={busy || !hasBranch} onSelect={() => void act.push()}>
              Push
            </MenuItem>
            <MenuItem disabled={busy} onSelect={() => void act.cloneRepository()}>
              Clone…
            </MenuItem>
            <MenuItem disabled={busy} onSelect={() => void act.checkoutTo()}>
              Checkout to…
            </MenuItem>
            <MenuItem disabled={busy} onSelect={() => void act.fetch()}>
              Fetch
            </MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={() => void act.addCoAuthorsToMessage()}>Add Co-authors…</MenuItem>
            <MenuSeparator />

            <MenuSub>
              <MenuSubTrigger>Commit</MenuSubTrigger>
              <MenuSubContent className="min-w-56">
                <MenuItem disabled={busy} onSelect={() => void commit()}>
                  Commit
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void commit({ stagedOnly: true })}>
                  Commit Staged
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void commit({ all: true })}>
                  Commit All
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.undoLastCommit()}>
                  Undo Last Commit
                </MenuItem>
                {operation === "rebase" && (
                  <MenuItem disabled={busy} onSelect={() => void act.abortOperation()}>
                    Abort Rebase
                  </MenuItem>
                )}
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void commit({ stagedOnly: true, amend: true })}>
                  Commit Staged (Amend)
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void commit({ all: true, amend: true })}>
                  Commit All (Amend)
                </MenuItem>
                <MenuItem onSelect={() => void act.editLastMessage()}>Edit Last Commit Message</MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void commit({ stagedOnly: true, signoff: true })}>
                  Commit Staged (Signed Off)
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void commit({ all: true, signoff: true })}>
                  Commit All (Signed Off)
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void commit({ noVerify: true })}>
                  Commit (No Verify)
                </MenuItem>
              </MenuSubContent>
            </MenuSub>

            <MenuSub>
              <MenuSubTrigger>Changes</MenuSubTrigger>
              <MenuSubContent>
                <MenuItem disabled={busy} onSelect={() => void stageAll()}>
                  Stage All Changes
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void unstageAll()}>
                  Unstage All Changes
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void discardAll()}>
                  Discard All Changes
                </MenuItem>
              </MenuSubContent>
            </MenuSub>

            <MenuSub>
              <MenuSubTrigger>Pull, Push</MenuSubTrigger>
              <MenuSubContent>
                <MenuItem disabled={busy} onSelect={() => void act.sync()}>
                  Sync
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void act.pull()}>
                  Pull
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.pull(true)}>
                  Pull (Rebase)
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.pullFrom()}>
                  Pull from…
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy || !hasBranch} onSelect={() => void act.push()}>
                  Push
                </MenuItem>
                <MenuItem disabled={busy || !hasBranch} onSelect={() => void act.pushTo()}>
                  Push to…
                </MenuItem>
                <MenuItem disabled={busy || !hasBranch} onSelect={() => void act.forcePush()}>
                  Force Push
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void act.fetch()}>
                  Fetch
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.fetch({ prune: true })}>
                  Fetch (Prune)
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.fetch({ all: true })}>
                  Fetch From All Remotes
                </MenuItem>
              </MenuSubContent>
            </MenuSub>

            <MenuSub>
              <MenuSubTrigger>Branch</MenuSubTrigger>
              <MenuSubContent>
                <MenuItem disabled={busy} onSelect={() => void act.mergeBranch()}>
                  Merge…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.rebaseBranch()}>
                  Rebase Branch…
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void act.createBranch()}>
                  Create Branch…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.createBranchFrom()}>
                  Create Branch From…
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy || !hasBranch} onSelect={() => void act.renameBranch()}>
                  Rename Branch…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.deleteBranch()}>
                  Delete Branch…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.deleteRemoteBranch()}>
                  Delete Remote Branch…
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy || !hasBranch || !!status?.upstream} onSelect={() => void act.publishBranch()}>
                  Publish Branch…
                </MenuItem>
              </MenuSubContent>
            </MenuSub>

            <MenuSub>
              <MenuSubTrigger>Remote</MenuSubTrigger>
              <MenuSubContent>
                <MenuItem disabled={busy} onSelect={() => void act.addRemote()}>
                  Add Remote…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.renameRemote()}>
                  Rename Remote…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.removeRemote()}>
                  Remove Remote…
                </MenuItem>
              </MenuSubContent>
            </MenuSub>

            <MenuSub>
              <MenuSubTrigger>Stash</MenuSubTrigger>
              <MenuSubContent className="min-w-56">
                <MenuItem disabled={busy} onSelect={() => void act.stash()}>
                  Stash
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.stash({ includeUntracked: true })}>
                  Stash (Include Untracked)
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.stash({ staged: true })}>
                  Stash Staged
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void act.applyStash(false, true)}>
                  Apply Latest Stash
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.applyStash(false)}>
                  Apply Stash…
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void act.applyStash(true, true)}>
                  Pop Latest Stash
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.applyStash(true)}>
                  Pop Stash…
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void act.dropStash()}>
                  Drop Stash…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.dropAllStashes()}>
                  Drop All Stashes…
                </MenuItem>
                <MenuSeparator />
                <MenuItem onSelect={() => void act.viewStash()}>View Stash…</MenuItem>
              </MenuSubContent>
            </MenuSub>

            <MenuSub>
              <MenuSubTrigger>Tags</MenuSubTrigger>
              <MenuSubContent>
                <MenuItem disabled={busy} onSelect={() => void act.createTag()}>
                  Create Tag…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.deleteTag()}>
                  Delete Tag…
                </MenuItem>
                <MenuItem disabled={busy} onSelect={() => void act.deleteRemoteTag()}>
                  Delete Remote Tag…
                </MenuItem>
                <MenuSeparator />
                <MenuItem disabled={busy} onSelect={() => void act.pushTags()}>
                  Push Tags
                </MenuItem>
              </MenuSubContent>
            </MenuSub>

            <MenuSeparator />
            <MenuItem onSelect={act.showGraph}>Show Commit Graph</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={act.showOutput}>Show Git Output</MenuItem>
          </>
        )}
      </MenuContent>
    </Menu>
  )
}
