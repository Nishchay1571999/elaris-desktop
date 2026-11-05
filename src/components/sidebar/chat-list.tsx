import {
  AlarmClock,
  AlarmClockOff,
  Archive,
  ArchiveRestore,
  Check,
  CircleDashed,
  Clock,
  MessageCircleQuestion,
  MessagesSquare,
  ShieldQuestion,
  Trash2,
  Undo2,
} from "lucide-react"
import { type MouseEvent, type ReactNode, useState } from "react"

import type { SessionSummary } from "@/bindings/SessionSummary"
import { Menu, MenuContent, MenuItem, MenuLabel, MenuTrigger } from "@/components/ui/menu"
import { Tooltip } from "@/components/ui/tooltip"
import { ProjectLogo } from "@/components/workspace/project-logo"
import { ipc } from "@/lib/ipc"
import { cn, relativeTime } from "@/lib/utils"
import { hasWoken, type Section, snoozePresets, useChatStatus, wakeLabel } from "@/stores/chat-status"
import { useSessions } from "@/stores/sessions"
import { useCurrent, useUi } from "@/stores/ui"

/** How much of the first message a row shows. */
const PREVIEW_CHARS = 20

export function ChatList({ sessions, section, now }: { sessions: SessionSummary[]; section: Section; now: number }) {
  return (
    <ul className="flex flex-col gap-px">
      {sessions.map((session) => (
        <ChatItem key={session.id} session={session} section={section} now={now} />
      ))}
    </ul>
  )
}

function previewOf(text: string): string {
  if (!text) return "Image"
  return text.length > PREVIEW_CHARS ? `${text.slice(0, PREVIEW_CHARS).trimEnd()}…` : text
}

/** What the agent is doing, when it is; it takes the time's place. */
function useLiveStatus(id: string, section: Section) {
  const request = useSessions((s) => s.requests[id]?.[0])
  if (request?.type === "question") return { label: "Input", icon: MessageCircleQuestion, className: "text-brand" }
  if (request) return { label: "Approval", icon: ShieldQuestion, className: "text-git-modified" }
  if (section === "working") return { label: "Working", icon: CircleDashed, className: "text-brand" }
  return null
}

/**
 * One chat: its project's logo, the title in bold, the start of its first
 * message underneath, and the time or what the agent is doing. Pointing at it
 * swaps the time for the row's actions, live chats included.
 */
