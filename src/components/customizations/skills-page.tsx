import { Check, Download, FolderOpen, MoreHorizontal, Package, Trash2 } from "lucide-react"
import { useEffect, useState } from "react"

import type { InstalledSkill } from "@/bindings/InstalledSkill"
import type { SkillListing } from "@/bindings/SkillListing"
import {
  count,
  Details,
  Empty,
  FilterTabs,
  InstallButton,
  LoadingRows,
  Page,
  RowError,
  RowSummary,
  SearchField,
  Toolbar,
  Working,
} from "@/components/customizations/list-parts"
import { IconButton } from "@/components/ui/button"
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu"
import { errorMessage, ipc } from "@/lib/ipc"
import { installedCopy, useSkills } from "@/stores/skills"

type View = "installed" | "browse"

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 })

export function SkillsPage() {
  const installed = useSkills((s) => s.installed)
  const loadError = useSkills((s) => s.loadError)
  const [view, setView] = useState<View>("installed")
  const [query, setQuery] = useState("")
  const [expanded, setExpanded] = useState<string | null>(null)
  const search = useSkillSearch(query.trim(), view === "browse")

  // Reload on every visit: skills also arrive from the CLI and other agents.
  useEffect(() => {
    void useSkills.getState().load()
  }, [])

  const changeView = (next: View) => {
    setView(next)
    setExpanded(null)
  }
  const toggle = (id: string) => setExpanded((open) => (open === id ? null : id))

  return (
    <Page
      title="Skills"
      summary={
        installed
          ? `${count(installed.length, "skill", "skills")} installed. The agent loads one when a task calls for it.`
          : "Reusable instructions the agent loads when a task calls for them."
      }
    >
      <Toolbar>
        <FilterTabs
          label="Show skills"
          value={view}
          onChange={changeView}
          options={[
            { id: "installed", label: "Installed", count: installed?.length },
            { id: "browse", label: "Browse skills.sh" },
          ]}
        />
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder={view === "installed" ? "Search installed skills" : "Search skills.sh"}
          busy={view === "browse" && search.loading}
        />
      </Toolbar>

      {view === "installed" ? (
        <InstalledList
          skills={installed}
          error={loadError}
          query={query.trim()}
          expanded={expanded}
          onToggle={toggle}
          onClear={() => setQuery("")}
          onBrowse={() => changeView("browse")}
        />
      ) : (
        <BrowseList query={query.trim()} search={search} expanded={expanded} onToggle={toggle} />
      )}
    </Page>
  )
}

function InstalledList({
  skills,
  error,
  query,
  expanded,
  onToggle,
  onClear,
  onBrowse,
}: {
  skills: InstalledSkill[] | null
  error: string | null
  query: string
  expanded: string | null
  onToggle: (id: string) => void
  onClear: () => void
  onBrowse: () => void
}) {
  if (!skills) {
    return error ? (
      <Empty
        tone="error"
        title="Couldn't read your skills folder"
        body={error}
        action={{ label: "Retry", run: () => void useSkills.getState().load() }}
      />
    ) : (
      <LoadingRows label="Loading installed skills" />
    )
  }

  const q = query.toLowerCase()
  const visible = skills.filter((s) =>
    [s.name, s.description ?? "", s.source ?? ""].some((text) => text.toLowerCase().includes(q)),
  )

  if (visible.length === 0) {
    return query ? (
      <Empty
        title={`No installed skills match “${query}”`}
        body="Search looks at names, descriptions and where each skill came from."
        action={{ label: "Clear search", run: onClear }}
      />
    ) : (
      <Empty
        title="No skills installed"
        body="A skill is a folder of instructions the agent reads when a task calls for it. Find one on skills.sh and it installs in a few seconds."
        action={{ label: "Browse skills.sh", run: onBrowse }}
      />
    )
  }

  return (
    <ul className="mt-1 border-t border-border">
      {visible.map((skill) => (
        <InstalledRow key={skill.id} skill={skill} open={expanded === skill.id} onToggle={() => onToggle(skill.id)} />
      ))}
    </ul>
  )
}

function InstalledRow({ skill, open, onToggle }: { skill: InstalledSkill; open: boolean; onToggle: () => void }) {
  const working = useSkills((s) => s.working[skill.id])
  const failed = useSkills((s) => s.failed[skill.id])
  const detailsId = `skill-${skill.id}-details`

  const confirmUninstall = async () => {
    if (await ipc.dialog.confirm(`Its folder in ~/.claude/skills will be deleted.`, `Uninstall ${skill.name}?`, "Uninstall")) {
      void useSkills.getState().remove(skill)
    }
  }

  return (
    <li className="border-b border-border">
      <div className="group flex items-start gap-3 py-3.5">
        <RowSummary
          open={open}
          onToggle={onToggle}
          detailsId={detailsId}
          name={skill.name}
          description={skill.description ?? "No description in its SKILL.md."}
          dimmed={working === "removing"}
          meta={
            skill.source ? (
              <span className="flex items-center gap-1">
                <Package className="size-3 text-subtle-foreground" />
                {skill.source}
              </span>
            ) : (
              <span className="flex items-center gap-1">
                <FolderOpen className="size-3 text-subtle-foreground" />
                Your own
              </span>
            )
          }
        />
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {working === "removing" ? (
            <Working label="Removing…" />
          ) : (
            // Skills written by hand aren't the CLI's to delete; their folder is shown instead.
            skill.source && (
              <Menu>
                <MenuTrigger asChild>
                  <IconButton label="More" ariaLabel={`More for ${skill.name}`}>
                    <MoreHorizontal className="size-4" />
                  </IconButton>
                </MenuTrigger>
                <MenuContent align="end" className="min-w-36">
                  <MenuItem
                    onSelect={() => void confirmUninstall()}
                    className="text-destructive [&_svg]:text-destructive"
                  >
                    <Trash2 /> Uninstall
                  </MenuItem>
                </MenuContent>
              </Menu>
            )
          )}
        </div>
      </div>

      {failed && <RowError message={`Couldn't uninstall: ${failed}`} />}
      {open && (
        <Details
          id={detailsId}
          rows={[
            ["Source", skill.source ?? "Written by you, not installed from a registry"],
            ["Folder", skill.path],
            ...(skill.installedAt ? [["Installed", formatDate(skill.installedAt)] as [string, string]] : []),
          ]}
        />
      )}
    </li>
  )
}

