import { create } from "zustand"

import type { InstructionFile } from "@/bindings/InstructionFile"
import { errorMessage, ipc } from "@/lib/ipc"

/**
 * The CLAUDE.md files the agent reads, and the edits to them. Drafts live here
 * rather than in the page so unsaved text survives navigating away and back.
 */
interface InstructionsState {
  files: InstructionFile[] | null
  loadError: string | null
  /** Path → the editor's text, while it differs from the file. */
  drafts: Record<string, string>
  /** Path → a save or delete in flight. */
  working: Record<string, "saving" | "deleting">
  /** Path → why the last save or delete failed. */
  failed: Record<string, string>
  /** Path → when it was last saved from here, for the "Saved" stamp. */
  savedAt: Record<string, number>

  load: () => Promise<void>
  edit: (file: InstructionFile, text: string) => void
  discard: (path: string) => void
  save: (file: InstructionFile) => Promise<void>
  remove: (file: InstructionFile) => Promise<void>
}

export const useInstructions = create<InstructionsState>()((set, get) => {
  const run = async (path: string, work: "saving" | "deleting", task: () => Promise<InstructionFile[]>) => {
    if (get().working[path]) return
    set((s) => ({ working: { ...s.working, [path]: work }, failed: without(s.failed, path) }))
    try {
      const files = await task()
      set((s) => ({ files, drafts: without(s.drafts, path), savedAt: { ...s.savedAt, [path]: Date.now() } }))
    } catch (error) {
      set((s) => ({ failed: { ...s.failed, [path]: errorMessage(error) } }))
    } finally {
      set((s) => ({ working: without(s.working, path) }))
    }
  }

  return {
    files: null,
    loadError: null,
    drafts: {},
    working: {},
    failed: {},
    savedAt: {},

    load: async () => {
      set({ loadError: null, failed: {} })
      try {
        const files = await ipc.instructions.list()
        // A draft that now matches the file on disk has nothing left to save.
        set((s) => ({
          files,
          drafts: Object.fromEntries(
            Object.entries(s.drafts).filter(([path, text]) => files.find((f) => f.path === path)?.content !== text),
          ),
        }))
      } catch (error) {
        set({ loadError: errorMessage(error) })
      }
    },
    edit: (file, text) =>
      set((s) => ({
        drafts: text === file.content ? without(s.drafts, file.path) : { ...s.drafts, [file.path]: text },
        savedAt: without(s.savedAt, file.path),
      })),
    discard: (path) => set((s) => ({ drafts: without(s.drafts, path), failed: without(s.failed, path) })),
    save: (file) => {
      const text = get().drafts[file.path]
      if (text === undefined) return Promise.resolve()
      return run(file.path, "saving", () =>
        ipc.instructions.save(file.path, text, file.exists ? file.content : null),
      )
    },
    remove: (file) => run(file.path, "deleting", () => ipc.instructions.remove(file.path, file.content)),
  }
})

function without<T>(record: Record<string, T>, key: string): Record<string, T> {
  if (!(key in record)) return record
  const next = { ...record }
  delete next[key]
  return next
}
