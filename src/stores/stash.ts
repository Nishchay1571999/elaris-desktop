import { create } from "zustand"
import { persist } from "zustand/middleware"

export interface StashedPrompt {
  id: string
  text: string
  createdAt: number
}

/** Prompts put aside from the composer to send later, newest first. Shared by every chat. */
interface StashState {
  items: StashedPrompt[]
  stash: (text: string) => void
  take: (id: string) => StashedPrompt | undefined
  clear: () => void
}

const MAX_ITEMS = 20

export const useStash = create<StashState>()(
  persist(
    (set, get) => ({
      items: [],
      stash: (text) =>
        set((s) => ({
          items: [{ id: crypto.randomUUID(), text, createdAt: Date.now() }, ...s.items].slice(0, MAX_ITEMS),
        })),
      take: (id) => {
        const item = get().items.find((i) => i.id === id)
        set((s) => ({ items: s.items.filter((i) => i.id !== id) }))
        return item
      },
      clear: () => set({ items: [] }),
    }),
    { name: "elaris.stash" },
  ),
)
