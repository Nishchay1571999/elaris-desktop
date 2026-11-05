import { Check, ChevronDown, GitPullRequestCreate, LoaderCircle, MessageSquare, RefreshCw, Search, X } from "lucide-react"
import { Popover } from "radix-ui"
import { type ReactNode, useEffect, useMemo, useState } from "react"

import { useDebounced } from "@/hooks/use-debounced"
import { useGh } from "@/hooks/use-gh"
import { Empty, FilterTabs, LoadingRows, Page, SearchField } from "@/components/customizations/list-parts"
import { ConnectGitHub } from "@/components/github/connect-github"
import { ActivityBar } from "@/components/ui/activity-bar"
import { Button, IconButton } from "@/components/ui/button"
import { Menu, MenuCheckItem, MenuContent, MenuLabel, MenuTrigger } from "@/components/ui/menu"
import type { Involvement, SearchItem, TrackerKind, TrackerState } from "@/lib/github"
import { ipc } from "@/lib/ipc"
import { cn } from "@/lib/utils"
import { useGitHub } from "@/stores/github"
import { DEFAULT_FILTERS, searchFilters, type TrackerFilters, type UpdatedWindow, useTracker } from "@/stores/tracker"
import { useUi } from "@/stores/ui"
import { useWorkspace } from "@/stores/workspace"

import { useCreatePr } from "./create-pr-dialog"
import { IssueDetail } from "./issue-detail"
import { Avatar, IssueStateIcon, Labels, PrStateIcon, since } from "./pr-bits"
import { PullDetail } from "./pull-detail"

const NOUN: Record<TrackerKind, { title: string; one: string; many: string }> = {
  prs: { title: "Pull requests", one: "pull request", many: "pull requests" },
  issues: { title: "Issues", one: "issue", many: "issues" },
}

const STATES: Record<TrackerKind, Array<{ id: TrackerState; label: string }>> = {
  prs: [
    { id: "open", label: "Open" },
    { id: "merged", label: "Merged" },
    { id: "closed", label: "Closed" },
  ],
  issues: [
    { id: "open", label: "Open" },
    { id: "closed", label: "Closed" },
  ],
}

/** How you're involved: the menu's label, and the words for the summary line. */
const INVOLVEMENT: Array<{ id: Involvement; label: string; phrase: string; prsOnly?: boolean }> = [
  { id: "involves", label: "Involving me", phrase: "involving you" },
  { id: "author", label: "Created by me", phrase: "opened by you" },
  { id: "assignee", label: "Assigned to me", phrase: "assigned to you" },
  { id: "review-requested", label: "Review requested", phrase: "waiting for your review", prsOnly: true },
  { id: "mentions", label: "Mentioning me", phrase: "that mention you" },
  { id: "any", label: "Everyone", phrase: "by anyone" },
]

const WINDOWS: Array<{ id: UpdatedWindow; label: string }> = [
  { id: "any", label: "Any time" },
  { id: "day", label: "Past day" },
  { id: "week", label: "Past week" },
  { id: "month", label: "Past month" },
  { id: "year", label: "Past year" },
]

const LIMIT = 50

/**
 * Pull requests or issues from every repository gh can see, filtered by state, how you're
 * involved, repository, label and when they last moved; with `number`, that one.
 */
