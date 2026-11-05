import { create } from "zustand"
import { persist } from "zustand/middleware"

import type { SessionSummary } from "@/bindings/SessionSummary"

/**
 * Where a chat sits in the sidebar: closed (T3 Code's "settled"), archived,
 * deleted (kept here until deleted for good) or snoozed until a time. Kept in
 * this window's local storage only; the backend never sees it.
 */
export interface ChatStatus {
  closedAt?: number
  archivedAt?: number
  deletedAt?: number
  snoozedUntil?: number
}

/** The shelves in the bar at the bottom of the sidebar. */
export type Shelf = "working" | "snoozed" | "closed" | "archived" | "deleted"
export type Section = "active" | Shelf

interface ChatStatusState {
  chats: Record<string, ChatStatus>
  /** The shelf open above the bar, if any. */
  shelf: Shelf | null
  /** Whether chats from before the shelves existed have been sorted once. */
  migrated: boolean
  toggleShelf: (shelf: Shelf) => void
  close: (id: string, closed: boolean) => void
  archive: (id: string, archived: boolean) => void
  /** Moves a chat to Deleted; deleting it for good is the sessions store's job. */
  trash: (id: string, deleted: boolean) => void
  snooze: (id: string, until: number | null) => void
  /** Clears a snooze that has run out, once the chat has been looked at. */
  acknowledge: (id: string) => void
  forget: (id: string) => void
  /** Closes every chat that isn't in `root`, the first time the sidebar sees them. */
  migrate: (summaries: SessionSummary[], root: string) => void
}

export const useChatStatus = create<ChatStatusState>()(
  persist(
    (set) => {
      // Each status replaces the last: a chat sits on one shelf at a time.
      const patch = (id: string, status: ChatStatus) => set((s) => ({ chats: { ...s.chats, [id]: status } }))
      return {
        chats: {},
        shelf: "working",
        migrated: false,
        toggleShelf: (shelf) => set((s) => ({ shelf: s.shelf === shelf ? null : shelf })),
        close: (id, closed) => patch(id, closed ? { closedAt: Date.now() } : {}),
        archive: (id, archived) => patch(id, archived ? { archivedAt: Date.now() } : {}),
        trash: (id, deleted) => patch(id, deleted ? { deletedAt: Date.now() } : {}),
        snooze: (id, until) => patch(id, until ? { snoozedUntil: until } : {}),
        acknowledge: (id) =>
          set((s) => {
            const until = s.chats[id]?.snoozedUntil
            return until && until <= Date.now() ? { chats: { ...s.chats, [id]: {} } } : s
          }),
        forget: (id) =>
          set((s) => {
            const { [id]: _, ...chats } = s.chats
            return { chats }
          }),
        migrate: (summaries, root) =>
          set((s) => {
            if (s.migrated) return s
            const now = Date.now()
            const chats = { ...s.chats }
            for (const chat of summaries) {
              if (chat.workspace !== root && !chats[chat.id]) chats[chat.id] = { closedAt: now }
            }
            return { chats, migrated: true }
          }),
      }
    },
    {
      name: "elaris.chat-status",
      version: 2,
      // Before version 2 there were pins and three shelves that each opened on their own.
      migrate: (old) => {
        const { chats = {} } = (old ?? {}) as { chats?: Record<string, ChatStatus & { pinnedAt?: number }> }
        const kept = Object.fromEntries(
          Object.entries(chats).map(([id, { closedAt, snoozedUntil }]) => [
            id,
            closedAt ? { closedAt } : snoozedUntil ? { snoozedUntil } : {},
          ]),
        )
        return { chats: kept, shelf: "working", migrated: false }
      },
    },
  ),
)

/**
 * The sidebar section for a chat. Deleted wins over everything; then a chat
 * that is replying sits in Working. A closed or archived chat that has had a
 * reply since comes back to the list.
 */
export function sectionOf(status: ChatStatus | undefined, updatedAt: number, working: boolean, now: number): Section {
  if (status?.deletedAt) return "deleted"
  if (working) return "working"
  if (status?.snoozedUntil && status.snoozedUntil > now) return "snoozed"
  if (status?.archivedAt && status.archivedAt >= updatedAt) return "archived"
  if (status?.closedAt && status.closedAt >= updatedAt) return "closed"
  return "active"
}

/** A snooze that has run out and hasn't been looked at. */
export function hasWoken(status: ChatStatus | undefined, now: number): boolean {
  return Boolean(status?.snoozedUntil && status.snoozedUntil <= now)
}

export interface SnoozePreset {
  label: string
  /** When it wakes, e.g. "6:00 PM" or "Mon 9:00 AM". */
  when: string
  until: number
}

const timeOf = (date: Date) => date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })

/** T3 Code's default snooze choices: in 1 hour, in 3 hours, this evening, tomorrow, next week. */
export function snoozePresets(now = new Date()): SnoozePreset[] {
  const at = (daysAhead: number, hour: number) => {
    const d = new Date(now)
    d.setDate(d.getDate() + daysAhead)
    d.setHours(hour, 0, 0, 0)
    return d
  }
  const after = (minutes: number) => new Date(now.getTime() + minutes * 60_000)
  const toMonday = (8 - now.getDay()) % 7 || 7

  const presets = [
    { label: "In 1 hour", wake: after(60) },
    { label: "In 3 hours", wake: after(180) },
    { label: "This evening", wake: at(0, 18) },
    { label: "Tomorrow", wake: at(1, 9) },
    { label: toMonday === 1 ? "Tomorrow" : "Next week", wake: at(toMonday, 9) },
  ]
  const seen = new Set<number>()
  return presets
    .filter(({ wake }) => wake.getTime() > now.getTime())
    .filter(({ wake }) => !seen.has(wake.getTime()) && Boolean(seen.add(wake.getTime())))
    .sort((a, b) => a.wake.getTime() - b.wake.getTime())
    .map(({ label, wake }) => ({ label, when: wakeLabel(wake.getTime(), now.getTime()), until: wake.getTime() }))
}

/** When a snoozed chat wakes, for its row: "6:00 PM", or "Mon 9:00 AM" on another day. */
export function wakeLabel(until: number, now = Date.now()): string {
  const d = new Date(until)
  return d.toDateString() === new Date(now).toDateString()
    ? timeOf(d)
    : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${timeOf(d)}`
}
