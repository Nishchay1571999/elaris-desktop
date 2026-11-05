import { create } from "zustand"
import { persist } from "zustand/middleware"

import type { SessionSettings } from "@/bindings/SessionSettings"

export type Theme = "system" | "light" | "dark"
export type Accent = "blue" | "violet" | "teal" | "green" | "amber" | "rose"
export type Density = "comfortable" | "compact"
export type ChatTextSize = "small" | "default" | "large"
export type SendKey = "enter" | "mod-enter"

/**
 * A logo the user chose for a project, by folder. Without one, the project's own
 * favicon or `logo.*` shows, else a monogram.
 */
export type ProjectIcon =
  | { kind: "image"; path: string }
  | { kind: "icon"; name: string; color: number }
  | { kind: "emoji"; emoji: string }
  | { kind: "monogram"; text: string; color: number }

/**
 * How the app looks and behaves, set from Settings. Kept in localStorage: it's
 * per machine, and read before the first paint so the theme never flashes.
 */
interface PreferencesState {
  theme: Theme
  accent: Accent
  density: Density
  chatTextSize: ChatTextSize
  animations: boolean
  sendKey: SendKey
  /** Mode, model and permissions a new chat starts with. */
  defaults: SessionSettings
  /** Shortcuts the user changed, by command id; null means unbound. */
  keybindings: Record<string, string | null>
  /** Logos the user picked, by folder path. */
  projectIcons: Record<string, ProjectIcon>
  /** Whether the sidebar's Customizations list is expanded. */
  customizationsOpen: boolean

  set: (patch: Partial<Omit<PreferencesState, "set" | "setKeybinding" | "resetKeybindings" | "setProjectIcon">>) => void
  /** `null` goes back to the detected logo. */
  setProjectIcon: (root: string, icon: ProjectIcon | null) => void
  /** `undefined` goes back to the default. */
  setKeybinding: (command: string, binding: string | null | undefined) => void
  resetKeybindings: () => void
}

export const usePreferences = create<PreferencesState>()(
  persist(
    (set) => ({
      theme: "dark",
      accent: "blue",
      density: "comfortable",
      chatTextSize: "default",
      animations: true,
      sendKey: "enter",
      defaults: { mode: "agent", model: "claude-opus-5-5", permissions: "ask" },
      keybindings: {},
      projectIcons: {},
      customizationsOpen: true,

      set: (patch) => set(patch),
      setKeybinding: (command, binding) =>
        set((s) => {
          const { [command]: _, ...rest } = s.keybindings
          return { keybindings: binding === undefined ? rest : { ...rest, [command]: binding } }
        }),
      resetKeybindings: () => set({ keybindings: {} }),
      setProjectIcon: (root, icon) =>
        set((s) => {
          const { [root]: _, ...rest } = s.projectIcons
          return { projectIcons: icon ? { ...rest, [root]: icon } : rest }
        }),
    }),
    { name: "elaris.preferences" },
  ),
)
