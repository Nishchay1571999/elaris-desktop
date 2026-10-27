import { ArrowDown, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";

import type { ImageAttachment } from "@/bindings/ImageAttachment";
import type { Message } from "@/bindings/Message";
import type { Part } from "@/bindings/Part";
import { useFollowBottom } from "@/hooks/use-follow-bottom";
import { errorMessage, ipc } from "@/lib/ipc";
import { cn } from "@/lib/utils";
import { type PendingRequest, useSessions } from "@/stores/sessions";

import { laneOf, toolLabel } from "./activity";
import { Markdown } from "./markdown";
import { ToolRow } from "./tool-row";

const NO_REQUESTS: PendingRequest[] = [];

/**
 * The conversation. With `split`, reads, edits and commands live in the side
 * columns instead, so only the other tool calls stay inline.
 */
export function Transcript({
  sessionId,
  messages,
  split,
}: {
  sessionId: string;
  messages: Message[];
  split: boolean;
}) {
  const requests = useSessions((s) => s.requests[sessionId] ?? NO_REQUESTS);
  const scroller = useFollowBottom<HTMLDivElement>([messages, requests]);

  return (
    <div
      ref={scroller}
      className="scrollbar-hidden min-h-0 flex-1 overflow-y-auto"
    >
      <ol className="mx-auto flex max-w-3xl flex-col gap-7 px-6 pt-4 pb-6">
        {messages.map((message) => (
          <li key={message.id} className="animate-message-in">
            {message.role === "user" ? (
              <UserMessage sessionId={sessionId} message={message} />
            ) : (
              <AssistantMessage
                message={message}
                split={split}
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
    <div className="flex flex-col items-end gap-2">
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
        <div className="selectable max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
          {message.content}
        </div>
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
  message,
  split,
  requests,
}: {
  message: Message;
  split: boolean;
  requests: PendingRequest[];
}) {
  const streaming = message.status === "streaming";
  const all: Part[] =
    message.parts.length > 0
      ? message.parts
      : [{ type: "text", text: message.content }];
  // Decided on every part, so the caret and dots still follow what is happening in the side columns.
  const lastIsText = all.at(-1)?.type === "text";
  const parts = split
    ? all.filter((p) => p.type === "text" || laneOf(p) === null)
    : all;
  const waiting =
    streaming &&
    (message.parts.length === 0 ? message.content === "" : parts.length === 0);

  return (
    <div>
      {waiting ? (
        <ThinkingDots />
      ) : (
        <div className="flex flex-col gap-3">
          {parts.map((part, i) =>
            part.type === "text" ? (
              // Only the text being written right now gets the caret.
              <div
                key={i}
                className={cn(
                  streaming &&
                    lastIsText &&
                    i === parts.length - 1 &&
                    "streaming-caret",
                )}
              >
                <Markdown text={part.text} />
              </div>
            ) : (
              <ToolRow key={part.id} part={part} />
            ),
          )}
          {streaming && !lastIsText && requests.length === 0 && (
            <ThinkingDots />
          )}
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
      {message.status === "error" && (
        <p className="selectable mt-2 flex items-start gap-1.5 text-xs text-destructive">
          <CircleAlert className="mt-px size-3.5 shrink-0" />{" "}
          {message.error ?? "The reply failed"}
        </p>
      )}
    </div>
  );
}

function ThinkingDots() {
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
  );
}
