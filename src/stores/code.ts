import { create } from "zustand"

import { errorMessage, ipc } from "@/lib/ipc"

interface CodeState {
  /** Bumped when a server is installed, so open views ask for colours again. */
  epoch: number
  /** Mason packages being installed. */
  installing: Record<string, boolean>
  /** Why the last install of a package failed. */
  failures: Record<string, string>
  /** Installs the language server for `path` (its Mason `pkg`). */
  install: (path: string, pkg: string) => Promise<void>
}

export const useCodeIntel = create<CodeState>()((set) => ({
  epoch: 0,
  installing: {},
  failures: {},
  install: async (path, pkg) => {
    set((s) => ({ installing: { ...s.installing, [pkg]: true }, failures: omit(s.failures, pkg) }))
    try {
      await ipc.code.install(path)
      set((s) => ({ epoch: s.epoch + 1 }))
    } catch (error) {
      set((s) => ({ failures: { ...s.failures, [pkg]: errorMessage(error) } }))
    } finally {
      set((s) => ({ installing: omit(s.installing, pkg) }))
    }
  },
}))

function omit<T>(record: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _, ...rest } = record
  return rest
}