export function TrackerPage({ kind, repo, number }: { kind: TrackerKind; repo?: string; number?: number }) {
  const status = useGitHub((s) => s.status)
  const folderRepo = useGitHub((s) => s.repo)
  const isGit = useWorkspace((s) => Boolean(s.info?.isGit))
  const noun = NOUN[kind]

  useEffect(() => {
    if (!status) void useGitHub.getState().refreshStatus()
    else if (isGit && folderRepo === undefined) void useGitHub.getState().refreshRepo()
  }, [status, isGit, folderRepo])

  if (!status) {
    return (
      <Page title={noun.title} summary="Checking GitHub…">
        <p className="mt-6 flex items-center gap-2 text-[13px] text-muted-foreground">
          <LoaderCircle className="size-3.5 animate-spin" /> Looking for the GitHub CLI…
        </p>
      </Page>
    )
  }
  if (!status.installed || !status.user) {
    return (
      <Page title={noun.title} summary={`Every ${noun.one} you're part of, from every repository, without leaving Elaris.`}>
        <div className="mt-6">
          <ConnectGitHub onReady={() => void useGitHub.getState().refreshRepo()} />
        </div>
      </Page>
    )
  }
  if (number !== undefined) {
    if (kind === "prs") return <PullDetail key={`${repo}#${number}`} repo={repo} number={number} />
    if (repo) return <IssueDetail key={`${repo}#${number}`} repo={repo} number={number} />
  }
  return <TrackerList key={kind} kind={kind} />
}

function TrackerList({ kind }: { kind: TrackerKind }) {
  const filters = useTracker((s) => s.filters[kind])
  const setFilters = useTracker((s) => s.setFilters)
  const folderRepo = useGitHub((s) => s.repo)
  const createPr = useCreatePr()
  const noun = NOUN[kind]
  const set = (patch: Partial<TrackerFilters>) => setFilters(kind, patch)

  const { query, ...rest } = filters
  // Typing waits a moment before asking GitHub.
  const debouncedQuery = useDebounced(query, 300)
  const search = searchFilters({ ...filters, query: debouncedQuery })
  const { data, error, revalidating, refresh } = useGh(
    `search:${kind}:${JSON.stringify(search)}`,
    () => ipc.github.search(kind, search),
    // Changing a filter keeps the old rows (dimmed) until the new ones arrive, unless they're cached.
    { keepPrevious: true },
  )
  const items = data ?? null
  const typing = query !== debouncedQuery
  const busy = revalidating || typing

  useEffect(() => {
    if (data) useTracker.getState().noteLabels(kind, data.flatMap((item) => item.labels))
  }, [kind, data])

  const changed = Object.entries(rest).some(([k, v]) => DEFAULT_FILTERS[k as keyof TrackerFilters] !== v)
  const stateLabel = STATES[kind].find((s) => s.id === filters.state)!.label.toLowerCase()
  const phrase = INVOLVEMENT.find((i) => i.id === searchFilters(filters).involvement)!.phrase

  return (
    <Page
      title={noun.title}
      summary={
        <>
          {stateLabel[0].toUpperCase() + stateLabel.slice(1)} {noun.many} {phrase}, in{" "}
          {filters.repo ? (
            <button
              type="button"
              onClick={() => void ipc.openUrl(`https://github.com/${filters.repo}`)}
              className="text-foreground hover:underline"
            >
              {filters.repo}
            </button>
          ) : (
            "every repository you can reach"
          )}
          .
        </>
      }
    >
      <div className="sticky top-0 z-10 -mx-2 mt-5 flex flex-col gap-2 bg-surface px-2 py-2">
        <div className="flex items-center gap-3">
          <FilterTabs label="State" options={STATES[kind]} value={filters.state} onChange={(state) => set({ state })} />
          <SearchField value={query} onChange={(q) => set({ query: q })} placeholder={`Search ${noun.many}`} busy={busy && !!query} />
          <IconButton label="Refresh" onClick={refresh}>
            <RefreshCw className="size-3.5" />
          </IconButton>
          {kind === "prs" && folderRepo && (
            <Button onClick={createPr} className="border border-border-strong text-foreground" title={`New pull request on ${folderRepo.nameWithOwner}`}>
              <GitPullRequestCreate className="size-3.5" /> New
            </Button>
          )}
        </div>
        <div role="group" aria-label="Filters" className="flex flex-wrap items-center gap-1.5">
          <InvolvementFilter kind={kind} filters={filters} onChange={(involvement) => set({ involvement })} />
          <RepoFilter value={filters.repo} onChange={(repo) => set({ repo })} />
          <LabelFilter kind={kind} repo={filters.repo} value={filters.label} onChange={(label) => set({ label })} />
          <UpdatedFilter value={filters.updated} onChange={(updated) => set({ updated })} />
          {changed && (
            <Button onClick={() => useTracker.getState().resetFilters(kind)} className="h-7 px-2 text-xs">
              Clear
            </Button>
          )}
          <span className="flex-1" />
          {items && (
            <span className="text-xs text-muted-foreground tabular-nums">
              {items.length >= LIMIT ? `Latest ${LIMIT}` : `${items.length} ${items.length === 1 ? noun.one : noun.many}`}
            </span>
          )}
        </div>
        <ActivityBar active={busy && items !== null} className="absolute inset-x-2 bottom-0" />
      </div>

      {error && !items ? (
        <Empty tone="error" title={`Couldn't load ${noun.many}`} body={error} action={{ label: "Try again", run: refresh }} />
      ) : items === null ? (
        <LoadingRows label={`Loading ${noun.many}`} />
      ) : items.length === 0 ? (
        <Empty
          title={query ? `No ${noun.many} match “${query.trim()}”` : `No ${stateLabel} ${noun.many} ${phrase}`}
          body={changed ? "Widen the filters to see more." : undefined}
          action={changed ? { label: "Clear filters", run: () => useTracker.getState().resetFilters(kind) } : null}
        />
      ) : (
        <ul className={cn("mt-1 divide-y divide-border border-y border-border transition-opacity", typing && "opacity-60")}>
          {items.map((item) => (
            <ItemRow key={item.url} kind={kind} item={item} />
          ))}
        </ul>
      )}
    </Page>
  )
}

