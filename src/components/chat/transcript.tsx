import { ArrowDown, Bot, Check, ChevronRight, CircleAlert, Copy } from "lucide-react";
import { useEffect, useState } from "react";


import type { ImageAttachment } from "@/bindings/ImageAttachment";
import type { Message } from "@/bindings/Message";
import type { Part } from "@/bindings/Part";
import type { Subagent } from "@/bindings/Subagent";
import { useFollowBottom } from "@/hooks/use-follow-bottom";
import { agentTabKey } from "@/lib/agents";
import { errorMessage, ipc } from "@/lib/ipc";
import { cn, relativeTime } from "@/lib/utils";
import { type PendingRequest, useSessions } from "@/stores/sessions";
import { useUi } from "@/stores/ui";

import { PLAN_TOOL, type ToolPart, toolLabel } from "./activity";
import { STATUS_LABEL } from "./agent-view";
import { WithContextReferences } from "./context-picker";
import { Markdown } from "./markdown";
import { PlanCard } from "./plan-card";
import { ToolRow } from "./tool-row";
import { WorkGroup } from "./work-group";
import { WorkLogButton } from "./work-log";

const NO_REQUESTS: PendingRequest[] = [];

type ReplyPart = Exclude<Part, { type: "input" }>;

/** A reply's parts with runs of two or more ordinary tool calls gathered into one work group. */
type Block =
  | { kind: "text"; text: string; index: number }
  | { kind: "tool"; part: ToolPart }
  | { kind: "work"; parts: ToolPart[] };

function toBlocks(parts: ReplyPart[]): Block[] {
  const blocks: Block[] = [];
  let run: ToolPart[] = [];
  const flush = () => {
    if (run.length === 1) blocks.push({ kind: "tool", part: run[0] });
    else if (run.length > 1) blocks.push({ kind: "work", parts: run });
    run = [];
  };
  parts.forEach((part, index) => {
    if (part.type === "tool" && part.name !== PLAN_TOOL) {
      run.push(part);
      return;
    }
    flush();
    if (part.type === "text") blocks.push({ kind: "text", text: part.text, index });
    else blocks.push({ kind: "tool", part });
  });
  flush();
  return blocks;
}

