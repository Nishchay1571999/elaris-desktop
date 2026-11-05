import { useEffect, useRef } from "react"

import { agentOfTab, agentThreads, isAgentTab } from "@/lib/agents"
import { isTerminalTab } from "@/lib/terminals"
import { useSessions } from "@/stores/sessions"
import { useToolTabs, useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

import { AgentView } from "./agent-view"
import { ChatHeader, TabHeader } from "./chat-header"
import { Composer } from "./composer"
import { FindBar } from "./find-bar"
import { TerminalView } from "./terminal-view"
import { ToolView } from "./tool-view"
import { Transcript } from "./transcript"

export function ChatView({ sessionId }: { sessionId: string | null }) {
  const session = useSessions((s) => (sessionId ? s.sessions[sessionId] : undefined))
  const load = useSessions((s) => s.load)
  const refreshUsage = useSessions((s) => s.refreshUsage)
  const tabs = useToolTabs(sessionId ?? "")
  // Pull requests and Issues tabs stay in reach from the new-chat screen too.
  const trackerTabs = useUi((s) => Object.keys(s.trackerTabs).length > 0)
  const conversation = useRef<HTMLDivElement>(null)

  // The find bar belongs to the chat it was opened in.
  useEffect(() => () => useUi.getState().closeFind(), [sessionId])

  useEffect(() => {
    if (sessionId) void load(sessionId).then(() => refreshUsage(sessionId))
  }, [sessionId, load, refreshUsage])

  // Every subagent the chat started gets a tab, now or when the chat is opened again.
  const agentIds = session ? agentThreads(session.messages).map((t) => t.id).join(" ") : ""
  useEffect(() => {
    if (sessionId && agentIds) useUi.getState().showAgentTabs(sessionId, agentIds.split(" "))
  }, [sessionId, agentIds])

  if (!sessionId || (session && session.messages.length === 0)) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        {trackerTabs && <TabHeader sessionId={sessionId} />}
        <div className="scrollbar-hidden flex min-h-0 flex-1 items-center justify-center overflow-y-auto px-6 pb-[8vh]">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
            <HeroHeading />
            <Composer key={sessionId ?? "new"} sessionId={sessionId} variant="hero" />
          </div>
        </div>
      </div>
    )
  }

  // Loading a saved chat: keep the pane blank rather than flashing the empty state.
  if (!session) return null

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col">
      <ChatHeader
        sessionId={session.id}
        messages={session.messages}
        usage={session.usage}
        context={session.context}
        model={session.model}
      />
      {tabs.open.filter(isTerminalTab).map((key) => (
        <TerminalView key={key} tabKey={key} active={tabs.active === key} />
      ))}
      {tabs.active && isAgentTab(tabs.active) && (
        <AgentView
          key={tabs.active}
          sessionId={session.id}
          agentId={agentOfTab(tabs.active)}
          messages={session.messages}
        />
      )}
      {tabs.active && !isTerminalTab(tabs.active) && !isAgentTab(tabs.active) && (
        <ToolView key={tabs.active} sessionId={session.id} partId={tabs.active} />
      )}
      {/* Kept mounted under a file tab so the conversation keeps its scroll position. */}
      <div className={tabs.active ? "hidden" : "contents"}>
        <div ref={conversation} className="relative flex min-h-0 flex-1 flex-col">
          <FindBar scope={conversation} />
          <Transcript sessionId={session.id} messages={session.messages} />
        </div>
        <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-4">
          {/* Keyed so each chat gets its own draft back. */}
          <Composer key={sessionId} sessionId={sessionId} variant="docked" />
        </div>
      </div>
    </div>
  )
}

/** T3 Code's new-chat question, naming the open folder. */
function HeroHeading() {
  const project = useWorkspace((s) => s.info?.name)
  return (
    <h1 className="text-center text-2xl font-normal tracking-tight text-foreground sm:text-3xl">
      What should we build{project ? " in " : "?"}
      {project && (
        <>
          <span className="font-medium">{project}</span>?
        </>
      )}
    </h1>
  )
}