function ItemRow({ kind, item }: { kind: TrackerKind; item: SearchItem }) {
  const navigate = useUi((s) => s.navigate)
  const repo = item.repository.nameWithOwner
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate({ view: { kind: kind === "prs" ? "pulls" : "issues", repo, number: item.number } })}
        className="flex w-full items-start gap-3 px-2 py-3 text-left outline-none hover:bg-muted/60 focus-visible:bg-muted/60"
      >
        {kind === "prs" ? (
          <PrStateIcon state={item.state.toUpperCase()} isDraft={item.isDraft ?? false} className="mt-0.5" />
        ) : (
          <IssueStateIcon state={item.state} className="mt-0.5" />
        )}
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="text-[13px] font-medium">{item.title}</span>
            <Labels labels={item.labels} />
          </span>
          <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span className="text-foreground/80">
              {repo} <span className="tabular-nums">#{item.number}</span>
            </span>
            <span className="flex items-center gap-1">
              <Avatar login={item.author.login} size={14} />
              {item.author.login}
            </span>
            <span title={new Date(item.updatedAt).toLocaleString()}>updated {since(item.updatedAt)}</span>
          </span>
        </span>
        {item.commentsCount > 0 && (
          <span className="mt-0.5 flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
            <MessageSquare className="size-3.5" />
            {item.commentsCount}
          </span>
        )}
      </button>
    </li>
  )
}

/* -------------------------------------------------------------------------- */
/* Filters                                                                    */
/* -------------------------------------------------------------------------- */

const CHIP =
  "flex h-7 max-w-64 items-center gap-1.5 rounded-md border border-border px-2 text-[13px] text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 data-[state=open]:bg-muted"
const CHIP_SET = "border-border-strong bg-secondary text-foreground hover:bg-secondary"

/** A filter's button: its name, and its value once it's narrowed from the default. */
function ChipLabel({ name, value }: { name: string; value: ReactNode | null }) {
  return (
    <>
      <span className="shrink-0">{name}</span>
      {value && <span className="min-w-0 truncate font-medium text-foreground">{value}</span>}
      <ChevronDown className="size-3 shrink-0 opacity-70" />
    </>
  )
}

