import { create } from "zustand"

import { errorMessage } from "@/lib/ipc"
import { adoptAgentTerminal, createShell, disposeAllTerminals, disposeTerminal, isTerminalTab } from "@/lib/terminals"
import { useSessions } from "@/stores/sessions"

export type CustomizationId =
  | "plugins"
  | "mcp"
  | "skills"
  | "instructions"
  | "agents"
  | "hooks"
  | "tools"

/** What the centre pane shows. */
export type MainView =
  | { kind: "chat" }
  | { kind: "diff"; path: string }
  | { kind: "file"; path: string }
  | { kind: "planned"; item: CustomizationId }

/** One step in back/forward history: a chat (or the new-chat screen) plus a view. */
export interface NavEntry {
  sessionId: string | null
  view: MainView
}

export type RightTab = "changes" | "files"

/**
 * Tabs beside a chat: Write/Edit calls (keyed by part id) and terminals (keyed `terminal:<n>`).
 * `active: null` is the conversation itself.
 */
export interface ToolTabs {
  open: string[]
  active: string | null
}

const NO_TABS: ToolTabs = { open: [], active: null }

interface UiState {
  history: NavEntry[]
  index: number
  leftOpen: boolean
  rightOpen: boolean
  rightTab: RightTab
  /** Bumped to ask the composer to take focus. */
  composerFocus: number
  /** Keyed by session id. */
  toolTabs: Record<string, ToolTabs>

  navigate: (entry: Partial<NavEntry>) => void
  /** Replaces the current entry without adding history (e.g. a chat created on first send). */
  replace: (entry: Partial<NavEntry>) => void
  back: () => void
  forward: () => void
  newChat: () => void
  /** Back to a new chat with no history, e.g. after switching projects. */
  resetNavigation: () => void
  /** Drops a deleted chat from history. */
  forgetSession: (id: string) => void
  setLeftOpen: (open: boolean) => void
  setRightOpen: (open: boolean) => void
  setRightTab: (tab: RightTab) => void
  focusComposer: () => void
  openToolTab: (sessionId: string, partId: string) => void
  /** `null` shows the conversation. */
  selectToolTab: (sessionId: string, partId: string | null) => void
  closeToolTab: (sessionId: string, partId: string) => void
  /** Starts a shell in a new tab beside the chat. */
  openTerminal: (sessionId: string) => Promise<void>
  /**
   * Opens the tab for a terminal the chat's agent started. In the background (as the
   * agent starts it) it doesn't take the front, so the user can keep reading.
   */
  showAgentTerminal: (sessionId: string, pty: number, title: string, front: boolean) => Promise<void>
}

const MAX_HISTORY = 50

const sameEntry = (a: NavEntry, b: NavEntry) =>
  a.sessionId === b.sessionId && JSON.stringify(a.view) === JSON.stringify(b.view)

export const useUi = create<UiState>()((set, get) => ({
  history: [{ sessionId: null, view: { kind: "chat" } }],
  index: 0,
  leftOpen: true,
  rightOpen: true,
  rightTab: "files",
  composerFocus: 0,
  toolTabs: {},

  navigate: (partial) => {
    const { history, index } = get()
    const next = { ...history[index], ...partial }
    if (sameEntry(next, history[index])) return
    const kept = history.slice(Math.max(0, index + 1 - MAX_HISTORY), index + 1)
    set({ history: [...kept, next], index: kept.length })
  },
  replace: (partial) => {
    const { history, index } = get()
    const updated = [...history]
    updated[index] = { ...history[index], ...partial }
    set({ history: updated })
  },
  back: () => set((s) => ({ index: Math.max(0, s.index - 1) })),
  forward: () => set((s) => ({ index: Math.min(s.history.length - 1, s.index + 1) })),
  newChat: () => {
    get().navigate({ sessionId: null, view: { kind: "chat" } })
    get().focusComposer()
  },
  resetNavigation: () => {
    disposeAllTerminals()
    set({ history: [{ sessionId: null, view: { kind: "chat" } }], index: 0, toolTabs: {} })
  },
  forgetSession: (id) =>
    set((s) => {
      const { [id]: closed, ...toolTabs } = s.toolTabs
      closed?.open.filter(isTerminalTab).forEach(disposeTerminal)
      return {
        history: s.history.map((entry) =>
          entry.sessionId === id ? { sessionId: null, view: { kind: "chat" } } : entry,
        ),
        toolTabs,
      }
    }),
  setLeftOpen: (leftOpen) => set({ leftOpen }),
  setRightOpen: (rightOpen) => set({ rightOpen }),
  setRightTab: (rightTab) => set({ rightTab, rightOpen: true }),
  focusComposer: () => set((s) => ({ composerFocus: s.composerFocus + 1 })),
  openToolTab: (sessionId, partId) =>
    set((s) => {
      const tabs = s.toolTabs[sessionId] ?? NO_TABS
      const open = tabs.open.includes(partId) ? tabs.open : [...tabs.open, partId]
      return { toolTabs: { ...s.toolTabs, [sessionId]: { open, active: partId } } }
    }),
  selectToolTab: (sessionId, partId) =>
    set((s) => ({
      toolTabs: { ...s.toolTabs, [sessionId]: { ...(s.toolTabs[sessionId] ?? NO_TABS), active: partId } },
    })),
  closeToolTab: (sessionId, partId) => {
    if (isTerminalTab(partId)) disposeTerminal(partId)
    set((s) => {
      const tabs = s.toolTabs[sessionId] ?? NO_TABS
      const at = tabs.open.indexOf(partId)
      const open = tabs.open.filter((id) => id !== partId)
      // Closing the active tab moves to its neighbour, like an editor; the last one goes back to the chat.
      const active = tabs.active === partId ? (open[Math.min(at, open.length - 1)] ?? null) : tabs.active
      return { toolTabs: { ...s.toolTabs, [sessionId]: { open, active } } }
    })
  },
  openTerminal: async (sessionId) => {
    try {
      // A shell that exits by itself (`exit`, Ctrl+D) closes its tab.
      const key = await createShell((key) => {
        if (get().toolTabs[sessionId]?.open.includes(key)) get().closeToolTab(sessionId, key)
        else disposeTerminal(key)
      })
      get().openToolTab(sessionId, key)
    } catch (error) {
      useSessions.setState({ error: errorMessage(error) })
    }
  },
  showAgentTerminal: async (sessionId, pty, title, front) => {
    try {
      const key = await adoptAgentTerminal(pty, title)
      if (front) {
        get().openToolTab(sessionId, key)
        return
      }
      set((s) => {
        const tabs = s.toolTabs[sessionId] ?? NO_TABS
        if (tabs.open.includes(key)) return {}
        return { toolTabs: { ...s.toolTabs, [sessionId]: { ...tabs, open: [...tabs.open, key] } } }
      })
    } catch (error) {
      useSessions.setState({ error: errorMessage(error) })
    }
  },
}))

export const useToolTabs = (sessionId: string) => useUi((s) => s.toolTabs[sessionId] ?? NO_TABS)

export const useCurrent = () => useUi((s) => s.history[s.index])
