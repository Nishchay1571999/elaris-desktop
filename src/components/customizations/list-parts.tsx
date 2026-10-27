/**
 * The pieces the Customizations pages (Plugins, MCP Servers, Skills) share:
 * the header, the sticky toolbar, row actions and the empty, loading and
 * error states, so the three pages read as one.
 */
import { ChevronRight, LoaderCircle, Search, X } from "lucide-react"
import type { ReactNode } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function Page({ title, summary, children }: { title: string; summary: ReactNode; children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-6 pt-9 pb-16">
        <header>
          <h1 className="text-xl font-semibold tracking-tight">{title}</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">{summary}</p>
        </header>
        {children}
      </div>
    </div>
  )
}

export function Toolbar({ children }: { children: ReactNode }) {
  return <div className="sticky top-0 z-10 -mx-2 mt-5 flex items-center gap-3 bg-surface px-2 py-2">{children}</div>
}

export function FilterTabs<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: Array<{ id: T; label: string; count?: number }>
  value: T
  onChange: (id: T) => void
}) {
  return (
    <>
      <div role="group" aria-label={label} className="flex items-center gap-0.5">
        {options.map((option) => (
          <button
            key={option.id}
            type="button"
            aria-pressed={value === option.id}
            onClick={() => onChange(option.id)}
            className={cn(
              "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[13px] text-muted-foreground transition-colors outline-none hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50",
              value === option.id && "bg-secondary text-foreground hover:bg-secondary",
            )}
          >
            {option.label}
            {option.count !== undefined && (
              <span className="text-xs text-subtle-foreground tabular-nums">{option.count}</span>
            )}
          </button>
        ))}
      </div>
      <div className="flex-1" />
    </>
  )
}

export function SearchField({
  value,
  onChange,
  placeholder,
  busy = false,
}: {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Swaps the search icon for a spinner while results load. */
  busy?: boolean
}) {
  return (
    <label className="flex h-7 w-56 items-center gap-2 rounded-md border border-input px-2 focus-within:ring-3 focus-within:ring-ring/50">
      {busy ? (
        <LoaderCircle aria-label="Searching" className="size-3.5 shrink-0 animate-spin text-subtle-foreground" />
      ) : (
        <Search className="size-3.5 shrink-0 text-subtle-foreground" />
      )}
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => e.key === "Escape" && onChange("")}
        placeholder={placeholder}
        aria-label={placeholder}
        className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
      />
      {value && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange("")}
          className="text-subtle-foreground hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      )}
    </label>
  )
}

/** The expandable left side of a row: chevron, name, description and a meta line. */
export function RowSummary({
  open,
  onToggle,
  detailsId,
  name,
  badge,
  description,
  meta,
  dimmed = false,
}: {
  open: boolean
  onToggle: () => void
  detailsId: string
  name: string
  badge?: ReactNode
  description?: ReactNode
  meta?: ReactNode
  dimmed?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      aria-controls={detailsId}
      className="-my-1 -ml-2 flex min-w-0 flex-1 items-start gap-1.5 rounded-md py-1 pr-2 pl-0.5 text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
    >
      <ChevronRight
        className={cn(
          "mt-[3px] size-3.5 shrink-0 text-subtle-foreground transition-transform duration-150 group-hover:text-muted-foreground",
          open && "rotate-90",
        )}
      />
      <span className={cn("min-w-0 flex-1", dimmed && "opacity-60")}>
        <span className="flex items-baseline gap-2">
          <span className="truncate text-sm font-medium">{name}</span>
          {badge}
        </span>
        {description && (
          <span className={cn("mt-0.5 block text-[13px] text-muted-foreground", !open && "line-clamp-1")}>
            {description}
          </span>
        )}
        {meta && (
          <span className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            {meta}
          </span>
        )}
      </span>
    </button>
  )
}

/** A label/value grid under an open row. */
export function Details({ id, rows, children }: { id: string; rows: Array<[string, ReactNode]>; children?: ReactNode }) {
  return (
    <div id={id} className="mb-4 ml-5 animate-message-in rounded-lg bg-surface-sunken px-4 py-3 text-[13px]">
      <dl className="selectable grid grid-cols-[7rem_1fr] gap-x-4 gap-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="min-w-0 break-words text-foreground">{value}</dd>
          </div>
        ))}
      </dl>
      {children}
    </div>
  )
}

export function InstallButton({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Button onClick={onClick} aria-label={label} className="bg-secondary px-3 text-foreground hover:bg-accent">
      Install
    </Button>
  )
}

/** Stands in for a row's button while its install or removal runs. */
export function Working({ label }: { label: string }) {
  return (
    <span role="status" className="flex h-7 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
      <LoaderCircle className="size-3.5 animate-spin text-brand" />
      {label}
    </span>
  )
}

/** Why the last attempt on a row failed, under its summary. */
export function RowError({ message }: { message: string }) {
  return (
    <p role="alert" className="-mt-1.5 mb-3 ml-5 text-[13px] text-destructive">
      {message}
    </p>
  )
}

/** Rows of flat bars at the size of the text they stand for, so nothing shifts when it lands. */
export function LoadingRows({ rows = 5, label }: { rows?: number; label: string }) {
  return (
    <ul aria-busy="true" aria-label={label} className="mt-1 border-t border-border">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="flex items-start gap-3 border-b border-border py-3.5 pl-5">
          <div className="flex-1">
            <div className="mt-1 h-3 rounded bg-muted" style={{ width: `${18 + ((i * 7) % 12)}%` }} />
            <div className="mt-2.5 h-2.5 rounded bg-muted" style={{ width: `${58 + ((i * 13) % 30)}%` }} />
            <div className="mt-3 h-2 w-24 rounded bg-muted" />
          </div>
          <div className="mt-0.5 h-7 w-16 rounded-md bg-muted" />
        </li>
      ))}
    </ul>
  )
}

export function Empty({
  title,
  body,
  action,
  tone = "neutral",
}: {
  title: string
  body?: ReactNode
  action?: { label: string; run: () => void } | null
  tone?: "neutral" | "error"
}) {
  return (
    <div role={tone === "error" ? "alert" : undefined} className="mt-1 border-t border-border py-14 text-center">
      <p className={cn("text-sm font-medium", tone === "error" && "text-destructive")}>{title}</p>
      {body && <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">{body}</p>}
      {action && (
        <Button onClick={action.run} className="mt-4 bg-secondary px-3 text-foreground hover:bg-accent">
          {action.label}
        </Button>
      )}
    </div>
  )
}