/** The conversation, laid out like T3 Code's timeline: every tool call inline as a work-log line. */
export function Transcript({
  sessionId,
  messages,
}: {
  sessionId: string;
  messages: Message[];
}) {
  const requests = useSessions((s) => s.requests[sessionId] ?? NO_REQUESTS);
  const scroller = useFollowBottom<HTMLDivElement>([messages, requests]);

  return (
    <div
      ref={scroller}
      data-transcript
      className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto"
    >
      <ol className="mx-auto flex max-w-3xl flex-col gap-(--chat-gap) px-6 pt-4 pb-6">
        {messages.map((message) => (
          <li key={message.id} className="group/message animate-message-in">
            {message.role === "user" ? (
              <UserMessage sessionId={sessionId} message={message} />
            ) : (
              <AssistantMessage
                sessionId={sessionId}
                message={message}
                requests={
                  message.status === "streaming" ? requests : NO_REQUESTS
                }
              />
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function UserMessage({
  sessionId,
  message,
}: {
  sessionId: string;
  message: Message;
}) {
  return (
    <div className="flex flex-col items-end gap-1">
      {message.images.length > 0 && (
        <ul className="flex max-w-[85%] flex-wrap justify-end gap-2">
          {message.images.map((image) => (
            <li key={image.id}>
              <SentImage sessionId={sessionId} image={image} />
            </li>
          ))}
        </ul>
      )}
      {message.content && (
        <div className="selectable max-w-[80%] min-w-0 rounded-2xl bg-secondary p-3 text-(length:--chat-text) leading-relaxed whitespace-pre-wrap">
          <WithContextReferences text={message.content} />
        </div>
      )}
      {message.content && (
        <MessageActions text={message.content} createdAt={message.createdAt} />
      )}
    </div>
  );
}

/** Loaded images by id; they never change once sent. */
const imageUrls = new Map<string, Promise<string>>();

/** An image the user sent; click to see it full size. */
function SentImage({
  sessionId,
  image,
}: {
  sessionId: string;
  image: ImageAttachment;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    let live = true;
    let load = imageUrls.get(image.id);
    if (!load) {
      load = ipc.chat.image(sessionId, image);
      imageUrls.set(image.id, load);
      load.catch(() => imageUrls.delete(image.id));
    }
    load
      .then((u) => live && setUrl(u))
      .catch((error) => useSessions.setState({ error: errorMessage(error) }));
    return () => {
      live = false;
    };
  }, [sessionId, image]);

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setZoomed(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [zoomed]);

  if (!url)
    return (
      <div
        aria-label={image.name || "Image"}
        className="size-32 animate-pulse rounded-xl bg-secondary"
      />
    );

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed(true)}
        className="block rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        <img
          src={url}
          alt={image.name || "Attached image"}
          title={image.name || undefined}
          className="max-h-48 max-w-64 rounded-xl border border-border object-contain"
        />
      </button>
      {zoomed && (
        <div
          role="dialog"
          aria-label={image.name || "Image"}
          onClick={() => setZoomed(false)}
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-8"
        >
          <img
            src={url}
            alt={image.name || "Attached image"}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
        </div>
      )}
    </>
  );
}

function AssistantMessage({
  sessionId,
  message,
  requests,
}: {
  sessionId: string;
  message: Message;
  requests: PendingRequest[];
}) {
  const streaming = message.status === "streaming";
  // `input` parts only ever belong to subagents.
  const parts: ReplyPart[] =
    message.parts.length > 0
      ? message.parts.filter((p): p is ReplyPart => p.type !== "input")
      : [{ type: "text", text: message.content }];
  const lastIsText = parts.at(-1)?.type === "text";
  const waiting =
    streaming &&
    (message.parts.length === 0 ? message.content === "" : parts.length === 0);

  return (
    <div>
      {waiting ? (
        <WorkingRow since={message.createdAt} />
      ) : (
        <div className="flex flex-col gap-2">
          {toBlocks(parts).map((block) =>
            block.kind === "text" ? (
              // Only the text being written right now gets the caret.
              <div
                key={block.index}
                className={cn(
                  "px-1 py-0.5",
                  streaming &&
                    lastIsText &&
                    block.index === parts.length - 1 &&
                    "streaming-caret",
                )}
              >
                <Markdown text={block.text} />
              </div>
            ) : block.kind === "work" ? (
              // Keyed by its first call, so it keeps its open state as the run grows.
              <WorkGroup key={block.parts[0].id} parts={block.parts} />
            ) : block.part.name === PLAN_TOOL ? (
              <PlanCard key={block.part.id} part={block.part} />
            ) : (
              <ToolRow key={block.part.id} part={block.part} />
            ),
          )}
          {streaming && !lastIsText && requests.length === 0 && (
            <WorkingRow since={message.createdAt} />
          )}
          {message.agents.map((agent) => (
            <AgentLink key={agent.id} sessionId={sessionId} agent={agent} />
          ))}
        </div>
      )}
      {requests.length > 0 && (
        // The prompt itself is docked on the composer; this just says where the reply went.
        <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
          <ArrowDown className="size-3.5" />
          {requests[0].type === "question"
            ? "Waiting for your answer"
            : `Waiting for you to allow ${toolLabel(requests[0].toolName)}`}
        </p>
      )}
      {!streaming && message.content && (
        <MessageActions
          text={message.content}
          createdAt={message.createdAt}
          align="start"
        />
      )}
      {message.status === "error" && (
        <p className="selectable mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert className="mt-px size-3.5 shrink-0" />{" "}
          {message.error ?? "The reply failed"}
        </p>
      )}
    </div>
  );
}

/** A subagent the reply started or sent a message to; opens its tab. */
function AgentLink({ sessionId, agent }: { sessionId: string; agent: Subagent }) {
  const sent = agent.parts.findLast((p) => p.type === "input");
  return (
    <WorkLogButton
      onClick={() => useUi.getState().openToolTab(sessionId, agentTabKey(agent.id))}
      icon={<Bot aria-hidden className="size-4 shrink-0 stroke-2 text-subtle-foreground" />}
      label={
        <span className="flex min-w-0 gap-1.5">
          <span className="shrink-0 text-foreground/80">{agent.description || "Agent"}</span>
          <span className="min-w-0 truncate">
            {sent?.type === "input" ? `You: ${sent.text}` : STATUS_LABEL[agent.status]}
          </span>
        </span>
      }
      trailing={
        <span className="flex shrink-0 items-center gap-0.5 text-xs text-brand">
          Open agent
          <ChevronRight aria-hidden className="size-3" />
        </span>
      }
    />
  );
}

/** Copy and the time, shown when the pointer is over a message. */
function MessageActions({
  text,
  createdAt,
  align = "end",
}: {
  text: string;
  createdAt: number;
  align?: "start" | "end";
}) {
  const [copied, setCopied] = useState(false);
  const copy = () =>
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });

  return (
    <div
      className={cn(
        "flex h-6 items-center gap-1 text-[11px] text-subtle-foreground opacity-0 transition-opacity group-hover/message:opacity-100 focus-within:opacity-100",
        align === "end" ? "justify-end" : "mt-1 justify-start",
      )}
    >
      <time
        dateTime={new Date(createdAt).toISOString()}
        title={new Date(createdAt).toLocaleString()}
        className="px-1"
      >
        {relativeTime(createdAt)}
      </time>
      <button
        type="button"
        onClick={copy}
        aria-label={copied ? "Copied" : "Copy message"}
        className="flex size-6 items-center justify-center rounded-md outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}

/** "Working for 12s", ticking while the reply has nothing to show yet. */
function WorkingRow({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return (
    <div aria-live="polite" className="border-b border-border pt-1 pb-2">
      <div className="flex h-6 items-center px-1 text-sm text-muted-foreground tabular-nums">
        <span className="live-tool-shine">Working for {elapsed(now - since)}</span>
      </div>
    </div>
  );
}

function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}