function InvolvementFilter({
  kind,
  filters,
  onChange,
}: {
  kind: TrackerKind
  filters: TrackerFilters
  onChange: (involvement: Involvement) => void
}) {
  const options = INVOLVEMENT.filter((o) => !o.prsOnly || kind === "prs")
  const current = options.find((o) => o.id === filters.involvement) ?? options[0]
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={cn(CHIP, current.id !== "involves" && CHIP_SET)}>
          <ChipLabel name="Type" value={current.label} />
        </button>
      </MenuTrigger>
      <MenuContent>
        {options.map((option) => {
          const needsRepo = option.id === "any" && !filters.repo
          return (
            <MenuCheckItem
              key={option.id}
              checked={current.id === option.id}
              disabled={needsRepo}
              onSelect={() => onChange(option.id)}
            >
              <span className="flex-1">
                <span className="block">{option.label}</span>
                {needsRepo && <span className="block text-[11px] text-subtle-foreground">Pick a repository first</span>}
              </span>
            </MenuCheckItem>
          )
        })}
      </MenuContent>
    </Menu>
  )
}

function UpdatedFilter({ value, onChange }: { value: UpdatedWindow; onChange: (value: UpdatedWindow) => void }) {
  return (
    <Menu>
      <MenuTrigger asChild>
        <button type="button" className={cn(CHIP, value !== "any" && CHIP_SET)}>
          <ChipLabel name="Updated" value={value === "any" ? null : WINDOWS.find((w) => w.id === value)!.label.toLowerCase()} />
        </button>
      </MenuTrigger>
      <MenuContent>
        <MenuLabel>Last updated</MenuLabel>
        {WINDOWS.map((w) => (
          <MenuCheckItem key={w.id} checked={value === w.id} onSelect={() => onChange(w.id)}>
            {w.label}
          </MenuCheckItem>
        ))}
      </MenuContent>
    </Menu>
  )
}

function RepoFilter({ value, onChange }: { value: string | null; onChange: (repo: string | null) => void }) {
  const repos = useTracker((s) => s.repos)
  const folderRepo = useGitHub((s) => s.repo?.nameWithOwner)
  const options = useMemo(() => {
    const names = (repos ?? []).map((r) => r.nameWithOwner)
    // The open folder's repository first, then the rest by when they were last pushed to.
    const ordered = folderRepo ? [folderRepo, ...names.filter((n) => n.toLowerCase() !== folderRepo.toLowerCase())] : names
    return ordered.map((name) => ({
      value: name,
      text: name,
      label: name,
      hint: name === folderRepo ? "This folder" : undefined,
    }))
  }, [repos, folderRepo])

  return (
    <Picker
      name="Repository"
      value={value}
      onChange={onChange}
      anyLabel="All repositories"
      placeholder="Find or type owner/name"
      options={options}
      loading={repos === null}
      onOpen={() => void useTracker.getState().loadRepos()}
      custom={(q) => (/^[\w.-]+\/[\w.-]+$/.test(q) ? q : null)}
    />
  )
}

function LabelFilter({
  kind,
  repo,
  value,
  onChange,
}: {
  kind: TrackerKind
  repo: string | null
  value: string | null
  onChange: (label: string | null) => void
}) {
  const seen = useTracker((s) => s.seenLabels[kind])
  const [open, setOpen] = useState(false)
  // A repository's labels load once the menu opens, and are remembered like every read.
  const { data: repoLabels, loading } = useGh(repo && open ? `labels:${repo}` : null, () => ipc.github.labels(repo!))

  // A repository's own labels when one is chosen; across repositories, the ones seen in results.
  const labels = repo ? (repoLabels ?? []) : seen
  const options = [...labels]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((label) => ({
      value: label.name,
      text: label.name,
      label: (
        <span className="flex min-w-0 items-center gap-2">
          <span className="size-2.5 shrink-0 rounded-full" style={{ background: `#${label.color}` }} />
          <span className="truncate">{label.name}</span>
        </span>
      ),
    }))

  return (
    <Picker
      name="Label"
      value={value}
      onChange={onChange}
      anyLabel="Any label"
      placeholder="Find or type a label"
      options={options}
      loading={repo !== null && loading}
      onOpen={() => setOpen(true)}
      empty={repo ? "This repository has no labels" : "Labels show up here as results load"}
      custom={(q) => q || null}
    />
  )
}

