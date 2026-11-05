import { create } from "zustand"

import { peek, put } from "@/lib/gh-cache"
import { errorMessage, ipc } from "@/lib/ipc"
import { type BranchPr, type GhRepo, type GhStatus, ghErrorKind, type GhErrorKind } from "@/lib/github"
import { useWorkspace } from "@/stores/workspace"

/**
 * GitHub as `gh` sees it: whether it's installed and signed in, the open
 * folder's repository, and the pull request for the checked-out branch.
 * PR lists and details load in their own views.
 */
interface GitHubState {
  status: GhStatus | null
  /** The open folder's GitHub repo; null when it has none, undefined until checked. */
  repo: GhRepo | null | undefined
  branchPr: BranchPr | null
  /** Set when an action failed because gh is missing or signed out; shows the connect dialog. */
  needsSetup: GhErrorKind | null

  refreshStatus: () => Promise<GhStatus | null>
  /** Re-reads the repo and the branch's PR, e.g. after opening a folder or switching branch. */
  refreshRepo: () => Promise<void>
  refreshBranchPr: () => Promise<void>
  /**
   * Turns a failed GitHub call into the right next step: the connect dialog for a
   * missing gh or signed-out account, otherwise the message. Returns the message.
   */
  handleError: (error: unknown) => string
  dismissSetup: () => void
}

export const useGitHub = create<GitHubState>()((set, get) => ({
  // Last launch's answer, so GitHub pages open at once; refreshStatus replaces it.
  status: peek<GhStatus>("status")?.value ?? null,
  repo: undefined,
  branchPr: null,
  needsSetup: null,

  refreshStatus: async () => {
    try {
      const status = await ipc.github.status()
      put("status", status)
      set({ status })
      return status
    } catch (error) {
      console.warn("Couldn't read gh status", error)
      return null
    }
  },

  refreshRepo: async () => {
    const status = get().status ?? (await get().refreshStatus())
    if (!status?.installed || !status.user) {
      set({ repo: null, branchPr: null })
      return
    }
    // The folder's repository as last seen, then GitHub's answer.
    const key = `repo:${useWorkspace.getState().info?.root ?? ""}`
    const hit = peek<GhRepo | null>(key)
    if (hit) set({ repo: hit.value })
    try {
      const repo = await ipc.github.repo()
      put(key, repo)
      set({ repo })
    } catch {
      if (!hit) set({ repo: null })
    }
    await get().refreshBranchPr()
  },

  refreshBranchPr: async () => {
    if (!get().repo) {
      set({ branchPr: null })
      return
    }
    try {
      set({ branchPr: await ipc.github.prForBranch() })
    } catch {
      set({ branchPr: null })
    }
  },

  handleError: (error) => {
    const kind = ghErrorKind(error)
    if (kind === "not-installed" || kind === "not-signed-in") {
      set({ needsSetup: kind })
      void get().refreshStatus()
    }
    return errorMessage(error)
  },

  dismissSetup: () => set({ needsSetup: null }),
}))
