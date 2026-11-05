import { create } from "zustand"

import type { GitOutputEntry } from "@/bindings/GitOutputEntry"
import { ipc } from "@/lib/ipc"

/** Entries kept; matches what the Rust side holds. */
const KEEP = 500

interface GitOutputState {
  entries: GitOutputEntry[]
  /** Starts following git commands; earlier ones this session are loaded too. */
  init: () => Promise<void>
  /** Hides everything so far (the Rust log keeps it). */
  clear: () => void
}

let listening = false
/** Entries at or before this id were cleared. */
let clearedThrough = 0

/** Every git command the app runs, for the Git Output view. */
export const useGitOutput = create<GitOutputState>()((set) => ({
  entries: [],
  init: async () => {
    if (listening) return
    listening = true
    await ipc.git.onOutput((entry) => set((s) => ({ entries: [...s.entries, entry].slice(-KEEP) })))
    const history = await ipc.git.outputHistory()
    set((s) => {
      // Entries that arrived while the history loaded are in both.
      const seen = new Set(s.entries.map((e) => e.id))
      const merged = [...history.filter((e) => !seen.has(e.id) && e.id > clearedThrough), ...s.entries]
      return { entries: merged.sort((a, b) => a.id - b.id).slice(-KEEP) }
    })
  },
  clear: () =>
    set((s) => {
      clearedThrough = s.entries.at(-1)?.id ?? clearedThrough
      return { entries: [] }
    }),
}))
