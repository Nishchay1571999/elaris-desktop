import { CircleAlert, Clock, LoaderCircle, Pencil, RotateCcw, X } from "lucide-react"

import { Tooltip } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { type OutgoingMessage, useSessions } from "@/stores/sessions"

const NONE: OutgoingMessage[] = []

/**
 * Messages the user sent that aren't in the chat yet, stacked over the composer so a
 * message never seems to vanish while the running reply stops. Waiting and failed
 * ones can be taken back into the box (`onEdit`) or dropped.
 */
export function PendingMessages({
  sessionId,
  onEdit,
}: {
  sessionId: string
  onEdit: (message: OutgoingMessage) => void
}) {
  const messages = useSessions((s) => s.outbox[sessionId] ?? NONE)
  const streaming = useSessions((s) => Boolean(s.streaming[sessionId]))
  const { retry, unsend } = useSessions.getState()
  if (messages.length === 0) return null

  return (
    <ul aria-label="Messages waiting to send" className="mb-2 flex flex-col gap-1.5">
      {messages.map((message) => {
        const { status } = message
        const images = message.images.length
        const note =
          status === "failed"
            ? "Couldn't send"
            : status === "sending"
              ? "Sending…"
              : streaming
                ? "Sends once the current reply stops"
                : "Waiting to send"
        return (
          <li
            key={message.key}
            className={cn(
              "group flex animate-dock-in items-start gap-2.5 rounded-lg border border-border bg-surface-elevated px-3 py-2",
              status === "failed" && "border-destructive/40",
            )}
          >
            <span className="mt-0.5 shrink-0">
              {status === "sending" ? (
                <LoaderCircle className="size-3.5 animate-spin text-brand" />
              ) : status === "failed" ? (
                <CircleAlert className="size-3.5 text-destructive" />
              ) : (
                <Clock className="size-3.5 text-subtle-foreground" />
              )}
            </span>
            <div className="min-w-0 flex-1">
              <p className="selectable line-clamp-3 text-[13px] leading-5 break-words whitespace-pre-wrap">
                {message.text || (images === 1 ? "An image" : `${images} images`)}
              </p>
              <p className={cn("text-[11.5px] text-subtle-foreground", status === "failed" && "text-destructive")}>
                {note}
                {message.text && images > 0 && ` · ${images === 1 ? "1 image" : `${images} images`}`}
              </p>
            </div>
            {status !== "sending" && (
              <div className="flex shrink-0 items-center gap-0.5">
                {status === "failed" && (
                  <Action label="Try again" onClick={() => void retry(sessionId, message.key)}>
                    <RotateCcw className="size-3.5" />
                  </Action>
                )}
                <Action
                  label="Edit in the box"
                  onClick={() => {
                    const taken = unsend(sessionId, message.key)
                    if (taken) onEdit(taken)
                  }}
                >
                  <Pencil className="size-3.5" />
                </Action>
                <Action label="Don't send" onClick={() => unsend(sessionId, message.key)}>
                  <X className="size-3.5" />
                </Action>
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function Action({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        onClick={onClick}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {children}
      </button>
    </Tooltip>
  )
}
