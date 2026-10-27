import { create } from "zustand"

import type { InstalledSkill } from "@/bindings/InstalledSkill"
import type { SkillListing } from "@/bindings/SkillListing"
import { errorMessage, ipc } from "@/lib/ipc"

export type SkillWork = "installing" | "removing"

/**
 * Skills in `~/.claude/skills`, and the installs and removals in flight. Held
 * here rather than in the page so an install keeps its spinner when you
 * navigate away and back.
 */
interface SkillsState {
  installed: InstalledSkill[] | null
  loadError: string | null
  /** Listing id (installs) or installed id (removals) → what is running. */
  working: Record<string, SkillWork>
  /** Same keys → why the last attempt failed. */
  failed: Record<string, string>

  load: () => Promise<void>
  install: (listing: SkillListing) => Promise<void>
  remove: (skill: InstalledSkill) => Promise<void>
}

export const useSkills = create<SkillsState>()((set, get) => {
  const run = async (key: string, work: SkillWork, task: () => Promise<InstalledSkill[]>) => {
    if (get().working[key]) return
    set((s) => ({ working: { ...s.working, [key]: work }, failed: without(s.failed, key) }))
    try {
      const installed = await task()
      set({ installed })
    } catch (error) {
      set((s) => ({ failed: { ...s.failed, [key]: errorMessage(error) } }))
    } finally {
      set((s) => ({ working: without(s.working, key) }))
    }
  }

  return {
    installed: null,
    loadError: null,
    working: {},
    failed: {},

    load: async () => {
      set({ loadError: null })
      try {
        set({ installed: await ipc.skills.installed() })
      } catch (error) {
        set({ loadError: errorMessage(error) })
      }
    },
    install: (listing) => run(listing.id, "installing", () => ipc.skills.add(listing.source, listing.name)),
    remove: (skill) => run(skill.id, "removing", () => ipc.skills.remove(skill.id)),
  }
})

/** The installed copy of a listing, matched on its source and folder or name. */
export function installedCopy(listing: SkillListing, installed: InstalledSkill[] | null) {
  return installed?.find(
    (s) => s.source === listing.source && (s.id === listing.skillId || s.id === listing.name || s.name === listing.name),
  )
}

function without<T>(record: Record<string, T>, key: string) {
  const { [key]: _, ...rest } = record
  return rest
}
