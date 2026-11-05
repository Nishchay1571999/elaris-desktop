import { create } from "zustand"

import type { DiffSide } from "@/bindings/DiffSide"
import { agentTabKey, isAgentTab } from "@/lib/agents"
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

export type SettingsSection = "appearance" | "chat" | "keyboard" | "github" | "about"

/** What the centre pane shows. */
export type MainView =
  | { kind: "chat" }
  /** One file's changes; `side` picks staged, unstaged or untracked (default: both, against HEAD). */
  | { kind: "diff"; path: string; side?: DiffSide }
  /** Every branch's history as a graph. */
  | { kind: "graph" }
  /** One commit: its message and changes. */
  | { kind: "commit"; sha: string }
  /** What a stash holds. */
  | { kind: "stash"; index: number; message: string }
  /** Every git command the app ran, and what git said. */
  | { kind: "gitOutput" }
  | { kind: "planned"; item: CustomizationId }
  | { kind: "settings"; section: SettingsSection }
  /**
   * Pull requests from every repository gh can see; with `number`, that one, on `repo`
   * (owner/name) or, without it, on the open folder's repository.
   */
  | { kind: "pulls"; repo?: string; number?: number }
  /** Issues from every repository gh can see; with `repo` and `number`, that one. */
  | { kind: "issues"; repo?: string; number?: number }

/** The Pull requests and Issues pages, which open as tabs beside the chat. */
export type TrackerTab = "pulls" | "issues"

/** Where an open Pull requests or Issues tab is: its list, or one pull request or issue. */
export interface TrackerLocation {
  repo?: string
  number?: number
}

/** One step in back/forward history: a chat (or the new-chat screen) plus a view. */
export interface NavEntry {
  sessionId: string | null
  view: MainView
}

/**
 * Tabs beside a chat: Write/Edit calls (keyed by part id), terminals (keyed `terminal:<n>`)
 * and subagents (keyed `agent:<id>`).
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
  /** Bumped to ask the composer to take focus. */
  composerFocus: number
  /** Keyed by session id. */
  toolTabs: Record<string, ToolTabs>
  /** Subagents whose tab the user closed, by session id, so they don't open again. */
  closedAgents: Record<string, string[]>
  /**
   * The open Pull requests and Issues tabs and where each is. They belong to no chat:
   * they stay in the tab bar across chats until closed.
   */
  trackerTabs: Partial<Record<TrackerTab, TrackerLocation>>
  /** The ⌘K command palette. */
  paletteOpen: boolean
  /** The find bar over the conversation; bumped by ⌘F so it refocuses when already open. */
  find: { open: boolean; focus: number }

  navigate: (entry: Partial<NavEntry>) => void
  /** Replaces the current entry without adding history (e.g. a chat created on first send). */
  replace: (entry: Partial<NavEntry>) => void
  back: () => void
  forward: () => void
  newChat: () => void
  /** Drops history and tool tabs after switching projects, keeping the open chat. */
  resetNavigation: () => void
  /** Drops a deleted chat from history. */
  forgetSession: (id: string) => void
  setLeftOpen: (open: boolean) => void
  setRightOpen: (open: boolean) => void
  focusComposer: () => void
  openSettings: (section?: SettingsSection) => void
  setPaletteOpen: (open: boolean) => void
  openFind: () => void
  closeFind: () => void
  openToolTab: (sessionId: string, partId: string) => void
  /**
   * Shows the Pull requests or Issues tab, opening it on its list. Already in front,
   * it goes back to its list.
   */
  openTracker: (kind: TrackerTab) => void
  /** Closes the Pull requests or Issues tab; if it was in front, the chat comes back. */
  closeTracker: (kind: TrackerTab) => void
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
  /**
   * Opens a tab, in the background, for each of the chat's subagents that has none and
   * wasn't closed by the user. Tabs never close by themselves when an agent ends.
   */
  showAgentTabs: (sessionId: string, agents: string[]) => void
}

const MAX_HISTORY = 50

const sameEntry = (a: NavEntry, b: NavEntry) =>
  a.sessionId === b.sessionId && JSON.stringify(a.view) === JSON.stringify(b.view)

export const isTrackerView = (view: MainView): view is Extract<MainView, { kind: TrackerTab }> =>
  view.kind === "pulls" || view.kind === "issues"

/** `tabs`, with the tab `view` is in (if it's in one) opened or moved to it. */
function follow(tabs: UiState["trackerTabs"], view: MainView): UiState["trackerTabs"] {
  if (!isTrackerView(view)) return tabs
  const at: TrackerLocation = {}
  if (view.repo !== undefined) at.repo = view.repo
  if (view.number !== undefined) at.number = view.number
  return { ...tabs, [view.kind]: at }
}

