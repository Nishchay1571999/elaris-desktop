import { create } from "zustand"

import type { McpServer } from "@/bindings/McpServer"
import { errorMessage, ipc } from "@/lib/ipc"
import type { McpCatalogEntry } from "@/lib/mcp-catalog"

export type McpWork = "installing" | "removing"

/** User-scope MCP servers from `~/.claude.json`, and changes in flight. */
interface McpState {
  servers: McpServer[] | null
  loadError: string | null
  /** Server name → what is running. */
  working: Record<string, McpWork>
  /** Server name → why the last attempt failed. */
  failed: Record<string, string>

  load: () => Promise<void>
  install: (entry: McpCatalogEntry, values: Record<string, string>) => Promise<boolean>
  remove: (name: string) => Promise<void>
}

export const useMcp = create<McpState>()((set, get) => {
  const run = async (name: string, work: McpWork, task: () => Promise<McpServer[]>) => {
    if (get().working[name]) return false
    set((s) => ({ working: { ...s.working, [name]: work }, failed: without(s.failed, name) }))
    try {
      set({ servers: await task() })
      return true
    } catch (error) {
      set((s) => ({ failed: { ...s.failed, [name]: errorMessage(error) } }))
      return false
    } finally {
      set((s) => ({ working: without(s.working, name) }))
    }
  }

  return {
    servers: null,
    loadError: null,
    working: {},
    failed: {},

    load: async () => {
      set({ loadError: null })
      try {
        set({ servers: await ipc.mcp.list() })
      } catch (error) {
        set({ loadError: errorMessage(error) })
      }
    },
    install: (entry, values) => run(entry.id, "installing", () => ipc.mcp.add(entry.id, entry.config(values))),
    remove: async (name) => {
      await run(name, "removing", () => ipc.mcp.remove(name))
    },
  }
})

function without<T>(record: Record<string, T>, key: string) {
  const { [key]: _, ...rest } = record
  return rest
}
