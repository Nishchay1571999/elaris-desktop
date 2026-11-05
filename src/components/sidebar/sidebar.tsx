import {
  AlarmClock,
  Archive,
  CircleCheck,
  CircleDashed,
  CircleDot,
  GitPullRequest,
  type LucideIcon,
  Search,
  Settings,
  SquarePen,
  Trash2,
  X,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"

import { IconButton, Kbd } from "@/components/ui/button"
import { Tooltip } from "@/components/ui/tooltip"
import { useBinding } from "@/lib/commands"
import { formatBinding } from "@/lib/keybindings"
import { cn } from "@/lib/utils"
import type { SessionSummary } from "@/bindings/SessionSummary"
import { type Section, type Shelf, sectionOf, useChatStatus } from "@/stores/chat-status"
import { useSessions } from "@/stores/sessions"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

import { ChatList } from "./chat-list"
import { CustomizationsNav } from "./customizations-nav"

/** One sidebar row, at t3code's row size: 32px tall, 14px text. */
export const ROW =
  "flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-left text-sm outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/50"

export function Sidebar() {
  const summaries = useSessions((s) => s.summaries)
  const streaming = useSessions((s) => s.streaming)
  const statuses = useChatStatus((s) => s.chats)
  const shelf = useChatStatus((s) => s.shelf)
  const toggleShelf = useChatStatus((s) => s.toggleShelf)
  const root = useWorkspace((s) => s.info?.root)
  const now = useNow()
  const newChat = useUi((s) => s.newChat)
  const openSettings = useUi((s) => s.openSettings)
  const inSettings = useUi((s) => s.history[s.index].view.kind === "settings")
  const newChatKey = formatBinding(useBinding("chat.new"))
  const settingsKey = formatBinding(useBinding("settings.open"))
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Once: chats from before the shelves that belong to other projects count as done.
  useEffect(() => {
    if (root && summaries.length > 0) useChatStatus.getState().migrate(summaries, root)
  }, [root, summaries])

  // Every chat from every project, each marked with its project's logo, sorted into T3 Code's sections.
  const sections = useMemo(() => {
    const q = query.trim().toLowerCase()
    const by: Record<Section, SessionSummary[]> = {
      active: [],
      working: [],
      snoozed: [],
      closed: [],
      archived: [],
      deleted: [],
    }
    for (const s of summaries) {
      if (q && !`${s.title} ${s.preview}`.toLowerCase().includes(q)) continue
      by[sectionOf(statuses[s.id], s.updatedAt, Boolean(streaming[s.id]), now)].push(s)
    }
    const latest = (key: "closedAt" | "archivedAt" | "deletedAt") => (a: SessionSummary, b: SessionSummary) =>
      (statuses[b.id]?.[key] ?? 0) - (statuses[a.id]?.[key] ?? 0)
    by.snoozed.sort((a, b) => (statuses[a.id]?.snoozedUntil ?? 0) - (statuses[b.id]?.snoozedUntil ?? 0))
    by.closed.sort(latest("closedAt"))
    by.archived.sort(latest("archivedAt"))
    by.deleted.sort(latest("deletedAt"))
    return by
  }, [summaries, query, statuses, streaming, now])

  const closeSearch = () => {
    setSearching(false)
    setQuery("")
  }

  return (
    <nav aria-label="Sidebar" className="flex h-full flex-col bg-sidebar">
      {/* Everything above the chat list stays put; only the chats scroll. */}
      <div className="shrink-0 px-2 pt-2">
        <GitHubSwitch />
      </div>
      <div className="flex shrink-0 items-center gap-1 px-2 py-1.5">
        <button type="button" onClick={newChat} className={cn(ROW, "flex-1 text-sidebar-foreground/75")}>
          <SquarePen className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">New chat</span>
          {newChatKey && <Kbd className="border-none px-0">{newChatKey}</Kbd>}
        </button>
        <IconButton
          label="Search chats"
          onClick={() => {
            setSearching(true)
            requestAnimationFrame(() => searchRef.current?.focus())
          }}
        >
          <Search className="size-3.5" />
        </IconButton>
      </div>

      {searching && (
        <div role="search" className="px-2 pb-2">
          <div className="flex h-7 items-center gap-1.5 rounded-md border border-input bg-surface-sunken px-2 focus-within:ring-3 focus-within:ring-ring/50">
            <Search className="size-3.5 text-subtle-foreground" />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => e.key === "Escape" && closeSearch()}
              placeholder="Search chats"
              aria-label="Search chats"
              className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground"
            />
            <button type="button" aria-label="Close search" onClick={closeSearch} className="text-subtle-foreground hover:text-foreground">
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-2">
        <ChatList sessions={sections.active} section="active" now={now} />
        {sections.active.length === 0 && (
          <p className="px-2.5 py-6 text-center text-xs text-subtle-foreground">
            {query ? "No matching chats" : summaries.length === 0 ? "No chats yet" : "Every chat is on a shelf below"}
          </p>
        )}
      </div>

      <ShelfBar sections={sections} open={shelf} onToggle={toggleShelf} now={now} />

      <CustomizationsNav />
      <div className="shrink-0 border-t border-border px-2 py-1.5">
        <button
          type="button"
          aria-current={inSettings ? "page" : undefined}
          onClick={() => openSettings()}
          className={cn(ROW, "text-sidebar-foreground/75 aria-[current=page]:bg-sidebar-selected aria-[current=page]:font-medium aria-[current=page]:text-sidebar-foreground")}
        >
          <Settings className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 text-left">Settings</span>
          {settingsKey && <Kbd className="border-none px-0">{settingsKey}</Kbd>}
        </button>
      </div>
    </nav>
  )
}

const GITHUB_VIEWS = [
  { kind: "pulls", label: "Pull requests", icon: GitPullRequest },
  { kind: "issues", label: "Issues", icon: CircleDot },
] as const

/**
 * Pull requests and Issues, from every repository gh can see, stacked in one box
 * over the chats. Each opens as a tab beside the chat. Neither is selected while a
 * chat or another page is open.
 */
function GitHubSwitch() {
  const openTracker = useUi((s) => s.openTracker)
  const current = useUi((s) => s.history[s.index].view.kind)
  return (
    <div role="group" aria-label="GitHub" className="flex flex-col divide-y divide-border overflow-hidden rounded-lg border border-border">
      {GITHUB_VIEWS.map(({ kind, label, icon: Icon }) => (
        <button
          key={kind}
          type="button"
          aria-current={current === kind ? "page" : undefined}
          onClick={() => openTracker(kind)}
          className={cn(
            ROW,
            "rounded-none text-sidebar-foreground/75 aria-[current=page]:bg-sidebar-selected aria-[current=page]:font-medium aria-[current=page]:text-sidebar-foreground",
          )}
        >
          <Icon className="size-4 shrink-0 text-muted-foreground" />
          <span className="flex-1 truncate">{label}</span>
        </button>
      ))}
    </div>
  )
}

const SHELVES: Array<{ id: Shelf; label: string; icon: LucideIcon; empty: string }> = [
  { id: "working", label: "Working", icon: CircleDashed, empty: "No chat is working right now" },
  { id: "snoozed", label: "Snoozed", icon: AlarmClock, empty: "No snoozed chats" },
  { id: "closed", label: "Closed", icon: CircleCheck, empty: "No closed chats" },
  { id: "archived", label: "Archived", icon: Archive, empty: "No archived chats" },
  { id: "deleted", label: "Deleted", icon: Trash2, empty: "Nothing deleted" },
]

/**
 * The shelves, as one bar of icons under the chat list: press one to open its
 * chats above the bar, press it again to put them away. One is open at a time.
 */
function ShelfBar({
  sections,
  open,
  onToggle,
  now,
}: {
  sections: Record<Section, SessionSummary[]>
  open: Shelf | null
  onToggle: (shelf: Shelf) => void
  now: number
}) {
  const current = SHELVES.find((s) => s.id === open)
  return (
    <div className="shrink-0 border-t border-border px-2 pt-1.5 pb-1.5">
      {current && (
        <section id="sidebar-shelf" aria-label={current.label} className="pb-1.5">
          <h3 className="flex h-7 items-center gap-2 px-2.5 text-xs font-medium text-muted-foreground">
            {current.label}
            <span className="font-normal tabular-nums">{sections[current.id].length}</span>
          </h3>
          {sections[current.id].length === 0 ? (
            <p className="px-2.5 pb-1 text-xs text-subtle-foreground">{current.empty}</p>
          ) : (
            <div className="max-h-[38vh] overflow-y-auto">
              <ChatList sessions={sections[current.id]} section={current.id} now={now} />
            </div>
          )}
        </section>
      )}
      <div role="toolbar" aria-label="Shelves" className="grid grid-cols-5 gap-0.5">
        {SHELVES.map(({ id, label, icon: Icon }) => {
          const count = sections[id].length
          const pressed = open === id
          return (
            <Tooltip key={id} label={count ? `${label} · ${count}` : label} side="top">
              <button
                type="button"
                aria-label={label}
                aria-pressed={pressed}
                aria-controls={pressed ? "sidebar-shelf" : undefined}
                onClick={() => onToggle(id)}
                className={cn(
                  "flex h-8 items-center justify-center gap-1.5 rounded-md text-xs text-muted-foreground tabular-nums outline-none transition-colors hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset",
                  pressed && "bg-sidebar-selected text-sidebar-foreground",
                )}
              >
                <Icon
                  aria-hidden
                  className={cn("size-4 shrink-0 stroke-[1.75]", id === "working" && count > 0 && "text-brand")}
                />
                {count > 0 && <span>{count}</span>}
              </button>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}

/** The time, a minute at a time: ages on rows, and snoozes running out. */
function useNow() {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  return now
}
