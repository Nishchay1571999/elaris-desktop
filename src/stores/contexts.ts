import { create } from "zustand"

import type { ContextSummary } from "@/bindings/ContextSummary"
import type { ItemSummary } from "@/bindings/ItemSummary"
import { errorMessage, ipc } from "@/lib/ipc"
import { useSessions } from "@/stores/sessions"

/**
 * Saved contexts: chats kept whole in Elaris's database so another chat can be
 * handed one as `#ctx-…`, and pull requests and issues saved with their
 * attachments, handed over as `%pr-…` or `%issue-…`. The lists are small, so
 * they're loaded whole and filtered here.
 */
interface ContextsState {
  saved: ContextSummary[]
  loaded: boolean
  load: () => Promise<void>
  /** Saves chat `sessionId`, returning its context; `null` if that failed (the error is shown). */
  save: (sessionId: string) => Promise<ContextSummary | null>
  items: ItemSummary[]
  itemsLoaded: boolean
  loadItems: () => Promise<void>
  /**
   * Saves a pull request or issue (`repo` is required for issues), returning it;
   * throws if that failed, so the page it's saved from can say why.
   */
  saveItem: (kind: "pr" | "issue", repo: string | undefined, number: number) => Promise<ItemSummary>
}

const fail = (error: unknown) => useSessions.setState({ error: errorMessage(error) })

export const useContexts = create<ContextsState>()((set) => ({
  saved: [],
  loaded: false,
  items: [],
  itemsLoaded: false,

  load: async () => {
    try {
      set({ saved: await ipc.contexts.list(), loaded: true })
    } catch (error) {
      fail(error)
    }
  },

  save: async (sessionId) => {
    try {
      const context = await ipc.contexts.save(sessionId)
      set((s) => ({ saved: [context, ...s.saved.filter((c) => c.id !== context.id)] }))
      return context
    } catch (error) {
      fail(error)
      return null
    }
  },

  loadItems: async () => {
    try {
      set({ items: await ipc.items.list(), itemsLoaded: true })
    } catch (error) {
      fail(error)
    }
  },

  saveItem: async (kind, repo, number) => {
    const item = await ipc.github.saveItem(kind, repo, number)
    set((s) => ({ items: [item, ...s.items.filter((i) => i.id !== item.id)] }))
    return item
  },
}))

/** `#ctx-…` as typed in a message; the same rule as `references` in `crates/contexts`. */
export const CONTEXT_REFERENCE = /(?<![A-Za-z0-9])#(ctx-[a-z0-9]{6})(?![A-Za-z0-9_-])/g

/** `%pr-…` or `%issue-…` as typed in a message; the same rule as `item_references` in `crates/contexts`. */
export const ITEM_REFERENCE = /(?<![A-Za-z0-9])%((?:pr|issue)-[a-z0-9]{6})(?![A-Za-z0-9_-])/g

/** Ids `text` references, each once, in order. */
export function contextReferences(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(CONTEXT_REFERENCE), (m) => m[1]))]
}

/** Saved pull request and issue ids `text` references, each once, in order. */
export function itemReferences(text: string): string[] {
  return [...new Set(Array.from(text.matchAll(ITEM_REFERENCE), (m) => m[1]))]
}

/** "~12k tokens". */
export function tokenLabel(tokens: number): string {
  if (tokens < 1000) return `~${tokens} tokens`
  const [value, unit] = tokens < 1_000_000 ? [tokens / 1000, "k"] : [tokens / 1_000_000, "M"]
  return `~${value.toFixed(value < 10 ? 1 : 0).replace(/\.0$/, "")}${unit} tokens`
}