interface PickerOption {
  value: string
  text: string
  label: ReactNode
  hint?: string
}

/** A filter with a long list to pick from: a find field over the options, and a way to type one that isn't listed. */
function Picker({
  name,
  value,
  onChange,
  anyLabel,
  placeholder,
  options,
  loading = false,
  empty = "Nothing to pick from",
  onOpen,
  custom,
}: {
  name: string
  value: string | null
  onChange: (value: string | null) => void
  anyLabel: string
  placeholder: string
  options: PickerOption[]
  loading?: boolean
  empty?: string
  onOpen?: () => void
  /** What the typed text picks when nothing listed matches it exactly, or null. */
  custom?: (query: string) => string | null
}) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const q = query.trim().toLowerCase()
  const shown = q ? options.filter((o) => o.text.toLowerCase().includes(q)) : options
  const typed = q && !options.some((o) => o.text.toLowerCase() === q) ? (custom?.(query.trim()) ?? null) : null

  const pick = (next: string | null) => {
    onChange(next)
    setOpen(false)
  }

  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setQuery("")
        if (next) onOpen?.()
      }}
    >
      <span className="flex items-center">
        <Popover.Trigger asChild>
          <button type="button" className={cn(CHIP, value && cn(CHIP_SET, "rounded-r-none border-r-0"))}>
            <ChipLabel name={name} value={value} />
          </button>
        </Popover.Trigger>
        {value && (
          <button
            type="button"
            aria-label={`Clear ${name.toLowerCase()}`}
            onClick={() => onChange(null)}
            className={cn(CHIP, CHIP_SET, "rounded-l-none px-1.5 hover:text-foreground")}
          >
            <X className="size-3" />
          </button>
        )}
      </span>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          className="z-50 flex w-72 flex-col rounded-lg border border-border-strong bg-popover p-1 text-[13px] text-popover-foreground shadow-xl"
        >
          <label className="flex h-8 items-center gap-2 border-b border-border px-2">
            <Search className="size-3.5 shrink-0 text-subtle-foreground" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return
                e.preventDefault()
                if (typed) pick(typed)
                else if (shown[0]) pick(shown[0].value)
              }}
              placeholder={placeholder}
              aria-label={placeholder}
              className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-subtle-foreground"
            />
          </label>
          <div role="listbox" aria-label={name} className="mt-1 max-h-72 overflow-y-auto">
            {!q && <PickerRow selected={value === null} onPick={() => pick(null)}>{anyLabel}</PickerRow>}
            {typed && (
              <PickerRow selected={false} onPick={() => pick(typed)}>
                Use “{typed}”
              </PickerRow>
            )}
            {shown.map((option) => (
              <PickerRow key={option.value} selected={value === option.value} onPick={() => pick(option.value)} hint={option.hint}>
                {option.label}
              </PickerRow>
            ))}
            {loading ? (
              <p className="flex items-center gap-2 px-2 py-2 text-xs text-muted-foreground">
                <LoaderCircle className="size-3.5 animate-spin" /> Loading…
              </p>
            ) : (
              shown.length === 0 &&
              !typed && <p className="px-2 py-2 text-xs text-muted-foreground">{q ? "No matches" : empty}</p>
            )}
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  )
}

function PickerRow({
  selected,
  onPick,
  hint,
  children,
}: {
  selected: boolean
  onPick: () => void
  hint?: string
  children: ReactNode
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent focus-visible:bg-accent"
    >
      <span className="flex size-3.5 shrink-0 items-center justify-center">{selected && <Check className="size-3.5 text-muted-foreground" />}</span>
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {hint && <span className="shrink-0 text-[11px] text-subtle-foreground">{hint}</span>}
    </button>
  )
}
