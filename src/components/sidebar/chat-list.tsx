import { MoreHorizontal, Pencil, Trash2 } from "lucide-react"
import { useState } from "react"

import type { SessionSummary } from "@/bindings/SessionSummary"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { ipc } from "@/lib/ipc"
import { cn, relativeTime } from "@/lib/utils"
import { useSessions } from "@/stores/sessions"
import { useCurrent, useUi } from "@/stores/ui"

export function ChatList({ sessions }: { sessions: SessionSummary[] }) {
  return (
    <ul className="flex flex-col gap-px pb-2">
      {sessions.map((session) => (
        <ChatItem key={session.id} session={session} />
      ))}
    </ul>
  )
}

function ChatItem({ session }: { session: SessionSummary }) {
  const current = useCurrent()
  const navigate = useUi((s) => s.navigate)
  const streaming = useSessions((s) => Boolean(s.streaming[session.id]))
  const { rename, remove } = useSessions()
  const [editing, setEditing] = useState(false)
  const active = current.sessionId === session.id && current.view.kind === "chat"

  const confirmDelete = async () => {
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
          className="h-7 w-full rounded-md border border-input bg-surface-sunken px-2 text-[13px] outline-none focus:ring-3 focus:ring-ring/50"
        />
      </li>
    )
  }

  return (
    <li className="group relative">
      <button
        type="button"
        onClick={() => navigate({ sessionId: session.id, view: { kind: "chat" } })}
        onDoubleClick={() => setEditing(true)}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-7 w-full items-center gap-2 rounded-md pr-8 pl-7 text-left text-[13px] text-sidebar-foreground/85 transition-colors outline-none hover:bg-sidebar-accent focus-visible:ring-3 focus-visible:ring-ring/50",
          active && "bg-sidebar-selected text-sidebar-foreground",
        )}
      >
        {streaming && <span aria-label="Replying" className="absolute left-3 size-1.5 animate-pulse rounded-full bg-brand" />}
        <span className="min-w-0 flex-1 truncate">{session.title}</span>
        <span className="text-[11px] text-subtle-foreground group-hover:invisible">{relativeTime(session.updatedAt)}</span>
      </button>
      <Menu>
        <MenuTrigger asChild>
          <button
            type="button"
            aria-label={`Actions for ${session.title}`}
            className="absolute top-1 right-1 flex size-5 items-center justify-center rounded text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-muted hover:text-foreground focus-visible:opacity-100 data-[state=open]:opacity-100"
          >
            <MoreHorizontal className="size-3.5" />
          </button>
        </MenuTrigger>
        <MenuContent align="end" className="min-w-36">
          <MenuItem onSelect={() => setEditing(true)}>
            <Pencil /> Rename
          </MenuItem>
          <MenuItem onSelect={() => void confirmDelete()} className="text-destructive [&_svg]:text-destructive">
            <Trash2 /> Delete
          </MenuItem>
        </MenuContent>
      </Menu>
    </li>
  )
}