function ChatItem({ session, section, now }: { session: SessionSummary; section: Section; now: number }) {
  const current = useCurrent()
  const navigate = useUi((s) => s.navigate)
  const { rename, remove } = useSessions()
  const status = useChatStatus((s) => s.chats[session.id])
  const { close, archive, trash, snooze, acknowledge } = useChatStatus()
  const [editing, setEditing] = useState(false)
  const [snoozing, setSnoozing] = useState(false)
  const active = current.sessionId === session.id && current.view.kind === "chat"
  const live = useLiveStatus(session.id, section)
  const woke = section === "active" && hasWoken(status, now)
  const receded = section === "closed" || section === "archived" || section === "deleted"

  const open = () => {
    navigate({ sessionId: session.id, view: { kind: "chat" } })
    acknowledge(session.id)
  }

  const deleteForGood = async () => {
    if (await ipc.dialog.confirm(`“${session.title}” will be permanently deleted.`, "Delete chat?")) {
      await remove(session.id)
    }
  }

  if (editing) {
    return (
      <li>
        <input
          autoFocus
          defaultValue={session.title}
          aria-label="Chat title"
          onFocus={(e) => e.target.select()}
          onBlur={(e) => {
            setEditing(false)
            void rename(session.id, e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur()
            if (e.key === "Escape") setEditing(false)
          }}
          className="h-[52px] w-full rounded-md border border-input bg-surface-sunken px-2.5 text-sm font-semibold outline-none focus:ring-3 focus:ring-ring/50"
        />
      </li>
    )
  }

  // The actions sit inside the row; using one doesn't open the chat.
  const act = (run: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    run()
  }

  const actions: ReactNode =
    section === "deleted" ? (
      <>
        <RowAction label="Restore chat" onClick={act(() => trash(session.id, false))}>
          <Undo2 />
        </RowAction>
        <RowAction label="Delete for good" destructive onClick={act(() => void deleteForGood())}>
          <Trash2 />
        </RowAction>
      </>
    ) : (
      <>
        {section === "closed" ? (
          <RowAction label="Reopen chat" onClick={act(() => close(session.id, false))}>
            <Undo2 />
          </RowAction>
        ) : section !== "archived" ? (
          <RowAction label="Close chat" onClick={act(() => close(session.id, true))}>
            <Check />
          </RowAction>
        ) : null}
        {section === "snoozed" ? (
          <RowAction label="Wake chat now" onClick={act(() => snooze(session.id, null))}>
            <AlarmClockOff />
          </RowAction>
        ) : section !== "archived" ? (
          <Menu open={snoozing} onOpenChange={setSnoozing}>
            <Tooltip label="Snooze" side="top">
              <MenuTrigger asChild>
                <button
                  type="button"
                  aria-label="Snooze chat"
                  onClick={(e) => e.stopPropagation()}
                  className={actionClass}
                >
                  <Clock />
                </button>
              </MenuTrigger>
            </Tooltip>
            <MenuContent align="end" className="min-w-56" onClick={(e) => e.stopPropagation()}>
              <MenuLabel>Snooze until</MenuLabel>
              {snoozePresets().map((preset) => (
                <MenuItem key={preset.until} onSelect={() => snooze(session.id, preset.until)}>
                  <span className="flex-1">{preset.label}</span>
                  <span className="text-[11px] text-subtle-foreground tabular-nums">{preset.when}</span>
                </MenuItem>
              ))}
            </MenuContent>
          </Menu>
        ) : null}
        {section === "archived" ? (
          <RowAction label="Unarchive chat" onClick={act(() => archive(session.id, false))}>
            <ArchiveRestore />
          </RowAction>
        ) : (
          <RowAction label="Archive chat" onClick={act(() => archive(session.id, true))}>
            <Archive />
          </RowAction>
        )}
        <RowAction label="Delete chat" onClick={act(() => trash(session.id, true))}>
          <Trash2 />
        </RowAction>
      </>
    )

  return (
    <li className="list-none">
      <div
        role="button"
        tabIndex={0}
        aria-current={active ? "page" : undefined}
        onClick={open}
        onDoubleClick={() => setEditing(true)}
        onKeyDown={(e) => {
          if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) {
            e.preventDefault()
            open()
          }
        }}
        title={session.workspace ? `${session.title}\n${session.workspace}` : session.title}
        className={cn(
          "group/sidebar-row relative flex w-full cursor-pointer items-start gap-2.5 rounded-md px-2.5 py-2 text-left outline-none select-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
          active ? "bg-sidebar-selected" : "hover:bg-sidebar-accent",
          // Keeps the actions showing while the snooze menu is open.
          snoozing && "bg-sidebar-accent",
        )}
      >
        {/* Other chats' logos recede until the row is pointed at. */}
        <span
          className={cn(
            "mt-0.5 flex shrink-0 items-center transition-opacity",
            (!active || receded) &&
              "opacity-50 grayscale group-hover/sidebar-row:opacity-100 group-hover/sidebar-row:grayscale-0 group-focus-within/sidebar-row:opacity-100 group-focus-within/sidebar-row:grayscale-0",
          )}
        >
          {session.workspace ? (
            <ProjectLogo root={session.workspace} className="size-4" />
          ) : (
            <MessagesSquare aria-hidden className="size-4 text-muted-foreground" />
          )}
        </span>

        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex h-5 min-w-0 items-center gap-2">
            <span
              className={cn(
                "min-w-0 flex-1 truncate text-[14px] leading-5 font-semibold",
                receded ? "text-sidebar-foreground/65 group-hover/sidebar-row:text-sidebar-foreground" : "text-sidebar-foreground",
              )}
            >
              {session.title}
            </span>

            {/* The time or the live status; pointing at the row swaps it for the actions. */}
            <span
              className={cn(
                "shrink-0 items-center text-xs text-muted-foreground tabular-nums",
                snoozing ? "hidden" : "flex group-hover/sidebar-row:hidden group-focus-within/sidebar-row:hidden",
              )}
            >
              {live ? (
                <span className={cn("inline-flex items-center gap-1 font-medium", live.className)}>
                  <live.icon aria-hidden className="size-3" />
                  {live.label}
                </span>
              ) : section === "snoozed" && status?.snoozedUntil ? (
                <span className="inline-flex items-center gap-1 text-brand">
                  <AlarmClock aria-hidden className="size-3" />
                  {wakeLabel(status.snoozedUntil, now)}
                </span>
              ) : woke ? (
                <span role="status" className="inline-flex items-center gap-1 font-medium text-git-modified">
                  <AlarmClock aria-hidden className="size-3" />
                  Woke
                </span>
              ) : (
                relativeTime(session.updatedAt, now)
              )}
            </span>
            <span
              className={cn(
                "-my-1 -mr-1 shrink-0 items-center gap-px",
                snoozing ? "flex" : "hidden group-hover/sidebar-row:flex group-focus-within/sidebar-row:flex",
              )}
            >
              {actions}
            </span>
          </span>

          <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-muted-foreground">
            {/* A live chat keeps saying so while the actions cover its status. */}
            {live && <span aria-hidden className={cn("size-1.5 shrink-0 animate-pulse rounded-full bg-current", live.className)} />}
            <span className="truncate">{previewOf(session.preview)}</span>
          </span>
        </span>
      </div>
    </li>
  )
}

const actionClass =
  "flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5 [&_svg]:stroke-[1.75]"

/** One of a row's icon actions, named by its tooltip. */
function RowAction({
  label,
  onClick,
  destructive = false,
  children,
}: {
  label: string
  onClick: (e: MouseEvent) => void
  destructive?: boolean
  children: ReactNode
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        onDoubleClick={(e) => e.stopPropagation()}
        className={cn(actionClass, destructive && "hover:text-destructive")}
      >
        {children}
      </button>
    </Tooltip>
  )
}
