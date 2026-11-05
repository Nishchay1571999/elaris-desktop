import { ChevronDown, ChevronUp, Search, X } from "lucide-react"
import { type RefObject, useEffect, useRef, useState } from "react"

import { useUi } from "@/stores/ui"

const supported = typeof CSS !== "undefined" && "highlights" in CSS

/**
 * ⌘F over the conversation. Matches are painted with the CSS Custom Highlight API
 * (see `::highlight(find-match)` in styles.css), so the messages never re-render,
 * and follow the transcript as a reply streams in.
 */
export function FindBar({ scope }: { scope: RefObject<HTMLElement | null> }) {
  const { open, focus } = useUi((s) => s.find)
  const close = useUi((s) => s.closeFind)
  const input = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState("")
  const [ranges, setRanges] = useState<Range[]>([])
  const [current, setCurrent] = useState(0)

  useEffect(() => {
    if (!open) return
    input.current?.focus()
    input.current?.select()
  }, [open, focus])

  // Finds every match, again whenever the transcript changes.
  useEffect(() => {
    const root = scope.current?.querySelector<HTMLElement>("[data-transcript]")
    if (!open || !root || !supported) return
    const search = () => setRanges(findRanges(root, query))
    search()
    let frame = 0
    const observer = new MutationObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(search)
    })
    observer.observe(root, { subtree: true, childList: true, characterData: true })
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [open, query, scope])

  // Starts from the first match whenever the query changes.
  useEffect(() => setCurrent(0), [query])

  const at = ranges.length ? Math.min(current, ranges.length - 1) : -1

  useEffect(() => {
    if (!supported) return
    if (!open || at < 0) {
      CSS.highlights.delete("find-match")
      CSS.highlights.delete("find-current")
      return
    }
    CSS.highlights.set("find-match", new Highlight(...ranges))
    CSS.highlights.set("find-current", new Highlight(ranges[at]))
  }, [open, ranges, at])

  useEffect(() => () => {
    if (!supported) return
    CSS.highlights.delete("find-match")
    CSS.highlights.delete("find-current")
  }, [])

  // Brings the current match into view, only when the user moves to it.
  const reveal = (index: number) => {
    const range = ranges[index]
    range?.startContainer.parentElement?.scrollIntoView({ block: "center", behavior: "smooth" })
  }
  useEffect(() => {
    if (open && ranges.length) reveal(Math.min(current, ranges.length - 1))
    // Only on a new query or step, not every time streaming text adds a match.
  }, [open, query, current])

  if (!open) return null

  const step = (by: number) => ranges.length && setCurrent((c) => (c + by + ranges.length) % ranges.length)

  return (
    <div
      role="search"
      className="absolute top-2 right-4 z-20 flex h-8 animate-dock-in items-center gap-1 rounded-lg border border-border-strong bg-popover pr-1 pl-2 text-[13px] shadow-lg"
    >
      <Search className="size-3.5 shrink-0 text-subtle-foreground" />
      <input
        ref={input}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.preventDefault()
            close()
          } else if (e.key === "Enter") {
            e.preventDefault()
            step(e.shiftKey ? -1 : 1)
          }
        }}
        placeholder={supported ? "Find in chat" : "Find isn't supported here"}
        disabled={!supported}
        aria-label="Find in chat"
        className="w-48 bg-transparent outline-none placeholder:text-subtle-foreground"
      />
      <span className="min-w-12 text-right text-xs text-subtle-foreground tabular-nums">
        {query ? (ranges.length ? `${at + 1} of ${ranges.length}` : "None") : ""}
      </span>
      <FindButton label="Previous match (⇧↩)" disabled={!ranges.length} onClick={() => step(-1)}>
        <ChevronUp className="size-3.5" />
      </FindButton>
      <FindButton label="Next match (↩)" disabled={!ranges.length} onClick={() => step(1)}>
        <ChevronDown className="size-3.5" />
      </FindButton>
      <FindButton label="Close (Esc)" onClick={close}>
        <X className="size-3.5" />
      </FindButton>
    </div>
  )
}

function FindButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className="flex size-6 items-center justify-center rounded-md text-muted-foreground outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 disabled:opacity-40 disabled:hover:bg-transparent"
    >
      {children}
    </button>
  )
}

const MAX_MATCHES = 2000

/** Every case-insensitive occurrence of `query` in the text under `root`, in document order. */
function findRanges(root: HTMLElement, query: string): Range[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const ranges: Range[] = []
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node && ranges.length < MAX_MATCHES; node = walker.nextNode()) {
    const text = node.textContent?.toLowerCase() ?? ""
    for (let i = text.indexOf(needle); i !== -1 && ranges.length < MAX_MATCHES; i = text.indexOf(needle, i + needle.length)) {
      const range = document.createRange()
      range.setStart(node, i)
      range.setEnd(node, i + needle.length)
      ranges.push(range)
    }
  }
  return ranges
}
