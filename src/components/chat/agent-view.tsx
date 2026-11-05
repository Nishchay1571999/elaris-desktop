import { ArrowDown, ArrowUp, Bot, Clock } from "lucide-react"
import { useState } from "react"

import type { Message } from "@/bindings/Message"
import type { SubagentStatus } from "@/bindings/SubagentStatus"
import { useFollowBottom } from "@/hooks/use-follow-bottom"
import { agentThread } from "@/lib/agents"
import { cn } from "@/lib/utils"
import { type QueuedInput, useSessions } from "@/stores/sessions"
import { useUi } from "@/stores/ui"

import { Markdown } from "./markdown"
import { ToolRow } from "./tool-row"

const NO_QUEUE: QueuedInput[] = []

export const STATUS_LABEL: Record<SubagentStatus, string> = {
  running: "Working",
  completed: "Done",
  failed: "Failed",
  stopped: "Stopped",
}

/**
 * A subagent's own tab: everything it was asked and did, across every reply that ran it,
 * with a box to send it more. The tab stays after the agent ends; sending resumes it.
 */
export function AgentView({ sessionId, agentId, messages }: { sessionId: string; agentId: string; messages: Message[] }) {
  const thread = agentThread(messages, agentId)
  const queued = useSessions((s) => s.queued[sessionId] ?? NO_QUEUE).filter((q) => q.agent === agentId)
  const waitingOnUser = useSessions((s) => (s.requests[sessionId]?.length ?? 0) > 0)
  const scroller = useFollowBottom<HTMLDivElement>([thread, queued])
  const running = thread?.status === "running"

  return (
    <>
      <div ref={scroller} className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pt-4 pb-6">
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Bot className="size-3.5 text-brand" />
            <span className="font-medium text-foreground">{thread?.description || "Agent"}</span>
            <span aria-hidden>·</span>
            <span className={cn(thread?.status === "failed" && "text-destructive")}>
              {thread ? STATUS_LABEL[thread.status] : "Starting"}
            </span>
          </p>
          {thread?.parts.map((part, i) =>
            part.type === "input" ? (
              <UserBubble key={i} text={part.text} />
            ) : part.type === "text" ? (
              <div key={i} className={cn(running && i === thread.parts.length - 1 && "streaming-caret")}>
                <Markdown text={part.text} />
              </div>
            ) : (
              <ToolRow key={part.id} part={part} />
            ),
          )}
          {running && thread.parts.at(-1)?.type !== "text" && <WorkingDots />}
          {queued.map((q, i) => (
            <UserBubble key={`queued-${i}`} text={q.text} queued />
          ))}
          {running && waitingOnUser && (
            <button
              type="button"
              onClick={() => useUi.getState().selectToolTab(sessionId, null)}
              className="flex items-center gap-1.5 self-start text-xs text-muted-foreground hover:text-foreground"
            >
              <ArrowDown className="size-3.5" />
              Waiting for your answer in the Elaris tab
            </button>
          )}
        </div>
      </div>
      <div className="mx-auto w-full max-w-3xl shrink-0 px-6 pb-4">
        <AgentComposer sessionId={sessionId} agentId={agentId} name={thread?.description || "the agent"} />
      </div>
    </>
  )
}

function UserBubble({ text, queued }: { text: string; queued?: boolean }) {
  return (
    <div className="flex flex-col items-end gap-1">
      <div
        className={cn(
          "selectable max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap",
          queued && "opacity-60",
        )}
      >
        {text}
      </div>
      {queued && (
        <span className="flex items-center gap-1 text-[11px] text-subtle-foreground">
          <Clock className="size-3" /> Sends when the current reply ends
        </span>
      )}
    </div>
  )
}

function AgentComposer({ sessionId, agentId, name }: { sessionId: string; agentId: string; name: string }) {
  const [text, setText] = useState("")
  const sendToAgent = useSessions((s) => s.sendToAgent)

  const submit = () => {
    const message = text.trim()
    if (!message) return
    setText("")
    void sendToAgent(sessionId, agentId, message)
  }

  return (
    <div className="rounded-xl shadow-composer">
      <div className="relative rounded-xl border border-input bg-surface-elevated transition-colors focus-within:border-brand/60">
        <textarea
          value={text}
          rows={1}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
          placeholder={`Message ${name}…`}
          aria-label="Message to the agent"
          className="block max-h-48 w-full resize-none bg-transparent px-3.5 pt-3 pb-1 text-sm leading-relaxed outline-none placeholder:text-subtle-foreground"
        />
        <div className="flex items-center px-2 pb-2">
          <div className="flex-1" />
          <button
            type="button"
            aria-label="Send to the agent"
            disabled={!text.trim()}
            onClick={submit}
            className="flex size-7 items-center justify-center rounded-full bg-brand text-brand-foreground transition-opacity hover:opacity-90 disabled:bg-muted disabled:text-subtle-foreground"
          >
            <ArrowUp className="size-4" />
          </button>
        </div>
      </div>
    </div>
  )
}

function WorkingDots() {
  return (
    <div aria-label="Working" className="flex h-6 items-center gap-1">
      {[0, 150, 300].map((delay) => (
        <span
          key={delay}
          className="size-1.5 animate-pulse rounded-full bg-muted-foreground"
          style={{ animationDelay: `${delay}ms` }}
        />
      ))}
    </div>
  )
}
