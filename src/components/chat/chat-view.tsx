import { useEffect, useLayoutEffect, useState } from "react"

import { isTerminalTab } from "@/lib/terminals"
import { useSessions } from "@/stores/sessions"
import { useToolTabs } from "@/stores/ui"

import { ActivityColumn } from "./activity-column"
import { ChatHeader } from "./chat-header"
import { Composer } from "./composer"
import { TerminalView } from "./terminal-view"
import { ToolView } from "./tool-view"
import { Transcript } from "./transcript"

// The side columns take the room either side of the conversation, never squeezing it below this.
const MIN_CENTER = 480
const SIDE_MIN = 200
const SIDE_MAX = 360
const CENTER = 768

export function ChatView({ sessionId }: { sessionId: string | null }) {
  const session = useSessions((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const load = useSessions((s) => s.load)
  const refreshUsage = useSessions((s) => s.refreshUsage)
  const [ref, width] = useWidth()
  const tabs = useToolTabs(sessionId ?? "")

  useEffect(() => {
    if (sessionId) void load(sessionId).then(() => refreshUsage(sessionId))
  }, [sessionId, load, refreshUsage])

  if (!sessionId || (session && session.messages.length === 0)) {
    return (
      <div className="scrollbar-hidden flex h-full items-center justify-center overflow-y-auto px-6 pb-[8vh]">
        <div className="w-full max-w-3xl">
          <Composer sessionId={sessionId} variant="hero" />
        </div>
      </div>
    )
  }

  // Loading a saved chat: keep the pane blank rather than flashing the empty state.
  if (!session) return null

  const side = Math.min(SIDE_MAX, Math.max(SIDE_MIN, (width - CENTER) / 2))
  // Too narrow for columns: tool calls stay inline in the transcript.
  const split = width - 2 * side >= MIN_CENTER

  return (
    <div
      ref={ref}
      className="grid h-full"
      style={{ gridTemplateColumns: split ? `${side}px minmax(0, 1fr) ${side}px` : "minmax(0, 1fr)" }}
    >
      {split && <ActivityColumn sessionId={session.id} lane="reads" messages={session.messages} />}
      <div className="flex min-h-0 min-w-0 flex-col">
        <ChatHeader sessionId={session.id} title={session.title} messages={session.messages} usage={session.usage} />
        {tabs.open.filter(isTerminalTab).map((key) => (
          <TerminalView key={key} tabKey={key} active={tabs.active === key} />
        ))}
        {tabs.active && !isTerminalTab(tabs.active) && (
          <ToolView key={tabs.active} sessionId={session.id} partId={tabs.active} />
        )}
        {/* Kept mounted under a file tab so the conversation keeps its scroll position. */}
        <div className={tabs.active ? "hidden" : "contents"}>
          <Transcript sessionId={session.id} messages={session.messages} split={split} />
          <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-4">
            <Composer sessionId={sessionId} variant="docked" />
          </div>
        </div>
      </div>
      {split && <ActivityColumn sessionId={session.id} lane="actions" messages={session.messages} />}
    </div>
  )
}

function useWidth() {
  const [el, ref] = useState<HTMLDivElement | null>(null)
  const [width, setWidth] = useState(0)
  // Measured before paint so the columns don't pop in a frame late.
  useLayoutEffect(() => {
    if (!el) return
    setWidth(el.getBoundingClientRect().width)
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width))
    observer.observe(el)
    return () => observer.disconnect()
  }, [el])
  return [ref, width] as const
}
