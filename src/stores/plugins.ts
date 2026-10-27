import { create } from "zustand"
import { persist } from "zustand/middleware"

/**
 * Which catalog plugins are installed, and whether each is switched on.
 * Kept in localStorage until the Rust side owns plugin installs.
 */
interface PluginsState {
  installed: Record<string, { enabled: boolean }>
  install: (id: string) => void
  uninstall: (id: string) => void
  setEnabled: (id: string, enabled: boolean) => void
}

export const usePlugins = create<PluginsState>()(
  persist(
    (set) => ({
      installed: {
        github: { enabled: true },
        "rust-toolkit": { enabled: true },
        "commit-hygiene": { enabled: false },
      },
      install: (id) => set((s) => ({ installed: { ...s.installed, [id]: { enabled: true } } })),
      uninstall: (id) =>
        set((s) => {
          const { [id]: _, ...rest } = s.installed
          return { installed: rest }
        }),
      setEnabled: (id, enabled) =>
        set((s) => (s.installed[id] ? { installed: { ...s.installed, [id]: { enabled } } } : s)),
    }),
    { name: "elaris.plugins" },
  ),
)
