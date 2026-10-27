import { MessagesSquare, Search, X } from "lucide-react"
import { useMemo, useRef, useState } from "react"

import { Button, IconButton, Kbd } from "@/components/ui/button"
import { isMac } from "@/lib/utils"
import { useSessions } from "@/stores/sessions"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

import { ChatList } from "./chat-list"
import { CustomizationsNav } from "./customizations-nav"

export function Sidebar() {
  const summaries = useSessions((s) => s.summaries)
  const root = useWorkspace((s) => s.info?.root)
  const newChat = useUi((s) => s.newChat)
  const [query, setQuery] = useState("")
  const [searching, setSearching] = useState(false)
  const searchRef = useRef<HTMLInputElement>(null)

  // Chats belong to the project they were started in; with none open, only project-less chats show.
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase()
    return summaries.filter((s) => s.workspace === (root ?? null) && (!q || s.title.toLowerCase().includes(q)))
  }, [summaries, query, root])

  const closeSearch = () => {
    setSearching(false)
    setQuery("")
  }

  return (
    <nav aria-label="Sessions" className="flex h-full flex-col bg-sidebar">
      <div className="flex h-11 shrink-0 items-center gap-1 px-3">
        <h2 className="flex-1 text-[13px] font-semibold">Sessions</h2>
        <Button onClick={newChat} className="h-6 gap-2 border border-border-strong px-2 text-xs text-foreground">
          New <Kbd className="border-none px-0">{isMac ? "⌘N" : "Ctrl+N"}</Kbd>
        </Button>
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
        <div role="search" className="px-3 pb-2">
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

      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        <div className="flex items-center gap-2 px-1.5 py-1.5 text-[13px] font-medium text-muted-foreground">
          <MessagesSquare className="size-3.5" />
          Chats
        </div>
        {visible.length === 0 ? (
          <p className="px-7 py-1 text-xs text-subtle-foreground">{query ? "No matching chats" : "No chats"}</p>
        ) : (
          <ChatList sessions={visible} />
        )}
      </div>

      <CustomizationsNav />
    </nav>
  )
}