/** Results already fetched, by query, so flipping between views doesn't refetch. */
const searches = new Map<string, SkillListing[]>()

/** Searches skills.sh while `enabled`; an empty query lists popular skills. */
function useSkillSearch(query: string, enabled: boolean) {
  const [results, setResults] = useState<SkillListing[] | null>(() => searches.get(query) ?? null)
  const [shownFor, setShownFor] = useState(query)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    if (!enabled || query.length === 1) {
      setLoading(false)
      return
    }
    const cached = searches.get(query)
    if (cached) {
      setResults(cached)
      setShownFor(query)
      setError(null)
      setLoading(false)
      return
    }
    let current = true
    setLoading(true)
    // Wait for typing to pause; the popular list (empty query) loads at once.
    const timer = setTimeout(
      () => {
        ipc.skills
          .search(query)
          .then((found) => {
            searches.set(query, found)
            if (!current) return
            setResults(found)
            setShownFor(query)
            setError(null)
          })
          .catch((e) => current && setError(errorMessage(e)))
          .finally(() => current && setLoading(false))
      },
      query ? 300 : 0,
    )
    return () => {
      current = false
      clearTimeout(timer)
    }
  }, [query, enabled, attempt])

  return { results, shownFor, error, loading, retry: () => setAttempt((n) => n + 1) }
}

function BrowseList({
  query,
  search,
  expanded,
  onToggle,
}: {
  query: string
  search: ReturnType<typeof useSkillSearch>
  expanded: string | null
  onToggle: (id: string) => void
}) {
  const { results, shownFor, error, loading, retry } = search

  if (query.length === 1) {
    return <Empty title="Keep typing" body="skills.sh searches from two letters." />
  }
  if (error && (!results || shownFor !== query)) {
    return (
      <Empty
        tone="error"
        title="Couldn't search skills.sh"
        body={error}
        action={{ label: "Retry", run: retry }}
      />
    )
  }
  if (!results) return <LoadingRows label="Loading skills from skills.sh" />

  // Older results stay on screen, faded, until the new ones land.
  const stale = loading && shownFor !== query
  if (results.length === 0 && !stale) {
    return (
      <Empty
        title={`Nothing on skills.sh matches “${query}”`}
        body="Try the job you want done, like “testing”, “docs” or “react”, rather than a skill's exact name."
      />
    )
  }

  return (
    <>
      <p className="mt-1 mb-2 text-xs text-muted-foreground" aria-live="polite">
        {shownFor
          ? `${count(results.length, "skill", "skills")} for “${shownFor}”, most installed first`
          : `The ${results.length} most installed skills on skills.sh`}
      </p>
      <ul className={stale ? "border-t border-border opacity-60 transition-opacity" : "border-t border-border"}>
        {results.map((listing) => (
          <ListingRow
            key={listing.id}
            listing={listing}
            open={expanded === listing.id}
            onToggle={() => onToggle(listing.id)}
          />
        ))}
      </ul>
    </>
  )
}

function ListingRow({ listing, open, onToggle }: { listing: SkillListing; open: boolean; onToggle: () => void }) {
  const copy = useSkills((s) => installedCopy(listing, s.installed))
  const working = useSkills((s) => s.working[listing.id])
  const failed = useSkills((s) => s.failed[listing.id])
  const detailsId = `listing-${listing.id.replaceAll("/", "-")}-details`

  return (
    <li className="border-b border-border">
      <div className="group flex items-start gap-3 py-3.5">
        <RowSummary
          open={open}
          onToggle={onToggle}
          detailsId={detailsId}
          name={listing.name}
          description={copy?.description ?? undefined}
          meta={
            <>
              <span className="flex items-center gap-1">
                <Package className="size-3 text-subtle-foreground" />
                {listing.source}
              </span>
              <span className="flex items-center gap-1 tabular-nums">
                <Download className="size-3 text-subtle-foreground" />
                {compact.format(listing.installs)} installs
              </span>
            </>
          }
        />
        <div className="flex shrink-0 items-center gap-1 pt-0.5">
          {working === "installing" ? (
            <Working label="Installing…" />
          ) : copy ? (
            <span className="flex h-7 items-center gap-1.5 px-2 text-[13px] text-muted-foreground">
              <Check className="size-3.5" />
              Installed
            </span>
          ) : (
            <InstallButton
              label={`Install ${listing.name}`}
              onClick={() => void useSkills.getState().install(listing)}
            />
          )}
        </div>
      </div>

      {failed && <RowError message={`Couldn't install: ${failed}`} />}
      {open && (
        <Details
          id={detailsId}
          rows={[
            ["Repository", `github.com/${listing.source}`],
            ["Page", `skills.sh/${listing.id}`],
            ["Installs", listing.installs.toLocaleString("en")],
            [
              "Command",
              <code key="command" className="font-mono text-xs">
                npx skills add {listing.source} --skill {listing.name}
              </code>,
            ],
          ]}
        />
      )}
    </li>
  )
}

function formatDate(iso: string) {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
}
