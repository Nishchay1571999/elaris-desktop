import { Bot, CircleDot, GitPullRequest, type LucideIcon, SquareTerminal, X } from "lucide-react"

import type { Message } from "@/bindings/Message"
import type { TokenUsage } from "@/bindings/TokenUsage"
import { Tooltip } from "@/components/ui/tooltip"
import { agentOfTab, agentThread, isAgentTab } from "@/lib/agents"
import { ipc } from "@/lib/ipc"
import { isTerminalTab, useTerminalTabs } from "@/lib/terminals"
import { contextWindow } from "@/lib/models"
import { cn } from "@/lib/utils"
import { useContexts } from "@/stores/contexts"
import { useSessions } from "@/stores/sessions"
import { isTrackerView, type TrackerTab, useCurrent, useToolTabs, useUi } from "@/stores/ui"

import { STATUS_LABEL } from "./agent-view"
import { SaveContextButton } from "./save-context-button"
import { findPart, toolPath } from "./tool-view"

/** Shared by the chat and both side columns so their headers line up. */
export const HEADER = "flex h-11 shrink-0 items-center"

const NO_MESSAGES: Message[] = []

const TRACKER_TABS: Array<{ kind: TrackerTab; label: string; icon: LucideIcon }> = [
  { kind: "pulls", label: "Pull requests", icon: GitPullRequest },
  { kind: "issues", label: "Issues", icon: CircleDot },
]

/**
 * Editor-style tabs over the chat: the conversation ("Elaris") first, then any Write/Edit
 * calls opened from the side column, terminals opened with ⌘T / Ctrl+T, and the Pull
 * requests and Issues pages. Shows the tokens used so far while the chat is in front.
 */
export function ChatHeader({
  sessionId,
  messages,
  usage,
  context,
  model,
}: {
  sessionId: string
  messages: Message[]
  usage: TokenUsage
  /** Prompt tokens of the agent's latest model call; 0 until a reply reports it. */
  context: number
  model: string
}) {
  const tabs = useToolTabs(sessionId)

  return (
    <header className={cn(HEADER, "gap-4 px-3")}>
      <TabStrip sessionId={sessionId} messages={messages} />
      {tabs.active === null && context > 0 && <ContextMeter used={context} limit={contextWindow(model)} />}
      {tabs.active === null && (
        <Tooltip
          label={
            <span className="block tabular-nums">
              {usage.input.toLocaleString()} input tokens
              {usage.cacheRead + usage.cacheWrite > 0 &&
                ` (${usage.cacheRead.toLocaleString()} read from cache, ${usage.cacheWrite.toLocaleString()} written to it)`}
              <br />
              {usage.output.toLocaleString()} output tokens
            </span>
          }
        >
          <p className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground tabular-nums">
            <span>
              <span className="text-subtle-foreground">Input</span> {compact(usage.input)}
            </span>
            <span>
              <span className="text-subtle-foreground">Output</span> {compact(usage.output)}
            </span>
          </p>
        </Tooltip>
      )}
    </header>
  )
}

/** The tab bar alone: over the Pull requests and Issues tabs, and the new-chat screen. */
export function TabHeader({ sessionId }: { sessionId: string | null }) {
  const messages = useSessions((s) => (sessionId ? s.sessions[sessionId]?.messages : undefined)) ?? NO_MESSAGES
  return (
    <header className={cn(HEADER, "gap-4 px-3")}>
      <TabStrip sessionId={sessionId} messages={messages} />
    </header>
  )
}