export const useUi = create<UiState>()((set, get) => ({
  history: [{ sessionId: null, view: { kind: "chat" } }],
  index: 0,
  leftOpen: true,
  rightOpen: true,
  composerFocus: 0,
  toolTabs: {},
  closedAgents: {},
  trackerTabs: {},
  paletteOpen: false,
  find: { open: false, focus: 0 },

  navigate: (partial) => {
    const { history, index } = get()
    const next = { ...history[index], ...partial }
    if (sameEntry(next, history[index])) return
    const kept = history.slice(Math.max(0, index + 1 - MAX_HISTORY), index + 1)
    set((s) => ({ history: [...kept, next], index: kept.length, trackerTabs: follow(s.trackerTabs, next.view) }))
  },
  replace: (partial) => {
    const { history, index } = get()
    const updated = [...history]
    updated[index] = { ...history[index], ...partial }
    set((s) => ({ history: updated, trackerTabs: follow(s.trackerTabs, updated[index].view) }))
  },
  back: () =>
    set((s) => {
      const index = Math.max(0, s.index - 1)
      return { index, trackerTabs: follow(s.trackerTabs, s.history[index].view) }
    }),
  forward: () =>
    set((s) => {
      const index = Math.min(s.history.length - 1, s.index + 1)
      return { index, trackerTabs: follow(s.trackerTabs, s.history[index].view) }
    }),
  newChat: () => {
    get().navigate({ sessionId: null, view: { kind: "chat" } })
    get().focusComposer()
  },
  resetNavigation: () => {
    disposeAllTerminals()
    const { history, index } = get()
    const chat = history[index].view.kind === "chat" ? history[index].sessionId : null
    set({ history: [{ sessionId: chat, view: { kind: "chat" } }], index: 0, toolTabs: {}, closedAgents: {} })
  },
  forgetSession: (id) =>
    set((s) => {
      const { [id]: closed, ...toolTabs } = s.toolTabs
      closed?.open.filter(isTerminalTab).forEach(disposeTerminal)
      const { [id]: _, ...closedAgents } = s.closedAgents
      return {
        closedAgents,
        history: s.history.map((entry) =>
          entry.sessionId === id ? { sessionId: null, view: { kind: "chat" } } : entry,
        ),
        toolTabs,
      }
    }),
  setLeftOpen: (leftOpen) => set({ leftOpen }),
  setRightOpen: (rightOpen) => set({ rightOpen }),
  focusComposer: () => set((s) => ({ composerFocus: s.composerFocus + 1 })),
  openSettings: (section) => {
    const { view } = get().history[get().index]
    get().navigate({ view: { kind: "settings", section: section ?? (view.kind === "settings" ? view.section : "appearance") } })
  },
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  openFind: () => set((s) => ({ find: { open: true, focus: s.find.focus + 1 } })),
  closeFind: () => set((s) => ({ find: { ...s.find, open: false } })),
  openTracker: (kind) => {
    const { history, index, trackerTabs, navigate } = get()
    const at = trackerTabs[kind]
    navigate({ view: history[index].view.kind === kind || !at ? { kind } : { kind, ...at } })
  },
  closeTracker: (kind) => {
    set((s) => {
      const { [kind]: _, ...trackerTabs } = s.trackerTabs
      return { trackerTabs }
    })
    if (get().history[get().index].view.kind === kind) get().navigate({ view: { kind: "chat" } })
  },
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
    if (isAgentTab(partId)) {
      set((s) => ({
        closedAgents: { ...s.closedAgents, [sessionId]: [...(s.closedAgents[sessionId] ?? []), partId] },
      }))
    }
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
  showAgentTabs: (sessionId, agents) =>
    set((s) => {
      const tabs = s.toolTabs[sessionId] ?? NO_TABS
      const closed = s.closedAgents[sessionId] ?? []
      const added = agents.map(agentTabKey).filter((key) => !tabs.open.includes(key) && !closed.includes(key))
      if (added.length === 0) return {}
      return { toolTabs: { ...s.toolTabs, [sessionId]: { ...tabs, open: [...tabs.open, ...added] } } }
    }),
}))

export const useToolTabs = (sessionId: string) => useUi((s) => s.toolTabs[sessionId] ?? NO_TABS)

export const useCurrent = () => useUi((s) => s.history[s.index])
