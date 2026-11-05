import {
  ArrowLeft,
  ArrowRight,
  CircleDot,
  Command as CommandIcon,
  FileDiff,
  FolderOpen,
  GitPullRequest,
  GitPullRequestCreate,
  type LucideIcon,
  PanelLeft,
  PanelRight,
  Plus,
  Search,
  Settings,
  SquareTerminal,
  SunMoon,
  TextCursorInput,
} from "lucide-react"

import { isDarkShowing } from "@/lib/appearance"
import type { Binding } from "@/lib/keybindings"
import { usePreferences } from "@/stores/preferences"
import { useSessions } from "@/stores/sessions"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

export type CommandGroup = "General" | "Navigation" | "View" | "Chat"

/**
 * Something the user can do from the ⌘K palette and, if it has one, a shortcut.
 * Settings → Keyboard lists these and lets the user rebind them.
 */
export interface Command {
  id: string
  title: string
  group: CommandGroup
  icon: LucideIcon
  keywords?: string[]
  /** Default shortcut, if any. */
  binding?: Binding
  /** False hides it from the palette and skips its shortcut (the key then goes through). */
  available?: () => boolean
  run: () => void
}

const ui = () => useUi.getState()

// Loaded lazily: the dialog's module imports this one.
const openCreatePr = async () => (await import("@/components/pulls/create-pr-dialog")).useCreatePr()()

/** The open chat with messages, if the conversation is what's showing. */
function openChat(): string | null {
  const { sessionId, view } = ui().history[ui().index]
  const session = sessionId ? useSessions.getState().sessions[sessionId] : undefined
  return view.kind === "chat" && session?.messages.length ? session.id : null
}

export const COMMANDS: Command[] = [
  {
    id: "palette.open",
    title: "Command palette",
    group: "General",
    icon: CommandIcon,
    binding: "mod+k",
    run: () => ui().setPaletteOpen(!ui().paletteOpen),
  },
  {
    id: "chat.new",
    title: "New chat",
    group: "Chat",
    icon: Plus,
    binding: "mod+n",
    run: () => ui().newChat(),
  },
  {
    id: "chat.focus",
    title: "Focus the message box",
    group: "Chat",
    icon: TextCursorInput,
    keywords: ["composer", "prompt"],
    binding: "mod+l",
    available: () => ui().history[ui().index].view.kind === "chat",
    run: () => ui().focusComposer(),
  },
  {
    id: "chat.find",
    title: "Find in chat",
    group: "Chat",
    icon: Search,
    keywords: ["search", "transcript"],
    binding: "mod+f",
    // The conversation itself, not a tab over it.
    available: () => {
      const id = openChat()
      return id !== null && !ui().toolTabs[id]?.active
    },
    run: () => ui().openFind(),
  },
  {
    id: "terminal.new",
    title: "New terminal",
    group: "Chat",
    icon: SquareTerminal,
    keywords: ["shell"],
    binding: "mod+t",
    // Only where the tab bar shows: a chat with messages, not the new-chat screen.
    available: () => openChat() !== null,
    run: () => {
      const id = openChat()
      if (id) void ui().openTerminal(id)
    },
  },
  {
    id: "workspace.open",
    title: "Open folder…",
    group: "General",
    icon: FolderOpen,
    keywords: ["project", "workspace"],
    binding: "mod+o",
    run: () => void useWorkspace.getState().pickAndOpen(),
  },
  {
    id: "pulls.open",
    title: "Pull requests",
    group: "General",
    icon: GitPullRequest,
    keywords: ["github", "pr", "review"],
    binding: "mod+shift+p",
    run: () => ui().openTracker("pulls"),
  },
  {
    id: "issues.open",
    title: "Issues",
    group: "General",
    icon: CircleDot,
    keywords: ["github", "issue", "bug"],
    run: () => ui().openTracker("issues"),
  },
  {
    id: "pr.create",
    title: "New pull request…",
    group: "General",
    icon: GitPullRequestCreate,
    keywords: ["github", "pr", "push"],
    available: () => Boolean(useWorkspace.getState().info?.isGit),
    run: () => void openCreatePr(),
  },
  {
    id: "settings.open",
    title: "Settings",
    group: "General",
    icon: Settings,
    keywords: ["preferences"],
    binding: "mod+,",
    run: () => ui().openSettings(),
  },
  {
    id: "theme.toggle",
    title: "Toggle light and dark theme",
    group: "View",
    icon: SunMoon,
    keywords: ["appearance", "mode"],
    binding: "mod+shift+l",
    run: () => usePreferences.getState().set({ theme: isDarkShowing() ? "light" : "dark" }),
  },
  {
    id: "view.sidebar",
    title: "Toggle sidebar",
    group: "View",
    icon: PanelLeft,
    binding: "mod+b",
    run: () => ui().setLeftOpen(!ui().leftOpen),
  },
  {
    id: "view.rightPanel",
    title: "Toggle files panel",
    group: "View",
    icon: PanelRight,
    binding: "mod+alt+b",
    run: () => ui().setRightOpen(!ui().rightOpen),
  },
  {
    id: "view.changes",
    title: "Show changes",
    group: "View",
    icon: FileDiff,
    keywords: ["git", "diff"],
    binding: "mod+shift+g",
    run: () => ui().setRightOpen(true),
  },
  {
    id: "nav.back",
    title: "Go back",
    group: "Navigation",
    icon: ArrowLeft,
    binding: "mod+[",
    run: () => ui().back(),
  },
  {
    id: "nav.forward",
    title: "Go forward",
    group: "Navigation",
    icon: ArrowRight,
    binding: "mod+]",
    run: () => ui().forward(),
  },
]

export const commandById = (id: string) => COMMANDS.find((c) => c.id === id)

/** Each command's shortcut after the user's changes; null when unbound. */
export function effectiveBindings(overrides: Record<string, string | null>): Record<string, Binding | null> {
  return Object.fromEntries(COMMANDS.map((c) => [c.id, c.id in overrides ? overrides[c.id] : (c.binding ?? null)]))
}

/** A command's current shortcut, for tooltips and hints. */
export function useBinding(id: string): Binding | null {
  return usePreferences((s) => (id in s.keybindings ? s.keybindings[id] : (commandById(id)?.binding ?? null)))
}
