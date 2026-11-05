import { create } from "zustand"
import { persist } from "zustand/middleware"

import type { ScmFile } from "@/bindings/ScmFile"
import type { ScmStatus } from "@/bindings/ScmStatus"
import { errorMessage, ipc } from "@/lib/ipc"
import { type SortBy, flatten, gitPaths } from "@/lib/scm"
import { useWorkspace } from "@/stores/workspace"

/** A long-running git command, for spinners and the progress line. */
export interface ScmBusy {
  /** What's happening, e.g. "Pushing…". */
  label: string
  /** git's latest progress line, e.g. `Writing objects:  45% (9/20)`. */
  progress: string | null
}

interface ScmState {
  /** `null` until loaded, or when the folder isn't a git repository. */
  status: ScmStatus | null
  busy: ScmBusy | null
  /** What's typed in the commit box; menus fill it (undo commit, co-authors). */
  message: string
  viewMode: "list" | "tree"
  sortBy: SortBy
  /**
   * With nothing staged, whether Commit stages everything first (VS Code's
   * smart commit). `null` until the user has answered once.
   */
  smartCommit: boolean | null

  setMessage: (message: string) => void
  setViewMode: (mode: "list" | "tree") => void
  setSortBy: (sortBy: SortBy) => void
  /** Re-reads git status; called on every file change the watcher reports. */
  refresh: () => Promise<void>
  /**
   * Runs one git action with a busy label, then refreshes. Failures go to the
   * error toast and resolve to `undefined`. One action at a time.
   */
  run: <T>(label: string, action: (progress: (line: string) => void) => Promise<T>) => Promise<T | undefined>

  stage: (files: ScmFile[]) => Promise<void>
  unstage: (files: ScmFile[]) => Promise<void>
  /** Asks first; untracked files go to the Trash. */
  discard: (files: ScmFile[]) => Promise<void>
  stageAll: () => Promise<void>
  unstageAll: () => Promise<void>
  discardAll: () => Promise<void>
  /** Commits what the commit box says; see `CommitMode`. Returns the short hash. */
  commit: (mode?: CommitMode) => Promise<string | undefined>
}

/** How Commit behaves; mirrors VS Code's Commit submenu. */
export interface CommitMode {
  /** Stage every change first, even with some staged. */
  all?: boolean
  /** Only what's staged, never asking to stage everything. */
  stagedOnly?: boolean
  amend?: boolean
  signoff?: boolean
  noVerify?: boolean
  /** Then push or sync. */
  then?: "push" | "sync"
}

let refreshSeq = 0

export const useScm = create<ScmState>()(
  persist(
    (set, get) => ({
      status: null,
      busy: null,
      message: "",
      viewMode: "list",
      sortBy: "path",
      smartCommit: null,

      setMessage: (message) => set({ message }),
      setViewMode: (viewMode) => set({ viewMode }),
      setSortBy: (sortBy) => set({ sortBy }),

      refresh: async () => {
        const seq = ++refreshSeq
        if (!useWorkspace.getState().info?.isGit) {
          set({ status: null })
          useWorkspace.setState({ changes: [] })
          return
        }
        try {
          const status = await ipc.git.scmStatus()
          // A slower, older read mustn't overwrite a newer one.
          if (seq !== refreshSeq) return
          set({ status })
          useWorkspace.setState({ changes: status ? flatten(status) : [] })
        } catch (error) {
          if (seq === refreshSeq) useWorkspace.setState({ error: errorMessage(error) })
        }
      },

      run: async (label, action) => {
        if (get().busy) return undefined
        set({ busy: { label, progress: null } })
        try {
          return await action((line) => set((s) => (s.busy ? { busy: { ...s.busy, progress: line } } : s)))
        } catch (error) {
          useWorkspace.setState({ error: errorMessage(error) })
          return undefined
        } finally {
          set({ busy: null })
          // Branch, upstream and changes may all have moved.
          await useWorkspace.getState().refreshInfo()
        }
      },

      stage: async (files) => {
        if (files.length) await get().run("Staging…", () => ipc.git.stage(gitPaths(files)))
      },
      unstage: async (files) => {
        if (files.length) await get().run("Unstaging…", () => ipc.git.unstage(gitPaths(files)))
      },
      discard: async (files) => {
        if (!files.length) return
        const untracked = files.every((f) => f.kind === "untracked")
        const what = files.length === 1 ? files[0].path : `${files.length} files`
        const message = untracked
          ? `Move ${what} to the Trash?`
          : `Discard changes to ${what}? This can't be undone; untracked files go to the Trash.`
        if (!(await ipc.dialog.confirm(message, "Discard changes", untracked ? "Move to Trash" : "Discard"))) return
        await get().run("Discarding…", () => ipc.git.discard(files.map((f) => f.path)))
      },
      stageAll: async () => {
        await get().run("Staging…", () => ipc.git.stageAll())
      },
      unstageAll: async () => {
        await get().run("Unstaging…", () => ipc.git.unstageAll())
      },
      discardAll: async () => {
        const ok = await ipc.dialog.confirm(
          "Discard every unstaged change in this folder? Untracked files go to the Trash; staged changes stay.",
          "Discard all changes",
          "Discard all",
        )
        if (ok) await get().run("Discarding…", () => ipc.git.discardAll())
      },

      commit: async (mode = {}) => {
        const { status, message } = get()
        if (!status) return undefined
        if (!message.trim() && !mode.amend) {
          useWorkspace.setState({ error: "Write a commit message first" })
          return undefined
        }
        let stagedOnly = status.staged.length > 0 && !mode.all
        if (!stagedOnly && !mode.all && mode.stagedOnly) {
          if (!mode.amend) {
            useWorkspace.setState({ error: "Nothing is staged. Stage changes first, or use Commit All." })
            return undefined
          }
          stagedOnly = true
        }
        // Nothing staged: VS Code's smart commit stages everything, once allowed.
        if (!stagedOnly && !mode.all && !mode.amend) {
          let smart = get().smartCommit
          if (smart === null) {
            smart = await ipc.dialog.confirm(
              "There are no staged changes. Stage all your changes and commit them? You won't be asked again.",
              "Commit",
              "Stage all and commit",
            )
            set({ smartCommit: smart })
          }
          if (!smart) return undefined
        }
        const sha = await get().run(mode.then ? "Committing and pushing…" : "Committing…", async (progress) => {
          const sha = await ipc.git.commit(message.trim(), null, {
            // An amend with nothing staged just rewords; Commit All stages everything.
            stagedOnly: !mode.all && (stagedOnly || !!mode.amend),
            amend: !!mode.amend,
            signoff: !!mode.signoff,
            noVerify: !!mode.noVerify,
          })
          if (mode.then === "push") await ipc.git.push({}, progress)
          if (mode.then === "sync") await ipc.git.sync(false, progress)
          return sha
        })
        if (sha) set({ message: "" })
        return sha
      },
    }),
    {
      name: "elaris.scm",
      partialize: (s) => ({ viewMode: s.viewMode, sortBy: s.sortBy, smartCommit: s.smartCommit }),
    },
  ),
)
