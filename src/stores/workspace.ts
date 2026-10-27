import { create } from "zustand"

import type { ChangedFile } from "@/bindings/ChangedFile"
import type { FileEntry } from "@/bindings/FileEntry"
import type { WorkspaceInfo } from "@/bindings/WorkspaceInfo"
import { errorMessage, ipc } from "@/lib/ipc"
import { parentDir } from "@/lib/utils"
import { useUi } from "@/stores/ui"

interface WorkspaceState {
  info: WorkspaceInfo | null
  recent: string[]
  /** Listed folders, keyed by workspace-relative path (`""` is the root). */
  children: Record<string, FileEntry[]>
  expanded: Record<string, true>
  changes: ChangedFile[]
  error: string | null
  /** How far along opening a project is, 0–1, or `null` when not opening one. */
  opening: number | null

  /** Reopens the last workspace and starts listening for file changes. */
  init: () => Promise<void>
  open: (path: string) => Promise<void>
  pickAndOpen: () => Promise<void>
  toggleDir: (path: string) => Promise<void>
  refreshChanges: () => Promise<void>
}

let unlisten: (() => void) | null = null

export const useWorkspace = create<WorkspaceState>()((set, get) => {
  const listDir = async (path: string) => {
    try {
      const entries = await ipc.workspace.listDir(path)
      set((s) => ({ children: { ...s.children, [path]: entries } }))
    } catch {
      // The folder was deleted; forget it so it's re-listed if it returns.
      set((s) => {
        const children = { ...s.children }
        const expanded = { ...s.expanded }
        delete children[path]
        delete expanded[path]
        return { children, expanded }
      })
    }
  }

  /** Re-lists only the folders we've shown that contain a changed path. */
  const onChanged = async (paths: string[]) => {
    const touchesGit = paths.some((p) => p.startsWith(".git/"))
    const dirs = new Set(paths.filter((p) => !p.startsWith(".git/")).map(parentDir))
    if (touchesGit) {
      // Branch switches, commits, or a fresh `git init`.
      const info = await ipc.workspace.current()
      if (info) set({ info })
    }
    const loaded = get().children
    await Promise.all([...[...dirs].filter((dir) => dir in loaded).map(listDir), get().refreshChanges()])
  }

  return {
    info: null,
    recent: [],
    children: {},
    expanded: {},
    changes: [],
    error: null,
    opening: null,

    init: async () => {
      unlisten ??= await ipc.workspace.onChanged((paths) => void onChanged(paths))
      const [current, recent] = await Promise.all([ipc.workspace.current(), ipc.workspace.recent()])
      set({ recent })
      if (current) {
        set({ info: current })
        await Promise.all([listDir(""), get().refreshChanges()])
      } else if (recent[0]) {
        await get().open(recent[0])
      }
    },

    open: async (path) => {
      // Four steps: open the folder, list its root, read git status, refresh
      // the recent list. Each one done moves the bar a quarter along.
      let done = 0
      const step = () => set({ opening: ++done / 4 })
      set({ opening: 0 })
      try {
        const info = await ipc.workspace.open(path)
        step()
        // The open chat, file and diff views all belong to the previous project.
        if (info.root !== get().info?.root) useUi.getState().resetNavigation()
        set({ info, children: {}, expanded: {}, changes: [], error: null })
        await Promise.all([listDir("").then(step), get().refreshChanges().then(step)])
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

    toggleDir: async (path) => {
      const expanded = { ...get().expanded }
      if (expanded[path]) {
        delete expanded[path]
        set({ expanded })
        return
      }
      expanded[path] = true
      set({ expanded })
      if (!(path in get().children)) await listDir(path)
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
  }
})
