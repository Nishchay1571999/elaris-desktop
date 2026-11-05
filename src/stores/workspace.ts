import { create } from "zustand"

import type { ChangedFile } from "@/bindings/ChangedFile"
import type { WorkspaceInfo } from "@/bindings/WorkspaceInfo"
import { errorMessage, ipc } from "@/lib/ipc"
import { useUi } from "@/stores/ui"

interface WorkspaceState {
  info: WorkspaceInfo | null
  recent: string[]
  changes: ChangedFile[]
  error: string | null
  /** How far along opening a project is, 0–1, or `null` when not opening one. */
  opening: number | null

  /** Reopens the last workspace and starts listening for file changes. */
  init: () => Promise<void>
  /**
   * Opens `path`. Switching to a chat's own folder passes `keepNavigation`, so
   * history and the terminals of other chats survive the switch.
   */
  open: (path: string, options?: { keepNavigation?: boolean }) => Promise<void>
  pickAndOpen: () => Promise<void>
  refreshChanges: () => Promise<void>
  switchBranch: (name: string) => Promise<void>
  /** Re-reads the branch and git status, after git or gh changed them. */
  refreshInfo: () => Promise<void>
}

let unlisten: (() => void) | null = null

export const useWorkspace = create<WorkspaceState>()((set, get) => {
  const onChanged = async (paths: string[]) => {
    if (paths.some((p) => p.startsWith(".git/"))) {
      // Branch switches, commits, or a fresh `git init`.
      const info = await ipc.workspace.current()
      if (info) set({ info })
    }
    await get().refreshChanges()
  }

  return {
    info: null,
    recent: [],
    changes: [],
    error: null,
    opening: null,

    init: async () => {
      unlisten ??= await ipc.workspace.onChanged((paths) => void onChanged(paths))
      const [current, recent] = await Promise.all([ipc.workspace.current(), ipc.workspace.recent()])
      set({ recent })
      if (current) {
        set({ info: current })
        await get().refreshChanges()
      } else if (recent[0]) {
        await get().open(recent[0])
      }
    },

    open: async (path, options) => {
      // Three steps: open the folder, read git status, refresh the recent
      // list. Each one done moves the bar a third along.
      let done = 0
      const step = () => set({ opening: ++done / 3 })
      set({ opening: 0 })
      try {
        const info = await ipc.workspace.open(path)
        step()
        // File and diff views belong to the previous project; the open chat
        // stays, and its next message runs in this one.
        if (info.root !== get().info?.root && !options?.keepNavigation) useUi.getState().resetNavigation()
        set({ info, changes: [], error: null })
        await get().refreshChanges()
        step()
        set({ recent: await ipc.workspace.recent() })
      } catch (error) {
        set({ error: errorMessage(error) })
      } finally {
        set({ opening: null })
      }
    },

    pickAndOpen: async () => {
      const path = await ipc.dialog.pickFolder()
      if (path) await get().open(path)
    },

    refreshChanges: async () => {
      if (!get().info?.isGit) {
        set({ changes: [] })
        return
      }
      try {
        set({ changes: await ipc.git.status() })
      } catch (error) {
        set({ error: errorMessage(error) })
      }
    },

    refreshInfo: async () => {
      const info = await ipc.workspace.current()
      if (info) set({ info })
      await get().refreshChanges()
    },

    switchBranch: async (name) => {
      let error: string | null = null
      try {
        await ipc.git.switch(name)
      } catch (e) {
        error = errorMessage(e)
      }
      // The watcher re-lists changed folders; the branch name is ours to refresh.
      // Even a failed switch can land on the branch, with conflicts to resolve.
      const info = await ipc.workspace.current()
      set(info ? { info, error } : { error })
      await get().refreshChanges()
    },
  }
})
