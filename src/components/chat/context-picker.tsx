import { BookmarkCheck, X } from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { baseName, cn, relativeTime } from "@/lib/utils";
import {
  CONTEXT_REFERENCE,
  contextReferences,
  ITEM_REFERENCE,
  itemReferences,
  tokenLabel,
  useContexts,
} from "@/stores/contexts";

const MAX_MATCHES = 8;

/**
 * `#` (a saved chat) or `%` (a saved pull request or issue) at the start or
 * after a space, then what's typed of an id or title so far.
 */
const TRIGGER = /(?:^|\s)([#%])([\w-]*)$/;

type Sigil = "#" | "%";

/** A saved chat, pull request or issue, as the list and the chips show it. */
interface Saved {
  id: string;
  title: string;
  /** Where it's from, how old and how big. */
  detail: string;
  /** How big, for its chip. */
  size: string;
  /** What the chip's tooltip warns about, if anything. */
  note?: string;
}

const LIST: Record<Sigil, { label: string; hint: string; none: string; noMatch: string }> = {
  "#": {
    label: "Saved chats",
    hint: "Attach a saved chat: all of it goes to the agent, tool calls and output included",
    none: "No saved chats yet. Save one with the bookmark beside Elaris.",
    noMatch: "No saved chats match.",
  },
  "%": {
    label: "Saved pull requests and issues",
    hint: "Attach a saved pull request or issue: its discussion goes to the agent, attachments included",
    none: "No saved pull requests or issues yet. Save one with the bookmark on its page.",
    noMatch: "No saved pull requests or issues match.",
  },
};

/**
 * Saved contexts in the composer. Typing `#` lists saved chats and `%` saved
 * pull requests and issues; picking one inserts `#ctx-…` or `%pr-…`, which
 * sends it, whole, to the agent with the message. References show as chips
 * above the box; unknown ids block sending.
 */
export function useContextReferences(
  text: string,
  setText: (text: string) => void,
  input: RefObject<HTMLTextAreaElement | null>,
): {
  /** Call on change, click and selection, so `#` and `%` open the list. */
  track: (el: HTMLTextAreaElement) => void;
  /** True when the list handled the key. */
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  menu: ReactNode;
  chips: ReactNode;
  /** The message references something that isn't saved (or the list is still loading). */
  blocked: boolean;
} {
  const { saved, loaded, load, items, itemsLoaded, loadItems } = useContexts();
  const [trigger, setTrigger] = useState<{ sigil: Sigil; start: number; query: string } | null>(null);
  const [highlight, setHighlight] = useState(0);
  // Where Escape closed the list, so it stays closed while typing on there.
  const dismissed = useRef<number | null>(null);
  const tried = useRef(new Set<string>());

  const chats = useMemo(
    () =>
      new Map<string, Saved>(
        saved.map((c) => [
          c.id,
          {
            id: c.id,
            title: c.title,
            detail: [c.workspace && baseName(c.workspace), relativeTime(c.createdAt), tokenLabel(c.tokens)]
              .filter(Boolean)
              .join(" · "),
            size: tokenLabel(c.tokens),
            note: c.partial ? "Saved from Elaris's copy of the chat, so long tool output may be clipped" : undefined,
          },
        ]),
      ),
    [saved],
  );
  const tracked = useMemo(
    () =>
      new Map<string, Saved>(
        items.map((i) => [
          i.id,
          {
            id: i.id,
            title: `${i.repo}#${i.number} ${i.title}`,
            detail: [relativeTime(i.createdAt), tokenLabel(i.tokens), attachments(i.assets)].filter(Boolean).join(" · "),
            size: [tokenLabel(i.tokens), attachments(i.assets)].filter(Boolean).join(" · "),
          },
        ]),
      ),
    [items],
  );

  const matches = useMemo(() => {
    if (!trigger) return [];
    const q = trigger.query.toLowerCase();
    const pool = trigger.sigil === "#" ? chats : tracked;
    return [...pool.values()]
      .filter((c) => c.id.includes(q) || c.title.toLowerCase().includes(q))
      .slice(0, MAX_MATCHES);
  }, [chats, tracked, trigger]);

  const refs = useMemo(() => contextReferences(text), [text]);
  const itemRefs = useMemo(() => itemReferences(text), [text]);

  // A pasted id may have been saved in another window since the list loaded.
  useEffect(() => {
    const missing = refs.filter((id) => !chats.has(id) && !tried.current.has(id));
    if (missing.length === 0 && (loaded || refs.length === 0)) return;
    for (const id of missing) tried.current.add(id);
    void load();
  }, [refs, chats, loaded, load]);
  useEffect(() => {
    const missing = itemRefs.filter((id) => !tracked.has(id) && !tried.current.has(id));
    if (missing.length === 0 && (itemsLoaded || itemRefs.length === 0)) return;
    for (const id of missing) tried.current.add(id);
    void loadItems();
  }, [itemRefs, tracked, itemsLoaded, loadItems]);

  const track = (el: HTMLTextAreaElement) => {
    const caret = el.selectionStart;
    const match = caret === el.selectionEnd ? TRIGGER.exec(el.value.slice(0, caret)) : null;
    if (!match) {
      dismissed.current = null;
      setTrigger(null);
      return;
    }
    const sigil = match[1] as Sigil;
    const start = caret - match[2].length - 1;
    if (dismissed.current === start) return;
    // Fresh each time it opens, to include ones saved in other windows.
    if (trigger?.start !== start) void (sigil === "#" ? load() : loadItems());
    if (trigger?.query !== match[2]) setHighlight(0);
    setTrigger({ sigil, start, query: match[2] });
  };

  const pick = (option: Saved) => {
    const el = input.current;
    if (!el || !trigger) return;
    const caret = el.selectionStart;
    const inserted = `${trigger.sigil}${option.id} `;
    setText(text.slice(0, trigger.start) + inserted + text.slice(caret));
    setTrigger(null);
    const at = trigger.start + inserted.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(at, at);
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (!trigger || e.nativeEvent.isComposing) return false;
    if (e.key === "Escape") {
      e.preventDefault();
      dismissed.current = trigger.start;
      setTrigger(null);
      return true;
    }
    if (matches.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const step = e.key === "ArrowDown" ? 1 : -1;
      setHighlight((h) => (h + step + matches.length) % matches.length);
      return true;
    }
    if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
      e.preventDefault();
      pick(matches[Math.min(highlight, matches.length - 1)]);
      return true;
    }
    return false;
  };

  const remove = (sigil: Sigil, id: string) =>
    setText(
      text
        .replace(sigil === "#" ? CONTEXT_REFERENCE : ITEM_REFERENCE, (token, found) => (found === id ? "" : token))
        .replace(/ {2,}/g, " ")
        .trimStart(),
    );

  const list = trigger && LIST[trigger.sigil];
  const empty = trigger?.sigil === "#" ? chats.size === 0 : tracked.size === 0;
  const menu = trigger && list && (
    <div
      role="listbox"
      aria-label={list.label}
      className="absolute bottom-full left-0 z-50 mb-2 w-[min(30rem,100%)] rounded-lg border border-border-strong bg-popover p-1 text-[13px] text-popover-foreground shadow-xl"
    >
      <p className="px-2 pt-1 pb-1.5 text-[11px] text-subtle-foreground">{list.hint}</p>
      {matches.length === 0 ? (
        <p className="px-2 py-1.5 text-muted-foreground">{empty ? list.none : list.noMatch}</p>
      ) : (
        matches.map((c, i) => (
          <div
            key={c.id}
            role="option"
            aria-selected={i === highlight}
            // Keeps focus in the box.
            onMouseDown={(e) => {
              e.preventDefault();
              pick(c);
            }}
            onMouseEnter={() => setHighlight(i)}
            className={cn(
              "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5",
              i === highlight && "bg-accent",
            )}
          >
            <span className="shrink-0 font-mono text-[11.5px] text-brand">
              {trigger.sigil}
              {c.id}
            </span>
            <span className="min-w-0 flex-1 truncate">{c.title}</span>
            <span className="shrink-0 text-[11px] text-subtle-foreground">{c.detail}</span>
          </div>
        ))
      )}
    </div>
  );

  const all: Array<{ sigil: Sigil; id: string; found: Saved | undefined; missing: boolean }> = [
    ...refs.map((id) => ({ sigil: "#" as const, id, found: chats.get(id), missing: loaded && !chats.has(id) })),
    ...itemRefs.map((id) => ({ sigil: "%" as const, id, found: tracked.get(id), missing: itemsLoaded && !tracked.has(id) })),
  ];

  const chips = all.length > 0 && (
    <ul aria-label="Attached context" className="flex flex-wrap gap-1.5 px-3 pt-3">
      {all.map(({ sigil, id, found, missing }) => (
        <li
          key={id}
          title={
            missing
              ? sigil === "#"
                ? "No saved chat has this id"
                : "No saved pull request or issue has this id"
              : found?.note
          }
          className={cn(
            "flex h-6 max-w-72 items-center gap-1.5 rounded-md border border-border bg-muted pr-1 pl-2 text-xs",
            missing && "border-destructive/50 text-destructive",
          )}
        >
          <BookmarkCheck className="size-3.5 shrink-0" />
          <span className="shrink-0 font-mono text-[11.5px]">
            {sigil}
            {id}
          </span>
          <span className="min-w-0 truncate text-muted-foreground">
            {missing ? "not found" : found ? `${found.title} · ${found.size}` : "…"}
          </span>
          <button
            type="button"
            aria-label={`Remove ${sigil}${id}`}
            onClick={() => remove(sigil, id)}
            className="flex size-4 shrink-0 items-center justify-center rounded text-subtle-foreground hover:bg-border hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </li>
      ))}
    </ul>
  );

  const blocked = refs.some((id) => !chats.has(id)) || itemRefs.some((id) => !tracked.has(id));

  return { track, onKeyDown, menu, chips, blocked };
}

const attachments = (n: number) => (n > 0 ? `${n} attachment${n === 1 ? "" : "s"}` : null);

const ANY_REFERENCE = new RegExp(`${CONTEXT_REFERENCE.source}|${ITEM_REFERENCE.source}`, "g");

/** A sent message's text, with each `#ctx-…` and `%pr-…` it attached marked out. */
export function WithContextReferences({ text }: { text: string }) {
  const pieces: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(ANY_REFERENCE)) {
    pieces.push(text.slice(last, match.index));
    pieces.push(
      <span
        key={match.index}
        title={
          match[0].startsWith("#")
            ? "A saved chat, sent whole to the agent with this message"
            : "A saved pull request or issue, sent to the agent with its attachments"
        }
        className="rounded bg-brand-soft px-1 font-mono text-[0.9em] text-brand"
      >
        {match[0]}
      </span>,
    );
    last = match.index + match[0].length;
  }
  pieces.push(text.slice(last));
  return <>{pieces}</>;
}
