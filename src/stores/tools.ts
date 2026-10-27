import { create } from "zustand"

import type { PermissionRules } from "@/bindings/PermissionRules"
import type { RuleBehavior } from "@/bindings/RuleBehavior"
import { errorMessage, ipc } from "@/lib/ipc"

/** Permission rules from `~/.claude/settings.json`, and changes in flight. */
interface ToolsState {
  rules: PermissionRules | null
  loadError: string | null
  /** Row id → a change is being saved. */
  working: Record<string, true>
  /** Row id → why the last change failed. */
  failed: Record<string, string>

  load: () => Promise<void>
  /** Moves `rules` to `behavior`'s list; `null` clears them. `id` names the row that asked. */
  set: (id: string, rules: string[], behavior: RuleBehavior | null) => Promise<void>
}

export const useTools = create<ToolsState>()((set, get) => ({
  rules: null,
  loadError: null,
  working: {},
  failed: {},

  load: async () => {
    set({ loadError: null })
    try {
      set({ rules: await ipc.tools.rules() })
    } catch (error) {
      set({ loadError: errorMessage(error) })
    }
  },

  set: async (id, rules, behavior) => {
    if (get().working[id]) return
    set((s) => ({ working: { ...s.working, [id]: true }, failed: without(s.failed, id) }))
    try {
      set({ rules: await ipc.tools.set(rules, behavior) })
    } catch (error) {
      set((s) => ({ failed: { ...s.failed, [id]: errorMessage(error) } }))
    } finally {
      set((s) => ({ working: without(s.working, id) }))
    }
  },
}))

function without<T>(record: Record<string, T>, key: string) {
  const { [key]: _, ...rest } = record
  return rest
}
