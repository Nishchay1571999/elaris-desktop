import { Check, Copy, SquareTerminal, X } from "lucide-react"
import { useState } from "react"

import type { Message } from "@/bindings/Message"
import type { TokenUsage } from "@/bindings/TokenUsage"
import { Tooltip } from "@/components/ui/tooltip"
import { isTerminalTab, useTerminalTabs } from "@/lib/terminals"
import { cn } from "@/lib/utils"
import { useSessions } from "@/stores/sessions"
import { useToolTabs, useUi } from "@/stores/ui"

import { findPart, toolPath } from "./tool-view"

/** Shared by the chat and both side columns so their headers line up. */
export const HEADER = "flex h-11 shrink-0 items-center"

/**
 * Editor-style tabs over the chat: the conversation ("Elaris") first, then any Write/Edit
 * calls opened from the side column and terminals opened with ⌘T / Ctrl+T. Shows the tokens used so far while the chat is in front.
 */
export function ChatHeader({
  sessionId,
  title,
  messages,
  usage,
}: {
  sessionId: string
  title: string
  messages: Message[]
  usage: TokenUsage
}) {
  const tabs = useToolTabs(sessionId)
  const select = useUi((s) => s.selectToolTab)
  const close = useUi((s) => s.closeToolTab)
  const terminals = useTerminalTabs()

  return (
    <header className={cn(HEADER, "gap-4 px-3")}>
      <div role="tablist" aria-label="Open tabs" className="scrollbar-hidden flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        <Tab active={tabs.active === null} onSelect={() => select(sessionId, null)}>
          <span className="font-medium">Elaris</span>
        </Tab>
        <CopyConversation title={title} messages={messages} />
        {tabs.open.map((id) => {
          if (isTerminalTab(id)) {
            const terminal = terminals[id]
            const title = terminal?.title ?? "Terminal"
            return (
              <Tab
                key={id}
                active={tabs.active === id}
                title={terminal?.agent ? `${title} · started by Elaris` : title}
                onSelect={() => select(sessionId, id)}
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
          const part = findPart(messages, id)
          const path = part ? toolPath(part) : "Unavailable"
          return (
            <Tab
              key={id}
              active={tabs.active === id}
              title={path}
              onSelect={() => select(sessionId, id)}
              onClose={() => close(sessionId, id)}
            >
              <span className="max-w-40 truncate">{path.split("/").pop()}</span>
            </Tab>
          )
        })}
      </div>
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

/** Copies the conversation as a Markdown README: the messages only, no tool calls. Nothing is saved. */
function CopyConversation({ title, messages }: { title: string; messages: Message[] }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(conversationMarkdown(title, messages))
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      useSessions.setState({ error: "Couldn't copy the conversation" })
    }
  }

  return (
    <Tooltip label={copied ? "Copied" : "Copy conversation as README"}>
      <button
        type="button"
        onClick={() => void copy()}
        aria-label="Copy conversation as README"
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </Tooltip>
  )
}

function conversationMarkdown(title: string, messages: Message[]): string {
  const sections = messages.flatMap((message) => {
    const text =
      message.role === "user"
        ? message.content
        : message.parts.length > 0
          ? message.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n")
          : message.content
    if (!text.trim()) return []
    return [`## ${message.role === "user" ? "You" : "Elaris"}\n\n${text.trim()}`]
  })
  return `# ${title || "Conversation"}\n\n${sections.join("\n\n---\n\n")}\n`
}

function compact(n: number): string {
  if (n < 1000) return String(n)
  const [value, unit] = n < 1_000_000 ? [n / 1000, "k"] : [n / 1_000_000, "M"]
  return `${value.toFixed(value < 100 ? 1 : 0).replace(/\.0$/, "")}${unit}`
}
