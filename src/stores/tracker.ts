import { create } from "zustand"

import type { GhLabel, GhRepoRef, Involvement, SearchFilters, TrackerKind, TrackerState } from "@/lib/github"
import { cached, peek } from "@/lib/gh-cache"
import { ipc } from "@/lib/ipc"

export type UpdatedWindow = "any" | "day" | "week" | "month" | "year"

/** What the Pull requests and Issues lists are filtered by, as the user set it. */
export interface TrackerFilters {
  state: TrackerState
  involvement: Involvement
  repo: string | null
  label: string | null
  updated: UpdatedWindow
  query: string
}

export const DEFAULT_FILTERS: TrackerFilters = {
  state: "open",
  involvement: "involves",
  repo: null,
  label: null,
  updated: "any",
  query: "",
}

const WINDOW_DAYS: Record<Exclude<UpdatedWindow, "any">, number> = { day: 1, week: 7, month: 30, year: 365 }

/** The filters as `gh search` takes them. */
export function searchFilters(filters: TrackerFilters): SearchFilters {
  const days = filters.updated === "any" ? null : WINDOW_DAYS[filters.updated]
  return {
    state: filters.state,
    // GitHub won't search every repository at once, so "everyone" needs one named.
    involvement: filters.involvement === "any" && !filters.repo ? "involves" : filters.involvement,
    repo: filters.repo,
    label: filters.label,
    updatedSince: days === null ? null : new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10),
    query: filters.query.trim() || null,
  }
}

interface TrackerStore {
  filters: Record<TrackerKind, TrackerFilters>
  /** Labels seen in results so far, per kind, so the label filter has something to offer across repositories. */
  seenLabels: Record<TrackerKind, GhLabel[]>
  /** The repositories the user can work in; null until loaded. */
  repos: GhRepoRef[] | null
  setFilters: (kind: TrackerKind, patch: Partial<TrackerFilters>) => void
  resetFilters: (kind: TrackerKind) => void
  noteLabels: (kind: TrackerKind, labels: GhLabel[]) => void
  loadRepos: () => Promise<void>
}

export const useTracker = create<TrackerStore>()((set, get) => ({
  filters: { prs: DEFAULT_FILTERS, issues: DEFAULT_FILTERS },
  seenLabels: { prs: [], issues: [] },
  repos: null,

  setFilters: (kind, patch) =>
    set((s) => {
      const next = { ...s.filters[kind], ...patch }
      // A label belongs to a repository's set; moving to another repository drops it.
      if ("repo" in patch && patch.repo !== s.filters[kind].repo && !("label" in patch)) next.label = null
      if (!next.repo && next.involvement === "any") next.involvement = "involves"
      if (kind === "issues" && next.state === "merged") next.state = "closed"
      return { filters: { ...s.filters, [kind]: next } }
    }),
  resetFilters: (kind) => set((s) => ({ filters: { ...s.filters, [kind]: { ...DEFAULT_FILTERS, query: s.filters[kind].query } } })),
  noteLabels: (kind, labels) =>
    set((s) => {
      const known = new Set(s.seenLabels[kind].map((l) => l.name))
      const added = labels.filter((l) => !known.has(l.name) && (known.add(l.name), true))
      return added.length ? { seenLabels: { ...s.seenLabels, [kind]: [...s.seenLabels[kind], ...added] } } : {}
    }),
  loadRepos: async () => {
    // What's remembered first, then a fresh list in the background.
    const hit = peek<GhRepoRef[]>("repos")
    if (hit && !get().repos) set({ repos: hit.value.filter((r) => !r.archived) })
    try {
      set({ repos: (await cached("repos", () => ipc.github.repos(), 10 * 60_000)).filter((r) => !r.archived) })
    } catch (error) {
      console.warn("Couldn't list repositories", error)
      if (!get().repos) set({ repos: [] })
    }
  },
}))