function TabStrip({ sessionId, messages }: { sessionId: string | null; messages: Message[] }) {
  const tabs = useToolTabs(sessionId ?? "")
  const trackerTabs = useUi((s) => s.trackerTabs)
  const close = useUi((s) => s.closeToolTab)
  const { view } = useCurrent()
  const terminals = useTerminalTabs()
  // While a Pull requests or Issues tab is in front, none of the chat's tabs is.
  const tracker = isTrackerView(view) ? view.kind : null

  const select = (id: string | null) => {
    if (sessionId) useUi.getState().selectToolTab(sessionId, id)
    if (tracker) useUi.getState().navigate({ view: { kind: "chat" } })
  }
  const active = (id: string | null) => !tracker && tabs.active === id

  return (
    <div role="tablist" aria-label="Open tabs" className="scrollbar-hidden flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
      <Tab active={active(null)} onSelect={() => select(null)}>
        <span className="font-medium">Elaris</span>
      </Tab>
      {sessionId && <SaveContext sessionId={sessionId} empty={messages.length === 0} />}
      {sessionId &&
        tabs.open.map((id) => {
          if (isTerminalTab(id)) {
            const terminal = terminals[id]
            const title = terminal?.title ?? "Terminal"
            return (
              <Tab
                key={id}
                active={active(id)}
                title={terminal?.agent ? `${title} · started by Elaris` : title}
                onSelect={() => select(id)}
                onClose={() => close(sessionId, id)}
              >
                <SquareTerminal className={cn("mr-1.5 size-3.5 shrink-0", terminal?.agent && "text-brand")} />
                <span className="max-w-40 truncate">{title}</span>
                {terminal?.agent && terminal.running && (
                  <span aria-label="Running" className="ml-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-brand" />
                )}
              </Tab>
            )
          }
          if (isAgentTab(id)) {
            const thread = agentThread(messages, agentOfTab(id))
            const title = thread?.description || "Agent"
            return (
              <Tab
                key={id}
                active={active(id)}
                title={`${title} · ${thread ? STATUS_LABEL[thread.status] : "Starting"}`}
                onSelect={() => select(id)}
                onClose={() => close(sessionId, id)}
              >
                <Bot className="mr-1.5 size-3.5 shrink-0 text-brand" />
                <span className="max-w-40 truncate">{title}</span>
                {thread?.status === "running" && (
                  <span aria-label="Running" className="ml-1.5 size-1.5 shrink-0 animate-pulse rounded-full bg-brand" />
                )}
              </Tab>
            )
          }
          const part = findPart(messages, id)
          const path = part ? toolPath(part) : "Unavailable"
          return (
            <Tab
              key={id}
              active={active(id)}
              title={path}
              onSelect={() => select(id)}
              onClose={() => close(sessionId, id)}
            >
              <span className="max-w-40 truncate">{path.split("/").pop()}</span>
            </Tab>
          )
        })}
      {TRACKER_TABS.map(({ kind, label, icon: Icon }) => {
        const at = trackerTabs[kind]
        if (!at) return null
        const place = at.number === undefined ? null : `${at.repo ?? ""}#${at.number}`
        return (
          <Tab
            key={kind}
            active={tracker === kind}
            title={place ? `${label} · ${place}` : label}
            onSelect={() => useUi.getState().navigate({ view: { kind, ...at } })}
            onClose={() => useUi.getState().closeTracker(kind)}
          >
            <Icon className="mr-1.5 size-3.5 shrink-0" />
            <span className="shrink-0">{label}</span>
            {at.number !== undefined && <span className="ml-1.5 text-subtle-foreground tabular-nums">#{at.number}</span>}
          </Tab>
        )
      })}
    </div>
  )
}

function Tab({
  active,
  title,
  onSelect,
  onClose,
  children,
}: {
  active: boolean
  title?: string
  onSelect: () => void
  onClose?: () => void
  children: React.ReactNode
}) {
  return (
    <div
      title={title}
      // Middle-click closes, as in an editor.
      onAuxClick={(e) => e.button === 1 && onClose?.()}
      className={cn(
        "group flex h-7 shrink-0 items-center rounded-md text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground",
        active && "bg-muted text-foreground",
      )}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        onClick={onSelect}
        className={cn("flex h-full items-center rounded-md outline-none focus-visible:ring-3 focus-visible:ring-ring/50", onClose ? "pr-1 pl-2.5" : "px-2.5")}
      >
        {children}
      </button>
      {onClose && (
        <button
          type="button"
          aria-label="Close tab"
          onClick={onClose}
          className={cn(
            "mr-1 flex size-4 items-center justify-center rounded text-subtle-foreground outline-none hover:bg-border hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
            !active && "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
          )}
        >
          <X className="size-3" />
        </button>
      )}
    </div>
  )
}

/**
 * Saves the chat in Elaris, whole (every tool call, command and output, plus its terminals),
 * and copies its id. Typing `#` in any chat lists saved chats to hand the agent as context.
 */
function SaveContext({ sessionId, empty }: { sessionId: string; empty: boolean }) {
  const streaming = useSessions((s) => Boolean(s.streaming[sessionId]))
  const save = useContexts((s) => s.save)
  return (
    <SaveContextButton
      sigil="#"
      noun="chat"
      disabled={streaming || empty}
      disabledLabel={streaming ? "Save once the reply finishes" : undefined}
      save={() => save(sessionId)}
      exportMarkdown={(id) => ipc.contexts.export(id)}
    />
  )
}

/** How full the agent's context window is, as a small ring. */
function ContextMeter({ used, limit }: { used: number; limit: number }) {
  const share = Math.min(1, used / limit)
  const percent = Math.round(share * 100)
  const r = 6
  const circumference = 2 * Math.PI * r
  const tone = share >= 0.9 ? "text-destructive" : share >= 0.7 ? "text-git-modified" : "text-brand"

  return (
    <Tooltip
      label={
        <span className="block tabular-nums">
          Context window {percent}% full
          <br />
          {used.toLocaleString()} of {limit.toLocaleString()} tokens
          {share >= 0.7 && (
            <>
              <br />
              <span className="text-muted-foreground">Older turns get summarised when it fills up.</span>
            </>
          )}
        </span>
      }
    >
      <p aria-label={`Context window ${percent}% full`} className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground tabular-nums">
        <svg viewBox="0 0 16 16" className="size-3.5 -rotate-90">
          <circle cx="8" cy="8" r={r} fill="none" strokeWidth="2" className="stroke-border-strong" />
          <circle
            cx="8"
            cy="8"
            r={r}
            fill="none"
            strokeWidth="2"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - share)}
            className={cn("stroke-current transition-[stroke-dashoffset]", tone)}
          />
        </svg>
        {percent}%
      </p>
    </Tooltip>
  )
}

function compact(n: number): string {
  if (n < 1000) return String(n)
  const [value, unit] = n < 1_000_000 ? [n / 1000, "k"] : [n / 1_000_000, "M"]
  return `${value.toFixed(value < 100 ? 1 : 0).replace(/\.0$/, "")}${unit}`
}
